import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RpcClient,
  compareVersions,
  execOmpConfigRunner,
  goalStateFromFrame,
  readInstalledOmpVersion,
  readOmpGoalContinuationModes,
  resolveOmpBinary,
  writeGoalContinuationOverlay,
} from "@omp-ui/core";

/**
 * Pins omp's native goal surface (issue #712, ADR-0046) against the REAL
 * `omp --mode=rpc-ui`: the `{ type: "goal", op }` command, `get_state.goal`,
 * `goal_updated` events, and the `goal.continuationModes` overlay that lets omp
 * continue a goal under rpc. A hermetic HOME whose models.yml points
 * `kwprobe/inert` at port 9 (discard) keeps every turn away from a real model.
 * Real timers: the awaited actor is an OS process speaking NDJSON.
 *
 * Skips without an omp binary, and per test below omp 18.4.11 (no goal command).
 */

const ompPath = resolveOmpBinary();
const NATIVE_GOAL_FLOOR = "18.4.11";

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
  command?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  message?: { role?: string; customType?: string };
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

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

/** A temp base holding a hermetic HOME (inert model, no update check) and its env. */
function hermeticBase(): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-goal-native-live-"));
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

function spawnScope(options: { overlay?: (lineage: string) => string | null } = {}): Scope {
  const { base, env } = hermeticBase();
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const overlay = options.overlay?.(lineage) ?? null;
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
    configOverlays: overlay === null ? [] : [overlay],
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
  const id = `goal-live-${sequence}`;
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

let scope: Scope | null = null;
const cleanups: (() => void)[] = [];
afterEach(async () => {
  if (scope !== null) {
    await killScope(scope);
    scope = null;
  }
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe.skipIf(ompPath === null)("omp's native goal command on the real runtime", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });
  const needsNativeGoals = (ctx: { skip: (note?: string) => void }): void => {
    if (version === null || compareVersions(version, NATIVE_GOAL_FLOOR) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates the native goal command (${NATIVE_GOAL_FLOOR})`);
    }
  };

  it("drives get, create, pause and drop over rpc and reports state in every frame", async (ctx) => {
    needsNativeGoals(ctx);
    scope = spawnScope();
    await ready(scope);

    const empty = await request(scope, { type: "goal", op: "get" });
    expect(empty.success).toBe(true);
    expect(empty.data).toEqual({ goal: null, state: null });

    const created = await request(scope, {
      type: "goal",
      op: "create",
      objective: "ship the fix",
      token_budget: 5000,
    });
    expect(created.success).toBe(true);
    const state = goalStateFromFrame(created);
    expect(state).toMatchObject({
      enabled: true,
      exiting: false,
      goal: { objective: "ship the fix", status: "active", tokenBudget: 5000 },
    });
    const goalId = state!.goal.id;
    await waitFor(
      () => scope!.frames.find((f) => f.type === "goal_updated" && goalStateFromFrame(f)?.goal.id === goalId),
      15_000,
      "a goal_updated event for the new goal",
    );

    const snapshot = await request(scope, { type: "get_state" });
    expect(goalStateFromFrame(snapshot)?.goal.id).toBe(goalId);

    const paused = await request(scope, { type: "goal", op: "pause" });
    expect(paused.success).toBe(true);
    expect(goalStateFromFrame(paused)).toMatchObject({ enabled: false, goal: { id: goalId, status: "paused" } });

    const refused = await request(scope, { type: "goal", op: "create", objective: "another" });
    expect(refused.success).toBe(false);
    expect(refused.error).toMatch(/^Resume or drop the paused goal/);

    const dropped = await request(scope, { type: "goal", op: "drop" });
    expect(dropped.success).toBe(true);
    expect(goalStateFromFrame(dropped)).toBeNull();
  }, 120_000);

  it("continues a created goal on its own under the rpc continuation overlay", async (ctx) => {
    needsNativeGoals(ctx);
    scope = spawnScope({
      overlay: (lineage) => writeGoalContinuationOverlay(lineage, ["interactive", "rpc"]),
    });
    await ready(scope);

    const created = await request(scope, { type: "goal", op: "create", objective: "ship the fix" });
    expect(created.success).toBe(true);
    await waitFor(
      () =>
        scope!.frames.find(
          (f) => f.type === "message_start" && f.message?.customType === "goal-continuation",
        ),
      15_000,
      "omp's own goal-continuation turn",
    );
  }, 120_000);

  it("reads the user's goal.continuationModes default through omp config", async (ctx) => {
    needsNativeGoals(ctx);
    const { base, env } = hermeticBase();
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    const modes = await readOmpGoalContinuationModes(
      { ompPath: ompPath!, projectCwd: base },
      execOmpConfigRunner(ompPath!),
      env,
    );
    expect(modes).toEqual(["interactive"]);
  }, 60_000);
});
