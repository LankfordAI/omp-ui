# Worktree checkouts live in app data

A worktree session (issue #224) runs its omp process in a dedicated git
worktree of its project — a separate checkout on its own branch, sharing
the repo's object store — minted at spawn. The checkout lives under
`<userData>/worktrees/<projectSlug>--<hash8(projectPath)>/<branchSlug>`:
the slug names the project, the eight hex digits hash the project path so
two projects with the same basename never collide, and the leaf is the
minted branch's slug. The session record's `projectCwd` still names the
project; the worktree is the session's effective working tree.

Deletion is one-way on the checkout only: deleting the session removes the
checkout (`git worktree remove --force`, falling back to a plain
filesystem delete when git cannot), but the branch and its commits survive
in the repo. Removal is best-effort and never blocks the session delete
itself. A worktree session always shows the delete confirmation, even with
skip-confirmation on.

## Considered Options

- **Sibling of the repo (rejected)** — a checkout directory next to the
  user's repo pollutes their filesystem beside the project they work in.
  T3 Code (pingdotgg/t3code) considered the same placement and rejected
  it too.
- **`.omp-ui/worktrees/` inside the repo (rejected)** — a worktree inside
  its own working tree is nested-worktree noise that shows up in the repo
  itself, plus per-repo gitignore churn.
- **App data (chosen)** — never touches the repo or its parent, is
  trivially cleaned, and needs no per-repo opt-in. The branch is the
  durable artifact, and it lives in the repo anyway.

## Prior art: T3 Code's thread-per-worktree

T3 Code (pingdotgg/t3code) runs each chat thread in a git worktree under
the app's data dir (`worktreesDir`), creating it with
`git worktree add -b <branch> <path> <base>` and force-removing it when
the thread is deleted. omp-ui follows the same shape, with a recognizable
temp-branch prefix of its own — `omp-ui/<8 hex>` here, `t3code/<8 hex>`
there — so a minted branch reads as app scratch work, never as a branch
the user made.

## Consequences

- **Checkouts don't survive a userData wipe.** The branch does — it
  lives in the repo.
- **A gitignored project `.env` is absent from the checkout**, so
  `.env`-only provider keys don't reach a worktree session. Stored, env,
  and shell-captured keys do — they ride `process.env` into the child.
  The spawn provider-keys gate stays on `projectCwd`.
- **A project-scope MCP toggle (issue #220) reaches a live worktree
  session only after the config change lands in the branch.**
- **Disk cost is user-visible** — a full checkout per worktree session —
  and is reclaimed on session delete.
- **A vanished checkout (manual rm) fails resume loudly** — it never
  silently respawns at the project root.

## Merge-back addendum (issue #272)

- **The merge runs in the project checkout, on its current branch.** A
  merge into the destination needs a worktree with it checked out; git
  refuses to check out a branch held by another worktree, and the worktree
  checkout belongs to the session — so the destination must be the project
  checkout's current branch, otherwise the merge is unavailable.
- **The destination resolves from the recorded `base`**: a local branch
  named by it, else — when `base` resolves to a commit — the unique local
  branch pointing at it, else the project's current branch when it
  contains that cut commit. The merge fast-forwards when history allows,
  otherwise creates a real merge commit; only committed work on the
  branch is included.
- **The metadata was refined to match**: `base` now records the project
  checkout's branch name at creation, and a SHA only when the checkout is
  detached (SHA bases resolve through the same rules).
- **Conflicts are left in the project checkout for the user** — `git merge
  --continue` to finish, `git merge --abort` to undo. omp-ui never
  resolves or aborts a merge.
- **The delete confirmation offers the same merge first.** Merging is
  additive: "deletion is one-way on the checkout only" still stands — the
  branch and its commits survive deletion either way.

## Worktree close addendum (issue #323)

- **Merge-back is terminal: merge & close.** A successful merge from the
  HUD worktree chip or the branch chip's merge-back row closes the
  worktree in the same operation: the session is deleted (its agent
  stopped, transcript and artifacts erased) and the checkout is removed —
  the merge and the close are one deliberate action, and the confirm
  dialog says so before it is taken.
- **A conflicted merge stops both the merge and the close** — the project
  checkout is left with files to resolve and the worktree stays open, so
  nothing is deleted behind a merge the user still has to finish by hand.
- **The already-merged state gains an actionable close.** When the status
  read reports the branch is already in the destination, the chips offer
  "close the worktree" (the session delete behind it) instead of the old
  inert "delete the session" note.
- **Branch deletion rides on the last-ref session delete.** When the
  session being deleted is the last record referencing its checkout, the
  delete path also attempts `git branch -d` for the worktree branch into
  its recorded base (the same destination the merge-back resolves). Plain
  `-d`, never force: git's own guards (branch checked out elsewhere,
  not merged) keep the branch when they say so, and the close-on-merge
  path can never hit the refusal because the merge required the
  destination checked out in the project.
- **The refusal is a warn, not a failure.** An unmerged branch, a base
  that no longer resolves, or a git refusal keeps the branch (commits
  survive, as before) and logs a warning; it never blocks or fails the
  session delete.
