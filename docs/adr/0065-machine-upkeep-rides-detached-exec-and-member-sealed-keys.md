# Machine upkeep rides a detached exec lane; Provider keys are sealed by the member

> **Status:** Accepted, 2026-10-21 ([#905](https://github.com/LankfordAI/omp-ui/issues/905)).

A **Fleet** member that grants Full control can run one **Fleet exec**
(ADR-0062), and a session can provision a checkout over its own ssh
(ADR-0064). Neither makes the member administrable from the dispatching app.
Installing a package, building a toolchain, or creating a virtualenv routinely
takes minutes, and the agent cannot see which OS or package manager it is
talking to. A member that should run the same models as this app also needs
this app's **Provider keys**, and today the only way to get them there is to
open Providers on the member and paste each one.

Facts that shape the design:

- The synchronous exec cap is fixed by a chain of bounds. A fleet exec gets
  30 s, inside the dispatcher's 45 s member-call deadline
  (`MEMBER_CALL_DEADLINE_MS`), inside the 60 s host-answer watchdog
  (`HOST_ANSWER_WATCHDOG_MS`). A host tool call that outlives the watchdog is
  answered as failed whatever the member does.
- `fleet:hostReport` already carries member facts at the observe floor
  (platform, arch, login user, project roots). It is the existing home for
  "what is this machine".
- The owner's grant ladder and its master switch already gate rung 4, and
  every accepted or refused fleet action already writes one owner-side audit
  line (ADR-0062).
- The omp auth bundle carry (#888, `auth:export-bundle` /
  `auth:import-bundle`) moves the output of `omp auth export`. It never reads
  omp-ui's own Provider keys, which live in `<userData>/provider-keys.json`
  encrypted by safeStorage (ADR-0010).
- Provider key plaintext exists only in the main process; `setKey` accepts
  only catalogued variable names and refuses to write when no OS credential
  store is present (ADR-0010).

## Why not the obvious routes

- **Raise the synchronous cap.** The 45 s member-call bound and the 60 s
  watchdog sit above it, and both protect every other host tool from a hung
  member. A 10-minute synchronous exec would need both raised for one tool.
  Rejected: long commands get their own lane.
- **A config-management engine.** Per-OS install verbs, a package-manager
  abstraction, idempotent state. That is Ansible's job, and the agent already
  writes shell commands well when it knows the OS and the managers present.
  Rejected: report the facts and let the agent compose the command.
- **Reuse the omp auth bundle carry for Provider keys.** It moves
  `omp auth export` output and never reads omp-ui's key store. Widening it
  would mix two stores with different owners and different gates. Rejected:
  a sibling channel that carries Provider keys only.
- **An agent tool for keys.** Keys are the user's secrets held on their
  behalf (ADR-0010). The user decided a rollout is theirs alone to start.
  Rejected: no agent-facing key tool; values never reach a model.
- **Refuse rollout over plain-HTTP joins.** The #888 carry already crosses
  `http://` joins and warns instead of refusing, and many fleets run on a
  private network with no certificate. Rejected for consistency: the
  confirmation names the transport and says plaintext when it is.

## Decision

**Long commands run as a Detached exec the member owns and the starter polls.
The host report names the member's OS and package managers. A user-initiated
Provider key rollout sends chosen keys main-to-main, and the member stores
them through its own credential store.**

- **Detached exec.** Two new proxied channels, `fleet:execDetach` and
  `fleet:execPoll`. Start needs the same check as fleet exec: Full control,
  master switch on. The member answers at once with an `execId` and runs the
  command through the same fixed shells and environment as fleet exec (both
  now launch through `packages/desktop/src/main/fleet-shell.ts`). The owner
  caps it at 30 minutes; the caller's `timeoutMs` may only shorten that.
  `FleetDetachedExecs` (`packages/desktop/src/main/fleet-detached-exec.ts`)
  keeps the last 65,536 bytes of each stream, runs at most 4 per member, and
  keeps the 32 most recent finished records for polling.
- **Polling is a snapshot.** A poll from the dispatcher instanceId that
  started the exec waits up to 25 s for it to finish, then answers with its
  state (`running`, `exited`, `timed-out`, `cancelled`, `revoked`), exit code,
  and output: the last 4,096 bytes per stream while running, the whole
  retained tail once finished. A poll may cancel, which kills the process
  tree. Any other caller gets the same refusal as an unknown id. Polls run no
  ladder check and write no audit line; ownership is the gate. Start,
  refusal, and finish each write one `exec-detached` line.
- **Owner consent stays the hard gate.** A running detached exec is killed,
  and reads `revoked`, as soon as its starter stops passing the Full-control
  check: the owner turns **Allow fleet exec** off, lowers the ceiling below
  Full control, or lowers that dispatcher's grant. `Backend.killAll` kills
  every running detached exec on quit.
- **Agent tools.** `omp-ui_fleet_exec` gains `detach`, and
  `omp-ui_fleet_exec_poll` is the sixth fleet tool, appended after the
  existing five under the same registration gate and `exec` approval tier.
- **Host report.** `FleetHostReport` gains `os` (`{ name, version }`, probed
  once per process) and `packageManagers` (a fixed per-platform table of
  names, each with its absolute path and whether it is on the PATH fleet exec
  children inherit, cached 60 s). `omp-ui_fleet_machines` prints them on a
  `system:` line under each remote member's `ssh:` line; the Fleet view shows
  an OS chip. An older member omits both and the dispatcher normalizes them
  to null.
- **Provider key rollout.** The Fleet view's **Roll out keys** opens a dialog
  that lists this app's keys by env name and masked tail, then a mandatory
  lifecycle confirmation. The renderer sends env names only on the local
  `fleet:rolloutProviderKeys`. The dispatching main reads each value with
  `ProviderKeys.rolloutValue` (stored, then environment, then login-shell;
  never a project `.env`) and sends them on the proxied `fleet:providerKeys`.
  The member checks Full control and stores each key with its own
  `ProviderKeys.setKey`, so its safeStorage re-encrypts the value. The answer
  lists installed and failed env names; the audit line names keys only.

## Consequences

- An app crash on the member orphans its running detached processes. On
  POSIX each leads its own process group, so nothing reaps it; it runs to its
  own end with no cap. Accepted: a clean quit kills them, and the owner can
  still see and kill them with ordinary OS tools.
- Every poll is a host tool call at omp's `exec` approval tier. In an
  approval mode that asks per call, a long install means one approval per
  poll, up to 25 s apart.
- Over an `http://` join, Provider keys cross the network in plaintext. The
  confirmation says so; the remedy is HTTPS or a private network, as for every
  other join traffic.
- Key values never enter a log, an audit detail, an error message, or a
  renderer payload. Parsers and codecs name only env names or indexes in their
  refusals.
- A member without an OS credential store (Linux `basic_text`) refuses every
  key with ADR-0010's message. The rollout still answers accepted, with every
  key failed, and the user sees which keys failed and why.
- Sessions already running on the member keep their old keys until restarted
  (ADR-0010 binds keys at process start); the success notice says so.
- Synchronous fleet exec keeps its bounds: 30 s and a 64 KiB head per stream.
  Owners get no UI to list or stop detached processes beyond the Activity log.

## Amends / relates

- ADR-0062 (fleet exec) adds the Detached exec lane, the sixth agent tool,
  and a 30-minute owner cap for detached commands. The synchronous bounds and
  the ladder are unchanged; detached start uses rung 4 exactly as exec does.
- ADR-0064 (provision over own ssh) extends the host report with `os` and
  `packageManagers`, printed beside the `ssh:` line it introduced.
- ADR-0010 (provider credentials) allows keys to arrive from a dispatcher
  holding Full control on this machine. Key material still never crosses into
  a renderer; it now crosses main-to-main over the join transport, and the
  member stores it through the same `setKey` checks as a typed key.
- ADR-0028 (remote instances) adds `fleet:execDetach`, `fleet:execPoll`, and
  `fleet:providerKeys` to the proxied allowlist. `fleet:rolloutProviderKeys`
  stays local.
