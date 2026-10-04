/**
 * The code-review wire contract (issue #728, ADR-0047): constants shared by
 * the generated review extension and the main-process roster UI, and the
 * text blocks handed to the reviewer subagents. Pure strings — nothing here
 * touches disk or omp; the generated source interpolates them instead of
 * copying them.
 */

/** The command the user types; `omp-ui_code_review` carries the namespace. */
export const CODE_REVIEW_COMMAND = "code-review";
/** Model-callable twin of the command, following the autoresearch pattern. */
export const CODE_REVIEW_TOOL = "omp-ui_code_review";

/** Slugs are the roster key: lowercase alphanumerics and inner hyphens. */
export function reviewerSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

export const CODE_REVIEW_USAGE =
  "usage: /code-review [pr <n> | <ref> | <from>..<to>] — bare reviews local changes against the upstream or default branch";

/**
 * Reviewer brief templates. `@@NAME@@` tokens are filled in one regex pass by
 * the bridge, so a value containing `@@` can never be re-substituted. Every
 * value is a resolved commit id, a validated ref, or a PR number.
 */
const UNTRACKED_LINE =
  "Then list untracked files with `git ls-files --others --exclude-standard --full-name -- :/` " +
  "and read each with your read tool (skip any file larger than 256 KiB).";

export const LOCAL_MERGE_BASE_COMMANDS = [
  "The base is commit @@BASE@@, the merge-base of HEAD and @@REF@@, resolved once for every reviewer.",
  "Review `git diff @@BASE@@` (every tracked change since the base: committed, staged, and unstaged) " +
    "and `git log --oneline @@BASE@@..HEAD` for the commits.",
  UNTRACKED_LINE,
].join("\n");

export const LOCAL_PARENT_COMMANDS = [
  "No upstream or default branch shares history with HEAD, so the base is HEAD's parent @@BASE@@.",
  "Review `git diff @@BASE@@` (the last commit plus every staged and unstaged change) " +
    "and `git show --no-patch --format=fuller HEAD` for the commit.",
  UNTRACKED_LINE,
].join("\n");

export const LOCAL_ROOT_COMMANDS = [
  "HEAD has no parent commit (or there is no commit yet), so the base is the empty tree @@BASE@@.",
  "Review `git diff @@BASE@@` (every tracked file) and `git log --oneline` for the commits, if any exist.",
  UNTRACKED_LINE,
].join("\n");

export const COMMIT_TARGET_COMMANDS =
  "Review commit @@SHA@@ (`@@REF@@`): `git show --format=fuller @@SHA@@`.";

export const RANGE_TARGET_COMMANDS =
  "Review the range `@@REF@@`: the commits on @@TO@@ that are not on @@FROM@@. " +
  "Diff from their merge-base with `git diff @@FROM@@...@@TO@@` and list the commits with " +
  "`git log --oneline @@FROM@@..@@TO@@`.";

export const PR_TARGET_COMMANDS = [
  "Review GitHub pull request #@@PR@@ (head @@HEAD@@ into @@BASE_REF@@): `gh pr diff @@PR@@` and `gh pr view @@PR@@`.",
  "Use only those read-only gh commands: never fetch, check out, or create a branch.",
  "If `gh pr view @@PR@@ --json headRefOid` no longer reports @@HEAD@@, say so on your first line.",
  "Never post comments, reviews, reactions, or anything else to any external service.",
].join("\n");

/** The findings grammar every reviewer ends with (§Component 3). */
export const REVIEW_FINDINGS_GRAMMAR =
  "Report each finding as one block:\n" +
  "SEVERITY(blocker|major|minor|nit) FILE:<path>:<line> ISSUE: <one sentence> FIX: <concrete change or none>\n" +
  "Order by severity. If the target is clean, reply exactly: no findings.";

/** The shared playbook prepended to every reviewer assignment. */
export const REVIEW_PLAYBOOK = [
  "You are one of N independent code reviewers; the others are separate agents — do not",
  "duplicate their role. Review only the stated target. Produce findings only: never edit",
  "files, never run mutating commands, never post to any external service.",
  REVIEW_FINDINGS_GRAMMAR,
].join("\n");
