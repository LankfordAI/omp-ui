# Electron over Tauri

Phase 1 embeds a terminal emulator (xterm.js), whose performance and rendering
fidelity depend entirely on the webview engine. We chose **Electron** — one
Chromium on every platform — over Tauri, accepting a ~150–300 MB bundle and a
native-module build step in exchange for identical terminal behavior
everywhere.

## Considered Options

- **Tauri (rejected)** — ~10 MB binary and a clean Rust PTY story
  (`portable-pty`), but its Linux webview is WebKitGTK with no Chromium option:
  xterm.js's WebGL renderer is unreliable there (canvas/DOM fallback) and text
  metrics diverge from Chromium. For a cross-platform app whose core
  deliverable *is* a terminal, a per-OS rendering engine is the wrong kind of
  variable. The primary dev machine runs Linux — Tauri's worst-case platform.
- **Electron (chosen)** — uniform Chromium: WebGL renderer path, glyph widths,
  and font stack are identical on Linux/macOS/Windows. Costs: bundle
  size/memory (secondary for a dev tool; VS Code/Hyper/Tabby ship the same
  way) and `node-pty` as a native module needing `@electron/rebuild` per
  Electron major (Phase 1 only; Phase 2's rpc-ui path is pure stdio).

## Consequences

- All OMP-facing code must live in `packages/core` (see ADR-0002), which keeps
  the Electron surface thin enough that this decision could be revisited —
  but the renderer's assumptions (Chromium APIs, xterm.js WebGL) would not
  carry over, so treat the choice as effectively permanent.
