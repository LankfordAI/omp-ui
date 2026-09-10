# The persistent host owns the authoritative application and the joined-instance proxy

## Status

Accepted and effective. Issues
[#442](https://github.com/LankfordAI/omp-ui/issues/442) and
[#443](https://github.com/LankfordAI/omp-ui/issues/443) (decision map).

**Rollout.** Shipped in two releases: a preparation release (P) extracted
`HostApplication`, the role-aware transport, the desktop adapter, the headless
verifier, and the authority machinery while Electron main still constructed the
application and remained the sole authority; the cutover release (C) made
`omp-ui serve` the only constructor, made Electron a client, and deleted the
IPC backend. Everything below describes the state after C.

Supersedes in part [ADR-0028](0028-remote-instances-joined-by-main-process-proxy.md):
its single-owner reasoning stands unchanged, but the owner it names — the
Electron main process — is replaced by the persistent host. ADR-0002's seam
(`packages/core` free of Electron and transport, one typed `OmpBackend`) is
what makes the move an extraction rather than a rewrite.

## Context

Before the cutover the application backend and the Electron desktop lifecycle
were one process: Electron main constructed the only backend (`MainBackend`),
which owned the registry, the sole `SessionManager`, every live `omp` child,
the joined remote instances, OMP updates, and the embedded `@omp-ui/server`
listener; `before-quit` called `backend.killAll()`. The display stack was
therefore on the availability path of every remote session. On a monitorless
Fedora 44 host, a Mutter zero-area-window crash triggered by a development
Electron launch repeatedly took down the installed app's GPU process, its
systemd scope, and port 4677 — while the machine, the network, and the OMP
session files were all healthy (#442). A headless server could not run omp-ui
at all without a display server or a virtual framebuffer.

The seams to extract along already existed: `BACKEND_CHANNELS` and the typed
`OmpBackend` client, the Electron-free `@omp-ui/server` transport, the
Electron-free `SessionManager`, the `KeyCipher` seam, the `VerifierPage` seam,
and the `onOpenUrl` adapter in `ProviderOAuth`.

## Decision

**One persistent host owns the authoritative application.** The stateful
composition root is `HostApplication` in `@omp-ui/host`
(`packages/host/src/host-application.ts`). It owns the data root, the
`Registry`, the `SessionManager` and every live `omp` and shell child,
hydration and hibernation, plan files, plan gates and preflight, OMP
resolution and updates, provider environment and provider OAuth, the joined
remote instances, attention, diagnostics orchestration, and shutdown. It
imports no Electron; eslint forbids `electron` under `packages/host/**`.

**Only `omp-ui serve` constructs it.** `packages/host/src/serve.ts` claims the
data root (ADR-0030), reconciles the children ledger, replays the migration
journal, opens the credential cipher, constructs `HostApplication`, and starts
local control; `packages/host/src/cli.ts` is the one entrypoint that calls it.
Electron is a client: `MainBackend.registerIpc`, the preload `ipcRenderer`
business bridge, the `before-quit → killAll` path, the Electron `safeStorage`
cipher, and the `BrowserWindow` verifier are deleted, not kept as a fallback.
The desktop package does not depend on `@omp-ui/host`.

**Every UI is a client of the host over one role-aware WebSocket transport.**
`@omp-ui/server` exposes `HostSurface` (`packages/server/src/index.ts`):
`handlers(ctx: ConnectionContext)` builds one `ChannelTable` per
authenticated connection, `connectionClosed(id)` fires exactly once per
socket, and `addSink` delivers events by `EventScope` — broadcast, one
role, or one connection. The credential presented at HTTP upgrade selects
the connection's `ClientRole` — `browser`, `desktop`, or `instance` — and
whether it is `local` and carries `control`; a renderer-supplied id is never a
trust signal. A role-gated channel is absent from that connection's table,
not present and denied.

The wire gains a **`hello` handshake** (`packages/server/src/protocol.ts`,
`HOST_PROTOCOL = 2`, range 1–2): a protocol-2 client's first text frame is a
`ClientHello` naming its role, kind, client version, and protocol; the host
answers a `ServerHello` verdict and closes an incompatible client with
`4002`. A request or notify frame arriving first is **implicit protocol 1**,
accepted only where the listener sets `allowImplicitProtocol1` — the remote
exposure listener, so existing browser and joined-instance clients keep
working — and never on local control (`startLocalControl` passes `false`).
Implicit protocol 1 is retired once two later minor releases have shipped and
twelve months have passed since the cutover (#457). A joined app that answers
`incompatible` is reported as *too new* or *too old* from the host's own
range instead of being inferred from a missing `instance:identity`.

**Two listeners, two lives.** Local control (`packages/host/src/control/`)
binds `127.0.0.1:0`, mints a desktop credential
(`{ role: "desktop", local: true, control: false }`) and a control credential
(`{ role: "browser", local: true, control: true }`), and publishes them with
the endpoint in the mode-0600 connection record `<dataRoot>/host.json`
(`packages/core/src/host-record.ts`). Remote exposure is the existing Remote
access listener (`browser` and `instance` grants, `local: false`). Enabling,
disabling, or rotating one never touches the other; a host restart rotates the
local pair.

**The desktop client finds or starts the host through a bootstrap surface.**
Electron main exposes `window.ompHostBootstrap`
(`packages/core/src/host-bootstrap-channels.ts`): it reads `host.json`, probes
it with the desktop credential, and — when no compatible host answers — installs
the host directory the desktop artifact embeds under
`<dataHome>/omp-ui-host/versions/<version>`, points `current` and the stable
`omp-ui` command at it, submits the platform supervisor's on-demand identity
(`packages/core/src/host-launch.ts`: `systemd-run --user`, `launchctl submit`,
`schtasks`), and polls until the host is ready. The renderer awaits
`connection()`, connects with the desktop hello, and only then imports React;
a failure renders a raw-DOM recovery surface with retry, stop, and rollback.
Electron never `spawn()`s the host and never opens an authoritative store. A
pre-cutover desktop leaves a one-use cutover handoff
(`<dataRoot>/runtime/cutover-handoff.json`) so the first host can adopt its
`userData` stores under the migration journal.

**Client effects leave the host.** Actions only a UI client can perform on its
own machine — window chrome, opening or revealing paths, opening a project in
VS Code/Files/a terminal, external links, save dialogs, the banner gate, and
the client's own Electron update — travel over `DESKTOP_CHANNELS`
(`packages/core/src/desktop-channels.ts`) as `window.ompDesktop`, an
in-process preload adapter beside `window.ompBackend`. A browser client has
no adapter and gets truthful replacements; the host never performs a client
effect. Attention is host state: `AttentionTracker` publishes a per-tab level
on `attention:changed`, and the desktop notifier is one subscriber that
translates it into an OS notification gated by its own window's viewed tab.
Provider OAuth publishes the sign-in URL in the flow state; whichever client
started the flow opens it.

**The plan verifier is headless.** The parser, transform, and layout pipeline
moves to `@omp-ui/plan-doc`; the host drives a vendored, exact-version-pinned
Chrome for Testing (`packages/host/src/verifier/`) whose executable hash
must match `browser.manifest.json` before launch — never a system browser,
never a runtime download — from an ephemeral loopback origin with a random
path prefix, a fresh page per proposal, and the unchanged fail-closed verdict
contract. It replaces the hidden `BrowserWindow` verifier, so preflight runs
its real two-width layout probe with zero clients attached.

**The join moves with the application.** ADR-0028's one socket per joined
instance, its derived credential in `remote-instances.json`, merged
`projects`/`modelFavorites`, and tab-id routing all live in `HostApplication`.
Every client of this host — desktop or browser — sees the same joined
instances, which was ADR-0028's argument for a single owner; only the owner's
process changes.

## Considered options

- **Keep patching Electron window behaviour (rejected).** #437's
  `ready-to-show` delay removed one trigger; the recurrence reached
  `meta_window_activate_full`. Any compositor, GPU, or graphical-session
  failure would still remove the listener and process ownership.
- **Xvfb, or a `--headless` flag with a nullable `BrowserWindow`
  (rejected).** Both keep Electron as the owner of the registry, children,
  verifier, updates, and listener, and leave a permanently divergent second
  composition full of `if (win)` conditionals.
- **A standalone server beside the Electron-owned backend (rejected).** Two
  backends could open one registry and resume one lineage; OMP has no
  cross-process session lock. The host replaces the Electron ownership path;
  it never supplements it.
- **Host-delegated client effects over a host→client request frame
  (rejected).** The wire has no host→client request; effects ride an
  in-process desktop adapter beside the backend client instead (#454).

## Consequences

- **Packaging splits by artifact.** The host ships as a Node 22 single
  executable (`npm run package:host --workspace @omp-ui/host`: pinned Node
  runtime verified against `SHASUMS256.txt` and its signature, `node-pty`
  built for that runtime's ABI, the verifier payload, rendered supervisor
  definitions; `npm run smoke:package` boots the result). Each release lane
  publishes `omp-ui-host-<version>-<platform>-<arch>` beside its desktop
  artifact with a `latest-host-<platform>.yml` feed, and the release manifest
  refuses a desktop release without its matching host. The desktop embeds
  the host as a cold-start seed and starts it detached through the platform
  supervisor, never as a child of the client. The host updates itself through
  a staged handover (`packages/host/src/update/host-update.ts`).
- **The data root moves out of Electron's `userData`** to
  `<dataHome>/omp-ui` (`omp-ui-dev`, `omp-ui-dev-server` by build flavor):
  `$XDG_DATA_HOME` or `~/.local/share` on Linux, `~/Library/Application
  Support` on macOS, `%LOCALAPPDATA%` on Windows
  (`packages/core/src/data-root.ts`). `OMP_UI_DATA_DIR` replaces the whole
  root, logs included; the earlier registry-only path override, which
  relocated the store but not the logs, is deleted. `OMP_PROFILE`/`PI_PROFILE` never enter the
  mapping. Electron's `userData` keeps only client state — the Chromium
  profile, `window-state.json`, client-local logs.
- **Versions are reported separately.** Host version, host protocol and
  range, OMP version, and the desktop client's Electron/Chromium versions are
  distinct facts; the diagnostics bundle carries `host` and optional
  `desktopClient` sections instead of assuming a window-state file exists.
- **Browser parity is a rule.** Every host-owned `OmpBackend` channel behaves
  identically for a browser client; capability differences are expressed
  only as role-gated client effects.
- **Closing Electron changes one client's view.** Live sessions, the remote
  listener, other clients, and the joined instances are unaffected; reopening
  reconnects and rehydrates without a second `omp` process.
- **Documentation and vocabulary.** "host" is reserved for the persistent
  host; a joined app is "that instance"; "host-local" gives way to
  client-local or instance-local (`CONTEXT.md`). ADR-0028 is amended in
  referent by this record, not rewritten.
