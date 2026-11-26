import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary } from "@omp-ui/core";

/**
 * Live proof that a model switch and an explicit thinking level survive a
 * session resume on the real `omp --mode=rpc-ui` binary (issue #1232): the
 * seam omp-ui's HUD and every restore path trust, with no live proof before.
 *
 * The cross-version claims, grounded in the omp source of both released
 * binaries (v18.22.0 and v19.0.0 carry this wire identically — the
 * `set_thinking_level` ack, the forwarded `thinking_level_changed` receipt,
 * the `appendModelChange` / `appendThinkingLevelChange` transcript entries,
 * and the resume-time replay in session-context.ts). CI runs this proof
 * against the single supported harness (the pinned current omp, now 19.2.1);
 * the version branches below keep it truthful when run locally against an
 * older binary:
 * 1. `set_thinking_level high` on an effort-ladder model answers with a
 *    success ack AND a `thinking_level_changed` frame carrying `high`.
 * 2. `set_model` switches the live model and get_state reports it.
 * 3. A level pinned AFTER the switch lands durable `model_change` +
 *    `thinking_level_change(high)` entries once the turn writes the first
 *    assistant message (omp lazily materializes the session file; before
 *    that these selector entries are draft-only).
 * 4. A resume of that session id with no --model and no --thinking restores
 *    BOTH: get_state reports model `switched` and thinking level `high`.
 *
 * One claim differs between released versions, and the gate asserts the
 * observed behavior per binary rather than skipping it: what survives a
 * model switch. v19's #reapplyThinkingLevel carries the current level and
 * applies the new model's default only when none is set; on 18.x,
 * `preferredDefault ?? this.#thinkingLevel` lets the new model's declared
 * `defaultLevel` override the pinned level (probe: high -> low across the
 * switch). omp-ui masks the 18.x behavior by re-pinning its own record, so
 * the resume claim stays version-independent by pinning after the switch.
 *
 * Credential-free by construction: a scripted loopback provider (the
 * intent-headline-live pattern) answers every completion with one sentence
 * and `stop`, so the turn completes without billing a model. HOME/XDG are
 * isolated per scope. Real timers throughout: the awaited actor is an OS
 * process speaking NDJSON, which no fake clock can advance; every wait ends
 * on an observed frame.
 */

const ompPath = resolveOmpBinary();

function ompMajor(): number | null {
  try {
    const match = /(\d+)\./.exec(execFileSync(ompPath!, ["--version"], { encoding: "utf8", timeout: 15_000 }));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

const majors = ompPath === null ? null : ompMajor();
const v19 = ompPath !== null && majors !== null && majors >= 19;

/** Two models with the same effort ladder; only their defaults could differ. */
const MODELS_YML = (baseUrl: string): string => `providers:
  thinkprobe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high]
          defaultLevel: low
      - id: switched
        name: switched
        contextWindow: 131072
        maxTokens: 128
        reasoning: true
        thinking:
          mode: effort
          efforts: [low, medium, high]
          defaultLevel: low
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
`;

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  thinkingLevel?: unknown;
  data?: Record<string, unknown>;
}

interface Scope {
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
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
    id: `think-${index}`,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: "thinkprobe",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
  })}\n\n`;

interface ScriptedProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/** Every completion streams one sentence and ends the turn; no model is ever billed. */
async function scriptedProvider(): Promise<ScriptedProvider> {
  let held = 0;
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
        chunk(index, { role: "assistant", content: "done" }, null) +
          chunk(index, {}, "stop") +
          "data: [DONE]\n\n",
      );
    });
  });
  const { promise: listening, resolve: settled } = Promise.withResolvers<void>();
  const { promise: listenFailed, reject: listenRejected } = Promise.withResolvers<never>();
  server.once("error", listenRejected);
  server.listen(0, "127.0.0.1", settled);
  await Promise.race([listening, listenFailed]);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback provider port");
  const { promise: closed, resolve: settleClose, reject: rejectClose } = Promise.withResolvers<void>();
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => {
      server.closeAllConnections();
      server.close((error) => (error ? rejectClose(error) : settleClose()));
      return closed;
    },
  };
}

/** One isolated HOME/lineage/project; the resume spawn reuses the same base. */
interface Env0 {
  base: string;
  env: NodeJS.ProcessEnv;
  project: string;
  lineage: string;
}

function makeBase(baseUrl: string): Env0 {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-thinklevel-"));
  const home = path.join(base, "home");
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  return {
    base,
    project,
    lineage,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    },
  };
}

function spawnScope(scope: Env0, opts: { model?: string; resumeSessionId?: string }): Scope {
  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const client = new RpcClient({
    cwd: scope.project,
    lineageDir: scope.lineage,
    ompPath: ompPath!,
    model: opts.model,
    resumeSessionId: opts.resumeSessionId,
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...scope.env },
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
  return { frames, client, exited };
}

const scopes: Scope[] = [];
async function killScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
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
  const id = `thinklive-${sequence}`;
  scope.client.send({ ...command, id } as never);
  return waitFor(
    () => scope.frames.find((f) => f.type === "response" && f.id === id),
    30_000,
    `the response to ${JSON.stringify(command)}`,
  );
}

async function ready(scope: Scope): Promise<void> {
  await waitFor(
    () => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
    60_000,
    "omp ready",
  );
}

/** get_state serializes the live Model object; the gate reads its id. */
function modelIdOf(data: Record<string, unknown> | undefined): unknown {
  const model = data?.model;
  return typeof model === "object" && model !== null && "id" in model ? model.id : model;
}

describe.skipIf(ompPath === null)("thinking level across model switch and resume on the real runtime (#1232)", () => {
  it(
    "set_model + set_thinking_level persist into the transcript and both restore on resume",
    async () => {
      provider = await scriptedProvider();
      const scope = makeBase(provider.baseUrl);

      // Boot on inert (ladder default low); no --thinking, so any level in
      // this proof is one the test itself set.
      const first = spawnScope(scope, { model: "thinkprobe/inert" });
      scopes.push(first);
      await ready(first);

      const pinned = await request(first, { type: "set_thinking_level", level: "high" });
      expect(pinned.success).toBe(true);
      const receipt = await waitFor(
        () => first.frames.find((f) => f.type === "thinking_level_changed" && f.thinkingLevel === "high"),
        15_000,
        "the thinking_level_changed(high) receipt",
      );
      expect(receipt).toBeDefined();

      const switched = await request(first, { type: "set_model", provider: "thinkprobe", modelId: "switched" });
      expect(switched.success).toBe(true);
      const afterSwitch = await request(first, { type: "get_state" });
      expect(modelIdOf(afterSwitch.data)).toBe("switched");
      // The one claim released versions disagree on — asserted per binary.
      // v19 carries the pinned level across the switch; 18.x lets the
      // target model's defaultLevel win (omp 18 model-controls preferredDefault).
      expect(afterSwitch.data?.thinkingLevel).toBe(v19 ? "high" : "low");

      // Pin high AFTER the switch so every later claim is version-independent.
      const repin = await request(first, { type: "set_thinking_level", level: "high" });
      expect(repin.success).toBe(true);
      const repinnedState = await request(first, { type: "get_state" });
      expect(repinnedState.data?.thinkingLevel).toBe("high");

      const prompted = await request(first, { type: "prompt", message: "go" });
      expect(prompted.success).toBe(true);
      await waitFor(
        () => (first.frames.some((f) => f.type === "agent_end") ? true : undefined),
        120_000,
        "the scripted turn to end",
      );

      // The assistant message materializes the session file; the selector
      // entries appended before it ride the same full-body rewrite.
      const state = await request(first, { type: "get_state" });
      const sessionId = typeof state.data?.sessionId === "string" ? state.data.sessionId : null;
      const sessionFile = typeof state.data?.sessionFile === "string" ? state.data.sessionFile : null;
      expect(sessionId).not.toBeNull();
      expect(sessionFile).not.toBeNull();
      const durable = await waitFor(
        () => {
          let text: string;
          try {
            text = fs.readFileSync(sessionFile!, "utf8");
          } catch {
            return undefined;
          }
          const entries = text
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => JSON.parse(line) as Record<string, unknown>);
          const thinking = entries.filter((e) => e.type === "thinking_level_change");
          const model = entries.filter((e) => e.type === "model_change");
          return thinking.length > 0 && model.length > 0 ? { thinking, model } : undefined;
        },
        30_000,
        "the durable thinking_level_change and model_change entries",
      );
      expect(durable.thinking.at(-1)?.thinkingLevel).toBe("high");
      expect(durable.model.some((e) => e.model === "thinkprobe/switched")).toBe(true);

      await killScope(first);
      const index = scopes.indexOf(first);
      if (index >= 0) scopes.splice(index, 1);

      // Resume on a fresh process with NO --model and NO --thinking: whatever
      // get_state reports now came from the transcript alone.
      const second = spawnScope(scope, { resumeSessionId: sessionId! });
      scopes.push(second);
      await ready(second);
      const resumedState = await request(second, { type: "get_state" });
      expect(resumedState.data?.sessionId).toBe(sessionId);
      expect(modelIdOf(resumedState.data)).toBe("switched");
      expect(resumedState.data?.thinkingLevel).toBe("high");

      fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
    240_000,
  );
});
