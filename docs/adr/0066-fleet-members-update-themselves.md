# Fleet members update themselves; the controller sends an instruction, not bytes

> **Status:** Accepted, 2026-10-21 ([#905](https://github.com/LankfordAI/omp-ui/issues/905)).

A **Fleet** whose members run different versions is a fleet with two fleets'
bugs: the harness floor refuses an omp below it, auto placement happily picks a
member running an app three versions behind, and nothing in the Fleet view says
which machine is which. Members already accept four dispatcher-initiated
actions — dispatch (ADR-0061), exec (ADR-0062), detached exec and Provider key
rollout (ADR-0065) — yet bringing a member's own omp or omp-ui current still
means walking to that machine. The versions each member runs are the one fleet
fact with no channel at all: `fleet:hostReport` carries the member's app
version for the *unsupported* check and nothing else.

Facts that shape the design:

- Each member already owns a verified path to its own new versions. Core's
  `downloadOmp` fetches an omp release, verifies it by running
  `omp --version`, and installs it into the managed path through an atomic
  rename; omp-ui itself stages updates through electron-updater on every
  auto-update package format. Neither path needs a byte from anyone else.
- The join socket carries requests, and the biggest thing ever meant to cross
  it is a Provider key value. An omp release is tens of megabytes and an
  AppImage around 100 MB.
- A detached exec (ADR-0065) already gives the member a long-running lane with
  polling, retention, and revoke — but it runs a shell command, and neither
  install path above is a shell command: each is an in-process promise
  (`downloadOmp`, electron-updater's `downloadUpdate`) with no killable child.
- The grant ladder's rung 4 (Full control) plus the `fleetExecEnabled` master
  switch already gate everything that runs code on the member, and every
  accepted or refused fleet action writes one owner-side audit line
  (ADR-0062).
- Applying an omp-ui update means `quitAndInstall`, which kills every PTY and
  RPC child on the member; on AppImage, electron-updater unlinks the old file
  before moving the new one in, so an interrupted apply can leave neither
  version runnable.
- `ompPinActive` (core's `omp-update.ts`) is the one pin rule: a binary pinned
  with `OMP_UI_OMP_PATH` is never replaced automatically, by either updater.

## Why not the obvious routes

- **The controller downloads and ships the binary.** ~100 MB of AppImage over
  a LAN socket, and the controller would have to know each member's package
  format, install path, and credential environment to place it — every
  host-specific assumption the member already has answered once, on itself.
  Rejected: the member installs on itself through its own verified path;
  nothing but an instruction crosses the join socket.
- **Run the update as a detached exec.** The agent could compose the installer
  command — but that is `curl | bash` with extra steps: it skips omp-ui's
  `omp --version` verification, ignores the pin rule unless every command
  author remembers it, and cannot stage an electron-updater update at all
  because that is an in-process call with no CLI. Rejected: **Fleet maintenance**
  is its own lane, sibling to detached exec, with the member's real updaters
  behind it.
- **A fifth "update" rung on the ladder.** The ladder's rungs are consent
  distinctions the owner can articulate; a member that grants Full control has
  already agreed to arbitrary shell as its own user (ADR-0062), which implies
  strictly more power than replacing its own binary. A new rung would touch the
  whole ladder UI — rung picker, ceiling, grants display — to buy no consent
  distinction. Rejected: update gates on rung 4 plus the master switch through
  the existing `check()`.
- **Apply on the member's next natural moment with a restart the controller
  requests.** A fleet apply that calls `AppUpdater.restart()` kills every PTY,
  RPC child, and running turn on the member, and on AppImage the rename window
  makes an interrupted apply unrecoverable. Rejected: apply is always deferred
  (below).

## Decision

**Fleet maintenance: the controller sends `{ target, action, version? }` and
the member updates itself — an omp binary through core's `downloadOmp` with
`omp --version` verification into the managed path, or an omp-ui update
through its own electron-updater staging. Nothing ships through the join
socket. Start needs rung 4 plus the master switch through the existing
`check()`; apply never restarts a member and only arms install-at-next-quit.**

- **Channels.** The dispatching app calls the local `fleet:updateMachine`
  with `{ machineKey, request }`; it is orchestration only and stays off the
  socket. It forwards to the proxied `fleet:updateMember` (`check`, `stage`,
  or `apply` against `omp` or `app`) and polls the proxied `fleet:updatePoll`
  by `jobId`, owner-only like exec polling — no ladder re-check, ownership of
  the job is the gate. A `check` answers immediately with what the member runs
  and what it could become; `stage` and `apply` answer at once with a `jobId`.
- **The member's registry.** `FleetMaintenance`
  (`packages/desktop/src/main/fleet-maintenance.ts`) keeps one running job per
  member, settles it `succeeded`, `failed`, or `revoked`, caps it at
  `FLEET_MAINTENANCE_TIMEOUT_MS` (10 minutes; the timeout detail reads
  `timed out after 600 s`), and retains the 8 most recent finished records for
  polling. There is no cancelled state: each install path downloads to a temp
  file and renames only on success, so mid-flight there is nothing useful to
  abort. An older member answers the proxied channels with an unknown channel,
  which the dispatcher turns into the skew refusal
  (`<name> runs an omp-ui without fleet updates; update omp-ui there`).
- **Revoke before rename.** Every grant change, ceiling change, or switch flip
  runs `revokeWhere`: a running job whose starter no longer passes the
  Full-control check settles `revoked`, and the omp install checks
  `shouldCommit()` immediately before its atomic rename — the temp file is
  abandoned and the old binary stays in place. The app path needs no such
  guard mid-stage: staging bytes are inert until applied, and apply is a
  separate gated request that revocation simply refuses afterwards. On quit,
  `Backend.killAll` disposes what remains.
- **Deferred apply.** Fleet apply NEVER restarts a member. An app `apply`
  arms `setInstallOnQuit(true)` on the member's own updater — the same
  **Install when I quit** the Updates page offers — and answers with the
  detail; the update lands on the member's next natural quit. Applying with
  live sessions needs `allowLiveSessions`, and refusing names the count so the
  human can choose on the member itself. An omp target has no apply action:
  it is verified and renamed inside its own job, and sessions already running
  keep their binary until their next spawn.
- **Agent tool.** `omp-ui_fleet_update` is the seventh fleet tool, under the
  same registration gate and `exec` approval tier; its `update` action maps to
  the wire's `stage`. `omp-ui_fleet_machines` gains a `versions:` line per
  ready member (`versions: omp-ui 0.31.0 (update available: 0.32.0), omp
  18.12.0 (pinned)`), so an agent sees skew before it asks.
- **Version transparency.** `FleetHostReport` gains `ompVersion`, `ompPath`,
  `ompPinned`, `ompBelowMinimum`, `packageFormat`, `appLatestVersion`, and
  `appUpdateStaged`; each Fleet machine row shows omp-ui/omp chips, a
  below-the-floor badge, and a staged badge. The Fleet view's **Update
  versions…** dialog starts the same maintenance a tool call starts, on either
  target, behind the same gates.

## Consequences

- Bootstrapping is manual exactly once: a member running an omp-ui older than
  this feature has no update handler to call, so the first update there is by
  hand — the skew refusal string names that remedy rather than retrying. After
  one hand update, the member maintains itself for good.
- The owner's audit line names target, versions, and job id only — never a URL
  or payload. "What updated here while I was away" is answerable from the
  member's Activity log alone.
- One maintenance job at a time per member: a second start refuses with
  `a Fleet update is already running on this machine; wait for it to finish`.
  Two agents racing one member serialize on that refusal rather than racing two
  installers.
- Package-format honesty: a deb/rpm/flatpak member refuses an app stage with
  its package manager named (`this machine installs omp-ui as a <format>
  package; update it with its package manager`), and an unknown format says
  update manually. omp-ui does not silently do the wrong thing on a community
  package.
- A pinned omp (`OMP_UI_OMP_PATH`) refuses exactly as the desktop updater does;
  Fleet maintenance adds no override, so the pin remains the owner's absolute
  say.
- The deferred apply means "updated" on an app target means *staged*: the
  member says so and quits do the rest. A fleet whose members are never quit
  accumulates staged versions until someone restarts one — accepted, because
  the alternative kills running work.
- Update starts write audit lines and polls write none, exactly as detached
  exec's start/poll split does; a long download is one approval at most in an
  asking approval mode, not one per poll.
- **Amended 2026-10-30 (#990): Update all.** The Fleet view's **Update all**
  runs the same per-member maintenance on every member at once. It is local
  orchestration in the dispatcher (`fleet:updateAll` starts the run,
  `fleet:updateAllStatus` reads it; neither is proxied). Each member gets
  `omp / check` → `omp / stage` (only when a newer release exists), then
  `app / check` → `app / stage` → `app / apply`. The dispatcher long-polls
  `fleet:updatePoll` for each job and keeps the last run in memory. The
  rules above are unchanged: the same rung 4 + master switch gate, no
  restart, apply only arms install-at-next-quit. Accepting the one
  confirmation is the *Install when I quit* choice, so the arm carries
  `allowLiveSessions`. A member's up-to-date app train settles its staging
  job failed with `FLEET_APP_NO_RELEASE_DETAIL`, which Update all reads as
  *current*. This computer is never in the run.

## Amends / relates

- ADR-0062 (fleet exec) — update gates on the same rung 4 plus the master
  switch through the same `check()`; the ladder itself is unchanged, and a
  fifth rung is explicitly rejected here. The `update` audit action joins the
  existing actions.
- ADR-0065 (machine upkeep) — Fleet maintenance is the sibling lane to Detached
  exec: same long-job discipline (immediate id, long-poll, owner-only poll,
  revoke-on-revoked-consent, retention cap), different because a maintenance
  job is an in-process install promise with no killable child, so it has no
  cancelled state and its revoke gate sits at `shouldCommit()`. The host report
  gains the version fields beside ADR-0065's `os` / `packageManagers`.
- ADR-0028 (remote instances) — adds `fleet:updateMember` and
  `fleet:updatePoll` to the proxied allowlist; `fleet:updateMachine` stays
  local to the dispatching app.
- ADR-0011 / ADR-0015 (AppImage-only Linux, Windows preview) — an app-stage
  member limits are exactly the formats those ADRs support; everything else
  answers with its package manager pointer.
