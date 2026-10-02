import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { readDefaultBranch } from "./branches";
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

/** A tracked diff taken from a resolved merge-base, with the ref it came from. */
interface BaseDiff {
  mergeBase: string;
  baseRef: string;
  diff: string;
}

/**
 * The first candidate whose merge-base with HEAD resolves, diffed from that
 * merge-base in one pass (commits + staged + unstaged). Null when none
 * resolves: a deleted ref or unrelated history.
 */
async function diffFromFirstBase(
  root: string,
  candidates: readonly string[],
): Promise<BaseDiff | null> {
  for (const candidate of candidates) {
    try {
      const mergeBase = (await git(root, ["merge-base", candidate, "HEAD"])).trim();
      const diff = await git(root, ["diff", mergeBase, "--no-ext-diff"]);
      return { mergeBase, baseRef: candidate, diff };
    } catch {
      // Next candidate; the caller falls back to `git diff HEAD`.
    }
  }
  return null;
}

/**
 * The current branch's configured upstream as a short ref (`origin/main`,
 * or a local branch name for a `.` remote); null when none is configured
 * or the configured ref no longer resolves.
 */
async function readUpstreamRef(root: string): Promise<string | null> {
  try {
    const ref = (
      await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"])
    ).trim();
    return ref === "" ? null : ref;
  } catch {
    return null;
  }
}

/**
 * Working-tree state of the project's git repo: the active branch name, the
 * tracked diff, and new untracked files read as creates. The tracked diff is
 * taken in one pass (commits + staged + unstaged) from the first base on a
 * four-rung ladder (issue #711): the recorded worktree `base`, as
 * `merge-base(base, HEAD)`; else, on a named branch, the repo's default
 * branch when this branch is not it, as `merge-base(default, HEAD)`; else
 * the branch's configured upstream, as `merge-base(upstream, HEAD)`, so
 * unpushed commits on the default branch stay visible; else plain
 * `git diff HEAD` (staged + unstaged). An unresolvable rung falls to the
 * next; a recorded base that fails goes straight to `git diff HEAD`.
 * Projects outside any git repo resolve to all-null fields — a no-repo
 * state, not an error.
 */
export async function readBranchDiff(
  projectCwd: string,
  base: string | null = null,
): Promise<BranchDiff> {
  const empty: BranchDiff = {
    branch: null,
    repoRoot: null,
    diff: "",
    untracked: [],
    mergeBase: null,
    baseRef: null,
  };
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

  // Diff base ladder (issue #711): the recorded worktree base; else, on a
  // named branch, the repo's default branch when this branch is not it;
  // else the branch's upstream, so unpushed commits on the default branch
  // stay visible too; else plain `git diff HEAD`. Each rung that cannot
  // resolve (deleted ref, unrelated history) falls to the next. A recorded
  // base that fails goes straight to the HEAD diff, as before.
  let resolved: BaseDiff | null = null;
  if (base !== null) {
    resolved = await diffFromFirstBase(root, [base]);
  } else if (branch !== null) {
    const defaultBranch = await readDefaultBranch(root);
    if (defaultBranch !== null && defaultBranch !== branch) {
      // The origin/<name> retry covers a deleted local default whose
      // remote-tracking ref remains (readDefaultBranch strips origin/).
      resolved = await diffFromFirstBase(root, [defaultBranch, `origin/${defaultBranch}`]);
    }
    if (resolved === null) {
      const upstream = await readUpstreamRef(root);
      if (upstream !== null) resolved = await diffFromFirstBase(root, [upstream]);
    }
  }
  const mergeBase = resolved?.mergeBase ?? null;
  const baseRef = resolved?.baseRef ?? null;
  let diff = resolved?.diff ?? "";
  if (mergeBase === null) {
    // `diff HEAD` covers staged + unstaged; a repo with no commits yet
    // (unborn HEAD) rejects that, so fall back to the two halves.
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

  return { branch, repoRoot: root, diff, untracked, mergeBase, baseRef };
}
