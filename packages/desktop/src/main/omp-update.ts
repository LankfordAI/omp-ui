import {
  checkOmpUpdate as coreCheckOmpUpdate,
  downloadOmp,
  managedOmpPath,
  type DownloadFetchLike,
  type FetchLike,
  type OmpUpdateState,
  type VersionRunner,
} from "@omp-ui/core";

// Main-process orchestration for omp install/update (issue #19), mirroring
// app-update.ts: core owns the machine work (version reads, registry lookup,
// the atomic verified download); this class owns the state machine the
// renderer's update card renders. Quiet by default: background checks never
// surface error/up-to-date — only "available"/"missing" earn the card.
// Nothing downloads without an explicit Update now/Install click, and a
// failed install leaves the previous binary untouched (core tmp+rename).

export interface OmpUpdaterDeps {
  getDismissed: () => string | null;
  setDismissed: (version: string | null) => void;
  /** Fires only after a successful install so the caller re-resolves the binary. */
  onApplied: (version: string) => void;
  send: (channel: string, state: OmpUpdateState) => void;
  channel: string; // CH.ompUpdateState
  fetchImpl?: FetchLike; // tests
  downloadFetchImpl?: DownloadFetchLike; // tests
  runner?: VersionRunner; // tests: version reads AND download verification
  targetPath?: string; // tests; default managedOmpPath()
  /** Tests force missing-omp with null; undefined = resolveOmpBinary() via core. */
  installPath?: string | null;
}

export class OmpUpdater {
  state: OmpUpdateState;

  constructor(private readonly deps: OmpUpdaterDeps) {
    this.state = {
      status: "idle",
      installPath: null,
      installedVersion: null,
      latestVersion: null,
      progress: null,
      error: null,
    };
  }

  private push(): void {
    this.deps.send(this.deps.channel, this.state);
  }

  private set(patch: Partial<OmpUpdateState>): void {
    this.state = { ...this.state, ...patch };
    this.push();
  }

  /**
   * One check against the npm registry's latest omp release. `manual`
   * (palette) bypasses the per-version dismissal and reports outcomes the
   * background check swallows: up-to-date, unreachable. A missing binary is
   * an install offer, not an update — decided before the no-update branch.
   */
  async checkNow(manual: boolean): Promise<OmpUpdateState> {
    this.set({ status: "checking", error: null, progress: null });
    const info = await coreCheckOmpUpdate({
      installPath: this.deps.installPath,
      fetchImpl: this.deps.fetchImpl,
      runner: this.deps.runner,
    });
    if (info.error !== null || info.latestVersion === null) {
      // Offline/registry unreachable: quiet in the background, answered manually.
      this.set(
        manual
          ? { status: "error", error: info.error ?? "could not reach the omp release registry" }
          : { status: "idle" },
      );
      return this.state;
    }
    const offered = info.installPath === null ? "missing" : info.updateAvailable ? "available" : null;
    if (offered === null) {
      this.set(manual ? { status: "up-to-date" } : { status: "idle" });
      return this.state;
    }
    // "Later" stays quiet for that version on background checks; an explicit
    // manual check is the user asking, so it always answers.
    if (!manual && this.deps.getDismissed() === info.latestVersion) {
      this.set({ status: "idle" });
      return this.state;
    }
    this.set({
      status: offered,
      installPath: info.installPath,
      installedVersion: info.installedVersion,
      latestVersion: info.latestVersion,
    });
    return this.state;
  }

  /**
   * The card's primary action (Update now / Install): streams the verified
   * binary into the managed path. No-op unless an offer is on the table; a
   * failure leaves the previous binary in place and the pre-action
   * installPath/installedVersion in state.
   */
  async download(): Promise<void> {
    if (this.state.status !== "available" && this.state.status !== "missing") return;
    const version = this.state.latestVersion;
    if (version === null) return;
    const target = this.deps.targetPath ?? managedOmpPath();
    this.set({ status: "downloading", progress: null, error: null });
    try {
      await downloadOmp({
        version,
        targetPath: target,
        fetchImpl: this.deps.downloadFetchImpl,
        verifyRunner: this.deps.runner, // undefined in prod → core's real --version check
        onProgress: (p) => this.set({ status: "downloading", progress: p }),
      });
    } catch (e) {
      // tmp already removed by core; the previous binary is still in place and
      // the state keeps the pre-action installPath/installedVersion.
      this.set({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        progress: null,
      });
      return;
    }
    this.deps.onApplied(version);
    this.set({
      status: "installed",
      installPath: target,
      installedVersion: version,
      progress: null,
    });
  }

  /**
   * Hides the card. `remember` persists the version so background checks stay
   * quiet for that offer; a transient hide (`remember: false`) clears only
   * the visible state. Last-known install facts are kept.
   */
  dismiss(version: string, remember: boolean): void {
    if (remember && version) this.deps.setDismissed(version);
    this.set({ status: "idle", latestVersion: null, progress: null, error: null });
  }
}
