import { git } from "./git";
import type { DiscardedApplyResult, DiscardedChange } from "./types";

/**
 * Recovery for omp's `bash.gitGuard` saves (omp 18.14, issue #973). In a
 * linked worktree the guard lets checkout/switch/restore/reset/stash run, and
 * before one discards tracked changes it records them with `git stash create`
 * on `refs/omp/discarded`, the reflog message `before <command>`. Refs are
 * shared by every worktree of a repository, so that one reflog interleaves
 * the saves of every worktree session; these helpers keep the ones this
 * checkout made and re-apply one with the `git stash apply --index` omp's
 * own note prints. Untracked files and `git clean` are never saved upstream,
 * so nothing here can bring them back.
 */

export const DISCARDED_REF = "refs/omp/discarded";

const APPLY_TIMEOUT_MS = 60_000;
const RECORD = "\x1e";
const FIELD = "\x1f";

interface HeadHistory {
  /** Unix seconds of the checkout's first HEAD entry; null without a reflog. */
  born: number | null;
  /** Every branch this checkout's HEAD held, renames included. */
  branches: Set<string>;
  /** Every commit this checkout's HEAD pointed at while detached. */
  detached: Set<string>;
}

/** A checkout move whose target is not a branch: `HEAD` (--detach) or a commit id. */
const DETACHED_TARGET = /^(?:HEAD|[0-9a-f]{7,64})$/;

/**
 * The checkout's own HEAD reflog. It lives in the worktree's admin dir, so
 * unlike `refs/omp/discarded` it is this checkout's alone: the branches and
 * commits it names are what the checkout held.
 */
async function readHeadHistory(worktreePath: string): Promise<HeadHistory> {
  const branches = new Set<string>();
  const detached = new Set<string>();
  let born: number | null = null;
  try {
    const current = (await git(worktreePath, ["branch", "--show-current"])).trim();
    if (current !== "") branches.add(current);
    else detached.add((await git(worktreePath, ["rev-parse", "--verify", "--quiet", "HEAD"])).trim());
  } catch {
    // Unreadable HEAD: the reflog below is the only evidence left.
  }
  let out: string;
  try {
    out = await git(worktreePath, [
      "reflog",
      "show",
      "--date=unix",
      `--format=%H${FIELD}%gd${FIELD}%gs`,
      "HEAD",
      "--",
    ]);
  } catch {
    return { born, branches, detached };
  }
  // Oldest first, so each checkout move sets the state the entries after it ran in.
  let isDetached = false;
  for (const line of out.split(/\r?\n/).reverse()) {
    const [commit, selector, message] = line.split(FIELD);
    if (commit === undefined || selector === undefined || message === undefined) continue;
    const at = /@\{(\d+)\}$/.exec(selector);
    if (at) born = born === null ? Number(at[1]) : Math.min(born, Number(at[1]));
    const moved = /^checkout: moving from (.+) to (.+)$/.exec(message);
    if (moved) {
      const target = moved[2]!.trim();
      isDetached = DETACHED_TARGET.test(target);
      if (!isDetached) branches.add(target);
    }
    const renamed = /^Branch: renamed refs\/heads\/(.+) to refs\/heads\/(.+)$/.exec(message);
    if (renamed) {
      branches.add(renamed[1]!.trim());
      branches.add(renamed[2]!.trim());
    }
    if (isDetached) detached.add(commit);
  }
  return { born, branches, detached };
}

/**
 * Lists the saves on `refs/omp/discarded` that the checkout at
 * `worktreePath` made, newest first. A save names the branch it was taken on
 * in its stash subject (`WIP on <branch>:`), and a branch is checked out by
 * one worktree at a time, so a save belongs here when its branch is one this
 * checkout's HEAD held during its life; a detached save (`(no branch)`)
 * belongs here only when this checkout's HEAD sat detached on the save's
 * base commit — sibling worktrees share commits, so the commit alone proves
 * nothing. `recordedBranch` is the session record's branch, kept even when
 * the reflog is gone. A repository with no saves, or an unreadable checkout,
 * lists [].
 */
export async function listDiscardedChanges(
  worktreePath: string,
  recordedBranch: string,
): Promise<DiscardedChange[]> {
  let out: string;
  try {
    out = await git(worktreePath, [
      "log",
      "-g",
      "--date=unix",
      `--format=${RECORD}%H${FIELD}%P${FIELD}%gd${FIELD}%gs${FIELD}%s`,
      "--diff-merges=first-parent",
      "--name-only",
      DISCARDED_REF,
      "--",
    ]);
  } catch {
    return [];
  }
  const history = await readHeadHistory(worktreePath);
  history.branches.add(recordedBranch);
  const saves: DiscardedChange[] = [];
  for (const record of out.split(RECORD)) {
    const lines = record.split(/\r?\n/);
    const [commit, parents, selector, message, subject] = (lines[0] ?? "").split(FIELD);
    if (!commit || parents === undefined || !selector || message === undefined || subject === undefined) continue;
    const at = /@\{(\d+)\}$/.exec(selector);
    if (!at) continue;
    const savedSeconds = Number(at[1]);
    if (history.born !== null && savedSeconds < history.born) continue;
    const branch = /^(?:WIP on|On) ([^:]+): /.exec(subject)?.[1] ?? null;
    if (branch === null) continue;
    const head = parents.split(" ")[0] ?? "";
    const ours =
      branch === "(no branch)" ? history.detached.has(head) : history.branches.has(branch);
    if (!ours) continue;
    saves.push({
      commit,
      savedAt: savedSeconds * 1000,
      command: message.startsWith("before ") ? message.slice("before ".length) : "",
      branch,
      files: lines.slice(1).map((line) => line.trim()).filter((line) => line !== ""),
    });
  }
  return saves;
}

async function readConflictedPaths(cwd: string): Promise<string[]> {
  try {
    return (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]))
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "");
  } catch {
    return [];
  }
}

/**
 * Re-applies one save into the checkout with `git stash apply --index`, the
 * command omp's own note prints, so staged changes come back staged. The
 * commit must be one listDiscardedChanges attributes to this checkout: the
 * caller never names an arbitrary object. When git cannot rebuild the index
 * it says "Try without --index", and the apply is retried that way with every
 * change unstaged. Conflicts are LEFT IN PLACE and reported, like a sync; a
 * refusal that touched nothing (local changes in the way, a vanished save)
 * rejects with git's own message.
 */
export async function applyDiscardedChange(
  worktreePath: string,
  recordedBranch: string,
  commit: string,
): Promise<DiscardedApplyResult> {
  const saves = await listDiscardedChanges(worktreePath, recordedBranch);
  if (!saves.some((save) => save.commit === commit)) {
    throw new Error(`${commit.slice(0, 7)} is not a save of this worktree on ${DISCARDED_REF}`);
  }
  const apply = async (withIndex: boolean): Promise<DiscardedApplyResult> => {
    try {
      await git(worktreePath, ["stash", "apply", ...(withIndex ? ["--index"] : []), commit], {
        timeoutMs: APPLY_TIMEOUT_MS,
      });
      return { kind: "applied", indexRestored: withIndex, files: [] };
    } catch (error) {
      const conflicted = await readConflictedPaths(worktreePath);
      // git restores no index on a conflicted apply ("Index was not unstashed").
      if (conflicted.length > 0) return { kind: "conflicts", indexRestored: false, files: conflicted };
      if (withIndex && error instanceof Error && /Try without --index/.test(error.message)) {
        return apply(false);
      }
      throw error;
    }
  };
  return apply(true);
}
