# Sessions provision fleet members over their own SSH; omp-ui only reports the target

> **Status:** Accepted, 2026-10-21 ([#904](https://github.com/LankfordAI/omp-ui/issues/904)).

A **Fleet dispatch** boots a session inside a *registered* project (ADR-0061),
so a member that lacks the checkout cannot take the work at all. ADR-0062's
rung 3 (`fleet:projectManage`) narrows the gap with two fixed verbs — `clone`
into a declared `fleetProjectRoots` root, `register` an existing checkout —
but its clone runs on the member's process with no interactive credential and
a 45 s bound, so in practice it reaches public `https` remotes only. A private
repository, an SSH remote, or a repo that needs its setup script run before a
session is useful (dependency install, submodules, generated files) stays out
of reach. ADR-0063 deferred "member lacks the checkout" to agent-driven
provisioning; this ADR is that provisioning.

Facts that shape the design:

- The agent asking for provisioning already runs in a session on the
  dispatching machine, with a real shell and whatever SSH keys and
  `~/.ssh/config` its user has. Most developer fleets already reach their own
  boxes over SSH; git on each member already holds that member's own
  credentials for the remotes it uses.
- The dispatching app already knows one host it has proved it can route to
  for every joined member: the hostname of the URL it joined that member at
  (ADR-0028). It does not know the member's login user, its platform, or which
  roots it accepts clones into — those live on the member, and
  `fleet:hostReport` is the existing channel that carries member facts.
- Registration is not just a registry write: `project:add` resolves the
  repository key (`resolveRepositoryKey`, ADR-0063) and starts the project's
  head watcher. The rung-3 `clone`/`register` verbs wrote the registry
  directly and skipped both, so a fleet-registered project showed no key —
  no unified node, no placement match — until restart (#906).
- `fleet:exec` (rung 4) can run one bounded command, but needs the owner's
  master switch, a raised ceiling, and fits a 30 s cap; a clone plus setup
  routinely exceeds that.

## Why not the obvious routes

- **Sync SSH keys or git credentials across the fleet.** One copy of a
  private key on every member — or a key the app mints and installs — gives
  omp-ui the highest-blast-radius secret it could hold, for a problem git
  already solves per machine. Rejected: each machine keeps its own
  credentials, and omp-ui holds none.
- **A manager-side `fleet:exec` sequence (clone, then setup) through the
  member.** Needs rung 4 on every member, which is default-off by design
  (ADR-0062), and the 30 s cap per command cuts off real clones and installs.
  Kept as the fallback lane for members SSH cannot reach, not the primary
  path.
- **Let members self-report their IP addresses.** A member knows its
  interfaces, but not which one the manager can reach: a workstation with
  Docker or VM bridges has several global IPv4 addresses, and a NAT'd or VPN
  host's own view differs from the route in. The join URL is the one host this
  app has already proved it can reach. Rejected.
- **Expose `project:add` to agents.** It is a renderer-proxied channel with no
  rung check; an agent calling it on a member would bypass the grant ladder
  entirely. Rejected: registration stays the rung-3 verb.

## Decision

**The fleet reports each member's SSH target; the session provisions with its
own shell and the machine's own SSH keys; registration stays the rung-3 verb,
routed through the same body as `project:add`.**

- **What the fleet reports.** `fleet:hostReport` gains the member's login
  user (`os.userInfo().username`) and its declared `fleetProjectRoots`. The
  dispatching app pairs the user with the **Member address** — the hostname of
  the join URL, IPv6 brackets stripped — and checks whether TCP port 22
  answers (1.5 s bound, cached 15 s per host, run concurrently with the host
  report, never for this computer or an unjoined member). A member running an
  older build omits the new fields; they normalize to null rather than
  failing the report.
- **What agents see.** `omp-ui_fleet_machines` prints, under each remote
  member, `ssh: user@address (port 22 open|closed|not checked); platform
  <platform> <arch>; project roots: <list|none declared|not reported>`, or
  `address: X (not connected)` for a member that is not ready. The Fleet view
  shows the same target as an `ssh user@address` chip toned by reachability.
- **What the session does.** `omp-ui_fleet_project` tells the agent to
  provision over its own `ssh -o BatchMode=yes user@address`: `git clone`
  into one of the member's project roots, run the repository's setup, then
  call the tool's `register` verb on the resulting checkout. The agent's
  shell commands run at omp's ordinary approval tier; no new agent tool.
- **One registration path.** `addProjectPath` in the backend is the single
  body behind both `project:add` and the rung-3 `clone`/`register` verbs
  (passed to the fleet server as `FleetServerDeps.addProject`), so a
  fleet-registered project gets its repository key and head watcher
  immediately (#906). A registration failure after a successful clone refuses
  with `cloned to <dest> but registration failed: …` so the checkout is not
  silently orphaned.

## Consequences

- omp-ui holds no SSH credential and opens no SSH session: the port probe is
  a bare TCP connect that is closed immediately. Provisioning succeeds or
  fails on the user's own SSH setup, exactly as it would from their terminal.
- `port 22 open` proves only that something answers on 22, not that the
  agent's key is authorized; `BatchMode=yes` makes an auth failure an
  immediate error instead of a hung password prompt.
- A member whose sshd listens elsewhere reads `closed`; the remedy is a
  `~/.ssh/config` `Host` entry on the dispatching machine, which the agent's
  ssh honours. The app does not probe other ports.
- A member joined over loopback (an SSH tunnel, or two instances on one box)
  reports `127.0.0.1` as-is; the address is the route this app uses, and it is
  correct for that route even when it is useless for SSH.
- The member's username now crosses the join at the observe floor. Project
  paths in the host report already expose it on most hosts, so the rung does
  not change.
- Fleet-registered projects carry their repository key and head watcher from
  the moment they register, so unified nodes (ADR-0063) and placement
  matching (ADR-0061) see them without a restart.

## Amends / relates

- ADR-0062 (fleet exec) — clarifies its rejection of "SSH/WinRM/SMB from the
  dispatching app": that rejection is of connections omp-ui itself owns and
  credentials it would have to provision. A session using the user's own ssh
  is the user's tool, not an omp-ui channel. Rung 3 still gates registration;
  rung 4 exec remains the fallback lane for members SSH cannot reach.
- ADR-0061 (fleet dispatch) — provisioning is what makes a member eligible:
  once registered with a repository key, the member is a placement candidate
  for that repository.
- ADR-0063 (unified project view) — this is the deferred answer to "member
  lacks the checkout": an agent provisions when asked, never the sidebar
  silently.
