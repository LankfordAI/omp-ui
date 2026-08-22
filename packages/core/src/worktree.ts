import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { projectSlug } from "./paths";

const ADD_TIMEOUT_MS = 60_000;
const REMOVE_TIMEOUT_MS = 30_000;

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
 * the project checkout's HEAD commit resolved before the add.
 */
export async function addWorktree(
  projectCwd: string,
  worktreePath: string,
  branch: string,
  baseRef: string | null,
): Promise<string> {
  const base = baseRef ?? (await git(projectCwd, ["rev-parse", "HEAD"])).trim();
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
