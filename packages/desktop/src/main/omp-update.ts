import { dialog, type BrowserWindow } from "electron";
import {
  checkOmpUpdate as coreCheckOmpUpdate,
  downloadOmp,
  fetchLatestOmpVersion,
  managedOmpPath,
  type OmpUpdateInfo,
} from "@omp-ui/core";

// Main-process orchestration for omp install/update. All the machine work
// (version reads, release lookup, download) lives in @omp-ui/core; this file
// wires it to the native confirm dialogs and the app-managed install location.
//
// Every download path goes through applyOmpUpdate, which always asks the user
// before writing anything — so the launch check and the renderer IPC surface
// share one guarded code path.

const appliedInfo = (version: string, target: string): OmpUpdateInfo => ({
  installPath: target,
  installedVersion: version,
  latestVersion: version,
  updateAvailable: false,
  error: null,
});

const failedInfo = (message: string): OmpUpdateInfo => ({
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  updateAvailable: false,
  error: message,
});

export function checkOmpUpdate(): Promise<OmpUpdateInfo> {
  return coreCheckOmpUpdate();
}

/**
 * Installs (or updates) the app-managed omp binary to the latest published
 * release. Always shows a confirm dialog first — it never downloads without
 * consent. `options.onApplied(version)` fires only after a successful install
 * so the caller can refresh its cached binary path immediately.
 *
 * On cancellation the returned info is the pre-action state (installedVersion
 * unchanged, error null), so callers can tell "applied" from "declined" by
 * comparing installedVersion against latestVersion.
 */
export async function applyOmpUpdate(
  win: BrowserWindow,
  options: { info?: OmpUpdateInfo; onApplied?: (version: string) => void } = {},
): Promise<OmpUpdateInfo> {
  const info = options.info ?? (await coreCheckOmpUpdate());
  const onApplied = options.onApplied ?? (() => {});
  const installing = !info.installPath;
  const target = managedOmpPath();

  try {
    const latest = info.latestVersion ?? (await fetchLatestOmpVersion());
    if (!latest) throw new Error("could not reach the omp release registry");

    const confirm = await dialog.showMessageBox(win, {
      type: "info",
      buttons: [installing ? "Install" : "Update now", "Later"],
      defaultId: 0,
      cancelId: 1,
      message: installing
        ? "omp is not installed."
        : `A new version of omp is available: ${info.installedVersion} → ${latest}.`,
      detail: installing
        ? "omp-ui manages its own copy of the omp binary. Install it now so you can run sessions?"
        : "Download and install it now? New sessions will use it immediately.",
    });
    if (confirm.response !== 0) return info;

    await downloadOmp({ version: latest, targetPath: target });
    onApplied(latest);
    await dialog.showMessageBox(win, {
      type: "info",
      message: `omp ${latest} installed.`,
      detail: `Installed to ${target}. New sessions will use it now.`,
    });
    return appliedInfo(latest, target);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await dialog.showMessageBox(win, {
      type: "error",
      message: "Failed to update omp.",
      detail: message,
    });
    return failedInfo(message);
  }
}

/**
 * The run-at-launch check. Asks the user before downloading anything: offers a
 * first install when omp is absent, or an update when a newer release exists.
 * Offline/unreachable failures stay silent. Resolves true when an install or
 * update was actually applied.
 */
export async function runOmpLaunchUpdateCheck(
  win: BrowserWindow,
  onApplied: (version: string) => void = () => {},
): Promise<boolean> {
  const info = await coreCheckOmpUpdate();
  if (info.error) return false; // offline or registry unreachable — stay quiet
  if (!info.latestVersion) return false; // registry unreachable — never error-spam on launch
  if (info.installPath && !info.updateAvailable) return false;
  const result = await applyOmpUpdate(win, { info, onApplied });
  return result.error === null && result.installedVersion === info.latestVersion;
}
