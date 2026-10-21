/**
 * Fleet exec shell launcher (issues #901, #905): the fixed per-platform shells,
 * the win32 pwsh-then-cmd.exe fallback, and the tree kill, shared by the
 * bounded fleet exec runner and the Detached exec owner.
 */
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { ChildProcess } from "node:child_process";

export interface FleetCommandSpec {
  command: string;
  cwd: string | null;
  timeoutMs: number | null;
}

export interface FleetSpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  detached: boolean;
}

export interface FleetCommandDeps {
  platform?: NodeJS.Platform;
  homeDir?: () => string;
  env?: NodeJS.ProcessEnv;
  /** Test seam: the argv triple is handed to this spawner verbatim. */
  spawnFn?: (command: string, args: string[], opts: FleetSpawnOptions) => ChildProcess;
}

interface ShellChoice {
  file: string;
  args: string[];
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** The shells, fixed per platform (deterministic across members, never $SHELL). */
function shellPlan(platform: NodeJS.Platform, command: string): ShellChoice[] {
  if (platform === "win32") {
    return [
      { file: "pwsh", args: ["-NoProfile", "-NonInteractive", "-Command", command] },
      { file: process.env["COMSPEC"] ?? "cmd.exe", args: ["/d", "/c", command] },
    ];
  }
  return [{ file: "/bin/sh", args: ["-c", command] }];
}

/** Group kill on POSIX (the child leads its own group), taskkill tree on win32. */
function killTree(child: ChildProcess, platform: NodeJS.Platform): void {
  if (child.pid === undefined) return;
  if (platform === "win32") {
    try {
      spawn("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    } catch {
      // A dead child or missing taskkill changes nothing about the outcome.
    }
    return;
  }
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch (err) {
    // ESRCH: the tree already exited between the timeout and the kill.
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
}

function defaultSpawn(command: string, args: string[], opts: FleetSpawnOptions): ChildProcess {
  return spawn(command, args, { cwd: opts.cwd, env: opts.env, detached: opts.detached, stdio: ["ignore", "pipe", "pipe"] });
}

/** null runs in the home directory; anything else must be an existing directory. */
export function resolveFleetCwd(cwd: string | null, homeDir: () => string): { ok: true; cwd: string } | { ok: false; reason: string } {
  if (cwd === null) return { ok: true, cwd: homeDir() };
  try {
    if (!fs.statSync(cwd).isDirectory()) throw new Error("not a directory");
  } catch {
    return { ok: false, reason: `cwd ${cwd} is not a directory on this machine` };
  }
  return { ok: true, cwd };
}

export interface FleetShellHandle {
  /** Tree kill of the CURRENT attempt's child; idempotent; no-op after close. */
  kill(): void;
  /**
   * Settles exactly once: resolves when the shell closes or fails to spawn,
   * rejects when no shell could be started at all (the spawner threw).
   */
  done: Promise<{ exitCode: number | null; spawnError: string | null }>;
}

/**
 * Start one command on the fixed shell: fresh child, no PTY, no stdin, its own
 * process group on POSIX. Inherits the node user's environment; the caller can
 * never override env or argv shape. Output reaches `onData` unbounded — the
 * caller owns the byte budget and the timeout.
 */
export function launchFleetShell(
  command: string,
  cwd: string,
  deps: FleetCommandDeps,
  onData: (stream: "stdout" | "stderr", chunk: Buffer) => void,
): FleetShellHandle {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  const plan = shellPlan(platform, command);
  const spawner = deps.spawnFn ?? defaultSpawn;
  const { promise, resolve, reject } = Promise.withResolvers<{ exitCode: number | null; spawnError: string | null }>();
  let current: ChildProcess | null = null;
  let closed = false;
  let killRequested = false;

  const attempt = (index: number): void => {
    const choice = plan[index]!;
    let child: ChildProcess;
    try {
      child = spawner(choice.file, choice.args, { cwd, env, detached: platform !== "win32" });
    } catch (err) {
      closed = true;
      reject(err);
      return;
    }
    current = child;
    child.stdout?.on("data", (chunk: Buffer) => onData("stdout", chunk));
    child.stderr?.on("data", (chunk: Buffer) => onData("stderr", chunk));
    const finish = (exitCode: number | null, spawnError: string | null): void => {
      // A superseded attempt (pwsh after its ENOENT) never settles the handle.
      if (closed || current !== child) return;
      closed = true;
      // A spawn error reports no exit code.
      resolve({ exitCode: spawnError === null ? exitCode : null, spawnError });
    };
    child.on("error", (e) => {
      // Win32: a missing pwsh (ENOENT on spawn error) retries once on cmd.exe,
      // unless a kill already asked this command to stop.
      if ((e as NodeJS.ErrnoException).code === "ENOENT" && index + 1 < plan.length && !killRequested) {
        if (closed || current !== child) return;
        attempt(index + 1);
        return;
      }
      finish(null, messageOf(e));
    });
    child.on("close", (code) => finish(code, null));
  };
  attempt(0);

  return {
    kill(): void {
      if (closed || current === null) return;
      killRequested = true;
      killTree(current, platform);
    },
    done: promise,
  };
}
