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
