import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

/** Runs git in `cwd`; rejects on non-zero exit or when `cwd` is outside a repo. */
export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileP("git", args, {
    cwd,
    maxBuffer: 32 * 1024 * 1024,
    encoding: "utf8",
  });
  return stdout;
}
