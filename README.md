# omp-ui

A cross-platform desktop GUI for [Oh My Pi](https://github.com/can1357/oh-my-pi) — the `omp` coding agent.

**Project sidebar on the left. A terminal tab or a native transcript in the
main pane.** Jump between projects without managing a fleet of terminal
windows. Full advisor integration, session management, plan mode, remote
access, and a native rendering mode over `--mode=rpc-ui`.

Think **T3 Code, but for Oh My Pi**: a launcher and session manager for `omp`,
not a browser of your `~/.omp` history — the sidebar tracks only sessions
omp-ui launched itself (see `CONTEXT.md`).

Built on **Electron** — a uniform Chromium webview on every platform, so the
xterm.js terminal renders and performs identically everywhere. Rationale and
rejected alternatives: [ADR-0001](docs/adr/0001-electron-over-tauri.md).

## Features

- **Two tab modes.** Every session runs as a **terminal tab** — omp's TUI
  unmodified under a PTY, every keybinding, theme, and skill intact — or a
  **native transcript tab** rendering the rpc-ui event stream as markdown
  with inline and display LaTeX math, tool cards, diffs, and advisor cards.
  Switching modes restarts the session in place; the default mode is a
  setting.
- **Session HUD.** Liveness, click-to-rename title, context meter, spend, and
  the session controls: compact, auto-compact, export, branch, new, refresh,
  steering / follow-up / interrupt queue modes.
- **Composer.** Model and thinking-level pickers, a session-scoped advisor
  with its own model picker
  ([ADR-0005](docs/adr/0005-session-scoped-advisor-via-config-overlay.md)),
  pasted image attachments, and `@`-mentions of project files. The branch
  control reports configured-upstream divergence for the project and offers
  guarded fast-forward pulls. The five composer parameters are remembered per
  project and seed the next session; where a project has none, a Settings
  default decides whether the advisor is on.
- **Plan mode and plan review.** Read-only planning driven by a generated
  extension ([ADR-0007](docs/adr/0007-plan-mode-via-generated-extension.md)),
  gated on your verdict: execute into the same session, a compacted session,
  or a fresh one seeded with the plan — or send it back with revision notes.
  Implementation always begins in Build mode, whatever the default agent mode says.
  Plans are authored and reviewed as one self-contained HTML document by
  default (Settings → General switches to markdown); that single file is the
  spec the implementer receives.
- **Inspector rail.** Todos, Agents, Session, Plans, and branch Diffs panes
  behind an icon strip — one pane at a time, badge counts on the strip.
  Clicking an agent opens its full read-only transcript — tool calls,
  thinking, bash output — in the main pane, with a banner and a path back
  to the main agent.
- **Command palette.** `Ctrl/⌘+K` searches every session, project, tab
  action, and slash command.
- **Themes.** Curated token sets that re-skin the UI, the terminal, and
  syntax highlighting at once; the signal accent stays reserved for agent
  liveness ([ADR-0004](docs/adr/0004-design-tokens-and-primitives.md)).
- **Managed omp binary.** omp-ui installs and updates its own copy of the
  `omp` CLI — nothing to install first. Running sessions keep their binary;
  new sessions pick up the update.
- **Per-project MCP servers.** Inspect and toggle a project's MCP servers
  from the session HUD or the palette.
- **Remote access and provider keys.** An optional, token-authenticated
  browser/phone mirror of your live sessions, and OS-keyring API keys
  supplied to every spawn. Both detailed below.

## Install

Linux AppImage is the canonical supported release. Install it with:

```bash
curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash
```

It verifies the download against `SHA256SUMS.txt`, installs the AppImage to
`~/.local/bin`, and registers a desktop entry; `install.sh --uninstall`
removes it. Or grab the AppImage straight from
[GitHub Releases](https://github.com/LankfordAI/omp-ui/releases). The Windows
x64 build is an unsigned preview and the macOS builds are signed previews,
both documented under
[Unsigned Windows x64 preview](#unsigned-windows-x64-preview) and
[macOS preview](#macos-preview). The supported Linux path remains
AppImage-only ([ADR-0011](docs/adr/0011-appimage-only-linux-distribution.md)).

## How it works

```
┌──────────────┬────────────────────────────────────────┬─────────────┐
│ Sidebar      │ TabBar                                 │             │
│              ├────────────────────────────────────────┤  Inspector  │
│ Projects     │ Session HUD    liveness · context ·    │    Rail     │
│ Sessions     │                spend · controls        │             │
│              ├────────────────────────────────────────┤  Todos      │
│ filter       │                                        │  Agents     │
│ live dots    │  Transcript (rpc-ui)   or   xterm.js   │  Session    │
│ new session +│  markdown · tool cards      (PTY TUI)  │  Plans      │
│              │  diffs · advisories                    │  Diffs      │
│ collapses    ├────────────────────────────────────────┤  collapses  │
│ to icons     │ Composer   model · advisor · /commands │  to icons   │
└──────────────┴────────────────────────────────────────┴─────────────┘
         Electron IPC (OmpBackend interface) │
┌────────────────────────────────────────────▼────────────────────────┐
│  packages/core — plain Node, zero Electron imports                  │
│  PTY manager (node-pty) · rpc-ui client/codec · session scanner     │
└────────────────────────────────────────────┬────────────────────────┘
                                             ▼  node-pty / child_process
                        omp --cwd=<project>   omp --resume=<session-id>
```

The app is single-instance. The renderer talks only to a typed `OmpBackend`
interface — Electron IPC locally, WebSocket remotely — and all OMP-facing
logic lives in the transport-agnostic `packages/core`
([ADR-0002](docs/adr/0002-transport-agnostic-core.md)). Owned sessions get
per-lineage pinned session dirs under `~/.omp/agent/sessions/`
([ADR-0003](docs/adr/0003-per-lineage-session-dirs.md)).

### Terminal tabs (PTY)

`omp` spawns under a [node-pty](https://github.com/microsoft/node-pty) PTY —
the same PTY layer VS Code, Hyper, and Tabby use. Raw PTY bytes stream over
Electron IPC into `xterm.js` in the renderer, so OMP's TUI runs unmodified.
Pasting an image is bridged to the TUI's own bracketed-paste path
([ADR-0006](docs/adr/0006-image-paste-in-both-modes.md)), since a PTY carries
no byte channel. Design doc: `docs/phase-1-pty-embed.md`.

### Native transcript tabs (rpc-ui)

`--mode=rpc-ui` is OMP's headless JSON protocol over stdin/stdout. The main
pane renders the `AgentSessionEvent` stream as native components: markdown
assistant text with inline and display LaTeX math (rendered locally by
KaTeX), a usage receipt per turn, per-tool cards with live partial output,
line-numbered diffs, and advisor cards by severity. New sessions auto-title
from the first substantive prompt via omp's own small model. Design doc:
`docs/phase-2-rpc-ui.md`.

### ACP

OMP itself serves the [Agent Client Protocol](https://agentclientprotocol.com)
via `omp acp` — Zed lists Pi Coding Agent in its ACP Registry today. omp-ui
deliberately does not wrap ACP; the integration notes live in
`docs/phase-3-acp.md`. Design decisions: `docs/adr/`.

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

## Development

Requires Node 22+.

```bash
npm install
npm run dev        # electron-vite dev --watch, hot-reloads on change
npm test           # vitest across workspaces
npm run typecheck  # tsc across workspaces
npm run lint       # eslint
npm run package    # build + electron-builder → AppImage
```

House rules live in `AGENTS.md`; the domain vocabulary (session, lineage,
owned session, inspector rail, …) is defined in `CONTEXT.md` — use it in
code, commits, and issues. `packages/core` must stay free of Electron
imports (ADR-0002).

## Remote access

**Settings → Remote access** turns on an embedded HTTP + WebSocket server that
serves the same renderer to a browser and mirrors the one live `MainBackend` —
remote clients are extra views of the same sessions, not a second owner. It is
**off by default**, and a connected client can do everything the local user can.

- **Bind address.** `localhost` (default) listens on `127.0.0.1` only. `local
  network` listens on `0.0.0.0` so a phone or second machine can reach it — an
  explicit, warned choice, over plain HTTP with no encryption.
- **Sign-in password (primary).** Set under Settings → Remote access. Stored as a
  salted scrypt hash in the registry — never plaintext, never recoverable.
  Unauthenticated browsers are redirected to a `/login` page; a correct password
  sets an HttpOnly session cookie. Wrong attempts are rate-limited per IP: after
  5 failures the address is locked out with exponential backoff (60 s doubling,
  capped at 15 min). While a password is set, the primary pairing URL and QR no
  longer contain the token.
- **Access token (fallback).** The auto-minted 32-byte bearer token stays valid
  alongside the password: pairing URLs with `?t=`, the QR code, and
  `Authorization: Bearer` all keep working. Regenerating the token revokes every
  token link; changing or clearing the password revokes every password session.
- **Port.** Default `4677`; any whole number in 1024–65535.
- **Build requirement.** The browser bundle is a separate Vite build. Run
  `npm run build:web --workspace @omp-ui/desktop` (it is part of `npm run
  build`); without it the server answers `503` with that hint and the settings
  page says the bundle is missing.

The transport remains plain HTTP: both the password and the token travel
unencrypted on the wire, so LAN binding stays an explicit, warned choice.

Because the server lives inside the Electron main process, there is no remote
access while the desktop app is closed — the point is controlling *this app's*
live sessions. Installability and offline support are secure-context-only, so a
`http://<lan-ip>` origin gets a responsive web app but no install prompt until
you front it with your own HTTPS.

The seam this rides on is a standing design constraint: all OMP-facing logic
lives in a transport-agnostic `packages/core`, and the renderer talks only to a
typed `OmpBackend` interface (Electron IPC locally, WebSocket remotely).
Rationale and consequences: [ADR-0002](docs/adr/0002-transport-agnostic-core.md).

## Provider keys

omp reads API credentials from environment variables, and a desktop launch (a
`.desktop` entry, an AppImage, a dock icon) inherits the session manager's
environment — never your `~/.zshrc`. Left alone, omp starts with no credentials
and its model catalog collapses to whatever needs no auth, which looks exactly
like "my provider disappeared".

**Settings → Providers** fixes that from either end:

- **Nothing to do in the common case.** At launch omp-ui asks your login shell
  which provider variables it exports and adopts them, so keys already in your
  shell profile just work.
- **Or paste a key.** Each provider row takes its credential directly, stored
  encrypted by your OS credential store (`gnome_libsecret`/`kwallet`). Where no
  keyring exists the write is refused rather than writing a decodable secret to
  disk. Keys never come back over IPC — the page shows a masked tail and where
  the value came from.
- **A project `.env` is shown but left alone**, because omp loads `.env` and
  `.env.local` itself.

Keys bind when omp starts, so a new key applies to the next session spawn.
Rationale and threat model:
[ADR-0010](docs/adr/0010-provider-credentials-supplied-to-every-spawn.md).

## Distribution

Pushing a `v*` tag runs `.github/workflows/release.yml`. Every release includes
the supported Linux **AppImage**, one unsigned Windows x64 preview installer,
and signed, notarized `arm64`/`x64` macOS preview DMGs and ZIPs: six
distributables in total. Linux publishes `latest-linux.yml`; Windows publishes
`latest.yml` and the installer blockmap for background staging. Signed macOS
previews publish `latest-mac.yml`, feeding in-place self-updates on both
architectures. One combined `SHA256SUMS.txt` covers the AppImage, Windows
installer, and all four macOS files and remains compatible with
`packaging/install.sh`, which selects only the AppImage's matching line.

The AppImage remains the sole first-party supported Linux artifact
([ADR-0011](docs/adr/0011-appimage-only-linux-distribution.md)); the earlier
deb, rpm, and Flatpak packages were dropped after v0.4.0. Installs from those
packages migrate with the canonical installer:
`curl -fsSL https://raw.githubusercontent.com/LankfordAI/omp-ui/main/packaging/install.sh | bash`.

The installed app **checks for newer releases** in the background at launch,
and on demand via the command palette's "Check for updates". A newer stable
release surfaces as a small non-modal **update card** in the lower-right
corner: installed/available versions, the update action, release notes, and
"Later" — which is remembered per release version. Offline, rate-limited, and
no-update checks stay silent, and dev/unversioned builds never check. The
launch check is optional: the settings surface's Updates page turns it off for
omp-ui independently of the omp binary, and the command-palette check still
runs on demand. Background checks quietly stage auto-updatable packages; the
update card appears only after verification. A restart or install-on-quit
choice is always explicit, and both pass through the live-session quit guard.

What the update action does depends on how the app was installed:

- **AppImage, Windows NSIS, and macOS** — in-place update via
  `electron-updater` (sha512/blockmap verified against platform update
  metadata; on macOS the staged ZIP applies through Squirrel.Mac). When the
  download finishes the card offers "Restart now" and "Install when I quit";
  restarting still passes the live-session quit guard.
- **Legacy deb / rpm / Flatpak installs** (v0.4.0 and earlier) — no
  same-format assets are published anymore, so the card's download path fails
  closed (`expected asset missing from release`). Migrate once with
  `packaging/install.sh`; updates are the in-place AppImage flow after that.

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

### Unsigned Windows x64 preview

Each [GitHub release](https://github.com/LankfordAI/omp-ui/releases/latest)
includes an unsigned per-user NSIS preview named
`omp-ui-<version>-windows-preview-x64-setup.exe`. GitHub Releases from
`LankfordAI/omp-ui` is the sole trusted download and update source; installers
are not published to npm.

Windows reports **Unknown publisher** because this preview has no trusted
Authenticode certificate. To continue, use Windows' supported **More info →
Run anyway** flow after checking the download against `SHA256SUMS.txt`. Never
disable SmartScreen or Defender globally. The SHA-256 manifest and
`latest.yml`/blockmap protect downloaded bytes against corruption or
substitution, but they do not establish publisher identity.

The assisted installer is x64-only, installs for the current user without
elevation, and allows choosing its installation directory. Application updates
stage in the background and retain the same explicit restart/install-on-quit
choices and live-session quit guard as AppImage. Managed omp installs
`omp-windows-x64.exe` under the user's LOCALAPPDATA tree.

See [ADR-0015](docs/adr/0015-unsigned-windows-nsis-preview.md).

### macOS preview

Each [GitHub release](https://github.com/LankfordAI/omp-ui/releases/latest)
includes unsupported macOS preview builds, Developer ID signed and notarized.
Download the DMG matching your Mac:

- Apple Silicon: `omp-ui-<version>-mac-preview-arm64.dmg`
- Intel: `omp-ui-<version>-mac-preview-x64.dmg`

The matching ZIP is advertised through `latest-mac.yml` and powers in-place
self-updates. [Issue #124](https://github.com/LankfordAI/omp-ui/issues/124)
remains open until the macOS lane is promoted from preview to supported.

If you want belt-and-braces assurance, verify the download before installing.
Download `SHA256SUMS.txt` beside the chosen DMG or ZIP, select that asset's
line, and check it. For example, for the Apple Silicon DMG:

```sh
grep 'omp-ui-.*-mac-preview-arm64\.dmg$' SHA256SUMS.txt | shasum -a 256 -c -
```

Change `arm64` to `x64`, or `.dmg` to `.zip`, for another asset. Running
`shasum -a 256 -c SHA256SUMS.txt` against a directory containing only one
download also prints harmless `No such file` messages for the other four
manifest entries; the selected-line form avoids that noise. Continue only if
the chosen file reports `OK`.

Mount the DMG and copy **omp-ui** to **Applications**. The build is Developer
ID signed and notarized, so macOS opens it directly — no Gatekeeper override
is needed.

Preview limitation: unsupported preview status.

Managed **omp binary** install and updates remain enabled independently. omp-ui
selects `omp-darwin-arm64` on Apple Silicon or `omp-darwin-x64` on Intel.

## Session storage

OMP stores sessions under `~/.omp/agent/sessions/` (default; overridable via
env, XDG, and `--session-dir`) with a per-project subdirectory. See
`docs/session-encoding.md` for the exact encoding rules and file format.
omp-ui does not browse this whole tree — it tracks only the sessions it
launched (its own registry), hydrating titles/status from the files. Launched
sessions live in per-lineage pinned dirs inside this root — see
[ADR-0003](docs/adr/0003-per-lineage-session-dirs.md).

## License

MIT
