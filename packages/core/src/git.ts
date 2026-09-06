import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GitOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Exit codes that are answers, not failures: their stdout resolves instead of rejecting. */
  allowExit?: number[];
}

interface GitFailure extends Error {
  killed?: boolean;
  stderr?: string;
  stdout?: string;
  code?: number | null;
}

/** Runs git in `cwd`; rejects on non-zero exit or when `cwd` is outside a repo. Exit codes listed in `allowExit` resolve with their stdout instead — probes like `merge-tree` answer through them. */
export async function git(
  cwd: string,
  args: string[],
  options: GitOptions = {},
): Promise<string> {
  try {
    const { stdout } = await execFileP("git", args, {
      cwd,
      env: { ...process.env, ...options.env },
      timeout: options.timeoutMs,
      maxBuffer: 32 * 1024 * 1024,
      encoding: "utf8",
    });
    return stdout;
  } catch (error) {
    const failure = error as GitFailure;
    const exitCode = typeof failure.code === "number" ? failure.code : null;
    if (
      exitCode !== null &&
      options.allowExit !== undefined &&
      options.allowExit.includes(exitCode)
    ) {
      return typeof failure.stdout === "string" ? failure.stdout : "";
    }
    const stderr = typeof failure.stderr === "string" ? failure.stderr.trim() : "";
    if (stderr) throw new Error(stderr, { cause: error });
    if (failure.killed && options.timeoutMs !== undefined) {
      throw new Error(`git ${args[0]} timed out after ${options.timeoutMs} ms`, {
        cause: error,
      });
    }
    throw error;
  }
}
