import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, compareVersions, readInstalledOmpVersion, resolveOmpBinary } from "@omp-ui/core";

/**
 * Pins omp's native `fork` RPC (issue #717) against the REAL `omp --mode=rpc-ui`
 * and the same-dir premise the whole feature rests on: the forked file lands in
 * the process's `--session-dir` (the record's lineageDir) — no fresh lineage is
 * minted — with `parentSession` pointing at the source file, while the source
 * stays byte-identical. A hermetic HOME whose models.yml points `kwprobe/inert`
 * at port 9 (discard) keeps every turn away from a real model; the hung turn is
 * aborted to reach the idle state `fork` requires. Real timers: the awaited
 * actor is an OS process speaking NDJSON.
 *
 * Skips without an omp binary, and per test below below omp 18.4.11 (no fork
 * command).
 */

const ompPath = resolveOmpBinary();
const NATIVE_FORK_FLOOR = "18.4.11";

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
}

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  // A real process is the thing waited on, so a real timer is the only clock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  return pollUntil(async () => probe(), timeoutMs, what);
}

/** The async sibling: probes may themselves await (a one-shot rpc read). */
async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/** A temp base holding a hermetic HOME (inert model, no update check) and its env. */
function hermeticBase(): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-fork-native-live-"));
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

function spawnScope(): Scope {
  const { base, env } = hermeticBase();
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
    model: "kwprobe/inert",
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
  return { base, lineage, frames, client, exited };
}

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

let sequence = 0;
/** Sends one command and waits for its correlated response. */
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  sequence += 1;
  const id = `fork-live-${sequence}`;
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

/** get_entries data: the entries array and leafId. */
async function entriesOf(scope: Scope): Promise<Record<string, unknown>[]> {
  const resp = await request(scope, { type: "get_entries" });
  expect(resp.success).toBe(true);
  return (resp.data?.entries ?? []) as Record<string, unknown>[];
}

let scope: Scope | null = null;
afterEach(async () => {
  if (scope !== null) {
    await killScope(scope);
    scope = null;
  }
});

describe.skipIf(ompPath === null)("omp's native fork command on the real runtime", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });
  const needsNativeFork = (ctx: { skip: (note?: string) => void }): void => {
    if (version === null || compareVersions(version, NATIVE_FORK_FLOOR) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates the native fork command (${NATIVE_FORK_FLOOR})`);
    }
  };

  it("forks at a user entry into a new same-dir file and leaves the source untouched", async (ctx) => {
    needsNativeFork(ctx);
    scope = spawnScope();
    await ready(scope);

    const before = await request(scope, { type: "get_state" });
    expect(before.success).toBe(true);
    const originalId = String(before.data!.sessionId);
    const originalFile = String(before.data!.sessionFile);

    sequence += 1;
    scope.client.send({ type: "prompt", message: "hold for the fork test", id: `fork-live-p${sequence}` } as never);
    // The user entry is recorded at prompt time, before the model answers.
    const entryId = await pollUntil(
      async () => {
        // The user entry is recorded at prompt time, before the model answers.
        const entries = await entriesOf(scope!);
        const found = entries.find(
          (e) =>
            e.type === "message" &&
            (e.message as { role?: string } | undefined)?.role === "user",
        );
        return found === undefined ? undefined : String(found.id);
      },
      30_000,
      "the user entry in get_entries",
    );

    // The inert model hangs the turn on the discard port; abort it, then wait
    // for the idle state `fork`'s requireIdle insists on.
    sequence += 1;
    scope.client.send({ type: "abort", id: `fork-live-a${sequence}` } as never);
    await pollUntil(
      async () => {
        const state = await request(scope!, { type: "get_state" });
        return state.data?.isStreaming === false ? true : undefined;
      },
      90_000,
      "the session to go idle",
    );
    // omp creates the source file at the first append and the abort can
    // still append at the turn's unwind: snapshot once the session is idle,
    // the last point the source's bytes could legitimately move.
    const originalBytes = fs.readFileSync(originalFile);

    const forked = await request(scope, { type: "fork", entryId });
    expect(forked.success).toBe(true);
    expect(forked.data!.cancelled).toBe(false);

    const after = await request(scope, { type: "get_state" });
    expect(after.success).toBe(true);
    const newId = String(after.data!.sessionId);
    const newFile = String(after.data!.sessionFile);
    // The same-dir premise: a fresh sessionId in the same lineage dir.
    expect(newId).not.toBe(originalId);
    expect(path.dirname(newFile)).toBe(path.dirname(originalFile));

    const lines = fs
      .readFileSync(newFile, "utf8")
      .split("\n")
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    const header = lines.find((line) => line.type === "session");
    expect(header).toBeDefined();
    expect(header!.id).toBe(newId);
    expect(header!.parentSession).toBe(originalFile);
    // The new file ends on the fork path: the forked entry is its last entry.
    expect(lines.at(-1)!.id).toBe(entryId);

    // The source file is byte-identical and still on disk.
    expect(fs.readFileSync(originalFile)).toEqual(originalBytes);

    // A bogus entry id is refused, and nothing moves.
    const refused = await request(scope, { type: "fork", entryId: "no-such-entry" });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/Invalid entry ID for forking/);
    const still = await request(scope, { type: "get_state" });
    expect(String(still.data!.sessionId)).toBe(newId);
  }, 180_000);
});
