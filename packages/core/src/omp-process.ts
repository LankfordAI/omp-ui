import { spawn } from "node:child_process";
import * as path from "node:path";
import { withoutAppImageRuntime } from "./appimage-env";
import { PROVIDER_ENV_NAMES, withoutProviderKeys } from "./provider-catalog";

export interface OmpOneShotProcess {
  stdout: NodeJS.ReadableStream;
  stderr: NodeJS.ReadableStream;
  kill(): void;
  onExit(cb: (code: number | null) => void): void;
  onSpawnError(cb: (err: Error) => void): void;
}

export type OmpOneShotSpawn = (
  ompPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
) => OmpOneShotProcess;

export interface RunOmpOnceOptions {
  ompPath: string;
  argv: string[];
  timeout: number;
  /**
   * Provider-credential overlay (`providerKeyEnv`), merged over the sanitized
   * base env at spawn. `ompChildEnv` strips credentials from inheritance, so
   * model-calling one-shots pass this overlay explicitly (finding 9).
   */
  providerEnv?: NodeJS.ProcessEnv;
  /** Test seam — defaults to child_process.spawn over pipes. */
  spawn?: OmpOneShotSpawn;
}

/**
 * The launch environment (AppImage runtime edits removed) with the resolved
 * omp binary's directory first on PATH, so runtime shims also work from
 * desktop launches.
 */
export function ompChildEnv(
  ompPath: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Provider credentials are injected per-spawn by the caller (session-manager
  // passes the resolved store) — never by blanket inheritance, so non-omp
  // children (git, hooks, helpers) cannot pick them up (finding 9,
  // ADR-0010's delivery guarantee moves from process.env to the omp spawn
  // sites that need it).
  const env = withoutProviderKeys(withoutAppImageRuntime(base));
  env.PATH = [path.dirname(ompPath), env.PATH].filter(Boolean).join(path.delimiter);
  return env;
}

/**
 * The provider-credential overlay merged over an omp child's env at spawn:
 * only the omp launch sites call it, so a spawned `git` never sees a key.
 */
export function providerKeyEnv(
  rolloutValue: (envName: string) => string | null,
): NodeJS.ProcessEnv {
  const overlay: NodeJS.ProcessEnv = {};
  for (const name of PROVIDER_ENV_NAMES) {
    const value = rolloutValue(name);
    if (value !== null) overlay[name] = value;
  }
  return overlay;
}

/** child_process.spawn over pipes, stdin closed; the default one-shot launcher. */
export function spawnOmpOneShot(
  ompPath: string,
  argv: string[],
  env: NodeJS.ProcessEnv,
): OmpOneShotProcess {
  const child = spawn(ompPath, argv, { stdio: ["ignore", "pipe", "pipe"], env });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    kill: () => child.kill(),
    onExit: (cb) => child.on("close", cb),
    onSpawnError: (cb) => child.on("error", cb),
  };
}

/** Runs one bounded, non-interactive omp command and returns its stdout on success. */
export async function runOmpOnce(opts: RunOmpOnceOptions): Promise<string | null> {
  let child: OmpOneShotProcess;
  try {
    const env = ompChildEnv(opts.ompPath);
    if (opts.providerEnv !== undefined) Object.assign(env, opts.providerEnv);
    child = (opts.spawn ?? spawnOmpOneShot)(opts.ompPath, opts.argv, env);
  } catch {
    return null;
  }

  return new Promise<string | null>((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (result: string | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      try {
        child.kill();
      } finally {
        finish(null);
      }
    }, opts.timeout);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    // omp writes progress to stderr; drain the pipe so a verbose child cannot stall.
    child.stderr.on("data", () => {});
    child.onSpawnError(() => finish(null));
    child.onExit((code) => finish(code === 0 ? stdout : null));
  });
}
