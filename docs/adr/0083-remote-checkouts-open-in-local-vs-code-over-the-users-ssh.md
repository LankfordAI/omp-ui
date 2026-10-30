# Remote checkouts open in this computer's VS Code over the user's own SSH

> **Status:** Accepted, 2026-10-30 ([#995](https://github.com/LankfordAI/omp-ui/issues/995)). Verified against VS Code 1.140.0 and Remote - SSH 0.129.2026100915. Amends the host-local bullet of [ADR-0028](0028-remote-instances-joined-by-main-process-proxy.md).

Most sessions run on fleet members. Looking at or editing the checkout a
remote session works in meant opening VS Code, connecting over Remote-SSH by
hand, and finding the project or worktree path. ADR-0028 kept every open
target host-local: Open in VS Code, Files, and Terminal are hidden for a
remote target and the proxy refuses them, because opening something *on the
host* answers a question nobody at this computer asked. This ADR records the
one exception: VS Code on *this* computer, connected to the member over SSH.

## Findings

- **VS Code's protocol handler opens a remote folder.** VS Code 1.140
  (`getWindowOpenableFromProtocolUrl`) reads
  `vscode://vscode-remote/<authority><path>`: it splits the authority off at
  the path's first `/`, opens the rest as a folder URI on that remote, and
  drops `windowId=_blank` after reading it as "new window". The handler is
  the same `vscode:` registration `ProjectOpener` already probes.
- **Remote-SSH's authority form is fixed by the extension.**
  `HostInfo.toAuthorityString` writes a bare lower-case host with no user,
  port, `/`, `\`, or `+` as itself, and anything else as the hex of
  `{"hostName","user"}` JSON. `HostInfo.parse` tries that hex JSON first and
  falls back to `user@host[:port]`. Remote-SSH refuses a host starting with
  `-` (`assertValidHost`), and then runs the user's own `ssh` with the
  user's own `~/.ssh/config` and agent.
- **omp-ui already knows the target.** Each joined member's `FleetMachine`
  carries `address` (the join URL's host), `report.user` (the member's login
  user), and `sshReachable` (a TCP connect to port 22 from this computer,
  cached 15 s) — ADR-0064. The member's projects, session records, and
  worktree checkouts arrive in `RemoteInstanceSummary.projects`.
- **omp has no part in this.** The open is VS Code and ssh; no omp RPC,
  setting, or binary is involved, so there is no omp constraint to verify.

## Decision

**Off by default.** `remoteVsCodeEnabled` (Settings → Remote instances →
*Open remote projects in VS Code over SSH*) is false until the user turns it
on. While off, neither surface shows the row, and main refuses
`project:openRemoteVsCode` with an error naming the setting. ADR-0028 and the
existing docs had no default for this case; off is the conservative choice.

**Two surfaces, one main path.** A remote project's page in the **Project
quick-open** and a remote session's title menu (its effective working tree:
the worktree checkout when it has one) show *Open in VS Code*. The renderer
asks `project:remoteVsCodeTarget(instanceId)` and shows the row enabled when
the target is ready, disabled with the reason (`SSH port 22 did not answer
on …`, no host report, unusable ssh host or user) otherwise, and hidden when
this computer has no `vscode:` handler. The compact shell never shows it, the
same rule as the local open targets.

**Main re-derives everything.** `RemoteVsCodeOpener`
(`packages/desktop/src/main/remote-vscode-open.ts`) takes only an instance id
and a path. On each open it checks the setting, requires the instance to be
joined, requires the path to be one that instance reported (a project path,
a session's project cwd, or a session's worktree path — exact string match,
so `..` cannot escape), reads the member's row through
`FleetDispatcher.machine` (the same report and cached probe the Fleet view
uses), and builds the URL itself. The renderer never supplies a host, user,
or URL.

**The ssh target is validated before it reaches a URL.** `remoteVsCodeTarget`
(`packages/core/src/remote-vscode.ts`) accepts a host of letters, digits,
dots, and hyphens starting alphanumeric, or an IPv6 literal of hex digits,
colons, and dots (no zone id), at most 253 characters; and a user of letters,
digits, dot, underscore, and hyphen starting with a letter, digit, or
underscore, at most 64 characters. Nothing that starts with `-` passes, so
neither value can read as an ssh option, and none of `@ / ? # % + :` (outside
IPv6) or whitespace can reach the authority. The authority is written exactly
as Remote-SSH writes it, so the window and its server key match a manual
connection to the same host. Each path segment is percent-encoded.

**Host-local, never proxied.** Both channels, and the settings channel, stay
off `REMOTE_PROXY_CHANNELS`: the action launches this computer's VS Code,
which a joined instance has no business asking for.

## Threat model

- **No new listener, no new credential.** omp-ui opens no port, runs no
  `ssh`, and holds no key. VS Code and the user's ssh do the connecting, with
  host-key checking and authentication exactly as a manual Remote-SSH
  connection. Nothing is logged: the URL is handed to the desktop's handler
  (`openExternal`, `xdg-open` on Linux from `withoutAppImageRuntime()`).
- **Who can trigger it.** This app's renderer, and a browser client signed in
  through remote access (the same request table serves both, as it does for
  `project:open`). Remote access's own token or password is the gate; such a
  client can make this computer's VS Code open a window on a member this app
  already joined, at a path that member already published, and nothing more.
- **What a member controls.** A joined member chooses its reported login user
  and its project and worktree paths. A hostile member can therefore pick
  which account VS Code tries and which folder opens — on that member's own
  host, which the join URL fixed. The character checks keep its user out of
  ssh option space and out of URL syntax; ssh authentication still decides
  whether the connection succeeds. The host itself comes from the join URL
  the user typed, never from the member's report.
- **What VS Code does next is VS Code's.** Connecting installs and runs VS
  Code Server on the member under that ssh account, as any Remote-SSH
  connection does. A missing Remote-SSH extension, an unknown host key, or a
  failed login shows in VS Code's window; omp-ui sees only that the launch
  started. Workspace trust for the opened folder is VS Code's prompt.
- **Reachability is a hint, not a guard.** The port-22 probe can be stale for
  up to 15 s, and something other than sshd may answer on port 22; either way
  the worst outcome is VS Code reporting a failed connection.

## Consequences

- ADR-0028's host-local bullet now reads with this one exception: VS Code
  over Remote-SSH opens on this computer, not on the host. Files and
  Terminal stay host-local, and `project:open` still never reaches a remote.
- A member reached through a hostname the user's ssh config aliases
  differently, a non-default ssh port, or a jump host is the user's ssh
  config's business: Remote-SSH resolves the authority's host through
  `~/.ssh/config` like a manual connection. The probe only checks port 22, so
  such a member reads *SSH port 22 did not answer* when 22 is closed; there
  is no per-member override.
- A member whose report predates #904 sends no user; the URL then carries
  only the host and ssh picks the user from the config or the local login.

## Alternatives considered

- **Run `code --remote ssh-remote+…` instead of the protocol URL.** Needs the
  `code` CLI on `PATH` (not installed by default on macOS) and a second
  launcher path beside the `vscode:` handler `ProjectOpener` already probes.
- **Open a local clone.** Edits the wrong copy.
- **Let the renderer pass the host, user, or URL.** One compromised or
  out-of-date renderer could then point VS Code anywhere; main rebuilding
  every part from its own state keeps the surface to "joined member, reported
  path".
- **Proxy it so a joined instance's window can open VS Code here.** Opens a
  window on this computer at another app's request; rejected.
