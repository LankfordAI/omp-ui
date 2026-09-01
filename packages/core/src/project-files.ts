import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import * as path from "node:path";
import { git } from "./git";
import { MAX_PROJECT_FILES } from "./project-files-limit";

/**
 * Project file listing for the composer's @ picker. Paths are
 * projectCwd-relative in every case, because omp resolves @mentions against
 * the session cwd (spawn passes `--cwd projectCwd`), so the listing must speak
 * that same cwd or the highlight would paint paths omp cannot resolve.
 *
 * In a git repo: tracked + untracked-not-ignored files (gitignore-respecting).
 * Outside a repo: a bounded walk skipping `.git`/`node_modules` and symlinked
 * dirs, which is the only honest answer when no ignore rules exist to ask.
 */

/** Cap on listed files; the picker's footer reports truncation past this. */
export { MAX_PROJECT_FILES } from "./project-files-limit";

export async function listProjectFiles(
  projectCwd: string,
): Promise<{ files: string[]; truncated: boolean }> {
  let files: string[];
  try {
    await git(projectCwd, ["rev-parse", "--show-toplevel"]);
    // --cached --others --exclude-standard = tracked + untracked-not-ignored.
    // `-z` guards a newline-in-path; pathspec `.` scopes the output to
    // projectCwd and keeps paths projectCwd-relative even when the project is
    // a subdirectory of its repo.
    const out = await git(projectCwd, [
      "ls-files",
      "-z",
      "--cached",
      "--others",
      "--exclude-standard",
      "--",
      ".",
    ]);
    files = out.split("\0").filter((f) => f !== "");
    // A tracked-but-deleted file must not highlight as resolved — omp silently
    // skips it at send time.
    files = files.filter((f) => existsSync(path.join(projectCwd, f)));
    // --cached and --others are each sorted but their concatenation is not.
    files.sort();
  } catch {
    // Not a git repo (branch-diff returns empty here, wrong for a picker).
    files = await walkProjectFiles(projectCwd);
  }
  if (files.length > MAX_PROJECT_FILES) {
    return { files: files.slice(0, MAX_PROJECT_FILES), truncated: true };
  }
  return { files, truncated: false };
}

/** Directories the non-repo walk never descends into. */
const WALK_SKIP_DIRS = new Set([".git", "node_modules"]);

async function walkProjectFiles(projectCwd: string): Promise<string[]> {
  const files: string[] = [];
  // Iterative stack of relative dir paths; recursion depth is unbounded here.
  // Collects up to MAX_PROJECT_FILES + 1 so the caller can tell a capped
  // listing (truncated) from one that happens to sit exactly at the cap.
  const stack = [""];
  while (stack.length > 0 && files.length <= MAX_PROJECT_FILES) {
    const rel = stack.pop() as string;
    let dirents;
    try {
      dirents = await readdir(rel === "" ? projectCwd : path.join(projectCwd, rel), {
        withFileTypes: true,
      });
    } catch {
      continue; // an unreadable dir skips, never sinks the whole listing
    }
    for (const dirent of dirents) {
      const childRel = rel === "" ? dirent.name : `${rel}/${dirent.name}`;
      if (dirent.isDirectory()) {
        // Never descend through a symlinked dir — the target's subtree is
        // outside the walk's budget and may cycle.
        if (!dirent.isSymbolicLink() && !WALK_SKIP_DIRS.has(dirent.name)) stack.push(childRel);
      } else {
        // Files, and symlinks as leaves (a symlinked dir is listed, not walked).
        files.push(childRel);
        if (files.length > MAX_PROJECT_FILES) break;
      }
    }
  }
  files.sort();
  return files;
}
