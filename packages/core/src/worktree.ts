import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { git } from "./git";
import { createBranch, readDefaultBranch } from "./branches";
import { buildMergeMessage } from "./merge-message";
import { projectSlug } from "./paths";
import type {
  MergeBackResult,
  MergeBackStatus,
  MergeDestination,
  MergePreview,
  WorktreeBranchRemoval,
  WorktreeSyncResult,
} from "./types";

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

const WORKTREE_BRANCH_PREFIX = "omp-ui";

/** 8 random hex chars — the only part of a worktree branch no human chose. */
export function mintBranchHash(): string {
  return randomBytes(4).toString("hex");
}

/**
 * A minted name no human chose (issue #389): `omp-ui/`, an optional run of
 * base segments (issue #405), then the 8-hex mint. Only these are auto-named
 * from the first prompt, and only these are recomposed when the base changes;
 * a user-typed name is never touched.
 */
export const PLACEHOLDER_BRANCH_RE = /^omp-ui\/(?:[^/]+\/)*[0-9a-f]{8}$/;

/**
 * Mints a worktree branch name (issues #224, #405): `omp-ui/`, the base
 * segment when a named branch is the cut point, then the 8-hex mint. With no
 * base this keeps the pre-#405 `omp-ui/<hash>` shape (detached HEAD, or a
 * repo with no branches).
 */
export function mintWorktreeBranch(segment: string | null = null): string {
  return composeWorktreeBranch(segment, mintBranchHash());
}

/**
 * Sanitised `<base>` segment of a minted branch (issue #405): null when
 * nothing is cut from a named branch. Case is preserved — a ticket key is
 * the segment users actually read (`sanitizeBranchName` is for model
 * output and lowercases; this is not it).
 */
export function baseBranchSegment(
  baseBranch: string | null,
  baseRef: string | null,
): string | null {
  const raw = (baseBranch ?? "").trim() !== "" ? baseBranch!.trim() : (baseRef ?? "").trim();
  if (raw === "") return null;
  const segments = raw
    .split("/")
    .map((s) => s.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32))
    .filter((s) => s !== "");
  return segments.length === 0 ? null : segments.join("/").slice(0, 64);
}

/** The one composition rule: `omp-ui/[<segment>/]<hash>`. */
export function composeWorktreeBranch(segment: string | null, hash: string): string {
  return segment === null
    ? `${WORKTREE_BRANCH_PREFIX}/${hash}`
    : `${WORKTREE_BRANCH_PREFIX}/${segment}/${hash}`;
}

/**
 * Follows the base while the name is still a mint (issue #405): a hand-typed
 * branch is never touched, and the hash survives so the checkout slot's slug
 * stays recognisable across base edits.
 */
export function remintForBase(branch: string, segment: string | null): string {
  if (!PLACEHOLDER_BRANCH_RE.test(branch)) return branch;
  return composeWorktreeBranch(segment, branch.slice(branch.lastIndexOf("/") + 1));
}

/** hex sha256 of `value`; the digest source for slot and slug suffixes. */
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/**
 * The per-project slot directory holding a project's worktree checkouts:
 * `<projectSlug>--<hash8>`. hash8 is the sha256 of the resolved project cwd,
 * so same-named projects in different locations stay distinct. Canonicality
 * of a checkout keys on this directory, not on the branch name — a renamed
 * branch stays in the slot its path was minted into.
 */
export function worktreeProjectDir(worktreesRoot: string, projectCwd: string): string {
  return path.join(worktreesRoot, `${projectSlug(projectCwd)}--${sha256(path.resolve(projectCwd)).slice(0, 8)}`);
}

/**
 * The checkout path for a worktree session under `worktreesRoot`:
 * `<projectSlug>--<hash8>/<branchSlug>`.
 */
export function mintWorktreePath(
  worktreesRoot: string,
  projectCwd: string,
  branch: string,
): string {
  const branchSlug = branch.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  // Issue #405: `omp-ui/<base>/<hash>` names can run long. A truncation that
  // drops the mint would collide two sessions on one slot, so an over-long
  // slug keeps a per-session tail: hash-of-branch for distinctness, last
  // chars of the sanitized branch for recognition. Deterministic — a renamed
  // branch still resolves to the slot its path was minted into.
  const slug =
    branchSlug.length <= 64
      ? branchSlug
      : `${branchSlug.slice(0, 47)}-${sha256(branch).slice(0, 8)}-${branchSlug.slice(-8)}`;
  return path.join(worktreeProjectDir(worktreesRoot, projectCwd), slug || "branch");
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
 * Creates a checkout at `worktreePath` on an EXISTING local branch (issue
 * #390): `git worktree add <path> <branch>`, no `-b`. Rejects with git's
 * stderr when the branch is missing or already held by another worktree.
 * Resolves the recorded base: the repo's default branch, else the project
 * checkout's branch, else its HEAD commit. When the default branch is
 * `branch` itself the base is still that name — merge status then reads
 * `alreadyMerged`, which is honest.
 */
export async function addWorktreeForBranch(
  projectCwd: string,
  worktreePath: string,
  branch: string,
): Promise<string> {
  const current = await currentBranch(projectCwd);
  const base =
    (await readDefaultBranch(projectCwd)) ??
    (current !== "" ? current : (await git(projectCwd, ["rev-parse", "HEAD"])).trim());
  await fs.promises.mkdir(path.dirname(worktreePath), { recursive: true });
  await git(projectCwd, ["worktree", "add", worktreePath, branch], {
    timeoutMs: ADD_TIMEOUT_MS,
  });
  return base;
}

/**
 * Creates the checkout on a new session branch cut from a NEW base branch
 * (issue #405): `git branch <baseBranch> <startPoint|HEAD>`, then
 * `git worktree add -b <branch> <path> <baseBranch>`. The recorded base is
 * `baseBranch`, so the branch diff, sync, and merge-back all target the
 * feature branch rather than the trunk it was cut from. Neither call checks
 * out anything, so the project's working tree never moves. Rolls the new ref
 * back when the add fails — git's message still propagates — so a rejected
 * create leaves no stray branch.
 */
export async function addWorktreeFromNewBase(
  projectCwd: string,
  worktreePath: string,
  branch: string,
  baseBranch: string,
  startPoint: string | null,
): Promise<string> {
  await createBranch(projectCwd, baseBranch, startPoint ?? "HEAD");
  try {
    await addWorktree(projectCwd, worktreePath, branch, baseBranch);
  } catch (err) {
    // Best-effort: an add that died after registering the checkout leaves the
    // new ref held by it and -D then refuses. The primary error still surfaces
    // and spawn rollback reclaims the path.
    await git(projectCwd, ["branch", "-D", baseBranch]).catch(() => undefined);
    throw err;
  }
  return baseBranch;
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
 * either an orphan checkout or stray debris — both deletable. The
 * `.merge/<8 hex>` scratch checkouts of mergeWorktreeBranch (issue #385)
 * obey the same rule: the two-level sweep reads `.merge` as a project dir
 * and its children as unreferenced leaves, so a crash between add and
 * remove is cleaned at the next boot. `referenced`
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
 * Destination resolution from a recorded base (issue #323), the body behind
 * resolveMergeDestination: (1) a local branch named by `base`; (2) else, when
 * `base` resolves to a commit — a unique local branch pointing at it, else
 * the project's current branch when it contains that commit; (3) else null
 * with "base-gone" (deleted name / unknown SHA) or "no-branch-match".
 */
async function currentBranch(projectCwd: string): Promise<string> {
  try {
    return (await git(projectCwd, ["branch", "--show-current"])).trim();
  } catch {
    return "";
  }
}

async function resolveMergeDestinationForCurrent(
  projectCwd: string,
  base: string | null,
  current: string,
): Promise<MergeDestination> {
  const baseIsBranch =
    base !== null &&
    !/^[0-9a-f]{40}$/.test(base) &&
    (await hasRef(projectCwd, `refs/heads/${base}`));
  let destination: string | null = null;
  let reason: MergeDestination["reason"] = "base-gone";
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
 * Resolves the default merge destination from a recorded base (issue #323).
 * The rev-parse toplevel probe lives here: a non-repo resolves to
 * `{ destination: null, reason: "no-repo" }` instead of throwing (issue #385
 * — callers ask before the finish dialog shows any destination UI).
 */
export async function resolveMergeDestination(
  projectCwd: string,
  base: string | null,
): Promise<MergeDestination> {
  try {
    await git(projectCwd, ["rev-parse", "--show-toplevel"]);
  } catch {
    return { destination: null, reason: "no-repo" };
  }
  return resolveMergeDestinationForCurrent(projectCwd, base, await currentBranch(projectCwd));
}

/**
 * True when the checkout at `worktreePath` has user-owned uncommitted or
 * untracked changes (issues #388, #417). The `.omp` omp-ui generates into the
 * checkout is application state, so it alone does not make the checkout dirty;
 * another `.omp`, or any status beside that link, still does. POSIX shows the
 * generated link as a lone symlink entry and Windows as an untracked directory,
 * so the entry is excused by resolution rather than by the link bit — Windows
 * makes the link a junction, whose `lstat` reports a plain directory
 * (issue #423). A checkout that owns a real `.omp` resolves to itself, so the
 * user's own project config stays dirty work. Any failure — not a repo, missing
 * path — resolves to null, "unreadable", never an error.
 */
export async function readWorktreeDirty(
  projectCwd: string,
  worktreePath: string,
): Promise<boolean | null> {
  try {
    const out = (await git(worktreePath, ["status", "--porcelain", "--untracked-files=normal"])).trim();
    if (out === "") return false;
    if (out !== "?? .omp" && out !== "?? .omp/") return true;
    return !sameCheckoutPath(path.join(worktreePath, ".omp"), path.join(projectCwd, ".omp"));
  } catch {
    return null;
  }
}

/** Compares two filesystem paths for sameness across platform separators. */
function sameCheckoutPath(a: string, b: string): boolean {
  const real = (p: string): string => {
    try {
      return fs.realpathSync.native(p);
    } catch {
      return path.resolve(p);
    }
  };
  // git emits porcelain paths in forward-slash form on every platform, but
  // realpathSync.native carries the platform separator — normalize both sides
  // so the comparison holds on Windows too (issues #230, #317).
  const norm = (p: string): string => real(p).replace(/[\\/]+/g, "/");
  const [left, right] =
    process.platform === "win32" ? [norm(a).toLowerCase(), norm(b).toLowerCase()] : [norm(a), norm(b)];
  return left === right;
}

/**
 * Where the local branch `destination` is checked out (issue #385): the
 * project checkout, nowhere, or another worktree. Parsed from
 * `git worktree list --porcelain` — blocks separated by blank lines,
 * `worktree <path>` and `branch refs/heads/<name>` within a block. Any
 * failure answers "none": an unreadable repo holds nothing.
 */
export async function readDestinationCheckout(
  projectCwd: string,
  destination: string,
): Promise<MergeBackStatus["destinationCheckout"]> {
  // Both probes are awaited even when one fails. `Promise.all` answered "none"
  // the moment the first rejected, leaving the sibling `git` child alive and —
  // on Windows — holding a handle on `projectCwd` until it was reaped, which is
  // what outlived the test harness's delete retries (issue #402).
  const [listing, toplevel] = await Promise.allSettled([
    git(projectCwd, ["worktree", "list", "--porcelain"]),
    git(projectCwd, ["rev-parse", "--show-toplevel"]),
  ]);
  if (listing.status === "rejected" || toplevel.status === "rejected") return "none";
  for (const block of listing.value.split(/\r?\n\r?\n/)) {
    let worktree: string | null = null;
    let branch: string | null = null;
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) worktree = line.slice("worktree ".length).trim();
      else if (line.startsWith("branch refs/heads/"))
        branch = line.slice("branch refs/heads/".length).trim();
    }
    if (branch !== destination || worktree === null) continue;
    return sameCheckoutPath(worktree, toplevel.value.trim()) ? "project" : "other";
  }
  return "none";
}

/**
 * Predicts the merge destination ← branch without touching any working tree
 * (issue #387): `git merge-tree --write-tree --name-only`. Exit 0 is clean;
 * exit 1's output is the tree OID, then conflicted paths up to the first
 * blank line. Anything else — exit ≥ 2, git without `--write-tree` (< 2.38),
 * a non-repo — answers "unknown": the dialog works, it just cannot predict.
 */
export async function previewMerge(
  projectCwd: string,
  destination: string,
  branch: string,
): Promise<MergePreview> {
  let out: string;
  try {
    out = await git(
      projectCwd,
      ["merge-tree", "--write-tree", "--name-only", destination, branch],
      { allowExit: [0, 1] },
    );
  } catch {
    return { kind: "unknown" };
  }
  const lines = out.split(/\r?\n/);
  if (lines.length === 0) return { kind: "unknown" };
  // The probe answered (exit 0 or 1): everything from line 2 up to the
  // first blank line is a conflicted path.
  const files: string[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === "") break;
    files.push(line.trim());
  }
  return files.length > 0 ? { kind: "conflicts", files } : { kind: "clean" };
}

/**
 * Merge-back feasibility for one CHOSEN destination (issues #272, #385,
 * #387, #388). Never throws: an unreadable repo resolves to
 * all-false/zero with `destinationExists: false`. The caller selects the
 * destination — the finish dialog passes the user's pick; the default
 * suggestion comes from resolveMergeDestination(base).
 */
export async function readMergeBackStatus(
  projectCwd: string,
  branch: string,
  destination: string,
  worktreePath: string | null,
): Promise<MergeBackStatus> {
  const [branchExists, destinationExists, mergeInProgress, destinationCheckout, worktreeDirty] =
    await Promise.all([
      hasRef(projectCwd, `refs/heads/${branch}`),
      hasRef(projectCwd, `refs/heads/${destination}`),
      hasRef(projectCwd, "MERGE_HEAD"),
      readDestinationCheckout(projectCwd, destination),
      worktreePath === null ? Promise.resolve(null) : readWorktreeDirty(projectCwd, worktreePath),
    ]);
  if (!branchExists || !destinationExists) {
    return {
      destination,
      destinationExists,
      destinationCheckout,
      branchExists,
      mergeInProgress,
      alreadyMerged: false,
      ahead: 0,
      behind: 0,
      worktreeDirty,
      ...NO_PUSH_FACTS,
      preview: { kind: "unknown" },
    };
  }
  const alreadyMerged = await isAncestor(projectCwd, branch, destination);
  let ahead = 0;
  let behind = 0;
  if (!alreadyMerged) {
    try {
      ahead = Number(
        (await git(projectCwd, ["rev-list", "--count", `${destination}..${branch}`])).trim(),
      );
    } catch {
      ahead = 0;
    }
    try {
      behind = Number(
        (await git(projectCwd, ["rev-list", "--count", `${branch}..${destination}`])).trim(),
      );
    } catch {
      behind = 0;
    }
  }
  // The destination's own push facts ride the same snapshot (issue #414): the
  // finish dialog's done row needs "destination ahead of origin/main", which
  // the `ahead` above (branch vs destination) reads 0 for once the merge lands.
  const destinationFacts = await readDestinationPushFacts(projectCwd, destination);
  const preview: MergePreview = alreadyMerged
    ? { kind: "clean" }
    : await previewMerge(projectCwd, destination, branch);
  return {
    destination,
    destinationExists,
    destinationCheckout,
    branchExists,
    mergeInProgress,
    alreadyMerged,
    ahead,
    behind,
    worktreeDirty,
    ...destinationFacts,
    preview,
  };
}

/** A destination with no readable upstream: no push affordance to offer. */
const NO_PUSH_FACTS = { destinationUpstream: null, destinationAhead: null } as const;

/**
 * Destination vs its own upstream, from stored refs only — never a fetch
 * (issue #414). A stale count is harmless: the push itself answers `rejected`.
 * Any miss or failure resolves null/null, so the status call stays
 * never-throwing on git state.
 */
async function readDestinationPushFacts(
  projectCwd: string,
  destination: string,
): Promise<{ destinationUpstream: string | null; destinationAhead: number | null }> {
  try {
    await git(projectCwd, ["rev-parse", "--verify", "--quiet", `${destination}@{upstream}`]);
    const upstream = (
      await git(projectCwd, ["rev-parse", "--abbrev-ref", `${destination}@{upstream}`])
    ).trim();
    if (upstream === "" || upstream === destination) return NO_PUSH_FACTS;
    const ahead = Number(
      (await git(projectCwd, ["rev-list", "--count", `${upstream}..${destination}`])).trim(),
    );
    return Number.isSafeInteger(ahead)
      ? { destinationUpstream: upstream, destinationAhead: ahead }
      : NO_PUSH_FACTS;
  } catch {
    return NO_PUSH_FACTS;
  }
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
 * Runs the merge of `branch` into the current branch of `cwd`: one `--no-ff`
 * merge commit whose message records the session's work (issue #333) — the
 * folded commits' subjects and every closing reference they carry. A
 * fast-forward would leave no trace that a worktree session landed — and
 * finishing a worktree deletes the branch — so the merge commit is the only
 * durable record. Conflicts are detected by the `--diff-filter=U` probe and
 * left exactly as git abandoned them; any other failure rethrows.
 */
async function mergeInto(
  cwd: string,
  branch: string,
  destination: string,
): Promise<Omit<MergeBackResult, "conflictsLeftIn">> {
  const commits = Number(
    (await git(cwd, ["rev-list", "--count", `${destination}..${branch}`])).trim(),
  );
  const message = buildMergeMessage({
    branch,
    destination,
    messages: await foldedCommitMessages(cwd, destination, branch),
  });
  // `--no-edit` alongside `-m` so a repo with merge.edit set cannot park the
  // merge in an editor no one can see.
  const args = ["merge", "--no-ff", "--no-edit", "-m", message.subject];
  if (message.body !== "") args.push("-m", message.body);
  args.push(branch);
  try {
    await git(cwd, args, { timeoutMs: MERGE_TIMEOUT_MS });
  } catch (error) {
    let conflicted: string[] = [];
    try {
      conflicted = (await git(cwd, ["diff", "--name-only", "--diff-filter=U"]))
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
 * Merges `branch` into `destination` (issue #272), wherever the destination
 * lives (issue #385): in the project checkout when that holds it — conflicts
 * then stop there, unresolved, `conflictsLeftIn: "project"`, the generated
 * message waiting in MERGE_MSG for `git merge --continue` — or in a scratch
 * worktree under `opts.scratchRoot` when the destination is checked out
 * nowhere. The scratch checkout exists only for the duration of this call; a
 * conflicted merge there is aborted and leaves nothing behind
 * (`conflictsLeftIn: null`), so the worktree session can sync, resolve, and
 * finish again. A destination held by ANOTHER worktree refuses: git would
 * refuse too, and picking elsewhere is the user's call. The scratch directory
 * is under the worktrees root, so a crash leaves a leftover that
 * sweepOrphanWorktrees deletes at next boot.
 */
export async function mergeWorktreeBranch(
  projectCwd: string,
  branch: string,
  destination: string,
  opts: { scratchRoot: string },
): Promise<MergeBackResult> {
  if (!(await hasRef(projectCwd, `refs/heads/${branch}`))) {
    throw new Error(`branch ${branch} no longer exists`);
  }
  if (!(await hasRef(projectCwd, `refs/heads/${destination}`))) {
    throw new Error(`destination ${destination} no longer exists`);
  }
  if (await isAncestor(projectCwd, branch, destination)) {
    return { kind: "already-merged", destination, commits: 0, files: [], conflictsLeftIn: null };
  }
  const checkout = await readDestinationCheckout(projectCwd, destination);
  if (checkout === "other") {
    throw new Error(`${destination} is checked out in another worktree — pick another destination`);
  }
  if (checkout === "project") {
    const result = await mergeInto(projectCwd, branch, destination);
    return {
      ...result,
      conflictsLeftIn: result.kind === "conflicts" ? "project" : null,
    };
  }
  const scratch = path.join(opts.scratchRoot, randomBytes(4).toString("hex"));
  await fs.promises.mkdir(path.dirname(scratch), { recursive: true });
  try {
    await git(projectCwd, ["worktree", "add", scratch, destination], {
      timeoutMs: ADD_TIMEOUT_MS,
    });
  } catch (err) {
    // The add may have half-created the directory; the rm+prune fallback of
    // removeWorktree cleans whatever is there before the error propagates.
    await removeWorktree(projectCwd, scratch).catch(() => {});
    throw err;
  }
  let result: Omit<MergeBackResult, "conflictsLeftIn"> | undefined;
  let failure: unknown;
  try {
    result = await mergeInto(scratch, branch, destination);
    if (result.kind === "conflicts") {
      // Nothing is left behind (issue #385): undo the conflicted merge.
      await git(scratch, ["merge", "--abort"]).catch(() => {});
    }
  } catch (err) {
    failure = err;
  }
  await removeWorktree(projectCwd, scratch).catch((err) =>
    console.warn(`[worktree] scratch cleanup failed for ${scratch}:`, err),
  );
  if (failure !== undefined) throw failure;
  return { ...result!, conflictsLeftIn: null };
}

/**
 * Merges `source` INTO the worktree checkout at `worktreePath` (issue #387):
 * the branch catching up with its destination, so conflicts are resolved in
 * the sandbox by the session that owns the change. Precondition: the checkout
 * is clean — a dirty tree would mix the sync's conflicts with the user's
 * uncommitted work. Unlike merge-back this may fast-forward; the durable
 * merge commit belongs to the landing, not the catch-up. Conflicts are LEFT
 * IN PLACE (MERGE_HEAD and the files) and reported — that is the point.
 */
export async function syncWorktree(
  projectCwd: string,
  worktreePath: string,
  source: string,
): Promise<WorktreeSyncResult> {
  if ((await readWorktreeDirty(projectCwd, worktreePath)) !== false) {
    throw new Error("commit or discard the worktree's changes before syncing");
  }
  // Worktrees share refs; the read answers in any checkout of the repo.
  if (!(await hasRef(worktreePath, `refs/heads/${source}`))) {
    throw new Error(`branch ${source} no longer exists`);
  }
  if (await isAncestor(worktreePath, source, "HEAD")) {
    return { kind: "up-to-date", source, files: [] };
  }
  try {
    await git(worktreePath, ["merge", "--no-edit", source], { timeoutMs: MERGE_TIMEOUT_MS });
  } catch (error) {
    let conflicted: string[] = [];
    try {
      conflicted = (await git(worktreePath, ["diff", "--name-only", "--diff-filter=U"]))
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "");
    } catch {
      // The probe itself failed — git's own message below is the better answer.
    }
    if (conflicted.length > 0) {
      return { kind: "conflicts", source, files: conflicted };
    }
    throw error;
  }
  return { kind: "merged", source, files: [] };
}

/**
 * Renames the branch the checkout at `worktreePath` has checked out (issue
 * #389): `git branch -m <from> <to>` inside the checkout, so git updates that
 * worktree's HEAD symref along with the ref. Git is the authority on names —
 * an existing or invalid `to` rejects with git's stderr, no pre-validation
 * (same stance as checkoutBranch).
 */
export async function renameWorktreeBranch(
  worktreePath: string,
  from: string,
  to: string,
): Promise<void> {
  await git(worktreePath, ["branch", "-m", from, to]);
}

/**
 * Deletes the worktree branch once it is verified fully merged into one of
 * the candidate destinations (issue #323, widened by #386: the caller's
 * mergedInto plus the destination resolved from the recorded base). Runs in
 * the project checkout, after the checkout's worktree has been removed. The
 * explicit `isAncestor(branch, candidate)` check is what licenses `branch
 * -D` — plain `-d` tests against HEAD only and would refuse a branch merged
 * into a destination that is not checked out (issue #385); the safety
 * property, never deleting unmerged work, moves into that check. git still
 * refuses a branch another worktree holds — reported as kept-refused.
 */
export async function removeWorktreeBranch(
  projectCwd: string,
  branch: string,
  destinations: readonly string[],
): Promise<WorktreeBranchRemoval> {
  if (!(await hasRef(projectCwd, `refs/heads/${branch}`))) {
    return { kind: "already-gone" };
  }
  const existing: string[] = [];
  for (const candidate of destinations) {
    if (await hasRef(projectCwd, `refs/heads/${candidate}`)) existing.push(candidate);
  }
  if (existing.length === 0) return { kind: "kept-no-destination" };
  let merged = false;
  for (const candidate of existing) {
    if (await isAncestor(projectCwd, branch, candidate)) {
      merged = true;
      break;
    }
  }
  if (!merged) return { kind: "kept-unmerged" };
  try {
    await git(projectCwd, ["branch", "-D", branch]);
  } catch (err) {
    return {
      kind: "kept-refused",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
  return { kind: "removed" };
}
