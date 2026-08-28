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
- **Project-scope `.omp/` config reaches a worktree session through a
  symlink** — see the addendum below (issue #325). Other project-scope
  provider files (`.cursor/mcp.json`, `opencode.json`, …) are tracked
  repo files, so the checkout legitimately carries its branch's copies.
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
  contains that cut commit. The merge always writes a `--no-ff` merge
  commit (see the merge-commit addendum, issue #333); only committed work
  on the branch is included.
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

- **Merge-back is terminal: merge & close.** Superseded by the worktree
  release addendum (issue #334): a successful merge no longer deletes the
  session. It still finishes the worktree in the same operation — the
  checkout is removed and the branch deleted — but the session moves back
  to the project checkout instead of being erased.
- **A conflicted merge stops both the merge and the close** — the project
  checkout is left with files to resolve and the worktree stays open, so
  nothing is deleted behind a merge the user still has to finish by hand.
- **The already-merged state gains an actionable action.** When the status
  read reports the branch is already in the destination, the chips offer
  it directly instead of the old inert "delete the session" note — now
  "return to <base>" (issue #334), originally "close the worktree".
- **Branch deletion rides on the last-ref session delete.** When the
  session being deleted is the last record referencing its checkout, the
  delete path also attempts `git branch -d` for the worktree branch into
  its recorded base (the same destination the merge-back resolves). Plain
  `-d`, never force: git's own guards (branch checked out elsewhere,
  not merged) keep the branch when they say so, and the merge-first path
  can never hit the refusal because the merge required the destination
  checked out in the project. The release path (issue #334) shares this
  reclaim with the delete rather than riding on it.
- **The refusal is a warn, not a failure.** An unmerged branch, a base
  that no longer resolves, or a git refusal keeps the branch (commits
  survive, as before) and logs a warning; it never blocks or fails the
  session delete.

## Project-scope config addendum (issue #325)

- **The checkout carries a `.omp` symlink to the project's own
  directory.** omp resolves project-scope config — `.omp/mcp.json`,
  `config.yml`, skills, rules — from its cwd, and a worktree session's cwd
  is the checkout, which lives outside the project. `.omp/` is gitignored
  in most repos, so the checkout had none and every project-scope setting
  silently vanished for those sessions. The link is created in the
  process-construction path (`SessionManager.spawnPty` / `spawnRpc`), so
  every route into a checkout is covered by one seam: fresh spawn,
  convert-to-worktree, plan handoff, resume, and relaunch — including a
  checkout minted before the project ever had an `.omp/`.
- **A symlink, not a copy.** One source of truth: omp-ui's project writes
  land on the project's real file through it, and no copy can drift. It
  also means the MCP manager, scoped to the session's own working tree,
  writes the project's file even though it resolves in the checkout.
- **Idempotent and never fatal.** Skipped when the project has no
  `.omp/`, when the checkout already owns one (a repo that tracks it —
  then the branch's own config wins, which is what omp reads there), and
  when the platform refuses the link (Windows without developer mode),
  where a warning is logged and the session runs on omp's user-level
  config as before.
- **Deletion must unlink, never traverse.** `removeWorktree`'s
  filesystem fallback and `sweepOrphanWorktrees` both use Node's
  recursive `fs.rm`, which lstats and unlinks symlinks. That invariant is
  load-bearing — breaking it deletes the user's project config — so both
  paths carry a regression test.
- **Rejected: copy `.omp/` into the checkout at spawn.** It drifts the
  moment either side is edited, and a project toggle would then have to
  decide which copy is authoritative.
- **Rejected: point omp at the project with a flag.** omp derives
  project scope from its cwd; the cwd must stay the checkout, because
  that is what makes the session's edits land on its own branch.

## Merge-commit addendum (issue #333)

- **Merge-back always writes a merge commit.** `git merge --no-ff -m ...`,
  never a fast-forward, even when the destination is an ancestor. A
  fast-forward left no trace that a worktree session landed, and the branch
  is deleted moments later, so nothing in the base branch said the work
  arrived through one. `git log --first-parent` now reads one entry per
  merged session.
- **The message is generated from the folded commits**: the borrowed subject
  of a single commit, or a count plus their subjects; then every GitHub
  closing reference (`Fixes #12`, `owner/repo#12`, `GH-12`) found in their
  bodies, re-emitted as one `Fixes <ref>` line each. GitHub already scans
  those same references in the individual commits, so this adds a readable
  record, not new closing behavior.
- **Nothing is pushed.** Merge-back moves the local base branch only; the
  issues close when the user pushes it. omp-ui has no push path.
- **Rejected: squash-merge.** It destroys the session's own commits, which
  are the record the merge commit points at.

## Worktree release addendum (issue #334)

- **Finishing a worktree releases it; it no longer deletes the session.**
  The session, its record, its transcript, its lineage and its tab all
  survive: `registry.updateSession(tabId, { worktree: null })` then a
  `relaunch` with `--resume`. Spawn cwd is `record.worktree?.path ??
  record.projectCwd`, so nulling the field is the whole move. This supersedes
  "Merge-back is terminal: merge & close".
- **The session lands on the base branch for free.** A merge-back already
  requires the destination to be the project checkout's current branch, so
  after the merge the project checkout is sitting on the branch the worktree
  was cut from. No `git checkout` is performed.
- **The order is forced by git and by the resume guard**: reap the child (and
  its console shell) → null the record → `git worktree remove --force` →
  `git branch -d` → respawn at `projectCwd`. `git branch -d` refuses a branch
  checked out in a live worktree, and `prepareResumeRecord` throws on a record
  whose checkout has vanished. A child that will not die aborts the release
  and leaves a retryable worktree session.
- **omp binds a session to the directory it was created in**, so the move is
  not just a spawn cwd. The session file's `"type":"session"` header carries
  `cwd`, and `omp --resume` refuses a session whose directory no longer
  exists — which is exactly what a release leaves behind. `prepareResumeRecord`
  therefore keeps that header equal to the record's effective working tree on
  every resume (`rebindSessionCwd` rewrites the header line alone; line 1 may
  be omp's fixed-width title slot, whose byte length is load bearing). Enforced
  at the resume seam, not in the release, so a dormant release is covered by
  the same invariant.
- **The release notice outlives the relaunch.** It is the only durable record
  in the UI of where the session went, and boot resets the transcript then
  replaces it with fetched history. Notices raised while a tab is booting are
  staged and delivered after that history lands.
- **The console drawer follows the session.** Its shell is killed with the
  checkout, and the drawer respawns when the session's working tree changes
  rather than resizing a dead terminal.
- **No other session is touched.** The plan-handoff cascade delete is gone
  with the delete. A descendant or fork sharing the checkout keeps the
  existing `shared` refcount true, so the checkout and its branch survive
  until the last sharer leaves, and the confirm dialog says so. This
  supersedes "Branch deletion rides on the last-ref session delete" for the
  release path; the delete path is unchanged, and both now share one
  `reclaimWorktree` with the same canonical/`isWithin` and `shared` guards.
- **Cleanup failures are warnings, never fatal.** The session must come back
  up in the project checkout either way; a leftover checkout is reclaimed by
  the boot-time `sweepOrphanWorktrees`, and the notice tells the user what was
  left behind.
- **A released session starts counting against the project busy guard**
  (`runningSessionTitleOnCheckout` compares `sessionCwd(...)`), so it can
  now prompt the mid-turn confirm for another session's merge-back or branch
  switch on the same checkout. That is correct: it really does run there now.
- **Rejected: switch the checkout's own HEAD to the base branch.** git
  refuses to check out a branch held by another worktree, and a detached
  checkout would strand the session outside the project it belongs to.
- **Rejected: keep the checkout and the branch.** Then `git branch -d` can
  never run, worktree checkouts accumulate in app data, and "finished" is
  indistinguishable from "still working".
