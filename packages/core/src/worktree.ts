import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { buildMergeMessage } from "./merge-message";
import { projectSlug } from "./paths";
import type { MergeBackResult, MergeBackStatus, WorktreeBranchRemoval } from "./types";

const ADD_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 30_000;
const MERGE_TIMEOUT_MS = 60_000;

/**
 * Per-session git worktrees (issue #224): each worktree session runs in its
 * own checkout of the project on a minted branch, so its edits never touch
 * the project's working tree — the per-session worktree model T3 Code uses.
 * Thin wrappers over git() from ./git, which rejects with git's stderr so
 * callers can surface the failure verbatim.
 */

/** Mints a worktree branch name: `omp-ui/` + 8 random hex chars. */
export function mintWorktreeBranch(): string {
  return `omp-ui/${randomBytes(4).toString("hex")}`;
}

/**
 * The checkout path for a worktree session under `worktreesRoot`:
 * `<projectSlug>--<hash8>/<branchSlug>`. hash8 is the sha256 of the resolved
 * project cwd, so same-named projects in different locations stay distinct.
 */
export function mintWorktreePath(
  worktreesRoot: string,
  projectCwd: string,
  branch: string,
): string {
  const hash8 = createHash("sha256").update(path.resolve(projectCwd)).digest("hex").slice(0, 8);
  const branchSlug =
    branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64) || "branch";
  return path.join(worktreesRoot, `${projectSlug(projectCwd)}--${hash8}`, branchSlug);
}

/**
 * Creates the checkout at `worktreePath` on the new branch `branch`, rooted
 * at `baseRef` (the project checkout's HEAD when null). Rejects with git's
 * own message — e.g. when the branch already exists or the cwd is not a repo.
 * Resolves to what the branch was cut from: `baseRef` verbatim when given
 * (so merge-base semantics tolerate the base branch moving forward), else
 * the project checkout's branch — its HEAD commit when detached.
 */
export async function addWorktree(
  projectCwd: string,
  worktreePath: string,
  branch: string,
  baseRef: string | null,
): Promise<string> {
  let base: string;
  if (baseRef !== null) {
    base = baseRef;
  } else {
    // The checkout's branch is the durable name for the cut point; only a
    // detached checkout has no name, and records its HEAD commit.
    let current: string;
    try {
      current = (await git(projectCwd, ["branch", "--show-current"])).trim();
    } catch {
      current = "";
    }
    base =
      current !== "" ? current : (await git(projectCwd, ["rev-parse", "HEAD"])).trim();
  }
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(
    projectCwd,
    ["worktree", "add", "-b", branch, worktreePath, ...(baseRef ? [baseRef] : [])],
    { timeoutMs: ADD_TIMEOUT_MS },
  );
  return base;
}

/**
 * True when `candidate` is a strict descendant of `root` (both resolved):
 * not the root itself, not a sibling sharing a path prefix, and no `..`
 * escape. Gates the recursive removal fallback so a corrupt registry
 * `worktree.path` can never steer it outside the worktrees root.
 */
export function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(path.resolve(root), path.resolve(candidate));
  return (
    rel !== "" && rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)
  );
}

/**
 * Links the project's `.omp/` into a worktree checkout (issue #325: project
 * MCP toggles never reached worktree sessions).
 *
 * omp resolves project-scope config — `.omp/mcp.json`, `config.yml`, skills,
 * rules — from its cwd, and a worktree session runs in the checkout, which
 * lives outside the project. `.omp/` is gitignored in most repos, so the
 * checkout has none and every project-scope setting silently vanished for
 * those sessions. A directory symlink keeps one source of truth: omp-ui's
 * project writes land on the project's real file through it, and no copy can
 * drift.
 *
 * Idempotent and never fatal. Skipped when the project has no `.omp/`, when
 * the checkout already owns one (a repo that tracks it), and when the
 * platform refuses the link (Windows without developer mode) — a warning is
 * logged and the session runs with omp's user-level config, exactly as it
 * does today.
 *
 * Deletion safety is load-bearing: every teardown path must unlink this
 * symlink, never traverse it. Node's recursive `fs.rm` lstats and unlinks
 * symlinks, which is what {@link removeWorktree}'s fallback and
 * {@link sweepOrphanWorktrees} rely on — regression-tested, because breaking
 * it deletes the user's project config.
 */
export async function linkProjectOmpDir(
  projectCwd: string,
  worktreePath: string,
): Promise<void> {
  const src = path.resolve(projectCwd, ".omp");
  const dest = path.join(worktreePath, ".omp");
  try {
    if (!(await fs.promises.stat(src)).isDirectory()) return;
  } catch {
    return; // no project .omp/ — nothing to link
  }
  try {
    await fs.promises.lstat(dest);
    return; // the checkout already has its own .omp (tracked, or linked earlier)
  } catch {
    // absent — link it below
  }
  try {
    // "junction" is ignored on POSIX and is the unprivileged directory link
    // on Windows; it requires the absolute target `src` already is.
    await fs.promises.symlink(src, dest, "junction");
  } catch (err) {
    console.warn(
      `[worktree] could not link ${dest} -> ${src}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/**
 * Removes the checkout at `worktreePath`. `--force` accepts dirty checkouts;
 * when git fails (e.g. the directory was already deleted) the leftover is
 * removed from disk and stale metadata pruned — pruning fails silently, as
 * an unreachable repo has nothing left to prune. The branch survives. The
 * fallback removes whatever `worktreePath` names: callers must pass only a
 * path verified to be inside the worktrees root (isWithin).
 */
export async function removeWorktree(projectCwd: string, worktreePath: string): Promise<void> {
  try {
    await git(projectCwd, ["worktree", "remove", "--force", worktreePath], {
      timeoutMs: REMOVE_TIMEOUT_MS,
    });
  } catch {
    await fs.promises.rm(worktreePath, { recursive: true, force: true });
    await git(projectCwd, ["worktree", "prune"], { timeoutMs: REMOVE_TIMEOUT_MS }).catch(() => {});
  }
}

/**
 * Removes checkout directories under `worktreesRoot` that no session record
 * references (issue #262). Layout is fixed two-level
 * (`<projectSlug--hash8>/<branchSlug>`), so anything else at those depths is
 * either an orphan checkout or stray debris — both deletable. `referenced`
 * only *protects* paths; deletions remain gated by isWithin(worktreesRoot),
 * so a corrupt registry path can never steer removal outside the root.
 * Returns the removed paths. Never throws: a missing root resolves to [];
 * per-entry failures are skipped.
 */
export async function sweepOrphanWorktrees(
  worktreesRoot: string,
  referenced: ReadonlySet<string>,
): Promise<string[]> {
  const root = path.resolve(worktreesRoot);
  let projects: fs.Dirent[];
  try {
    projects = await fs.promises.readdir(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const removed: string[] = [];
  for (const project of projects) {
    const projectDir = path.join(root, project.name);
    try {
      if (!project.isDirectory()) {
        // Nothing but checkout dirs legitimately lives here.
        await fs.promises.rm(projectDir, { force: true });
        removed.push(projectDir);
        continue;
      }
      const leaves = await fs.promises.readdir(projectDir, { withFileTypes: true });
      for (const leaf of leaves) {
        const leafPath = path.join(projectDir, leaf.name);
        if (referenced.has(path.resolve(leafPath))) continue;
        if (!isWithin(root, leafPath)) continue;
        try {
          await fs.promises.rm(leafPath, { recursive: true, force: true });
          removed.push(leafPath);
        } catch {
          // A busy or permission-locked entry is skipped, not fatal.
        }
      }
      // Prune an emptied project dir; fails harmlessly when not empty.
      await fs.promises.rmdir(projectDir).catch(() => {});
    } catch {
      // An unreadable project dir is skipped, not fatal.
    }
  }
  return removed;
}

/** Probe: true when `ref` exists; a failed rev-parse is the answer false. */
async function hasRef(cwd: string, ref: string): Promise<boolean> {
  try {
    await git(cwd, ["rev-parse", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Probe: true when `ancestor` is an ancestor of `descendant`. Both refs
 * are verified to exist by the caller, so a non-zero exit is the boolean
 * answer false, not an error.
 */
async function isAncestor(cwd: string, ancestor: string, descendant: string): Promise<boolean> {
  try {
    await git(cwd, ["merge-base", "--is-ancestor", ancestor, descendant]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Destination resolution shared by readMergeBackStatus and removeWorktreeBranch
 * (issue #323): (1) a local branch named by `base`; (2) else, when `base`
 * resolves to a commit — a unique local branch pointing at it, else the
 * project's current branch when it contains that commit; (3) else null with
 * "base-gone" (deleted name / unknown SHA) or "no-branch-match".
 */
export async function resolveMergeDestination(
  projectCwd: string,
  base: string | null,
): Promise<{ destination: string | null; reason: MergeBackStatus["reason"] }> {
  const baseIsBranch =
    base !== null &&
    !/^[0-9a-f]{40}$/.test(base) &&
    (await hasRef(projectCwd, `refs/heads/${base}`));
  let current: string;
  try {
    current = (await git(projectCwd, ["branch", "--show-current"])).trim();
  } catch {
    current = "";
  }
  let destination: string | null = null;
  let reason: MergeBackStatus["reason"] = "base-gone";
  if (baseIsBranch) {
    destination = base;
    reason = null;
  }
  if (destination === null && base !== null) {
    let sha: string;
    try {
      sha = (await git(projectCwd, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]))
        .trim();
    } catch {
      sha = "";
    }
    if (sha !== "") {
      let pointsAt: string[];
      try {
        pointsAt = (await git(projectCwd, ["branch", "--points-at", sha]))
          .split("\n")
          .map((line) => line.replace(/^[* ]+/, "").trim())
          .filter((line) => line !== "");
      } catch {
        pointsAt = [];
      }
      if (pointsAt.length === 1) {
        destination = pointsAt[0];
        reason = null;
      } else if (current !== "" && (await isAncestor(projectCwd, sha, current))) {
        destination = current;
        reason = null;
      } else {
        reason = "no-branch-match";
      }
    }
  }
  return { destination, reason };
}

/**
 * Merge-back feasibility (issue #272). Never throws: an unreadable repo
 * resolves to destination null, reason "no-repo". Destination resolution:
 * (1) a local branch named by `base`; (2) else, when `base` resolves to a
 * commit — a unique local branch pointing at it, else the project's
 * current branch when it contains that commit; (3) else null with
 * "base-gone" (deleted name / unknown SHA) or "no-branch-match".
 * All ref reads are local; `rev-list --count` is the only potentially slow one.
 */
export async function readMergeBackStatus(
  projectCwd: string,
  branch: string,
  base: string | null,
): Promise<MergeBackStatus> {
  try {
    await git(projectCwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return {
      destination: null,
      reason: "no-repo",
      destinationCheckedOut: false,
      branchExists: false,
      mergeInProgress: false,
      alreadyMerged: false,
      ahead: 0,
    };
  }

  const branchExists = await hasRef(projectCwd, `refs/heads/${branch}`);
  let current: string;
  try {
    current = (await git(projectCwd, ["branch", "--show-current"])).trim();
  } catch {
    current = "";
  }
  let mergeInProgress = false;
  try {
    await git(projectCwd, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]);
    mergeInProgress = true;
  } catch {
    // No merge in progress.
  }

  const { destination, reason } = await resolveMergeDestination(projectCwd, base);

  let alreadyMerged = false;
  let ahead = 0;
  if (destination !== null && branchExists) {
    alreadyMerged = await isAncestor(projectCwd, branch, destination);
    if (!alreadyMerged) {
      try {
        ahead = Number(
          (await git(projectCwd, ["rev-list", "--count", `${destination}..${branch}`])).trim(),
        );
      } catch {
        ahead = 0;
      }
    }
  }

  return {
    destination,
    reason,
    destinationCheckedOut: destination !== null && current === destination,
    branchExists,
    mergeInProgress,
    alreadyMerged,
    ahead,
  };
}

/**
 * Full messages of the non-merge commits `destination` lacks, oldest first.
 * NUL-delimited so bodies with blank lines survive the split. Never fatal: a
 * failed read degrades to a bare "Merge <branch> into <destination>" subject
 * rather than blocking the merge.
 */
async function foldedCommitMessages(
  projectCwd: string,
  destination: string,
  branch: string,
): Promise<string[]> {
  let out: string;
  try {
    out = await git(projectCwd, [
      "log",
      "--no-merges",
      "--reverse",
      "--format=%B%x00",
      `${destination}..${branch}`,
    ]);
  } catch {
    return [];
  }
  return out
    .split("\0")
    .map((message) => message.trim())
    .filter((message) => message !== "");
}

/**
 * Merges `branch` into `destination` in the project checkout (issue #272),
 * always as a `--no-ff` merge commit whose message records the session's work
 * (issue #333): the folded commits' subjects and every closing reference they
 * carry. A fast-forward would leave no trace that a worktree session landed —
 * and finishing a worktree deletes the branch — so the merge commit is the
 * only durable record.
 *
 * A conflicted merge stops with the conflicts left in the project checkout
 * (kind "conflicts" + files) — never resolved, never aborted by omp-ui; the
 * generated message waits in MERGE_MSG for `git merge --continue`. Throws with
 * git's own message when the branch or destination no longer exists, when
 * destination is not the checkout's current branch, or when git refuses the
 * merge (dirty overlap, unresolvable committer identity, ...).
 */
export async function mergeWorktreeBranch(
  projectCwd: string,
  branch: string,
  destination: string,
): Promise<MergeBackResult> {
  if (!(await hasRef(projectCwd, `refs/heads/${branch}`))) {
    throw new Error(`branch ${branch} no longer exists`);
  }
  if (!(await hasRef(projectCwd, `refs/heads/${destination}`))) {
    throw new Error(`destination ${destination} no longer exists`);
  }
  const current = (await git(projectCwd, ["branch", "--show-current"])).trim();
  if (current !== destination) {
    throw new Error(`check out ${destination} in the project before merging`);
  }
  if (await isAncestor(projectCwd, branch, destination)) {
    return { kind: "already-merged", destination, commits: 0, files: [] };
  }
  const commits = Number(
    (await git(projectCwd, ["rev-list", "--count", `${destination}..${branch}`])).trim(),
  );
  const message = buildMergeMessage({
    branch,
    destination,
    messages: await foldedCommitMessages(projectCwd, destination, branch),
  });
  // `--no-edit` alongside `-m` so a repo with merge.edit set cannot park the
  // merge in an editor no one can see.
  const args = ["merge", "--no-ff", "--no-edit", "-m", message.subject];
  if (message.body !== "") args.push("-m", message.body);
  args.push(branch);
  try {
    await git(projectCwd, args, { timeoutMs: MERGE_TIMEOUT_MS });
  } catch (error) {
    let conflicted: string[] = [];
    try {
      conflicted = (await git(projectCwd, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    } catch {
      // The probe itself failed — git's own message below is the better answer.
    }
    if (conflicted.length > 0) {
      return { kind: "conflicts", destination, commits, files: conflicted };
    }
    throw error;
  }
  return { kind: "merged", destination, commits, files: [] };
}

/**
 * Deletes the worktree branch once it is verified fully merged into the
 * destination resolved from its recorded base (issue #323). Runs in the
 * project checkout, after the checkout's worktree has been removed, so git's
 * own `git branch -d` guards (merged-into-HEAD, not checked out elsewhere)
 * apply. A refusal keeps the branch and reports it — never throws, never
 * uses -D: an unverified unmerged branch must survive.
 */
export async function removeWorktreeBranch(
  projectCwd: string,
  branch: string,
  base: string | null,
): Promise<WorktreeBranchRemoval> {
  if (!(await hasRef(projectCwd, `refs/heads/${branch}`))) {
    return { kind: "already-gone" };
  }
  const { destination } = await resolveMergeDestination(projectCwd, base);
  if (destination === null) return { kind: "kept-no-destination" };
  if (!(await isAncestor(projectCwd, branch, destination))) {
    return { kind: "kept-unmerged" };
  }
  try {
    await git(projectCwd, ["branch", "-d", branch]);
  } catch (err) {
    return {
      kind: "kept-refused",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: "removed" };
}
