# Architecture

omp-ui is an Electron application with one backend and two renderer transports. The desktop window reaches the backend over Electron IPC. A remote browser reaches the same backend over paired authenticated WebSockets: reliable control/terminal traffic and acknowledged browser pane frames. Both renderers use the same React source and the same typed `OmpBackend` interface.

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
  main --> rim[RemoteInstanceManager<br/>WebSocket client per joined instance]
  rim -. tab-routed calls, merged state .-> other[Another omp-ui app<br/>its @omp-ui/server]
  sessions --> core[@omp-ui/core]
  core --> pty[node-pty<br/>omp TUI]
  core --> rpc[stdio pipes<br/>omp --mode=rpc-ui]
```

The browser path does not create a second application backend. `@omp-ui/server` accepts a `RemoteHost`, dispatches requests and notifications to `MainBackend.handlers()`, and mirrors backend events from `MainBackend.addSink()`. Session ownership, the registry, child processes, and updates remain in the Electron main process. The same main process is also the only client of any [remote instance](remote-instances.md) this app has joined: `RemoteInstanceManager` dials the other app's `@omp-ui/server`, and its projects and sessions arrive in the renderer as ordinary backend state.

## Package responsibilities

| Package | Owns | Does not own |
|---|---|---|
| [`@omp-ui/core`](../packages/core/src/index.ts) | Transport-independent Node logic: shared types and channel declarations, registry persistence, OMP path and session-file resolution, archive handling, worktrees, provider and settings logic, memory access, PTY spawning and batching, and the rpc-ui client and frame codec. | Electron windows, IPC, WebSockets, renderer state, or application update orchestration. |
| [`@omp-ui/desktop`](../packages/desktop/src/) | The Electron lifecycle, secure window and preload setup, `MainBackend`, the sole `SessionManager`, renderer and web builds, OS credential encryption, window and shell integration, remote-server lifecycle, the `RemoteInstanceManager` that joins other omp-ui apps, and app and OMP update state. | A second transport-specific business interface. Both IPC and WebSocket use the core channel table. |
| [`@omp-ui/server`](../packages/server/src/index.ts) | Static delivery of the browser bundle, token or password authentication, WebSocket request routing, reliable event fan-out, paired acknowledged image delivery, and the matching `connectInstanceClient` that desktop main uses to join another app's server. | Electron, the registry, sessions, OMP processes, or a standalone backend. It requires a `RemoteHost` supplied by desktop main. |

`@omp-ui/core` is transport-agnostic, not browser-safe as a whole. It uses Node APIs and `node-pty`. The renderer imports only dependency-free subpaths such as `@omp-ui/core/types`, `@omp-ui/core/plan`, and `@omp-ui/core/advisor-stats`.

## Renderer and backend seam

[`BACKEND_CHANNELS`](../packages/core/src/backend-channels.ts) declares each capability once. The channel name, arguments, result, generated `OmpBackend` client, and `ChannelTable` handler shape all derive from that declaration. [`MainBackend.handlers()`](../packages/desktop/src/main/backend.ts) implements the request and notification sides once for both transports.

Request and notification argument codecs are required metadata on each `BACKEND_CHANNELS` declaration. Electron IPC and authenticated WebSocket traffic converge on the same core dispatch boundary, which validates exact tuples before a `ChannelTable` handler runs. Malformed requests reject with a channel-qualified static error; malformed notifications are dropped under the existing fire-and-forget policy. Backend events flow in the opposite direction and are not decoded here.

| Channel kind | Direction | Contract | Examples |
|---|---|---|---|
| Request | Renderer to backend, then one reply | Returns a promise that resolves a value or rejects with the backend error. | `state:get`, `session:spawn`, `plan:read`, `memory:overview`, `app:updateCheck`, `diagnostics:export` |
| Notify | Renderer to backend | Fire-and-forget input with no reply path. A handler must not depend on acknowledgement. | `pty:write`, `pty:resize`, `rpc:send`, `shell:write` |
| Event | Backend to every registered sink | Pushes state or process output to the desktop renderer and all connected browser clients. | `state:changed`, `pty:data`, `rpc:frame`, `shell:exit`, update and remote-state events |

The desktop preload builds the request, notification, and reliable-event bridge with `ipcRenderer.invoke`, `ipcRenderer.send`, and typed listeners. Browser pane media bypasses contextBridge: a fixed, top-level-frame-only handshake transfers a MessagePort into the renderer's main world. For a local pane the port carries only capture leases and geometry notices (`browser-pane-desktop-protocol.ts`); the pixels arrive as a Chromium tab-capture `MediaStream`. For a joined remote instance's pane it carries JPEG images: main filters desktop subscriptions before sending, permits one unacknowledged image per window, and retains only the newest pending image per subscribed tab. ACK follows painting or intentional drop; port replacement fences old replies and settles pending lease requests, and document replacement resets subscriptions. `renderer/src/backend.ts` combines this receiver with the preload bridge into the application's `OmpBackend` and exports the lease channel as `desktopPaneMedia`.

The browser adapter builds the same interface with WebSocket request ids, notifications, and event listeners. PTY and shell bytes stay on reliable `/ws` binary frames; browser pane images use sequence-bearing binary envelopes on authenticated `/ws/frames`, paired by a live key sent over `/ws`. One image awaits ACK per pair, with only the latest pending image per subscribed tab. Browser consumers ACK after paint or intentional drop; joined main processes ACK after local relay handoff. Each downstream pair owns its own bound, independent of desktop credit. Reliable inbound messages have a 64 MiB ceiling; the ACK-only socket has a 1 KiB ceiling and cannot dispatch backend calls.

There is one renderer implementation under [`packages/desktop/src/renderer/src`](../packages/desktop/src/renderer/src/). The Electron build receives `window.ompBackend` from preload. The web bootstrap connects first, assigns the WebSocket-backed client to the same global, and only then imports the renderer entry. Backend-facing stores and views therefore use no transport-specific call path.

The diagnostic bundle ([`core/src/diagnostics.ts`](../packages/core/src/diagnostics.ts)) is the feature-seam example for redaction: callers hand the collector the raw settings object, and the scrub that replaces `remoteToken`/`remotePasswordHash`/`remotePasswordSalt` with presence booleans lives inside the collector, not in any caller — a new call site cannot forget it. The bundle's own `manifest.json` states the policy and lists every section with byte counts, so a recipient sees what the file holds.


## Process and isolation invariants

- omp-ui must remain single-instance for each application data directory. Electron acquires `requestSingleInstanceLock()` before creating the backend. A second launch focuses the existing window and exits. OMP has no cross-process session lock, so two application instances could otherwise resume and write the same JSONL session.
- The Electron main process is the sole owner of live OMP children. `SessionManager` keys live and in-flight resume spawns by `tabId`, deduplicates before its first asynchronous resume step, and never starts a second process for the same owned session.
- The renderer is sandboxed. `contextIsolation` and `sandbox` stay enabled, while `nodeIntegration` stays disabled. Preload exposes only the generated `OmpBackend` through `contextBridge`; event listeners discard Electron's event object before invoking renderer callbacks.
- Renderer failure does not transfer process ownership. The main process keeps live sessions, guards dead event sinks, and may reload the renderer. A reload rebuilds state and rpc-ui history through the backend rather than adopting child processes in the renderer.
- Agent-authored plan HTML renders only as `srcDoc` in an `<iframe sandbox="">`. The main process denies subframe navigation and sends allowed web links to the system browser. The renderer never receives a general filesystem read capability for plan files.
- The browser pane's `WebContents`, its `debugger`, and every CDP session stay in the main process. No channel returns any of them to a renderer: renderers receive JPEG frames and JSON state and send JSON input, and the only route into the page is the loopback, token-pathed bridge the owning main process hosts. The pane's partition denies every permission and download and loads only http(s) documents.

## OMP execution modes

A live session has one process and one mode at a time. Switching mode reaps the current child, records the new mode, and resumes the same owned session through the other adapter.

| Mode | Child transport | Renderer data | Framing rule |
|---|---|---|---|
| Terminal, `pty` | `node-pty` runs the unmodified OMP TUI. Input, resize, and raw output cross the backend seam; xterm.js interprets the bytes. Core coalesces output for 5 ms before either transport sees it. | Terminal bytes only. OMP owns the visible TUI and its key handling. | No JSON interpretation. Preserve PTY bytes through core, IPC or WebSocket, and xterm.js. See [Phase 1: PTY embed](phase-1-pty-embed.md). |
| Native, `rpc-ui` | `omp --mode=rpc-ui` runs over stdin and stdout pipes without a PTY. Structured commands go in and protocol frames and `AgentSessionEvent` objects come out. | Native transcript render items, session state, extension UI, todos, tools, diffs, and subagent events. | Newline-delimited JSON. Core starts with a 1 MiB physical-frame limit, adopts a positive integer `maxFrameBytes` from OMP's `ready` frame, and then negotiates protocol v2. `rpc_chunk` sequences must be ordered and consistent and may reassemble to at most 64 MiB. A framing violation terminates the child. See [Phase 2: rpc-ui](phase-2-rpc-ui.md). |

The physical-frame limit applies to each newline-delimited stdout frame: 1 MiB until a valid `ready.maxFrameBytes` overrides it. Protocol v2 carries larger logical output as chunks. The 64 MiB reassembly limit applies after base64 decoding. The renderer receives only complete frames. Detailed command and event inventories remain in the linked phase reference rather than being duplicated here.

Every native command the renderer sends is armed with a 30 s budget, but that budget measures two different things because OMP answers on a single serial chain (`RpcInputDispatcher`). **Strict** commands — everything OMP answers from memory, plus a plain-text `prompt` — must be acknowledged within the window; expiry means the chain is wedged and is the diagnostic issue #302's attribution relies on, so it must keep firing. **Late-ack** commands are those whose handler OMP awaits before acknowledging: `compact`, `handoff`, `abort`, `abort_and_prompt`, `export_html`, `login`, `new_session`, `switch_session`, `branch`, `set_model`, `cycle_model`, `get_available_models`, `bash`, `predict_word`, and any `prompt` that is a slash command or contains `/skill:<name>` (OMP runs the whole agent turn inside that handler). For them the window measures the process's **silence**: `lastFrameAt` records the wall-clock of the last frame seen for the tab, and the budget re-arms for the remainder of the window while frames keep arriving, failing only after a full quiet window. Off-chain commands — `bash` and `predict_word`, flagged `offChain` in `SESSION_COMMANDS` (`packages/core/src/session-command.ts`) — are exempted client-side from that measurement: OMP dispatches them outside the serial chain and they emit no frames while they run, so a quiet pending one re-arms unconditionally and its completion never retires attribution for earlier commands ([#678](https://github.com/LankfordAI/omp-ui/issues/678), [#715](https://github.com/LankfordAI/omp-ui/issues/715)). `isLateAckCommand` in the renderer store's `shared` slice owns the classification. Waits are never left to expire against a process that went away — process exit, hibernation, boot, and session deletion all abandon them silently, because the dead overlay or the fresh boot already reports what happened.

## Session ownership and storage

OMP's JSONL files are authoritative for session identity, transcript content, title, status, and lineage changes. omp-ui's `registry.json` is authoritative for application preferences, registered projects, owned-session membership, `tabId`, current mode, agent mode, model and advisor choices, the compaction method captured by a fresh native session, worktree metadata, and cached display fields. Cached registry fields are fallback display data, not a replacement transcript.

- **Registry.** One `OwnedSessionRecord` represents one spawned lineage. Registry writes replace the JSON file atomically. An unknown or corrupt registry schema is quarantined rather than partially trusted.
- **Renderer reconciliation.** Each authoritative local project snapshot reconciles the renderer's mounted local tabs against current registry records. A missing local record drops its tab and renderer runtime. Joined remote projections follow the same rule, but an unreachable instance retains its last-known tabs until it rejoins and publishes an authoritative listing.
- **Sidebar order.** The registry's persisted arrays are the sidebar orders (issues #115, #274): projects append via `addProject`, sessions insert at their project's top via `addSession`, and `moveProject`/`moveSession` reorder on user action only. Nothing re-sorts during state builds — activity refreshes cached fields in place. A one-time `sessionOrderFrozen` seed converts legacy registries from recency order on first load.
- **Lineage.** A new owned session gets a pinned `omp-ui--<project-slug>--<uuid>/` directory directly under OMP's active sessions root and passes it as `--session-dir`. One OMP process may move through several session ids via `/new` or `/branch`; they remain one lineage and one tab.
- **Plan handoff.** When an approved plan starts in a fresh implementation session, registry metadata on the implementation's `OwnedSessionRecord` owns the one-way `planImplementationSource` relation. It snapshots `sourceTabId`, `planTitle`, and the `local://` `planFilePath`. The planning record has no reverse link; the sidebar derives that link from current records. This relation never uses the transcript's `parentSession`. The renderer waits for the fresh seed command's successful response before it suppresses advisor-reply and stall auto-continue on the source and requests hibernation. Main validates the persisted relation and runs its bounded live-work probe before reaping. This explicit handoff may bypass ordinary viewed-tab, last-active, and post-verdict guards, but it still respects disabled hibernation and refuses a running turn, queued prompt, active stream, or blocking human-answer request. The planning and implementation transcripts and pinned lineage directories remain independent. Hibernation deletes neither one, and ordinary resume restores the source with its transcript intact. Deleting the planning session also deletes the implementation sessions it spawned, and every session descended from them, with it (issue #309).
- **Materialization.** OMP may keep a new session only in memory until it produces durable output. The registry record and `tabId` exist first, and `sessionId: null` remains valid. A lineage watcher adopts the JSONL header id after the file appears and follows later in-process session changes.
- **Archive.** OMP garbage collection may gzip and move a lineage under the archive sessions root. omp-ui stores the lineage directory name and session id, not a cached absolute file path. Hydration resolves the active root first and the archive root second. Resume restores an archived lineage to the active root before spawning OMP.
- **Delete.** Explicit session deletion reaps a live child, removes the lineage from both active and archive roots, and only then removes the registry record. If file deletion fails, the record remains visible and retryable. This is the one destructive operation against the authoritative session storage. When the session has plan-handoff descendants, deletion cascades to their complete closure, each through this same per-session path (issue #309).
- **Worktree session.** A worktree session keeps its registered `projectCwd` for grouping and project-scoped settings, but runs OMP in a dedicated checkout under the app-data worktrees root. The checkout is its effective working tree for diffs, branches, file mentions, and its console shell. The session record persists the branch's cut point (`base`) — which may be a branch omp-ui created within the same create operation, the base branch named by the *new branch…* selection (issue #405); a minted session branch then carries it as its middle name segment, `<project>/<base>/<hash>`, whose first segment is the project's own slug (`slugifyProjectName` of the `projectCwd` basename, the rule the checkout slot directory uses) — and the branch diff pane uses the recorded base to keep committed session work visible via merge-base. Deleting the session removes the checkout on a best-effort basis; the branch and commits remain in the project repository. Finishing a worktree instead **releases** it (issue #334): the record's `worktree` is cleared and the session respawns in the project checkout with `--resume`, keeping its transcript, tab, and lineage, wh…
- **Compaction method overlay.** The app default seeds only fresh native `OwnedSessionRecord` values. At each later native process spawn, core reads supported methods from the installed OMP binary's pristine `compaction.methodOrder` and the effective fallback order for the session working directory. SessionManager writes a per-lineage overlay that promotes the captured method and preserves those fallbacks. Unsupported or unreadable captures remove the overlay and defer to OMP. Terminal-origin sessions keep a null capture and never receive this overlay.
- **Subagent model overlay ([ADR-0031](adr/0031-subagent-model-selection-via-config-layers.md)).** A per-lineage `--config` overlay carries the session's `task.agentModelOverrides` choices: the session's own map, or — while it has none and the app preference is on — a `"*"` (inherit-the-session-model) entry for every agent in the registry roster. Unlike the advisor overlay, OMP re-reads this file before every subagent spawn, so `session:setSubagentModels` rewrites it in place and the change is live with no relaunch. The Global and Project layers of the same record are edited through the settings allowlist (replace-not-merge) and the project config writer's third-level map API (one entry at a time); the agent roster is refreshed on demand via `omp agents unpack`, never on the spawn path.


Session lifecycle mutations are dependency-ordered rather than compensating
blindly. A failed fresh spawn stops its child and watcher before removing its
record, and reclaims only a checkout minted by that spawn after the record is
confirmed absent; a checkout borrowed through plan handoff is never owned by
the rollback. Cascade deletion runs each member through its normal per-tab queue,
settles the full closure, then asks core's `reclaimCheckouts` to deduplicate the
captured descriptors against an explicit snapshot of surviving records. The
console drawer follows the same ownership boundary through a separate
`ShellHost`; it is not part of the live OMP child map.

See [Session storage and encoding](session-encoding.md) for the verified JSONL, title-slot, artifacts, root-resolution, and archive formats. Directory encoding is diagnostic only. Code must read the JSONL header instead of reconstructing a project path from a directory name.

## Feature seams

### UI locale

The registry's `localeId` is broadcast in `BackendState`, and each renderer applies it through the same locale module after initial hydration and later state updates. English is the source catalog; Korean is selected only for the `ko` locale, with per-key English fallback for forward compatibility and unknown saved locale ids resolving to English. The renderer uses a zero-dependency, plain-text `t()` layer with flat three-segment keys and placeholder substitution; desktop notification copy selects from the same two locale choices in main. This seam translates application chrome only: session and plan content, PTY bytes, code and paths, names, backend errors, KaTeX/Mermaid output, versions, URLs, and duration tokens remain untouched.

### Provider credentials

[`ProviderKeys`](../packages/core/src/provider-keys.ts) resolves catalogued environment variables from stored values, the inherited environment, and a captured login shell. Project `.env` files are report-only because OMP loads them itself. Desktop main supplies the OS `safeStorage` cipher, refuses storage when it cannot encrypt securely, installs resolved values into its own `process.env` before any spawn, and returns only source labels and masked tails to renderers. Key material never crosses IPC or WebSocket. See [ADR-0010](adr/0010-provider-credentials-supplied-to-every-spawn.md).

Subscription sign-in is a separate seam over the same boundary. A `ProviderOAuth` controller in core drives a bare, session-less rpc child (no tools, extensions, LSP, skills, or rules) that runs one provider's login flow; desktop main answers the child's `open_url` request through the safe-external-link policy and publishes the flow's phase, prompt, and terminal state to the renderer. The credential is written by omp itself into its auth broker — shared with terminal omp — so no token crosses IPC, and the renderer receives only the phase, the provider's identity strings, and errors. `omp token --list` is the account source (a non-zero exit means no accounts); sign-out runs `omp auth-broker logout` through the same controller (issue #368).

### Child environment

An AppImage launch edits omp-ui's own `process.env`: the runtime exports `APPDIR`, `APPIMAGE`, `ARGV0`, and `OWD`; electron-builder's AppRun prepends the mount to `PATH`, `XDG_DATA_DIRS`, `LD_LIBRARY_PATH`, and `GSETTINGS_SCHEMA_DIR`; and every electron-updater relaunch stacks another copy. Every child that runs the user's programs starts from core's [`withoutAppImageRuntime()`](../packages/core/src/appimage-env.ts), which drops those variables and undoes each generation's AppRun edits. That covers the console drawer shell, every omp child through `ompChildEnv`, git, the login-shell key capture, the project open targets (VS Code, Files, Terminal), and the browser handoffs (transcript links, provider sign-in, release notes, the exported transcript). It is recomputed per spawn so provider keys installed later still ride along (ADR-0010). On Linux, Electron's `shell.openExternal` and `shell.openPath` launch `xdg-open` from omp-ui's own environment and accept no replacement, so the VS Code and Files targets and the browser handoffs go through [`system-open.ts`](../packages/desktop/src/main/system-open.ts), which spawns `xdg-open` itself, or `xdg-email` for a `mailto:` link as Electron does. That spawn cannot carry the XDG activation token Electron's launch mints, so on Wayland a browser that is already running opens the page without raising its window. `shell.showItemInFolder` stays on Electron, which asks the desktop portal or `org.freedesktop.FileManager1` over D-Bus; only its last resort, when neither service answers, opens the parent folder through `xdg-open` from omp-ui's environment. PTYs rendered by xterm.js (terminal tabs, the console drawer, its handoff TUI) also advertise `COLORTERM=truecolor`. Electron's own variables (`NO_AT_BRIDGE`, `GDK_BACKEND`, `CHROME_DESKTOP`, …) pass through unchanged.

### Web search provider order

The Providers page's **Preferred provider** select writes omp's `providers.webSearchOrder` on binaries that still publish it and otherwise the `web` role of `modelRoles` — a REPLACE-not-merge write of the whole merged global record, badged by the web role's own layer, Automatic deleting the key (ADR-0031, ADR-0036) — through the same `omp config set` boundary as every other global omp key (ADR-0025); omp-ui keeps no preference of its own. Its choices come from the installed binary: `readWebSearchProviders` in [`omp-settings.ts`](../packages/core/src/omp-settings.ts) runs `omp models --kind search --json` under an empty `HOME`, and the zero-import [`web-search-order.ts`](../packages/core/src/web-search-order.ts) subpath parses those rows into provider ids and maps a stored order or role selector to and from the select ([ADR-0035](adr/0035-web-search-provider-list-read-from-omp-model-catalog.md)). The pure half is bundled by the renderer; the spawn half stays main-process only, reached through the `web-search-providers:read` channel. omp validates neither the array nor its members, so the control is closed — free text is never offered — and a configured id omp's list lacks stays selectable, labelled as outside omp's list. A catalog read that yields nothing degrades to `discovered: false` plus a visible note rather than a fabricated catalog ([ADR-0027](adr/0027-web-search-provider-list-discovered-from-omp.md)).

### Managed OMP binary

Core owns binary discovery, version comparison, release asset selection, temporary-executable validation, and atomic replacement. Resolution prefers an explicit `OMP_UI_OMP_PATH`, then omp-ui's private managed copy, then `PATH` and known user install locations. Desktop main owns the visible update state and refreshes the resolved path after an install. Session, title, and branch-name processes all use that resolved binary. The renderer never downloads or launches omp itself.

### Plan mode and plan review

OMP's rpc-ui protocol has no plan-mode command, so core generates a per-lineage extension and desktop passes it with `-e` on rpc-ui spawns. The extension uses OMP's existing extension UI frames to publish mode state and block on plan review. It also drives OMP's own write guard; the renderer does not simulate read-only mode. Plan-file reads are confined in main to the owning lineage directory. HTML plans use the sandboxed renderer path described above. An HTML proposal passes main-owned plan preflight before any review surface exists: the generated extension's `select` request is claimed at the session's frame edge, the artifact is read through the confined plan reader, and the same parse/highlight/diagram pipeline plus a real layout probe run inside a hidden, script-less Chromium verifier window. A failed or inconclusive outcome answers the agent with located diagnostics through the proposal tool result — the agent repairs the reported ranges instead of presenting a broken document — and a passed proposal carries a main-authored `sourceHash` into the gate, where an `execute` answer re-checks the artifact bytes before implementation dispatches. Every renderer surface still prepares and verifies locally as the final check of what it actually shows ([ADR-0022](adr/0022-prepared-plan-verification-in-the-renderer.md), amended by the issue #312 follow-up; see also the ADR-0023 amendment on source-range composition). The decisions and unsupported OMP method hooks are recorded in [ADR-0007](adr/0007-plan-mode-via-generated-extension.md), [ADR-0013](adr/0013-plan-mode-as-read-only-with-on-demand-gate.md), and [ADR-0014](adr/0014-html-plans-authored-directly.md).

Plan review can execute in the planning session, execute there after compaction, or seed a fresh implementation session. Only the fresh-session choice creates a plan handoff. The source snapshot is persisted with the fresh session before dispatch. The new session begins in Build mode, and the renderer waits for its seed acknowledgement before asking main to hibernate the source. Main owns that reap and preserves the source's transcript, lineage, and resumability. Same-session and compacted choices preserve their existing execution paths and create no cross-session relation (issues #165, #238, #283, and #309).

### Host tools and host URIs

Every rpc-ui spawn registers the `omp-ui://` read-only URI scheme and the namespaced `omp-ui_notify` host tool through the protocol's own `set_host_uri_schemes` / `set_host_tools` commands, which ride `initialCommands` so they land before the first turn on fresh spawn and resume alike ([ADR-0043](adr/0043-host-tools-answer-what-the-main-process-owns.md)). The main process answers both: `omp-ui://plan` serves the plan the session last proposed from the same validated snapshot or confined lineage reader the review pane uses, and `omp-ui_notify` posts an immediate OS notification through the desktop notifier, bypassing the attention pipeline's delay and suppression. Host frames arrive on the RPC client's input-order seam — before delivery — so the answerer's ownership mark exists before the renderer's fallback stub can double-answer; a per-request watchdog answers a generic error if anything stalls, so an agent's host call can never hang. PTY-embedded and remote-instance processes receive no registration; their host frames reach the renderer stub, which answers a well-formed error result.

### MCP configuration, runtime status, and OAuth recovery

MCP configuration resolution stays in transport-agnostic core and returns only a redacted effective view: credentials, headers, auth and OAuth blocks, source errors, and URL secrets never reach a renderer. Resolution and writes are keyed on the working tree whose project-scope config decides, which for a worktree session is its checkout rather than the project root; the checkout carries a `.omp` symlink to the project's own directory so OMP resolves the project's config there and a write lands on the project's real file (issue #325). A live native session's connection truth comes from OMP's `mcp:connection-status` event bus through a third per-lineage generated extension. That extension reduces raw events to server names plus `auth` or `connection` failure kinds and publishes the snapshot over OMP's existing `setStatus` frame. `MainBackend` forwards the ordinary rpc frame, so Electron and remote-browser renderers derive the same transcript notice, Session HUD badge, and manager-row state without a new backend channel or session-file entry.

A project-scope disable of a row the user-level allowlist force-enables has to clear that pin, because OMP reads both override lists from the user file alone. Clearing it alone would drop the server in every other project whose global-scope winner says `enabled: false`, so when that winner is a file omp-ui may write, core flips it to `enabled: true` first and the pin becomes redundant instead of load-bearing. A tool-owned winner has no such lever — omp-ui never mutates another tool's config — so that case stays global and the DTO's `disableReach` tells the row's tooltip which of the two it is (issues #324, #326).

A config write is not a live change: OMP has no MCP RPC verbs. `/mcp reload` is the runtime lever — OMP handles it internally (`disconnectAll` → `discoverAndConnect` → `refreshMCPTools`) and answers `agentInvoked: false`, so the viewer's MCP footer offers it for a live pinned tab (typed into the TUI for a terminal tab) instead of restarting the process (issue #327).

OAuth recovery is deliberately separate from runtime observation. OMP refuses `/mcp reauth` over rpc-ui, so an effective HTTP or SSE row in a live native session hands the command to a real OMP TUI in the console drawer. The TUI runs with `--no-session`; after browser consent, the user exits it with `/quit` and reloads MCP in the live session. A reload rebinds that process's MCP tool set; a restart also replaces its `MCPManager` and clears the old process-scoped snapshot.

Runtime status is compatibility-bound to OMP versions that emit `mcp:connection-status`. OMP's `startup.quiet` also suppresses those startup events. In either case omp-ui degrades silently: configured servers remain visible in the viewer's redacted MCP tab, but the UI does not parse `/mcp list` prose or claim that configured means connected.

The same modal is now the session-capabilities viewer (issue #374): MCP configuration plus the loaded Skills and complete registered Tools rosters of the pinned live native session. Its rosters come from a fourth per-lineage generated extension, rewritten on every spawn and passed with `-e` beside the plan, advisor, and MCP-status bridges. Following [ADR-0008](adr/0008-advisor-accounting-via-generated-extension.md) discipline, the extension patches `AgentSession.prompt` and binds the first session that prompts as the root — descendant and subagent sessions never republish the roster of the session the tab represents. Sampling is read-only by construction: skills are read as data, never loaded, refreshed, or recovered from the system prompt, and MCP ownership comes only from the scalar metadata each registered tool reports. The bridge itself is no longer purely read-only: since issue #379 it also executes one deliberate tool enable/disable, and that single mutation verb is its only write. Every settled root prompt forces a publish, an `unref`'d digest poll samples every 2 s between prompts, and the bridge stops polling when the root session shuts down.

The wire contract is the pure [`capabilities.ts`](../packages/core/src/capabilities.ts), which the renderer imports directly as a dependency-free subpath ([ADR-0002](adr/0002-transport-agnostic-core.md)); the generated source interpolates the same constants, so publisher and parser cannot drift. A snapshot publishes skills and tools as `available` rosters or an `unavailable` reason (`missing-api`, `read-failed`, `payload-too-large`), caps each description at 2048 characters, and replaces a roster that serializes past 256 KiB with a `payload-too-large` snapshot rather than shipping a partial inventory — the parser rejects an over-budget payload outright. It also publishes `toolControl` — `available`, or `unsupported` when the field is absent because the bridge predates tool control — and the latest retained `toolMutation` result, so mutability is read from the payload and never inferred from an OMP version string. Every publication carries a per-spawn `processKey` and a strictly increasing `revision`, so a reader keeps the newer revision within a process and replaces a predecessor's inventory wholesale on a new key; a separate reader-side generation counter keeps an in-flight channel read from overwriting a newer push.

The snapshot also carries omp's own magic-keyword table with its settings gate (the `magicKeywords` section): the generated bridge imports omp's exported `MAGIC_KEYWORDS` and reads `magicKeywords.enabled` plus each `magicKeywords.<id>` through omp's config registry, so a live `omp config set` republishes within the 2 s poll and the composer's glow — and the plan review's switches — follow omp's own decision rather than a mirrored table ([ADR-0036](adr/0036-generated-bridges-read-omp-settings-through-its-config-registry.md)); a session's tool requirements are checked against the published Tools roster, and an unknown gate falls back to painting every keyword.

The last snapshot that parsed is cached on the main-process `RpcLiveEntry`: transient, per-process, never persisted to the registry. Main's frame interception drops a malformed capabilities frame rather than letting it masquerade as an empty roster, and drops a killed spawn's frames rather than letting them publish into its successor's tab. Boot hydration, a late-joining renderer, and the viewer's refresh read through the generated `session:capabilities` channel — one `BACKEND_CHANNELS` entry, so the shared handler serves IPC and WebSocket with no transport-specific code — and the result maps the tab's lifecycle directly: `missing-session`, `not-live`, `terminal` for a PTY tab, `bridge-unavailable` when the extension could not be written at spawn, `starting` until the first publication, otherwise `available` with the snapshot. A Tools switch writes through the generated `session:tool-enabled` channel — one more `BACKEND_CHANNELS` entry on this seam, bound to `SessionManager`, so the shared handler again serves IPC and WebSocket with no transport-specific code, and the first in the viewer's contract that mutates a running session rather than writing configuration. It carries the `processKey` and `sessionId` the viewer observed, and main re-validates them against the live entry, so a successor under the same tab answers `stale` rather than quietly mutating the new process. Browsing the viewer never prompts the model; the bridge's session inputs are its hidden arm command at spawn and the hidden mutation command a clicked switch dispatches, and neither starts an agent turn.

Tool control adds the bridge's one write (issue #379): beside its read-only arm command the generated extension registers a strict `tool "…JSON…"` verb, and a malformed or unknown-field payload is rejected rather than falling through to the arm path. Main holds the busy barrier before it dispatches — a running turn, a queued prompt, an abort, an unresolved human-answer request, a lifecycle operation, or another tool mutation is refused with `busy`, never queued — and OMP's own `runToolRegistryMutation` is the runtime lock the verb queues on, the same queue the MCP reload chain and lifecycle paths serialize through. Completion cannot come from that verb's RPC response, which proves only that the dispatch was accepted, so the runtime retains the latest mutation result and force-publishes it into the snapshot — refusals included — and the observer confirms a change only by matching request id + `processKey` + `sessionId` + tool name + requested value inside the published roster; OMP's tool policy answers a refused change as `mode-required`, and the republished roster, never an error string, is what proves it. The request carries a 30 s main-clock deadline minted in main; past it the outcome is `unconfirmed`, never a retry, so a switch that could not be observed is never reported as moved. The plan bridge shares that queue and now owns only the temporary `write` addition it makes on Plan entry, which it removes on exit; it no longer snapshots and restores the enabled roster, so a tool the user toggled during Plan keeps that choice ([ADR-0013](adr/0013-plan-mode-as-read-only-with-on-demand-gate.md)). The unresolved human answer that gates the barrier is main-owned state: the plan-review gate rides the session summary as `pendingPlan`/`planSettle`, and the open blocking dialogs beside it as `pendingDialogs` ([`dialog-gate-tracker.ts`](../packages/desktop/src/main/dialog-gate-tracker.ts)), so every viewer — including a late joiner — reconciles one owner's list rather than a renderer-local queue left prompting after a sibling answered (issue #555).

Beside the rosters, the same three tabs carry **scoped capability catalogs**
(issue #383, [ADR-0025](adr/0025-scoped-capability-catalogs.md)): config truth
resolved at global or project scope, never a roster imitation and never a
probe session. Reads go through one core module,
[`capability-catalog.ts`](../packages/core/src/capability-catalog.ts), which
parses the omp settings layers (one `readOmpSettings` call feeds the tool
gates and the `skills.*` gates alike) and walks the SKILL.md roots from the
version-pinned table in
[`omp-capability-keys.ts`](../packages/core/src/omp-capability-keys.ts) —
shadowed losers included and labeled, omp's embedded curated skills named as
un-listable rather than guessed at. Writes route by scope and never across it:
global mutations go through `omp config set` (omp validates the value);
project mutations edit `<cwd>/.omp/config.yml` through a line-scoped editor
([`project-config-writer.ts`](../packages/core/src/project-config-writer.ts))
that preserves every untouched byte — comments included — and refuses with the
offending file and line rather than reformatting YAML it cannot read in its
two-level grammar. The catalogs reach the renderer over the
`capabilities:scoped` channels; the HUD button and the palette's global action
open them unpinned, project settings embeds them at the project's scope, and
the session-pinned viewer is unchanged.

The advisor roster (ADR-0039) adds two channels, `watchdog:roster` and
`watchdog:roster:set`, over omp's `WATCHDOG.yml`: core reproduces omp's
discovery/merge ([`watchdog-config.ts`](../packages/core/src/watchdog-config.ts)),
including omp's read-only `WATCHDOG.md` instructions-file discovery, which is
listed in the roster result but never parsed or edited (#691), and rewrites a
whole file only when it can do so losslessly. The advisor-stats frame gains
additive `advisors` and `configWarnings` fields describing the root session's
roster; aggregate cost and tokens are unchanged.

### Slash commands in native sessions

A native session's composer accepts the same slash commands as the terminal TUI. A few commands map to omp-ui surfaces and never reach the child; every other command line is forwarded to OMP.

| Composer input | Handling |
|---|---|
| `/new` | Opens a new tab session; the composer never dispatches it. |
| `/plan`, `/no-plan` (bare) | Toggle plan mode through the generated extension described above. |
| `/mcp`, `/mcp list` (bare) | Open the capabilities viewer's MCP tab for the session's own working tree. Every other `/mcp …` subcommand forwards normally — including `/mcp reload`, which the viewer's MCP footer sends. |
| `/goal …`, `/guided-goal …` | Never forwarded as prose: OMP's `/goal` spec is TUI-only, so a forwarded line would reach the model as text and start a turn that talks about the goal instead of changing it. The composer dispatches a hidden command to the generated goal bridge instead, whose reply settles the command row ([ADR-0024](adr/0024-goal-mode-in-native-sessions.md)). Terminal tabs keep forwarding the line to OMP's own TUI. |
| `/vibe …` | Never forwarded as prose: OMP's `/vibe` spec is TUI-only, so a forwarded line would reach the model as text and start a turn that talks about workers instead of spawning them. The composer dispatches a hidden command to the generated vibe bridge instead, whose published result settles the command row ([ADR-0041](adr/0041-vibe-mode-in-native-sessions-drives-omp-worker-tools.md)). Verbs the native bridge does not carry (`scope`, `undo`, …) answer with that reason rather than falling through as prose. Terminal tabs keep forwarding the line to OMP's own TUI. |
| `/btw <question>`, `/btw` | Never forwarded as prose: OMP's `/btw` is TUI-only (`handleTui`, no `handle`), so a forwarded line would become a normal model turn and pollute the transcript ([#682](https://github.com/LankfordAI/omp-ui/issues/682)). In a native tab the composer sends a hidden command to the generated side-questions bridge and opens the Side questions pane, adding no transcript row; bare `/btw` opens the pane. Terminal tabs keep forwarding the line to OMP's own TUI. |
| `/autoresearch start` | Bare `start` opens the New experiment dialog for the session's project; `start <text>` starts the experiment interview in this session with the text as the rough description ([#567](https://github.com/LankfordAI/omp-ui/issues/567), [ADR-0032](adr/0032-experiments-configured-in-conversation.md)). `/autoresearch lab` opens the Lab, likewise never forwarded. Every other `/autoresearch…` form — bare, a goal, `off`, `clear` — forwards verbatim: it is OMP's own extension command, which dispatches over rpc-ui without a dialog ([ADR-0030](adr/0030-experiments-read-autoresearch-from-two-sources.md)). |
| Any other advertised command | Forwards as a `prompt` frame with the command acknowledgement lifecycle below. |
| Unknown `/word` | Forwards as a literal model prompt. No command row appears; OMP starts a real agent turn. |

The composer's slash palette completes in two stages (`lib/slash-completion.ts`). While the command word is being typed it fuzzy-searches the roster, nesting each command's advertised subcommands under it. Once whitespace follows the word, the word is resolved exactly against the roster and only that command's subcommands are offered, fuzzy-matched by name against everything after the word; with no match the palette is not mounted, so `Enter` runs the line verbatim and never rewrites a typed argument into a completion.

A forwarded command appends a command render item in the transcript that starts `running` and settles from the `response` frame: an RPC failure settles it `failed` with OMP's own error text, `agentInvoked: false` settles it `done`, and `agentInvoked: true` settles it `agent` because the resulting agent turn renders on its own. An older runtime that omits the acknowledgement data leaves the item `running` until the matching `prompt_result`, mapped by request id, settles it `done` or `agent`, or the tab's next `agent_start` settles it `agent`. A command sent while the agent is streaming goes out unchanged; OMP rejects it and the item settles `failed`.

`command_output` frames attach to the newest running command item, joined by newlines and capped at 64 KiB with a head-preserving truncation note; with no running command item the text falls back to an info notice. OMP 17.3.8 emits `command_output` for builtin replies over rpc-ui, and the command row renders that text - in the docked transcript and, since the hero treats command rows as ambient, in the fresh-session hero footer as well. Runtimes that emit no reply leave the row settled but textless; omp-ui does not fabricate those replies from adjacent RPC state.

#### Shell commands in native sessions

A composer draft whose trimmed text starts with `!` is OMP's shell command, not a prompt ([#678](https://github.com/LankfordAI/omp-ui/issues/678)): the composer dispatches the concurrent `{ type: "bash", command }` RPC directly — no model turn, no `@`-resolution, no images — and appends one shell render item at submit. The item settles only from the command's completion response, correlated by id: `cancelled: true` settles it `cancelled` (OMP omits `exitCode` there), otherwise it settles `done` with the output (capped at 64 KiB head-preserving, like slash output) and exit code; a non-zero exit is the command's outcome, not a dispatch failure. An RPC failure or process abandonment settles the row `failed`/`cancelled` respectively; the dispatch is quiet, so a failed command never paints the session-level banner. A stop control on a running row sends `abort_bash`, which cancels every bash running in that process — OMP offers no per-command abort — and each affected row settles from its own response. The output enters the model's context through OMP's own `bashExecution` session entry, and `historyToItems` maps those entries back to shell rows on resume. `cd` inside one command does not persist to the next: the rpc path carries no session-cwd transition. Terminal (PTY) tabs keep the TUI's own `!`/`!!` handling, including its cwd tracking.

#### Ghost completion in native sessions

While the user types a prose word at the end of a native draft, the composer asks OMP to finish it and paints the answer as dim ghost text after the caret ([#715](https://github.com/LankfordAI/omp-ui/issues/715)). The engine is OMP's: `{ type: "predict_word", text, cursor }` answers `data.suffix`, a string or `null`. OMP gates the request server-side to end-of-line prose words and runs it off its serial chain, so it answers while a turn streams; a newer request replaces one still waiting, which answers `null`. A failing prediction daemon answers `success: false` and fails fast for about 30 s. `spelling.autocomplete: off` makes every answer `null`, and an OMP older than 18.4.9 answers `Unknown command:`.

The host pre-gates before asking (`wordGhostCandidate` in `lib/use-word-ghost.ts`): the caret must end the whole draft, not merely its line, because the ghost paints only in the composer's mirror and a ghost before a later line would re-wrap the mirror and drift every following glyph off the textarea (#282); a slash or `!` draft is never prose; and the draft must end in a letter, mark, or apostrophe. The composer also requires focus, a collapsed selection, a live process, no worktree conversion in flight, and no open slash or `@` palette. A request goes out 100 ms after the last edit, and every draft or caret change bumps a sequence id, so an answer for an older draft is dropped.

`Tab` accepts the ghost plus a provisional space: a typed space is swallowed into it, and any of `-.,;:!?)]}` replaces it, as in OMP's editor. `→` accepts without a space. Typing characters that match the ghost (case-insensitive) projects the remainder at once without asking again. Feedback mirrors OMP's editor: `accepted: true` on `Tab` or `→`; `accepted: false` only when an appended keystroke diverges from the ghost, carrying the pre-keystroke text, cursor, and suggestion; caret moves, deletions, blur, submit, and history recall hide the ghost silently. Feedback (`predict_word_feedback`) is sent fire-and-forget with no id: it rides OMP's serial chain, so a tracked wait queued behind a long `compact` would hit the strict budget and pollute #302's attribution. Its id-less response is dropped by `frame-reduction`.

Support is learned per process, on `TabRuntime`, from behaviour rather than version: the first `Unknown command:` answer switches prediction and feedback off until the process is replaced, and any other failure backs off for 30 s. Neither failure paints the session banner or adds a transcript item. `installedVersion` cannot decide this, since it describes the app's binary rather than the running process, and a remote instance runs its own. Ghost text stays live while the agent runs.

`open_url` extension UI requests, emitted by RPC login and OAuth flows, route to the system browser: the renderer calls `window.open`, main's window-open handler denies the window and passes the URL through `openExternalSafe`, which gates schemes to https, http, and mailto. The request is answered `confirmed: true` and the transcript records an opened-browser marker. A request without a valid URL is cancelled as before.

### Goal mode

A native session can hold an OMP goal: an objective the runtime keeps working
toward across turns, with token accounting and a budget of its own. The goal
belongs to OMP. omp-ui stores no goal of its own, meters no tokens, and asks no
model to pretend; a fifth per-lineage generated extension drives
`AgentSession.goalRuntime` and publishes what the runtime reports
([ADR-0024](adr/0024-goal-mode-in-native-sessions.md)). Whether goals are
switched on at all is read from `goal.enabled` through omp's own config
registry — the same seam the capabilities bridge uses for the
`magicKeywords.*` gate ([ADR-0036](adr/0036-generated-bridges-read-omp-settings-through-its-config-registry.md)).

The channel is an existing frame type claimed ahead of the generic extension
status: `ui.setStatus("omp-ui:goal", <json>)` publishes a `GoalSnapshot` carrying
the availability verdict and its reason, OMP's goal with its status and token
accounting, the continuation state, the pause reason, and any correlated command
result. Snapshots are monotonic per process (`revision`) and describe the payload
they carry (a digest), so a stale or duplicate publish loses to what the client
already holds and a malformed publish leaves the last good snapshot standing. Main
keeps the newest snapshot per live session, keyed on the process that answered
rather than the tab, adopts a new process key when a lineage's process is
replaced, and retires frames from a superseded bridge; `SessionSummary.goal`
carries it to late subscribers and rehydrating renderers, including remote ones.

Because rpc-ui is not one of the modes OMP's interactive continuation loop serves,
the bridge replicates that loop: after a clean `agent_end` it waits the TUI's
800 ms settle window and starts the next turn through `promptCustomMessage`,
which writes the same `goal-continuation` records and `mode` entries OMP's own TUI
would. A turn that makes no tool progress trips OMP's no-progress guard and pauses
with OMP's reason text.

Three UI surfaces read the snapshot: the composer's command family, a HUD chip
showing status and token use whose click opens the command, and Plan mode's entry
guard — an unfinished goal blocks entering Plan mode in the renderer *and* in the
generated plan bridge, so neither the raw RPC path nor a race window slips past
it. Automatic prompts (advisor reply, stall auto-continue) stand down while a goal
owns the session, and an active goal vetoes session hibernation, since hibernating
the process would kill the loop doing the work. A paused or budget-limited idle
goal owns no loop and applies no veto.

### Vibe mode

A native session can hold OMP's vibe mode: the model becomes a director that
spawns and steers worker sessions with OMP's own `vibe_*` tools. The mode, the
workers, their tiers, and their screens belong to OMP. omp-ui stores no director
of its own and re-implements no worker semantics: a per-lineage generated
extension activates the tools and drives their `execute` implementations, and
publishes what the runtime reports
([ADR-0041](adr/0041-vibe-mode-in-native-sessions-drives-omp-worker-tools.md)).

The channel follows the goal bridge: `ui.setStatus("omp-ui:vibe", <json>)`
publishes a monotonic `VibeSnapshot` — availability, the mode flag, the worker
roster (state, tier, turn count), and any correlated command result — keyed in
main by the process that answered, carried to late subscribers on
`SessionSummary.vibe`, and polled every 1.5 s while the mode is on because
workers move without a command. A command row settles from the snapshot's
`requestId` correlation, never from a model turn. On resume the bridge replays
OMP's `custom:vibe-session-lifecycle` transcript entries: a saved-on mode
survives a crashed process, workers whose transcripts survived but whose
screens did not are reported `parked`, and an explicitly killed worker stays
killed — omp-ui tombstones the kill rather than resurrecting the row.

Three interlocks keep the single persisted mode slot honest: vibe entry refuses
Plan mode and an unfinished goal; goal start refuses an active vibe mode; and
plan entry refuses an active vibe mode — each refused in the renderer's toggle
*and* in the generated bridges, so neither the raw RPC path nor a race window
slips past. The bridges' entry and exit share one transition chain under
`Symbol.for("omp-ui:mode-transition")`, and every rpc spawn arms them in the
order mcp, goal, vibe, plan, so vibe's restore re-checks the goal bridge's
restored state before re-arming a saved mode. A vibe mode with work in flight
vetoes session hibernation beside the goal veto; an idle roster owns no loop and
applies none.

### Experiments (autoresearch)

OMP's `/autoresearch` loop owns the whole experiment: the mode, the benchmark
runs, and the record. omp-ui stores no experiment of its own and writes nothing
OMP owns ([ADR-0030](adr/0030-experiments-read-autoresearch-from-two-sources.md),
issue #559); it reads from two sources, because no single seam carries the state.

The whole subsystem sits behind the app-global `experimentsEnabled` flag
(Settings → General, default off). With the flag off the spawn path never
writes `omp-ui-autoresearch.ts` into the lineage dir and never sends the arm
command, so `propose_experiment` is never registered and no snapshot is ever
published; the renderer hides every Lab and New experiment entry point and
`/autoresearch start|lab` fall through to OMP verbatim.

Live mode, goal, and tool activity come from another per-lineage generated
extension. The pure wire contract is
[`autoresearch.ts`](../packages/core/src/autoresearch.ts), which the generated
`omp-ui-autoresearch.ts` interpolates so publisher and parser cannot drift; the
bridge reduces the root session's branch (`sessionManager.getBranch()` walking
OMP's `autoresearch-control` entries) and watches `tool_execution_end`, then
publishes an `AutoresearchSnapshot` on the existing extension-status key
`ui.setStatus("omp-ui:autoresearch", …)`. `AutoresearchStatusTracker` in main
keeps the newest accepted snapshot per tab, keyed on the process that answered,
and `SessionSummary.autoresearch` carries it to late and remote subscribers. A
bridge whose API is missing publishes `available: false` with the reason rather
than a guess.

Run history comes from OMP's per-project autoresearch SQLite databases, read
directly by [`autoresearch-store.ts`](../packages/core/src/autoresearch-store.ts)
with one read-only connection per request and no write path at all — the ADR-0017
discipline, including discovery: omp-ui derives the deterministic path but never
creates a file. The renderer sends `projectCwd` plus an optional `tabId`; main
confines every read through `experiments.ts` and serves the project-proxied
`autoresearch:overview`, `autoresearch:experiment`, and `autoresearch:runLog`
channels, so a remote renderer reads the host that owns the checkout.

The renderer's `lab` slice holds the Lab's view state and the per-project cache,
and the Lab surface is a main-pane view, not a tab and not an inspector rail
pane: opening it hides the tab column, and `focusOn` closes it. Its rows link an
experiment to an owned session by effective checkout plus branch, which is also
how a session's HUD chip finds the experiment it is running.

New experiment launches sequence through the ordinary worktree spawn path:
spawn a worktree rpc-ui session on a minted `autoresearch/<slug>/<hash>` branch
(ADR-0018) with the launch recorded as provenance on the registry record, wait
for ready, apply the session's model, dispatch bare `/autoresearch` to arm
OMP's mode, then send one kickoff prompt whose fields are exactly
`init_experiment`'s parameters. A non-git project launches at the project
checkout with OMP's own warning; a jj-only workspace is refused before spawn.

An experiment's fields can also be configured in conversation (#567,
[ADR-0032](adr/0032-experiments-configured-in-conversation.md)). The autoresearch
bridge additionally registers a `propose_experiment` tool with the runtime's
`pi.registerTool`; after an interview in a native session — started by the
dialog's **Configure with the agent** button or by `/autoresearch start <text>`
— the model calls it, and the tool blocks on a `select` whose title carries the
`omp-ui:experiment-proposal:` sentinel plus the JSON spec. `frame-reduction`
intercepts that sentinel like the plan-review one and hands the spec to the
`lab` slice, which opens the New experiment dialog prefilled;
`reconcilePendingDialogs` splits the frame out of the generic queue so a late
joiner hydrates it the same way (#555). To main the select is an ordinary
blocking dialog — awaiting-answer, hibernation, and the stall watchdog need no
new tracker. Launch runs the sequence above unchanged and answers the gate with
`launched:<json>` (branch and spec as launched) only after the spawn resolves,
so a failed spawn leaves the gate pending; closing the dialog answers `revise`.
The proposing agent's `brief` rides the kickoff prompt — it is not an
`init_experiment` parameter and not launch provenance.

Two deliberate absences. There is no hibernation veto — a benchmark runs inside
a turn, so the running-turn probe already covers the work, and OMP replays its
control entries and re-checks the branch on resume — and there is no Plan-mode
interlock, since the loop and the read-only guarantee are OMP's. OMP's own
`autoresearch` `setWidget` frame is answered (OMP blocks on the reply) and
swallowed in native tabs: its content is the snapshot and the Lab.

### Advisor

Advisor enablement and model selection are session state. Core writes a per-lineage `--config` overlay, and a change relaunches a live child with `--resume` because OMP binds the root advisor at process start. A second generated extension treats the root switch as a ceiling on every task descendant before its prompt starts. It also publishes root advisor configuration and context together with session-tree advisor cost and token totals over an existing extension status key. Advisor notes remain structured transcript events. Renderer logic handles the bounded late-review fold and idle-session reply; the transport and server do not interpret advisor content. See [ADR-0005](adr/0005-session-scoped-advisor-via-config-overlay.md), [ADR-0008](adr/0008-advisor-accounting-via-generated-extension.md), [ADR-0009](adr/0009-late-advisor-concerns-folded-into-plan-execution.md), and [ADR-0012](adr/0012-advisor-reply-on-idle-sessions.md).

A dev/test spawn gate ([#371](https://github.com/LankfordAI/omp-ui/issues/371), [#372](https://github.com/LankfordAI/omp-ui/issues/372)) puts the gate on the same contracts: the gate's model and advisor selectors go into the same `--model` argument and `omp-ui-advisor.yml`/`omp-ui-model.yml` overlays, and the renderer displays them as read-only `DEV/TEST` choices in the composer chips and PlanReview's implementation setup whenever `spawnGate` is present in app state. The gate is display-only downstream of spawn resolution: the on/off switch and model pickers keep editing the registry record, which the gate never rewrites — so an ungated relaunch and a running gated instance disagree only in the overlay, which is exactly the point of the seam.

### Rewind and the session tree

Rewinding a native session to an earlier prompt rides OMP's existing `branch` RPC: the renderer never rewrites the session file, and the abandoned turns stay in it as another branch. A hover chip on each user row (`packages/desktop/src/renderer/src/components/TranscriptView.tsx`) stages the action; the click is refused while the tab is streaming, because `branch` clears OMP's own prompt queue and a refused click is honest while a queued one is not ([#680](https://github.com/LankfordAI/omp-ui/issues/680)).

omp-ui's transcript render items do not carry OMP entry ids, so a row-to-entry correlation is positional: the k-th visible user row maps to the k-th user-message entry on the leaf path (`lib/session-rewind.ts` walks `get_entries`' entries from `leafId` to the root, honoring a compaction's `firstKeptEntryId` truncation) and is verified by re-deriving the row's text from the entry through the same `userContentFromContent` used at ingest. A mismatch refuses the action rather than rewinding to the wrong entry. The accepted confirmation (`{kind: "rewind"}` on the one-pending-confirmation lifecycle) dispatches `branch` with the entry's id; a `cancelled: true` response (a hook veto) reloads nothing. Edit-and-resend captures the prompt into a per-tab snapshot map (cleared with the tab runtime in `disposeTabRuntime`) and, after the branch lands and history reloads, hands the text and images to the new branch's composer queue — never a silent replace-the-draft path. Because `branch` with the first user entry reparents to a brand-new session id in the same lineage directory, the file watcher adopts the new header id and the quiet `get_state` that follows merges identity belt-and-braces.

Jumping to an arbitrary tree entry — an assistant turn, or a sibling branch left by an earlier rewind — needs `AgentSession.navigateTree(entryId, { summarize })`, which is in-process only: OMP's rpc surface reads the tree (`get_tree`) but has no dispatch case that jumps. Per ADR-0007/0024 that makes this one more per-lineage generated bridge, `tree-extension.ts`, beside the plan, advisor, capabilities, goal, and autoresearch bridges. Its pure wire contract is [`session-tree.ts`](../packages/core/src/session-tree.ts), which the renderer imports directly as a dependency-free subpath ([ADR-0002](adr/0002-transport-agnostic-core.md)) so publisher and parser cannot drift. The bridge reduces the session manager's tree to a `TreeSnapshot` — flattened nodes with a 160-character preview each, the leaf id, and the leaf-to-root `activePath` — and publishes it as JSON on the existing extension-status key `omp-ui:tree` with a monotonic `revision`, republishing on branch and turn-end events; a payload past 256 KiB publishes `available: false` with `payload-too-large` rather than a partial roster, and the parser rejects an over-budget publish outright so the last good snapshot stands. An API the runtime does not expose reads `missing-api`, never an empty tree. Navigation rides the hidden `/omp-ui-tree navigate <id> [summarize]` command; because the prompt acknowledgement proves only that the dispatch was accepted, completion settles from the snapshot's `navigation` field — same correlation discipline as the goal bridge — with the summarize path polled longer since it can run a model turn. The `SessionTreeViewer` modal (HUD `tree` control, command palette) renders the snapshot: prompt rows rewind through the entry id directly (`stageRewindEntry`), other rows stage a navigate confirmation naming the discarded-entry count, optionally asking the model to summarize the abandoned turns.

Side questions (`/btw`, [#682](https://github.com/LankfordAI/omp-ui/issues/682)) are one more per-lineage generated bridge, `side-questions-extension.ts`, beside the plan, goal, tree, and limits bridges. OMP's `/btw` is TUI-only and its `BtwController` never runs under rpc-ui, so the bridge drives `AgentSession.runEphemeralTurn` — the API that controller uses, which reuses the main context and appends nothing to the transcript — and keeps OMP's own `btw-history/entry-<id>.json` grammar (strict keys, revision-guarded atomic writes), so a topic started here is browsable in OMP's TUI overlay. The bridge is the single reader and writer of that directory for a native tab and publishes a `BtwSnapshot` (topics, running turn, one-shot busy refusal) over `ui.setStatus("omp-ui:btw", …)`; there is no main-process file channel, so remote instances need no extra IPC. Its pure wire contract and file grammar mirror live in [`side-questions.ts`](../packages/core/src/side-questions.ts). One question runs at a time; state is keyed on `(sessionId, artifactsDir)` and re-read on session switch, so hibernation, resume, and lineage switches show the right topics.

Subagent control (steer/kill/revive, [#684](https://github.com/LankfordAI/omp-ui/issues/684)) is one more per-lineage generated bridge, `subagent-control-extension.ts`. omp's rpc surface reads the roster (`get_subagents`) but exposes no verb that touches one agent: `AgentLifecycleManager.ensureLive`/`release` and the `AgentRegistry`'s live session refs are in-process only ([ADR-0040](adr/0040-subagent-control-via-generated-bridge.md)). The bridge binds both through their literal registry subpaths and static `.global()` accessors — a failed import degrades every verb to a `missing-api` refusal, never a crash — replays Agent Hub's exact order and refusal sentences (kill aborts the session first, then releases with a tombstone so the row and its `history://` transcript stay readable), and publishes each settled result over `omp-ui:subagent-control`. The pure contract is [`subagent-control.ts`](../packages/core/src/subagent-control.ts), which the renderer imports directly as a dependency-free subpath ([ADR-0002](adr/0002-transport-agnostic-core.md)). Dispatch rides a hidden quiet prompt (the goal/btw precedent, issue #680) correlated by `requestId`; results are transient chrome ring-capped at 16, never roster truth — `get_subagents` remains the read side, and a roster refresh follows every settled verb. The Agents pane and the SubagentView banner gate their controls on the roster's own status: live statuses steer and kill, `parked` revives and kills, anything else offers nothing; PTY tabs keep omp's TUI UX because the hidden frame cannot ride a terminal. Hibernation refuses to kill a tab whose `get_state` probe reports `hasPendingAsyncWork` — 18.4.2's `get_state` has no `subagentCount`, and a background child is an asyncJobManager job — with a strictly-parsed probe where a missing field means "cannot verify" and rearms instead.

### App feedback host

Session and project lifecycle confirmations and backend error notices render through one feedback host (`AppFeedback`) as DOM `alertdialog` elements on the shared overlay stack — never `window.alert` or `window.confirm`, which blocked the renderer and were undrivable for tests and remote clients ([#373](https://github.com/LankfordAI/omp-ui/issues/373)). The host shows one dialog at a time: the oldest error notice outranks a pending confirmation (the confirmation stays staged), dismissing the last notice restores it, and while an accepted effect is in flight the dialog is locked against dismissal to prevent double dispatch. All dialog state lives in the store (`errorNotices`, `lifecycleConfirmation`); the lifecycle slice re-checks its target on acceptance, so a session or project that changed while the dialog was open resolves safely.

### Updates

omp updates and omp-ui application updates are separate state machines. For the application, core handles release lookup, package detection, and checksum-verified downloads. For omp, core selects the release binary, validates the temporary executable, and replaces the managed copy atomically. Desktop main owns background-check policy, dismissal state, progress events, Electron package staging, installer handoff, and guarded restart or quit. The remote server only transports the same update channels. See [Releases](releases.md) for supported package policy.

### Remote transport

Desktop main owns whether remote access is enabled, its bind address and port, its token, its password hash, and server restart policy. `@omp-ui/server` owns HTTP delivery and authentication, both `/ws` and paired `/ws/frames` upgrades, JSON request routing, and event fan-out. Both sockets accept the minted token or a password-derived session credential; a frame socket additionally needs the key of a live reliable connection. The server has no registry or session implementation beyond `RemoteHost`. Reliable-connection loss reloads and rehydrates the browser; frame-only loss reconnects independently and replays the latest eligible image without interrupting reliable traffic. See [Remote access](remote-access.md) for trust and network constraints.

#### Remote instances

A [remote instance](remote-instances.md) is another omp-ui app this one has joined as a client ([ADR-0028](adr/0028-remote-instances-joined-by-main-process-proxy.md)). Desktop main owns the join end to end: `RemoteInstanceManager` holds one paired transport client per joined instance, signs in once with the password or takes the token from a pasted token link, and persists only the derived credential — encrypted by the OS `KeyCipher` in `remote-instances.json` beside `registry.json`, handled like `provider-keys.json` (`0600`, never read by the diagnostic bundle, refused when no credential store exists). The desktop renderer never sees a credential or a socket; it keeps its single `OmpBackend`.

The join is a handshake, not a bare connection. After the reliable and frame sockets are paired, main asks `instance:identity`; a rejection naming an unknown channel marks the remote *incompatible*, and an `instanceId` equal to this app's own persistent registry `instanceId` marks it *self*. Otherwise main reads the remote's `state:get`, adopts only its `projects` and `modelFavorites`, and publishes them as `BackendState.remoteInstances[i].projects` / `.modelFavorites`. Local `projects` and local `modelFavorites` stay local-only — a remote tab's model palette reads that instance's favorites, never this app's — and the proxy never reads a remote's own `remoteInstances`, so joins are one level deep and an A↔B mutual join cannot recurse.

Routing is by tab id. Every request or notification in `TAB_ROUTED_REQUESTS` / `TAB_ROUTED_NOTIFIES` (from `core/remote-instances.ts`) carries the owning `tabId` first; `routeByTab` wraps `MainBackend.handlers()` so a tab owned by a joined instance is forwarded to it and every other tab runs locally, with `session:spawn` routed by `resumeTabId` only for a resume. Project-scoped calls reach a remote through `remote-instance:request` and `remote-instance:notify`, which forward only channels in `REMOTE_PROXY_CHANNELS` — registry and session lifecycle, branches, worktrees, MCP and capability catalogs, project files — plus one app-scoped entry, `favorites:toggle`, addressed by `instanceId` because a favorite belongs to the instance, not to a session or project. Host-local opens, settings, updates, providers, remote access, diagnostics, and the remote's own remote-instance channels are refused. The renderer builds one thin `OmpBackend` per instance over those two channels for project-scoped actions and keys its project maps by `projectKey(instanceId, path)`.

Model choice follows the owner end to end. The palette's catalog rides the tab-routed rpc path — the live session's own `get_available_models` over `rpc:send` — so a remote tab lists the models its host's session reports; favorites come from that instance's projection; and project model pins (`project:setDefaultModel`, `project:setDefaultAdvisorModel`) plus advisor defaults (`advisor:defaults`) ride the project channels, so they read and write the remote's own registry. A remote tab whose host reports no catalog never opens this app's Providers page — it shows noninteractive guidance naming the instance, because provider credentials are host-local.

Events are filtered the same way. Channels in `REMOTE_TAB_EVENTS`, including terminal output and `browser-pane:frame` / `browser-pane:state`, are mirrored into local sinks unchanged: the transport envelope is removed at receipt, but terminal bytes and JPEG payloads are not re-encoded across either hop. A remote `state:changed` replaces that instance's `projects` and `modelFavorites` and triggers a local broadcast, with a partial or malformed payload keeping the last good projection rather than clearing either; every other remote event — update state, remote-access state, the remote's own notifications — is dropped. One event is converted rather than mirrored (issue #498): the host's `branch:changed` carries `instanceId` null because it is host-scoped, so `RemoteInstanceManager` re-stamps it with the joined instance's id and delivers it to local renderers only — never into the sink set, so a converted event cannot re-enter a socket relay and loop across a mutual join. The viewed-tab hibernation exemption follows the viewer: `tab:viewed` runs locally and is then forwarded to the owning instance, with a `null` sent to the instance the client just left, and `stall:cap` follows its tab.

A dropped reliable socket after a successful join marks the instance *unreachable*, keeps its projects, favorites, and tab ids, and schedules a reconnect with capped backoff (1 s doubling to 30 s). A `401` marks it *sign-in required* and stops retrying. Frame-only loss instead reconnects the companion in place (500 ms doubling to 5 s); it does not cycle the join or interrupt PTY/control traffic. On full rejoin the renderer re-boots each open rpc-ui tab, re-sends `pty:resize` for each terminal tab, and drops tabs whose sessions vanished. `killAll()` stops every remote client before the local server, so quitting disconnects cleanly and leaves the remote's sessions running.

### Live sharing (Collab)

OMP owns Collab hosting entirely; omp-ui only opens rooms, reads them, and closes them, and only for terminal tabs — `/collab` lives in the TUI, and the RPC protocol exposes no collab surface, which the UI shows as an unavailable dialog rather than silence ([#686](https://github.com/LankfordAI/omp-ui/issues/686)). `CollabTracker` (main) polls `omp collab list --json` on a fixed cadence while at least one PTY child is live and matches registry rows to tabs by OS pid, so a foreign host — an `omp` the user started outside omp-ui — is never surfaced: rows only matter when their pid is one of ours. A probe failure or a missing binary holds the last snapshot rather than flashing every tab off. Share and stop are keystroke routes: `/collab`, `/collab view`, or `/collab stop` goes into the tab's PTY — the same channel every other terminal input uses — and success is the registry row appearing or clearing on a later poll, never an assumed round-trip; a share with no row within the settle window rejects with omp's own doubt. Join links come from `omp collab link <pid> [--view] --json`, fetched on demand — the room key lives in the link's URL fragment, so the renderer holds links only while the Share-live dialog is open, and the registry's generation counter (omp re-rooms on `/new`, `/resume`, and branch switches) re-fetches them on rotation. Per-tab snapshots broadcast on change only, mirror into the `collab` store slice (absent row is off), and retire with the tab. A terminal tab's chip, the dialog, the palette action, and the first-share privacy gate read that slice and nothing else. See [Live session sharing](collab-sharing.md) for the user-facing trust model.

### Browser pane

Desktop main owns the pane. `BrowserPaneHost` (`packages/desktop/src/main/browser-pane-host.ts`) keeps one offscreen `WebContents` per live rpc-ui tab in the app-wide `persist:browser-pane` partition. Native paint delivery stays stopped, and the page-zoom density model and 30 fps ceiling apply to both capture paths below. The host's device-emulation override is cleared before being set only when it re-asserts params its debugger session last applied or that state is unknown; a size-changing resize sets directly, because Chromium applies new params without the clear (identical re-sends are dropped). The #653 probe matrix found the accelerated-canvas resize loss in the window's own surface resize, not that emulation cycle, so the condition is params bookkeeping; the loss itself is an open upstream bug with no host-side workaround.

A local desktop viewer uses tab capture (#651). Main mints a single-use `webContents.getMediaSourceId(requester)` lease bound to the requesting window, plus a matching single-use permission grant on the pane partition (`createMediaCaptureGrants`, `browser-pane-guard.ts`): Chromium asks the *captured* page's session to approve the capture, and every other permission, including page camera and microphone requests, stays denied. `renderer/src/lib/browser-pane-media.ts` opens the stream with `getUserMedia({chromeMediaSource: "tab"})`, reads it through `MediaStreamTrackProcessor` with a one-frame buffer, draws each `VideoFrame` to the canvas and closes it. No pixels pass through the main process. Each lease names a page generation, which strictly increases when a page is created or destroyed; main sends `media-geometry` on resize and on subscribe/port-ready replay, and `media-ended` on page destruction, so the renderer asks for exactly one new lease per change instead of polling. Chromium captures odd dimensions at the next lower even size and resamples, so after the root metrics override resolves the host pads the compositor surface to even dimensions. The CSS viewport and devicePixelRatio stay unchanged; the renderer crops to the logical pixels. A desktop viewer keeps its page alive but does not start CDP capture.

Remote viewers and joined remote-instance panes keep JPEG. `browser-pane-capture.ts` owns a private flattened CDP session and requests JPEG screencast frames from Chromium, whose encoder runs off the JavaScript main thread. Capture requires a committed document and a JPEG viewer; it uses quality 70 while loading and 85 when settled. Only the newest unpublished encoded event is retained, and every event receives its own CDP ACK, including repeated tokens and discarded frames. A generation fence prevents late attach results or old-document frames from entering a replacement stream. Capture errors appear in the existing pane state, without a native-paint fallback or automatic retry loop.

Main parses JPEG SOF dimensions, trims an even-surface padding column or row by rewriting only the SOF size (`trimJpegToWidthHeight`; no re-encode), assembles the unchanged eight-byte header once, caches the frame, and publishes `browser-pane:frame` to sinks. Remote delivery retains its authenticated paired WebSocket protocol and independent credit. No relay re-encodes JPEGs. Diagnostics report `lastFrameProcessMs` for base64 conversion, JPEG-header inspection and wire assembly, not Chromium's compression time. Hidden desktop panes stop their capture track and retain no active canvas writer; remote-only viewing causes no desktop work.

Each successful paint reconciles frame metadata through the store's equality guard. This restores screenshot attachment readiness after clear-data recreation even when the mounted painter's dimensions have not changed (#655), without storing image bytes or repeatedly publishing unchanged metadata in React state. Screenshot attachments come from the painter: the JPEG painter returns its last frame, and the media painter encodes the canvas at quality 0.85 on demand.

The host applies renderer input from `browser-pane:input` and exposes the page to the agent through the loopback, token-pathed CDP bridge (`browser-pane-bridge.ts`). The generated `omp-ui-browser-pane.ts` extension delivers that endpoint as one hidden message. The private capture session is not an agent client, and its events never reach agent-owned sessions. `browser-pane:pick` is tab-routed for the element hand-back; app-scoped `browser-pane:clear-data` clears only this host's partition. The endpoint lives with the live rpc tab; the page is created on first open or first agent attach, survives a process restart, and is destroyed with hibernate, delete, and a switch to terminal mode. Renderers hold no page handle: they receive frames and JSON state and send JSON input. See [ADR-0029](adr/0029-browser-pane-offscreen-webcontents-and-loopback-cdp-bridge.md).

With a project's `browserClock` on, the bridge passes each forwarded `Page.captureScreenshot` result through `BrowserPaneHost.stampScreenshot`, which stamps the image in the main-owned `clock-stamper.html` page (`ClockStamper`) using the renderer's `lib/clock-stamp.ts`. The renderer uses the same library for the camera and pick hand-backs.

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
| [Prepared plan documents are verified in the renderer before presentation](adr/0022-prepared-plan-verification-in-the-renderer.md) | Verify a prepared HTML plan structurally and with a script-less layout probe; amended (#312 follow-up): main owns the submission gate for every client ahead of review, and the renderer check stays as each surface's final local verification. |
| [Goal mode, driven by the same generated-extension discipline](adr/0024-goal-mode-in-native-sessions.md) | Run the `/goal` family in native sessions against OMP's own goal runtime, published as a monotonic snapshot instead of forwarded prose. |
| [Glass chrome via backdrop-filter](adr/0026-glass-chrome-via-backdrop-filter.md) | Make chrome planes translucent over an achromatic backdrop wash with backdrop-filter, keeping the reading plane and terminals opaque. |
| [The web-search provider list is discovered from omp](adr/0027-web-search-provider-list-discovered-from-omp.md) | Probe the installed binary for its provider ids instead of transcribing a catalog, and degrade to configured ids only when discovery fails — superseded by [ADR-0035](adr/0035-web-search-provider-list-read-from-omp-model-catalog.md): the enumeration source is now the model catalog. |
| [Remote instances are joined by the main process, not the renderer](adr/0028-remote-instances-joined-by-main-process-proxy.md) | Let desktop main dial each joined omp-ui app, hold its credential, merge its projects into backend state, and route tab-scoped traffic by tab id, so the renderer keeps one backend and every client sees the same joined instances. |
| [The browser pane is an offscreen WebContents streamed to renderers and bridged to the agent over loopback CDP](adr/0029-browser-pane-offscreen-webcontents-and-loopback-cdp-bridge.md) | Render the shared page offscreen in desktop main, stream JPEG frames on a lossy event to every view, take input back as JSON, and hand the agent a host-local, token-pathed CDP endpoint through a generated extension — never a WebContentsView, never omp's Chromium, never `--remote-debugging-port`. |
| [Experiments read autoresearch from two sources](adr/0030-experiments-read-autoresearch-from-two-sources.md) | Take live autoresearch state from a generated bridge over the existing `setStatus` frame and run history from OMP's own SQLite databases, read-only per request, since no rpc command, no extension-importable storage, and no wire-visible control entry can carry either alone. |
| [Subagent model selection via omp's config layers](adr/0031-subagent-model-selection-via-config-layers.md) | Edit `task.agentModelOverrides` at Global, Project, and a live per-lineage overlay scope, with a roster-expanded `"*"` umbrella at Session scope so subagents default to the session's own model. |
| [Experiments configured in conversation](adr/0032-experiments-configured-in-conversation.md) | Let the main model propose an experiment through a bridge-registered `propose_experiment` sentinel select the New experiment dialog answers — no one-shot drafting, no loop in the interview session, no main-process gate tracker. |
| [Proposed plans outlive their process; the review gate does not](adr/0033-proposed-plans-outlive-their-process.md) | Persist each proposal and its verdict on the owned session record, derive an interrupted plan from a pending record with no live gate, and re-raise a real review through the plan extension's review verb — never a gate-less execute, never a re-propose turn. |
| [The web-search provider list is read from omp's model catalog](adr/0035-web-search-provider-list-read-from-omp-model-catalog.md) | Enumerate web-search providers from `omp models --kind search --json` under a pristine environment — designed JSON, offline, credential-free — keeping ADR-0027's closed-list contract and synthetic-reason degradation. |
| [Generated bridges read omp settings through its config registry](adr/0036-generated-bridges-read-omp-settings-through-its-config-registry.md) | Read the effective value with a literal dynamic import of omp's config registry and `lookup(id).get(session.settings)` — layered, live, read-only — because 18.3.2's `Settings` has no string-key `get` and every alternative either writes or guesses. |
