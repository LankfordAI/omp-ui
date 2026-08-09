import * as path from "node:path";
import { git } from "./git";
import type { BranchList } from "./types";

// Same transport-agnostic Node convention as branch-diff.ts: git is a plain
// child_process here, and the renderer never runs git — it asks the main
// process, which hands back one BranchList snapshot (or git's own error).

/**
 * Local branches of the project's git repo: the checked-out branch, every
 * local branch (default first, then alphabetical), and the default branch
 * when one can be determined. Projects outside any git repo resolve to a
 * null/empty BranchList — a no-repo state, not an error.
 */
export async function listBranches(projectCwd: string): Promise<BranchList> {
  const empty: BranchList = { repoRoot: null, current: null, branches: [], defaultBranch: null };
  let root: string;
  try {
    root = path.resolve((await git(projectCwd, ["rev-parse", "--show-toplevel"])).trim());
  } catch {
    return empty;
  }

  // `branch --show-current` is empty (not an error) on a detached HEAD.
  const current = (await git(root, ["branch", "--show-current"])).trim() || null;

  // for-each-ref over `branch --format`: the latter includes a
  // "(HEAD detached at …)" pseudo-entry on a detached HEAD, which is not a
  // branch and must never be a switcher row.
  const branches = (await git(root, ["for-each-ref", "refs/heads", "--format=%(refname:short)"]))
    .split("\n")
    .map((name) => name.trim())
    .filter((name) => name !== "");

  // The default branch: origin/HEAD when the remote names one, else the usual
  // suspects, else none — the menu simply sorts alphabetically then.
  let defaultBranch: string | null = null;
  try {
    const head = (
      await git(root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
    ).trim();
    defaultBranch = head.startsWith("origin/") ? head.slice("origin/".length) : head;
  } catch {
    if (branches.includes("main")) defaultBranch = "main";
    else if (branches.includes("master")) defaultBranch = "master";
  }

  const rest = branches.filter((name) => name !== defaultBranch).sort((a, b) => a.localeCompare(b));
  return {
    repoRoot: root,
    current,
    branches: defaultBranch === null ? rest : [defaultBranch, ...rest],
    defaultBranch,
  };
}

/**
 * Switches the repo to `name`, creating it (`checkout -b`) when opts.create.
 * No client-side name validation or dirty-tree pre-flight: git refuses exactly
 * the checkouts that would lose work, and its stderr — carried by the
 * rejection — is the message the menu displays.
 */
export async function checkoutBranch(
  projectCwd: string,
  name: string,
  opts?: { create?: boolean },
): Promise<void> {
  await git(projectCwd, opts?.create ? ["checkout", "-b", name] : ["checkout", name]);
}
