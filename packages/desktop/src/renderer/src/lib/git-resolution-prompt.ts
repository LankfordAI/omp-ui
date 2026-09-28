// The branch chip's resolve row's playbook (issue #675). One fresh session
// in the diverged or mid-merge checkout, seeded with the resolution steps —
// the same spawn-then-prompt shape as lib/experiment-kickoff. No ahead/behind
// counts ride along: the chip's snapshot can be stale and the playbook's own
// fetch changes them, so step 2 re-derives the truth from git.
import { withoutAccidentalKeywords } from "@omp-ui/core/magic-keywords";

export type GitResolutionTrigger =
  | { kind: "diverged"; branch: string; upstream: string; cwd: string }
  | { kind: "merge"; branch: string | null; cwd: string };

/** The first prompt of a fresh session asked to resolve a checkout's git state. */
export function gitResolutionPrompt(trigger: GitResolutionTrigger): string {
  return withoutAccidentalKeywords((q) => {
    if (trigger.kind === "diverged") {
      return [
        `Integrate the diverged branch in this checkout: ${q.inline(trigger.cwd)} — branch`,
        `${q.inline(trigger.branch)} and upstream ${q.inline(trigger.upstream)} each hold commits the other lacks,`,
        "so a fast-forward pull is impossible.",
        "",
        "1. Run `git status --porcelain=v2 --branch` and fetch the upstream's",
        "   remote. If the working tree holds uncommitted changes, commit or stash",
        "   them before touching history and say which you did — never discard or",
        "   reset uncommitted work.",
        "2. Read the divergence yourself:",
        `   ${q.inline(`git log --oneline ${trigger.upstream}..${trigger.branch}`)},`,
        `   ${q.inline(`git log --oneline ${trigger.branch}..${trigger.upstream}`)}, and`,
        `   ${q.inline(`git merge-base ${trigger.branch} ${trigger.upstream}`)}.`,
        "3. Choose the strategy: prefer rebasing the local commits onto the",
        "   upstream; merge instead when the local commits are already published",
        "   somewhere others could have pulled. Say which you chose and why.",
        "4. Resolve every conflict by reading both sides and the surrounding",
        "   context. When the right merge is ambiguous, keep both sides' intent",
        "   working and flag that file for review in your summary.",
        "5. Do not push, publish, or open a pull request. Leave the integrated",
        "   branch checked out with a clean working tree, then summarize: the",
        "   strategy, which commits moved where, which files needed hand",
        "   resolution, and anything you want reviewed.",
        "",
        "If the remote cannot be fetched from this machine, integrate against the",
        "local tracking refs and say so in the summary.",
      ].join("\n");
    }
    return [
      `A merge is in progress in this checkout: ${q.inline(trigger.cwd)}, stopped on conflicts`,
      trigger.branch === null
        ? "on a detached HEAD."
        : `on branch ${q.inline(trigger.branch)}.`,
      "Finish it.",
      "",
      "1. Run `git status --porcelain=v2 --branch`, read the stored merge",
      "   message (MERGE_MSG) and what MERGE_HEAD names, so you know what is",
      "   being merged into what and why.",
      "2. Resolve every unmerged file by reading both sides and the surrounding",
      "   context. When the right merge is ambiguous, keep both sides' intent",
      "   working and flag that file for review in your summary.",
      "3. If the tree also carries unrelated uncommitted changes, preserve them —",
      "   commit or stash them separately and say which; never discard.",
      "4. When every conflict is resolved, complete the merge with a plain",
      "   `git commit` (git's stored message unless it needs a fix). Do not",
      "   push, publish, or open a pull request.",
      "5. Summarize: what was merged into what, which files needed hand",
      "   resolution, and anything you want reviewed.",
    ].join("\n");
  });
}
