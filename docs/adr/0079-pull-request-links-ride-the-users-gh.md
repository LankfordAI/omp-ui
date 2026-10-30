# Pull request links ride the user's gh

> **Status:** Accepted, 2026-10-30 ([#985](https://github.com/LankfordAI/omp-ui/issues/985)).

A worktree session usually ends in a pull request, but until this change
omp-ui never learned which PR a session produced. The branch chip and the
Finish worktree dialog could only *open* the host's compare page (#414).
This ADR records how a session learns its pull requests, how their state
reaches every client, and when a merge settles the session.

## Decision

**The user's `gh` is the only forge client.** omp-ui still holds no token
(the #414 rule). `listBranchPullRequests` (`packages/core/src/pull-requests.ts`)
runs `gh api graphql` in the project checkout with `-F owner={owner} -F
name={repo}`, so gh picks the base repository and host exactly as it does for
`gh pr create`: github.com or any GitHub Enterprise host the user logged
into, the `gh repo set-default` choice, the upstream of a fork. Prompts and
update notices are disabled. A non-GitHub remote (GitLab, a bare path, an
unknown host) is not supported; gh says so and the repository is skipped.

**One call per repository.** Every worktree branch of one project is a
`pullRequests(headRefName:)` alias in one GraphQL query (40 per call), so
the cost does not grow with the number of sessions in a project. A PR whose
head repository is not the branch's own push repository is a same-named
branch in someone else's fork and is dropped.

**The owning host polls; the record carries the links.** The main process's
`PullRequestPoller` reads worktree records, writes `pullRequests:
{number, url, state, checks}[]` onto each `OwnedSessionRecord`, and
broadcasts. Clients — the desktop renderer, browser clients, and joined
instances — render what the host published; none of them run gh for a
session they do not own. It polls every 60 s while an omp-ui window has
focus, every 5 min otherwise, and at once when focus returns after 30 s. A
repository gh cannot answer for a lasting reason (gh missing, logged out,
not GitHub) waits 15 min; a transient failure (a GitHub 5xx, a timeout)
retries on the next poll. An empty answer never erases links the forge
reported before.

**Merge settles through the Settle path, on the observed transition only.**
When a record's known links were not all merged and the next poll reports
every one merged, the host settles the session through
`SessionManager.settleSession` — the reap Settle (#980) and a merged Finish
(#924) use — and emits `session:autoSettled` so each renderer adds an Undo
entry and the toast. It never reaps a running turn (it waits for the turn to
end), never settles a dormant row that is already in Settled, and never
settles on the first sighting of an already-merged PR (an upgrade, a branch
checked out after its merge) or again after the user resumed a merged
session. `autoSettleMergedPullRequests` (Settings → General, default on) is
the default; `OwnedSessionRecord.autoSettleOnMerge` (the HUD title menu)
overrides it per session.

## Rejected

- **A GitHub token or OAuth app in omp-ui.** A second credential store and a
  second login for something gh already holds; it would also need its own
  GHE host configuration.
- **Polling from each renderer.** Several windows and joined clients would
  multiply the gh calls, and a joined instance's checkout is not on the
  joiner's disk.
- **`gh pr list --head <branch>` per session.** One process and one API call
  per session per poll; the GraphQL alias batch answers a whole project in
  one.
- **Settling whenever the links read all merged.** A user who resumes a
  merged session to keep working would be settled again on every poll.

## Consequences

- PR links and auto-settle need `gh` installed and logged in on the machine
  that owns the session. Without it, sessions show no PR chip and nothing
  settles; the main log notes why once per backoff window.
- An in-app PR viewer (diff, comments, merge) remains out of scope; the
  branch diff pane already shows the diff.
