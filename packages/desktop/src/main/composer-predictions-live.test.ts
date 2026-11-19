import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeComposerPredictionsExtension } from "@omp-ui/core";
import {
  COMPOSER_PREDICTIONS_COMMAND,
  COMPOSER_PREDICTIONS_STATUS_KEY,
  COMPOSER_PREDICTION_USAGE_PURPOSE,
  composerPredictionRequestMessage,
  parseComposerPredictionsSnapshot,
  type ComposerPredictionsSnapshot,
} from "@omp-ui/core/composer-predictions";

/**
 * Live proof for the composer next-message prediction bridge (issue #1239)
 * against the REAL `omp --mode=rpc-ui` binary — the same skip-when-no-binary
 * discipline as async-jobs-live.test.ts, with a scripted loopback provider so
 * no real provider is ever billed. Runs identically on both harness floors
 * (18.22.0 and 19.0.0): every surface this bridge uses — the command context's
 * `runEphemeralTurn`/`sessionManager`, `ctx.on("agent_start")`, the
 * ADR-0036 registry read, and `appendModelUsage`'s (sessionId, parentId)
 * owner — exists on both tags (verified against their sources).
 *
 * What it proves end to end: with `composer.predictions` on, the arm
 * publishes availability, a request runs exactly one extra provider call over
 * the session context (the request count is pinned), its reply arrives on the
 * status channel correlated by requestId, and the billed usage lands in the
 * session journal as a `model_usage` entry with purpose `composer-prediction`
 * — which is exactly what the session-spend bridge sums, so the spend is
 * never invisible. With the setting off, the arm publishes
 * `available: false / "settings-off"`, the request bills nothing (the count
 * stays at the single prompt turn), and no journal entry appears.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = (baseUrl: string): string => `providers:
  predprobe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
        reasoning: false
`;

const CONFIG_YML = (predictions: boolean): string => `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
composer:
  predictions: ${predictions ? "true" : "false"}
`;

/** The line the scripted provider replies to a prediction request with. */
const PREDICTED = "Sounds good — ship it.";

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  method?: string;
  statusKey?: string;
  statusText?: string;
}

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

const chunk = (index: number, delta: Record<string, unknown>, finishReason: string | null): string =>
  `data: ${JSON.stringify({
    id: `predprobe-${index}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 11, completion_tokens: 3, total_tokens: 14 } }),
  })}\n\n`;

interface ScriptedProvider {
  baseUrl: string;
  /** Total /v1/chat/completions calls received so far. */
  requests(): number;
  /** The body of the `which`th request (0-based). */
  body(which: number): string;
  close(): Promise<void>;
}

/** Every completion streams one sentence and ends the turn, with a usage block. */
async function scriptedProvider(reply: string): Promise<ScriptedProvider> {
  let held = 0;
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    let body = "";
    request.on("data", (piece) => {
      body += piece;
    });
    request.on("end", () => {
      const index = held++;
      bodies.push(body);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        chunk(index, { role: "assistant", content: reply }, null) + chunk(index, {}, "stop") + "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback provider port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests: () => held,
    body: (which) => bodies[which] ?? "",
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function hermeticBase(baseUrl: string, predictions: boolean): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-predictions-live-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML(predictions));
  return {
    base,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    },
  };
}

function spawnScope(base: string, env: NodeJS.ProcessEnv): Scope {
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "predprobe/inert",
    extensions: [writeComposerPredictionsExtension(lineage)],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
      });
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal) => void proc.kill(signal),
        onExit: (cb) => proc.on("exit", (code) => cb(code)),
        onSpawnError: (cb) => proc.on("error", cb),
      };
    },
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: () => {},
  });
  return { base, lineage, frames, client, exited };
}

const scopes: Scope[] = [];
async function killScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([
    scope.exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let provider: ScriptedProvider | null = null;
afterEach(async () => {
  for (const scope of scopes.splice(0)) await killScope(scope);
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
});

let sequence = 0;
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  sequence += 1;
  const id = `pred-live-${sequence}`;
  scope.client.send({ ...command, id } as never);
  return pollUntil(
    () => scope.frames.find((f) => f.type === "response" && f.id === id),
    30_000,
    `the response to ${JSON.stringify(command)}`,
  );
}

async function ready(scope: Scope): Promise<void> {
  await pollUntil(
    () => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
    60_000,
    "omp ready",
  );
}

/** Every snapshot the bridge published on its status key, in wire order. */
function published(scope: Scope): ComposerPredictionsSnapshot[] {
  const snapshots: ComposerPredictionsSnapshot[] = [];
  for (const frame of scope.frames) {
    if (frame.type !== "extension_ui_request" || frame.method !== "setStatus") continue;
    if (frame.statusKey !== COMPOSER_PREDICTIONS_STATUS_KEY) continue;
    const snapshot = parseComposerPredictionsSnapshot(frame.statusText);
    // A publish the client parser rejects is a contract drift: fail loudly.
    if (snapshot === null) throw new Error(`bridge published an unparsable snapshot: ${frame.statusText}`);
    snapshots.push(snapshot);
  }
  return snapshots;
}

const last = (scope: Scope): ComposerPredictionsSnapshot | undefined => published(scope).at(-1);

/** The session journals in the lineage dir omp was handed (--session-dir). */
function journalEntries(base: string): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const file of fs.readdirSync(base)) {
    if (!file.endsWith(".jsonl")) continue;
    for (const line of fs.readFileSync(path.join(base, file), "utf8").split("\n")) {
      if (!line.includes("model_usage")) continue;
      try {
        const entry = JSON.parse(line) as Record<string, unknown>;
        if (entry.type === "model_usage") found.push(entry);
      } catch {
        // Partial trailing lines are fine to skip.
      }
    }
  }
  return found;
}

describe.skipIf(ompPath === null)("composer predictions bridge on the real runtime (#1239)", () => {
  it("predicts on a completed turn, journals the billed usage, and bills nothing else", async () => {
    provider = await scriptedProvider(PREDICTED);
    const { base, env } = hermeticBase(provider.baseUrl, true);
    const scope = spawnScope(base, env);
    scopes.push(scope);
    await ready(scope);

    // One completed turn: exactly one provider call so far.
    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);
    await pollUntil(() => (provider!.requests() >= 1 ? true : undefined), 120_000, "the prompt turn");

    // Arm: availability publishes; the arm itself bills nothing.
    const armed = await request(scope, { type: "prompt", message: `/${COMPOSER_PREDICTIONS_COMMAND}` });
    expect(armed.success).toBe(true);
    const snapshot = await pollUntil(
      () => (last(scope)?.available === true ? last(scope) : undefined),
      30_000,
      "the available publish",
    );
    expect(snapshot.unavailable).toBeNull();
    expect(provider.requests()).toBe(1);

    // Request: one correlated result, the first choice only surfaces (no pick list yet).
    const asked = await request(scope, {
      type: "prompt",
      message: composerPredictionRequestMessage({ requestId: "live-1" }),
    });
    expect(asked.success).toBe(true);
    const settled = await pollUntil(
      () => published(scope).find((s) => s.result?.requestId === "live-1"),
      60_000,
      "the prediction result",
    );
    expect(settled.result).toEqual({ requestId: "live-1", ok: true, choices: [PREDICTED] });

    // Exactly one extra provider call — the side turn — over the session context.
    await pollUntil(() => (provider!.requests() === 2 ? true : undefined), 30_000, "the single prediction call");
    expect(provider.requests()).toBe(2);
    // The prediction prompt went out with omp's own instruction vocabulary.
    expect(provider.body(1)).toContain("Predict the user's next message");
    expect(provider.body(1)).toContain("NO_PREDICTION");

    // The billed spend is journalled where session totals read it: a
    // model_usage entry under purpose "composer-prediction" with usage.
    const entry = await pollUntil(
      () => journalEntries(scope.lineage).find((e) => e.purpose === COMPOSER_PREDICTION_USAGE_PURPOSE),
      10_000,
      "the journaled model_usage entry",
    );
    const usage = entry.usage as Record<string, unknown> | undefined;
    expect(usage).toBeTruthy();
    expect(Number(usage!.output ?? 0)).toBeGreaterThan(0);
  });

  it("stays inert when composer.predictions is off: no availability, no request, no spend", async () => {
    provider = await scriptedProvider(PREDICTED);
    const { base, env } = hermeticBase(provider.baseUrl, false);
    const scope = spawnScope(base, env);
    scopes.push(scope);
    await ready(scope);

    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);
    await pollUntil(() => (provider!.requests() >= 1 ? true : undefined), 120_000, "the prompt turn");

    const armed = await request(scope, { type: "prompt", message: `/${COMPOSER_PREDICTIONS_COMMAND}` });
    expect(armed.success).toBe(true);
    const snapshot = await pollUntil(
      () => (last(scope)?.available === false ? last(scope) : undefined),
      30_000,
      "the unavailable publish",
    );
    expect(snapshot.unavailable).toBe("settings-off");

    // A request against an off setting refuses without touching the provider.
    const asked = await request(scope, {
      type: "prompt",
      message: composerPredictionRequestMessage({ requestId: "live-2" }),
    });
    expect(asked.success).toBe(true);
    const settled = await pollUntil(
      () => published(scope).find((s) => s.result?.requestId === "live-2"),
      30_000,
      "the off refusal",
    );
    expect(settled.result).toEqual({ requestId: "live-2", ok: false, reason: "off" });
    expect(provider.requests()).toBe(1);
    expect(journalEntries(scope.lineage).some((e) => e.purpose === COMPOSER_PREDICTION_USAGE_PURPOSE)).toBe(false);
  });
});
