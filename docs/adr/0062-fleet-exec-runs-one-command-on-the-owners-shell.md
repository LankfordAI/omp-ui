# Fleet exec runs one bounded command on the owner's shell; both sides consent

> **Status:** Accepted, 2026-10-21 ([#901](https://github.com/LankfordAI/omp-ui/issues/901)).

ADR-0061 gave the **Fleet** one write primitive: a **Fleet dispatch** boots a
whole build-mode session inside a registered project. There is no way to ask
"what does this machine actually have installed?" or "is that service
running?" without paying a session spawn — and when the member has no
registered project, even the session is unreachable. A fleet whose manager
cannot run one command on its members cannot manage them: placement scores
say CPU and memory, but every fact below that granularity (toolchains,
services, disk layout) is invisible to the dispatching app.

Facts that shape the design:

- The join link already exists and is authenticated: the main-process proxy
  (ADR-0028) forwards an allowlisted set of channels over one socket carrying
  the instance credential. `shell:spawn` and `pty:*` are on that list for
  tab-scoped terminals, so arbitrary command execution *already* crosses it —
  but only through a tab the user opened in the renderer, never from an agent
  tool call.
- Every host tool runs at omp's `exec` approval tier and the host cannot
  change it (ADR-0048). A fleet exec tool inherits that gate for free.
- Dispatched sessions never receive the fleet tools (ADR-0061 §No recursion);
  the same exclusion covers exec.
- The owner already samples its own resources for `fleet:hostReport`
  (`fleet-host.ts`), so an owner-side policy check on inbound requests has a
  home.
- Paths and shells are host-local: the owner chooses the interpreter, so one
  tool works across Windows (`pwsh`) and POSIX hosts without the dispatcher
  knowing either.

## Why not the obvious routes

- **Require a registered project and dispatch a session instead.** Costs a
  model turn and a repo clone to answer `git --version`, cannot reach members
  with no registered project at all, and — because the dispatched session is
  an unattended agent — gives *less* determinism than the one command the
  caller asked for. Rejected in practice within a day of #899 landing.
- **SSH/WinRM/SMB from the dispatching app.** Every member needs a second
  credential path (authorized_keys, WinRM trusted hosts, firewall holes) that
  omp-ui does not own and cannot configure — the fleet join is the only
  channel guaranteed open. It also duplicates an authenticated link that
  already exists.
- **Fold it into `fleet:hostReport`.** The report is a periodic read-only
  resource sample; arbitrary owner-side probes running on the sampler's
  interval widens its blast radius and couples request/response semantics to
  a push channel.

## Decision

**Add one bounded command channel, `fleet:exec`, enforced node-side through
a grant ladder: the dispatching app sends `{ machineKey, command, cwd?,
timeoutMs? }`; the owning instance runs it as its own user and answers with
`{ exitCode, stdout, stderr, truncated }`. Both sides must have consent
turned on; the owner's check is enforced on the inbound handler.**

- **Channels.** `fleet:exec`, `fleet:projectManage`, `fleet:grantRung`, and
  `fleet:grantRaise` join `REMOTE_PROXY_CHANNELS` as instance-scoped
  requests (like `fleet:hostReport`), never tab- or project-routed; local
  orchestration (`fleet:machines`, `fleet:dispatch`, node-local grant
  edits, audit reads) stays off the socket. The owner's handler runs the
  command with the host's platform shell (`pwsh` on Windows, `/bin/sh -c`
  otherwise) in a fresh process — no PTY, no stdin, no streaming.
- **The owner's consent is a grant ladder, not a boolean.** Each dispatcher
  holds one **Fleet grant** rung on each node — `observe` < `dispatch` <
  `manage projects` < `full` — cumulative upward, enforced node-side keyed on
  the claimed dispatcher instanceId every fleet request carries. Join grants
  rung 2 (dispatch) exactly as before: no grant record means `dispatch`, so
  existing pairs keep working bit-identically. Rung 3 (`fleet:projectManage`,
  fixed verbs `clone` into a declared `fleetProjectRoots` root or `register`
  an existing checkout under one) needs an explicit grant. Rung 4
  (`fleet:exec`) additionally requires the host master switch
  `fleetExecEnabled` (default off) and a host ceiling
  `fleetExecCeiling` (default `dispatch`) that caps whatever any dispatcher
  may hold; effective rung = `min(grant ?? dispatch, ceiling)`. A compromised
  or mistaken dispatcher cannot execute — or even manage projects — on an
  unwilling member.
- **Raising a grant re-presents the join credential.** A remote raise
  (`fleet:grantRaise`) only succeeds when the dispatcher re-supplies this
  node's token/password; lowering needs no ceremony, and raising locally is
  free (Settings → Remote instances → Fleet access). Grants bind to the
  *claimed* instanceId — intent bookkeeping under the shared join token, not
  adversarial authentication; only a holder of the node's credential reaches
  the socket at all. Per-peer named credentials are the recorded remedy and
  explicitly deferred.
- **Caller-side consent rides ADR-0061's gate.** `omp-ui_fleet_exec` and
  `omp-ui_fleet_project` join §61's three tools into one five-tool set,
  registered only while *Let agents dispatch fleet work* is on and the
  session was not itself agent-dispatched (no recursion, §61), and every
  call runs at omp's `exec` approval tier — the user approves each
  invocation the same way they approve any other host tool. *Amended
  (#945): a **Chat** carries the set regardless of the setting (ADR-0061);
  member ladders still gate every exec, project, and update call.*
- **Bounds are the owner's, not the caller's.** 65,536 bytes per stream
  (stdout/stderr each truncated past the cap, `truncated: true` set), a
  30 s timeout after which the owner kills the process tree and answers
  with the partial output and `timedOut: true`, and a single command
  string — no argument-array smuggling, no environment overrides, no
  privilege hints. The caller's `timeoutMs` may only shorten the cap. A
  clone gets 45 s, inside the manager's 45 s member-call bound, inside the
  60 s host-answer watchdog. Exec on this computer is refused — "use your
  own tools there" — the ladder gates members reached over the socket.
- **Audit on the owner.** Each accepted or refused exec, project-manage, or
  grant-raise appends one audit line — timestamp, action, dispatching
  instance label, outcome with the rung used, detail truncated to a fixed
  budget — into an in-memory ring plus `fleet-audit.log`, readable from the
  fleet UI, so every member can answer "what ran here while I was away."

## Consequences

- The join credential becomes RCE-equivalent *on members whose owner opened
  the ladder all the way*: a holder of an instance's join credential can run
  anything its owner user can once `fleetExecEnabled` is on, the ceiling is
  `full`, and that dispatcher holds a `full` grant. The mitigations are the
  two default-off owner switches (master switch off; ceiling at `dispatch`),
  the re-presentation ceremony on every remote raise, the manager-side *Let
  agents dispatch fleet work* gate plus omp's fixed `exec` approval tier,
  no-recursion, and the owner's audit log; document them next to the
  token-rotation UI.
- Members reachable only through the fleet become answerable: no
  authorized_keys, WinRM trusted-hosts, or firewall surgery — the omp-ui
  join *is* the admin channel, which is exactly the point of membership.
- `fleet:hostReport` keeps its shape; anything a future UI wants to sample
  stays off the exec path rather than bolted onto it.
- Windows members gain a first-class management surface: command text runs
  through `pwsh`, so fleet docs must say so rather than implying POSIX
  semantics.
- Refusals are answers, not errors: `fleet:machines` output carries each
  member's effective rung (`; access full`, omitted for This computer) so
  agents see what a member will accept before trying, every owner audit
  line records the rung used, and a refused exec returns the reason as
  tool text rather than a retry-baiting error.

## Amends / relates

- ADR-0028 (remote instances joined by the main-process proxy) — adds the
  four fleet ladder channels to the proxied allowlist, instance-scoped like
  the read channels already there. ADR-0028's user-initiated remote-tab
  proxies (`shell:spawn`, `pty:*`, …) are untouched: the ladder gates the
  fleet channels only.
- ADR-0061 (fleet dispatch) — same registration gate and no-recursion rule;
  exec differs in that the *owner* can refuse, because it executes rather
  than hosts a session.
- ADR-0043 / ADR-0048 (host tools) — follows vault/fleet tool registration,
  `loadMode: "essential"`, and the fixed `exec` approval tier.
