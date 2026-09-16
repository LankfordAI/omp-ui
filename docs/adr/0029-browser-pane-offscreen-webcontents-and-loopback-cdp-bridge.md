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
  Main still encodes one JPEG per paint and caches the last frame per pane.
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
- **`bufferedAmount` or `ws.send` callbacks alone (rejected after S14).**
  Both bound only local writes, not bytes already accepted by the kernel.
  The 256 → 64 KiB fallback and a one-callback-in-flight experiment still
  delivered tens-of-seconds-old images and delayed PTY data. Receiver ACKs
  bound outstanding image delivery; a separate frame socket prevents image
  head-of-line blocking on the reliable connection. The accepted state is
  per remote transport pair, not per paint sink in `BrowserPaneHost`.

## Consequences

- **Frame cost is bounded and measured.** Encoding is ~4 ms at 1280×800 and
  ~15 ms at 2560×1600 on the Linux reference, ~13–40 KB per frame; at 30 fps
  and 1080p that is under a quarter of the main thread. Idle pages paint
  nothing, but a focused caret repaints a full frame every 600 ms. If a platform
  smoke measures p90 encode over 16 ms, the dsf is clamped to a pixel budget
  first and the frame-rate constant lowered second; a row whose fallback fired
  is recorded here with the measured value.
- **HiDPI is best-effort.** `offscreen.deviceScaleFactor` is honoured on X11,
  Windows and macOS and ignored on Wayland; the host reads the painted scale
  off the first frame (a 1280×800 frame for a 1280×800 page is dsf 1), so the
  header says what was painted and the renderer upscales (measured on the
  Linux reference: requested 2, painted 1 under Wayland; 2560×1600 at 2 under
  `--ozone-platform=x11`, encode p90 16.3 ms). Monitor moves after creation are
  not chased in v1.
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
  `input` carrying `한`. The composer accepted it while the pane lost it.
  The proxy now forwards non-composing committed input as `insertText`,
  suppresses preedit and deduplicates a trailing echo of a nonempty
  `compositionend`. Two native commits produced `한 한 ` exactly once each;
  live candidate rendering remains the separate F7 follow-on. Native German
  QWERTZ/AltGr also produced identical `zy @€ üß` in the composer and pane.
- **Platform gates are smokes, not assumptions.** Offscreen paint on GPU and
  software paths, dsf, input into an unfocused hidden window, OS keymaps, ⌘
  chords, right-click semantics, non-ASCII `insertText`, the omp handshake,
  `file:` cancellation, disposal, LAN streaming, throttling and cross-instance
  sizing each have a spike or smoke command, a pass value, and a prescribed
  fallback. No real-Electron CI lane exists; runner adoption is a follow-on.
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
