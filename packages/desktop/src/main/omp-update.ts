import {
  checkOmpUpdate as coreCheckOmpUpdate,
  compareVersions,
  downloadOmp,
  managedOmpPath,
  MIN_SUPPORTED_OMP,
  ompPinActive,
  type DownloadFetchLike,
  type FetchLike,
  type OmpUpdateState,
  type VersionRunner,
} from "@omp-ui/core";
import { UpdateController, type UpdateControllerDeps } from "./update-controller";

// Main-process orchestration for omp install/update (issue #19), mirroring
// app-update.ts: core owns the machine work (version reads, registry lookup,
// the atomic verified download); this class owns the state machine the
// renderer's update card renders. Quiet by default: background checks never
// surface error/up-to-date — only "available"/"missing" earn the card.
// Nothing downloads without an explicit Update now/Install click — except
// when the installed binary is below MIN_SUPPORTED_OMP and auto-upgrade is
// on (§ harness floor): a requirement, not an offer. A failed install leaves
// the previous binary untouched (core tmp+rename).

export interface OmpUpdaterDeps extends UpdateControllerDeps<OmpUpdateState> {
  /** Fires only after a successful install so the caller re-resolves the binary. */
  onApplied: (version: string) => void;
  fetchImpl?: FetchLike; // tests
  downloadFetchImpl?: DownloadFetchLike; // tests
  runner?: VersionRunner; // tests: version reads AND download verification
  targetPath?: string; // tests; default managedOmpPath()
  /** Tests force missing-omp with null; undefined = resolveOmpBinary() via core. */
  installPath?: string | null;
  /** Reads registry setting `ompAutoUpgrade`; false disables below-floor auto-download. */
  autoUpgrade: () => boolean;
  /** True when OMP_UI_OMP_PATH names an existing file — a dev pin outranks the
   *  managed copy (paths.ts resolveOmpBinary), so installing into the managed
   *  path would be silently ignored and must never happen automatically. */
  pinActive?: () => boolean; // tests; default: core's ompPinActive env check
}

export class OmpUpdater extends UpdateController<OmpUpdateState> {

  constructor(private readonly deps: OmpUpdaterDeps) {
    super(
      {
        status: "idle",
        installPath: null,
        installedVersion: null,
        latestVersion: null,
        belowMinimum: false,
        progress: null,
        error: null,
      },
      deps,
    );
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
    // Every outcome carries the resolved install facts (issue #76): without
    // them a present, up-to-date omp leaves installPath/installedVersion null
    // and the Settings row falls back to its "not installed" placeholder.
    const facts = { installPath: info.installPath, installedVersion: info.installedVersion };
    const pinned = (this.deps.pinActive ?? ompPinActive)();
    this.reapDismissed(info.installedVersion);
    if (info.error !== null || info.latestVersion === null) {
      // Offline/registry unreachable: quiet in the background, answered manually.
      this.set(
        manual
          ? {
              ...facts,
              belowMinimum: info.belowMinimum,
              status: "error",
              error: info.error ?? {
                kind: "unreachable",
                message: "could not reach the omp release registry",
              },
            }
          : { ...facts, belowMinimum: info.belowMinimum, status: "idle" },
      );
      return this.state;
    }
    const offered = info.installPath === null ? "missing" : info.updateAvailable ? "available" : null;
    if (offered === null) {
      this.set(
        manual
          ? { ...facts, belowMinimum: info.belowMinimum, status: "up-to-date" }
          : { ...facts, belowMinimum: info.belowMinimum, status: "idle" },
      );
      return this.state;
    }
    // "Later" stays quiet for that version on background checks; an explicit
    // manual check is the user asking, so it always answers. A floor
    // violation is a requirement, not an offer: a stored "Later" never mutes it.
    if (!info.belowMinimum && this.offerIsDismissed(info.latestVersion, manual)) {
      this.set({ ...facts, belowMinimum: info.belowMinimum, status: "idle" });
      return this.state;
    }
    this.set({
      status: offered,
      ...facts,
      belowMinimum: info.belowMinimum,
      latestVersion: info.latestVersion,
    });
    // Below the floor with auto-upgrade on, the check installs in the same
    // pass — download() re-validates the offer state, so this is the entire
    // install path. A dev pin outranks the managed copy, so installing there
    // would silently do nothing; the card instructs instead.
    if (info.belowMinimum && this.deps.autoUpgrade() && !pinned) {
      await this.download();
    }
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
        error: {
          kind: "failed",
          message: e instanceof Error ? e.message : String(e),
        },
        progress: null,
      });
      return;
    }
    this.deps.onApplied(version);
    this.reapDismissed(version);
    this.set({
      status: "installed",
      installPath: target,
      installedVersion: version,
      belowMinimum: compareVersions(version, MIN_SUPPORTED_OMP) < 0,
      progress: null,
    });
  }

  /**
   * Hides the card. `remember` persists the version so background checks stay
   * quiet for that offer; a transient hide (`remember: false`) clears only
   * the visible state. Last-known install facts are kept. While the floor is
   * violated the hide is always transient: a requirement returns next check.
   */
  dismiss(version: string, remember: boolean): void {
    this.dismissState(version, remember && !this.state.belowMinimum, {
      status: "idle",
      latestVersion: null,
      belowMinimum: false,
      progress: null,
      error: null,
    });
  }

}
