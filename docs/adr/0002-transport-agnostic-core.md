# Transport-agnostic core (`packages/core` + `OmpBackend`)

Remote browser access to the UI is a stated future goal but not planned work.
We therefore split the repo so all OMP-facing logic (PTY via node-pty, rpc-ui
frame codec, session scanning) lives in **`packages/core`** — plain Node with
zero Electron imports — and the renderer talks only to a typed **`OmpBackend`**
interface (request/response + event subscription), never to `ipcRenderer`
directly. Today's transport is Electron IPC; a future `packages/server`
implements the same interface over WebSocket and serves the same renderer
build to a browser.

## Considered Options

- **Backend logic in Electron main, extract later (rejected)** — simpler on
  day one, but "extract later" against code that imports Electron throughout
  is a rewrite, not an extraction; the boundary would also be shaped by IPC
  habits rather than by what a network transport needs.
- **Design the server now (rejected)** — auth/TLS, multi-client semantics, and
  session ownership are unknowns; building them now would be guesswork. Only
  the seam is designed, not the server.

## Consequences

- `packages/core` must never import Electron or any transport; code review
  enforces this (a lint rule on imports is a cheap backstop).
- Throughput optimizations (PTY output coalescing, frame batching) belong in
  core so both transports benefit.
- The `OmpBackend` interface is the *only* contract a future server must
  reproduce — changes to it are effectively API changes and should be treated
  as such.
