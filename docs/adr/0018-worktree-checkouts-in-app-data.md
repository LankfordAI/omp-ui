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
the user made (superseded by the finish dialog addendum).

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
  checkout's current branch, otherwise the merge is unavailable (superseded
  by the finish dialog addendum).
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
  resolves or aborts a merge (superseded by the finish dialog addendum).
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
  checked out in the project (superseded by the finish dialog addendum).
  The release path (issue #334) shares this
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
  was cut from. No `git checkout` is performed (superseded by the finish
  dialog addendum).
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

## Lifecycle atomicity addendum

- **A fresh spawn is rolled back in dependency order.** Once a checkout is
  minted, every later failure unwinds the spawned child and lineage watcher
  before removing the new registry record. The minted checkout is reclaimed
  only after that record was removed (or was never persisted), so a registry
  write failure can never leave a surviving record pointing at a checkout the
  rollback deleted. A reused checkout is borrowed state and is never reclaimed
  by spawn rollback.
- **Cascade deletion settles records before reclaiming checkouts.** Every member
  still enters its ordinary per-tab delete queue, and all members are allowed
  to settle. Checkout descriptors are captured first, deduplicated by path,
  then reclaimed against the explicit post-settle registry survivors. A failed
  descendant therefore stays retryable and protects a shared checkout, while a
  fully deleted closure reclaims that checkout exactly once.
- **Checkout policy lives in core.** `reclaimCheckouts` owns canonical-path,
  survivor, checkout-removal, and branch-removal policy for delete, release,
  and rollback. Desktop supplies the current survivor snapshot; it does not
  duplicate those guards.

## Finish dialog addendum (issues #385–#390)

- **One dialog settles a worktree session.** The merge-back rows are gone
  from the HUD's worktree chip and the composer's branch chip: both open the
  finish dialog, which runs create branch → rename → merge → release in that
  order (issue #385). The delete confirmation pairs with the dialog from its
  own side: it still merges first when asked — destination resolved from the
  recorded base, or the listing's default branch when no base was recorded —
  and deletes only when the merge does not stop on conflicts. A conflicted
  merge leaves the dialog open on the conflict; a conflicted sync closes it
  and moves the work into the checkout.
- **The destination is chosen, not derived.** The dialog defaults to
  `resolveMergeDestination(projectCwd, base)`, offers any local branch, and
  offers a new branch cut from a chosen start point — `createBranch` first,
  then a merge into it like into any other destination. While a new branch
  is selected, its feasibility reads against the start point: merging into a
  fresh branch at X is byte-identical to merging into X. This supersedes
  "the destination must be the project checkout's current branch, otherwise
  the merge is unavailable" (merge-back addendum, issue #272).
- **The merge runs wherever the destination lives.** When the project
  checkout holds the destination, the merge runs there as before. When the
  destination is checked out nowhere, it runs in a scratch worktree under
  `<worktreesRoot>/.merge`: `git worktree add`, merge, remove — the checkout
  exists only for the duration of the call (issue #385). A conflicted merge
  there is `git merge --abort`ed and leaves nothing behind
  (`conflictsLeftIn: null`), so the session can sync and finish again. A
  destination held by ANOTHER worktree refuses: git would refuse too, and
  picking elsewhere is the user's call. The scratch directory lives under
  the worktrees root, so a crash leaves at most a leftover that
  `sweepOrphanWorktrees` deletes at next boot.
- **Conflicts are previewed, then resolved in the sandbox.** Before any
  merge runs, `git merge-tree --write-tree` answers whether it would conflict
  and in which files; an older git or a failed probe reads "unknown" and the
  dialog simply cannot predict (issue #387). On conflict the dialog offers
  to sync the destination into the worktree — the destination merged into
  the session's own clean checkout, conflicts left in place for the session
  that owns the change to resolve in the sandbox. This supersedes "conflicts
  are left in the project checkout for the user" (merge-back addendum) as
  the default story; it stays true exactly when the project checkout holds
  the destination.
- **A dirty checkout cannot be returned.** `releaseWorktree` refuses while
  the checkout has uncommitted or untracked changes — main reads
  `git status --porcelain` (issue #388). The dialog's return checkbox
  follows the status, not the other way round. Merge-only and keep-branch
  still work on a dirty checkout — neither removes it — and the delete
  confirmation remains the one surface that force-removes it, now naming
  the loss only when there is one.
- **Keep-branch and rename are first-class outcomes** (issue #386). The
  keep outcome releases the session and the reclaim records
  `kept-requested` without a git call — the branch survives because nothing
  deletes it. The keep path can rename the branch first: `git branch -m`
  inside the checkout, so git moves that worktree's HEAD symref along with
  the ref. A merge path instead hands its destination to branch-deletion
  verification as `mergedInto`.
- **Branch deletion verifies, then forces.** `removeWorktreeBranch` runs
  `git branch -D` only after proving `isAncestor(branch, candidate)`
  against its candidate destinations — the branch just merged into, plus
  the one resolved from the recorded base (issue #385). The safety property
  plain `-d` borrowed from git ("never delete unmerged work") moves into
  that check, because plain `-d` tests against HEAD only and would refuse a
  branch merged into a destination that is not checked out; git still
  refuses a branch another worktree holds (`kept-refused`), and the checkout
  is always removed before the branch is attempted. This supersedes "Plain
  `-d`, never force" (worktree close addendum) and the `git branch -d` step
  in the release order (worktree release addendum).
- **Canonicality keys on the slot directory, not the branch name.** A
  checkout is canonical when the parent of its path equals
  `worktreeProjectDir(worktreesRoot, projectCwd)` — a directory derived from
  the project path alone (issue #386). The mint-time path shape above
  stands; what changed is that the leaf is never re-derived from the current
  branch name, so a renamed branch stays in the slot its path was minted
  into, while a corrupt or foreign path still refuses reclaim and is left
  for manual removal.
- **Auto-naming names created branches, never the session's own.** A
  minted worktree branch is the session's durable name (issue #428 retires
  the first-prompt rename this bullet formerly described, together with the
  plan-gate substitution of issue #422). Generation lives in the finish
  dialog, where it pre-fills the rename field — placeholders only, until
  the user types — and the *new branch…* destination's name field. "A
  minted branch reads as app scratch work" therefore stands for every
  untouched mint, and a user-typed name is never touched.
- **An existing-branch checkout records the repo's default branch as its
  base** (issue #390): the session cut nothing, so the branch's own history
  is not this session's work, and the default branch is the honest
  destination default — falling back to the project checkout's branch, then
  its HEAD commit. When the default branch is the branch checked out
  itself, merge status reads already-merged, which is honest.
- **Rejected: merging only into whatever the base resolution names.** The
  recorded base answers where the work was cut from, not where the user
  wants it to land; the resolution survives as the dialog's default, not its
  only option (issue #385).

## Branch naming addendum (issue #428)

- **The mint is the session branch's durable name.** A worktree session's
  branch reads `omp-ui/[<base>/]<8 hex>` at the review gate, at spawn, and
  after its first prompt, unless a human typed something; both automatic
  writers — the plan-gate hash substitution (issue #422) and the
  first-prompt rename (issue #389) — are retired. Model-derived names
  belong to branch *creation*: the finish dialog's rename field and its
  *new branch…* destination name field, each pre-filled from the session,
  each yielding to typed text. `PLACEHOLDER_BRANCH_RE` keeps keying the
  pre-fills and the base-following rule (issue #405), so untouched mints
  still state their cut point and stay unique per spawn.
