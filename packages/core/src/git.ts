import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface GitOptions {
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
}

interface GitFailure extends Error {
  killed?: boolean;
  stderr?: string;
}

/** Runs git in `cwd`; rejects on non-zero exit or when `cwd` is outside a repo. */
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
