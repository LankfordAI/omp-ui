/**
 * The code-review wire contract (issue #728, ADR-0047): constants shared by
 * the generated review extension and the main-process roster UI, the
 * `/code-review` argument parser, and the text blocks handed to the reviewer
 * subagents. Pure strings and regexes — nothing here touches disk or omp, so
 * the templates are unit-testable and the generated source interpolates them
 * instead of copying them.
 */

/** The command the user types; `omp-ui_code_review` carries the namespace. */
export const CODE_REVIEW_COMMAND = "code-review";
/** Model-callable twin of the command, following the autoresearch pattern. */
export const CODE_REVIEW_TOOL = "omp-ui_code_review";

/** Slugs are the roster key: lowercase alphanumerics and inner hyphens. */
export function reviewerSlug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
}

/** Which diff a reviewer is pointed at. */
export type ReviewTargetKind = "local" | "commit" | "pr";

export interface ReviewTarget {
  readonly kind: ReviewTargetKind;
  /** Commit/range ref(s) or PR number; null for bare `/code-review`. */
  readonly value: string | null;
  /**
   * True when the local target could not name a merge-base (detached HEAD,
   * no upstream, deleted base) and the commands degrade to `HEAD~1..HEAD`.
   */
  readonly degraded: boolean;
}

/** A ref is a sha (short or full) or a sha range; anything else is a name. */
const REF_RE = /^[0-9a-f]{7,40}(\.\.[0-9a-f]{7,40})?$/;
/** Names reach a reviewer's own `git rev-parse --verify`, never a shell here. */
const NAME_RE = /^[A-Za-z0-9._/@][A-Za-z0-9._/@^{}~/-]{0,254}$/;

export const CODE_REVIEW_USAGE =
  "usage: /code-review [pr <n> | <ref-or-range>] — bare reviews local changes since the merge-base";

/**
 * Parses trailing command args into a target, or a one-line usage string.
 * A `degraded` local target is decided by the caller (extension side), which
 * owns the git probes; the parser only classifies the shape.
 */
export function parseReviewArgs(
  args: string,
): { readonly target: ReviewTarget } | { readonly usage: string } {
  const trimmed = args.trim();
  if (trimmed === "") return { target: { kind: "local", value: null, degraded: false } };
  const pr = /^pr(?:\s+([1-9][0-9]*))?$/u.exec(trimmed);
  if (pr !== null) {
    if (pr[1] === undefined) return { usage: "usage: /code-review pr <number>" };
    return { target: { kind: "pr", value: pr[1], degraded: false } };
  }
  if (trimmed.includes("\n") || trimmed.includes(" ")) return { usage: CODE_REVIEW_USAGE };
  if (REF_RE.test(trimmed) || NAME_RE.test(trimmed)) {
    return { target: { kind: "commit", value: trimmed, degraded: false } };
  }
  return { usage: CODE_REVIEW_USAGE };
}

/**
 * The reviewer briefs are templates with a single `@@VALUE@@` token so the
 * generated extension carries byte-identical text (the extension cannot
 * import this module). `fillTarget` substitutes with split/join, a single
 * pass that cannot re-replace a value that contains the token itself.
 */
export const TARGET_VALUE_TOKEN = "@@VALUE@@";

/** The commands a local reviewer runs; degraded swaps merge-base for HEAD~1. */
export const LOCAL_TARGET_COMMANDS = [
  "Determine the base: `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` if an upstream " +
    "is configured, else the repository's default branch (main/master; " +
    "`git remote show origin` or the local branches when there is no remote).",
  'Then review everything since the merge-base: `git log --oneline "$(git merge-base HEAD <base>)"..HEAD` ' +
    "for the commits and `git diff \"$(git merge-base HEAD <base>)\"` for the diff, " +
    "plus untracked files from `git status --porcelain` " +
    "(skip any file larger than 256 KiB; read each with your read tool).",
].join("\n");

export const LOCAL_TARGET_COMMANDS_DEGRADED = [
  "The branch has no usable merge-base (detached HEAD, no upstream, or a deleted base).",
  "Review `git diff HEAD~1..HEAD` plus untracked files from `git status --porcelain` " +
    "(skip any file larger than 256 KiB; read each with your read tool).",
].join("\n");

/** The commands a commit/range reviewer runs. */
export const COMMIT_TARGET_COMMANDS = `Review commit ${TARGET_VALUE_TOKEN}: \`git show --format=fuller ${TARGET_VALUE_TOKEN}\`. ` +
  "Confirm it exists first with `git rev-parse --verify`; if it does not, say so.";

export const COMMIT_RANGE_COMMANDS = [
  `Review the range ${TARGET_VALUE_TOKEN}: \`git diff ${TARGET_VALUE_TOKEN}...\` (mind the three dots) and ` +
    `\`git log --oneline ${TARGET_VALUE_TOKEN}\` for the commits it carries. ` +
    "Confirm both endpoints exist first with `git rev-parse --verify`; if either is missing, say so.",
].join("\n");

/** The commands a PR reviewer runs; read-only gh, and never a post. */
export const PR_TARGET_COMMANDS = [
  `Review GitHub pull request #${TARGET_VALUE_TOKEN}: \`gh pr diff ${TARGET_VALUE_TOKEN}\` and \`gh pr view ${TARGET_VALUE_TOKEN}\` ` +
    "when `gh` is installed and authenticated.",
  "When gh is unavailable, fall back to the refs: `gh pr view` tells you the base branch; " +
    "then `git fetch` the PR head (`git fetch origin pull/<n>/head:pr-<n>`) and diff it against the base.",
  "Never post comments, reviews, reactions, or anything else to any external service.",
].join("\n");

function fillTarget(template: string, value: string): string {
  return template.split(TARGET_VALUE_TOKEN).join(value);
}

export function targetBlock(target: ReviewTarget): string {
  if (target.kind === "local") {
    return `## Diff target\n${target.degraded ? LOCAL_TARGET_COMMANDS_DEGRADED : LOCAL_TARGET_COMMANDS}`;
  }
  const value = target.value ?? "";
  const commands =
    target.kind === "pr"
      ? fillTarget(PR_TARGET_COMMANDS, value)
      : fillTarget(value.includes("..") ? COMMIT_RANGE_COMMANDS : COMMIT_TARGET_COMMANDS, value);
  return `## Diff target\n${commands}`;
}

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
