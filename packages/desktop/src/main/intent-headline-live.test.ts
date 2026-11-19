import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeIntentTracingOverlay } from "@omp-ui/core";

/**
 * Live proof for the intent-headline overlay (issue #1231) against the REAL
 * `omp --mode=rpc-ui`: with only the generated intent overlay loaded, a bash
 * tool call whose arguments carry omp's `i` intent field must surface
 * `intent` on the `tool_execution_start` frame — the field native tool cards
 * headline with. Without the pin and with the user's own
 * `tools.intentTracing: false` in the global layer, the same scripted call
 * must reach no frame carrying an intent, so the card keeps its
 * argument-summary fallback instead of a headline omp was told not to ask for.
 *
 * A scripted loopback provider (the bash-minimized-live pattern) makes the
 * tool call deterministic without billing a model: completion 0 emits one
 * bash call, every later completion streams one sentence and ends the turn.
 * HOME/XDG and the lineage are isolated per scope. Real timers throughout:
 * the awaited actor is an OS process.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = (baseUrl: string): string => `providers:
  intentprobe:
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

const CONFIG_YML = (extra = ""): string => `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
${extra}`;

const TOOL_CALL_ID = "call_intent_probe";
const INTENT_TEXT = "prove the tool-card headline";

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  toolCallId?: string;
  toolName?: string;
  intent?: unknown;
}

interface Scope {
  base: string;
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
    id: `intent-${index}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  })}\n\n`;

interface ScriptedProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/** Completion 0 emits the bash call carrying the `i` intent arg; later ones close the turn. */
async function scriptedProvider(withIntentArg: boolean): Promise<ScriptedProvider> {
  let held = 0;
  const args: Record<string, string> = { command: "echo intent-probe" };
  if (withIntentArg) args.i = INTENT_TEXT;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      const index = held++;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        (index === 0
          ? chunk(
              index,
              {
                role: "assistant",
                tool_calls: [
                  {
                    index: 0,
                    id: TOOL_CALL_ID,
                    type: "function",
                    function: { name: "bash", arguments: JSON.stringify(args) },
                  },
                ],
              },
              null,
            ) + chunk(index, {}, "tool_calls")
          : chunk(index, { role: "assistant", content: "done" }, null) + chunk(index, {}, "stop")) +
          "data: [DONE]\n\n",
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function hermeticBase(baseUrl: string, extraConfig = ""): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-intent-live-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML(extraConfig));
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

function spawnScope(base: string, env: NodeJS.ProcessEnv, configOverlays: string[]): Scope {
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
    model: "intentprobe/inert",
    configOverlays,
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, [...args, "--tools=bash"], {
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
  return { base, frames, client, exited };
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
  const id = `intent-live-${sequence}`;
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

describe.skipIf(ompPath === null)("intent headline overlay on the real runtime (#1231)", () => {
  it("surfaces intent on tool_execution_start with only the overlay pinning it", async () => {
    provider = await scriptedProvider(true);
    const { base, env } = hermeticBase(provider.baseUrl);
    const overlays: string[] = [];
    const lineageForOverlay = path.join(base, "lin");
    const written = writeIntentTracingOverlay(lineageForOverlay, true);
    expect(written).not.toBeNull();
    overlays.push(written!);
    const scope = spawnScope(base, env, overlays);
    scopes.push(scope);
    await ready(scope);

    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);

    const started = await pollUntil(
      () => scope.frames.find((f) => f.type === "tool_execution_start" && f.toolCallId === TOOL_CALL_ID),
      120_000,
      "the tool_execution_start for the probe bash call",
    );
    expect(started.toolName).toBe("bash");
    expect(started.intent).toBe(INTENT_TEXT);
  });

  it("carries no intent when the user's global layer opts out, even with the arg present", async () => {
    provider = await scriptedProvider(true);
    const { base, env } = hermeticBase(provider.baseUrl, "  intentTracing: false\n");
    const scope = spawnScope(base, env, []);
    scopes.push(scope);
    await ready(scope);

    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);

    // Whatever shape the off-path frame takes (omitted field), no frame may
    // headline a card the user asked omp not to annotate. The turn itself ran:
    // its bash tool executed, so a start frame or a refusal exists either way.
    await pollUntil(
      () =>
        scope.frames.find(
          (f) => f.type === "tool_execution_end" || (f.type === "tool_execution_start" && f.toolCallId === TOOL_CALL_ID),
        ),
      120_000,
      "the probe bash call to reach execution either way",
    );
    expect(scope.frames.filter((f) => f.type === "tool_execution_start").every((f) => f.intent === undefined)).toBe(
      true,
    );
  });

  it("honours the PI_INTENT_TRACING env opt-out over the overlay", async () => {
    provider = await scriptedProvider(true);
    const { base, env } = hermeticBase(provider.baseUrl);
    env.PI_INTENT_TRACING = "false";
    const written = writeIntentTracingOverlay(path.join(base, "lin"), true);
    const scope = spawnScope(base, env, written === null ? [] : [written]);
    scopes.push(scope);
    await ready(scope);

    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);

    await pollUntil(
      () =>
        scope.frames.find(
          (f) => f.type === "tool_execution_end" || (f.type === "tool_execution_start" && f.toolCallId === TOOL_CALL_ID),
        ),
      120_000,
      "the probe bash call to reach execution either way",
    );
    expect(scope.frames.filter((f) => f.type === "tool_execution_start").every((f) => f.intent === undefined)).toBe(
      true,
    );
  });
});
