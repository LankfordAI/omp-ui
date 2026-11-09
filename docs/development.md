# Development

omp-ui is an npm workspace containing a transport-agnostic Node core, an Electron desktop app, and the server used by remote browser clients. This guide covers a local checkout, repository commands, tests, and contributor constraints.

Return to the [Documentation home](README.md). Read [Architecture](architecture.md) before changing package boundaries and [Releases](releases.md) before changing packaging or update behavior.

## Prerequisites

Install these tools before checking out the repository:

- Git.
- Node.js 22 or newer and its bundled npm. The current Electron package requires Node 22.12.0 or newer, so use a current Node 22 release.
- The native build tools required by `node-pty` on Linux.

`node-pty` ships Node-API prebuilds for Windows and macOS, so `npm install` compiles it only on Linux. Node-API is ABI-stable across Node and Electron, so the copy npm installs is the copy that ships in every package; nothing rebuilds it for Electron. Install the platform tools:

- Linux: Python 3, `make`, and a C/C++ build toolchain. On Debian or Ubuntu, install them with `sudo apt install -y python3 make build-essential`.
- macOS: Xcode command-line tools for `codesign`, `hdiutil`, and `notarytool`.
- Windows preview: no native toolchain; electron-builder bundles NSIS.

Linux AppImage and macOS packages are the supported distributions. Windows packages are previews, but their development and packaging scripts remain available.

## Check out and install

Clone the repository and create a branch for the change:

```bash
git clone https://github.com/LankfordAI/omp-ui.git
cd omp-ui
git checkout -b docs/my-change
npm install
```

Run commands from the repository root unless a command says otherwise. Commit `package-lock.json` whenever a dependency or workspace version change updates it.

## Root commands

The root scripts delegate to the npm workspaces where appropriate.

| Task | Command | What it runs |
|---|---|---|
| Install dependencies | `npm install` | Installs the root and all workspace dependencies. |
| Start the desktop app | `npm run dev` | Generates theme CSS, installs the Electron binary if needed, then starts `electron-vite dev --watch`. |
| Start the desktop app headless | `npm run dev:headless` | Same as `npm run dev`, but Chromium runs on its headless Ozone platform so no window is mapped on your display. Uses a dedicated userData identity, a throwaway registry with OS notifications off, and CDP on `127.0.0.1:9223` (the launcher prints `cdp-port-file=`, where the app records the live port; a main-rebuild restart that cannot rebind moves CDP to the next free port, #783). With `-- --pane` the run also serves its UI over loopback HTTP; see [Verification runs](#verification-runs). Linux only. For agent verification runs; see [Verification runs](#verification-runs). |
| Build all app bundles | `npm run build` | Generates themes, builds Electron main/preload/renderer, then builds the remote web bundle. |
| Package the default target | `npm run package` | Runs the Linux packaging script. |
| Preview release notes | `npm run notes` | Runs `scripts/release-notes.mjs` to render a release's notes body locally from git history and the GitHub API, for example `npm run notes -- --tag v0.9.12 --stdout`. Read-only; writes nothing to GitHub. |
| Test all workspaces | `npm test` | Runs each workspace's `test` script. The desktop test script checks generated themes before Vitest. |
| Test process-backed live proofs | `npm run test:live` | Runs the desktop `src/main/**/*-live.test.ts` integration proofs serially against the real omp binary. Skips cleanly when no omp binary is installed. CI runs this after `npm test`. Includes the Knowledge vault live test (`knowledge-vault-live.test.ts`): registration of the ten `omp-ui_vault_*` tools always; a real search call and an `omp-ui://sessions` read when an API key is set. Includes the worker-thread bridge test (`subagent-workers-live.test.ts`, omp 18.17+, issue #1070): a 10-subagent fan-out against a loopback provider, run once with omp's default `task.workerThreads` and once with `task.workerThreads: 0`; the background-jobs tree, cancels, session spend, roster, and subagent frames must match across the two runs. Includes the ovnfs suppression test (`ovnfs-isolation-live.test.ts`, omp 18.17+, issue #1071, ADR-0089): against a real ovnfs daemon and mount it proves an owned session's isolated task runs outside any mount with its patch still applied to the parent, that the overlay outranks a `ovnfs.path` the user pinned in their global agent layer, and that the no-ovnfs run is byte-identical; it skips wherever no usable ovnfs binary exists (`$OMP_UI_OVNFS_BIN` or PATH). |
| Type-check all workspaces | `npm run typecheck` | Runs each workspace's `typecheck` script. |
| Lint the repository | `npm run lint` | Runs ESLint from the root. |
| Audit visible strings | `python3 scripts/scan-visible-strings.py` | Heuristic list of renderer chrome literals that may still need an i18n `t()` key (issue #363). Read-only; triage hits by hand — brand names, hotkeys, paths, commands, and data labels are intentionally outside localization. |

`npm run dev` hot reloads the desktop renderer. Restart it when a main-process, preload, native-module, or startup environment change cannot be picked up by the running process.

TypeScript runs at two versions. Every workspace typechecks and tests with TypeScript 7 (the native compiler); core tests use its `typescript/unstable/*` API and esbuild for type stripping. The root `typescript` entry is the `@typescript/typescript6` alias, kept only because `typescript-eslint` needs the classic compiler API that TypeScript 7 does not ship (typescript-eslint #10940). Remove the alias when typescript-eslint supports TypeScript 7.

CI runs the knowledge-vault smoke right after the node-pty smoke, then lint
before typecheck, tests, build, and the browser-pane smoke. Unused declarations
are lint errors: remove obsolete helpers and fixtures rather than disabling the
rule (issue #742). Smoke-summary uploads run only when their corresponding
smoke step succeeds or fails, not when an earlier gate skips it (issue #862).
Failed smokes still upload diagnostics; an executed smoke that produces no
summary remains an upload error.

The subagent-model live proof inherits the local omp parent model. That model
must be served by its configured provider; a provider rejection prevents the
first task spawn regardless of the subagent pin (issue #744).

Three live proofs pin their hermetic scope against omp 18.17 runtime behavior
(issue #1051). The bash minimizer proof drives `git log --stat` over a seeded
repo because as of 18.17 the shell minimizer rewrites only recognized command
families; generic repetitive output arrives truncated with no
`meta.minimized`. The spend-cap proof seeds its transcript's model in the
scope's own `models.yml`: a resume whose last assistant model no longer
resolves exits with `SessionModelRestoreError` before taking any prompt. The
magic-keyword proofs pin `compaction.enabled: false` — against their
unreachable probe model, auto-compaction enters `auto_compaction_start` and
never consumes the next prompt, and omp-ui's stall watchdog deliberately
treats that frame as legitimate quiet.

The worker-thread proof kills a subagent's own nested bash job first and requires that kill to succeed through the bridge's owner-scoped route (issue #1077), with the owning task row still running when the result lands; it then cancels every worker-hosted task and observes whatever nested jobs remain settle through the bridge. After bulk cancellation it checks all twenty original job statuses with a test-only larger `getAsyncJobTree` read: OMP's ten-row recent list is sorted by job start time, so it cannot retain the entire cancelled tree. Production retention stays unchanged. A separate post-cancellation transcript and usage append must produce fresh spend frames with exact usage deltas, proving polling survived cancellation.

## Workspace commands

Use npm's workspace flag for a focused task. These commands match the scripts in `packages/desktop/package.json`:

```bash
# Build only the remote browser bundle.
npm run build:web --workspace @omp-ui/desktop

# Prove the installed node-pty addon loads and spawns a shell inside Electron.
npm run smoke:pty --workspace @omp-ui/desktop

# Electron-runtime smoke of the shipped browser pane host; writes
# out/browser-pane-smoke/summary.json. CI runs --once on Linux: the self-hosted
# runner for same-repo events, a hosted runner (headless Ozone, Xvfb fallback)
# for fork pull requests.
npm run smoke:browser-pane --workspace @omp-ui/desktop

# Electron-runtime smoke of the shipped plan verifier window: one real verify
# through the shipped BrowserVerifierPage; writes out/plan-verifier-smoke/
# summary.json. CI runs --once on Linux, headless Ozone first with an Xvfb
# fallback — the verifier window once SIGSEGV'd main on headless Ozone (#820).
npm run smoke:plan-verifier --workspace @omp-ui/desktop

# Node-posture smoke of the Knowledge vault host tools against a generated
# fixture vault (S1-S8); writes out/knowledge-vault-smoke/summary.json. No
# display, no Obsidian; scripts/electron-node.cjs relaunches the built entry
# under Electron's Node runtime, so it runs the same on Linux, macOS, and
# Windows. --volume=1000,5000 sets the search sizes (20000 is opt-in,
# recorded, not gating); --slow adds the 60 s watchdog row (S9).
npm run smoke:knowledge-vault --workspace @omp-ui/desktop

# Regenerate committed theme CSS from theme-sources.json.
npm run themes:generate --workspace @omp-ui/desktop

# Fail when committed theme CSS does not match its source.
npm run themes:check --workspace @omp-ui/desktop

# Rebuild the lite member's session bundle from the real desktop sources —
# the electron drift gate (a new runtime Electron import in the bundled
# cluster fails here, loudly). CI runs this every check; it needs no app
# boot at all.
npm run bundle -w @omp-ui/host-lite

# Run a headless lite member against a throwaway data dir: plain Node, no
# window, no display — the same rule #858 sets for verification runs.
OMP_UI_LITE_HOME=$(mktemp -d) npm run serve -w @omp-ui/host-lite

# Two-instance join proof: one real lite member + one owner-side join, both
# in-process; prints pass/fail, writes nothing outside its temp dirs.
npm run proof:join -w @omp-ui/host-lite

# Build the single-file SEA binary (linux-x64 only; needs a pinned
# linux-x64 Node 22 via OMP_UI_LITE_NODE and the declared postject devDep).
npm run sea -w @omp-ui/host-lite
```

The browser-pane smoke reports `frameProcessMs` for main-thread base64 decoding,
JPEG-header inspection and frame assembly. It does not measure Chromium's
asynchronous JPEG compression. The host smoke covers raster density, input,
agent screenshots and clock stamping, but bypasses desktop delivery: local
panes paint from a tab-capture `MediaStream`, and joined remote-instance panes
from MessagePort JPEGs. Use a full `dev:headless` run to measure desktop
painting, input-to-paint latency, ACK backpressure, hidden-tab filtering and
renderer reload recovery. Pane text input is safe on a body-focused page: the
host types a plain `insertText` as CDP char events and rides only a provably-live
IME commit over the root debugger session; a click into the page mid-conversion
drops the debugger route entirely, never `webContents.insertText` (#656).
Keep workload, density, quality and GPU mode fixed between baseline and changed
runs; report software
rendering separately. Verify the raster marker and JPEG payload size throughout:
the pre-existing accelerated static-canvas resize defect (#653) can otherwise
turn a detailed fixture into an almost empty image. A retained image of seeded
pixels avoids that fixture failure without reducing frame dimensions or quality.

No lane rebuilds `node-pty` for Electron: the addon is Node-API, so the copy
`npm ci` installs — a prebuild on Windows and macOS, a node-gyp build on Linux —
is the copy electron-builder packs. The package verifiers only prove that copy
exists on disk, so every packaging lane and CI run `smoke:pty` first. It
relaunches itself as the Electron binary with `ELECTRON_RUN_AS_NODE=1` (no
display needed), spawns a shell through `node-pty`, and fails if the addon
cannot load or spawn under the exact Electron the package embeds (issue #484).
The macOS prebuild stores its `spawn-helper` non-executable, and a copied tree
keeps that mode into the packaged app, so `scripts/ensure-node-pty-exec.cjs`
ORs the exec bit back in: as the desktop workspace's `postinstall` (every
`npm ci`/`npm install` and the smoke itself), as electron-builder's `afterPack`
hook so a local `package:mac` is safe without the smoke, and as an assertion in
`verify-macos-package.sh` (issue #489).

Run a single workspace's tests or type check with the same form:

```bash
npm test --workspace @omp-ui/core
npm test --workspace @omp-ui/desktop
npm test --workspace @omp-ui/server
npm run typecheck --workspace @omp-ui/core
```

Vitest accepts a test path after `--`. The path is relative to the selected workspace:

```bash
npm test --workspace @omp-ui/core -- src/paths.test.ts
npm test --workspace @omp-ui/desktop -- src/main/app-update.test.ts
```

The desktop unit suite caps Vitest at 4 worker processes on local machines
(CI keeps full parallelism), so a full local run stays interactive. For a
tighter loop, run only affected tests from `packages/desktop`:

```bash
npx vitest run --changed
```

Every Git fixture must give each repository it initializes its own
repository-local `user.name`/`user.email` before any commit — including a
nested repository created inside another fixture repo. A freshly initialized
repo reads only its own config plus the developer's global identity, so the
outer repo's fixture identity does not reach it; a global identity makes the
missing config invisible locally while clean CI (no global config) fails with
`Author identity unknown` before the assertions run (#1080). The hermetic check
for this is to run the suite with an empty Git config:

```bash
H=$(mktemp -d) && env -i HOME=$H PATH=$PATH TMPDIR=/tmp \
  GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null \
npm test --workspace @omp-ui/core
```

Fleet audit summaries cap `detail` at 200 characters; the maintenance poll
retains the complete result. Ownership-update tests should prove installation,
refresh, warning delivery, and manifest preservation through that result, not
equate the audit summary with it. Windows temporary paths can cross the cap
even when the same fixture stays below it on Linux (#1081).

The desktop `test` script does not run the process-backed live proofs
(`src/main/**/*-live.test.ts`, real omp spawns); run them on demand with
`npm run test:live --workspace @omp-ui/desktop`. Renderer `.live.test.tsx`
files spawn no subprocess and remain in the unit suite.

## Platform packages

The root `npm run package` command selects Linux. Use the desktop workspace scripts when the target must be explicit:

```bash
# Supported Linux AppImage.
npm run package:linux --workspace @omp-ui/desktop

# macOS package.
npm run package:mac --workspace @omp-ui/desktop

# Unsigned Windows x64 preview.
npm run package:win --workspace @omp-ui/desktop
```

Packaging runs the full desktop build first. macOS release signing and notarization require the release credentials described in [Releases](releases.md). The Windows script always passes `--x64`.

## Android app

`android/` is a standalone Kotlin/Gradle project, outside the npm workspaces
([#1100](https://github.com/LankfordAI/omp-ui/issues/1100)). It loads the host's
remote web bundle; it neither embeds Electron nor runs omp on the phone. Build
and run a host from this checkout as well: older published hosts do not contain
the Android draft/view recovery and reading-position changes.

Use JDK 21, Android SDK platform 36 and build-tools 36.0.0. Set `JAVA_HOME` to
the JDK (not a runtime-only installation) and `ANDROID_HOME` to the SDK. The
wrapper pins Gradle 8.13 with its distribution SHA-256; the project pins AGP
8.13.2 and Kotlin 2.1.20.

The APK launcher uses the existing `packages/desktop/build/icon.png` wordmark
([#1118](https://github.com/LankfordAI/omp-ui/issues/1118)). Gradle's
`syncLauncherIcon` task stages that file under
`app/build/generated/res/launcherIcon/drawable-nodpi/omp_ui_icon.png` before
`preBuild`, for both debug and release. Android builds need neither Node nor
Chromium to package it. The adaptive icon uses the matching opaque tile color
and an 18 dp foreground inset so launcher masks do not clip the wordmark.
To change the artwork, update the shared PNG rather than adding an Android copy.

```bash
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "platforms;android-36" "build-tools;36.0.0"
cd android
./gradlew --no-daemon :app:assembleDebug :app:testDebugUnitTest :app:lintDebug
```

On Windows use `gradlew.bat`. The debug-signed APK is
`android/app/build/outputs/apk/debug/app-debug.apk`, version 0.1.0, application
ID `ai.lankford.ompui.android`. It requires Android 10/API 29 or newer and an
updated Android System WebView supporting both `DOCUMENT_START_SCRIPT` and
`WEB_MESSAGE_LISTENER`; document-start support alone is insufficient. This debug
APK is local-only; stable GitHub releases ship a separately release-signed APK
as described in [Android distribution](releases.md#android-apk-distribution-and-signing).

From the repository root, install on the explicitly selected device:

```bash
"$ANDROID_HOME/platform-tools/adb" -s DEVICE_SERIAL install -r android/app/build/outputs/apk/debug/app-debug.apk
```

CI's `android-check` job runs these debug build/unit/lint tasks and the Android
release-verifier regression tests on pushes to `main` and all pull requests,
including forks, on a GitHub-hosted runner with no signing secrets.

For a signed release build on Linux/macOS, set `ANDROID_KEYSTORE_PATH` and
`ANDROID_KEYSTORE_PASSWORD` securely (no shell tracing), then from the repository
root run:

```bash
./android/gradlew -p android --no-daemon --no-configuration-cache \
  -PreleaseVersion=0.34.0 :app:assembleRelease :app:testReleaseUnitTest :app:lintRelease
node android/scripts/verify-release.mjs \
  android/app/build/outputs/apk/release/app-release.apk 0.34.0 CERTIFICATE_SHA256
```

Use the intended stable release version and the pinned 64-hex public certificate
digest. The keystore alias is `omp-ui-android`, with the same store/key password.
Release tasks refuse missing signing credentials or a missing/invalid version;
debug builds do not require either. The release workflow stages the verified APK
as `omp-ui-<version>-android.apk` and keeps it out of Electron update feeds.

For instrumentation, unlock the selected emulator first, then run
`ANDROID_SERIAL=DEVICE_SERIAL ./gradlew --no-daemon :app:connectedDebugAndroidTest`
from `android/`. `ShellLifecycleTest` exercises recreation, durable cookies and
web storage, configuration callbacks, connection-panel retention, and native
Back. `HostPolicyTest` covers endpoint/origin rejection and fold geometry.

`ShellConnectionTest` covers actual HTML login failures and corrected sign-in,
post-login Back without credential replay, HTTP/HTTPS POST receiver silence,
host switching, canceled/confirmed all-origin deletion, and persisted pending
deletion. The unsupported-deletion case skips when the current provider supports
the deletion feature; a passing current-provider run does not exercise that
older-provider branch.

The OS-scheme test uses the real UI mode service. Some API 29 Google APIs images
lock night mode against the ordinary shell UID; those images require a disposable
`userdebug` emulator with verified `su 0` access. The test checks that prerequisite
explicitly and restores the original night setting. Unlocked images use the
ordinary shell command; no production root access or test hook is involved.

`ShellThemeTest` covers five system-bar behavior groups for #1115:

- Root-canvas changes update native chrome while preserving the live WebView,
  draft, selection, and scroll position.
- The connection panel retains native background/light icons and returning to
  the retained host applies its latest canvas, including changes while hidden.
- Only the current trusted main frame can change chrome: reject foreign origins,
  child frames, stale views, non-string messages, and strings other than exact
  six-digit `#RRGGBB`; the channel has no replies or general Java host interface.
- Token-free sign-in navigation, activity recreation, and HTTP failure use the
  visible surface's chrome; recreation derives the document color again.
- Real OS night-mode changes reach the retained WebView's media query, update
  native colors/icons, preserve its draft/selection, and leave the connection
  panel blue in both schemes. The setting is restored after the test.

Run the focused suite from `android/` on an unlocked selected device:

```bash
ANDROID_SERIAL=DEVICE_SERIAL ./gradlew --no-daemon :app:connectedDebugAndroidTest \
  -Pandroid.testInstrumentationRunnerArguments.class=ai.lankford.ompui.android.ShellThemeTest
```

### Required system-bar device matrix (#1115)

The following is the repeatable verification procedure. The recorded #1115 run
appears below it; earlier recovery/hardening proofs cover their own stated changes.
Instrumentation does not replace full-device screenshots: WebView/CDP screenshots
omit native system bars.

1. Rebuild and install the APK above, and run the host from this checkout.
   Updating only the hosted renderer does not add native system-bar support to
   an older APK. Once installed, later hosted themes require no APK reinstall.
   Record APK/host revisions, device serial, API level, WebView provider/version,
   and support for both required provider features with each result.
2. Exercise API **29, 35, and 36**, each with **gesture** and **three-button**
   navigation. Select the navigation mode in Android Settings (do not infer it
   from the API level). For each of these six configurations, use fixed dark,
   fixed light, saturated-color, and imported themes, plus **Follow system**
   while changing the Android system appearance in both directions. Record the
   effective document canvas RGB and both light-status-bar/light-navigation-bar
   appearance flags from the existing window/instrumentation state; light-bar
   flags mean dark icons. They must follow contrast, not the theme label.
3. Capture the entire device for each case, including both bars, from the
   repository root (substitute the serial and a distinct descriptive filename):

   ```bash
   adb -s DEVICE_SERIAL exec-out screencap -p > /tmp/api29-gesture-dark.png
   ```

   Inspect/sample flat inset backplate pixels away from icons, gesture handles,
   navigation buttons, and antialiased edges. Their RGB must exactly match the
   opaque document canvas, with no navigation scrim or divider. Confirm readable
   icon contrast on both bars and retain screenshots and flag observations;
   do not treat a matching CSS value or WebView-only image as native proof.

4. On the API 36 foldable, repeat cover/inner fold transitions, portrait and
   landscape rotation, and IME open/close with a selected tab and unsent Unicode
   draft. Check bar/backplate color, both icon flags, unchanged retained WebView,
   draft, selection, and reading position. Reuse the real fold/rotation setup
   below; separate flat AVDs are not a fold-transition proof.
5. Open **Host connection…**, change the retained host's theme while its WebView
   is hidden, and return. The native panel must remain `#101820` with light icons;
   return must apply the latest cached host color without replacing the WebView.
   Check failure and data-clearing panels use the same native appearance. Switch
   hosts, navigate through token-free sign-in, and recreate the activity: no old
   host color may leak to a native panel or replacement view, and a restored host
   must derive its canvas again. Keep the draft/selection/scroll assertions in
   the retained-view cases; recreation is not a promise of DOM preservation.
6. Record pass/fail and any unavailable configuration explicitly for every matrix
   cell. A passing API 36 gesture run is not evidence for API 29, API 35, or
   three-button navigation. Do not mark this matrix verified until those results
   and full-device captures exist.

### System-bar proof recorded 2026-11-08 (#1115)

The debug build, Android unit tests, and lint passed with JDK 21.0.13 and SDK 36.
The complete instrumentation suite passed on API 29, 35, and 36: 19 passed and
one existing older-provider-only deletion case skipped on each. All three
disposable AVDs used standalone Chromium WebView 156.0.8078.47, including real
document-start scripts, WebMessages, binary-message rejection, and browsing-data
deletion. The new OS-scheme regression failed against the prior fixed-dark APK
before passing with the day/night `android:isLightTheme` resource.

| API / disposable AVD | Gesture navigation | Three-button navigation |
| --- | --- | --- |
| 29 / Pixel 3 | Six cases passed | Six cases passed |
| 35 / Pixel 5 | Six cases passed | Six cases passed |
| 36 / Pixel Fold | Six cases passed, inner display | Six cases passed, cover display |

Each cell includes Graphite (`#0a0b0d`), Light (`#e8ecf0`), Solarized Light
(`#e6e0cd`), the imported Native Canvas Proof palette (`#192d42`), and real
OS-light/OS-dark transitions with Solarized Light/imported picks. Thirty-six
full-device screenshots and measured RGB/appearance records were retained in
the verification run's `proof/` directory. Six unobstructed top/bottom pixels
and three navigation-boundary pixels matched the effective canvas exactly in
every case. Both window icon-appearance flags requested dark icons for the two
light canvases and light icons for the dark canvases; screenshots confirmed the
visible polarity. Fixed/imported/OS transitions retained the same document,
composer node, unsent Unicode draft, and selection within each configuration.
Changing Android's navigation mode itself recreated the activity; that is not
claimed as a retained-WebView transition.

The real two-host proof also covered native-panel return after a hidden host
theme change, distinct host colors, an unreachable-host failure, ordinary reload,
all-host clearing, and actual app process restart with recovered draft/selected
tab and rederived canvas. Native panels stayed `#101820` with light icons, and
their body pixels were identical across OS light/dark schemes. Physical fold/
unfold and acceleration-sensor rotations retained the document, draft, selection,
and selected tab. Keyboard-open/closed screenshots in both inner orientations
and on the cover showed the composer above the IME without a new bottom strip;
Android sometimes hid the keyboard during display/rotation changes, so it was
explicitly reopened for the settled-layout checks.

**Platform limits:** the API 36 inner display's three-button **Launcher taskbar**
is a separate system-owned window; its Graphite-case background measured
`#111318`, not the app's `#0a0b0d`. The cover-display three-button cases have no
tablet taskbar and matched exactly. The app does not recolor that taskbar or the
keyboard. The foldable AVD still published a null book split; physical Samsung
fold posture/cutout behavior remains a hardware check, not an inferred result.


For a real UI proof, start the host using `dev:headless` as described below,
forward its remote port with `adb -s DEVICE_SERIAL reverse tcp:PORT tcp:PORT`,
and connect the Android app to `http://localhost:PORT`. Debug builds expose the
WebView through `adb forward tcp:LOCAL_PORT localabstract:webview_devtools_remote_PID`;
release builds explicitly request debugging disabled and have no debuggable
manifest flag. Debug/userdebug Android images can override this: WebView 124's
[provider](https://github.com/chromium/chromium/blob/124.0.6367.219/android_webview/glue/java/src/com/android/webview/chromium/SharedStatics.java)
ignores disable requests on debug Android builds, so an emulator with
`ro.debuggable=1` is not proof that a release APK enables debugging on a production
device. Use a production Android build for that runtime security check. Use real
fold/unfold and acceleration sensor commands on a hinge-capable AVD, not two independent flat profiles.
With the disposable API 36 foldable used for #1100, host GLES with Vulkan off
(`-no-window -gpu host -feature -Vulkan`) avoided a bundled SwiftShader crash.
Dismiss the emulator's keyguard before lifecycle tests. Apply density overrides
after the physical display switch has settled, not immediately after `emu fold`.

The live proof covered cover/inner transitions with an open keyboard, portrait
and landscape rotation, the same mounted reading block, selected session and
Unicode draft, process-restart text recovery, a system-picked PNG attachment,
and saved blob-download bytes. Physical Samsung Fold 8 posture reporting still
needs a hardware check; the emulator did not publish a non-null book split.
The app remains width-adaptive when native folding features are absent.

The hardening proof also exercised the real host's wrong-password correction
and HTTP 429 lockout page, physical Back during a held turn, all-host deletion
and sign-in removal, and a new incrementally streamed turn after actual app
process restart. The host's omp PID stayed unchanged. An unacknowledged handoff
was held by pausing only that disposable omp child; after its pending text
reached the WebView journal, the app was force-stopped and reconnected. The text
remained separate until explicit recovery, with no automatic model request.
Do not mistake `localStorage.getItem()` for a disk-commit barrier: an immediate
force-stop restored an older draft snapshot in a separate run. Recovery is
best-effort, and `ActivityScenario.recreate()` alone is not process-death proof.

## Workspace layout

| Path | Responsibility | Main entries and tests |
|---|---|---|
| `packages/core` | Plain Node and TypeScript for OMP-facing behavior, including PTYs, rpc-ui framing, session files, settings, updates, and shared backend types. It must not import Electron or a transport. | Public exports start at `src/index.ts`. Tests live beside source as `src/**/*.test.ts`, including `src/rpc/*.test.ts`. |
| `packages/desktop` | Electron shell, backend orchestration, preload bridge, React renderer, remote web entry, and packaging configuration. | Main process: `src/main/index.ts`. Preload: `src/preload/index.ts`. Desktop renderer: `src/renderer/index.html` and `src/renderer/src/main.tsx`. Browser renderer: `src/web/index.html` and `src/web/main.web.tsx`. Tests are colocated as `*.test.ts` and `*.test.tsx`. |
| `packages/server` | Node HTTP and WebSocket transport that serves the browser bundle and exposes the same typed backend used by the desktop renderer. | Public server entry: `src/index.ts`. Tests live beside source as `src/*.test.ts`. |
| `android` | Installable Kotlin/WebView client using the existing host-served renderer; no npm workspace or second backend. | `app/src/main/java/ai/lankford/ompui/android/MainActivity.kt`; policy unit tests in `app/src/test`, lifecycle tests in `app/src/androidTest`. |

The desktop and browser entries load the same renderer. Electron reaches the backend through the sandboxed preload and IPC. The browser entry installs the WebSocket backend before it imports renderer code. See [Architecture](architecture.md) and [ADR-0002](adr/0002-transport-agnostic-core.md) for the boundary and its rationale.

## Contributor invariants

Read [`CONTEXT.md`](../CONTEXT.md) before changing code. It defines terms such as session, live session, tab, lineage, owned session, render item, and inspector rail. Use those terms in code, issues, and commits, and respect every `_Avoid_` list. An npm workspace is the package-manager concept; a user-registered working directory is a project.

Keep these rules intact:

- Current source is authoritative when an old plan or old prose disagrees with it. Use the phase documents and ADRs for intent and rejected alternatives, then verify behavior in the implementation.
- `packages/core` stays free of Electron and transport imports. Electron-specific wiring belongs in `packages/desktop`; HTTP and WebSocket transport belongs in `packages/server`.
- A session file is the source of truth. omp-ui reads and resumes it, but never rewrites its contents. The only destructive write is an explicit, user-confirmed deletion of the whole owned lineage directory.
- One main process owns the registry and live sessions. Never spawn a second OMP process for the same session. Closing a tab hides it; it does not stop the live session.
- Native transcript render items are derived state. Unknown event types add nothing rather than breaking the transcript or changing the session file.
- Search for an existing GitHub issue before filing a bug or feature request. Keep one request or defect per issue, use `CONTEXT.md` vocabulary, and do not close the issue until the change has been verified.
- Mark every issue a commit cites as `Fixes #N` (completes it) or `Refs #N` (does not). `npm install` sets `core.hooksPath` to `.githooks`, whose `commit-msg` hook enforces this. Pushes to `main`/`develop` close `Fixes` issues and comment on any issue that lands unmarked.

The full agent and contribution rules are in [`AGENTS.md`](../AGENTS.md). Review the [phase 1 PTY plan](phase-1-pty-embed.md), [phase 2 rpc-ui plan](phase-2-rpc-ui.md), [phase 3 ACP plan](phase-3-acp.md), and [ADRs](adr/) before changing a documented decision. The [session format reference](session-encoding.md) covers the on-disk JSONL format and path encoding.

## Development and test controls

The following environment variables are developer and test seams. They are not user settings, are not part of the supported settings surface, and should not appear in user setup instructions.

| Control | Development or test effect |
|---|---|
| `OMP_UI_OMP_PATH` | Adds an explicit OMP executable as the first binary-resolution candidate. If it does not exist, resolution continues to the managed copy and normal search paths. |
| `OMP_UI_INSTALL_DIR` | Overrides the directory that holds omp-ui's managed OMP executable. This is a directory, not the executable path. |
| `OMP_UI_REGISTRY_PATH` | Replaces the main process's default `registry.json` path, which isolates a development run's app state. |
| `OMP_UI_CDP_PORT` | Adds Electron's `remote-debugging-port` switch for programmatic renderer inspection. The switch is Chromium-wide, so every browser pane page is also a tokenless target on that port beside the app renderer. Set it only for a local development run. On unpackaged Linux runs the app checks `/proc/net/tcp{,6}` and falls back to the next free port when the configured one is held by a LISTEN or TIME-WAIT socket (#783); the chosen port is written to `<userData>/dev-cdp-port.txt`. |
| `OMP_UI_HEADLESS=1` | Selects the `@omp-ui/desktop-dev-headless` userData identity so a headless verification run never collides with — or focuses — an interactive dev instance. Set by `npm run dev:headless`; it changes nothing else. |
| `OMP_UI_TEST_MODEL` | Pins the main model of every session this app instance spawns — fresh or resumed, terminal or native — by passing the `provider/model[:level]` selector to OMP as `--model` and writing it into the lineage's `omp-ui-model.yml` overlay as `modelRoles.default`. It overrides the project's default-model pin and last-used model, and never rewrites a registry record. A selector OMP cannot resolve fails the spawn with OMP's own message in the tab's failure surface. |
| `OMP_UI_TEST_ADVISOR` | Pins only the advisor model, as `modelRoles.advisor` in the lineage's advisor overlay. The advisor's on/off posture still comes from the session record and the composer, so an advisor test under the gate still tests the advisor. |
| `OMP_UI_APP_UPDATE_ENABLE=1` | Forces app-update behavior on for an unpackaged development build. |
| `OMP_UI_APP_UPDATE_VERSION` | Overrides the current app version passed to the updater. |
| `OMP_UI_APP_UPDATE_FORMAT=appimage` | Supplies the development-only AppImage environment needed to reach the AppImage updater path. Other values do not select a fake package format. |

Pass controls on the same command invocation so they do not leak into later runs. For example:

```bash
OMP_UI_OMP_PATH=/absolute/path/to/omp \
OMP_UI_REGISTRY_PATH=/tmp/omp-ui-registry.json \
OMP_UI_CDP_PORT=9222 \
npm run dev
```

The app-update controls can contact and act on real release metadata. Use them only for a deliberate updater test, with an isolated registry and no live session you need to preserve.

### Verification runs

A CDP verification run pins both model roles to an explicitly available, operator-approved selector (or an isolated hermetic provider fixture). Pins on the interactive app do not apply to a separate dev instance. Never silently substitute an unavailable model; report the missing prerequisite. Delegated work follows the run's model unless an explicit approved override applies.

```bash
OMP_UI_TEST_MODEL="openrouter/openai/gpt-6.1-sol" \
OMP_UI_TEST_ADVISOR="openrouter/openai/gpt-6.1-sol" \
npm run dev:headless
```

Verification runs boot the app headless. `dev:headless` maps no window and takes no focus, isolates the run's userData and registry (`OMP_UI_REGISTRY_PATH` defaults to a fresh temp file; whichever registry the run uses gets `desktopNotifications` forced off), sizes the virtual screen to 1600x1000, and exposes CDP on `127.0.0.1:9223`; set `OMP_UI_REGISTRY_PATH` or `OMP_UI_CDP_PORT` to override. After a main-process rebuild restarts the app, read `<userData>/dev-cdp-port.txt` and reconnect to the recorded port — the observer's pre-restart connections belong to the dead process (#783). Extra Chromium switches pass through from the workspace: `npm run dev:headless --workspace @omp-ui/desktop -- --no-sandbox`. Reach for `npm run dev` only when a human needs to see the window. One headless instance runs at a time: a second one exits on the single-instance lock.

The browser-pane smoke's `resize-canvas` step (#653) gates hard on GPU runners: a window surface resize drops an unchanged accelerated canvas from composited frames and no host-side emulation command restores it, so the host ends every size-changing apply with one inert page-side redraw of the page's 2D canvases, and the step fails when the marker is missing from the streamed frame after a resize. Software raster never loses the layer, so the step passes vacuously there. A stalled capture or a page-side pixel loss still fails the run. To inspect the raw state after a resize, run `npm run smoke:browser-pane --workspace @omp-ui/desktop -- --once --dsf=1.5 --size=1514x1337` and read the `resize-canvas` row of the summary.

The browser-pane smoke's `metrics-open-viewport` and `metrics-clear-viewport` steps read actual Chromium geometry immediately after each viewport-command reply, without waiting for the reassert debounce (#1072, omp 18.17 upstream #18160). Both must already report the pane's CSS size and density; an agent's open-time viewport must not govern the pane until a timer fires.

Viewport replies wait at most one second for host metrics restoration. Unit regressions cover a stalled debugger command, deferred/rejecting bridge settlement, and the delayed pre-commit fallback; the live metrics steps cover normal Chromium restoration before reply.

#### Sidebar feature toggles

The Fleet and Artifacts sidebar buttons toggle their respective views. Other
launchers remain explicit opens, including artifact selection links. Both the
open and dismiss branches must close the compact Sessions sheet.

In an isolated headless run, click each sidebar button three times and check
open, closed, then open again. The rendered view, store state and `aria-pressed`
must agree. Switch Fleet → Artifacts → Fleet and check that only the requested
feature is open and pressed. Also check Enter activation and the existing close
controls. At 390 × 844, open Sessions, select a feature, reopen Sessions and
select it again. Both selections must leave `compactSurface === null`, first
with the feature open and then closed. Repeated explicit-open actions must keep
the view open and preserve the existing artifact selection handling.

#### Artifact library acceptance (#1121)

The experiment remains off by default. Run the deterministic suites and both
desktop TypeScript projects before runtime proof:

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run smoke:artifact-library --workspace @omp-ui/desktop
npm run test:live --workspace @omp-ui/desktop
```

`artifact-library-smoke.ts` is a separate built Electron entry, excluded along
with its output from every package file list. It selects Linux headless Ozone
before readiness, maps no window, and writes JSON/PNG evidence under
`packages/desktop/out/artifact-library-smoke`. It uses shipped self-contained
CommonJS preloads, actual separate WebContents and two sequential Electron
processes over one isolated store. It checks kernel seccomp and rejects
`--no-sandbox`; do not weaken the sandbox to make this proof pass. A real SQLite
trigger refusal exercises storage-write failure, not physical disk exhaustion.

The proof covers pre-Keep saves, check/note/dataset/provenance restart checksums,
root/guest/frame/ticket authority, network/loopback/WebSocket/STUN/device denial,
rate/JSON refusal recovery, CAS, trusted save/reload status, delayed-save disable
fencing and re-enable retention. Correlate host notices by surface ID and wait
for the actual event: a guest receipt and root chrome cross different renderer
processes, so their delivery order is not a synchronization contract.

Use the real derived curated palette in the smoke, not hex-only stand-ins:
registered themes include CSS Color 4 alpha values containing `/`. Palette
admission must still reject URL functions and bound the complete generated CSS.
Exercise Escape through the actual guest's `sendInputEvent`, await the correlated
host notice, and verify the native dialog closes without replacing its guest.
Parent-page CDP keyboard events alone do not prove cross-WebContents routing.

`artifact-library-live.test.ts` uses real OMP and a hermetic loopback provider;
no external API key/model is required. It exercises cold/warm factories and
hot roster reconciliation, persisted native render/capture details, Keep/Apply,
immutable data consent, and complete Unicode paging. Missing/skipped new runtime
obligations are not passing release evidence.

The loopback fixture simulates the reported OpenRouter Responses root-schema
restriction on its existing Chat Completions endpoint. It rejects own root
`oneOf`, `anyOf` or `allOf` on advertised omp-ui host tools with HTTP 400 before
the scripted responder runs, without inspecting nested schemas. Its greeting
case requires an actual assistant reply, not only registration or turn-end
acknowledgements. This is not an OpenRouter Responses integration test.
External acceptance uses separate isolated headless runs pinned to
`openrouter/anthropic/claude-opus-5.5` and `anthropic/claude-opus-5-5` with
Artifacts enabled and the advisor disabled. On the built-in OpenRouter
Responses route, check a completed greeting, hot disable/re-enable with a
correlated roster update and another greeting, then direct managed render,
real Keep, Refresh now, direct capture and human Apply. Accepted data must
stay unchanged until Apply. Do not substitute routes or relax null validation.
Record unavailable external checks separately from hermetic passing evidence.

For [#1135](https://github.com/LankfordAI/omp-ui/issues/1135), both pinned
provider runs passed on OMP 18.18.4. The OpenRouter run completed greetings
before and after acknowledged hot re-registration, then direct render,
Keep, Refresh now, capture and Apply with manual fixture data changing from
`[1,2]` to `[3,4]` only after Apply. The focused core, desktop service/bridge
and serial real-OMP suites passed 25, 170 and 10 tests respectively.

For the full application scenario, use distinct disposable registry parents,
`XDG_CONFIG_HOME`, `XDG_DATA_HOME` and `PI_CODING_AGENT_DIR` with existing isolated
session roots, then the pinned `dev:headless -- --pane` launcher. Do not use the
user's live registry/sessions. Inspect off→enable without a model prompt;
session→Keep→restart; live/dormant reference targets with retained drafts;
compatible/stale/incompatible revisions; failed/successful refresh and human
Apply; source/project deletion; disable/re-enable; and a second authenticated
browser client's static document. Check actual 320px, 390px and desktop captures,
keyboard focus, both scroll axes, source links and light/dark contrast. Stop
the headless watcher before further source edits, and reconnect to its recorded
CDP port after a main rebuild.

Both library and transcript expansion use native dialog focus containment over
the existing guest. Include a manual edit after capture staging but before Apply,
then verify that Apply retains that edit. Verify historical views refuse writes,
and that a kept viewer remains writable after its reporting session and project
are removed. Insert generated multiline refresh drafts as one input edit; typing
unmodified newline keys into the composer can submit separate turns instead.
Record the actual selected CDP port from the launcher/port file, since a preferred
port can fall back. Label hermetic model-provider fixtures explicitly in evidence.

#### Device pane acceptance (#1009)

Use Linux `dev:headless` for the owning app and disposable AVDs, not the
interactive app or an AVD with user data. This recipe isolates the AVD homes,
registry and XDG config/data while using an explicitly selected, installed SDK.
Creation never borrows a donor, downloads an image, or rewrites an existing
AVD. Install prerequisites deliberately with SDK Manager before starting; use
the owner's chooser diagnostics for the exact missing packages. A working
JDK and SDK Command-line Tools (`cmdline-tools/latest/bin/avdmanager`),
platform-tools, emulator, complete native-ABI mobile images and usable host
acceleration are required for Create.

```bash
# Set this to the real owner SDK, not a viewer's SDK.
export ANDROID_HOME=/absolute/path/to/Android/Sdk
export ANDROID_SDK_ROOT="$ANDROID_HOME"
proof_root=$(mktemp -d /tmp/omp-ui-device-proof.XXXXXX)
export ANDROID_USER_HOME="$proof_root/android"
export ANDROID_EMULATOR_HOME="$ANDROID_USER_HOME"
export ANDROID_AVD_HOME="$ANDROID_USER_HOME/avd"
mkdir -p "$ANDROID_AVD_HOME"

"$ANDROID_HOME/emulator/emulator" -version
"$ANDROID_HOME/emulator/emulator" -accel-check
"$ANDROID_HOME/cmdline-tools/latest/bin/avdmanager" list device
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --list_installed

OMP_UI_REGISTRY_PATH="$proof_root/registry.json" \
XDG_CONFIG_HOME="$proof_root/config" \
XDG_DATA_HOME="$proof_root/data" \
OMP_UI_TEST_MODEL="openrouter/openai/gpt-6-luna:low" \
OMP_UI_TEST_ADVISOR="openrouter/openai/gpt-6-luna:low" \
npm run dev:headless --workspace @omp-ui/desktop -- --pane
```

Use the printed CDP port file for the actual owner renderer and the printed
loopback pane URL for a served client. Keep SDK/AVD variables on every owner
restart; a disposable registry does not isolate Android's AVD storage. Create
a live rpc-ui tab and use the real chooser to create **Small Phone** (API 35),
**Small Tablet**, **Pixel 9 Pro Fold**, and **6.7-inch Foldable** (API 36 for
the latter three). Search/select with the keyboard, review the exact image
package and proposed API-specific name, and explicitly confirm Create.
Wait for the operation to clear and `phase: streaming`, `screen: active`,
`inputReady: true`; acceptance of Create/Boot alone is not readiness. Keep
each AVD/serial/binding UUID in the proof record. Choose names under this
disposable AVD home and never edit LCD, hinge or posture keys to make a test
pass. A native profile/image absent from the owner's SDK must be unavailable,
not replaced with another profile or ABI.

For input evidence, install a disposable native test APK or the app under
development on each recorded serial, using an explicit selector:
`"$ANDROID_HOME/platform-tools/adb" -s SERIAL install -r /absolute/path/to/probe.apk`.
The fixture needs four distinguishable corner targets with native event
logging, a draggable target, a real `ScrollView` with observable scroll offset,
and an `EditText` retaining content across configuration changes. Use
`FULL_SENSOR` orientation for the four-quadrant fixture; retain the APK,
source, native event logs and manifest orientation policy with the proof.
A canvas screenshot or a successful RPC alone is not native input evidence.

| Slice | Required observation |
|---|---|
| Four devices × four quadrants | On the actual phone/tablet/book/flip, request physical 0/90/180/270. Check native model readback, fresh screenshot rotation and four distinct native corner events. Include same-size 180-degree transitions; do not infer input rotation from legacy UIAutomator XML when the independent native input viewport differs. |
| Touch, wheel, keyboard and IME | Verify native drag coordinates and actual ScrollView deltas; on touch-only targets wheel becomes a finite bounded host swipe. Native wheel requires positive runtime axis/display evidence. Type ASCII and commit non-ASCII through Chromium CDP `Input.imeSetComposition`/`Input.insertText`; inspect the native EditText. Begin a drag or hold a key before rotation and observe the original UP/release. |
| Book/flip and screen power | Retain a unique editor token across closed/half-open/open and physical rotations on the same serial. Observe native cover/inner dimensions and independently committed guest posture. Test only advertised postures; unsupported controls must explain why. Observe guest sleep/wake separately: inactive screen disables input and removes stale geometry; wake restores fresh input without losing text. Never require every closed foldable to sleep. |
| Identity and lifetime | Reject old binding/revision input while accepting current text. Hold an agent lease and refuse competing UI rotate/bind. Final unsubscribe must leave zero active screenshot streams and no further encodes; hidden controls must add no encodes, and resubscribe must replay a fresh current identity with at most one stream. Close retains binding; Disconnect releases it; disposal leaves the emulator alive. Confirmed Power off affects only its captured current binding. Exercise reload, reconnect, stale confirmations and ACK/drop/bitmap cleanup with both pane channels. |
| Remote ownership | Drive the owner through a served browser and a joined instance. Inventory/create/control use the owner's SDK, not viewer-local tools. Replay old remote input and a stale Power off confirmation after rebinding; both the old and new emulator must survive the refused confirmation. |
| Real agent gate and parity | Spawn once with Agents can use devices off and confirm `omp-ui_device` is absent. Enable it, spawn/resume and use the real registered bridge for `profiles`, `create`, `state`, `rotate` and `posture`, not direct calls standing in for registration. Poll State after Create acceptance. Check `targets`/`use`, selector refusal, lease release and the existing webhook/MCP exclusion. `orientation auto` remains guest policy, not a physical rotate; an app-locked orientation must fail honestly rather than claim it rotated. |
| Responsive and prerequisites | Inspect the actual owner in light/dark at nominal pane widths 300/420/900, full-column, compact 390×844 and short landscape 844×390. Reach every More action by internal scroll, keep chooser/menu inside the visual viewport, preserve 44px compact targets, and switch browser/device in their shared slot. Isolate missing SDK, command-line-tools and no-eligible-image cases; disabled Create must show owner reasons/copyable commands while existing AVDs remain selectable where prerequisites permit. |

For negative prerequisites, use a separate SDK facade exposing only the
components under test, never rename or remove the real SDK's files. To prove
the SDK is completely absent, also launch with an isolated `HOME`: resolution
falls back to the OS default SDK location when explicit roots are invalid.
Record a pre/post SHA-256 for a disposable pre-existing noncatalog AVD's
`config.ini` while booting/binding/powering it off; it must not change. Power
off each disposable emulator explicitly before removing its proof directory:
closing the pane or stopping the headless app intentionally does not kill it.
Retain image `source.properties`, emulator version, SDK root, serials,
screenshots, native logs and assertions with each run; do not commit private
tokens or gRPC discovery credentials.

**Recorded #1009 proof scope:** Linux x64 with KVM, Android emulator
**37.2.13, build 16740729**. The installed images were
`system-images;android-35;google_apis;x86_64` **revision 9, extension 13**;
`system-images;android-36;google_apis;x86_64` **revision 7, extension 17**
(`IsBaseSdk=true`); and an additional real agent-created Small Phone used
`system-images;android-29;google_apis;x86_64` **revision 13**, with no
`ExtensionLevel` property. Extension metadata is not a platform minor
version. The four chooser-created devices above passed all four physical
quadrants and native input/IME; book and flip retained text through posture
changes. The generic API 36 flip remained Awake/active when closed; explicit
gated-agent hardware sleep/wake proved Asleep/inactive/input-disabled and
recovery with the same text. A noncatalog Pixel 7 AVD retained its config
SHA-256. Real tool registration/gate, asynchronous creation, busy lease,
original drag/key release, stale same-binding revision text and stale remote
binding/Power off refusal were exercised. Guest `orientation auto` preserved
physical quadrant 1; `orientation portrait` did not confirm under the native
probe's FULL_SENSOR policy and reported failure rather than overriding it.

The production host/client lifetime proof observed no encodes or active
streams while unsubscribed, at most one stream, no hidden-rotate encode growth, fresh
resubscribe replay and emulator survival after dispose. Actual owner UI
inspection covered the light/dark and size matrix above. The short-landscape
More menu, after its visual-viewport clamp fix, ended at y=382 in a 390px
viewport; its final 44px action ended at y=377.2 and remained reachable by
internal scrolling. Missing command-line-tools/no-image SDK facades and a
fully absent SDK under isolated HOME produced prerequisite diagnostics.
These are bounded functional observations, not performance benchmarks or
Windows, macOS or Apple Silicon runtime proof.

#### Stats managed-collector proof

Run the isolated, no-model-call proof against the executable selected by the
same `resolveOmpBinary()` path as the application:

```bash
npm run test:live --workspace @omp-ui/desktop -- src/main/stats-collector-live.test.ts
```

The suite uses disposable home/config/data/profile trees and seeded JSONL only;
it never inherits provider credentials, opens the user's database, launches the
OMP dashboard, or restores an archive. It requires actual code-0 child closure
and the intended readable database, checks default/named/XDG/custom-agent/dotenv
source targeting and legacy cursor migration, then verifies exact request,
token, cost, agent, fork-deduplication, and tool-outcome amounts. Unchanged runs
must not duplicate usage; late empty/error outcomes update the retained tool
owner without adding calls. Transcript/archive hashes must remain unchanged
apart from the fixture's explicit appends. A separate controllable subprocess
proves TERM-resistant reaping and host single-flight retention.

The verified OMP 18.17.0 collector produces message rollup version `2` with
trigger version `4`; the reader deliberately retains its supported version-`3`
guard and uses raw fallback. The proof records observed schema metadata rather
than requiring a particular executable version or treating summary output as
completion. A tool-result-only collection can update outcomes while reporting
zero newly processed request entries.

For a rendered proof, use the isolated headless launch and direct workspace
`--pane` command below, with seeded Projects/owned lineages and a pinned resolved
binary. Open Stats through the command palette in both clients; exercise range,
Project, paired provider/model and agent filters, tool sorting, UTC chart labels,
narrow light/dark layouts, source/coverage caveats, and collection failure with
retained figures. Concurrent clients must observe one host run; browser reload
must recover it. Use a separate disposable database transaction to hold a writer
lock when exercising indeterminate indexing and nonzero-exit retention, then
roll it back. Keep collection freshness distinct from latest recorded usage.

#### First-launch and served-client checks

To verify the Getting started checklist's first-launch gates, a throwaway registry is not enough: the binary row reads `resolveOmpBinary()`, whose PATH scan finds the managed copy whenever the run is launched from a shell inside the packaged app (that PATH starts with `~/.local/share/omp-ui/bin`), and the provider row additionally sees ambient env, the login shell's rc exports, and subscription accounts. Simulate a virgin machine by clearing the environment:

```bash
env -i HOME=$(mktemp -d) PATH=/usr/bin:/bin SHELL=/bin/bash \
    XDG_RUNTIME_DIR=$XDG_RUNTIME_DIR TMPDIR=/tmp \
    OMP_UI_INSTALL_DIR=$(mktemp -d)/bin \
npm run dev:headless --workspace @omp-ui/desktop
```

`OMP_UI_INSTALL_DIR` redirects both binary resolution and the checklist's Install download target, so the download lands in the temp dir instead of the real managed dir. Expect all four rows pending with their actions; clicking Install runs the real GitHub download and flips row 1. Without an OS credential store (what `env -i` also removes), saving a key from Settings refuses to store it — by design, the page says so — so exercise the connected state by exporting a provider variable instead (`OPENROUTER_API_KEY=…` before `env`, giving `source: "environment"`).

Pass `--pane` instead of a Chromium switch — `npm run dev:headless --workspace @omp-ui/desktop -- --pane` — and the run additionally serves its own UI over loopback HTTP so it can be watched live in another omp-ui instance's browser pane (issue #553). The launcher seeds `remoteEnabled`, `remoteBind: "localhost"`, a free `remotePort`, and a fresh `remoteToken` into the registry it uses (these keys win even in a user-supplied `OMP_UI_REGISTRY_PATH`, which otherwise keeps all its other settings), spawns `vite build --watch --config vite.web.config.ts` so the served `out/web` bundle stays current, and prints one line:

```
dev:headless: pane=http://127.0.0.1:PORT/?t=TOKEN
```

The printed URL may initially return `503 Service Unavailable` until the first web build finishes. After the build completes, reload the same URL to load the current bundle without restarting the remote server.

An agent loads that URL with `browser.open(...)` from a *different* omp-ui instance: the browser-pane guard (#531) denies a pane page access to its own instance's remote port, so an instance cannot watch itself. Over HTTP the pane covers the full renderer, but native-window-only surfaces (title bar overlay, window state, menus, OS notifications, spellcheck, pane sizing) stay out of reach and remain covered by CDP on the hidden instance. Two runtime races are accepted in dev: a rare rebuild can empty `out/web` for a moment (`emptyOutDir: true`), so a pane reload racing a `vite build --watch` cycle 503s — reload again; and if another process binds the probed port between the launcher's free-port probe and the app's bind, the settings page reports the port-in-use error while the printed URL is already stale.

That pairing — Luna as the main selector, Terra as the advisor selector — is the recommended default; `openrouter/z-ai/glm-5.3-flash:low` is the alternate main selector when a run wants the wider context. Every documented example names an OpenRouter selector, never a local endpoint: a run on a machine without that host running would fail the spawn instead of cheapening it. Re-check a selector, its thinking levels, and whether it accepts image input with `omp models find <model>`; choose one reporting `images: yes` for a run that exercises image paste, and avoid a `:batch` variant, since a verification run waits on its own output and batch delivery has no latency promise.

Three cautions:

- Always pair the gate with a throwaway `OMP_UI_REGISTRY_PATH`. The renderer records a session's live model as that registry's project `lastModel`, so a polluted development registry silently becomes the next run's default model.
- Subagents follow the gate only while OMP's `task.agentModelOverrides` has no entry for their agent type. Setting `task.showResolvedModelBadge` makes each delegated session's resolved model visible in the transcript.
- Read the main model from OMP's own report — the `model_change` entry in the transcript or the composer's model button. The composer's advisor chip instead shows the session record's or OMP's configured advisor model, because OMP reports no resolved advisor model over rpc-ui: the authoritative check for `OMP_UI_TEST_ADVISOR` is the lineage's `omp-ui-advisor.yml`. Under a spawn gate the chips invert that: the gate's selectors are what the child actually runs, so the composer and PlanReview show the gated model read-only, tagged `DEV/TEST`, with a tooltip stating that this app instance overrides the advisor model and that saved choices are unchanged. The advisor on/off switch still writes the session record's own choice — the gate changes only the resolved model, never the saved tuple.
- A gated run never records: the registry's per-session `advisorModel`/model pins and the project `lastModel` keep user-level values, so an ungated launch of the same registry sees the previous saved choices, not the gate's selectors.

### Feedback dialogs

Lifecycle confirmations (settling a running session / mode switch / remove project) and backend error notices no longer use `window.alert`/`window.confirm`. They render as DOM `alertdialog` elements through the shared overlay stack (`AppFeedback`), so keyboard, automation, and remote clients drive them like any other UI. One dialog shows at a time: the oldest error notice outranks a pending confirmation without dropping that decision, and dismissing the last notice restores the confirmation. While a confirmation's effect is in flight the dialog is locked (Escape, backdrop, and close are no-ops, Cancel disabled) and the action cannot double-dispatch. Tests drive this through the store — the harness's native dialog stubs now throw — and the DOM carries focus affordances (`data-modal-initial-focus`) asserted by the component tests.

For the agent *driving* the run, rather than the app it drives, OMP's own settings are the lever and no omp-ui code is involved: `omp config set task.agentModelOverrides '{"task":"openrouter/openai/gpt-5.6-luna:low"}'`, `omp config set task.prewalk true`, and `prewalk.enabled` plan on the strong model and then hand off to a cheaper model at the first edit. Since omp 18.14 that hand-off target is `prewalk.into` (default the `smol` role, `@smol`) and `/prewalk restart` returns to `prewalk.from` (default `@default`); both accept a model selector or an `@role` and are editable under **Settings → omp → Context**.

## Continuous integration order

The main CI job uses Node 22 and runs these commands in order:

```bash
npm ci
npm run smoke:pty --workspace @omp-ui/desktop
npm run smoke:knowledge-vault --workspace @omp-ui/desktop
npm run lint
npm install --package-lock-only
git diff --exit-code package-lock.json
npm run typecheck
node --test scripts/release-artifacts.test.mjs
node --test scripts/release-notes.test.mjs
node --test scripts/close-landed-issues.test.mjs
npm test
npm run test:live
npm run build
npm run smoke:browser-pane --workspace @omp-ui/desktop -- --once
```

The `npm install --package-lock-only` and `git diff --exit-code package-lock.json` pair asserts that workspace metadata and `package-lock.json` agree. `npm ci` alone does not catch every workspace-version drift case.

### Self-hosted Linux pool

Same-repo CI, `release-linux`, and the nightly `linux-x64` lane run on the org's self-hosted Linux pool; jobs request `[self-hosted, gfx1201]` (the runners register with labels `linux,rocm,gfx1201`). The runner container registers `--ephemeral`, and the supervisor restarts it between jobs, but the same image filesystem comes back: a warm `~/.npm` and `~/.cache` and a mounted host Docker socket. Treat the pool as stateful — cache hits and host-visible mounts are the norm, and nothing on the release path asserts otherwise. Issue #629 proposed a dedicated fresh-container pool to change that contract; the pool will not be deployed, and its isolation detector was removed. A label no registered runner serves queues jobs forever instead of failing them — retargeting to that undeployed pool stalled every main-branch run for hours (issue #631).

The runner image and the compose-based supervisor live in `LankfordAI/Actions-Runner` under `Dockerfiles/ActionsRunner/`.

## Pull request reviews

This repository uses [CodeRabbit](https://coderabbit.ai) for **advisory** AI
reviews on pull requests. It is not a merge gate: there is no CodeRabbit GitHub
Actions workflow, no required status check, and no secret, and merging stays a
human decision. The behaviour lives in `.coderabbit.yaml` in the repository root
so it is version controlled.

Reviews use the *chill* profile, never auto-approve, keep their summary in the
walkthrough, skip the walkthrough poem, and disable the docstring and unit-test
generation finishing touches. `AGENTS.md`, `CONTEXT.md`, and
`docs/architecture.md` are loaded as coding guidelines, with architecture applied
to every path, so reviews respect the transport-agnostic core boundary of
[ADR-0002](adr/0002-transport-agnostic-core.md) and the vocabulary in
[CONTEXT.md](../CONTEXT.md).

### Activation (organization owner)

1. Install the CodeRabbit GitHub App from
   [github.com/apps/coderabbit](https://github.com/apps/coderabbit), choosing
   "Only select repositories" and selecting `LankfordAI/omp-ui`. An organization
   owner must approve the installation.
2. CodeRabbit detects the repository's open-source status and applies the OSS
   entitlement. Eligibility and rate limits are managed by CodeRabbit, not by
   `.coderabbit.yaml`, so this repository stores no key and needs no billing
   setup.
3. Open a pull request that contains `.coderabbit.yaml`. CodeRabbit reads the
   configuration from the branch under review and posts an advisory review.

### Manual review and configuration inspection

On any pull request, drive the review from a comment:

- `@coderabbitai review` runs, or re-runs, a review of the current head.
- `@coderabbitai configuration` prints the resolved configuration in YAML with a
  comment per setting naming its source — repository YAML, UI settings, or
  defaults — which is how you confirm `.coderabbit.yaml` parsed and took effect.

The schema URL in the first line of `.coderabbit.yaml` gives editor validation of
the file itself.

## Documentation-only changes

Do not add a runtime test solely to validate prose. For edited Markdown files, run this local path check and list the files after `-`. It checks relative links and image targets without making network requests:

```bash
node --input-type=module - docs/development.md <<'NODE'
import fs from "node:fs";
import path from "node:path";

let failed = false;
for (const file of process.argv.slice(2)) {
  const markdown = fs.readFileSync(file, "utf8");
  for (const match of markdown.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
    const raw = match[1].trim().replace(/^<|>$/g, "");
    if (!raw || raw.startsWith("#") || /^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = decodeURIComponent(raw.split(/[?#]/, 1)[0]);
    if (fs.existsSync(path.resolve(path.dirname(file), target))) continue;
    console.error(`${file}: missing ${raw}`);
    failed = true;
  }
}
if (failed) process.exit(1);
NODE
```

The check verifies local targets, not GitHub heading anchors or external URLs. Review changed anchors in GitHub's Markdown preview.
