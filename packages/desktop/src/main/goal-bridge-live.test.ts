import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  goalArmMessage,
  goalMessage,
  parseGoalSnapshot,
  resolveOmpBinary,
  writeGoalExtension,
} from "@omp-ui/core";
import { GOAL_STATUS_KEY, type GoalSnapshot } from "@omp-ui/core/goal";

/**
 * Live proof for the goal bridge on the REAL `omp --mode=rpc-ui` binary
 * (issue #665): the bridge reads `goal.enabled` through omp's own config
 * registry (ADR-0036), which is the exact call 18.3.2's `Settings` class
 * made without one. The scope's models.yml points `kwprobe/inert` at port 9
 * (discard) so no prompt can ever reach a model; the goal command frames are
 * handled without one regardless. Same harness as magic-keywords-live.test.ts;
 * real timers — the awaited actor is an OS process speaking NDJSON.
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

interface Frame {
  type: string;
  statusKey?: string;
  statusText?: string;
  message?: { role?: string };
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

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

function spawnScope(options: { overlays?: string[] }): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-goal-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML);
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "kwprobe/inert",
    extensions: [writeGoalExtension(lineage)],
    configOverlays: options.overlays ?? [],
    initialCommands: [{ type: "prompt", message: goalArmMessage() }],
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

function latestSnapshot(scope: Scope): GoalSnapshot | null {
  for (let i = scope.frames.length - 1; i >= 0; i--) {
    const frame = scope.frames[i]!;
    if (frame.type === "extension_ui_request" && frame.statusKey === GOAL_STATUS_KEY) {
      const snapshot = parseGoalSnapshot(frame.statusText);
      if (snapshot !== null) return snapshot;
    }
  }
  return null;
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

let scope: Scope | null = null;
afterEach(async () => {
  if (scope !== null) {
    await killScope(scope);
    scope = null;
  }
});

describe.skipIf(ompPath === null)("the goal bridge on the real runtime", () => {
  it("publishes an available snapshot through omp's registry", async () => {
    scope = spawnScope({});
    const snapshot = await waitFor(
      () => {
        const latest = latestSnapshot(scope!);
        return latest !== null && latest.available ? latest : undefined;
      },
      30_000,
      "an available goal snapshot",
    );
    expect(snapshot.unavailable).toBeNull();
  }, 60_000);

  it("reads goal.enabled through the registry and refuses when it is off", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-goal-off-"));
    const overlay = path.join(base, "goal-off.yml");
    fs.writeFileSync(overlay, "goal:\n  enabled: false\n");
    scope = spawnScope({ overlays: [overlay] });
    const armed = await waitFor(
      () => {
        const latest = latestSnapshot(scope!);
        return latest !== null && latest.available ? latest : undefined;
      },
      30_000,
      "an available goal snapshot under the overlay",
    );
    const before = scope.frames.length;
    scope.client.send({
      type: "prompt",
      message: goalMessage({
        requestId: "live-goal-1",
        sessionId: armed.sessionId,
        processKey: armed.processKey,
        command: "goal",
        args: "ship the fix",
      }),
    } as never);
    const settled = await waitFor(
      () => {
        const latest = latestSnapshot(scope!);
        return latest !== null && latest.result?.requestId === "live-goal-1" ? latest : undefined;
      },
      30_000,
      "the correlated goal result",
    );
    expect(settled.result!.ok).toBe(false);
    expect(settled.result!.text).toContain("goal.enabled");
    expect(
      scope.frames
        .slice(before)
        .some((f) => f.type === "message_start" && f.message?.role === "user"),
    ).toBe(false);
    fs.rmSync(base, { recursive: true, force: true });
  }, 60_000);
});
