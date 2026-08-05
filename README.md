# omp-ui

A cross-platform desktop GUI for [Oh My Pi](https://github.com/can1357/oh-my-pi) — the `omp` coding agent.

**Project sidebar on the left. Either an embedded OMP TUI or a native
transcript in the main pane.** Jump between repos without managing a fleet of
terminal windows. Full advisor integration, session management, and a native
rendering mode over `--mode=rpc-ui`.

Think **T3 Code, but for Oh My Pi**: a launcher and session manager for `omp`,
not a browser of your `~/.omp` history — the sidebar tracks only sessions
omp-ui launched itself (see `CONTEXT.md`).

Built on **Electron** — a uniform Chromium webview on every platform, so the
xterm.js terminal renders and performs identically everywhere. Rationale and
rejected alternatives: [ADR-0001](docs/adr/0001-electron-over-tauri.md).

## Architecture (three phases)

```
┌──────────────┬────────────────────────────────────────┬─────────────┐
│ Sidebar      │ TabBar                                 │             │
│              ├────────────────────────────────────────┤  Inspector  │
│ Projects     │ Session HUD    liveness · context ·    │    Rail     │
│ Sessions     │                spend · controls        │             │
│              ├────────────────────────────────────────┤  Todos      │
│ filter       │                                        │  Console    │
│ live dots    │  Transcript (rpc-ui)   or   xterm.js   │  Agents     │
│ new session +│  markdown · tool cards      (PTY TUI)  │  Session    │
│              │  diffs · advisories                    │             │
│ collapses    ├────────────────────────────────────────┤  collapses  │
│ to icons     │ Composer   steer · queue · /commands   │  to icons   │
└──────────────┴────────────────────────────────────────┴─────────────┘
         Electron IPC (OmpBackend interface) │
┌────────────────────────────────────────────▼────────────────────────┐
│  packages/core — plain Node, zero Electron imports                  │
│  PTY manager (node-pty) · rpc-ui client/codec · session scanner     │
└────────────────────────────────────────────┬────────────────────────┘
                                             ▼  node-pty / child_process
                        omp --cwd=<project>   omp --resume=<session-id>
```

A command palette (`Ctrl/⌘+K`) searches every session, project, and tab
action. Design tokens and the primitive vocabulary are fixed by
[ADR-0004](docs/adr/0004-design-tokens-and-primitives.md).

### Phase 1: PTY Embed
Spawn `omp` under a [node-pty](https://github.com/microsoft/node-pty) PTY (the
same PTY layer VS Code, Hyper, and Tabby use). Raw PTY bytes stream via
Electron IPC into `xterm.js` in the renderer. OMP's TUI runs unmodified —
every keybinding, theme, and skill works. Pasting an image is bridged to the
TUI's own bracketed-paste path ([ADR-0006](docs/adr/0006-image-paste-in-both-modes.md)),
since a PTY carries no byte channel. Build in ~2 weeks.

**Files:** `docs/phase-1-pty-embed.md`

### Phase 2: RPC-UI Native Render
`--mode=rpc-ui` is OMP's headless JSON protocol over stdin/stdout. The main
pane renders the `AgentSessionEvent` stream as native components: markdown
assistant text, per-tool cards with live partial output, line-numbered diffs,
advisor cards by severity, and a usage receipt per turn. The composer carries
the controls that belong beside the text — model, thinking level, an advisor
on/off with its own model picker
([ADR-0005](docs/adr/0005-session-scoped-advisor-via-config-overlay.md)), and
pasted image attachments — while the session HUD and inspector rail expose the
rest: steering / follow-up / interrupt modes, compaction, auto-retry, branch,
export, todos, subagents, bash, and all 49 slash commands through a fuzzy
palette.

**Files:** `docs/phase-2-rpc-ui.md`

### Phase 3: ACP Integration
OMP already serves the [Agent Client Protocol](https://agentclientprotocol.com)
via `omp acp` — Zed lists Pi Coding Agent in its ACP Registry today. This phase
documents the integration and optionally builds a thin ACP client wrapper.

**Files:** `docs/phase-3-acp.md`

## Repository layout

```
packages/
├── core/      # Plain Node + TS: PTY manager, rpc-ui frame codec/client,
│              # session scanner. Zero Electron imports, transport-agnostic.
├── desktop/   # Electron shell: main process, preload bridge, renderer.
│              # Wires packages/core to the renderer over IPC.
└── server/    # Node HTTP + WebSocket wrapper around packages/core: serves the
               # renderer bundle to a browser and implements OmpBackend over WS.
```

## Remote access

**Settings → Remote access** turns on an embedded HTTP + WebSocket server that
serves the same renderer to a browser and mirrors the one live `MainBackend` —
remote clients are extra views of the same sessions, not a second owner. It is
**off by default**, and a connected client can do everything the local user can.

- **Bind address.** `localhost` (default) listens on `127.0.0.1` only. `local
  network` listens on `0.0.0.0` so a phone or second machine can reach it — an
  explicit, warned choice, over plain HTTP with no encryption.
- **Access token.** A 32-byte bearer token authenticates every request and the
  WebSocket upgrade. The page reveals, copies, and QR-codes the pairing URL;
  regenerating the token disconnects every connected client.
- **Port.** Default `4677`; any whole number in 1024–65535.
- **Build requirement.** The browser bundle is a separate Vite build. Run
  `npm run build:web --workspace @omp-ui/desktop` (it is part of `npm run
  build`); without it the server answers `503` with that hint and the settings
  page says the bundle is missing.

Because the server lives inside the Electron main process, there is no remote
access while the desktop app is closed — the point is controlling *this app's*
live sessions. Installability and offline support are secure-context-only, so a
`http://<lan-ip>` origin gets a responsive web app but no install prompt until
you front it with your own HTTPS.

The seam this rides on is a standing design constraint: all OMP-facing logic
lives in a transport-agnostic `packages/core`, and the renderer talks only to a
typed `OmpBackend` interface (Electron IPC locally, WebSocket remotely).
Rationale and consequences: [ADR-0002](docs/adr/0002-transport-agnostic-core.md).

## Distribution

Releases are **Linux-only** (the dev machine is Fedora) and tag-driven: pushing
`v*` runs `.github/workflows/release.yml`, which publishes four artifacts to
the GitHub release — **AppImage**, **deb**, **rpm** (electron-builder), and a
single-file **Flatpak** bundle (assembled separately) — plus the update
metadata: `latest-linux.yml` (sha512 + blockmap, for the AppImage path) and
`SHA256SUMS.txt` (covering all four artifacts). The stack stays cross-platform
— uniform Chromium is why Electron was chosen (ADR-0001) — so widening later
is a packaging task, not a port.

The installed app **checks for newer releases** in the background at launch,
and on demand via the command palette's "Check for updates". A newer stable
release surfaces as a small non-modal **update card** in the lower-right
corner: installed/available versions, the update action, release notes, and
"Later" — which is remembered per release version. Offline, rate-limited, and
no-update checks stay silent, and dev/unversioned builds never check. The
launch check is optional: the settings surface's Updates page turns it off for
omp-ui independently of the omp binary, and "Check for updates" from the
command palette still runs either way. Nothing downloads without an explicit
click, and nothing restarts the app for you.

What the update action does depends on how the app was installed:

- **AppImage** — in-place update via electron-updater (sha512/blockmap
  verified against `latest-linux.yml`). When the download finishes the card
  offers "Restart now"; restarting still passes the live-session quit guard.
- **deb / rpm** — the exact expected package is downloaded to `~/Downloads`,
  sha256-verified against the release's `SHA256SUMS.txt` (fail-closed: no
  checksums, no install), and opened with the system installer.
- **Flatpak** — the bundle is a single file with no ostree repo behind it, so
  `flatpak update` never applies; the card downloads the new bundle
  (sha256-verified the same way) and opens it, which reinstalls in place.

The **omp binary** gets the same treatment: omp-ui manages its own copy of
the `omp` CLI and checks the npm registry at launch (and on demand via the
command palette's "Check for omp updates"). A newer omp — or a missing binary
— surfaces as the same kind of update card: installed/available versions,
"Update now" (or "Install"), and "Later", remembered per offered version.
Offline and no-update checks stay silent. The install is atomic and verified
(the download must run as `omp --version` before it replaces anything),
nothing downloads without a click, and live sessions keep their running
binary — only new sessions pick up the install. Its launch check has its own
switch on the Updates page, separate from the omp-ui one; "Check for omp
updates" from the command palette runs whether or not the launch check is on.


## Session Storage

OMP stores sessions under `~/.omp/agent/sessions/` (default; overridable via
env, XDG, and `--session-dir`) with a per-project subdirectory. See
`docs/session-encoding.md` for the exact encoding rules and file format.
omp-ui does not browse this whole tree — it tracks only the sessions it
launched (its own registry), hydrating titles/status from the files. Launched
sessions live in per-lineage pinned dirs inside this root — see
[ADR-0003](docs/adr/0003-per-lineage-session-dirs.md).

## License

MIT
