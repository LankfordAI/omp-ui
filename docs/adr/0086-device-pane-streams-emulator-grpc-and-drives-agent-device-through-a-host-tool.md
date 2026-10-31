# The device pane streams the emulator's gRPC screen and drives agent-device through a host tool

> **Status:** Accepted, 2026-10-30 ([#1006](https://github.com/LankfordAI/omp-ui/issues/1006)). Verified against Electron 43.2.0 and agent-device 0.21.35.

The **device pane** is a live Android emulator inside an rpc-ui tab that the
user and the agent share, the mobile twin of the browser pane
([ADR-0029](0029-browser-pane-offscreen-webcontents-and-loopback-cdp-bridge.md)).
The user watches and touches the emulator's screen beside the native
transcript; the agent installs, opens, and taps through the app it is building
on the same emulator. v1 covers emulators only, includes remote viewers (the
web client and joined instances), and keeps agent control off by default.

## Findings

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

## Decision

1. **Video comes from the emulator's own gRPC stream.** Desktop main opens
   `streamScreenshot` with `ImageFormat{RGBA8888}` sized so the long edge is
   at most 1280 device pixels (`DEVICE_PANE_MAX_EDGE`), over a dependency-free
   `node:http2` client and a hand-rolled protobuf subset. No extra process and
   no ffmpeg are involved.
2. **Main encodes JPEG, one format for every viewer.** Each frame is
   R/B-swapped in place, encoded at quality 80 with `nativeImage`, and
   prefixed with the browser pane's 8-byte frame header (`dsf: 1`). The frame
   rides `device-pane:frame` on the existing lossy, acknowledged frame
   transport: the desktop MessagePort stream and `/ws/frames` gain a channel
   field and per-(channel, tab) keys, and nothing else changes shape. A raw
   RGBA path to the desktop window would add a second paint path to save
   about 2.3 ms per frame.
3. **Pacing matches the browser pane.** Newest message wins, with at most one
   encode per 33 ms (30 fps). The stream runs only while a view subscribes; a
   new subscriber gets the cached frame, or one `getScreenshot` when there is
   none, since a static screen may send no stream message.
4. **User input is one long-lived `streamInputEvent` per binding.** Renderers
   send touch and wheel positions as unit coordinates over the painted frame;
   main maps them to native display pixels, so no renderer knows device
   geometry. Keys go as W3C key values, printable ASCII as keyboard text, and
   other text through the emulator clipboard and Ctrl+V.
5. **Agent control is one essential host tool.** `omp-ui_device { args }`
   ([ADR-0043](0043-host-tools-answer-what-the-main-process-owns.md)) runs
   the pinned, bundled `agent-device` CLI as a child of `process.execPath`
   with `ELECTRON_RUN_AS_NODE=1`, so its re-spawned daemon is Node too and
   never a second app. Main appends `--platform android --serial <serial>
   --session <session>`, sets the device allowlist to the bound serial,
   refuses agent-supplied selector flags, and forwards only an allowlist of
   commands; `targets` and `use` are omp-ui's own verbs. A bare `screenshot`
   comes back inline as an image. A device command opens the pane when it is
   closed (the agent never acts on a screen the user cannot see) and shows an
   acting badge; nothing closes the pane automatically.
6. **The tool is gated per spawn.** It is registered through `set_host_tools`
   only when **Agents can use devices** is on (off by default) and the
   session was not requested by a webhook or an MCP client. A change applies
   at the next spawn or resume, the rule of
   [ADR-0048](0048-knowledge-vault-host-tools-and-home-folder-boundary.md).
7. **The emulator runs on the machine that owns the session and outlives the
   pane.** Booting starts the AVD headless (`-no-window`) and detached; it
   survives omp-ui quitting and stops only on **Power off**. One tab binds
   one emulator, and a second tab is refused while the first holds it.
   Hibernate, a switch to terminal mode, and quit stop the stream and
   remember the serial; delete forgets it.
8. **One split slot, two kinds.** The browser pane and the device pane share
   the split beside the native transcript; opening one in a tab closes the
   other. The inspector rail is unchanged.

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
- Main pays about 2.7 ms per frame at 576×1280 (swap plus encode) while a
  view watches, and nothing while none does. `DevicePaneDiagnostics` reports
  the encode times.
- The Android SDK (platform-tools and emulator) is the user's to install;
  omp-ui finds it through `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or the OS
  default and never relies on `PATH`. A missing piece is named in the pane
  and in the tool's error.
- The packaged app unpacks `agent-device` from the asar, because adb pushes
  its helper APKs from real files and its daemon re-spawns its own `bin`.
- Physical devices, iOS simulators, secondary displays, recording, remote
  device hosts, and a device tool for subagents stay out of scope.
