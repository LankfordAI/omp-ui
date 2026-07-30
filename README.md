# omp-ui

A cross-platform desktop GUI for [Oh My Pi](https://github.com/can1357/oh-my-pi) — the `omp` coding agent.

**Project sidebar on the left. Embedded OMP TUI in the main pane.** Jump between
repos without managing a fleet of terminal windows. Full advisor integration,
session management, and optional native rendering via `--mode=rpc-ui`.

Think **T3 Code, but for Oh My Pi**: a launcher and session manager for `omp`,
not a browser of your `~/.omp` history — the sidebar tracks only sessions
omp-ui launched itself (see `CONTEXT.md`).

Built on **Electron** — a uniform Chromium webview on every platform, so the
xterm.js terminal renders and performs identically everywhere. Rationale and
rejected alternatives: [ADR-0001](docs/adr/0001-electron-over-tauri.md).

## Architecture (three phases)

```
┌────────────────────────────────────────────────────────────┐
│  omp-ui desktop (Electron — packages/desktop)              │
│  ┌──────────┐  ┌────────────────────────────────────────┐  │
│  │ Sidebar  │  │  Main pane                             │  │
│  │ Projects │  │  ┌──────────────────────────────────┐  │  │
│  │ Sessions │  │  │  xterm.js terminal               │  │  │
│  │          │  │  │  (Phase 1: PTY-embedded OMP TUI) │  │  │
│  └──────────┘  │  └──────────────────────────────────┘  │  │
│                │                                        │  │
│                │  ┌──────────────────────────────────┐  │  │
│                │  │  Native transcript (Phase 2)     │  │  │
│                │  │  (--mode=rpc-ui JSON protocol)   │  │  │
│                │  └──────────────────────────────────┘  │  │
│                └────────────────────────────────────────┘  │
└───────────────────────┬────────────────────────────────────┘
                        │ Electron IPC (OmpBackend interface)
┌───────────────────────▼────────────────────────────────────┐
│  packages/core — plain Node, zero Electron imports         │
│  PTY manager (node-pty) · rpc-ui client · session scanner  │
└───────────────────────┬────────────────────────────────────┘
                        ▼  node-pty / child_process
              omp --cwd=<project>   omp --resume=<session-id>
```

### Phase 1: PTY Embed
Spawn `omp` under a [node-pty](https://github.com/microsoft/node-pty) PTY (the
same PTY layer VS Code, Hyper, and Tabby use). Raw PTY bytes stream via
Electron IPC into `xterm.js` in the renderer. OMP's TUI runs unmodified —
every keybinding, theme, and skill works. Build in ~2 weeks.

**Files:** `docs/phase-1-pty-embed.md`

### Phase 2: RPC-UI Native Render
Switch the main pane to `--mode=rpc-ui` — OMP's headless JSON protocol over
stdin/stdout. Same project sidebar, but the main pane renders
`<advisory>` blocks, diffs, and todos as native components instead of terminal text.
Build in ~1.5–2 weeks.

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
└── server/    # FUTURE — thin WebSocket/HTTP wrapper around packages/core
               # for remote browser access. See below.
```

## Remote access (future goal)

Accessing this UI from a browser on another machine is **not planned for now**,
but it is a standing design constraint baked in from day one: all OMP-facing
logic lives in a transport-agnostic `packages/core`, and the renderer talks
only to a typed `OmpBackend` interface (Electron IPC today, WebSocket later).
Rationale and consequences: [ADR-0002](docs/adr/0002-transport-agnostic-core.md).

## Distribution

v0 is **Linux-only local builds** via electron-builder (the dev machine is
Fedora); the CI matrix and auto-update are deferred. The stack stays
cross-platform — uniform Chromium is why Electron was chosen (ADR-0001) —
so widening later is a packaging task, not a port.

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
