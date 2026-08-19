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
  /** Marks the app's quit guard as satisfied after renderer confirmation. */
  authorizeQuit: () => void;
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

export class AppUpdater extends UpdateController<AppUpdateState> {
  /** Dev/unversioned builds never check: off unless packaged AND semver-stamped. */
  private readonly enabled: boolean;
  /** The release behind the current offer/stage, kept for notes and downloads. */
  private release: AppReleaseInfo | null = null;
  private autoUpdater: AutoUpdaterLike | null = null;
  private autoUpdaterHooked = false;
  private autoUpdateStaging = false;
  private autoUpdateStageVisible = false;
  private installOnQuitArmed = false;
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
  }


  /**
   * One check against the latest stable GitHub release. `manual` (palette)
   * bypasses the per-version dismissal and reports outcomes the background
   * check swallows: up-to-date, unreachable, disabled.
   */
  async checkNow(manual: boolean): Promise<AppUpdateState> {
    if (!this.enabled) {
      if (manual) this.set({ status: "disabled" });
      return this.state;
    }
    this.set({ status: "checking", error: null, progress: null });
    const release = await fetchLatestAppRelease(this.deps.fetchImpl);
    if (release === null) {
      this.set(manual ? { status: "error", error: "could not reach GitHub" } : { status: "idle" });
      return this.state;
    }
    if (compareVersions(this.deps.currentVersion, release.version) >= 0) {
      this.set(manual ? { status: "up-to-date" } : { status: "idle" });
      return this.state;
    }
    // "Later" stays quiet for that release on background checks; an explicit
    // manual check is the user asking, so it always answers.
    if (this.offerIsDismissed(release.version, manual)) {
      this.set({ status: "idle" });
      return this.state;
    }
    this.release = release;
    const format = detectPackageFormat(this.deps.env, this.deps.exists, this.deps.platform);
    if (isAutoUpdateFormat(format)) {
      await this.stageAutoUpdate(release, format, manual);
      return this.state;
    }
    this.set({
      status: "available",
      latestVersion: release.version,
      releaseUrl: release.url,
      releaseName: release.name,
      format,
    });
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
    const releaseState = {
      latestVersion: release.version,
      releaseUrl: release.url,
      releaseName: release.name,
      format,
    };

    if (this.autoUpdateStaging) {
      if (visible && !this.autoUpdateStageVisible) {
        this.autoUpdateStageVisible = true;
        this.set({ status: "downloading", ...releaseState });
      }
      return;
    }

    this.autoUpdateStaging = true;
    this.autoUpdateStageVisible = visible;
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
          if (this.autoUpdateStageVisible) {
            this.set({ status: "downloading", progress: Math.floor(p.percent) });
          }
        });
        autoUpdater.on("update-downloaded", (info) => {
          this.autoUpdateStaging = false;
          this.autoUpdateStageVisible = false;
          this.set({
            status: "downloaded",
            latestVersion: info.version,
            progress: null,
            error: null,
          });
        });
        autoUpdater.on("error", (err) => {
          if (!this.autoUpdateStaging) return;
          const wasVisible = this.autoUpdateStageVisible;
          this.autoUpdateStaging = false;
          this.autoUpdateStageVisible = false;
          this.set(wasVisible ? { status: "error", error: err.message } : { status: "idle" });
        });
      }

      this.set(
        visible
          ? { status: "downloading", ...releaseState }
          : { status: "idle", ...releaseState },
      );
      const result = await autoUpdater.checkForUpdates();
      if (result?.isUpdateAvailable) {
        await autoUpdater.downloadUpdate();
      } else {
        this.autoUpdateStaging = false;
        this.autoUpdateStageVisible = false;
        this.set(visible ? { status: "up-to-date" } : { status: "idle" });
      }
    } catch (error) {
      // electron-updater normally emits "error" before rejecting. Only own
      // the fallback when that event did not already settle this stage.
      if (!this.autoUpdateStaging) return;
      const wasVisible = this.autoUpdateStageVisible;
      this.autoUpdateStaging = false;
      this.autoUpdateStageVisible = false;
      this.set(
        wasVisible
          ? { status: "error", error: error instanceof Error ? error.message : String(error) }
          : { status: "idle" },
      );
    }
  }

  /**
   * The card's primary action for manual formats: download the exact expected
   * asset, verify it against SHA256SUMS.txt, and open it with the system
   * installer. Auto-update staging begins in checkNow().
   */
  async download(): Promise<void> {
    if (this.state.status !== "available" || this.release === null) return;
    const release = this.release;
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
      this.set({ status: "error", error: "expected asset missing from release" });
      return;
    }
    const sums = await fetchSha256Sums(release.tag, this.deps.fetchImpl);
    const expectedSha256 = sums?.get(name);
    if (expectedSha256 === undefined) {
      // Fail closed: every release cut after this updater shipped carries
      // SHA256SUMS.txt; never run an unverified installer.
      this.set({ status: "error", error: "release checksums unavailable" });
      return;
    }
    this.set({ status: "downloading", progress: null });
    const targetPath = join(this.deps.downloadsDir, name);
    try {
      await downloadAppAsset({
        url: `${APP_RELEASE_DOWNLOAD_BASE}/${release.tag}/${name}`,
        targetPath,
        expectedSha256,
        fetchImpl: this.deps.downloadFetchImpl,
        onProgress: (p) => this.set({ status: "downloading", progress: p }),
      });
    } catch (e) {
      this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
      return;
    }
    this.set({ status: "downloaded", downloadedPath: targetPath, progress: null });
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
    this.deps.authorizeQuit();
    if (this.state.format === "nsis") this.autoUpdater.quitAndInstall(true, true);
    else this.autoUpdater.quitAndInstall();
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
    this.set({ installOnQuit: on });
  }

  /**
   * Hides the card. `remember` persists the version so background checks stay
   * quiet for that release; a transient hide (`remember: false`) clears only
   * the visible state.
   */
  dismiss(version: string, remember: boolean): void {
    this.release = null;
    this.dismissState(version, remember, {
      status: "idle",
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      progress: null,
      downloadedPath: null,
      error: null,
    });
  }
}
