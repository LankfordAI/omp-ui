import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import type { BranchDiff } from "./types";

// Git is a plain child_process here (core/git.ts) — this module is
// transport-agnostic Node, exactly like pty.ts and title-model.ts. The
// renderer never runs git; it asks the main process, which hands back one
// BranchDiff snapshot.

/** Untracked files bigger than this are skipped — a data blob is not a diff. */
const MAX_UNTRACKED_BYTES = 256 * 1024;
const MAX_UNTRACKED_FILES = 256;

/** Reads a working-tree file for the diff viewer; null when unreadable. */
function readWorkingFile(absPath: string, maxBytes = MAX_UNTRACKED_BYTES): BranchDiff["untracked"][number] | null {
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > maxBytes) return null;
    const buf = fs.readFileSync(absPath);
    if (buf.includes(0)) return { path: "", text: "", binary: true };
    return { path: "", text: buf.toString("utf8"), binary: false };
  } catch {
    // A file deleted between ls-files and read is not an error worth raising.
    return null;
  }
}

/**
 * Working-tree state of the project's git repo: the active branch name, the
 * tracked `git diff HEAD` (staged + unstaged), and new untracked files read as
 * creates. Projects outside any git repo resolve to all-null fields — a
 * no-repo state, not an error.
 */
export async function readBranchDiff(projectCwd: string): Promise<BranchDiff> {
  const empty: BranchDiff = { branch: null, repoRoot: null, diff: "", untracked: [] };
  let root: string;
  try {
    root = path.resolve((await git(projectCwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return empty;
  }

  // `branch --show-current` is empty (not an error) on a detached HEAD.
  let branch: string | null;
  try {
    branch = (await git(root, ["branch", "--show-current"])).trim() || null;
  } catch {
    branch = null;
  }

  // `diff HEAD` covers staged + unstaged; a repo with no commits yet (unborn
  // HEAD) rejects that, so fall back to the two staged/unstaged halves.
  let diff = "";
  try {
    diff = await git(root, ["diff", "HEAD", "--no-ext-diff"]);
  } catch {
    try {
      const unstaged = await git(root, ["diff", "--no-ext-diff"]);
      const staged = await git(root, ["diff", "--cached", "--no-ext-diff"]);
      diff = `${staged}${unstaged}`;
    } catch {
      // Unreadable repo — report what we can (the branch) with an empty diff.
    }
  }

  const untracked: BranchDiff["untracked"] = [];
  try {
    // `-z` so a path with a newline cannot split a record.
    const listed = await git(root, ["ls-files", "--others", "--exclude-standard", "-z"]);
    for (const rel of listed.split("\0")) {
      if (!rel) continue;
      if (untracked.length >= MAX_UNTRACKED_FILES) break;
      const read = readWorkingFile(`${root}/${rel}`);
      if (!read) continue;
      untracked.push({ ...read, path: rel });
    }
  } catch {
    // No untracked listing — the tracked diff still stands.
  }

  return { branch, repoRoot: root, diff, untracked };
}
