/**
 * Routine run-hook runner (issue #1283, ADR-0100 amendment): one bounded shell
 * command per phase, executed through `launchFleetShell` so the fixed per-platform
 * shells, detached process group, and tree kill are shared with fleet exec.
 * Both entry points resolve — never reject — for script reasons; the callers
 * (scheduler pre hook, lifecycle post hook) treat a resolution as total.
 */
import {
  ROUTINE_SCRIPT_SKIP_EXIT_CODE,
  ROUTINE_SCRIPT_TIMEOUT_MS,
  withoutAppImageRuntime,
  withoutProviderKeys,
} from "@omp-ui/core";
import { launchFleetShell, messageOf, type FleetCommandDeps, type FleetShellHandle } from "./fleet-shell";

export const ROUTINE_TEST_OUTPUT_CAP = 16_384; // bytes kept per stream for Test script only
export const ROUTINE_SCRIPT_ENV_PREFIX = "OMP_UI_ROUTINE_";

export interface RoutineScriptEnv {
  /** Absent for the attended Test action (#1283). */
  OMP_UI_ROUTINE_ID?: string;
  OMP_UI_ROUTINE_TRIGGER: "clock" | "late" | "manual" | "test";
  OMP_UI_ROUTINE_PROJECT_CWD: string;
  /** pre/post phase only. */
  OMP_UI_ROUTINE_WORKSPACE?: "worktree" | "checkout";
  /** post phase only. */
  OMP_UI_ROUTINE_OUTCOME?: "on-time" | "late" | "failed";
  /** Fixed enum, or "" for none; post phase only. */
  OMP_UI_ROUTINE_REASON_CODE?: string;
  /** post phase only. */
  OMP_UI_ROUTINE_TAB_ID?: string;
  /** post phase: the run's actual working directory. */
  OMP_UI_ROUTINE_RUN_CWD?: string;
}

export type RoutineScriptResult =
  | { kind: "ok" } // exit 0
  | { kind: "skip" } // exit === ROUTINE_SCRIPT_SKIP_EXIT_CODE
  | { kind: "failed"; timedOut: boolean; exitCode: number | null };

/** Live children so gate-off / quit can reap what `sessions.killAll()` never sees. */
const live = new Set<FleetShellHandle>();

/** Kill every live hook group; each call then settles through the timeout path. */
export function cancelAllRoutineScripts(): void {
  for (const handle of live) {
    try {
      handle.kill();
    } catch {
      // Already gone: the close handler removes it from the set.
    }
  }
}

class StreamTail {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly cap: number) {}

  push(chunk: Buffer): void {
    if (this.bytes >= this.cap) return; // drop-after-cap; the head is kept
    const room = this.cap - this.bytes;
    const kept = chunk.length > room ? chunk.subarray(0, room) : chunk;
    this.chunks.push(Buffer.from(kept));
    this.bytes += kept.length;
  }

  text(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

async function run(
  command: string,
  cwd: string,
  env: RoutineScriptEnv,
  keepOutput: boolean,
  deps?: FleetCommandDeps & { timeoutMs?: number },
): Promise<RoutineScriptResult & { stdout: string; stderr: string }> {
  const base = withoutProviderKeys(withoutAppImageRuntime(deps?.env ?? process.env));
  // A nested hook (a routine fired from a shell that itself ran a hook) must
  // never inherit stale outcome/tab values: sweep every inherited phase
  // variable before setting this phase's own.
  const spawnEnv: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(spawnEnv)) {
    if (key.startsWith(ROUTINE_SCRIPT_ENV_PREFIX)) delete spawnEnv[key];
  }
  Object.assign(spawnEnv, env);
  // withoutProviderKeys removes the exact catalogued provider names only: a
  // hook still sees ordinary shell credentials (gh, AWS, SSH agent). That is
  // intended — and exactly why the editor carries the copper hook warning.

  const out = new StreamTail(ROUTINE_TEST_OUTPUT_CAP);
  const err = new StreamTail(ROUTINE_TEST_OUTPUT_CAP);
  let timedOut = false;
  let handle: FleetShellHandle | undefined;
  try {
    handle = launchFleetShell(command, cwd, { ...deps, env: spawnEnv }, (stream, chunk) => {
      if (!keepOutput) return; // unattended: output is counted-and-dropped by construction
      if (stream === "stdout") out.push(chunk);
      else err.push(chunk);
    });
    live.add(handle);
    const target = handle;
    // `handle.done` resolves on child close or spawn error; a descendant that
    // inherited a pipe, or a kill that failed, can hold `close` open forever —
    // so the deadline settles the promise itself, never just the kill.
    const expired = Promise.withResolvers<{ exitCode: null; spawnError: string }>();
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        target.kill();
      } catch {
        // best-effort cleanup, never fatal
      }
      expired.resolve({ exitCode: null, spawnError: "timeout" });
    }, deps?.timeoutMs ?? ROUTINE_SCRIPT_TIMEOUT_MS);
    const finished = await Promise.race([
      handle.done.then(
        (r) => ({ ...r, timedOut: false }),
        (e: unknown) => ({ exitCode: null as number | null, spawnError: messageOf(e), timedOut: false }),
      ),
      expired.promise.then((r) => ({ ...r, timedOut: true })),
    ]).finally(() => clearTimeout(timer));

    if (finished.timedOut) {
      // The race settled on the timer: a later exit 0/78 can never outrank it.
      return { kind: "failed", timedOut: true, exitCode: finished.exitCode, stdout: out.text(), stderr: err.text() };
    }
    if (finished.spawnError !== null) {
      return { kind: "failed", timedOut: false, exitCode: null, stdout: out.text(), stderr: err.text() };
    }
    if (finished.exitCode === 0) return { kind: "ok", stdout: out.text(), stderr: err.text() };
    if (finished.exitCode === ROUTINE_SCRIPT_SKIP_EXIT_CODE) {
      // The skip convention is pre-only; the post caller maps it to "failed".
      return { kind: "skip", stdout: out.text(), stderr: err.text() };
    }
    return {
      kind: "failed",
      timedOut: false,
      exitCode: finished.exitCode,
      stdout: out.text(),
      stderr: err.text(),
    };
  } catch {
    // A wiring bug, not an exit status: callers resolve either way.
    return { kind: "failed", timedOut, exitCode: null, stdout: "", stderr: "" };
  } finally {
    if (handle !== undefined) live.delete(handle);
  }
}

/** Unattended phases: output is counted and dropped, never retained (#1254). */
export function runRoutineScript(
  command: string,
  cwd: string,
  env: RoutineScriptEnv,
  deps?: FleetCommandDeps & { timeoutMs?: number },
): Promise<RoutineScriptResult> {
  return run(command, cwd, env, false, deps).then((result): RoutineScriptResult => {
    if (result.kind === "ok") return { kind: "ok" };
    if (result.kind === "skip") return { kind: "skip" };
    return { kind: "failed", timedOut: result.timedOut, exitCode: result.exitCode };
  });
}

/** Attended Test action only: returns the capped tails alongside the result. */
export function runRoutineScriptForTest(
  command: string,
  cwd: string,
  env: RoutineScriptEnv,
  deps?: FleetCommandDeps & { timeoutMs?: number },
): Promise<RoutineScriptResult & { stdout: string; stderr: string }> {
  return run(command, cwd, env, true, deps);
}
