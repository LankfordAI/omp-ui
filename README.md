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
│ mode chips   │  markdown · tool cards      (PTY TUI)  │  Session    │
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
every keybinding, theme, and skill works. Build in ~2 weeks.

**Files:** `docs/phase-1-pty-embed.md`

### Phase 2: RPC-UI Native Render
`--mode=rpc-ui` is OMP's headless JSON protocol over stdin/stdout. The main
pane renders the `AgentSessionEvent` stream as native components: markdown
assistant text, per-tool cards with live partial output, line-numbered diffs,
advisor cards by severity, and a usage receipt per turn. The session HUD and
inspector rail expose the command surface — model and thinking level, steering
/ follow-up / interrupt modes, compaction, auto-retry, branch, export, todos,
subagents, bash, and all 49 slash commands through a fuzzy palette.

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
