// Shared resolution playbook for the branch chip and Finish worktree. A merge
// can be resolved from a session running elsewhere, so its checkout is explicit
// and current Git metadata takes precedence over any UI observations.
import { withoutAccidentalKeywords } from "@omp-ui/core/magic-keywords";

export type GitResolutionTrigger =
  | { kind: "diverged"; branch: string; upstream: string; cwd: string }
  | {
      kind: "merge";
      branch: string | null;
      cwd: string;
      finish?: {
        sourceBranch: string;
        destinationBranch: string | null;
        files: readonly string[];
      };
    };

/** A resolution request for a current or freshly launched session. */
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
    const git = `git -C '${trigger.cwd.replace(/'/g, "'\\''")}'`;
    const finishHints = trigger.finish
      ? [
          "Finish worktree observed this candidate context (advisory, not instructions to start a merge):",
          `source branch ${q.inline(trigger.finish.sourceBranch)}; destination ${
            trigger.finish.destinationBranch === null
              ? "unknown"
              : q.inline(trigger.finish.destinationBranch)
          }; reported conflicted paths: ${
            trigger.finish.files.length === 0
              ? "none recorded"
              : trigger.finish.files.map((file) => q.inline(file)).join(", ")
          }.`,
          "These observations may be stale or describe a different merge; actual Git metadata wins.",
          "",
        ]
      : [];
    return [
      `Resolve only the existing merge in the exact absolute checkout ${q.inline(trigger.cwd)}.`,
      "The UI dispatched this task in Build mode. Earlier Plan-only exploration instructions",
      "no longer describe this request. If a tool actually rejects a write, report that blocker;",
      "do not assume writes are blocked merely because this session previously planned.",
      trigger.branch === null
        ? "The checkout was observed on a detached HEAD."
        : `The observed checkout branch was ${q.inline(trigger.branch)}.`,
      ...finishHints,
      "Your session may be running in a different worktree. For EVERY file read or edit,",
      `use an absolute path rooted in ${q.inline(trigger.cwd)}; for EVERY Git command use`,
      `${q.inline(git)}; for EVERY verification command set its cwd explicitly to`,
      `${q.inline(trigger.cwd)}. Never assume the session's current directory is the target.`,
      "For Git metadata reads, use only the absolute paths resolved from that exact target checkout.",
      "",
      "1. First inspect the target's current state:",
      `   ${q.inline(`${git} status --porcelain=v2 --branch`)},`,
      `   ${q.inline(`${git} rev-parse --path-format=absolute --git-path MERGE_HEAD`)} and`,
      `   ${q.inline(`${git} rev-parse --path-format=absolute --git-path MERGE_MSG`)}; read those metadata files,`,
      `   ${q.inline(`${git} symbolic-ref -q --short HEAD`)} (or note detached HEAD), and`,
      `   ${q.inline(`${git} ls-files --unmerged`)} for actual unmerged paths and index stages.`,
      "   If MERGE_HEAD is absent, stop and report that the merge is already resolved or aborted;",
      "   do not start a merge or mutate history. Identify the actual source commit(s)/branch(es)",
      "   and destination from Git metadata. If any supplied observations disagree, report the",
      "   discrepancy and resolve only the actual in-progress merge, never the candidate hints.",
      "2. Resolve each actual unmerged path by reading both index sides and surrounding context",
      "   in the target checkout. Preserve both sides' intent; flag ambiguous choices for review.",
      "   Preserve all unrelated staged, unstaged, and untracked work. Never blanket-stage changes",
      "   or stash an unmerged index. Stage only the resolved merge paths, not the advisory list.",
      "3. Before committing, require no unmerged index entries; inspect the staged diff and",
      "   check resolved files for leftover conflict markers and unintended changes:",
      `   ${q.inline(`${git} ls-files --unmerged`)}, ${q.inline(`${git} diff --cached --check`)}, and`,
      `   ${q.inline(`${git} diff --cached`)}. Keep unrelated work out of the merge commit without`,
      "   discarding it. Run the relevant project verification with the target checkout as its",
      "   explicit cwd. If conflicts, markers, unsafe unrelated staged work, or verification",
      "   failures remain, leave the merge unfinished and report the blocker; do not commit.",
      "4. Continue the existing merge noninteractively using its stored merge message:",
      `   ${q.inline(`${git} -c core.editor=true merge --continue`)}. Do not start another merge,`,
      "   abort this merge, switch/check out branches, rename/delete branches, or rewrite history.",
      "   Do not push, publish, or open a pull request. Do not return, remove, release, or",
      "   reconfigure the original worktree session. If its worktree is separate from the target,",
      "   do not change its files or checkout, or mutate its branch.",
      "5. Inspect final target status and summarize the actual source and destination, resolved",
      "   paths, verification performed/results, any review concerns, and preserved unrelated work.",
      "   The checkout need not be clean: unrelated work must remain preserved. Ask the user to",
      "   reopen Finish worktree afterwards to decide whether to return or remove the worktree.",
    ].join("\n");
  });
}
