import { spawn } from "node:child_process";
import * as path from "node:path";

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
  /** Test seam — defaults to child_process.spawn over pipes. */
  spawn?: OmpOneShotSpawn;
}

/**
 * Copies the parent environment and exposes the resolved omp binary's directory
 * first on PATH, so runtime shims also work from desktop launches.
 */
export function ompChildEnv(
  ompPath: string,
  base: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  return {
    ...base,
    PATH: [path.dirname(ompPath), base.PATH].filter(Boolean).join(path.delimiter),
  };
}

function defaultSpawn(
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
    child = (opts.spawn ?? defaultSpawn)(opts.ompPath, opts.argv, ompChildEnv(opts.ompPath));
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
