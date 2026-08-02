# Phase 1: PTY Embed (Electron + node-pty + xterm.js)

> Session-format and CLI claims verified against `@oh-my-pi/pi-coding-agent`
> **v17.1.8** (`src/session/session-paths.ts`, `session-listing.ts`,
> `session-entries.ts`, `session-loader.ts`) and a live install; see
> `docs/session-encoding.md` for the full format reference. Electron snippets
> target **Electron 43** (contextIsolation + sandboxed preload); PTY snippets
> use **node-pty 1.1** with `encoding: null` (raw Buffers); terminal packages
> are the current `@xterm/*` scoped ones (v6); scaffold uses **electron-vite 5**.

## Goal

Embed the full OMP TUI inside an Electron window with a project sidebar.
The OMP TUI runs unmodified — every keybinding, theme, skill, and advisor note
renders through xterm.js. This is literally "terminal-in-a-window" with session
management on top.

Why Electron and not a system-webview shell: Phase 1 *is* a terminal emulator,
and xterm.js performance/fidelity depend entirely on the webview. Electron
ships one Chromium everywhere — identical WebGL renderer path and text metrics
on Linux, macOS, and Windows. A system webview (WebKitGTK on Linux) makes the
WebGL renderer unreliable and glyph widths engine-dependent.

## Session Management

### Session storage location

OMP stores sessions under **`~/.omp/agent/sessions/`** by default (note the
`agent/` level). The root moves with `PI_CONFIG_DIR`, `PI_CODING_AGENT_DIR`,
`OMP_PROFILE`/`PI_PROFILE`, and on Linux `XDG_DATA_HOME`
(`$XDG_DATA_HOME/omp/sessions`). The CLI flag `--session-dir <path>` pins it —
pass it to every spawned `omp` and scan exactly that directory. See
`docs/session-encoding.md` for the full resolution order.

Each subdirectory corresponds to a project (working directory). Each `.jsonl`
file is a session, with an optional sibling artifacts directory of the same
name minus `.jsonl` holding advisor (`__advisor[.<slug>].jsonl`) and named
subagent (`<agentId>.jsonl`) transcripts.

### Strategy: Read session files (primary)

A v3 session file opens with an **optional** fixed-width title slot (256
bytes), then the header — slotless files have the header on line 1:

```
{"type":"title","v":1,"title":...,"pad":...}        ← optional, exactly 256 bytes incl. newline
{"type":"session","version":3,"id":...,"cwd":...}  ← the header
```

**Read the header, not the directory name — and never assume a fixed line or
byte offset.** Scan the first lines for the one with `"type":"session"`.

The sidebar does **not** walk the whole sessions root. omp-ui tracks only
**owned sessions** — sessions it launched itself, recorded in omp-ui's own
registry at spawn time (see `CONTEXT.md`). Population:

1. At spawn, record the launch (cwd, timestamp) in omp-ui's registry; the
   session id is learned moments later (attribution below).
2. Sidebar entries = registered projects → their owned sessions, hydrated
   from the `.jsonl` files: `title` from the header/title-slot, `status`
   from the tail (4 KiB prefix + 32 KiB tail, like OMP's own scanner),
   mtime for sorting.
3. Sessions from terminal `omp` use are never shown — even for registered
   projects.

**Attribution facts** (verified v17.1.8) — omp picks the session UUID, and:

- **Lazy materialization**: a session with no durable output lives only in
  memory (`session-manager.ts:1599`) — a launched session may have no
  `.jsonl` for minutes, or ever. Registry entries must be valid with
  `sessionId: null`; tab focus/dedupe keys on the **tab/process**, not the
  session id, pre-materialization.
- **In-process switching**: `/new` and `/branch` replace the session file of
  the *same* process (`createBranchedSession` reassigns `#sessionFile` and
  `#sessionId`). One tab produces a *sequence* of session ids over its
  lifetime.

**Ownership architecture (decided — [ADR-0003](adr/0003-per-lineage-session-dirs.md))**:
each launched session lineage gets its own `--session-dir`: a **direct child
of OMP's default sessions root**, named `omp-ui--<project-slug>--<lineage-id>/`.
Every file in such a dir is UI-launched by construction — `/new` sequences and
`/branch` forks included (omp writes both in-process to the manager's session
dir) — so attribution needs no header sniffing, and two live tabs in one
project are never ambiguous. The dir MUST be a direct child of the default
root: `omp gc` computes blob reachability only over the default root +
archive and scans exactly one level deep (`gc-cli.ts:307,339`) — anywhere
else, GC would delete blobs UI sessions reference. The same GC **relocates
and gzips** cold sessions into the archive root, so the registry stores
session id + lineage dir *name* and re-resolves the file on every hydrate
(never a cached absolute path); resuming an archived lineage unarchives
(gunzip + move back) first. A resumed session keeps its existing lineage dir;
only brand-new sessions mint a fresh one. Registry entries are valid with
`sessionId: null` pre-materialization, and tab focus/dedupe keys on the
tab/process.

The header has **no** `model`, `status`, or `messageCount`: model lives in
later `model_change` entries, and OMP derives status from the file *tail*, not
the header (OMP's own scanner reads a 4 KiB prefix + 32 KiB tail). Treat
directory names as display-only; the header `cwd` is authoritative.

This is encoding-agnostic — it survives OMP upgrades that change the directory
naming scheme.

### Directory encoding (secondary/context only)

For debugging or raw filesystem listing without parsing headers, OMP encodes
the project path into the subdirectory name (`session-paths.ts`). Current
format: `-<home-relative-with-dashes>` under `$HOME` (e.g.
`-Documents-Repos-LankfordAI-omp-ui`), `-tmp[-<relative>]` under the temp
root, and the legacy `--<absolute-with-dashes>--` wrapper everywhere else.

Full rules, examples, and the legacy-format migration (a running sidebar can
observe directories being renamed) are in **`docs/session-encoding.md`**.
Decoding is lossy — never reconstruct a `cwd` from a directory name.

### SessionInfo fields (from `session-listing.ts`)

OMP's own scanner produces:

```ts
interface SessionInfo {
  path: string;           // full path to the .jsonl file
  id: string;             // UUIDv7 — pass as --resume <prefix>
  cwd: string;            // project path (from header; empty for old sessions)
  title?: string;         // session name
  parentSessionPath?: string;  // fork parent
  created: Date;
  modified: Date;
  messageCount: number;
  size: number;           // bytes on disk
  firstMessage: string;
  allMessagesText: string;
  status?: SessionStatus; // complete | interrupted | aborted | error | pending | unknown
}
```

There is **no `model` field** — a sidebar that shows the model must parse
`model_change` entries from the file. `status` requires the tail read
described above, not just the header.

### Launching OMP

**New session in a project:**
```bash
omp --cwd=<project-path>
```

**Resume a session:**
```bash
omp --resume=<session-id-prefix>
```

The `--resume` flag accepts an ID prefix or a path (matching is
case-insensitive against the session UUID, the full basename, or the basename
portion after the last `_` — `session-listing.ts:662`). No picker interaction
needed when the ID is provided.

**With advisor:**
```bash
omp --cwd=<path> --advisor
```

When omp-ui passes it: a per-project toggle in the registry, **default off** —
advisor spend is per-session, and advisor config (WATCHDOG.yml) is
project-scoped, so the toggle is too.

### Live-session dedupe (mandatory)

omp has **no cross-process lock** on session files (verified v17.1.8:
`SessionManager.open` takes no filesystem lock; the "single-writer lock" in
its comments is the in-process persistence chain, and `config/file-lock.ts`
serves config writers, not sessions). Two `omp` processes resuming the same
session would append to the same `.jsonl` concurrently.

Rule: the sidebar tracks which sessions are live (a running `omp` owned by
the app). Clicking a live session **focuses its existing tab** — never
spawn a second process for the same session. `--resume` is only for dormant
sessions.

Enforcement: run omp-ui **single-instance** (`app.requestSingleInstanceLock()`;
on `second-instance`, focus the existing window) and keep the live-session
registry in the one main process. Without this, two omp-ui instances could
each spawn a PTY for the same session and the rule couldn't see across them.

Scope limit: this covers sessions owned by the omp-ui instance. An `omp`
started in a plain terminal outside omp-ui is undetectable (no lock to
check) — accepted as out of scope for v0.

### Tab lifecycle

Closing a tab **hides** it — the `omp` process keeps running and the sidebar
entry stays live; clicking the session resurfaces the tab. Implementation:
keep the xterm.js instance alive but unmounted (per-tab memory is bounded by
xterm's own `scrollback` cap — hundreds of KB — so no main-process output
buffer is needed). A separate **Terminate** action kills the process (confirm
if a turn is running). Quitting the app kills all PTYs **explicitly in
`before-quit`** — do not rely on SIGHUP-on-master-close: ConPTY has no hangup
semantics, and an orphaned `omp` would keep appending to an owned session
after the app exits. Quit also confirms when any live session exists ("3
agents still running — quit?"): Phase 1 can't see turn state through the PTY,
so the confirm is coarse; Phase 2's rpc-ui events can refine it to
turns-in-flight. Sessions remain resumable from the sidebar afterwards.

## Tech Stack

| Layer | Choice | Rationale |
|---|---|---|
| Shell | **Electron 43** | One Chromium everywhere — xterm.js's WebGL renderer and text metrics are identical on all OSes. A system webview (WebKitGTK on Linux) can't guarantee either, and Phase 1 *is* a terminal emulator |
| Process PTY | **node-pty 1.1** (in `packages/core`) | Same PTY layer as VS Code/Hyper/Tabby; `encoding: null` emits raw Buffers. Cost: native C++ module — see the rebuild note below |
| Terminal | **@xterm/xterm 6** + `@xterm/addon-fit` + `@xterm/addon-web-links` + `@xterm/addon-webgl` | WebGL renderer path is reliable under Chromium |
| UI framework | **React** | Decided in grilling; phase-2 component snippets are already TSX |
| State | **Zustand** | Simple, no boilerplate |
| Session parsing | Read JSONL headers in `packages/core` (Node `fs`) | No OMP API dependency |
| Build/scaffold | **electron-vite 5** | One dev/build pipeline for main, preload, and renderer |

## Layout: keep OMP-facing code out of Electron

All PTY, session-scanning, and (Phase 2) rpc-ui code lives in
**`packages/core`** — a plain Node package with **zero Electron imports**.
The Electron main process is a thin wiring layer registering `ipcMain`
handlers against core. This costs one extra package boundary today and pays
off twice: core is unit-testable without Electron, and the future
`packages/server` (remote browser access) wraps core without extraction
surgery. See README → Remote access.

## Implementation Steps

### Step 1: Electron scaffold + workspace
```bash
npm create @quick-start/electron@latest omp-ui -- --template react-ts
cd omp-ui
# Create packages/core as a plain Node workspace package:
npm --workspace packages/core i node-pty
# Renderer terminal deps:
npm i @xterm/xterm @xterm/addon-fit @xterm/addon-web-links @xterm/addon-webgl
```

### Step 2: PTY spawn (packages/core)
node-pty 1.1 API: `pty.spawn(file, args, opts)` returns an `IPty` with
`onData` / `onExit` / `write` / `resize` / `kill`. Spawn `omp` with
**`encoding: null`** so `onData` emits raw `Buffer`s instead of decoded
strings (on Windows node-pty emits Buffers regardless of this setting):

```ts
// packages/core/src/pty.ts
import * as pty from "node-pty";

export interface PtyHandle {
  readonly id: string;
  onData(cb: (data: Buffer) => void): void;
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  kill(): void;
}

export function spawnOmp(opts: {
  id: string;
  cwd: string;
  lineageDir: string;       // ADR-0003 — minted for new sessions, reused on resume
  resumeSessionId?: string; // set when resuming a dormant session
  cols: number;
  rows: number;
  advisor?: boolean;
}): PtyHandle {
  const args = ["--cwd", opts.cwd, "--session-dir", opts.lineageDir];
  if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`);
  if (opts.advisor) args.push("--advisor");

  const proc = pty.spawn("omp", args, {
    name: "xterm-256color",
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: process.env,
    encoding: null, // raw Buffers, not decoded strings
  });

  return {
    id: opts.id,
    // node-pty's typings declare `onData: IEvent<string>` even with
    // `encoding: null` — cast to IEvent<Buffer> (known typing gap; harmless
    // if the types are ever fixed).
    onData: (cb) => (proc.onData as pty.IEvent<Buffer>)(cb),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: () => proc.kill(),
  };
}
```

(Windows: node-pty 1.x selects ConPTY automatically on Windows 10+; no flag
needed.)

### Step 3: Stream output to the renderer — as bytes

Forward PTY output as **bytes**, not decoded strings: a read can split a
multi-byte UTF-8 sequence, and decoding each chunk independently silently
corrupts it. That is exactly what `encoding: null` buys — `onData` hands you
`Buffer`s, and xterm.js accepts `Uint8Array` and buffers partial sequences
itself. `Buffer` is a `Uint8Array` subclass and crosses Electron IPC intact
(IPC arguments are structured-cloned; typed arrays are supported), so there is
no JSON-array or base64 tax.

The Electron main process is only a wiring layer over `packages/core`:

```ts
// packages/desktop/src/main/index.ts
import { ipcMain } from "electron";
import { spawnOmp, type PtyHandle } from "@omp-ui/core";

const ptys = new Map<string, PtyHandle>();

ipcMain.handle("pty:spawn", (event, opts) => {
  const handle = spawnOmp(opts);
  ptys.set(opts.id, handle);
  handle.onData((data) => event.sender.send("pty:data", opts.id, data));
  handle.onExit(({ exitCode }) => {
    ptys.delete(opts.id);
    event.sender.send("pty:exit", opts.id, exitCode);
  });
});
```

An `onExit` firing means the `omp` process is gone — remove its tab from the
sidebar (the equivalent of reaping the child handle).

Preload — `contextIsolation` on, and never expose `ipcRenderer` itself: wrap
callbacks so the event object can't leak into the renderer:

```ts
// packages/desktop/src/preload/index.ts
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("omp", {
  ptySpawn: (opts: unknown) => ipcRenderer.invoke("pty:spawn", opts),
  ptyWrite: (id: string, data: string) => ipcRenderer.send("pty:write", id, data),
  ptyResize: (id: string, cols: number, rows: number) =>
    ipcRenderer.send("pty:resize", id, cols, rows),
  onPtyData: (cb: (id: string, data: Uint8Array) => void) =>
    ipcRenderer.on("pty:data", (_e, id, data) => cb(id, data)),
  onPtyExit: (cb: (id: string, code: number) => void) =>
    ipcRenderer.on("pty:exit", (_e, id, code) => cb(id, code)),
});
```

BrowserWindow settings: `webPreferences: { preload, contextIsolation: true,
nodeIntegration: false, sandbox: true }`.

```ts
// renderer
import { Terminal } from "@xterm/xterm";

const term = new Terminal();
term.open(document.getElementById("terminal")!);

window.omp.onPtyData((_id, data) => term.write(data)); // Uint8Array straight in
```

### Throughput: coalesce before the transport

A redrawing TUI emits output in bursts of small chunks; forwarding each as its
own IPC message wastes most of the cost on per-message overhead (structured
clone + contextBridge hop). Coalesce in **`packages/core`** — not the Electron
layer — so the future WebSocket transport inherits the same batching:

```ts
// packages/core/src/pty-batch.ts
export function batched(handle: PtyHandle, windowMs = 5): PtyHandle {
  return {
    ...handle,
    onData: (cb) => {
      let pending: Buffer[] = [];
      let timer: NodeJS.Timeout | undefined;
      handle.onData((chunk) => {
        pending.push(chunk);
        timer ??= setTimeout(() => {
          timer = undefined;
          cb(pending.length === 1 ? pending[0] : Buffer.concat(pending));
          pending = [];
        }, windowMs);
      });
    },
  };
}
```

5 ms is far below frame latency, and xterm.js already queues writes internally
— the renderer (`term.write(data)`) doesn't change. This is the same
coalescing VS Code's terminal does. If the consumer still falls behind,
`handleFlowControl: true` (with `flowControlPause` / `flowControlResume`)
makes node-pty apply XON/XOFF backpressure toward `omp` instead of buffering
unboundedly. v0 can ship without this wrapper — it's a drop-in optimization in
core, no timeline impact.

### Step 4: Input handling

```ts
// renderer
term.onData((data) => window.omp.ptyWrite(id, data));
```

```ts
// main
ipcMain.on("pty:write", (_e, id: string, data: string) =>
  ptys.get(id)?.write(data),
);
```

### Step 5: Session sidebar (packages/core)
The sidebar is **registry-driven**, not a filesystem walk: omp-ui's own state
maps each registered project to the sessions it launched there. Hydrate each
owned session from its `.jsonl` (header/title-slot for `title`, tail for
`status`) and watch the file for changes (title-slot rewrites); watch for
external deletion too (mark the entry missing).

Every session row carries a delete affordance (`session:delete`): it drops the
registry record **and** removes the lineage dir from both the active and archive
roots — transcript plus artifacts, since one record owns one lineage dir
(ADR-0003). Files go first, so a failed delete leaves the row visible and
retryable instead of orphaning the transcript. A live session is stopped as
part of the delete (graceful signal, then SIGKILL); if the process cannot be
reaped, the files are left alone and the delete fails.

```ts
// packages/core/src/sessions.ts
export interface OwnedSessionRecord {
  sessionId: string | null; // UUIDv7 — null until the session materializes
  lineageDir: string;       // dir NAME under the sessions root (ADR-0003), not a path
  projectCwd: string;       // launch cwd — the registered project
  launchedAt: string;       // ISO
  // display metadata (title, last-known mtime) cached for archived entries
}

export async function hydrateSession(rec: OwnedSessionRecord): Promise<SessionSummary> {
  // Re-resolve on every hydrate: <sessionsRoot>/<lineageDir> first, then the
  // archive root — `omp gc` relocates AND gzips cold sessions, so a cached
  // absolute path dangles. Never store filePath in the registry.
  // header/title-slot → title; 4 KiB prefix + 32 KiB tail → status
  // (same read shape as OMP's own scanner in session-listing.ts)
}
```

The scanner reads headers exactly as described above — only the *selection*
of files changes (registry, not walk).

### Step 6: Resize handling
Forward terminal resize to the PTY so `omp` gets `SIGWINCH`:

```ts
// renderer
window.addEventListener("resize", () => {
  fitAddon.fit(); // recalculates term.cols/rows first
  window.omp.ptyResize(id, term.cols, term.rows);
});
```

```ts
// main
ipcMain.on("pty:resize", (_e, id: string, cols: number, rows: number) =>
  ptys.get(id)?.resize(cols, rows),
);
```

### Step 7: Renderer transport boundary (`OmpBackend`)

Don't scatter `window.omp` through components. Define one interface; the
Electron implementation wraps the preload bridge, and a future WebSocket
implementation (remote browser access, see README) swaps in without touching
a component:

```ts
export interface OmpBackend {
  listSessions(): Promise<ProjectGroup[]>;
  ptySpawn(opts: SpawnOpts): Promise<void>;
  ptyWrite(id: string, data: string): void;
  ptyResize(id: string, cols: number, rows: number): void;
  onPtyData(cb: (id: string, data: Uint8Array) => void): void;
  onPtyExit(cb: (id: string, exitCode: number) => void): void;
}
```

## Native module caveat (the one real cost)

node-pty is a C++ module. v1.1 ships prebuilds (its loader searches
`prebuilds/<platform>-<arch>`), but the binary must match **Electron's** Node
ABI — after every Electron major bump, run:

```bash
npx @electron/rebuild   # v4.x, formerly electron-rebuild
```

Keep `node-pty` out of the main-process bundle (electron-vite externalizes
native deps automatically). If a platform lacks a matching prebuild,
`@electron/rebuild` compiles from source — that needs a C++ toolchain on the
build machine, not on users' machines.

## What You Get For Free

- **Full OMP TUI** — themes, skills, slash commands, keybindings
- **Advisor notes** — rendered through OMP's own `<advisory>` system in the TUI
- **Advisor cost** — status line shows `$2.67 (sub) + $0.41 (adv)`
- **Per-advisor config** — WATCHDOG.yml files work as-is
- **No agent logic reimplementation** — OMP handles everything; you just embed it

## Rough Timeline

Re-costed after the grilling session — the ownership machinery (registry,
per-lineage session dirs, tab lifecycle, confirms) roughly doubles the
original ~1-week sketch:

| Task | Time |
|---|---|
| Scaffold Electron (electron-vite) + core workspace | 1 day |
| PTY spawn + output streaming (incl. coalescing) | 2 days |
| xterm.js terminal widget + keep-alive hidden tabs | 1 day |
| Input handling + resize | 1 day |
| Sessions-root resolution + lineage-dir minting | 1 day |
| Registry: projects CRUD + owned sessions (userData JSON) | 2 days |
| Hydration + sidebar UI (incl. archived entries) | 2 days |
| Tab lifecycle: spawn/resume/hide/terminate, dedupe, confirms | 2 days |
| Single-instance lock + before-quit cleanup | 0.5 day |
| Resume flow (incl. unarchive) | 1 day |
| electron-builder Linux packaging (local builds; CI matrix deferred) | 0.5 day |
| **Total** | **~2 weeks** (for basic working v0) |
