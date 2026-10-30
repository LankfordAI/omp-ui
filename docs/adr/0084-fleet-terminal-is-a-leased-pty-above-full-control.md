# A fleet terminal is a leased member PTY on a rung above Full control

> **Status:** Accepted, 2026-10-30 ([#991](https://github.com/LankfordAI/omp-ui/issues/991)).

**Fleet exec** (ADR-0062) runs one bounded command with no PTY, no stdin, and
no streaming, and ADR-0062 says outright that it is "not a terminal". To
watch `btop` on a member, or to work interactively there, the user leaves
omp-ui for ssh, which is also unreachable from a phone over remote access.

Facts that shape the design:

- A joined remote session's console drawer already runs a PTY on the owning
  instance and streams it here: `shell:spawn` and the `shell:*` notifies are
  tab-routed over the join (ADR-0028), and `shell:data` is mirrored as a
  remote tab event. That path keys on a tab id, and a fleet member with no
  session has no tab to key on.
- The member's grant ladder (ADR-0062) already decides how far each
  dispatcher may go, node-side, keyed on the claimed dispatcher instanceId.
  Full control runs one command; it says nothing about an interactive shell.
- The proxy relays a member's events to every dispatcher joined to it, and
  `REMOTE_TAB_EVENTS` re-emits them into the dispatcher's own sinks. Events
  in that set reach the dispatcher's own remote clients, and a mutual join
  would relay them back.
- A dispatcher can vanish without a goodbye: it quits, crashes, or loses its
  network. A shell it opened must not outlive that.

## Why not the obvious routes

- **Widen fleet exec with a PTY and stdin.** ADR-0062 bounds exec at one
  command, 30 s, and 64 KiB per stream so an agent tool call can never hold
  a shell. An interactive surface needs none of those bounds and is never an
  agent's to open, so it is a separate surface with a separate gate.
- **Reuse the console drawer's tab-routed `shell:*` channels.** They key on a
  session tab the member owns. A fleet terminal has no session, and minting
  a phantom tab would put a row in nobody's sidebar and bypass the ladder,
  since `shell:spawn` is gated only by joining.
- **Gate it on Full control.** A user who granted Full control so an agent
  could run `git --version` would find they had also granted an interactive
  login shell. Members that granted Full control before this change would
  gain it silently.

## Decision

**A fleet terminal is a PTY running the member's login shell, opened by the
user from the Fleet view under a dispatcher-minted id, gated on a new fifth
rung, `terminal`, above Full control, and kept alive only by a lease the
dispatcher renews.**

- **Rung.** `FLEET_RUNGS` becomes `observe < dispatch < manage < full <
  terminal`. Opening needs effective rung `terminal`
  (`min(grant ?? dispatch, ceiling)`) plus the `fleetExecEnabled` master
  switch, the same pair Full control needs. The ceiling defaults to
  `dispatch`, so no member offers a terminal until its owner raises the
  ceiling to Terminal, and raising a grant to Terminal remotely re-presents
  the join credential like every other raise. The member's Dispatchers list
  shows the grant.
- **Member legs, proxied.** `fleet:terminalOpen` (gate, then spawn under the
  minted id in the home directory), `fleet:terminalRenew`,
  `fleet:terminalEnd`, and the notifies `fleet:terminalWrite` /
  `fleet:terminalSize` join `REMOTE_PROXY_CHANNELS`. Each carries the claimed
  requester, and the member acts only on terminals that requester opened, so
  one dispatcher can neither type into nor end another's shell.
- **Member events are converted, never mirrored.** The member emits
  `fleet:memberTerminalData` / `fleet:memberTerminalExit` to its socket
  clients and never to its own window. The dispatcher's
  `RemoteInstanceManager` hands those two names to `FleetTerminalClient`,
  which converts bytes for the ids it opened into the local
  `fleet:terminalData` and drops everything else. Neither member event name
  is in `REMOTE_TAB_EVENTS`, so bytes are never relayed onward and a mutual
  join cannot loop.
- **Dispatcher legs, local only.** `fleet:terminalStart`, `Close`, `Input`,
  and `Resize` orchestrate in the acting app's main and are not on the
  proxy allowlist. Open terminals ride `BackendState.fleetTerminals`, in
  memory only, so every client of this app, including a phone over remote
  access, sees and can drive them.
- **Lease.** The dispatcher renews each member's running terminals every
  10 s. A member ends a terminal not renewed for 45 s, ends every terminal
  whose dispatcher drops below Terminal (a grant or ceiling change, or the
  master switch going off), and ends every terminal when it quits. A
  dispatcher that quits asks each member to end its shells immediately.
  Closing the terminal ends the shell. Nothing is written on the member.
- **Bounds.** At most 8 fleet terminals per member across all dispatchers;
  terminal size is clamped to 1..1000 cells per side.
- **Audit.** Each open (accepted or refused) and each end, with its reason
  (exited, closed, lease, revoked, quit) and exit code, appends one
  `terminal` line to the member's fleet audit. Keystrokes and output are
  never logged.
- **Agents never reach it.** No host tool opens a fleet terminal. It is a
  user surface in the Fleet view only.

## Consequences

- A holder of the join credential, on a member whose owner turned the master
  switch on, raised the ceiling to Terminal, and granted Terminal, gets an
  interactive shell as that member's user. That is the same blast radius
  Full control already carries (ADR-0062), reached through a separate,
  default-closed rung.
- Members that predate this change refuse the open with their own
  `unknown channel` error, reported as "update omp-ui there". Existing grants
  keep their meaning: nobody holds Terminal until it is granted.
- A terminal survives a brief drop of the join: its lease covers 45 s of
  silence, and the view says the member is not connected and holds input.
  A longer outage ends the shell, and the view then shows it ended on the
  member.
- Output is not buffered on the member. Bytes emitted while the dispatcher
  is disconnected are lost, as with the console drawer of a remote session.

## Amends / relates

- ADR-0062 (fleet exec): exec is still not a terminal. This ADR adds a fifth
  rung above Full control and a separate, user-only surface. The ladder's
  "rung 4 requires the master switch" now reads "Full control and above".
- ADR-0028 (remote instances): adds five member channels to the proxied
  allowlist and introduces member events that are converted per id rather
  than mirrored.
- ADR-0065 (detached exec): the member's ladder re-check now also ends fleet
  terminals.
