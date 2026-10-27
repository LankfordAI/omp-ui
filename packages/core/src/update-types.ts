/** Typed failure shared by app and omp updater state machines.
 *  `unreadable` is app-only: the feed answered with a release this build's
 *  parser refuses (issue #930) — distinct from a feed it could not reach. */
export interface UpdateFailure {
  kind: "unreachable" | "unreadable" | "failed";
  message: string;
}

export interface OmpUpdateInfo {
  installPath: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  /** Installed binary is older than MIN_SUPPORTED_OMP. False when no binary. */
  belowMinimum: boolean;
  error: UpdateFailure | null;
}

/** Every package format `detectPackageFormat` can answer; the type derives from this tuple so the two cannot drift. */
export const APP_PACKAGE_FORMATS = ["appimage", "nsis", "maczip", "deb", "rpm", "flatpak", "unknown"] as const;

export type AppPackageFormat = (typeof APP_PACKAGE_FORMATS)[number];

export type AppUpdateStatus =
  | "disabled"
  | "idle"
  | "checking"
  | "up-to-date"
  | "available"
  | "downloading"
  | "downloaded"
  | "installing"
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  releaseUrl: string | null;
  releaseName: string | null;
  format: AppPackageFormat;
  progress: number | null;
  downloadedPath: string | null;
  installOnQuit: boolean;
  error: UpdateFailure | null;
}

export type AppUpdateRestartResult = "confirmation-required" | "restarting" | "unavailable";

export type OmpUpdateStatus =
  | "idle"
  | "checking"
  | "up-to-date"
  | "missing"
  | "available"
  | "downloading"
  | "installed"
  | "error";

export interface OmpUpdateState {
  status: OmpUpdateStatus;
  installPath: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  /** Installed binary is older than MIN_SUPPORTED_OMP (harness floor). */
  belowMinimum: boolean;
  progress: number | null;
  error: UpdateFailure | null;
}

export type UpdateTrain = "stable" | "nightly";
