import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Rebinding a session file to a new working directory (issue #334).
 *
 * omp binds a session to the directory it was created in: the `"type":"session"`
 * header line carries `cwd`, and `omp --resume <id>` refuses a session whose
 * recorded directory no longer exists ("run interactively to move it into the
 * current project"). Releasing a worktree moves the session to the project
 * checkout and removes the checkout, so the recorded cwd must move with it or
 * the respawn dies on omp's guard.
 */

/**
 * Points the session header's `cwd` at `cwd`, returning true when the file
 * changed. Only the header line is rewritten — every other byte is preserved,
 * because line 1 may be omp's fixed-width title slot, whose length is load
 * bearing. A file with no session header is left alone (false): a resume that
 * omp will reject on its own must not be blocked here first.
 */
export async function rebindSessionCwd(filePath: string, cwd: string): Promise<boolean> {
  const raw = await fs.promises.readFile(filePath, "utf8");
  const lines = raw.split("\n");
  const index = lines.findIndex((line) => line.includes('"type":"session"'));
  if (index === -1) return false;
  let entry: Record<string, unknown>;
  try {
    entry = JSON.parse(lines[index]) as Record<string, unknown>;
  } catch {
    return false;
  }
  if (entry.type !== "session" || entry.cwd === cwd) return false;
  entry.cwd = cwd;
  lines[index] = JSON.stringify(entry);
  // Atomic replace: a torn session file is unresumable, and nothing holds an
  // append handle here (the child is reaped before a release or a resume).
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.rebind-${process.pid}`,
  );
  await fs.promises.writeFile(temp, lines.join("\n"), "utf8");
  await fs.promises.rename(temp, filePath);
  return true;
}
