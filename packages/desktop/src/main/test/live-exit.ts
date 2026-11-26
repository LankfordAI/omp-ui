import { spawn } from "node:child_process";
import type { RpcSpawnFn } from "@omp-ui/core";

/**
 * Snapshot of a live-test child's drained exit state.
 *
 * `exited` flips only on Node's `close` event (via {@link closeAwareSpawn}),
 * after stdout and stderr have completely drained, so a child that emits a
 * valid frame and exits immediately delivers that frame before `exited` flips.
 */
export interface LiveExitState {
  exited: boolean;
  code: number | null;
  error: string | null;
}

/**
 * Thrown by {@link waitForOrExit} when the child process dies before the waited
 * predicate becomes satisfied.
 */
export class PreReadyExit extends Error {
  readonly code: number | null;
  readonly stderrError: string | null;

  constructor(what: string, code: number | null, stderrError: string | null) {
    const codeText = code === null ? "signal/unknown" : `code ${code}`;
    const detail = stderrError ? `: ${stderrError}` : "";
    super(`child exited (${codeText}) before ${what}${detail}`);
    this.name = "PreReadyExit";
    this.code = code;
    this.stderrError = stderrError;
  }

  /**
   * Spontaneous non-zero exit (e.g. `omp` exiting code 1 with "No default model
   * selected") vs. a signal kill (`code === null`) or timeout. Callers that
   * retry transient startup failures skip retries on spontaneous non-zero exit.
   */
  get isNonZeroExit(): boolean {
    return this.code !== null && this.code !== 0;
  }
}

/**
 * Tracks a live-test child's exit code and last `onError` message, ignoring
 * exits caused by the test's own teardown `kill()`.
 */
export class LiveExitTracker {
  #exited = false;
  #code: number | null = null;
  #error: string | null = null;
  #testKilling = false;

  markTestKilling(): void {
    this.#testKilling = true;
  }

  recordError(msg: string): void {
    this.#error = msg;
  }

  recordExit(code: number | null): void {
    if (this.#exited) return;
    this.#exited = true;
    // Preserve null when the test itself initiated kill so callers never
    // mistake teardown for a spontaneous non-zero startup exit.
    this.#code = this.#testKilling ? null : code;
  }

  state(): LiveExitState {
    return {
      exited: this.#exited,
      code: this.#code,
      error: this.#error,
    };
  }
}

/**
 * Returns an {@link RpcSpawnFn} that binds `onExit` to `proc.on("close", ...)`
 * instead of `proc.on("exit", ...)`, ensuring buffered stdout/stderr chunks
 * finish draining into `RpcClient` before `#dead` latches.
 */
export function closeAwareSpawn(envOverride?: NodeJS.ProcessEnv): RpcSpawnFn {
  return (bin, args, baseEnv) => {
    const proc = spawn(bin, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: envOverride ? { ...baseEnv, ...envOverride } : baseEnv,
    });
    return {
      stdin: proc.stdin,
      stdout: proc.stdout,
      stderr: proc.stderr,
      kill: (signal?: NodeJS.Signals) => void proc.kill(signal),
      onExit: (cb: (code: number | null) => void) => proc.on("close", (code) => cb(code)),
      onSpawnError: (cb: (err: Error) => void) => proc.on("error", cb),
    };
  };
}

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig targets ES2022.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls `probe` until it returns a defined value, the child exits (checked
 * after re-probing once so drained frames win), or `timeoutMs` elapses.
 */
export async function waitForOrExit<T>(
  probe: () => Promise<T | undefined> | (T | undefined),
  exitState: () => LiveExitState,
  timeoutMs: number,
  what: string,
  pollIntervalMs = 50,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    const state = exitState();
    if (state.exited) {
      // One final probe after drained close guarantees a frame flushed right
      // before close always wins over PreReadyExit.
      const finalValue = await probe();
      if (finalValue !== undefined) return finalValue;
      throw new PreReadyExit(what, state.code, state.error);
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await sleep(pollIntervalMs);
  }
}
