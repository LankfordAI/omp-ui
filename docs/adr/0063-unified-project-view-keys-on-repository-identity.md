# Unified project view keys on repository identity; a one-machine launch stays a plain session

> **Status:** Accepted, 2026-10-21 ([#903](https://github.com/LankfordAI/omp-ui/issues/903)).

The sidebar grew two parallel stacks: this app's own projects, then one group
per joined **Remote instance** (ADR-0028) with that instance's projects under
it. The same repository registered on three machines therefore shows as three
unrelated nodes, and starting work "on the box with the GPU" meant finding the
right group first. ADR-0061 already solved the matching problem for dispatch:
machines are matched by repository key — `host/owner/repo` lowercased, from
the checkout's web remote (`resolveRepositoryKey`) — never by path. This ADR
applies the same identity to how the sidebar *shows* projects, and pins down
what a single-machine launch from the **New session dialog** actually is.

Facts that shape the design:

- `ProjectRecord.repositoryKey` is exactly the key ADR-0061's placement uses;
  it is already carried in `fleet:hostReport`, so a joined instance's projects
  arrive with their keys and unification needs no new channel.
- The key is null for a checkout with no web remote (or an unreadable one).
  Two path-identical projects on two machines are not the same work; only a
  shared key can say so.
- `session:spawn` is already proxied and tab-routed by owner (ADR-0028), and
  the renderer's `launchSession(projectCwd, { instanceId })` rides it for a
  local or remote target alike — a one-machine launch needs no new transport.
- A **Fleet dispatch** is identified by the `fleet` provenance stamped on its
  record: the Session HUD's *Dispatched from* chip and the Fleet view's
  Dispatches section read it. Routing every remote launch through
  `fleet:dispatch` would stamp hand-launched sessions as dispatched work.
- A dispatch requires a first prompt (ADR-0061); a local launch may start an
  idle session. Folding remote launches into dispatch would force a prompt the
  user never asked for, or weaken the gate.
- Process and worktree state are host-local: a running session's child process,
  PTY, and checkout live on the owner, so no view can make a session mobile.

## Why not the obvious routes

- **Route every remote launch through `fleet:dispatch`.** One call path for
  all launches — but it stamps `FleetProvenance` on sessions the user started
  by hand, so the HUD claims "Dispatched from" a machine that is just hosting
  its own session, and the Fleet view's Dispatches section fills with ordinary
  work. It also inherits the required-prompt gate and the dispatchId dedupe
  for launches that need neither. Rejected: provenance should mean
  "arrived as dispatched work," not "runs on another machine."
- **Let sessions roam between machines.** The sidebar node suggests one thing,
  so its sessions could follow the user. But omp's process, its PTY, and the
  worktree the session edits are pinned to the owner's filesystem; "moving" a
  live session means kill-and-pack at best. Rejected: the session stays where
  it was born (ADR-0061 says the same for dispatch); the unified view shows
  them together without pretending they travel.
- **Replicate the project onto machines that lack the checkout.** A unified
  node naming a repository could auto-clone it on every member. That writes to
  machines the user never asked to touch, needs credentials the dispatching
  app may not have, and duplicates what agents can already do through
  `fleet:exec` (ADR-0062) when asked. Deferred to agent-driven provisioning
  (#904); unification is a view, not a sync engine.

## Decision

**(a) The sidebar unifies on repository identity.** Under **All hosts** scope,
projects whose records carry the same non-null `repositoryKey` render as one
**Unified project view** node with one sub-row per checkout; a null key never
merges — a checkout without a web remote stays its own node, per instance and
path. Path is never a match key.

**(b) A single-member launch rides the direct spawn path, not `fleet:dispatch`.**
Choosing one machine in the **New session dialog** calls
`launchSession(projectCwd, { instanceId })` — local `SessionManager.spawn` or
the proxied `session:spawn`, exactly as today — and renders through the normal
seed path. The record carries no `FleetProvenance`. `fleet:dispatch` stays what
the dialog's Fleet face produces for multi-target or auto runs (ADR-0061); a
machine dropdown with one box ticked is not a dispatch.

**(c) Sessions stay pinned to their owner instance.** The unified node lists
sessions from every member, but the machine is a label on the session row, not
a wall: opening, steering, and terminating run on the owner exactly as in the
per-instance view. The **HostScopePicker** stays the per-host lens; a unified
node never claims to change where a session runs.

## Consequences

- The sidebar answers "where is this repo checked out, and what is running on
  it?" in one node; the Fleet view answers "where should new work start?" —
  the two views agree because both read `resolveRepositoryKey`.
- Hand-launched remote sessions are indistinguishable from local ones in the
  record except for their owner instance: no provenance, no dispatchId, HUD
  shows only the host chip ADR-0028's projection already carries. The Fleet
  view's Dispatches section stays a true list of dispatched work.
- Remote one-machine launches may start idle sessions with no first prompt,
  like local ones; the required-prompt rule belongs to the Fleet face alone.
- Keyless checkouts stay visually separate even when path-identical; adding a
  web remote to one merges the nodes on the next state change, since keys are
  read from the registry records each instance reports.

## Amends / relates

- ADR-0061 (fleet dispatch) — borrows its repository-key matching and keeps
  its boundary: dispatch is multi-target or auto fan-out with a prompt the
  owner delivers; a single launch is a plain session on the direct path.
- ADR-0028 (remote instances joined by the main-process proxy) — unification
  reads the project projections the proxy already publishes, and single-machine
  launches ride the already-proxied `session:spawn`; no new channel.
- ADR-0062 (fleet exec) — the deferred answer to "member lacks the checkout":
  an agent can clone through exec when asked (#904), not the sidebar silently.
