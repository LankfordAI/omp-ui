/** Typed failure shared by app and omp updater state machines. */
export interface UpdateFailure {
  kind: "unreachable" | "failed";
  message: string;
}

export interface OmpUpdateInfo {
  installPath: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  error: UpdateFailure | null;
}

export type AppPackageFormat =
  | "appimage"
  | "nsis"
  | "maczip"
  | "deb"
  | "rpm"
  | "flatpak"
  | "unknown";

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
  progress: number | null;
  error: UpdateFailure | null;
}

export type UpdateTrain = "stable" | "nightly";
