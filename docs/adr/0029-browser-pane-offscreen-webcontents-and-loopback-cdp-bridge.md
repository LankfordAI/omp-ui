# The browser pane is an offscreen WebContents streamed to renderers and bridged to the agent over loopback CDP

The **browser pane** (issue #519) is a live web page inside an rpc-ui tab that
the user and the agent share: a Vite dev server, a static export, a component
playground, opened once and looked at by both. Electron already ships Chromium,
omp's `browser` tool already drives a Chromium of its own, and the frameless
omp-ui window already composites everything the user sees in one renderer, so
the obvious readings were to embed a `WebContentsView` in the window, to mirror
omp's Chromium into the shell, or to point omp at Electron's own
`--remote-debugging-port`. We took none of them.

We decided that the page is an **offscreen `WebContents` owned by the main
process**, delivered to every view as a frame stream, and reached by the agent
through a **loopback CDP bridge** the main process hosts:

- Desktop main creates one hidden `BrowserWindow` per live rpc-ui tab with
  `webPreferences.offscreen`, in the app-wide `persist:browser-pane` partition,
  with `sandbox`, `contextIsolation`, no `nodeIntegration`, and no preload
  (the plan verifier's isolation recipe). `paint` frames are `toJPEG(70)` at
  `setFrameRate(30)` only while a renderer is subscribed; the pane follows the
  app's hardware-acceleration setting. Every frame carries an eight-byte header
  (`u16` width, height, dsf×100, reserved) so a frame and its dimensions can
  never arrive out of order.
- Frames ride the existing structural binary rule of `@omp-ui/server` on a
  new `browser-pane:frame` event declared **lossy** in `BACKEND_CHANNELS`. The
  server skips a client whose socket buffer is over 256 KiB for lossy events
  only; `pty:data` and `shell:data` are never dropped. Main caches the last
  encoded frame per pane and replays it to each new subscriber.
- Renderers send JSON back: `browser-pane:input` mirrors Electron's
  `sendInputEvent` unions plus `insertText` and macOS edit verbs, in CSS px;
  `browser-pane:navigate`, `browser-pane:resize` (desktop renderers only —
  other views scale the frame and map coordinates through its header), and
  `browser-pane:subscribe`. All seven channels are tab-routed, so a joined
  instance's pane streams through this app with one relay hop (ADR-0028).
- The agent reaches the page through one loopback, token-pathed listener per
  live rpc tab that shims Chrome's browser-level `Target`/`Browser` domains
  over `webContents.debugger`: `getBrowserContexts`, `setDiscoverTargets`
  (plus a synthetic `browser` target), `setAutoAttach` (attach Electron's
  `tab` target before replying), `createTarget` aliased to the one page,
  `closeTarget`/`Page.close` faked, `Browser.close` swallowed; every other
  command is forwarded with its session id unchanged. One page per pane: omp
  never calls `newPage`, and puppeteer's `newPage` aliases to the same page.
- The agent learns the endpoint from a sixth generated `-e` extension,
  `omp-ui-browser-pane.ts`, armed by a hidden slash command in
  `initialCommands` at every rpc spawn. It delivers **one** hidden custom
  message (`display: false`) naming `browser.open({ app: { cdp_url } })` and
  the endpoint's rules, re-queued after a compaction or branch switch. No prompt
  suffix, no system-prompt append: about 180 tokens once per omp process, and
  the provider prefix cache is left intact.
- The endpoint lives with the live rpc tab from spawn; the page is created on
  first user open or first agent attach, whichever comes first. The pane
  survives a process restart under the same tab, and is destroyed with
  hibernate, delete, a switch to terminal mode, and quit. The user closing the
  pane only unsubscribes; the page keeps running for the agent. When the agent
  attaches while the pane is closed, the renderer opens it: the agent never
  acts on a page the user cannot see.
- Both drive, always. Input is never blocked; the bridge derives an agent state
  (`detached | attached | acting`) from the commands it forwards and the
  renderer badges it. The hand-back is a screenshot **Attachment** (the last
  frame) plus the page URL as prompt text, queued into the composer through a
  store seam — never sent on the user's behalf.
- Page content is untrusted input to the agent. Everything the agent reads from
  the pane — DOM text, screenshots, console output, accessibility snapshots,
  `tab.extract` results — is authored by the site and may carry instructions
  aimed at the model. omp-ui cannot sanitise it: the bytes cross the bridge as
  CDP payloads forwarded verbatim, and any filter that could alter them would
  also break Puppeteer. What omp-ui owns is the page's *reach* — partition,
  permissions, downloads, navigation, and the bridge's gates — not what the
  page says. A hostile page can attempt prompt injection exactly as a hostile
  file read by the `read` tool can; the user directs the agent at pages they
  trust.
- The bridge defends against web content — in the pane and in the user's other
  browsers — not against processes running as the user, which already own the
  machine and the agent's shell. It binds `127.0.0.1`, requires an exact
  `Host`, answers any `Origin` with 403, gates the WebSocket on a 256-bit token
  path, answers the un-tokened `/json/version` puppeteer fetches only within
  five seconds of a tokened hit, caps clients at eight, and the pane's own
  partition may never request a loopback URL on a live bridge port or the
  remote-access port. The agent runs on the owning instance and reaches the
  pane only there; no channel ever carries the endpoint to a renderer.

## Considered options

- **`WebContentsView` in the app window (rejected).** Electron paints a
  `WebContentsView` above every DOM overlay by design on all three platforms
  (`electron_api_browser_window.cc`), so dialogs, sheets, the command palette
  and the plan review would render under the page; its bounds are main-process
  integer DIPs deferred while hidden; Linux rounds only the primary web
  contents, so the pane overdraws the frameless window's corners; window-control
  buttons stay above it; and a third-party page could declare
  `app-region: drag` and hijack the frameless window. Offscreen rendering keeps
  the same Chromium and the same isolation and composes as an ordinary DOM
  element.
- **Mirror the Chromium omp's `browser` tool launches (rejected).** omp's
  managed Chromium publishes no CDP endpoint omp-ui could adopt without an
  upstream change, which omp-ui does not request; `app.relay` needs an MV3
  extension inside the user's own Chrome plus a relay daemon, so it is not
  reusable for a page omp-ui owns; and the agent's tab handles, idle-freeze and
  idle-close rules would apply to the user's page. One engine — omp-ui's —
  serves both, with the agent attaching as a CDP client.
- **Electron's `--remote-debugging-port` as the product endpoint (rejected).**
  The switch is Chromium-wide and tokenless: it exposes omp-ui's own renderer,
  and therefore its IPC bridge, to any local process. It stays the developer
  seam `OMP_UI_CDP_PORT` already is, documented as also exposing pane targets.
- **A sixth inspector-rail pane (rejected).** The rail's width budget is a
  readable-todo-list wide, not a readable-page wide, and the prototype confirmed
  it; the pane is a split beside the transcript with a full-column mode, and
  the rail stays "five panes".
- **A dedicated tab kind (rejected).** A Tab is the renderer's view onto a live
  session's process; the browser pane is a view onto the *same* live session,
  like the subagent view, and its lifetime is that session's.
- **Prompt-suffix routing context for the endpoint (rejected).** The attachment
  routing pattern puts text in every prompt of the session file, needs a strip
  on render, and would require the *viewing* renderer to hold a host-local URL
  for a tab another instance owns. A hidden custom message is conversation
  content: append-only, invisible to the transcript, and armed by the owning
  main process.
- **Per-client frame throttling in main (rejected).** One encode per paint and
  the server's lossy skip is the whole backpressure story: a slow phone drops
  frames rather than slowing the desktop, latest frame wins once it drains, and
  main keeps no per-sink state.

## Consequences

- **Frame cost is bounded and measured.** Encoding is ~4 ms at 1280×800 and
  ~15 ms at 2560×1600 on the Linux reference, ~13–40 KB per frame; at 30 fps
  and 1080p that is under a quarter of the main thread. Idle pages paint
  nothing, but a focused caret repaints a full frame every 600 ms. If a platform
  smoke measures p90 encode over 16 ms, the dsf is clamped to a pixel budget
  first and the frame-rate constant lowered second; a row whose fallback fired
  is recorded here with the measured value.
- **HiDPI is best-effort.** `offscreen.deviceScaleFactor` is honoured on X11,
  Windows and macOS and ignored on Wayland (the header simply says 1 and the
  renderer upscales). Monitor moves after creation are not chased in v1.
- **One loopback listener per live rpc tab, from spawn.** An idle tab costs one
  socket and no Chromium resources; the page and its renderer process exist
  only after first use. The token rotates with the listener.
- **The partition is a browser profile.** Cookies, storage and cache persist
  across restarts and tabs under `userData`, so a dev-app login survives; a
  "clear browser pane data" action is a follow-on. The agent can read what the
  user logged into — the shell it already holds can read the same files.
- **Remote views are first-class but not equal.** Browser clients and joined
  instances see the live pane and drive it; only desktop renderers size it.
  Both relay hops are lossy; nothing is re-encoded because the header travels
  in-band. An unreachable owner leaves the last frame dimmed under the
  remote-instance banner with input held; rejoin resubscribes.
- **Platform gates are smokes, not assumptions.** Offscreen paint on GPU and
  software paths, dsf, input into an unfocused hidden window, OS keymaps, ⌘
  chords, right-click semantics, non-ASCII `insertText`, the omp handshake,
  `file:` cancellation, disposal, LAN streaming, throttling and cross-instance
  sizing each have a spike or smoke command, a pass value, and a prescribed
  fallback. No real-Electron CI lane exists; runner adoption is a follow-on.
- **omp is unchanged.** Everything rests on what omp exposes today: the
  `browser` global with `app.cdp_url`, its adoption of the existing page target,
  disconnect-only `tab.close`, and the extension API's `registerCommand`,
  `sendCustomMessage` and session events. omp's `tab.click` hang against every
  CDP target is worked around in the hidden message (`tab.run` + `page.click`),
  not fixed here.
