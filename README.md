# omp-ui

A cross-platform desktop GUI for [Oh My Pi](https://github.com/can1357/oh-my-pi) — the `omp` coding agent.

**Project sidebar on the left. Embedded OMP TUI in the main pane.** Jump between
repos without managing a fleet of terminal windows. Full advisor integration,
session management, and optional native rendering via `--mode=rpc-ui`.

## Architecture (three phases)

```
┌──────────────────────────────────────────────────────────┐
│  omp-ui (Tauri desktop app)                             │
│  ┌──────────┐  ┌──────────────────────────────────────┐ │
│  │ Sidebar  │  │  Main pane                            │ │
│  │ Projects │  │  ┌──────────────────────────────────┐ │ │
│  │ Sessions │  │  │  xterm.js terminal               │ │ │
│  │          │  │  │  (Phase 1: PTY-embedded OMP TUI) │ │ │
│  └──────────┘  │  └──────────────────────────────────┘ │ │
│                │                                      │ │
│                │  ┌──────────────────────────────────┐ │ │
│                │  │  Native transcript (Phase 2)    │ │ │
│                │  │  (--mode=rpc-ui JSON protocol)   │ │ │
│                │  └──────────────────────────────────┘ │ │
│                └──────────────────────────────────────┘ │
└──────────────────────────────────────────────────────────┘
         │
         ▼  portable-pty (Rust)
   omp --cwd=<project>   omp --resume=<session-id>
```

### Phase 1: PTY Embed
Spawn `omp` under a [portable-pty](https://github.com/wez/portable-pty) (Rust crate
from the wezterm project) PTY. The PTY master streams output via Tauri events into
`xterm.js` in the frontend. OMP's TUI runs unmodified — every keybinding, theme,
and skill works. Build in ~1–2 weeks.

**Files:** `docs/phase-1-pty-embed.md`

### Phase 2: RPC-UI Native Render
Switch the main pane to `--mode=rpc-ui` — OMP's headless JSON protocol over
stdin/stdout. Same project sidebar, but the main pane renders
`<advisory>` blocks, diffs, and todos as native components instead of terminal text.
Build in ~2 weeks.

**Files:** `docs/phase-2-rpc-ui.md`

### Phase 3: ACP Integration
OMP already serves the [Agent Client Protocol](https://spec.acp.arthurpals.dev)
via `omp acp`. Zed and other ACP clients can drive OMP today. This phase documents
the integration and optionally builds a thin ACP client wrapper.

**Files:** `docs/phase-3-acp.md`

## Session Storage

OMP stores sessions under `~/.omp/sessions/` with a per-project subdirectory.
See `docs/phase-1-pty-embed.md#session-encoding` for the exact encoding rules.

## License

MIT
