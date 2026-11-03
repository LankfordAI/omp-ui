import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, compareVersions, readInstalledOmpVersion, resolveOmpBinary } from "@omp-ui/core";

/**
 * Pins omp's credential-fallback switch (issue #1032, upstream omp PR #17559)
 * to the REAL `omp --mode=rpc-ui` wire contract: when the pinned model's
 * provider has no usable credential, omp silently switches the session to the
 * first `retry.fallbackChains` candidate. The frames captured by the throwaway
 * probe from omp/18.15.0 are: a bare `model_changed`, then
 * `retry_fallback_applied {from, to, role, reason: "no credential for ..."}`,
 * and NO `config_update` — which is exactly why a #970-style chip that sources
 * its model from config updates goes stale during the fallback. When the
 * credential returns, a second bare `model_changed` reverts the session.
 *
 * The setup: `nokeyprov/m1` (the pin) uses a command secret
 * (`apiKey: "!cat <keyFile>"`) that prints nothing while the key file is
 * empty; `keyprov/m1` has a literal key; both point at one scripted loopback
 * SSE provider, and `retry.fallbackChains` routes both `default` and
 * `nokeyprov/m1` to `keyprov/m1`. Filling the key file restores the pin.
 *
 * Skips without an omp binary, and per test below omp 18.15.0, where
 * credential fallback landed.
 */

const ompPath = resolveOmpBinary();
/** The first omp that switches sessions on missing provider credentials. */
const CRED_FALLBACK_FLOOR = "18.15.0";

interface Frame {
  type: string;
  id?: string;
  command?: string;
  success?: boolean;
  data?: Record<string, unknown>;
  message?: Record<string, unknown>;
  from?: string;
  to?: string;
  role?: string;
  reason?: string;
  model?: string;
}

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  // A real process is the thing waited on, so a real timer is the only clock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  probe: () => Promise<T | undefined> | (T | undefined),
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(100);
  }
}

function chunk(body: { model?: string }, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "probe-1",
    object: "chat.completion.chunk",
    created: 0,
    model: body.model ?? "m1",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

/** Streams one canned assistant answer for every completion request. */
async function scriptedProvider(): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer((request, response) => {
    if (request.method !== "POST") {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (c: Buffer) => chunks.push(c));
    request.on("end", () => {
      let body: { model?: string } = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { model?: string };
      } catch {
        // keep defaults
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        chunk(body, { role: "assistant", content: "probe answer" }, null) +
          chunk(body, {}, "stop") +
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

const MODELS_YML = (baseUrl: string, keyFile: string): string => `providers:
  nokeyprov:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: "!cat ${keyFile}"
    models:
      - id: m1
        name: m1
        contextWindow: 131072
        maxTokens: 128
  keyprov:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: probe-fixed-key
    models:
      - id: m1
        name: m1
        contextWindow: 131072
        maxTokens: 128
`;

const CONFIG_YML = (keyFile: string): string => `startup:
  checkUpdate: false
retry:
  fallbackChains:
    default:
      - keyprov/m1
    "nokeyprov/m1":
      - keyprov/m1
tools:
  approvalMode: yolo
# keyFile=${keyFile}
`;

function hermeticBase(baseUrl: string, keyFile: string): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cred-fallback-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl, keyFile));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML(keyFile));
  fs.writeFileSync(keyFile, "");
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

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
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
    model: "nokeyprov/m1",
    configOverlays: [],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, [...args, "--no-tools"], {
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
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let provider: { baseUrl: string; close(): Promise<void> } | null = null;
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
  const id = `cred-live-${sequence}`;
  scope.client.send({ ...command, id } as never);
  return pollUntil(
    () => scope.frames.find((f) => f.type === "response" && f.id === id),
    60_000,
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

function assistantEnds(frames: Frame[]): Frame[] {
  return frames.filter((f) => f.type === "message_end" && (f.message as { role?: string } | undefined)?.role === "assistant");
}

function stateModel(frame: Frame): Record<string, unknown> | undefined {
  return frame.data?.model as Record<string, unknown> | undefined;
}

describe.skipIf(ompPath === null)("credential fallback switch on the real runtime", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });
  const needsCredentialFallback = (ctx: { skip: (note?: string) => void }): void => {
    if (version === null || compareVersions(version, CRED_FALLBACK_FLOOR) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates credential fallback (${CRED_FALLBACK_FLOOR})`);
    }
  };

  it("switches to the fallback candidate without a config_update and reverts when the credential returns", async (ctx) => {
    needsCredentialFallback(ctx);
    const keyFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-cred-key-")), "key.txt");
    provider = await scriptedProvider();
    const { base, env } = hermeticBase(provider.baseUrl, keyFile);
    const scope = spawnScope(base, env);
    scopes.push(scope);
    await ready(scope);

    // Before any prompt, get_state reports the pin we spawned with.
    const initial = await request(scope, { type: "get_state" });
    expect(stateModel(initial)?.provider).toBe("nokeyprov");

    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);

    // The switch announcement, exactly as the omp/18.15.0 probe captured it.
    const applied = await pollUntil(
      () => scope.frames.find((f) => f.type === "retry_fallback_applied"),
      60_000,
      "retry_fallback_applied",
    );
    expect(applied.from).toBe("nokeyprov/m1");
    expect(applied.to).toBe("keyprov/m1");
    expect(typeof applied.reason).toBe("string");
    expect(applied.reason!.startsWith("no credential for ")).toBe(true);

    await pollUntil(
      () => (scope.frames.some((f) => f.type === "agent_end") ? true : undefined),
      120_000,
      "turn 1 agent_end",
    );

    // The switch is preceded somewhere by a bare `model_changed` frame.
    const firstEnd = scope.frames.findIndex((f) => f.type === "agent_end");
    expect(scope.frames.slice(0, firstEnd).some((f) => f.type === "model_changed")).toBe(true);

    // The turn ran on the fallback candidate: the assistant message_end names
    // keyprov/m1, and get_state agrees while the record pin (which rpc does
    // not track) stays nokeyprov/m1.
    const firstTurnEnd = assistantEnds(scope.frames)[0];
    expect(firstTurnEnd).toBeDefined();
    expect((firstTurnEnd.message as Record<string, unknown>).provider).toBe("keyprov");
    expect((firstTurnEnd.message as Record<string, unknown>).model).toBe("m1");
    const stateDuring = await request(scope, { type: "get_state" });
    expect(stateModel(stateDuring)?.provider).toBe("keyprov");

    // Credential returns: fill the key file. The command-secret failure backs
    // off for 30 s, so this converges only in real time — fake timers cannot
    // drive a child process — hence a bounded real-clock re-prompt loop every
    // 12 s within a ~180 s budget.
    fs.writeFileSync(keyFile, "returned-key");
    let restored = false;
    const deadline = Date.now() + 180_000;
    while (!restored) {
      if (Date.now() > deadline) throw new Error("timeout waiting for the session to revert to nokeyprov");
      await sleep(12_000);
      await request(scope, { type: "prompt", message: "again" });
      const state = await request(scope, { type: "get_state" });
      restored = String(stateModel(state)?.provider ?? "") === "nokeyprov";
    }
    expect(restored).toBe(true);

    // The revert is announced the same way the switch was: a second bare
    // `model_changed`, no dedicated revert event.
    expect(scope.frames.filter((f) => f.type === "model_changed").length).toBeGreaterThanOrEqual(2);

    // The restoring turn's assistant message_end runs on the pin again.
    const restoredEnd = await pollUntil(
      () => assistantEnds(scope.frames).find((f) => (f.message as Record<string, unknown>).provider === "nokeyprov"),
      60_000,
      "the restoring turn's assistant message_end on nokeyprov",
    );
    expect((restoredEnd.message as Record<string, unknown>).model).toBe("m1");

    // The honesty crux of #1032: across the WHOLE session capture — switch,
    // fallback turn, and revert — omp never emits `config_update`, so a chip
    // sourced from config updates (#970) would keep showing the stale pin.
    expect(scope.frames.some((f) => f.type === "config_update")).toBe(false);
  }, 420_000);
});
