# The device pane streams the emulator's gRPC screen and drives agent-device through a host tool

> **Status:** Accepted, 2026-10-30 ([#1006](https://github.com/LankfordAI/omp-ui/issues/1006)); amended for cohesive native creation and physical controls ([#1009](https://github.com/LankfordAI/omp-ui/issues/1009)). The original investigation used Electron 43.2.0 and agent-device 0.21.35; these are historical findings, not a cross-platform or current performance certification.

The **device pane** is a live Android emulator inside an rpc-ui tab that the
user and the agent share, the mobile twin of the browser pane
([ADR-0029](0029-browser-pane-offscreen-webcontents-and-loopback-cdp-bridge.md)).
The user watches and touches the emulator's screen beside the native
transcript; the agent installs, opens, and taps through the app it is building
on the same emulator. It covers emulators only, includes remote viewers (the
web client and joined instances), and keeps agent control off by default.

## Original findings (2026-10-30)

- **The emulator already serves its screen and input.** The emulator's
  `android.emulation.control.EmulatorController` gRPC service (AOSP
  `emulator_controller.proto`) offers `streamScreenshot(ImageFormat)`,
  `getScreenshot`, `streamInputEvent`, `getStatus`, `setVmState`, and
  `setClipboard`. A running emulator writes a `pid_<pid>.ini` discovery file
  with `port.serial`, `grpc.port`, `grpc.token`, and `avd.name`, and
  `adb -s <serial> emu grpc <port>` turns the endpoint on at runtime. Android
  Studio's embedded emulator uses the same RPC.
- **The RGBA stream arrives top-down.** The proto comment says "bottom up",
  but Expo's `serve-emu` feeds the bytes to its encoder unflipped at
  quarter-turn 0 and maps touches in the same top-left physical space.
- **T3 Code's device panel adds a host encoder.** Its `serve-emu` helper runs
  `streamScreenshot` through host ffmpeg libx264 to H.264 and ships it over a
  WebSocket to WebCodecs. Agents reach the device through `agent-device`
  behind a per-session launcher, gated by an "Agents can use devices" setting.
- **JPEG in Electron main is cheap at a capped size.** Measured in Electron
  43.2.0 main, `nativeImage.createFromBitmap(...).toJPEG(80)` took p50 2.3 ms
  / p90 2.8 ms at 576×1280, p50 1.5 ms at 432×960, and p50 12.6 ms at
  1080×2400. The R/B swap took p50 0.40 ms at 576×1280. `createFromBitmap`
  expects BGRA: after the swap a pixel round-trips correctly.
- **A utilityProcess cannot encode.** A utilityProcess's `require("electron")`
  exposes only `net` and `systemPreferences`; there is no `nativeImage`.
- **agent-device runs under Electron's Node and re-spawns it.**
  `agent-device@0.21.35` is MIT, 5.6 MB unpacked, with no runtime
  dependencies and `engines.node >=22.12` (Electron 43 ships Node 24.18.0).
  `ELECTRON_RUN_AS_NODE=1 electron bin/agent-device.mjs --version` prints
  `0.21.35`. Its daemon re-spawns `process.execPath` with the caller's env,
  and it reads `AGENT_DEVICE_STATE_DIR`,
  `AGENT_DEVICE_ANDROID_DEVICE_ALLOWLIST`, `AGENT_DEVICE_SESSION_LOCK`, and
  `AGENT_DEVICE_NO_UPDATE_NOTIFIER`.

## Current decision (#1009 amendment)

The original gRPC/JPEG/host-tool trade-off remains. The creation, physical
control, identity and lifecycle contracts below supersede the initial shared
browser/device payload format and dimension-only input assumptions.

1. **Create explicitly from native SDK definitions.** Running and stopped
   AVDs remain selectable even outside the creation catalog. Create requires
   the owning host's `avdmanager`, an available native hardware profile, an
   exact eligible installed system-image package and a new AVD name. The
   catalog covers small/medium phones and tablets, Pixel 9/9 Pro XL/Tablet/
   Fold/9 Pro Fold and generic 7.6/6.7/8-inch foldables; local SDK membership
   and profile API floors determine each offer. Images must be stable,
   complete mobile images with matching metadata and host-native ABI.
   Stable SDK extension packages are valid when metadata agrees; extensions
   are not platform minor versions and `IsBaseSdk=false` alone does not mean
   preview. API 24/25 support their older vendor-free file layout. There is
   no preview, TV/Wear/Automotive, cross-ABI or incomplete-image fallback.
   Default to the highest eligible installed API, propose an API-specific
   unused name, then require image/name confirmation. Missing prerequisites
   have owner-side reasons and copyable commands, never automatic downloads.
   There is no donor or implicit create-on-Boot path. Native panel/hinge
   definitions remain SDK-owned; only a newly created AVD gets a verified
   `hw.keyboard=yes` patch. Existing AVDs are never rewritten. Legacy static
   layout names do not assert genuine OEM hardware or folding capability.
2. **Physical controls report observations, not intent.** Rotation selects
   0/90/180/270 degrees through the native physical model, not CSS rotation.
   Posture offers closed/half-open/open/flipped/tent only when actual AVD
   hardware, native model and independent Android guest support agree.
   Unsupported choices carry reasons. Setter success only schedules work:
   a bounded 15-second confirmation requires physical readback and a fresh
   native screenshot, plus committed guest state for posture. An observed
   inactive display is valid for a posture that really sleeps; closed does
   not imply asleep. Guest app orientation policy remains authoritative.
   Forwarded agent-device `orientation` keeps guest lock/auto semantics and
   is not a substitute for physical rotation. Device layout uses `placement`
   (`split`, `column`, `sheet`), not physical `posture`; the browser's existing
   layout API is unchanged.
3. **Video stays on the emulator's gRPC stream.** Main requests RGBA8888
   bounded to a 1280-pixel long edge over `node:http2` and the dependency-free
   protobuf subset. No ffmpeg or extra encoder process is involved. Newest
   message wins, with at most one encode per 33 ms. Main swaps R/B into a
   reusable buffer and uses `nativeImage` JPEG quality 80 for every viewer.
   Historical encoder timings below explain this choice, not a new latency
   or throughput guarantee.
4. **Native observation is independent of publication.** At most one
   screenshot stream exists per binding, only while a view subscribes.
   The final unsubscribe releases input, aborts capture and clears pending
   frames, cache and capture timers; resubscribe requests a fresh screenshot
   if no current cache exists. Hidden control/readiness work can observe
   native screenshots without encoding any JPEG or consulting a cached JPEG.
   Screen-off, display and posture notifications invalidate old geometry
   immediately; a control operation does not require a viewer or paint ACK
   to finish.
5. **Device identity is protocol v2, not the browser payload.** State and
   every input carry a binding UUID and positive u32 geometry revision. The
   device header is 28 bytes: u16 width, height and density-times-100,
   `0x4450`, 16 binding UUID bytes and a u32 revision, in network byte order.
   The browser header remains unchanged. Decoder injection keeps one JPEG
   painter without conflating codecs; current identity is checked before
   decode and again before draw. Decode/drop/dispose still settles delivery
   credit and closes bitmaps. Desktop MessagePort channel credit and paired
   authenticated `/ws/frames` ACK envelopes are unchanged: browser/device
   pending slots remain distinct per channel/tab, with one unacknowledged
   image per WebSocket pair. Reconnect and state/frame reordering cannot
   enable input until the current identity has actually been painted.
6. **Input uses native capture and input geometry.** Unit coordinates are
   mapped through native screenshot rotation/display identity, folded
   region/offsets and input extents, which need not match capture extents.
   Pixel Fold cover aliases are normalized from native hardware evidence.
   `wm size`, frame aspect ratio and a width/height swap are not input
   authority. All four quadrants, including same-size 180-degree changes,
   invalidate identity as necessary; unknown geometry or an inactive guest
   or native screen disables input. A long-lived `streamInputEvent` carries
   W3C keys and touch; ASCII uses keyboard text, other commits clipboard
   paste. Guards recheck binding, revision, generation, geometry, sender,
   subscription and lease immediately before every queued write, including
   after asynchronous clipboard work. Transitions force releases on original
   pointer coordinates/display and held keys before replacing geometry.
   Touch-only wheel input is a finite, bounded host-owned swipe. Native
   wheel events require positive runtime evidence for the emulator
   controller's own axes and matching active display geometry, not a guessed
   mouse name or an unrelated input device.
7. **One host owns commands and races.** A serial binds exclusively to one
   live rpc-ui tab. AVD creation/boot reservations and forwarded-command
   tab/serial leases survive until actual work settles; competing UI changes
   are refused. Operation/entry generations fence late results after abort,
   disposal or rebinding. `omp-ui_device { args }` uses the real host inventory
   and action paths for `targets`, `profiles`, `create`, `state`, `use`,
   `rotate` and `posture`, not a parallel mock/provisioning path. Create/Boot
   acceptance reports a running operation, not readiness; callers poll State.
   Other allowlisted commands run pinned bundled agent-device under
   `process.execPath` with `ELECTRON_RUN_AS_NODE=1`, a bound-serial allowlist,
   fixed platform/serial/session flags and a 50-second child bound. Selector
   overrides are refused. A bare screenshot returns an inline image. Commands
   open the pane, release user input and show acting state; nothing closes
   it automatically.
8. **The essential tool stays gated per spawn.** `set_host_tools` registers
   it only when **Agents can use devices** is on (off by default) and the
   session was not requested by a webhook or MCP client. Setting changes
   apply at spawn/resume, following
   [ADR-0048](0048-knowledge-vault-host-tools-and-home-folder-boundary.md).
9. **Binding and emulator lifetimes are separate.** Boot starts an existing
   AVD detached and headless (`-no-window`) after checking host acceleration.
   It outlives pane closure, Disconnect and omp-ui disposal. Close keeps the
   binding; Disconnect releases it; confirmed Power off alone requests
   shutdown of the captured current binding, with stale confirmations
   refused. Hibernate, terminal-mode switch and quit dispose host resources
   and remember the serial; delete forgets it. A later ensure can rebind the
   still-running emulator.
10. **One split slot, owner-routed remote parity.** Browser and device panes
    share the slot beside the native transcript; opening one closes the other,
    without changing the inspector rail. Every `device-pane:*` request routes
    to the session's owning host and state/frames mirror back. Remote viewers
    use the owner's SDK, inventory and controls, never viewer-local tools.

### Amendment evidence and limits

The #1009 runtime proof exercised Linux x64/KVM, emulator 37.2.13 build
16740729, API 35 Google APIs x86_64 revision 9/extension 13 and API 36 Google
APIs x86_64 revision 7/extension 17, plus a real gated agent-created API 29
Google APIs x86_64 revision 13 phone (no ExtensionLevel property). Four actual
chooser-created phone/tablet/book/flip AVDs consumed distinct native corner
input in all quadrants, native drag/scroll and ASCII/CDP IME commits. Book
and flip transitions retained text on the same serial. Generic API 36 flip
closure remained Awake; explicit hardware sleep/wake proved inactive-screen
input gating instead. A noncatalog Pixel 7 AVD's config hash was unchanged.
Busy leases, original drag/key releases, stale revisions/bindings and stale
remote Power off confirmations were exercised. Production host/client
lifetime proof observed no encodes or active streams while unsubscribed,
at most one stream, no hidden-rotate encode growth, fresh resubscribe replay and emulator survival
after dispose. This is not a benchmark or Windows/macOS/Apple Silicon proof.
See [Development](../development.md#device-pane-acceptance-1009) for the
reproducible acceptance matrix and responsive proof scope.

## Rejected options

- **ffmpeg/H.264, as in T3 Code.** A host ffmpeg dependency and an encoder
  process per stream, for bandwidth savings a capped JPEG stream does not
  need.
- **The emulator's WebRTC module.** It needs a signalling peer, and whether
  current emulator builds ship it is unconfirmed.
- **scrcpy.** That is the physical-device path, out of scope for v1.
- **Writing `agent-device mcp` into the user's `.omp/mcp.json`.** A config
  write into user-owned files, which
  [ADR-0055](0055-private-sessions-quiet-overlay-plus-bridge-not-config-write.md)
  rules out, and one that could not bind the tab's serial or tell main when
  the agent acts.
- **A generated `-e` extension calling `registerTool`.**
  [ADR-0048](0048-knowledge-vault-host-tools-and-home-folder-boundary.md)
  already rejected `registerTool` bridges in favour of host tools.
- **Encoding in a utilityProcess.** It has no `nativeImage`; encoding stays in
  main, and the frame size cap bounds its event-loop cost.

## Consequences

- Renderers receive only JPEG frames and JSON state and send only JSON input.
  The gRPC endpoint, its token, and the serial-to-port mapping never leave
  the owning main process, and every `device-pane:*` request is tab-routed to
  the owner for a joined instance.
- Encoding is subscription-driven, not all host work: hidden control operations
  can still make native observations without encoding. `DevicePaneDiagnostics`
  reports encode counts/times. The original swap/encode measurements above
  informed the transport trade-off; they are not current performance claims.
- The Android SDK is the user's to install. Existing AVDs need platform-tools
  and emulator; explicit Create also needs command-line tools, a native profile
  and an eligible installed image. Discovery uses `ANDROID_HOME`,
  `ANDROID_SDK_ROOT`, then the OS default, never `PATH`. Missing pieces are
  named in the pane/tool; no SDK download or existing-AVD mutation is implicit.
- The packaged app unpacks `agent-device` from the asar, because adb pushes
  its helper APKs from real files and its daemon re-spawns its own `bin`.
- Physical devices, iOS simulators, secondary-display selection, recording,
  separate device-host services and a device tool for subagents stay out of
  scope. Remote viewers of an owning omp-ui host are supported, not a separate
  device-host service.
