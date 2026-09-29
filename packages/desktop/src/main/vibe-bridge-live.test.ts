import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  parseVibeSnapshot,
  resolveOmpBinary,
  vibeArmMessage,
  vibeMessage,
  writeVibeExtension,
} from "@omp-ui/core";
import { VIBE_STATUS_KEY, type VibeSnapshot } from "@omp-ui/core/vibe";

/**
 * Live proof for the vibe bridge on the REAL `omp --mode=rpc-ui` binary
 * (issue #683), in two tiers:
 *
 * 1. The hermetic tier runs every mode/command path against an inert model
 *    (port 9, discard) in an isolated HOME — hidden commands settle through
 *    omp's vibe runtime without a model ever being called.
 * 2. The worker tier spawns real vibe workers, so it needs a reachable model
 *    session; it follows the #86 convention of skipping cleanly when the
 *    environment cannot produce one. The crash-resume stage proves the
 *    restore path re-arms a transcript that never exited vibe mode.
 *
 * Real timers on purpose: the awaited actor is an OS process speaking NDJSON.
 */

const ompPath = resolveOmpBinary();

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

type Frame = {
  type: string;
  id?: string;
  statusKey?: string;
  statusText?: string;
  data?: { isStreaming?: boolean; queuedMessageCount?: number; subagents?: Array<{ id: string }> };
  subagents?: Array<{ id: string }>;
};

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

interface SpawnOptions {
  /** Isolate HOME behind an inert model; false inherits the machine's session. */
  hermetic: boolean;
  base?: string;
  resumeSessionId?: string;
  overlays?: string[];
}

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function spawnScope(options: SpawnOptions): Scope {
  const base = options.base ?? fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vibe-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  if (options.hermetic) {
    const home = path.join(base, "home");
    fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML);
    fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  }
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: options.hermetic ? project : base,
    lineageDir: lineage,
    ompPath: ompPath!,
    ...(options.hermetic ? { model: "kwprobe/inert" } : {}),
    extensions: [writeVibeExtension(lineage)],
    ...(options.overlays !== undefined ? { configOverlays: options.overlays } : {}),
    ...(options.resumeSessionId !== undefined ? { resumeSessionId: options.resumeSessionId } : {}),
    initialCommands: [{ type: "prompt", message: vibeArmMessage() }],
    ...(options.hermetic
      ? {
          spawnProcess: (bin: string, args: string[], extra: NodeJS.ProcessEnv) => {
            const proc = spawn(bin, args, {
              stdio: ["pipe", "pipe", "pipe"],
              env: {
                ...extra,
                HOME: path.join(base, "home"),
                XDG_CONFIG_HOME: path.join(base, "home", ".config"),
                XDG_DATA_HOME: path.join(base, "home", ".local", "share"),
              },
            });
            return {
              stdin: proc.stdin,
              stdout: proc.stdout,
              stderr: proc.stderr,
              kill: (signal?: NodeJS.Signals) => void proc.kill(signal),
              onExit: (cb: (code: number | null) => void) => proc.on("exit", (code) => cb(code)),
              onSpawnError: (cb: (error: Error) => void) => proc.on("error", cb),
            };
          },
        }
      : {}),
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: () => {},
  });
  return { base, lineage, frames, client, exited };
}

function latest(scope: Scope): VibeSnapshot | null {
  for (let i = scope.frames.length - 1; i >= 0; i--) {
    const frame = scope.frames[i]!;
    if (frame.type === "extension_ui_request" && frame.statusKey === VIBE_STATUS_KEY) {
      const snapshot = parseVibeSnapshot(frame.statusText);
      if (snapshot !== null) return snapshot;
    }
  }
  return null;
}

/** An arm-complete (available) snapshot; the bridge's first publish. */
function armed(scope: Scope): Promise<VibeSnapshot> {
  return waitFor(
    () => {
      const value = latest(scope);
      return value !== null && value.available ? value : undefined;
    },
    30_000,
    "an available vibe snapshot",
  );
}

let requestCounter = 0;

/** Dispatches one command and returns the snapshot whose result carries it. */
function command(
  scope: Scope,
  snapshot: VibeSnapshot,
  commandName: string,
  args = "",
  timeoutMs = 60_000,
): Promise<VibeSnapshot> {
  requestCounter += 1;
  const requestId = `live-vibe-${requestCounter}`;
  const before = snapshot.revision;
  scope.client.send({
    type: "prompt",
    message: vibeMessage({
      requestId,
      sessionId: snapshot.sessionId,
      processKey: snapshot.processKey,
      command: commandName as never,
      args,
    }),
  } as never);
  return waitFor(
    () => {
      const value = latest(scope);
      return value !== null && value.revision > before && value.result?.requestId === requestId
        ? value
        : undefined;
    },
    timeoutMs,
    `the result of ${commandName}`,
  );
}

/** A command that must succeed; fails with the bridge's own text otherwise. */
async function ok(
  scope: Scope,
  snapshot: VibeSnapshot,
  commandName: string,
  args = "",
  timeoutMs = 60_000,
): Promise<VibeSnapshot> {
  const settled = await command(scope, snapshot, commandName, args, timeoutMs);
  expect(settled.result!.ok, `vibe ${commandName}: ${settled.result!.text}`).toBe(true);
  return settled;
}

async function killScope(scope: Scope, signal?: NodeJS.Signals): Promise<void> {
  scope.client.kill(signal);
  const exitedNow = await Promise.race([
    scope.exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
}

/** Every jsonl under the lineage dir (session dirs nest one level). */
function transcripts(scope: Scope): string {
  return fs
    .readdirSync(scope.lineage)
    .flatMap((name) => {
      const full = path.join(scope.lineage, name);
      return fs.statSync(full).isDirectory()
        ? fs.readdirSync(full).map((child) => path.join(full, child))
        : [full];
    })
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

const scopes: Scope[] = [];
afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    await killScope(scope);
    fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe.skipIf(ompPath === null)("the vibe bridge on the real runtime", () => {
  it("drives mode and command round-trips with no model in reach", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vibe-live-"));
    // activateVibeTools resolves the fast/good agents' models; pin both to
    // the inert model so nothing may reach a provider.
    const overlay = path.join(base, "worker-model.yml");
    fs.writeFileSync(overlay, "task:\n  agentModelOverrides:\n    sonic: kwprobe/inert\n    task: kwprobe/inert\n");
    const scope = spawnScope({ hermetic: true, base, overlays: [overlay] });
    scopes.push(scope);
    let snapshot = await armed(scope);
    expect(snapshot.unavailable).toBeNull();
    expect(snapshot.enabled).toBe(false);
    expect(snapshot.workers).toEqual([]);

    // A command addressed to another process is never applied.
    const beforeForeign = snapshot.revision;
    scope.client.send({
      type: "prompt",
      message: vibeMessage({
        requestId: "foreign",
        sessionId: snapshot.sessionId,
        processKey: "omp-ui-someone-elses",
        command: "toggle",
        args: "",
      }),
    } as never);
    await sleep(1_000);
    expect(latest(scope)!.revision).toBe(beforeForeign);
    expect(latest(scope)!.enabled).toBe(false);

    snapshot = await ok(scope, snapshot, "toggle");
    expect(snapshot.enabled).toBe(true);
    expect(snapshot.result!.text).toContain("Vibe mode on");

    snapshot = await ok(scope, snapshot, "list");
    expect(snapshot.result!.text).toBe("No vibe workers.");

    // spawn's argument contract settles through the published result, not a
    // tool error thrown into a model turn.
    snapshot = await command(scope, snapshot, "spawn", JSON.stringify({ cli: "fast" }));
    expect(snapshot.result!.ok).toBe(false);
    expect(snapshot.result!.text).toContain("prompt");

    snapshot = await ok(scope, snapshot, "toggle");
    expect(snapshot.enabled).toBe(false);

    // A second cycle proves enter/exit round-trips on the real runtime.
    snapshot = await ok(scope, snapshot, "toggle");
    expect(snapshot.enabled).toBe(true);
    snapshot = await ok(scope, snapshot, "off");
    expect(snapshot.enabled).toBe(false);
    // (No transcript assertion here: an inert model never flushes a session
    // file — the worker tier's resume stage proves mode persistence.)
  }, 120_000);

  it("runs a worker round-trip and re-arms a crashed mode after resume", async (ctx) => {
    if (ompPath === null) ctx.skip("omp binary not found");
    // Workers need a model that actually answers; pin the agent roles the
    // fast/good clis resolve to, same convention as subagent-model-live.
    const pin = process.env.OMP_UI_LIVE_VIBE_MODEL ?? "openrouter/openai/gpt-5.6-luna:medium";
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-vibe-live-"));
    const overlay = path.join(base, "worker-model.yml");
    fs.writeFileSync(overlay, `task:\n  agentModelOverrides:\n    sonic: ${pin}\n    task: ${pin}\n`);
    const scope = spawnScope({ hermetic: false, base, overlays: [overlay] });
    scopes.push(scope);
    const readyId = "vibe-ready-probe";
    scope.client.send({ type: "get_state", id: readyId });
    try {
      await waitFor(
        () => (scope.frames.some((f) => f.type === "response" && f.id === readyId) ? true : undefined),
        60_000,
        "oauth ready response",
      );
    } catch (error) {
      ctx.skip(`no model session became ready (${String(error)}); worker spawns need one`);
    }
    let snapshot = await armed(scope);

    snapshot = await ok(scope, snapshot, "toggle");
    expect(snapshot.enabled).toBe(true);

    // Spawn one fast worker: its first turn starts immediately.
    const spawned = await ok(
      scope,
      snapshot,
      "spawn",
      JSON.stringify({ cli: "fast", prompt: "Reply with exactly ok and nothing else." }),
      120_000,
    );
    const workerId = spawned.workers[0]?.id;
    if (workerId === undefined) throw new Error(`spawn published an empty roster: ${spawned.result!.text}`);
    expect(spawned.workers[0]!.state).toMatch(/starting|running/);

    // The parent transcript carries omp's own spawn lifecycle entry: the
    // restore path's source for the parked roster after a crash.
    await waitFor(
      () => (transcripts(scope).includes('"action":"spawn"') ? true : undefined),
      30_000,
      "the spawn lifecycle entry in the transcript",
    );

    // The worker appears on omp's own subagent channel while its turn runs.
    let polls = 0;
    const liveRows = await waitFor(
      () => {
        if (polls % 5 === 0) scope.client.send({ type: "get_subagents", id: `gs-${polls}` });
        polls += 1;
        const rows = scope.frames.filter(
          (f) => f.type === "response" && Array.isArray(f.data?.subagents),
        );
        const last = rows.at(-1)?.data?.subagents;
        return last?.some((row) => row.id === workerId) ? last : undefined;
      },
      60_000,
      "the worker in get_subagents",
    );
    expect(liveRows.some((row) => row.id === workerId)).toBe(true);

    // vibe_wait settles the first turn; the roster reports the settled row.
    snapshot = await ok(
      scope,
      spawned,
      "wait",
      JSON.stringify({ sessions: [workerId], timeout: 240 }),
      270_000,
    );
    expect(snapshot.workers.some((worker) => worker.turns >= 1)).toBe(true);

    // omp's own list drops the killed screen; the tool's text is the proof.
    snapshot = await ok(scope, snapshot, "kill", JSON.stringify({ session: workerId }));
    expect(snapshot.result!.text).toContain(workerId);
    snapshot = await ok(scope, snapshot, "toggle");
    expect(snapshot.enabled).toBe(false);

    // Crash path: enter and spawn again, then SIGKILL mid-mode so the
    // transcript's last mode entry stays `vibe` with no tombstone.
    snapshot = await ok(scope, snapshot, "toggle");
    snapshot = await ok(
      scope,
      snapshot,
      "spawn",
      JSON.stringify({ cli: "fast", prompt: "Reply with exactly ok and nothing else." }),
      120_000,
    );
    const crashedSession = snapshot.sessionId;
    await killScope(scope, "SIGKILL");

    // Resume in a fresh process: the bridge restores from the transcript and
    // re-arms the mode the crash left on.
    const resumed = spawnScope({ hermetic: false, base: scope.base, resumeSessionId: crashedSession });
    scopes.push(resumed);
    let restored = await armed(resumed);
    expect(restored.enabled).toBe(true);
    restored = await ok(resumed, restored, "toggle");
    expect(restored.enabled).toBe(false);
  }, 420_000);
});
