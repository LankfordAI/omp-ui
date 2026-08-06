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
  type AppUpdateState,
  type DownloadFetchLike,
  type FetchLike,
} from "@omp-ui/core";

// Main-process orchestration for omp-ui's own release updates (issue #18).
// All the machine work — release lookup, package-format detection, the
// checksum-verified download — lives in @omp-ui/core; this file owns the
// state machine the renderer's update card renders, plus the AppImage
// in-place path through electron-updater.
//
// Quiet by default: background (launch) checks never surface error or
// up-to-date states — only "available" earns the card. Manual checks from the
// command palette bypass dismissal and report up-to-date/error/disabled
// transiently. Nothing downloads without an explicit Update/Download click.

/** The slice of electron-updater's AppUpdater this flow uses (6.8.9 API). */
export interface AutoUpdaterLike {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  on(event: "download-progress", cb: (p: { percent: number }) => void): void;
  on(event: "update-downloaded", cb: (info: { version: string }) => void): void;
  on(event: "error", cb: (err: Error) => void): void;
  checkForUpdates(): Promise<{ isUpdateAvailable: boolean } | null>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
}

export interface AppUpdaterDeps {
  win: BrowserWindow;
  enabled: boolean;
  currentVersion: string;
  downloadsDir: string; // app.getPath("downloads")
  getDismissed: () => string | null;
  setDismissed: (version: string | null) => void;
  /** Runs the live-session quit guard; resolves true when quit may proceed. */
  confirmQuit: () => Promise<boolean>;
  send: (channel: string, state: AppUpdateState) => void;
  channel: string; // CH.appUpdateState
  fetchImpl?: FetchLike; // tests
  downloadFetchImpl?: DownloadFetchLike; // tests
  autoUpdaterFactory?: () => Promise<AutoUpdaterLike>; // tests; default below
  env?: NodeJS.ProcessEnv;
  exists?: (p: string) => boolean;
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
  // electron and is dead weight on deb/rpm/flatpak installs — only the
  // AppImage download path ever needs it.
  const autoUpdater = resolveAutoUpdater(await import("electron-updater"));
  if (autoUpdater === null) throw new Error("electron-updater export unavailable");
  return autoUpdater;
};

export class AppUpdater {
  state: AppUpdateState;
  /** Dev/unversioned builds never check: off unless packaged AND semver-stamped. */
  private readonly enabled: boolean;
  /** The release that earned the current "available" state, kept for download(). */
  private release: AppReleaseInfo | null = null;
  private autoUpdater: AutoUpdaterLike | null = null;
  private autoUpdaterHooked = false;

  constructor(private readonly deps: AppUpdaterDeps) {
    this.enabled =
      deps.enabled &&
      deps.currentVersion !== "0.0.0" &&
      parseSemver(deps.currentVersion) !== null;
    this.state = {
      status: "idle",
      currentVersion: deps.currentVersion,
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      format: detectPackageFormat(deps.env, deps.exists),
      progress: null,
      downloadedPath: null,
      error: null,
    };
    // A remembered dismissal suppresses only its exact offered version, and
    // every offer is newer than the running build — so once this build has
    // caught up to the dismissed version the entry can never fire again and
    // would only sit on the Settings Updates page as a stale "Dismissed" row
    // (issue #88). Unparseable/0.0.0 dev-build versions sort lowest in
    // compareVersions, so they never reap. The running version is fixed for
    // the process's lifetime, so construction is the only reap point needed.
    const dismissed = deps.getDismissed();
    if (dismissed !== null && compareVersions(dismissed, deps.currentVersion) <= 0) {
      deps.setDismissed(null);
    }
  }

  private push(): void {
    this.deps.send(this.deps.channel, this.state);
  }

  private set(patch: Partial<AppUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.push();
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
    if (!manual && this.deps.getDismissed() === release.version) {
      this.set({ status: "idle" });
      return this.state;
    }
    this.release = release;
    this.set({
      status: "available",
      latestVersion: release.version,
      releaseUrl: release.url,
      releaseName: release.name,
      format: detectPackageFormat(this.deps.env, this.deps.exists),
    });
    return this.state;
  }

  /**
   * The card's primary action. AppImage hands off to electron-updater
   * (sha512/blockmap-verified in-place update); deb/rpm/flatpak download the
   * exact expected asset, verify it against the release's SHA256SUMS.txt, and
   * open it with the system installer. No-op unless an update is available.
   */
  async download(): Promise<void> {
    if (this.state.status !== "available" || this.release === null) return;
    const release = this.release;
    const format = this.state.format;
    if (format === "unknown") {
      await this.openReleaseNotes(); // nothing downloadable — show the release page
      return;
    }
    if (format === "appimage") {
      // Everything up to the download itself lives inside the try: a factory
      // or setup failure must land on the card's error state, not escape as
      // an invoke rejection the renderer cannot show (issue #87).
      try {
        this.autoUpdater ??= await (this.deps.autoUpdaterFactory ?? defaultAutoUpdaterFactory)();
        const autoUpdater = this.autoUpdater;
        // Never download without the explicit click that got us here.
        autoUpdater.autoDownload = false;
        // An ordinary quit must never silently install a downloaded update
        // (ADR-0011); install happens only via the card's "Restart now".
        autoUpdater.autoInstallOnAppQuit = false;
        if (!this.autoUpdaterHooked) {
          this.autoUpdaterHooked = true; // a second download() must not double-register
          autoUpdater.on("download-progress", (p) => {
            this.set({ status: "downloading", progress: Math.floor(p.percent) });
          });
          autoUpdater.on("update-downloaded", () => {
            this.set({ status: "downloaded", progress: null });
          });
          autoUpdater.on("error", (err) => {
            this.set({ status: "error", error: err.message });
          });
        }
        const r = await autoUpdater.checkForUpdates();
        if (r?.isUpdateAvailable) {
          await autoUpdater.downloadUpdate();
        } else {
          this.set({ status: "up-to-date" });
        }
      } catch (e) {
        this.set({ status: "error", error: e instanceof Error ? e.message : String(e) });
      }
      return;
    }
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

  /** Reveals the downloaded artifact in its folder (non-AppImage). */
  async showDownload(): Promise<void> {
    if (this.state.downloadedPath !== null) shell.showItemInFolder(this.state.downloadedPath);
  }

  /**
   * Restarts into the downloaded AppImage update. Live sessions still get
   * their say first — the same quit guard as the window close button.
   */
  async restart(): Promise<void> {
    if (this.state.status !== "downloaded" || this.state.format !== "appimage") return;
    if (this.autoUpdater === null) return;
    if (!(await this.deps.confirmQuit())) return;
    this.autoUpdater.quitAndInstall();
  }

  /**
   * Hides the card. `remember` persists the version so background checks stay
   * quiet for that release; a transient hide (`remember: false`) clears only
   * the visible state.
   */
  dismiss(version: string, remember: boolean): void {
    if (remember && version) this.deps.setDismissed(version);
    this.release = null;
    this.set({
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
