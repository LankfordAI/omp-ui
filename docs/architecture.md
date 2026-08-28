# Architecture

omp-ui is an Electron application with one backend and two renderer transports. The desktop window reaches the backend over Electron IPC. A remote browser reaches the same backend over an authenticated WebSocket. Both renderers use the same React source and the same typed `OmpBackend` interface.

Start at the [Documentation home](README.md). See the [development guide](development.md) for repository workflows, [remote access](remote-access.md) for operating the browser transport, and [settings](settings.md) for user-facing configuration.

## System shape

```mermaid
flowchart LR
  subgraph clients[Renderer clients]
    er[Electron renderer<br/>shared React source]
    wr[Browser renderer<br/>shared React source]
  end

  er --> eb[OmpBackend]
  wr --> wb[OmpBackend]
  eb --> ipc[Sandboxed preload<br/>Electron IPC]
  wb --> ws[Browser WebSocket adapter]
  ipc --> main[MainBackend<br/>Electron main process]
  ws --> server[@omp-ui/server<br/>HTTP, auth, WebSocket]
  server --> main

  main --> sessions[SessionManager]
  sessions --> core[@omp-ui/core]
  core --> pty[node-pty<br/>omp TUI]
  core --> rpc[stdio pipes<br/>omp --mode=rpc-ui]
```

The browser path does not create a second application backend. `@omp-ui/server` accepts a `RemoteHost`, dispatches requests and notifications to `MainBackend.handlers()`, and mirrors backend events from `MainBackend.addSink()`. Session ownership, the registry, child processes, and updates remain in the Electron main process.

## Package responsibilities

| Package | Owns | Does not own |
|---|---|---|
| [`@omp-ui/core`](../packages/core/src/index.ts) | Transport-independent Node logic: shared types and channel declarations, registry persistence, OMP path and session-file resolution, archive handling, worktrees, provider and settings logic, memory access, PTY spawning and batching, and the rpc-ui client and frame codec. | Electron windows, IPC, WebSockets, renderer state, or application update orchestration. |
| [`@omp-ui/desktop`](../packages/desktop/src/) | The Electron lifecycle, secure window and preload setup, `MainBackend`, the sole `SessionManager`, renderer and web builds, OS credential encryption, window and shell integration, remote-server lifecycle, and app and OMP update state. | A second transport-specific business interface. Both IPC and WebSocket use the core channel table. |
| [`@omp-ui/server`](../packages/server/src/index.ts) | Static delivery of the browser bundle, token or password authentication, WebSocket request routing, event fan-out, and binary framing for PTY and shell bytes. | Electron, the registry, sessions, OMP processes, or a standalone backend. It requires a `RemoteHost` supplied by desktop main. |

`@omp-ui/core` is transport-agnostic, not browser-safe as a whole. It uses Node APIs and `node-pty`. The renderer imports only dependency-free subpaths such as `@omp-ui/core/types`, `@omp-ui/core/plan`, and `@omp-ui/core/advisor-stats`.

## Renderer and backend seam

[`BACKEND_CHANNELS`](../packages/core/src/backend-channels.ts) declares each capability once. The channel name, arguments, result, generated `OmpBackend` client, and `ChannelTable` handler shape all derive from that declaration. [`MainBackend.handlers()`](../packages/desktop/src/main/backend.ts) implements the request and notification sides once for both transports.

| Channel kind | Direction | Contract | Examples |
|---|---|---|---|
| Request | Renderer to backend, then one reply | Returns a promise that resolves a value or rejects with the backend error. | `state:get`, `session:spawn`, `plan:read`, `memory:overview`, `app:updateCheck` |
| Notify | Renderer to backend | Fire-and-forget input with no reply path. A handler must not depend on acknowledgement. | `pty:write`, `pty:resize`, `rpc:send`, `shell:write` |
| Event | Backend to every registered sink | Pushes state or process output to the desktop renderer and all connected browser clients. | `state:changed`, `pty:data`, `rpc:frame`, `shell:exit`, update and remote-state events |

The preload builds `OmpBackend` with `ipcRenderer.invoke`, `ipcRenderer.send`, and typed listeners. The browser adapter builds the same interface with WebSocket request ids, notifications, and event listeners. PTY and shell byte events use WebSocket binary frames, so remote terminal output is not base64-inflated. Other remote frames are JSON. The server rejects inbound WebSocket payloads larger than 64 MiB.

There is one renderer implementation under [`packages/desktop/src/renderer/src`](../packages/desktop/src/renderer/src/). The Electron build receives `window.ompBackend` from preload. The web bootstrap connects first, assigns the WebSocket-backed client to the same global, and only then imports the renderer entry. Backend-facing stores and views therefore use no transport-specific call path.

## Process and isolation invariants

- omp-ui must remain single-instance for each application data directory. Electron acquires `requestSingleInstanceLock()` before creating the backend. A second launch focuses the existing window and exits. OMP has no cross-process session lock, so two application instances could otherwise resume and write the same JSONL session.
- The Electron main process is the sole owner of live OMP children. `SessionManager` keys live and in-flight resume spawns by `tabId`, deduplicates before its first asynchronous resume step, and never starts a second process for the same owned session.
- The renderer is sandboxed. `contextIsolation` and `sandbox` stay enabled, while `nodeIntegration` stays disabled. Preload exposes only the generated `OmpBackend` through `contextBridge`; event listeners discard Electron's event object before invoking renderer callbacks.
- Renderer failure does not transfer process ownership. The main process keeps live sessions, guards dead event sinks, and may reload the renderer. A reload rebuilds state and rpc-ui history through the backend rather than adopting child processes in the renderer.
- Agent-authored plan HTML renders only as `srcDoc` in an `<iframe sandbox="">`. The main process denies subframe navigation and sends allowed web links to the system browser. The renderer never receives a general filesystem read capability for plan files.

## OMP execution modes

A live session has one process and one mode at a time. Switching mode reaps the current child, records the new mode, and resumes the same owned session through the other adapter.

| Mode | Child transport | Renderer data | Framing rule |
|---|---|---|---|
| Terminal, `pty` | `node-pty` runs the unmodified OMP TUI. Input, resize, and raw output cross the backend seam; xterm.js interprets the bytes. Core coalesces output for 5 ms before either transport sees it. | Terminal bytes only. OMP owns the visible TUI and its key handling. | No JSON interpretation. Preserve PTY bytes through core, IPC or WebSocket, and xterm.js. See [Phase 1: PTY embed](phase-1-pty-embed.md). |
| Native, `rpc-ui` | `omp --mode=rpc-ui` runs over stdin and stdout pipes without a PTY. Structured commands go in and protocol frames and `AgentSessionEvent` objects come out. | Native transcript render items, session state, extension UI, todos, tools, diffs, and subagent events. | Newline-delimited JSON. Core starts with a 1 MiB physical-frame limit, adopts a positive integer `maxFrameBytes` from OMP's `ready` frame, and then negotiates protocol v2. `rpc_chunk` sequences must be ordered and consistent and may reassemble to at most 64 MiB. A framing violation terminates the child. See [Phase 2: rpc-ui](phase-2-rpc-ui.md). |

The physical-frame limit applies to each newline-delimited stdout frame: 1 MiB until a valid `ready.maxFrameBytes` overrides it. Protocol v2 carries larger logical output as chunks. The 64 MiB reassembly limit applies after base64 decoding. The renderer receives only complete frames. Detailed command and event inventories remain in the linked phase reference rather than being duplicated here.

## Session ownership and storage

OMP's JSONL files are authoritative for session identity, transcript content, title, status, and lineage changes. omp-ui's `registry.json` is authoritative for application preferences, registered projects, owned-session membership, `tabId`, current mode, agent mode, model and advisor choices, the compaction method captured by a fresh native session, worktree metadata, and cached display fields. Cached registry fields are fallback display data, not a replacement transcript.

- **Registry.** One `OwnedSessionRecord` represents one spawned lineage. Registry writes replace the JSON file atomically. An unknown or corrupt registry schema is quarantined rather than partially trusted.
- **Sidebar order.** The registry's persisted arrays are the sidebar orders (issues #115, #274): projects append via `addProject`, sessions insert at their project's top via `addSession`, and `moveProject`/`moveSession` reorder on user action only. Nothing re-sorts during state builds — activity refreshes cached fields in place. A one-time `sessionOrderFrozen` seed converts legacy registries from recency order on first load.
- **Lineage.** A new owned session gets a pinned `omp-ui--<project-slug>--<uuid>/` directory directly under OMP's active sessions root and passes it as `--session-dir`. One OMP process may move through several session ids via `/new` or `/branch`; they remain one lineage and one tab.
- **Plan handoff.** When an approved plan starts in a fresh implementation session, registry metadata on the implementation's `OwnedSessionRecord` owns the one-way `planImplementationSource` relation. It snapshots `sourceTabId`, `planTitle`, and the `local://` `planFilePath`. The planning record has no reverse link; the sidebar derives that link from current records. This relation never uses the transcript's `parentSession`. The renderer waits for the fresh seed command's successful response before it suppresses advisor-reply and stall auto-continue on the source and requests hibernation. Main validates the persisted relation and runs its bounded live-work probe before reaping. This explicit handoff may bypass ordinary viewed-tab, last-active, and post-verdict guards, but it still respects disabled hibernation and refuses a running turn, queued prompt, active stream, or blocking human-answer request. The planning and implementation transcripts and pinned lineage directories remain independent. Hibernation deletes neither one, and ordinary resume restores the source with its transcript intact. Deleting the planning session also deletes the implementation sessions it spawned, and every session descended from them, with it (issue #309).
- **Materialization.** OMP may keep a new session only in memory until it produces durable output. The registry record and `tabId` exist first, and `sessionId: null` remains valid. A lineage watcher adopts the JSONL header id after the file appears and follows later in-process session changes.
- **Archive.** OMP garbage collection may gzip and move a lineage under the archive sessions root. omp-ui stores the lineage directory name and session id, not a cached absolute file path. Hydration resolves the active root first and the archive root second. Resume restores an archived lineage to the active root before spawning OMP.
- **Delete.** Explicit session deletion reaps a live child, removes the lineage from both active and archive roots, and only then removes the registry record. If file deletion fails, the record remains visible and retryable. This is the one destructive operation against the authoritative session storage. When the session has plan-handoff descendants, deletion cascades to their complete closure, each through this same per-session path (issue #309).
- **Worktree session.** A worktree session keeps its registered `projectCwd` for grouping and project-scoped settings, but runs OMP in a dedicated checkout under the app-data worktrees root. The checkout is its effective working tree for diffs, branches, file mentions, and its console shell. The session record persists the branch's cut point (`base`), which the branch diff pane uses to keep committed session work visible via merge-base. Deleting the session removes the checkout on a best-effort basis; the branch and commits remain in the project repository. At startup the main process sweeps checkout directories under the worktrees root that no session record references.
- **Compaction method overlay.** The app default seeds only fresh native `OwnedSessionRecord` values. At each later native process spawn, core reads supported methods from the installed OMP binary's pristine `compaction.methodOrder` and the effective fallback order for the session working directory. SessionManager writes a per-lineage overlay that promotes the captured method and preserves those fallbacks. Unsupported or unreadable captures remove the overlay and defer to OMP. Terminal-origin sessions keep a null capture and never receive this overlay.

See [Session storage and encoding](session-encoding.md) for the verified JSONL, title-slot, artifacts, root-resolution, and archive formats. Directory encoding is diagnostic only. Code must read the JSONL header instead of reconstructing a project path from a directory name.

## Feature seams

### Provider credentials

[`ProviderKeys`](../packages/core/src/provider-keys.ts) resolves catalogued environment variables from stored values, the inherited environment, and a captured login shell. Project `.env` files are report-only because OMP loads them itself. Desktop main supplies the OS `safeStorage` cipher, refuses storage when it cannot encrypt securely, installs resolved values into its own `process.env` before any spawn, and returns only source labels and masked tails to renderers. Key material never crosses IPC or WebSocket. See [ADR-0010](adr/0010-provider-credentials-supplied-to-every-spawn.md).

### Managed OMP binary

Core owns binary discovery, version comparison, release asset selection, temporary-executable validation, and atomic replacement. Resolution prefers an explicit `OMP_UI_OMP_PATH`, then omp-ui's private managed copy, then `PATH` and known user install locations. Desktop main owns the visible update state and refreshes the resolved path after an install. Session, title, and branch-name processes all use that resolved binary. The renderer never downloads or launches omp itself.

### Plan mode and plan review

OMP's rpc-ui protocol has no plan-mode command, so core generates a per-lineage extension and desktop passes it with `-e` on rpc-ui spawns. The extension uses OMP's existing extension UI frames to publish mode state and block on plan review. It also drives OMP's own write guard; the renderer does not simulate read-only mode. Plan-file reads are confined in main to the owning lineage directory. HTML plans use the sandboxed renderer path described above. Prepared HTML plans are verified in the renderer before presentation, and a failed verification shows a named failure with the raw plan source in place of the iframe ([ADR-0022](adr/0022-prepared-plan-verification-in-the-renderer.md)). The decisions and unsupported OMP method hooks are recorded in [ADR-0007](adr/0007-plan-mode-via-generated-extension.md), [ADR-0013](adr/0013-plan-mode-as-read-only-with-on-demand-gate.md), and [ADR-0014](adr/0014-html-plans-authored-directly.md).

Plan review can execute in the planning session, execute there after compaction, or seed a fresh implementation session. Only the fresh-session choice creates a plan handoff. The source snapshot is persisted with the fresh session before dispatch. The new session begins in Build mode, and the renderer waits for its seed acknowledgement before asking main to hibernate the source. Main owns that reap and preserves the source's transcript, lineage, and resumability. Same-session and compacted choices preserve their existing execution paths and create no cross-session relation (issues #165, #238, #283, and #309).

### MCP configuration, runtime status, and OAuth recovery

MCP configuration resolution stays in transport-agnostic core and returns only a redacted effective view: credentials, headers, auth and OAuth blocks, source errors, and URL secrets never reach a renderer. Resolution and writes are keyed on the working tree whose project-scope config decides, which for a worktree session is its checkout rather than the project root; the checkout carries a `.omp` symlink to the project's own directory so OMP resolves the project's config there and a write lands on the project's real file (issue #325). A live native session's connection truth comes from OMP's `mcp:connection-status` event bus through a third per-lineage generated extension. That extension reduces raw events to server names plus `auth` or `connection` failure kinds and publishes the snapshot over OMP's existing `setStatus` frame. `MainBackend` forwards the ordinary rpc frame, so Electron and remote-browser renderers derive the same transcript notice, Session HUD badge, and manager-row state without a new backend channel or session-file entry.

A project-scope disable of a row the user-level allowlist force-enables has to clear that pin, because OMP reads both override lists from the user file alone. Clearing it alone would drop the server in every other project whose global-scope winner says `enabled: false`, so when that winner is a file omp-ui may write, core flips it to `enabled: true` first and the pin becomes redundant instead of load-bearing. A tool-owned winner has no such lever — omp-ui never mutates another tool's config — so that case stays global and the DTO's `disableReach` tells the row's tooltip which of the two it is (issues #324, #326).

A config write is not a live change: OMP has no MCP RPC verbs. `/mcp reload` is the runtime lever — OMP handles it internally (`disconnectAll` → `discoverAndConnect` → `refreshMCPTools`) and answers `agentInvoked: false`, so the manager's footer offers it for a live pinned tab (typed into the TUI for a terminal tab) instead of restarting the process (issue #327).

OAuth recovery is deliberately separate from runtime observation. OMP refuses `/mcp reauth` over rpc-ui, so an effective HTTP or SSE row in a live native session hands the command to a real OMP TUI in the console drawer. The TUI runs with `--no-session`; after browser consent, the user exits it with `/quit` and reloads MCP in the live session. A reload rebinds that process's MCP tool set; a restart also replaces its `MCPManager` and clears the old process-scoped snapshot.

Runtime status is compatibility-bound to OMP versions that emit `mcp:connection-status`. OMP's `startup.quiet` also suppresses those startup events. In either case omp-ui degrades silently: configured servers remain visible in the redacted manager, but the UI does not parse `/mcp list` prose or claim that configured means connected.

### Slash commands in native sessions

A native session's composer accepts the same slash commands as the terminal TUI. A few commands map to omp-ui surfaces and never reach the child; every other command line is forwarded to OMP.

| Composer input | Handling |
|---|---|
| `/new` | Opens a new tab session; the composer never dispatches it. |
| `/plan`, `/no-plan` (bare) | Toggle plan mode through the generated extension described above. |
| `/mcp`, `/mcp list` (bare) | Open the MCP manager for the session's own working tree. Every other `/mcp …` subcommand forwards normally — including `/mcp reload`, which the manager's footer sends. |
| Any other advertised command | Forwards as a `prompt` frame with the command acknowledgement lifecycle below. |
| Unknown `/word` | Forwards as a literal model prompt. No command row appears; OMP starts a real agent turn. |

A forwarded command appends a command render item in the transcript that starts `running` and settles from the `response` frame: an RPC failure settles it `failed` with OMP's own error text, `agentInvoked: false` settles it `done`, and `agentInvoked: true` settles it `agent` because the resulting agent turn renders on its own. An older runtime that omits the acknowledgement data leaves the item `running` until the matching `prompt_result`, mapped by request id, settles it `done` or `agent`, or the tab's next `agent_start` settles it `agent`. A command sent while the agent is streaming goes out unchanged; OMP rejects it and the item settles `failed`.

`command_output` frames attach to the newest running command item, joined by newlines and capped at 64 KiB with a head-preserving truncation note; with no running command item the text falls back to an info notice. OMP 17.3.8 emits `command_output` for builtin replies over rpc-ui, and the command row renders that text - in the docked transcript and, since the hero treats command rows as ambient, in the fresh-session hero footer as well. Runtimes that emit no reply leave the row settled but textless; omp-ui does not fabricate those replies from adjacent RPC state.

`open_url` extension UI requests, emitted by RPC login and OAuth flows, route to the system browser: the renderer calls `window.open`, main's window-open handler denies the window and passes the URL through `openExternalSafe`, which gates schemes to https, http, and mailto. The request is answered `confirmed: true` and the transcript records an opened-browser marker. A request without a valid URL is cancelled as before.

### Advisor

Advisor enablement and model selection are session state. Core writes a per-lineage `--config` overlay, and a change relaunches a live child with `--resume` because OMP binds the root advisor at process start. A second generated extension treats the root switch as a ceiling on every task descendant before its prompt starts. It also publishes root advisor configuration and context together with session-tree advisor cost and token totals over an existing extension status key. Advisor notes remain structured transcript events. Renderer logic handles the bounded late-review fold and idle-session reply; the transport and server do not interpret advisor content. See [ADR-0005](adr/0005-session-scoped-advisor-via-config-overlay.md), [ADR-0008](adr/0008-advisor-accounting-via-generated-extension.md), [ADR-0009](adr/0009-late-advisor-concerns-folded-into-plan-execution.md), and [ADR-0012](adr/0012-advisor-reply-on-idle-sessions.md).

### Updates

omp updates and omp-ui application updates are separate state machines. For the application, core handles release lookup, package detection, and checksum-verified downloads. For omp, core selects the release binary, validates the temporary executable, and replaces the managed copy atomically. Desktop main owns background-check policy, dismissal state, progress events, Electron package staging, installer handoff, and guarded restart or quit. The remote server only transports the same update channels. See [Releases](releases.md) for supported package policy.

### Remote transport

Desktop main owns whether remote access is enabled, its bind address and port, its token, its password hash, and server restart policy. `@omp-ui/server` owns HTTP delivery and authentication, the `/ws` upgrade, JSON request routing, and event fan-out. It accepts either the minted token or a password-derived session credential. It has no access to registry or session implementation beyond the `RemoteHost` interface. The browser reconnect path reloads and rehydrates instead of inventing a partial frame replay. See [Remote access](remote-access.md) for trust and network constraints.

### Memory

OMP exposes no memory command over rpc-ui. Core therefore reads mnemopi SQLite banks directly with `node:sqlite`, one read-only connection per request, and writes none. There is a single memory channel, `memory:overview`. The renderer sends `projectCwd`, never a database path; main resolves and confines both banks itself. Reads coexist with OMP's WAL writer. omp-ui discovers existing project banks and does not derive or create their hashed names. The settings surface reports configured banks but does not claim to show the exact memories OMP injected into a running session. See [ADR-0017](adr/0017-memory-pane-reads-mnemopi-sqlite-directly.md).

## ACP is deliberately unwrapped

omp already provides an Agent Client Protocol server over stdio:

```bash
omp acp
```

The command speaks newline-delimited JSON-RPC. omp-ui does not wrap it, proxy it through `OmpBackend`, or present itself as an ACP client. ACP clients should invoke omp's capability directly. If omp-ui later owns an ACP spawn, the same pinned lineage and registry rules will apply; an external ACP client's sessions remain outside omp-ui ownership. See [Phase 3: ACP](phase-3-acp.md) for the verified capability and interoperation notes.

## Architecture decision records

Each current record is indexed once below. Superseding records remain linked because they explain why the present implementation has its shape.

| Record | Decision |
|---|---|
| [Electron over Tauri](adr/0001-electron-over-tauri.md) | Use Electron's consistent Chromium and xterm.js behavior across platforms instead of system webviews. |
| [Transport-agnostic core (`packages/core` + `OmpBackend`)](adr/0002-transport-agnostic-core.md) | Keep OMP-facing Node logic free of Electron and expose one typed backend interface over IPC or WebSocket. |
| [Per-lineage pinned session dirs inside OMP's default sessions root](adr/0003-per-lineage-session-dirs.md) | Give every owned lineage a direct-child `--session-dir` so ownership is structural and OMP garbage collection keeps its data reachable. |
| [Design tokens and UI primitives](adr/0004-design-tokens-and-primitives.md) | Build renderer views from semantic theme tokens and shared primitives, reserving the signal accent for liveness and success. |
| [Session-scoped advisor, driven by a per-lineage `--config` overlay](adr/0005-session-scoped-advisor-via-config-overlay.md) | Store advisor state per session, apply it through a lineage config overlay, and relaunch live sessions when it changes. |
| [Pasted images: inline bytes for rpc-ui, a scratch file for the PTY](adr/0006-image-paste-in-both-modes.md) | Send rpc-ui images as inline base64, but hand terminal mode a bracketed-paste path to a bounded scratch file. |
| [Plan mode, driven by a per-lineage generated extension](adr/0007-plan-mode-via-generated-extension.md) | Drive rpc-ui plan state and review through a generated lineage extension and OMP's existing extension UI frames. |
| [Advisor accounting, delivered by a second generated extension](adr/0008-advisor-accounting-via-generated-extension.md) | Publish reduced OMP advisor usage from a generated extension instead of parsing text or recalculating usage in the client. |
| [Late advisor concerns are folded into plan execution](adr/0009-late-advisor-concerns-folded-into-plan-execution.md) | On execute, wait for the drafting turn's bounded late advisor review and fold new concerns into every implementation context. |
| [Provider credentials are omp-ui's problem, and they ride `process.env`](adr/0010-provider-credentials-supplied-to-every-spawn.md) | Resolve provider keys once in main, store user-entered values with OS encryption, and supply them to every OMP child through `process.env`. |
| [AppImage as the sole first-party Linux artifact, via a staged bridge](adr/0011-appimage-only-linux-distribution.md) | Ship AppImage as the sole supported first-party Linux artifact with a per-user install and in-place update path. |
| [An advisor review that lands on an idle session is answered by a reply](adr/0012-advisor-reply-on-idle-sessions.md) | Batch late findings into a bounded automatic follow-up in the same idle rpc-ui session. |
| [Plan mode is the read-only mode, with the plan gate on demand](adr/0013-plan-mode-as-read-only-with-on-demand-gate.md) | Enforce read-only exploration in Plan mode and open a review gate only when the user asked for a plan and the agent proposed one. |
| [HTML plans are authored directly, as the one and only plan file](adr/0014-html-plans-authored-directly.md) | Treat the self-contained HTML artifact as the sole plan file when HTML plan format is selected. |
| [Unsigned per-user NSIS for the Windows x64 preview](adr/0015-unsigned-windows-nsis-preview.md) | Distribute the Windows x64 preview as an unsigned per-user NSIS installer until publicly trusted signing is available. |
| [Plan implementation always begins in Build mode](adr/0016-plan-implementation-always-begins-in-build.md) | Start every approved-plan implementation in Build mode regardless of the default mode for ordinary new sessions. |
| [The Memory pane reads mnemopi's SQLite directly](adr/0017-memory-pane-reads-mnemopi-sqlite-directly.md) | Read mnemopi banks directly from main with confined, read-only SQLite because OMP exposes no runtime memory command. |
| [Worktree checkouts live in app data](adr/0018-worktree-checkouts-in-app-data.md) | Put worktree-session checkouts under app data and remove the checkout, but not its branch or commits, when deleting the session. |
| [Stall auto-continue after stalled turns](adr/0019-stall-auto-continue-after-stalled-turns.md) | When a turn dies to a stream stall, post the diagnostic at the turn-end and dispatch a bounded continue prompt into the same idle rpc-ui session. |
| [Plan-handoff descendants are deleted with their source](adr/0021-cascade-delete-of-plan-handoff-descendants.md) | Deleting a session erases its complete plan-handoff descendant closure; a session without descendants is deleted alone. |
| [Prepared plan documents are verified in the renderer before presentation](adr/0022-prepared-plan-verification-in-the-renderer.md) | Verify a prepared HTML plan structurally and with a script-less layout probe in the renderer; a failed verification presents a named reason and the raw plan source, never a blank frame. |
