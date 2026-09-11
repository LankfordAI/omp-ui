import { join } from "node:path";
import { shell, type BrowserWindow } from "electron";
import {
  APP_RELEASE_DOWNLOAD_BASE,
  compareVersions,
  detectPackageFormat,
  downloadAppAsset,
  fetchLatestAppRelease,
  fetchSha256Sums,
  parseSemver,
  selectAsset,
  type AppReleaseInfo,
  type AppPackageFormat,
  type AppUpdateRestartResult,
  type AppUpdateState,
  type DownloadFetchLike,
  type FetchLike,
} from "@omp-ui/core";
import { UpdateController, type UpdateControllerDeps } from "./update-controller";

// Main-process orchestration for omp-ui's own release updates (issue #18).
// All the machine work — release lookup, package-format detection, the
// checksum-verified download — lives in @omp-ui/core; this file owns the
// state machine the renderer's update card renders, plus the AppImage/NSIS/
// macOS-zip in-place path through electron-updater.
//
// Quiet by default: background checks never surface errors or up-to-date
// states. Auto-updates stage immediately and quietly; only the verified,
// downloaded update earns the card. Manual checks expose staging progress and
// failures. Other package formats still wait for an explicit Download click.


/** Auto-updatable through electron-updater: AppImage, NSIS, macOS ZIP feed. */
export type AutoUpdateFormat = "appimage" | "nsis" | "maczip";

export function isAutoUpdateFormat(
  format: AppPackageFormat,
): format is AutoUpdateFormat {
  return format === "appimage" || format === "nsis" || format === "maczip";
}
/** The slice of electron-updater's AppUpdater this flow uses (6.8.9 API). */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "download-progress", cb: (p: { percent: number }) => void): void;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean } | null>;
  downloadUpdate(): Promise<unknown>;
  /**
   * BaseUpdater's idempotent quit-hook registration. electron-updater marks
   * this protected in TypeScript but exposes it at runtime; arming after a
   * completed download otherwise cannot install on quit (6.8.9).
   */
  addQuitHandler(): void;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface AppUpdaterDeps extends UpdateControllerDeps<AppUpdateState> {
  win: BrowserWindow;
  enabled: boolean;
  currentVersion: string;
  downloadsDir: string; // app.getPath("downloads")
  /** Main-process live-session authority, re-read immediately before restart. */
  hasLiveSessions: () => boolean;
  /**
   * Latches (true) / revokes (false) the main process's update-quit
   * authorization: bypasses the darwin hide-on-close and both live-session
   * quit guards while the installer handoff is in flight (issue #244).
   */
  setQuitAuthorized: (on: boolean) => void;
  fetchImpl?: FetchLike; // tests
  downloadFetchImpl?: DownloadFetchLike; // tests
  autoUpdaterFactory?: () => Promise<AutoUpdaterLike>; // tests; default below
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
  platform?: NodeJS.Platform;
}

/**
 * electron-updater is CommonJS and exposes `autoUpdater` only as a lazy
 * arrow-body getter, which cjs-module-lexer never surfaces as a named export
 * on a real import() namespace — the working binding sits on `default`
 * (issue #87). Accepts both shapes; null when neither carries it.
 */
export function resolveAutoUpdater(mod: unknown): AutoUpdaterLike | null {
  if (mod === null || typeof mod !== "object") return null;
  // The module's own .d.ts claims `autoUpdater` is always a named export —
  // that is precisely the lie being worked around, so these reads must
  // narrow at runtime; the final casts name the interop boundary.
  if ("autoUpdater" in mod && mod.autoUpdater != null) {
    return mod.autoUpdater as AutoUpdaterLike;
  }
  if (
    "default" in mod &&
    mod.default !== null &&
    typeof mod.default === "object" &&
    "autoUpdater" in mod.default &&
    mod.default.autoUpdater != null
  ) {
    return mod.default.autoUpdater as AutoUpdaterLike;
  }
  return null;
}

const defaultAutoUpdaterFactory = async (): Promise<AutoUpdaterLike> => {
  // Lazy on purpose (dynamic-import exception): electron-updater hooks the
  // real Electron app when imported, which breaks under vitest's mocked
  // electron and is dead weight on manual installer formats — only the
  // AppImage/NSIS/macOS-zip download path needs it.
  const autoUpdater = resolveAutoUpdater(await import("electron-updater"));
  if (autoUpdater === null) throw new Error("electron-updater export unavailable");
  return autoUpdater;
};

// ---------------------------------------------------------------------------
// Updater internal machine. The renderer only ever sees the frozen
// AppUpdateState (core/types.ts); everything below is main-process
// bookkeeping behind it. Every state transition routes through
// deriveAppUpdateState so the whole machine is one testable table; the class
// holds the snapshot and applies the side effects (IPC send, quit
// authorization) around it.
// ---------------------------------------------------------------------------

/**
 * The updater's private snapshot:
 * - state: the AppUpdateState the renderer sees.
 * - release: the release behind the current offer, kept for notes and
 *   downloads; only dismiss drops it.
 * - stage: null = idle; {visible} = an electron-updater stage is in flight
 *   (visible = it began from a manual check, so its progress and failures
 *   reach the card). Invariant V⇒S: a visible stage is a stage.
 * The class additionally holds the latches no transition derives from
 * events: autoUpdaterHooked (listener-registration latch), restarting
 * (irreversible installer-handoff guard), installOnQuitArmed (retained user
 * intent, survives every status transition).
 */
export interface AppUpdateMachine {
  state: AppUpdateState;
  release: AppReleaseInfo | null;
  /** null = idle; {visible} = a stage is in flight (invariant: visible ⇒ staging). */
  stage: null | { visible: boolean };
}

/** One transition of the machine. See deriveAppUpdateState for the meaning. */
export type AppUpdateEvent =
  | { t: "disabled" }
  | { t: "check-begin" }
  | { t: "unreachable"; manual: boolean }
  | { t: "up-to-date"; manual: boolean }
  | { t: "offer-dismissed" }
  | { t: "available"; release: AppReleaseInfo; format: AppPackageFormat }
  | { t: "stage-enter"; visible: boolean; release: AppReleaseInfo; format: AutoUpdateFormat }
  | { t: "stage-progress"; percent: number }
  | { t: "stage-complete"; version: string }
  | { t: "stage-empty"; visible: boolean }
  | { t: "stage-failed"; visible: boolean; message: string }
  | { t: "installing" }
  | { t: "apply-failed"; message: string }
  | { t: "install-on-quit"; on: boolean }
  | { t: "asset-missing" }
  | { t: "checksums-missing" }
  | { t: "asset-download-begin" }
  | { t: "asset-download-progress"; percent: number | null }
  | { t: "asset-download-failed"; message: string }
  | { t: "asset-downloaded"; path: string }
  | { t: "dismiss" };

/**
 * The pure transition table. Each case returns the full next snapshot; the
 * state half merges exactly as the historical partial `set({...})` patches
 * did, so fields a transition does not name are deliberately RETAINED —
 * quirks included, kept verbatim from before this table existed:
 * - idle transitions ("unreachable"/"up-to-date"/"offer-dismissed" quiet
 *   arms, quiet stage-failed) keep stale release metadata, and the quiet
 *   stage-failed arm even keeps the stale error string.
 * - "available" keeps a stale downloadedPath/error from an earlier manual
 *   download in the same session.
 * - a visible "stage-failed" keeps the stale progress number.
 * - "asset-download-failed" keeps the last progress; "asset-downloaded"
 *   keeps a stale error (the following check-begin clears it).
 * - "dismiss" clears the offer but keeps currentVersion, format, and
 *   installOnQuit — and drops only `release`: a background stage still in
 *   flight keeps running (stage untouched), so a dismissed mid-staging
 *   snapshot is {release: null, stage: {visible?: …}} and a later
 *   "stage-complete" re-surfaces the card. That is today's behavior.
 * - "stage-empty" reports from the visible FLAG THE CALL BEGAN WITH
 *   (`event.visible`), not the stage's current visibility — a reentrant
 *   reveal during the in-flight call must not change how the original
 *   caller settles. Kept from the pre-table code deliberately.
 */
export function deriveAppUpdateState(
  prev: AppUpdateMachine,
  event: AppUpdateEvent,
): AppUpdateMachine {
  // Merge semantics of the historical `set(patch)`: unpatched fields survive.
  const state = (patch: Partial<AppUpdateState>): AppUpdateState => ({
    ...prev.state,
    ...patch,
  });
  const next = (
    state: AppUpdateState,
    over: Partial<Omit<AppUpdateMachine, "state">> = {},
  ): AppUpdateMachine => ({
    state,
    release: prev.release,
    stage: prev.stage,
    ...over,
  });

  switch (event.t) {
    // Dev/unversioned build, manual check only.
    case "disabled":
      return next(state({ status: "disabled" }));
    case "check-begin":
      return next(state({ status: "checking", error: null, progress: null }));
    case "unreachable":
      return next(
        state(
          event.manual
            ? { status: "error", error: "could not reach GitHub" }
            : { status: "idle" },
        ),
      );
    case "up-to-date":
      return next(state({ status: event.manual ? "up-to-date" : "idle" }));
    case "offer-dismissed":
      return next(state({ status: "idle" }));
    case "available":
      return next(
        state({
          status: "available",
          latestVersion: event.release.version,
          releaseUrl: event.release.url,
          releaseName: event.release.name,
          format: event.format,
        }),
        { release: event.release },
      );
    // Beginning a stage — or a manual check revealing an in-flight quiet
    // one (visible=true): the release becomes the current offer and the
    // stage is in flight. A visible stage shows "downloading"; a quiet one
    // stays on "idle".
    case "stage-enter":
      return next(
        state({
          status: event.visible ? "downloading" : "idle",
          latestVersion: event.release.version,
          releaseUrl: event.release.url,
          releaseName: event.release.name,
          format: event.format,
        }),
        { release: event.release, stage: { visible: event.visible } },
      );
    case "stage-progress":
      return next(state({ status: "downloading", progress: event.percent }));
    case "stage-complete":
      return next(
        state({
          status: "downloaded",
          latestVersion: event.version,
          progress: null,
          error: null,
        }),
        { stage: null },
      );
    case "stage-empty":
      return next(
        state({ status: event.visible ? "up-to-date" : "idle" }),
        { stage: null },
      );
    case "stage-failed":
      return next(
        state(
          event.visible
            ? { status: "error", error: event.message }
            : { status: "idle" },
        ),
        { stage: null },
      );
    // Installer handoff transitions. The `restarting` latch itself and the
    // quit authorization are class-side side effects applied around these
    // events (an error during the handoff also revokes authorization there).
    case "installing":
      return next(state({ status: "installing", progress: null, error: null }));
    case "apply-failed":
      return next(
        state({
          status: "error",
          progress: null,
          error: `could not apply update: ${event.message}`,
        }),
      );
    case "install-on-quit":
      return next(state({ installOnQuit: event.on }));
    case "asset-missing":
      return next(
        state({ status: "error", error: "expected asset missing from release" }),
      );
    case "checksums-missing":
      return next(
        state({ status: "error", error: "release checksums unavailable" }),
      );
    case "asset-download-begin":
      return next(state({ status: "downloading", progress: null }));
    case "asset-download-progress":
      return next(state({ status: "downloading", progress: event.percent }));
    case "asset-download-failed":
      return next(state({ status: "error", error: event.message }));
    case "asset-downloaded":
      return next(
        state({ status: "downloaded", downloadedPath: event.path, progress: null }),
      );
    case "dismiss":
      return next(
        state({
          status: "idle",
          latestVersion: null,
          releaseUrl: null,
          releaseName: null,
          progress: null,
          downloadedPath: null,
          error: null,
        }),
        { release: null },
      );
  }
}

export class AppUpdater extends UpdateController<AppUpdateState> {
  /** Dev/unversioned builds never check: off unless packaged AND semver-stamped. */
  private readonly enabled: boolean;
  /** The machine snapshot (state + current offer + in-flight stage). */
  private machine: AppUpdateMachine;
  private autoUpdater: AutoUpdaterLike | null = null;
  /** electron-updater listener-registration latch. */
  private autoUpdaterHooked = false;
  /** Retained user intent ("install on next quit"); survives transitions. */
  private installOnQuitArmed = false;
  /** Irreversible installer-handoff guard while quitAndInstall is in flight. */
  private restarting = false;

  constructor(private readonly deps: AppUpdaterDeps) {
    super(
      {
        status: "idle",
        currentVersion: deps.currentVersion,
        latestVersion: null,
        releaseUrl: null,
        releaseName: null,
        format: detectPackageFormat(deps.env, deps.exists, deps.platform),
        progress: null,
        downloadedPath: null,
        installOnQuit: false,
        error: null,
      },
      deps,
    );
    this.enabled =
      deps.enabled &&
      deps.currentVersion !== "0.0.0" &&
      parseSemver(deps.currentVersion) !== null;
    // The running version is fixed for this process, so stale dismissal
    // reaping happens once at construction.
    this.reapDismissed(deps.currentVersion);
    this.machine = { state: this.state, release: null, stage: null };
  }

  /**
   * The one route from an event to the renderer: derive the next snapshot
   * and publish its COMPLETE state through the controller's generic set().
   * No other method calls set() directly (dismiss excepted — the base
   * persistence policy rides on its dismissState, which receives the full
   * derived state as its patch).
   */
  private publish(event: AppUpdateEvent): void {
    this.machine = deriveAppUpdateState(this.machine, event);
    this.set(this.machine.state);
  }

  /**
   * One check against the latest stable GitHub release. `manual` (palette)
   * bypasses the per-version dismissal and reports outcomes the background
   * check swallows: up-to-date, unreachable, disabled.
   */
  async checkNow(manual: boolean): Promise<AppUpdateState> {
    if (!this.enabled) {
      if (manual) this.publish({ t: "disabled" });
      return this.state;
    }
    this.publish({ t: "check-begin" });
    const release = await fetchLatestAppRelease(this.deps.fetchImpl);
    if (release === null) {
      this.publish({ t: "unreachable", manual });
      return this.state;
    }
    if (compareVersions(this.deps.currentVersion, release.version) >= 0) {
      this.publish({ t: "up-to-date", manual });
      return this.state;
    }
    // "Later" stays quiet for that release on background checks; an explicit
    // manual check is the user asking, so it always answers.
    if (this.offerIsDismissed(release.version, manual)) {
      this.publish({ t: "offer-dismissed" });
      return this.state;
    }
    const format = detectPackageFormat(this.deps.env, this.deps.exists, this.deps.platform);
    if (isAutoUpdateFormat(format)) {
      await this.stageAutoUpdate(release, format, manual);
      return this.state;
    }
    this.publish({ t: "available", release, format });
    return this.state;
  }

  /**
   * Stages an AppImage/NSIS/macOS-zip update through electron-updater's
   * sha512/blockmap-verified path; on macOS the staged ZIP is applied through
   * Squirrel.Mac. Background checks expose only the completed state; a manual
   * check makes the same in-flight stage and failures visible.
   */
  private async stageAutoUpdate(
    release: AppReleaseInfo,
    format: AutoUpdateFormat,
    visible: boolean,
  ): Promise<void> {
    if (this.machine.stage !== null) {
      if (visible && !this.machine.stage.visible) {
        this.publish({ t: "stage-enter", visible: true, release, format });
      }
      return;
    }

    this.publish({ t: "stage-enter", visible, release, format });
    try {
      this.autoUpdater ??= await (this.deps.autoUpdaterFactory ?? defaultAutoUpdaterFactory)();
      const autoUpdater = this.autoUpdater;
      // omp-ui controls when staging begins; electron-updater must not start a
      // second download from its own checkForUpdates() call.
      autoUpdater.autoDownload = false;
      // False until the user explicitly chooses "Install when I quit".
      autoUpdater.autoInstallOnAppQuit = this.installOnQuitArmed;
      if (!this.autoUpdaterHooked) {
        this.autoUpdaterHooked = true;
        autoUpdater.on("download-progress", (p) => {
          if (this.machine.stage?.visible) {
            this.publish({ t: "stage-progress", percent: Math.floor(p.percent) });
          }
        });
        autoUpdater.on("update-downloaded", (info) => {
          this.publish({ t: "stage-complete", version: info.version });
        });
        autoUpdater.on("error", (err) => {
          if (this.restarting) {
            this.restarting = false;
            this.deps.setQuitAuthorized(false);
            this.publish({ t: "apply-failed", message: err.message });
            return;
          }
          // An error outside an in-flight stage is someone else's problem:
          // the restart arm above owns handoff failures, and a late event
          // after the stage already settled must not overwrite its result.
          if (this.machine.stage === null) return;
          this.publish({ t: "stage-failed", visible: this.machine.stage.visible, message: err.message });
        });
      }

      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable) {
        await autoUpdater.downloadUpdate();
      } else {
        // Reports from the flag this call began with, not the stage's
        // current visibility — a reentrant reveal mid-call must not change
        // how the original caller settles.
        this.publish({ t: "stage-empty", visible });
      }
    } catch (error) {
      // electron-updater normally emits "error" before rejecting. Only own
      // the fallback when that event did not already settle this stage.
      // stage-enter (and updater callbacks) mutate the snapshot across the
      // await; TypeScript retains the stale pre-await null narrowing.
      const currentStage = (this.machine as AppUpdateMachine).stage;
      if (currentStage === null) return;
      this.publish({
        t: "stage-failed",
        visible: currentStage.visible,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * The card's primary action for manual formats: download the exact expected
   * asset, verify it against SHA256SUMS.txt, and open it with the system
   * installer. Auto-update staging begins in checkNow().
   */
  async download(): Promise<void> {
    if (this.state.status !== "available" || this.machine.release === null) return;
    const release = this.machine.release;
    const format = this.state.format;
    if (format === "unknown") {
      await this.openReleaseNotes(); // nothing downloadable — show the release page
      return;
    }
    // Auto-update formats never reach "available": checkNow() stages them immediately.
    if (isAutoUpdateFormat(format)) return;
    // deb / rpm / flatpak: verified download + system-installer handoff.
    const name = selectAsset(release, format);
    if (name === null) {
      this.publish({ t: "asset-missing" });
      return;
    }
    const sums = await fetchSha256Sums(release.tag, this.deps.fetchImpl);
    const expectedSha256 = sums?.get(name);
    if (expectedSha256 === undefined) {
      // Fail closed: every release cut after this updater shipped carries
      // SHA256SUMS.txt; never run an unverified installer.
      this.publish({ t: "checksums-missing" });
      return;
    }
    this.publish({ t: "asset-download-begin" });
    const targetPath = join(this.deps.downloadsDir, name);
    try {
      await downloadAppAsset({
        url: `${APP_RELEASE_DOWNLOAD_BASE}/${release.tag}/${name}`,
        targetPath,
        expectedSha256,
        fetchImpl: this.deps.downloadFetchImpl,
        onProgress: (p) => this.publish({ t: "asset-download-progress", percent: p }),
      });
    } catch (e) {
      this.publish({
        t: "asset-download-failed",
        message: e instanceof Error ? e.message : String(e),
      });
      return;
    }
    this.publish({ t: "asset-downloaded", path: targetPath });
    // Best-effort installer handoff; the downloaded card keeps "Show in
    // folder" as the escape hatch when the system handler declines.
    await shell.openPath(targetPath).catch(() => "");
  }

  /** Opens the pending release's GitHub page. */
  async openReleaseNotes(): Promise<void> {
    if (this.state.releaseUrl !== null) await shell.openExternal(this.state.releaseUrl);
  }

  /** Reveals a downloaded manual installer in its folder. */
  async showDownload(): Promise<void> {
    if (this.state.downloadedPath !== null) shell.showItemInFolder(this.state.downloadedPath);
  }

  /**
   * Two-step restart contract: a live session makes the first request return
   * to the initiating renderer for confirmation. A confirmed retry re-reads
   * live state, authorizes the process quit guard, then installs.
   */
  restart(confirmed = false): AppUpdateRestartResult {
    if (this.restarting) return "restarting";
    if (this.state.status !== "downloaded" || !isAutoUpdateFormat(this.state.format)) {
      return "unavailable";
    }
    if (this.autoUpdater === null) return "unavailable";
    if (this.deps.hasLiveSessions() && !confirmed) return "confirmation-required";
    this.restarting = true;
    this.publish({ t: "installing" });
    this.deps.setQuitAuthorized(true);
    try {
      if (this.state.format === "nsis") this.autoUpdater.quitAndInstall(true, true);
      else this.autoUpdater.quitAndInstall();
    } catch (error) {
      this.restarting = false;
      this.deps.setQuitAuthorized(false);
      this.publish({
        t: "apply-failed",
        message: error instanceof Error ? error.message : String(error),
      });
      return "unavailable";
    }
    return "restarting";
  }

  /**
   * Applies a staged AppImage/NSIS/macOS-zip update on the next natural quit
   * only after an explicit user choice. BaseUpdater skips quit-hook registration
   * when the download completed with autoInstallOnAppQuit=false, so arming later
   * must register that idempotent hook; it re-checks the flag at quit, making
   * disarming reliable.
   */
  setInstallOnQuit(on: boolean): void {
    if (on && (this.state.status !== "downloaded" || !isAutoUpdateFormat(this.state.format))) return;
    this.installOnQuitArmed = on;
    if (this.autoUpdater !== null) {
      this.autoUpdater.autoInstallOnAppQuit = on;
      if (on) this.autoUpdater.addQuitHandler();
    }
    this.publish({ t: "install-on-quit", on });
  }

  /**
   * Hides the card. `remember` persists the version so background checks
   * stay quiet for that release; a transient hide (`remember: false`)
   * clears only the visible state. The persistence policy mirrors
   * UpdateController's dismissState, applied before the publish.
   */
  dismiss(version: string, remember: boolean): void {
    if (remember && version !== "") this.deps.setDismissed(version);
    this.publish({ t: "dismiss" });
  }
}
