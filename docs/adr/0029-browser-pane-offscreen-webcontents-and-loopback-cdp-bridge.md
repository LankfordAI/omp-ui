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
  (the plan verifier's isolation recipe). Native painting stays stopped; the
  offscreen frame rate and every publication ceiling remain 30 fps.
- A **local desktop viewer uses Chromium tab capture** (#651). Main mints a
  single-use `webContents.getMediaSourceId(requester)` lease for the
  requesting window's top-level frame and records a single-use, 10-second
  permission grant for that page. Chromium asks the captured page's session
  to approve tab capture; the pane partition approves only a `media` request
  with no media types from the lease's requester origin and keeps denying
  everything else. The renderer reads the `MediaStream` through
  `MediaStreamTrackProcessor` with `maxBufferSize: 1`, draws each `VideoFrame`
  to the canvas and closes it. Leases carry a page generation that strictly
  increases on page creation and destruction; main sends `media-geometry` on
  resize and on subscribe/port-ready replay and `media-ended` on destruction.
  The renderer requests one lease per change and never polls. Because Chromium
  captures odd dimensions at the next lower even size and resamples, the host
  pads the compositor surface to even dimensions after the root metrics
  override resolves; CSS viewport and devicePixelRatio stay unchanged, and
  the renderer crops to the logical pixels.
- **Remote viewers and joined remote-instance panes keep JPEG.** Chromium
  encodes a private flattened CDP session's screencast at quality 70 while
  loading and 85 when settled, without `maxWidth` or `maxHeight`. CDP capture
  starts only after document commit and while a JPEG viewer is subscribed;
  a desktop tab-capture viewer keeps the page alive but never starts it. Main
  keeps one unpublished encoded event, replaces it with the newest, and ACKs
  every event once on its originating session. Repeated ACK tokens are not
  deduplicated. JPEG SOF markers supply each frame's physical dimensions; an
  even-surface padding column or row is removed by rewriting only the SOF
  size, which is valid because a trailing odd pixel never changes a
  component's block grid for sampling factors 1–2. The unchanged eight-byte
  header (`u16` width, height, dsf×100, reserved) keeps the logical
  dimensions with the JPEG, including frames racing a resize.
- Desktop pane media bypasses contextBridge through a main-owned MessagePort.
  Its fixed-channel handshake accepts only the window's current top-level frame;
  preload transfers the port into the main world without exposing ipcRenderer.
  For local panes the port carries only lease requests, leases and geometry
  notices. For joined remote-instance panes main filters subscriptions before
  structured-cloning bytes, allows one image awaiting ACK per window, and keeps
  the newest pending frame per subscribed tab with fair scheduling. ACK follows
  canvas paint or intentional drop, not callback entry. Port generations fence
  stale ACKs and delivery IDs never reset; port replacement settles pending
  lease requests as `null`. Reload, renderer crash and window teardown release
  upstream subscriptions and desktop viewers; an ordinary port replacement
  retains them. Hidden panes stop their capture tracks and dispose their writers.
- `browser-pane:frame` remains **lossy** in `BACKEND_CHANNELS`, but remote
  images travel only on a separate authenticated `/ws/frames` WebSocket.
  The reliable `/ws` connection supplies a random 256-bit pairing key; the
  frame connection requires both that live key and ordinary remote auth.
  It cannot issue backend calls or outlive its reliable connection.
  Each pair admits one frame awaiting its exact sequence ACK and retains
  only the newest pending frame per subscribed tab, with fair tab scheduling.
  A browser ACK follows paint or intentional drop; a joined main process
  ACK follows its local relay handoff, whose downstream frame pairs have
  independent bounds. No viewer waits for another viewer's ACK. The existing
  eight-byte pane header is unchanged inside the sequenced transport envelope.
  Main caches one unchanged encoded JPEG frame per pane for new viewers.
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
  Electron's root `Target` domain lists every target in the app — the omp-ui
  renderer included — so the bridge names only the pane's own tab and page
  (found by browser context, URL, and, between panes, an auto-attach probe),
  answers `Target.getTargets` with that pair, refuses any root command naming
  another target, and forwards no other target's lifecycle events.
- The agent learns the endpoint from a sixth generated `-e` extension,
  `omp-ui-browser-pane.ts`, armed by a hidden slash command in
  `initialCommands` at every rpc spawn. It delivers **one** hidden custom
  message (`display: false`) naming `browser.open({ app: { cdp_url } })`, the
  endpoint's rules, and a routing policy (#561): prefer the most direct
  interface — `read`/search for repository files and static web content,
  installed CLIs or APIs with existing credentials for structured service work
  — and reserve the pane for rendered UI, client-side JavaScript, browser
  state, browser-only authentication, and explicit user requests to see or
  interact with a page. A CLI or API that reports browser authentication is
  required sends the agent to the pane for that sign-in and back. This is
  guidance, not a gate: "both drive, always" describes control once attached,
  not tool preference, and the agent opening the pane autonomously stays
  intentional. The message is re-queued after a compaction or branch switch.
  No prompt suffix, no system-prompt append: one short hidden message once per
  omp process, and the provider prefix cache is left intact.
- The endpoint lives with the live rpc tab from spawn; the page is created on
  first user open or first agent attach, whichever comes first. The pane
  survives a process restart under the same tab, and is destroyed with
  hibernate, delete, a switch to terminal mode, and quit. The user closing the
  pane only unsubscribes; the page keeps running for the agent. When the agent
  attaches while the pane is closed, the renderer opens it: the agent never
  acts on a page the user cannot see.
- Both drive, always. Input is never blocked; the bridge derives an agent state
  (`detached | attached | acting`) from the commands it forwards and the
  renderer badges it. The whole-page hand-back is a screenshot **Attachment**
  plus the page URL, queued into the composer — never sent on the user's behalf.
  A second hand-back picks one element: main hit-tests over its debugger session
  and the renderer crops the last frame to the returned element rect (#544).
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
- **`bufferedAmount` or `ws.send` callbacks alone (rejected after S14).**
  Both bound only local writes, not bytes already accepted by the kernel.
  The 256 → 64 KiB fallback and a one-callback-in-flight experiment still
  delivered tens-of-seconds-old images and delayed PTY data. Receiver ACKs
  bound outstanding image delivery; a separate frame socket prevents image
  head-of-line blocking on the reliable connection. The accepted state is
  per remote transport pair, not per paint sink in `BrowserPaneHost`.
- **Desktop JPEG screencast, screenshot pull, raw bitmaps or shared textures
  for local panes (rejected, #651).** Measured on Electron 43.2.0 at
  2271×2006, normal GPU, headless Ozone, against a 100 ms pane
  input-to-painted p95 budget: the CDP screencast over the acknowledged
  MessagePort reached 185–195 ms p95 (source-to-capture and capture-to-main
  latency dominate; `setFrameRate(60)` did not help, and the pinned protocol
  has no `maxFramesInFlight`). A fresh `Page.captureScreenshot` per frame gave
  5–7.5 fps at 202–333 ms p95. Raw `toBitmap` over the MessagePort peaked at
  23.5 fps and 129 ms p95 with dirty-rect unions. Offscreen shared textures
  delivered no frames on headless Ozone. Tab capture gave 30 painted fps and
  45–63 ms p95 with no main-process pixel work.

## Consequences

- **Main-thread frame work is bounded (#651).** Local desktop panes move no
  pixels through main; a lease is one IPC round trip per page generation or
  geometry change. For JPEG viewers Chromium's encoder threads do the
  compression; main decodes only selected base64 payloads, inspects their
  JPEG headers, assembles the wire frame and fans it out. `lastFrameProcessMs`
  measures that JavaScript-side work, not asynchronous compression.
  Measure event-loop delay, UI input latency, painted fps and retained memory
  separately; do not lower density, JPEG quality or the 30 fps ceiling to hide
  a delivery regression. Disable/navigation/disposal fence old generations,
  stop and detach their private sessions, and release retained events. Capture
  failures surface through the pane error field without retrying indefinitely;
  a new document or an off/on subscription can explicitly restart capture. A
  failed or ended tab capture waits for the next geometry or generation notice.
  The host-owned session never changes agent-client counts, and agent screenshot
  or recording sessions do not own or stop it.
- **The pane partition grants exactly one permission shape.** Tab capture
  needs the captured page's session to approve a `media` request. The grant is
  minted only with a lease, bound to that page and the requester's origin,
  consumed on first use and expires after 10 s. A page's own camera,
  microphone or other permission request remains denied.
- **HiDPI is page zoom (#557; amended 2026-09-24, #646).** Under Wayland
  *fractional* scaling `screen.getDisplayMatching().scaleFactor` lies (reports 1
  while the app window's own pages render at 1.5), so the host takes its target
  from the app window's measured page `devicePixelRatio` divided by the window's
  zoom factor, clamped to `BROWSER_PANE_MAX_DSF`. Each page is created with
  `webPreferences.zoomFactor` = target and its offscreen window sized
  `css × target` DIPs: Chromium lays out the CSS size, reports
  `devicePixelRatio` = target and rasterizes at target, so every frame header's
  dsf is the page zoom by construction. The first route, which this amendment
  withdraws, was `Emulation.setDeviceMetricsOverride` at the CSS size inside a
  `css × dsf` window. It never rasterized above 1×: under device emulation Blink
  lays out at the widget's real dsf (`ZoomFactorForViewportLayout` returns the
  compositor override, which `ScreenMetricsEmulator` sets to the original screen
  dsf, and the offscreen view reports 1). So the page filled only the top-left
  `1/dsf` of every frame, and every check #557 and #630 relied on (`innerWidth`,
  `devicePixelRatio`, `outerWidth`, paint size, header dsf) reads the same in
  that state. The smoke now measures a 100 CSS px marker in the streamed frame.
  The host still owns one override, `{width, height}` = window size with
  `deviceScaleFactor: 1`, under which Blink lays out windowWidth / zoom = the
  CSS size and reports dpr = zoom, so the host stays the last writer of the
  widget's emulation. An agent `setViewport`, a clipped or
  `captureBeyondViewport` capture (which restores the agent session's own
  params), or a session detaching with a viewport would otherwise leave the
  widget at the agent's size: emulation is per CDP session — a clear from the
  host's session does not drop an agent's override — and Chromium keeps the
  resized view when it drops one. `deviceScaleFactor: 0` is not neutral: it
  resolves to the *screen's* dsf (1.5 under Wayland fractional scaling), never
  the offscreen view's 1, and that emulated dsf — not the page zoom — then
  drives layout. Every application clears the host's override before setting
  it (Chromium ignores a re-sent identical override) and waits for the window's
  first document commit (an override sent before it segfaults the GPU process);
  every commit also re-forces `setZoomFactor(target)` because Chromium restores
  the origin's persisted zoom level at commit, which would otherwise silently
  replace the page's density. The host re-asserts through a 250 ms debounce
  after any such command has been
  answered and after any decrease in CDP clients. The pane's own input is scaled
  from CSS to window DIPs by the host; CDP input is CSS and needs nothing. CDP
  screenshot clips are DIP and Chromium scales them by the widget dsf only, so
  the bridge scales a `Page.captureScreenshot` clip by the page zoom and turns a
  clipless `captureBeyondViewport` into an explicit clip over
  `Page.getLayoutMetrics().cssContentSize × zoom`. Screenshots therefore come
  back at `css × zoom` pixels. Measured (Electron 43, GNOME/Wayland 1.5×, 959×1337
  CSS): the old route painted 1439×2006 with a 100 CSS px marker at 100 px;
  page zoom paints 1439×2006 with it at 150 px; an agent click at CSS
  hits; an agent clip at (600, 900) is wrong without the bridge mapping and
  right with it. Measured on the Linux reference (GNOME/Wayland, 1.5× fractional,
  software raster, 800×600 CSS pane): target 1.5 → paint 1200×900 at page dpr
  1.5, encode p90 3.8 ms; target 2 → paint 1600×1200 at page dpr 2, encode p90
  7.0 ms — inside the 16 ms gate, no frame-rate fallback. Monitor moves after
  creation are still not chased in v1; `display-metrics-changed` and window
  moves only re-probe the target, which applies at the next page create or
  resize.
- **One loopback listener per live rpc tab, from spawn.** An idle tab costs one
  socket and no Chromium resources; the page and its renderer process exist
  only after first use. The token rotates with the listener.
- **The partition is a browser profile.** Cookies, storage and cache persist
  across restarts and tabs under `userData`, so a dev-app login survives.
  Settings → Advanced → **Clear browser pane data** wipes storage, cache and
  HTTP auth, closing live pages first and recreating those still shown (#542).
  The agent can read what the user logged into — the shell it already holds can
  read the same files.
- **Remote views are first-class but not equal.** Browser clients and joined
  instances see the live pane and drive it; only desktop renderers size it.
  Both relay hops are lossy; nothing is re-encoded because the header travels
  in-band. An unreachable owner leaves the last frame dimmed under the
  remote-instance banner with input held; rejoin resubscribes.
- **S14 changed the transport decision (#546).** Linux S14 initially used a
  real browser and PTY on the same WebSocket, throttled to 50,000 B/s for 60 s.
  The prescribed 256 → 64 KiB fallback lowered maximum native `bufferedAmount`
  from 299,956 to 123,685 bytes, but maximum displayed-frame age only fell
  from 41,786 to 38,988 ms. Desktop delivery stayed at 30 fps and caught-up
  frames arrived 104–105 ms after unthrottling; browser PTY delivery stalled
  behind queued images despite continued production. Heap did not trend up,
  but RSS oscillated roughly 251–764 MiB, so flat memory was not established.
  A separate real-transport experiment with one `ws.send` callback in flight
  still reached 18.5 s message age in 20 s: callbacks acknowledge local socket
  acceptance, not receiver delivery. The user approved receiver ACKs plus a
  separate authenticated frame stream, superseding the threshold fallback.
  A missing ACK never releases credit; frame reconnect replays the latest
  eligible image without restarting a healthy reliable connection. Reliable
  close discards all pairing and pending-frame state. This is a clean
  transport cutover: hosts, joined instances, and browser bundles must all
  implement the pairing handshake; there is no old shared-socket image path.
  The rebuilt Linux rerun used a 50,000 B/s aggregate cap across both sockets
  for 60 s (46,045 B/s measured), with roughly 107 kB images: desktop delivery
  and painting stayed at 30 fps; all 120 real PTY echoes arrived with 8–30 ms
  latency; current-image catchup took 206 ms after unthrottling. Maximum
  unacknowledged delivery was one, every admitted image was the newest
  available, and displayed age stayed bounded at 4,744 ms rather than growing
  throughout the run. Main heap medians were 9.825 → 9.852 MiB. RSS medians
  were 413.9 → 432.0 MiB with allocation/GC oscillation (261–742 MiB), not
  constant RSS; no sustained retained-memory growth was observed in the run.
  A frame-only disconnect recovered without a reliable-socket change or PTY
  interruption. The Linux A → B → browser rerun separately proved unchanged
  JPEG bytes, independent subscriber credit, and 503/504 ms companion-only
  reconnects on the upstream/downstream hops; full owner rejoin still
  preserved the dimmed last image and blocked input while unreachable.
- **IME commits are not always carried by `compositionend` (#550).** Real
  Linux X11/IBus Hangul 1.5.5 emitted an empty `compositionend`, followed by
  `input` carrying `한`. The proxy forwards non-composing committed input as
  `insertText`, suppresses preedit and deduplicates a trailing echo of a
  nonempty `compositionend`. Preedit is forwarded as CDP
  `Input.imeSetComposition` over main's root debugger session, so candidates
  render live; the commit still travels as `insertText` and replaces the
  composition (#541). Native German QWERTZ/AltGr remains unchanged.
- **Platform gates are smokes, not assumptions.** Offscreen paint on GPU and
  software paths, dsf, input into an unfocused hidden window, OS keymaps, ⌘
  chords, right-click semantics, non-ASCII `insertText`, the omp handshake,
  `file:` cancellation, disposal, LAN streaming, throttling and cross-instance
  sizing each have a spike or smoke command, a pass value, and a prescribed
  fallback. The self-hosted Linux runner runs `smoke:browser-pane --once` on
  every CI run and publishes `summary.json`; it prefers the runner session,
  then headless Ozone, then Xvfb (#540). Hosted macOS and Windows remain excluded.
  Local Linux verification painted on both rungs with sandboxing enabled:
  Wayland session (`ozone: wayland`, `sessionType: wayland`) and offscreen
  headless Ozone (`ozone: headless`), each with 19 JPEG frames and exit 0.
  Fallbacks that fired on the Linux reference: S11's fourth layer — an agent's
  `Page.navigate` to a refused URL is cancelled by the request layer, but
  Chromium would still commit an error page for it, so `did-start-navigation`
  stops the navigation (deferred out of the observer; a synchronous `stop()`
  there trips a Chromium CHECK) and the previous document stays on screen with
  its state (`net::ERR_ABORTED` to the agent).
  Linux remote-view verification used `--no-sandbox` for its isolated test
  instances; its results do not establish sandbox behavior. The local
  lifecycle, hand-back and native-keyboard instances ran without that flag.
- **omp is unchanged.** Everything rests on what omp exposes today: the
  `browser` global with `app.cdp_url`, its adoption of the existing page target,
  disconnect-only `tab.close`, and the extension API's `registerCommand`,
  `sendCustomMessage` and session events. omp's `tab.click` hang against every
  CDP target is worked around in the hidden message (`tab.run` + `page.click`),
  not fixed here.
- **Three implementation deviations were explicitly ratified.** Browser
  translation keys use the existing three-segment catalog convention
  (`browser.toolbar.blocked`, `browser.split.resize`). Root
  `Target.setAutoAttach` is shimmed with an owned-tab attachment rather than
  forwarded, avoiding duplicate paused worker sessions; root
  `setDiscoverTargets({discover:false})` changes only that client's flag,
  preserving discovery for other clients. The live hidden-extension test
  reads `get_messages`, because omp does not create the session `.jsonl`
  before a user message exists. These are intentional, not migration gaps.

## Amendment — browser clock

The bridge forwards CDP payloads verbatim **except** `Page.captureScreenshot`:
its clip is mapped by the page zoom (see 'HiDPI is page zoom'), and a successful
result while the tab's project has the browser clock on (see CONTEXT.md
"Browser clock", issue #642). That result's `data` is replaced with the same
image, re-encoded in the requested format and quality, with a date/time badge
in the top-right corner. The size is unchanged unless
the image is too small for the badge, in which case a strip is added on top.
A stamping failure is returned to the client as the command's CDP error,
never as an unstamped image. The page is never touched: the stamp is drawn in
a separate main-owned hidden page, not in the pane.
