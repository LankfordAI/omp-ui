# AppImage-only Linux distribution research

**Issue:** [#61 — Evaluate AppImage-only Linux distribution](https://github.com/LankfordAI/omp-ui/issues/61)<br>
**Scope:** Research and recommendation only; no implementation<br>
**Date:** 2026-08-05

## Reading this report

- **Observed** means directly supported by the cited omp-ui source, installed dependency source, T3 Code source, or first-party documentation.
- **Inference** means a consequence of observed behavior that has not been exercised end to end.
- **Recommendation** is proposed policy or future work.
- **Open decision** requires an explicit product choice before implementation.

## Executive conclusion

**Recommendation: GO only with a staged bridge release and a tested graphical per-user installer; NO-GO for an immediate hard cutover or for AppImage-only distribution without that installer.**

omp-ui already has the core T3-like AppImage update experience: it discovers a release, downloads an AppImage only after the user clicks, verifies the downloaded bytes against the SHA-512 declared in update metadata, offers a restart, routes that restart through the live-session quit guard, replaces the AppImage, and relaunches without a package manager or administrator password. It does not yet have the installation experience required to replace deb/rpm/Flatpak: the same AppImage must provide a graphical first-run installer that puts itself at a stable per-user path and creates a working Applications-menu entry and icon. The principal work is therefore that installer, release simplification, migration from the three legacy formats, runtime compatibility, and failure-policy hardening—not a new updater architecture.

The safe interpretation of **“AppImage only”** is: **AppImage becomes the sole first-party, supported Linux artifact; community packages may exist but are unsupported.** Attempting to prohibit AUR, COPR, Flathub, or other downstream packages is neither necessary nor realistically enforceable.

A direct cutover is unsafe because current deb/rpm/Flatpak installs select an exact same-format asset. When that asset disappears, they show `expected asset missing from release`; they cannot learn a migration path after the fact. A final bridge release must therefore ship in all four current formats and teach legacy installs how to move to AppImage before any legacy asset is removed.

The cutover is also gated on a real distro smoke matrix. The installed electron-builder supports the newer static AppImage runtime, but labels it **Beta**; it has not been validated for omp-ui. This report recommends testing it, not treating it as proven.

A pure AppImage cannot override Linux executable-bit enforcement. A browser download may therefore require one initial file-manager action such as **Properties → Allow executing file as program** before the AppImage can be launched, unless an external helper such as AppImageLauncher or an executable-preserving archive is used. That limitation must be stated rather than papered over. The product requirement is **no terminal at any point** and, after the one-time graphical install, normal launches from the desktop Applications menu ([AppImage launch instructions](https://docs.appimage.org/user-guide/run-appimages.html#download-make-executable-run), [AppImageLauncher integration](https://docs.appimage.org/user-guide/run-appimages.html#appimagelauncher)).

## Current omp-ui path

### Release and discovery

**Observed:**

1. A `v*` tag runs the Linux release job. electron-builder currently emits AppImage, deb, and rpm; a separate script emits a standalone Flatpak bundle. The release also carries `latest-linux.yml` and `SHA256SUMS.txt` ([builder config](../../packages/desktop/electron-builder.yml#L12-L29), [workflow](../../.github/workflows/release.yml#L19-L68)).
2. The app checks GitHub's latest stable release at launch when enabled, and manually from the command palette. Drafts and prereleases are rejected; network and parse failures are quiet for background checks ([core release lookup](../../packages/core/src/app-update.ts#L13-L79), [background check](../../packages/desktop/src/main/backend.ts#L412-L420)).
3. Package detection is `APPIMAGE` first, then Flatpak, then host `dpkg`, then host `rpm`, else unknown. The deb/rpm branches are host heuristics, not proof of how the app was installed ([format detection](../../packages/core/src/app-update.ts#L82-L97)).

### AppImage update and relaunch

**Observed:**

1. The update card's explicit action lazy-loads `electron-updater`, sets `autoDownload = false`, rechecks `latest-linux.yml`, and downloads only when an update is still available ([desktop updater](../../packages/desktop/src/main/app-update.ts#L140-L181)).
2. Installed `electron-updater` 6.8.9 requires `APPIMAGE`, stages the download in its updater cache, passes the metadata's SHA-512 value into the downloader, falls back from a failed differential download to a full download on Linux, and makes the staged file mode `0755` (`node_modules/electron-updater/out/AppImageUpdater.js:17-69`; `node_modules/electron-updater/out/AppUpdater.js:559-566,585-641`).
3. “Restart now” is accepted only for a downloaded AppImage and first awaits omp-ui's existing live-session quit guard ([restart](../../packages/desktop/src/main/app-update.ts#L227-L236), [quit guard](../../packages/desktop/src/main/index.ts#L31-L71)).
4. Installed 6.8.9 then **unlinks the old AppImage before** moving the downloaded file into its destination. This is not an atomic replacement. A failure after unlink and before a successful move can leave no AppImage at the old path (`node_modules/electron-updater/out/AppImageUpdater.js:72-100`).
5. Bare `quitAndInstall()` requests a relaunch through the upstream default, then calls Electron `app.quit()` (`node_modules/electron-updater/out/BaseUpdater.js:13-26`; `node_modules/electron-updater/out/AppUpdater.js:115-119`). omp-ui's `before-quit` handler kills every PTY/RPC/shell and stops the remote server after confirmation ([quit cleanup](../../packages/desktop/src/main/index.ts#L154-L164), [backend cleanup](../../packages/desktop/src/main/backend.ts#L462-L470)).

**Inference:** a user-writable AppImage path provides the intended end-to-end self-update. A root-owned directory or read-only mount does not: the download may succeed in cache, but unlink/move at the launch location cannot. There is no privilege escalation, relocation fallback, writable-location preflight, or retained old copy in the inspected AppImage install path.

### Legacy-format path

**Observed:** At the 2026-08-05 audit, deb, rpm, and Flatpak used an exact expected filename, required the matching entry from `SHA256SUMS.txt`, streamed the artifact to the Downloads directory, verified SHA-256, and opened the system installer. Missing assets or checksums failed closed ([asset selection](../../packages/core/src/app-update.ts#L99-L157), [handoff](../../packages/desktop/src/main/app-update.ts#L183-L215)). The standalone Flatpak was not backed by an OSTree repository, so `flatpak update` was not its update mechanism. [ADR-0011](../adr/0011-appimage-only-linux-distribution.md) records the later removal of the legacy formats.

## Exact comparison with T3 Code

The comparison below uses T3 Code at audited commit [`2a04db134c2d88f06e5b8d61a8410cb51ea07430`](https://github.com/pingdotgg/t3code/commit/2a04db134c2d88f06e5b8d61a8410cb51ea07430) (desktop package `0.0.31`) and separates the reusable behavior from T3-specific architecture.

| Concern | omp-ui now | T3 Code reference | Consequence for omp-ui |
|---|---|---|---|
| First-party Linux artifacts | AppImage + deb + rpm + standalone Flatpak ([config](../../packages/desktop/electron-builder.yml#L12-L24), [workflow](../../.github/workflows/release.yml#L39-L59)) | Linux x64 AppImage only; workflow publishes AppImage/update metadata through the GitHub release ([T3 workflow](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/.github/workflows/release.yml#L340-L375)) | Packaging convergence is mostly release work. |
| Availability checks | Stable GitHub `/releases/latest`; launch check plus manual check; per-version persisted dismissal ([core](../../packages/core/src/app-update.ts#L34-L79), [orchestrator](../../packages/desktop/src/main/app-update.ts#L103-L138)) | Startup delay plus periodic polling; stable/nightly channel filtering ([T3 `DesktopUpdates`](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/apps/desktop/src/updates/DesktopUpdates.ts)) | Keep omp-ui's stable-only and persisted-dismissal behavior; T3's channel machinery is unnecessary. |
| Download policy | Explicit click; `autoDownload = false` ([source](../../packages/desktop/src/main/app-update.ts#L154-L180)) | Explicit click; `autoDownload = false` and `autoInstallOnAppQuit = false` ([T3 `DesktopUpdates`](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/apps/desktop/src/updates/DesktopUpdates.ts)) | Set both properties explicitly in a future change. omp-ui currently leaves upstream `autoInstallOnAppQuit` at its `true` default. |
| UI | Non-modal card: update, progress, restart, later; dismissal can be remembered | Sidebar pill: download, progress, restart; restart confirmation warns that running tasks are interrupted ([T3 update logic](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/apps/web/src/components/desktopUpdate.logic.ts), [pill](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/apps/web/src/components/sidebar/SidebarUpdatePill.tsx)) | Preserve omp-ui's card and stronger live-session guard; copy the warning's meaning, not T3's component architecture. |
| Install preparation | Await live-session confirmation, then call `quitAndInstall()`; normal `before-quit` kills all backends ([restart](../../packages/desktop/src/main/app-update.ts#L227-L236), [lifecycle](../../packages/desktop/src/main/index.ts#L154-L164)) | Set quitting, stop **every** backend concurrently with a 5-second SIGTERM grace, destroy all windows, then `quitAndInstall(true, true)` ([T3 `installDownloadedUpdate`](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/apps/desktop/src/updates/DesktopUpdates.ts#L478-L560)) | Both stop active work. T3 has explicit bounded shutdown before install; omp-ui relies on its normal quit cleanup after install/relaunch has been initiated. |
| Quit interception | Existing confirmation sets a `forceQuit` latch; the updater's later `app.quit()` passes the guard ([quit guard](../../packages/desktop/src/main/index.ts#L28-L71)) | An updater-specific `before-quit-for-update` hook bypasses T3's normal graceful-shutdown interception ([T3 lifecycle](https://github.com/pingdotgg/t3code/blob/2a04db134c2d88f06e5b8d61a8410cb51ea07430/apps/desktop/src/app/DesktopLifecycle.ts)) | Do not copy T3's bypass unless omp-ui's lifecycle changes; verify the existing sequence instead. |
| Relaunch | electron-updater replaces the file, spawns the new AppImage, then quits the old app | Same AppImageUpdater mechanism; this updater path is distinct from T3's ordinary `app.relaunch()` path | The core “bounce” already exists in omp-ui. |
| Work preservation | No running backend survives; persisted session files remain on disk | Confirmation says tasks are interrupted; T3 stops all backends before relaunch | Neither app preserves active work across the bounce. |
| Architecture | Direct class/state machine around existing card | Effect layers, reducers, IPC factories, stable/nightly channels | Do not import T3's scaffolding; it solves T3-specific concerns. |

### What T3's “bounce” means

**Observed:** “bounce the application while it is still open” is a user-initiated update flow, not process continuity:

1. The running UI downloads an update.
2. The user clicks restart and confirms that running tasks will be interrupted.
3. T3 marks itself as quitting, stops all backend instances with bounded grace, destroys its windows, and calls `quitAndInstall(true, true)`.
4. electron-updater replaces the AppImage and starts a detached new process; the old Electron process exits.
5. The new process performs a fresh startup. Only state already persisted to disk can reappear.

**Conclusion:** T3 does **not** preserve running tasks, backend processes, or in-memory UI state. omp-ui should not market its restart as preserving live work. Its session JSONL can remain resumable on disk, but the running agent process is terminated.

## AppImage runtime and publishing prerequisites

### Runtime

**Observed:**

- An AppImage must be downloaded, made executable, and run; no system installation or root access is required ([AppImage quickstart](https://docs.appimage.org/introduction/quickstart.html)).
- omp-ui's current builder config has no `toolsets.appimage` selection. Installed `app-builder-lib` therefore chooses the legacy `0.0.0` FUSE2 toolset. Its type declarations list `1.0.2` and `1.0.3` as Beta static-runtime choices (`node_modules/app-builder-lib/out/configuration.d.ts:325-336`; `node_modules/app-builder-lib/out/targets/appimage/AppImageTarget.js:65-98`).
- electron-builder's first-party documentation says the legacy runtime depends on FUSE2, which is increasingly absent on current Fedora, Arch, and Ubuntu 24.04+, while `1.0.3` removes that dependency. The same page labels `1.0.3` **Beta (recommended)** and says it becomes the default in electron-builder v27 ([electron-builder AppImage toolsets](https://www.electron.build/appimage/#toolsets)).

**Recommendation:** opt in to the static `1.0.3` runtime only after a packaged omp-ui smoke matrix proves launch, Chromium sandbox behavior, update, replacement, and relaunch. The static runtime is a candidate, not a validated fact. If it fails the gate, delay cutover rather than making users install FUSE2 as the long-term answer.

### Publishing

A supported AppImage self-update requires:

- a stable GitHub release with the AppImage and generated `latest-linux.yml`;
- a publish provider matching `LankfordAI/omp-ui` ([builder config](../../packages/desktop/electron-builder.yml#L25-L29));
- SHA-512 and AppImage path in the metadata (already asserted by the release job, [workflow](../../.github/workflows/release.yml#L60-L68));
- a semver-stamped packaged app and an `APPIMAGE` environment path at runtime ([enablement](../../packages/desktop/src/main/app-update.ts#L67-L91); `node_modules/electron-updater/out/AppImageUpdater.js:17-27`);
- the embedded blockmap used for differential download; electron-builder documents that AppImage blockmaps are embedded, so a separate `.blockmap` asset is not required ([electron-builder auto-update support](https://www.electron.build/appimage/#auto-update-support)); and
- preservation of historical release assets for rollback and legacy users.

Current release publication already satisfies the metadata shape. The cutover removes other artifacts; it must not accidentally remove `latest-linux.yml` or its assertions.

## Writable-location and desktop-integration constraints

### Writable location

**Observed:** 6.8.9 validates that `APPIMAGE` exists, is absolute, and contains no NUL; it then unlinks that path and moves the staged update into the same directory (`node_modules/electron-updater/out/AppImageUpdater.js:72-100`).

**Inference:** self-update requires write/delete/rename permission in the AppImage's parent directory, not merely a writable AppImage file. A read-only mount, root-owned application directory, or managed system location will fail. Because the updater's unlink occurs first, a move failure after a successful unlink is destructive.

**Recommendation:** the graphical installer must use the canonical unversioned path `$HOME/.local/bin/omp-ui.AppImage`. This is XDG-aligned: the XDG Base Directory Specification explicitly reserves `$HOME/.local/bin` for user-specific executables, while `$XDG_DATA_HOME` is for data and defaults to `$HOME/.local/share` ([XDG Base Directory Specification](https://specifications.freedesktop.org/basedir-spec/latest/)). The installer must create the parent when necessary, copy the launched AppImage to a unique temporary file in that same directory, set mode `0755`, flush/close it, and atomically rename it over the canonical path; partial copies must never become the launch target. An unversioned name is significant: 6.8.9 preserves the old name when it contains no `X.Y.Z`; a versioned launch name may be replaced by a new versioned sibling name, invalidating launchers (`node_modules/electron-updater/out/AppImageUpdater.js:89-100`). Update installation must preflight the canonical parent and fail before the updater's destructive unlink path when it is not writable.

### Desktop integration

**Observed:** AppImages do not self-install menu entries. electron-builder has not provided self-integration since v21; its documentation recommends AppImageLauncher or manual extraction/copying of the embedded desktop file and icon ([electron-builder desktop integration](https://www.electron.build/appimage/#desktop-integration)). AppImage's own documentation describes AppImageLauncher moving integrated files to `~/Applications` ([AppImage desktop integration](https://docs.appimage.org/user-guide/run-appimages.html#integrating-appimages-into-the-desktop)). At the 2026-08-05 audit, deb, rpm, and the standalone Flatpak provided installed desktop entries; the Flatpak bundle used `ai.lankford.omp-ui.desktop`. That packaging source has since been removed, as recorded in [ADR-0011](../adr/0011-appimage-only-linux-distribution.md). Freedesktop specifies application entries below the XDG data search path, `Exec` as a command that may use a full executable path, and themed application icons below an `icons/hicolor/<size>/apps` hierarchy ([Desktop Menu file locations](https://specifications.freedesktop.org/menu-spec/latest/paths.html), [Desktop Entry `Exec`](https://specifications.freedesktop.org/desktop-entry-spec/latest/exec-variables.html), [Icon Theme Specification](https://specifications.freedesktop.org/icon-theme-spec/latest/)).

**Mandatory installer contract:** when launched outside the canonical path, the AppImage must show an in-app graphical install flow before normal use. **Install** performs the atomic copy/mode operation above; atomically writes `$XDG_DATA_HOME/applications/ai.lankford.omp-ui.desktop` (default `~/.local/share/applications`) with `Exec` and `TryExec` set to the installer-resolved absolute canonical pathname (for example `/home/alice/.local/bin/omp-ui.AppImage`, never literal `$HOME`), and `Icon=ai.lankford.omp-ui`; installs every shipped bitmap size as `$XDG_DATA_HOME/icons/hicolor/<size>/apps/ai.lankford.omp-ui.png` (and a shipped scalable icon under `hicolor/scalable/apps` if applicable); runs `update-desktop-database` and the available icon-cache refresh tool best-effort, never treating a missing cache utility as installation failure; relaunches the canonical installed copy; and exits the downloaded copy. **Cancel** exits without a partial installation. Paths must be derived from the environment/defaults, desktop-file values must follow Freedesktop quoting rules, and no administrator privilege or terminal is permitted.

The same flow must be idempotent and double as **Repair installation**: a launch already at the canonical path, or an explicit Settings repair action, must verify/recreate the owned desktop entry, icons, mode, and cache notifications without replacing identical files or spawning a relaunch loop. It must remove obsolete per-user entries that omp-ui previously owned, and mask or guide removal of known legacy system entries only after the new launcher has been proven; it must not delete unrecognized community or user-authored launchers. A graphical **Uninstall omp-ui** action in Settings must remove the canonical AppImage, the owned desktop entry and icons, refresh caches best-effort, and preserve settings, provider keys, session history, managed binaries, and other user data by default. Destructive data removal must be a separate explicit choice with a clear inventory and confirmation. AppImageLauncher/manual integration remains troubleshooting guidance, not a substitute for the first-party installer.

## Integrity and authenticity boundaries

**Observed:**

- For a full AppImage download, `electron-updater` copies the SHA-512 declared in update metadata into the HTTP downloader, whose digest transform checks the downloaded bytes (`node_modules/electron-updater/out/AppUpdater.js:559-566`; `node_modules/builder-util-runtime/out/httpExecutor.js:398-434,457-475`). The differential downloader receives the same file metadata and performs a whole-file digest transform (`node_modules/electron-updater/out/differentialDownloader/DifferentialDownloader.js:120-129`).
- A matching cached update is rehashed before reuse (`node_modules/electron-updater/out/DownloadedUpdateHelper.js:113-126`).
- The current release job creates an unsigned `SHA256SUMS.txt` beside the artifacts ([workflow](../../.github/workflows/release.yml#L53-L59)). The AppImage updater does not consume that file; it uses `latest-linux.yml`.
- No Linux publisher-signature verification call is present in the inspected AppImage updater path. AppImage supports optional embedded GPG signatures, but verification requires an external trusted verifier ([AppImage signing documentation](https://docs.appimage.org/packaging-guide/optional/signatures.html)).

**Boundary:** the SHA-512 check provides strong byte-integrity against the digest in the fetched update metadata. It does not independently prove publisher identity if an attacker can replace both the artifact and metadata at the trusted release/feed. `SHA256SUMS.txt` in the same unsigned release is useful for manual corruption checks but is not an independent authenticity root. HTTPS and GitHub release/workflow controls remain part of the trust model.

**Recommendation:** retain a one-line `SHA256SUMS.txt` for manual verification and document what it does and does not prove. Treat publisher signing or provenance attestation as a separate explicit security decision; do not claim it exists until the release and updater verify it end to end.

## Release-pipeline delta

Future implementation work is narrow and concrete:

| Area | Current | AppImage-only delta |
|---|---|---|
| electron-builder targets | `AppImage`, `deb`, `rpm` | `AppImage` only; select the static toolset only after its smoke gate |
| Package naming | deb/rpm overrides; default AppImage name | Define a stable published asset name and a documented stable installed name |
| Runner toolchain | Installs rpm, Flatpak, D-Bus, and three Flatpak runtimes | Remove legacy packaging dependencies after rollback window |
| Flatpak lane | Separately assembles/uploads one x86_64 bundle | Remove from cutover workflow; keep source/lane recoverable through rollback window |
| Checksums | Hashes four artifact globs | Hash AppImage only if manual SHA-256 remains policy |
| Assertions | Require all four formats, metadata, and at least four checksum lines | Require exactly the intended AppImage architecture(s), `latest-linux.yml` with AppImage SHA-512, and the chosen checksum/provenance assets |
| Updater defaults | `autoDownload` explicitly false; `autoInstallOnAppQuit` inherits true | Explicitly set both false so download and install/restart remain user-controlled |
| Release notes | Four-format instructions | One-time graphical executable permission if needed; launch downloaded AppImage once; graphical install/repair/uninstall behavior; canonical path; migration; live-work warning; and rollback link |

This is mostly deletion and assertion rewiring, but the migration behavior and packaged smoke tests are release blockers.

## Legacy deb/rpm/Flatpak migration

### Why a bridge is mandatory

**Observed:** a legacy install detects its current format and selects an exact same-format filename. If the latest release lacks that name, it stops at `expected asset missing from release` ([selection](../../packages/core/src/app-update.ts#L99-L130), [error](../../packages/desktop/src/main/app-update.ts#L183-L187)). An AppImage-only release cannot retroactively change code in an older package.

**Recommendation:** publish one final **bridge release in all four formats**. Its future updater behavior must recognize “my package format was retired but an AppImage is available,” explain the migration, download and verify the AppImage, then invoke the **same graphical installer contract** used by a browser-downloaded AppImage. That shared path must install to `$HOME/.local/bin/omp-ui.AppImage`, create/repair the per-user launcher and icons, relaunch the canonical copy after the old process releases its single-instance lock, and avoid pretending it installed a system package.

### Data and process migration

- **deb/rpm → AppImage:** inventory and preserve the existing Electron userData directory; omp session storage and the managed omp binary are outside the package installation tree ([registry location](../../packages/desktop/src/main/index.ts#L106-L119), [session/bin paths](../../packages/core/src/paths.ts#L27-L52), [managed binary](../../packages/core/src/paths.ts#L83-L96)). Remove the old package only after the AppImage launches with the expected data.
- **Flatpak → AppImage:** Flatpak normally scopes writable app data under `~/.var/app/$FLATPAK_ID`; at the 2026-08-05 audit, omp-ui's Flatpak app ID was `ai.lankford.omp-ui` ([Flatpak filesystem model](https://docs.flatpak.org/en/latest/sandbox-permissions.html)). Inventory/copy the registry and provider-key store into the AppImage's Electron userData location, and validate key decryptability. Do not assume copying is sufficient without a packaged migration test. The retired Flatpak granted home access at the audit date, while omp sessions and the managed binary used home-based paths, so those paths should remain available; verify that inference with real bridge data ([paths](../../packages/core/src/paths.ts#L27-L52)).
- **Running old copy:** omp-ui uses a userData-scoped single-instance lock. Starting the AppImage while the old install is still running can focus the old window and exit the new process ([single-instance code](../../packages/desktop/src/main/index.ts#L7-L26)). Migration instructions must say to finish/stop sessions and fully quit the old copy first.
- **Desktop entries:** the shared installer must remove recognized obsolete per-user entries and detect known package/Flatpak entries, while never deleting unrecognized community or user-created entries. Validate the new canonical launcher first; only then uninstall/disable the legacy package or place a per-user `Hidden=true` shadow for a known legacy desktop-file ID that cannot yet be removed. Confirm GNOME and KDE each show exactly one omp-ui entry with its icon and that it launches `$HOME/.local/bin/omp-ui.AppImage` ([desktop-file identity and precedence](https://specifications.freedesktop.org/desktop-entry-spec/latest/file-naming.html), [`Hidden` semantics](https://specifications.freedesktop.org/desktop-entry-spec/latest/recognized-keys.html)).
- **Community packages:** do not route them through package-manager actions. If format cannot be established, continue to show the release page and state that self-update is supported only from the first-party AppImage.

Exact deb/rpm uninstall commands and installed desktop-file names must be derived from produced bridge artifacts before publishing instructions; they were not established by this source-only review.

## Staged rollout and rollback

### Stage 0 — decide and prove prerequisites

1. Record the product decisions below.
2. Build a candidate static-runtime AppImage on the actual release runner.
3. Complete the distro, filesystem, integration, migration, and failure matrix below.
4. Define release assertions and a rollback owner/runbook.

**Gate:** no bridge or cutover until launch/update/relaunch and live-session behavior pass on the supported distro matrix **and** the graphical installer completes install, repair, Applications-menu launch, and uninstall without a terminal on both GNOME and KDE.

### Stage 1 — bridge release, all four formats

1. Ship the migration-aware updater and the same graphical AppImage installer path in AppImage, deb, rpm, and Flatpak.
2. Explicitly disable install-on-ordinary-quit.
3. Publish deprecation and migration instructions, including the possible one-time file-manager executable permission for browser downloads, Flatpak data handling, and duplicate launchers.
4. Exercise an update from the preceding release in every format through the shared installer into the canonical AppImage, including canonical relaunch and menu launch.
5. Exercise a fresh browser download through the graphical installer on GNOME and KDE with no terminal; where the browser strips execution permission, verify the documented file-manager action.
6. Leave the bridge as latest for a defined observation window.

**Gate:** telemetry is not required, but maintainers need direct successful migration evidence for every current format, idempotent installer/repair evidence on GNOME and KDE, and a documented graphical support fallback. A bridge that merely downloads or reveals an AppImage does not pass.

### Stage 2 — AppImage-only cutover

1. Publish only the x86_64 AppImage, `latest-linux.yml`, and chosen checksum/provenance assets.
2. Keep historical legacy assets downloadable; do not delete old releases.
3. Keep the old packaging source/workflow recoverable for at least one stable cycle.
4. Release notes must identify the bridge minimum version, the graphical fresh-install path, the possible one-time file-manager permission action, and the manual recovery path for pre-bridge users.

**Gate:** release assertions prove asset/metadata completeness; the same AppImage has passed fresh graphical install, canonical relaunch, repair, update/relaunch, and data-preserving uninstall; GNOME and KDE each show one working Applications-menu entry with the correct icon; unsupported non-writable locations fail safely before replacement. **AppImage-only is NO-GO if any graphical-installer or desktop-integration gate is red.**

### Stage 3 — cleanup

After one stable cycle with no cutover-blocking issue, remove inactive rpm/Flatpak packaging machinery and obsolete docs. Cleanup is deliberately later so rollback remains a revert rather than a reconstruction.

### Rollback

- **Before cutover:** fix or replace the bridge while all four formats still publish.
- **After cutover, pipeline failure:** revert the target/workflow changes and publish the next release in all four formats from retained packaging sources.
- **Bad AppImage:** publish a fixed AppImage promptly. Historical assets remain available for manual downgrade; there is no in-app retained-copy rollback in 6.8.9's replace-in-place flow.
- **Bad installer/desktop integration:** before cutover, keep the bridge and all legacy artifacts current while fixing install/repair/uninstall. After cutover, use the retained packaging lane for a recovery release if a fixed AppImage cannot restore a no-terminal Applications-menu path; do not tell affected users to repair it in a terminal.
- **Bad migration logic:** keep the old install and data until AppImage validation succeeds; never make legacy uninstall the first step.
- **Destructive replacement failure:** provide a direct release link and reinstall instructions because 6.8.9 can unlink the old AppImage before a failed move.

## Live-session policy

**Recommendation:** retain explicit user control and describe the truth: **restart ends every running agent session; persisted session history remains available for later resume, but running work does not survive.**

Required future behavior:

1. Never download without the user's update action.
2. Set `autoInstallOnAppQuit = false`; “Later” and an ordinary quit must not silently install a downloaded update.
3. At restart, show the exact live-session count and state that active agents/processes will be stopped.
4. Cancel leaves the old app and all sessions running.
5. Confirmed restart stops every backend with a defined bounded-grace policy, flushes/preserves session files, and only then initiates replacement/relaunch.
6. On the new process, surface resumable persisted sessions normally; do not label this as preservation of running work.
7. Verify the single-instance/relaunch ordering so the new process cannot lose to the still-running old instance.

T3 supplies a useful warning and bounded backend shutdown, but not active-work preservation. omp-ui should keep its non-modal card and live-count guard rather than copy T3's generic `window.confirm` UX.

## Risk matrix

Likelihood and impact are qualitative (`L`, `M`, `H`) for prioritization, not measured probabilities.

| Risk | L | I | Basis | Required mitigation |
|---|---:|---:|---|---|
| Legacy installs dead-end after assets disappear | H | H | Exact same-format selection and current missing-asset error | Four-format bridge release before cutover |
| AppImage fails on modern distros without FUSE2 | H | H | Current legacy toolset; upstream warning | Validate Beta static runtime on distro matrix; block cutover if red |
| Browser download is not executable | M | H | Linux will not execute a file without execute permission; AppImage code cannot run early enough to change that | Document and test a one-time file-manager **Allow executing** action; require no terminal; treat AppImageLauncher/archive preservation only as external alternatives |
| Graphical installer or icon integration is missing/broken | M | H | A raw AppImage does not self-integrate, so removing packages would regress normal application discovery | Make installer plus GNOME/KDE Applications-menu icon a hard cutover gate; retain legacy formats until green |
| Replacement deletes old path then move fails | L | H | Observed unlink-before-move in 6.8.9 | Writable preflight, free-space/error tests, reinstall/rollback path; do not call update atomic |
| Read-only/root-owned source or canonical location cannot install/update | M | H | Installer reads the source and updater mutates the canonical AppImage parent | Canonical `$HOME/.local/bin` target, same-directory temporary copy and atomic rename, writable preflight, actionable graphical error |
| Active agent work is lost on restart | M | H | Both apps terminate backends | Explicit count/warning, cancel, bounded stop, resumability validation |
| New AppImage loses single-instance race with old app | L | H | Upstream spawn starts before old `app.quit()`; omp-ui lock exits second instance | End-to-end relaunch stress test; adjust choreography if reproduced |
| Ordinary quit silently installs a downloaded update | M | M | Upstream `autoInstallOnAppQuit` defaults true | Explicitly set false and test “Later”/quit |
| Flatpak settings/provider keys do not migrate | M | H | Sandboxed userData differs from AppImage userData | Tested copy/import path, decryptability check, old data retained |
| Duplicate/stale desktop entries launch old copy | M | M | Package/Flatpak entries can coexist with the new per-user entry | Stable desktop ID, owned-entry cleanup, known legacy shadow/removal only after validation, GNOME/KDE duplicate checks |
| Versioned filename breaks desktop entry | M | M | 6.8.9 may choose new versioned destination | Stable unversioned installed filename |
| Repair/uninstall damages user data or third-party entries | L | H | Integration spans executable, desktop, icon, and legacy artifacts | Idempotent ownership checks; default uninstall removes only owned application artifacts and preserves all user data; destructive deletion requires separate explicit confirmation |
| Artifact bytes verify but publisher identity is not independently proven | L | H | Digest and metadata share release trust root; no signature verifier observed | Document trust boundary; decide signing/attestation separately |
| Release workflow omits metadata or keeps stale assertions | M | H | Current assertions require four formats | AppImage-only asset contract and fail-closed release checks |
| Beta static runtime changes sandbox behavior | M | H | Upstream labels 1.0.3 Beta | Distro/sandbox smoke test; retain rollback lane |
| Community package is misdetected as deb/rpm | L | M | Detection is host heuristic | Scope support to first-party AppImage; unknown/community path opens release guidance |
| x86_64-only remains a product limitation | H | L | Current release is x86_64-only | State support clearly; treat arm64 as a separate decision |

## Verification matrix for a future implementation

These are release gates, not tests performed by this research task.

| Area | Scenario | Expected evidence |
|---|---|---|
| Runtime | Fresh AppImage launch on current Fedora, Ubuntu 24.04 LTS, and Arch-derived environment without FUSE2 | UI opens without installing FUSE2; sandbox policy is explicit; logs contain no runtime mount failure |
| Runtime fallback | Host with restricted unprivileged user namespaces | App launches under the selected static-runtime sandbox behavior; no unconditional unsafe fallback is assumed |
| Browser first run | Download raw AppImage with a browser that preserves execute permission and one that strips it | Preserving case opens directly; stripped case succeeds after a documented file-manager **Allow executing** action; neither path uses a terminal; no claim says the AppImage can bypass execute permission |
| Graphical install | Launch a versioned AppImage from Downloads and choose Install | Installer copies through a same-directory temporary file, publishes `$HOME/.local/bin/omp-ui.AppImage` atomically at `0755`, writes the stable desktop entry and all icon sizes, relaunches the canonical path, and exits the downloaded process |
| Install cancel/failure | Cancel; inject short copy, full destination, permission change, and rename failure | Cancel and every failure leave no partial canonical target or launcher; an existing valid installation remains launchable; the UI gives a graphical recovery path |
| Installer idempotence | Run install twice; launch canonical copy; choose Settings repair with missing/corrupt desktop entry, icon, and cache utilities absent | Exactly one canonical file and launcher remain; owned files are repaired, identical files are not churned, no relaunch loop occurs, and missing cache utilities are non-fatal |
| Update integrity | Valid full download | SHA-512-verified download reaches `downloaded`; restart is offered |
| Update integrity | Corrupted full and differential downloads; corrupted cached file | Update fails closed, old running app remains usable, corrupt cache is not installed |
| Metadata failure | Missing/malformed `latest-linux.yml`, absent SHA-512, release-upload race | Actionable error; no install; next check can recover |
| Writable path | User-owned `$HOME/.local/bin` | Update, replacement, quit, and relaunch complete into the canonical unversioned path |
| Non-writable path | Non-writable `$HOME/.local/bin`, root-owned directory, and read-only mount | Installer/update preflight blocks before publication or unlink, explains the problem graphically, and preserves the existing valid file |
| Replacement failure | Destination full/permission changes after download and injected move failure | Old path is preserved by future hardening or reinstall path is explicit; no “atomic” claim |
| Filename | Start from a versioned download installed to the stable unversioned name | Subsequent updates preserve the stable path; desktop `Exec` and `TryExec` contain the resolved absolute canonical path, not literal `$HOME` or a versioned Downloads path |
| Live sessions | Zero sessions | Restart proceeds without a live-session warning and relaunches |
| Live sessions | One and multiple active/hidden sessions; cancel | Counts are correct; cancel preserves every process |
| Live sessions | One and multiple active/hidden sessions; confirm | Backends stop within policy; session files remain readable/resumable; no process survives |
| Install-on-quit | Download, choose Later/close card, then ordinary quit | No update installs; next launch still offers the downloaded/available update per chosen policy |
| Relaunch ordering | Repeat update/restart under slow AppImage mount/start conditions | Exactly one new-version instance remains; old instance exits; no lost bounce |
| Desktop install/repair | GNOME and KDE, custom and default `XDG_DATA_HOME`, install and repair with cache tools present/absent | Exactly one `ai.lankford.omp-ui.desktop` appears with the correct icon; it launches the canonical AppImage; entry/icon paths honor XDG; cache-tool absence is non-fatal |
| Duplicate cleanup | Install over known deb/rpm/Flatpak and earlier per-user entries, plus an unrelated community launcher | Recognized stale entries are removed or safely shadowed only after validation; the community launcher is untouched; GNOME and KDE show no stale first-party duplicate |
| Settings uninstall | Uninstall with populated settings, provider keys, sessions, and managed binary; repeat after partial removal | Canonical AppImage, owned entry, and owned icons disappear; caches refresh best-effort; user data remains intact by default; repeat is safe; data deletion requires a separate explicit confirmation |
| deb migration | Prior release deb → bridge → shared graphical installer → AppImage | Canonical file, entry, and icon match fresh install; menu launch works; settings/session registry/provider-key behavior is preserved; old package is removed only after validation |
| rpm migration | Prior release rpm → bridge → shared graphical installer → AppImage | Same as deb; commands and desktop filenames match the produced artifact |
| Flatpak migration | Prior Flatpak with settings, provider keys, and sessions → bridge → shared graphical installer → AppImage | Canonical file, entry, and icon match fresh install; registry/settings arrive, key decryptability is checked, sessions remain resumable, and old sandbox data remains recoverable |
| Pre-bridge install | Old deb/rpm/Flatpak sees AppImage-only latest | Documented manual recovery path is discoverable and succeeds |
| Community package | Unpacked/AUR-like launch on dpkg/rpm host | Support boundary is clear; no unsafe package installation is attempted |
| Release contract | Dry-run/tagged release | Exactly intended AppImage architecture(s), `latest-linux.yml`, SHA-512, and chosen checksum/provenance assets exist; no deb/rpm/Flatpak asset |
| Rollback | Re-enable retained legacy lane and publish a recovery release | All four historical formats can be rebuilt while rollback window is open |

## Work areas, without estimates

1. **Product/UX:** mandatory first-run Install/Cancel flow, Settings repair/uninstall, data-preservation confirmation, executable-permission explanation, live-session wording, and graphical failure recovery.
2. **Installer/updater lifecycle:** atomic per-user publication, `0755` mode, canonical-path detection, idempotent repair, explicit updater defaults, writable preflight, backend shutdown ordering, single-instance relaunch, and failure recovery.
3. **Packaging:** AppImage-only target, static-runtime candidate, stable unversioned naming, embedded desktop/icon inputs, architecture contract.
4. **Release engineering:** toolchain deletion, metadata/checksum assertions, bridge/cutover release notes, retained rollback lane.
5. **Migration:** retired-format offer through the shared installer, Flatpak userData import, legacy uninstall, known desktop-entry cleanup/shadowing, and third-party-entry protection.
6. **Desktop integration:** mandatory XDG per-user desktop entry and hicolor icon lifecycle, best-effort cache refresh, GNOME/KDE behavior, and owned-artifact uninstall.
7. **Security:** digest behavior, trust-boundary documentation, decision on signature/provenance verification.
8. **QA/release operations:** distro matrix, browser permission paths, installer/update filesystem failure injection, GNOME/KDE install/repair/uninstall, all-format bridge exercise, rollback rehearsal.
9. **Documentation:** graphical install and one-time executable permission, supported canonical path, live-work semantics, manual recovery, community-package status.

## Explicit product decisions

| Decision | Recommendation | Rationale |
|---|---|---|
| What does “only” mean? | Sole first-party/supported artifact; tolerate unsupported community packages | Clear support contract without trying to control downstream distribution |
| Direct cutover or bridge? | Mandatory all-format bridge | Old clients otherwise cannot obtain migration behavior |
| Runtime | Trial static `1.0.3`, cut over only after distro smoke tests | Removes FUSE2 dependency, but installed builder labels it Beta |
| Supported location | `$HOME/.local/bin/omp-ui.AppImage`, unversioned and user-owned | XDG explicitly reserves `$HOME/.local/bin` for user executables; enables unprivileged replacement and a stable launcher target |
| Graphical installer and desktop integration | Mandatory in-AppImage install/repair/uninstall; stable per-user desktop ID and hicolor icons; AppImageLauncher/manual steps are troubleshooting only | AppImage-only cannot replace package integration without a tested no-terminal Applications-menu experience |
| Initial execute permission | State that a raw browser download may require one file-manager permission action | A pure AppImage cannot bypass Linux execute permission before it runs; the supported flow still requires no terminal |
| Uninstall data policy | Remove owned app/integration artifacts; preserve user data by default | Prevents loss of settings, keys, sessions, and managed binaries; destructive removal is a separate explicit choice |
| Live sessions | Warn with count; cancel or bounded stop; no preservation claim | Matches actual lifecycle and protects user agency |
| Install on ordinary quit | Disable | Keeps install/restart explicit and makes “Later” truthful |
| Flatpak data | Tested guided/automatic import with old data retained | Highest migration risk; manual guessing is insufficient |
| SHA256SUMS | Keep one AppImage line | Useful manual integrity check, while documenting that it is not independent authenticity |
| Publisher authenticity | Separate decision; claim none until verified end to end | Current digest path does not independently authenticate the publisher |
| Legacy packaging source | Retain through one stable post-cutover cycle | Makes rollback operationally credible |
| Architecture | Keep x86_64 for this cutover; evaluate arm64 separately | Avoid coupling distribution reduction to a new architecture promise |

## Final recommendation

Proceed with **AppImage as the sole first-party Linux artifact**, but only through the staged bridge plan **and only after the AppImage itself provides the tested graphical per-user installer described above**. The implementation should preserve omp-ui's existing non-modal update card, per-version dismissal, and live-session guard; explicitly disable install-on-quit; add truthful interruption and initial executable-permission wording; install atomically to `$HOME/.local/bin/omp-ui.AppImage`; own the XDG desktop-entry/icon lifecycle and data-preserving uninstall; and route bridge migrations through that same installer.

The cutover remains **NO-GO** until all of the following are true:

1. a four-format bridge release has shipped and each legacy format has completed a real migration through the shared graphical installer;
2. a fresh browser-downloaded AppImage installs, relaunches from the canonical path, repairs idempotently, and uninstalls without a terminal, with the one-time file-manager executable-permission path tested where required;
3. GNOME and KDE each show exactly one `ai.lankford.omp-ui.desktop` Applications-menu entry with the correct icon, and that entry launches the canonical unversioned AppImage;
4. installer copy/permission/rename failures leave no partial target, update/relaunch succeeds from the canonical writable location, and unsupported locations fail safely before publication or unlink;
5. Settings uninstall removes only owned application/integration artifacts and preserves user data by default; duplicate cleanup does not delete community or user-authored entries;
6. the Beta static runtime has passed the named distro/sandbox smoke matrix, or another supported runtime decision has been made;
7. live-session cancel/confirm behavior and single-instance relaunch ordering have passed end to end;
8. Flatpak data/provider-key migration and rollback have been proven; and
9. the AppImage-only release contract asserts the AppImage, `latest-linux.yml`, SHA-512 metadata, and chosen checksum/provenance assets.

With those gates met, the recommendation becomes **GO**. Without a tested graphical installer and working Applications-menu icon on both GNOME and KDE, AppImage-only distribution remains **NO-GO**, regardless of whether raw AppImage launch and self-update succeed.
