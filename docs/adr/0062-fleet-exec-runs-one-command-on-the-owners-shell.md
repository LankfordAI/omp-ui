# Fleet exec runs one bounded command on the owner's shell; both sides consent

> **Status:** Proposed, 2026-10-20.

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

**Add one proxied request channel, `fleet:exec`, and one host tool,
`omp-ui_fleet_exec`: the dispatching app sends `{ machineKey, command, cwd?,
timeoutMs? }`; the owning instance runs it as its own user and answers with
`{ exitCode, stdout, stderr, truncated }`. Both sides must have consent
turned on; the owner's check is enforced on the inbound handler.**

- **Channel.** `fleet:exec` joins `REMOTE_PROXY_CHANNELS` as an
  instance-scoped request (like `fleet:hostReport`), never tab- or
  project-routed. The owner's handler runs the command with the host's
  platform shell (`pwsh` on Windows, `/bin/sh -c` otherwise) in a fresh
  process — no PTY, no stdin, no streaming.
- **Owner-side consent is the hard gate.** A per-instance *Allow remote exec*
  setting (off by default, joined-instance registry, same store as placement
  preference) plus a host-local *Enable fleet exec server* master switch
  (also off by default). An owner with either off answers `refused` with a
  reason string; a compromised or mistaken dispatcher cannot execute on an
  unwilling member. This is the difference from dispatch, where the receiving
  side always accepts a well-formed spawn.
- **Caller-side consent rides ADR-0061's gate.** `omp-ui_fleet_exec` is
  registered only while *Let agents dispatch fleet work* is on and the
  session was not itself agent-dispatched (no recursion, §61), and every call
  runs at omp's `exec` approval tier — the user approves each invocation the
  same way they approve any other host tool.
- **Bounds are the owner's, not the caller's.** Output caps (stdout/stderr
  each truncated past a fixed byte budget, `truncated: true` set), a fixed
  timeout after which the owner kills the process tree and answers with the
  partial output and `timedOut: true`, and a single command string — no
  argument-array smuggling, no environment overrides, no privilege hints.
  The caller's `timeoutMs` may only shorten the cap.
- **Audit on the owner.** Each accepted or refused exec appends one registry
  line — timestamp, dispatching instance nickname, owning tabId, command
  text, exit code — readable from the fleet UI, so every member can answer
  "what ran here while I was away."

## Consequences

- The join credential becomes RCE-equivalent *for members that opted in*: a
  holder of an opted-in instance's credential can run anything its owner user
  can. The two default-off switches plus per-call approval tier are the whole
  mitigation; document them next to the token-rotation UI.
- Members reachable only through the fleet become answerable: no
  authorized_keys, WinRM trusted-hosts, or firewall surgery — the omp-ui
  join *is* the admin channel, which is exactly the point of membership.
- `fleet:hostReport` keeps its shape; anything a future UI wants to sample
  stays off the exec path rather than bolted onto it.
- Windows members gain a first-class management surface: command text runs
  through `pwsh`, so fleet docs must say so rather than implying POSIX
  semantics.
- Refusals are answers, not errors: `machines` output should stay the way to
  discover which members can be execed (its report gains an `execEnabled`
  flag) so agents do not retry refused members.

## Amends / relates

- ADR-0028 (remote instances joined by the main-process proxy) — adds
  `fleet:exec` to the proxied allowlist, instance-scoped like the two fleet
  read channels already there.
- ADR-0061 (fleet dispatch) — same registration gate and no-recursion rule;
  exec differs in that the *owner* can refuse, because it executes rather
  than hosts a session.
- ADR-0043 / ADR-0048 (host tools) — follows vault/fleet tool registration,
  `loadMode: "essential"`, and the fixed `exec` approval tier.
