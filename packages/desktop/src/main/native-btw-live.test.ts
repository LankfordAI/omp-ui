import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, compareVersions, readInstalledOmpVersion, resolveOmpBinary } from "@omp-ui/core";
import { parseBtwRecord } from "@omp-ui/core/side-questions";

/**
 * Pins omp's native side-question RPC (issue #775, upstream #14110) against the
 * REAL `omp --mode=rpc-ui`: `get_btw_history` answers `{records: []}` (the
 * verb is native, not an unknown-command error), `btw` starts a running turn
 * that answers through `btw_record`/`btw_delta` frames, `btw_cancel` cancels
 * it, and none of it touches the transcript. omp owns `btw-history/` as
 * reader and writer, so no generated bridge is loaded.
 *
 * A hermetic HOME whose models.yml points `kwprobe/inert` at port 9 (discard)
 * hangs the ephemeral turn so the cancel path is deterministic. The full
 * answer round trip needs a live model, so it runs against the ambient omp
 * config and skips when none answers.
 *
 * Skips without an omp binary, and per test below omp 18.6.3.
 */

const ompPath = resolveOmpBinary();
/** Mirrors renderer lib/native-btw.ts NATIVE_BTW_MIN_OMP. */
const NATIVE_BTW_FLOOR = "18.6.3";

const MODELS_YML = `providers:
  kwprobe:
    baseUrl: http://127.0.0.1:9/v1
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 4096
        maxTokens: 128
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  record?: Record<string, unknown>;
  recordId?: string;
  delta?: string;
  message?: { role?: string; content?: unknown };
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
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
    await sleep(50);
  }
}

/** A temp base holding a hermetic HOME (inert model, no update check) and its env. */
function hermeticBase(): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-native-btw-live-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML);
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
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

function spawnScope(env: NodeJS.ProcessEnv, model?: string): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-native-btw-live-"));
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
    model,
    configOverlays: [],
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

afterEach(async () => {
  for (const scope of scopes.splice(0)) await killScope(scope);
});

let sequence = 0;
/** Sends one command and waits for its correlated response. */
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  sequence += 1;
  const id = `btw-live-${sequence}`;
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

/** The transcript frames a side question must never produce. */
function transcriptCarrying(scope: Scope, needle: string): Frame[] {
  return scope.frames.filter(
    (f) =>
      (f.type === "message_update" || f.type === "message_end") &&
      JSON.stringify(f.message ?? "").includes(needle),
  );
}

describe.skipIf(ompPath === null)("omp's native btw commands on the real runtime", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });
  const needsNativeBtw = (ctx: { skip: (note?: string) => void }): void => {
    if (version === null || compareVersions(version, NATIVE_BTW_FLOOR) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates the native btw commands (${NATIVE_BTW_FLOOR})`);
    }
  };

  it("answers get_btw_history natively on a fresh session", async (ctx) => {
    needsNativeBtw(ctx);
    const scope = spawnScope(hermeticBase().env);
    scopes.push(scope);
    await ready(scope);

    const history = await request(scope, { type: "get_btw_history" });
    expect(history.success).toBe(true);
    expect(history.data?.records).toEqual([]);
    // The unknown-command path proves the assertion above is real: the verb
    // resolved instead of erroring like an unsupported command would.
  }, 120_000);

  it("runs, cancels, and records a side question without a transcript row", async (ctx) => {
    needsNativeBtw(ctx);
    const scope = spawnScope(hermeticBase().env);
    scopes.push(scope);
    await ready(scope);

    const question = "hold open for the native btw cancel test";
    const asked = await request(scope, { type: "btw", question });
    expect(asked.success).toBe(true);
    const running = parseBtwRecord(JSON.stringify(asked.data?.record ?? null));
    expect(running?.status).toBe("running");
    if (running === null) throw new Error("btw answered without a well-formed running record");

    // The inert model hangs the ephemeral turn on the discard port, so the
    // topic is still running here — no deltas can have completed.
    const cancelled = await request(scope, { type: "btw_cancel" });
    expect(cancelled.success).toBe(true);
    expect(cancelled.data?.cancelled).toBe(true);

    // The lifecycle frames: a btw_record for the running topic (last-per-id
    // wins) ending on the cancelled status.
    const settled = await pollUntil(
      () =>
        scope.frames
          .filter((f) => f.type === "btw_record" && f.record?.id === running.id)
          .map((f) => parseBtwRecord(JSON.stringify(f.record ?? null)))
          .find((r) => r !== null && r.status !== "running") ?? undefined,
      30_000,
      "the cancelled btw_record",
    );
    expect(settled?.status).toBe("cancelled");

    const history = await request(scope, { type: "get_btw_history" });
    const records = (history.data?.records ?? []) as Record<string, unknown>[];
    expect(records.map((r) => r.id)).toContain(running.id);

    // The side question never entered the transcript.
    expect(transcriptCarrying(scope, question)).toEqual([]);
  }, 180_000);

  it("answers a side question end to end (needs a live model)", async (ctx) => {
    needsNativeBtw(ctx);
    // The ambient omp config: hermetic HOME has no reachable real model. The
    // session itself lives in a temp lineage dir, never the user's history.
    const scope = spawnScope(process.env);
    scopes.push(scope);
    try {
      await ready(scope);
    } catch {
      return ctx.skip("no usable ambient omp config in this environment");
    }

    const question = "Reply with the single word: pong";
    const asked = await request(scope, { type: "btw", question });
    expect(asked.success).toBe(true);
    if (asked.success !== true) return ctx.skip(`no live model in this environment: ${asked.error}`);

    const settled = await pollUntil(
      () =>
        scope.frames
          .filter((f) => f.type === "btw_record")
          .map((f) => parseBtwRecord(JSON.stringify(f.record ?? null)))
          .find((r) => r !== null && r.status !== "running") ?? undefined,
      120_000,
      "the side question to settle",
    );
    if (settled.status !== "complete")
      return ctx.skip(`no live model in this environment: ${settled.error ?? settled.status}`);
    expect(settled.answer.trim()).not.toBe("");
    expect(
      scope.frames.some((f) => f.type === "btw_delta" && f.recordId === settled.id && (f.delta ?? "").length > 0),
    ).toBe(true);

    const history = await request(scope, { type: "get_btw_history" });
    const records = (history.data?.records ?? []) as Record<string, unknown>[];
    expect(records.find((r) => r.id === settled.id)?.status).toBe("complete");
    expect(transcriptCarrying(scope, "pong")).toEqual([]);
  }, 180_000);
});
