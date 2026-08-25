import type { AppUpdateState, OmpUpdateState } from "@omp-ui/core/types";
import { useStore } from "../../store";
import { AppUpdateRestartAction } from "../AppUpdateCard";
import { Button, Panel, Switch } from "../ui";

function appStatusLine(u: AppUpdateState): string {
  switch (u.status) {
    case "available":
      return `${u.latestVersion ?? "a newer release"} available`;
    case "downloading":
      return `downloading ${u.latestVersion ?? ""}…`;
    case "downloaded":
      return `${u.latestVersion ?? "update"} downloaded${u.installOnQuit ? " — installs on quit" : ""}`;
    case "installing":
      return `applying ${u.latestVersion ?? "update"}…`;
    case "up-to-date":
      return "up to date";
    case "checking":
      return "checking…";
    case "disabled":
      return "omp-ui checks disabled in this build — omp binary updates are independent";
    case "error":
      return u.error ?? "update check failed";
    default:
      return "no check has run yet";
  }
}

function ompStatusLine(u: OmpUpdateState): string {
  switch (u.status) {
    case "missing":
      return "not installed";
    case "available":
      return `${u.latestVersion ?? "a newer release"} available`;
    case "downloading":
      return `installing ${u.latestVersion ?? ""}…`;
    case "installed":
      return `${u.latestVersion ?? "update"} installed — new sessions use it`;
    case "up-to-date":
      return "up to date";
    case "checking":
      return "checking…";
    case "error":
      return u.error ?? "update check failed";
    default:
      return "no check has run yet";
  }
}

export function UpdatesPage() {
  const state = useStore((s) => s.state);
  const appUpdate = useStore((s) => s.appUpdate);
  const ompUpdate = useStore((s) => s.ompUpdate);
  const setAppUpdateCheckOnLaunch = useStore(
    (s) => s.setAppUpdateCheckOnLaunch,
  );
  const setOmpUpdateCheckOnLaunch = useStore(
    (s) => s.setOmpUpdateCheckOnLaunch,
  );
  const clearDismissedAppUpdate = useStore((s) => s.clearDismissedAppUpdate);
  const clearDismissedOmpUpdate = useStore((s) => s.clearDismissedOmpUpdate);
  const checkAppUpdate = useStore((s) => s.checkAppUpdate);
  const checkOmpUpdate = useStore((s) => s.checkOmpUpdate);
  const downloadOmpUpdate = useStore((s) => s.downloadOmpUpdate);
  const downloadAppUpdate = useStore((s) => s.downloadAppUpdate);

  const setAppUpdateInstallOnQuit = useStore(
    (s) => s.setAppUpdateInstallOnQuit,
  );
  const showAppUpdateDownload = useStore((s) => s.showAppUpdateDownload);
  const openAppUpdateReleaseNotes = useStore(
    (s) => s.openAppUpdateReleaseNotes,
  );

  // Clear THEN check, so the card reappears immediately if an offer stands.
  const reofferApp = (): void => {
    void clearDismissedAppUpdate().then(() => checkAppUpdate());
  };
  const reofferOmp = (): void => {
    void clearDismissedOmpUpdate().then(() => checkOmpUpdate());
  };

  return (
    <div className="space-y-3 px-4 py-3">
      <Panel className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">omp-ui</p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-mid tabular-nums">
              {appUpdate.currentVersion ?? "unversioned build"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {appStatusLine(appUpdate)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* The update card's primary action mirrored (issue #89): a check
                that answers "available" here must not require closing
                Settings to reach the corner card — and the downloaded
                follow-through finishes the install without leaving either. */}
            {appUpdate.status === "available" &&
              (appUpdate.format === "unknown" ? (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void openAppUpdateReleaseNotes()}
                >
                  View release
                </Button>
              ) : (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void downloadAppUpdate()}
                >
                  {appUpdate.format === "appimage" ||
                  appUpdate.format === "nsis" ||
                  appUpdate.format === "maczip"
                    ? "Update"
                    : "Download"}
                </Button>
              ))}
            {appUpdate.status === "downloaded" &&
              (appUpdate.format === "appimage" ||
              appUpdate.format === "nsis" ||
              appUpdate.format === "maczip" ? (
                <>
                  <AppUpdateRestartAction size="xs" />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() =>
                      void setAppUpdateInstallOnQuit(!appUpdate.installOnQuit)
                    }
                  >
                    {appUpdate.installOnQuit
                      ? "Undo install on quit"
                      : "Install when I quit"}
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void showAppUpdateDownload()}
                >
                  Show in folder
                </Button>
              ))}
            <Button
              size="xs"
              disabled={appUpdate.status === "installing"}
              onClick={() => void checkAppUpdate()}
            >
              Check now
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-mid">Check on launch</span>
          <Switch
            on={state?.appUpdateCheckOnLaunch ?? true}
            onChange={(next) => void setAppUpdateCheckOnLaunch(next)}
            label="check for omp-ui updates on launch"
          />
        </div>
        {typeof state?.dismissedAppUpdateVersion === "string" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-mid">
              Dismissed: {state.dismissedAppUpdateVersion}
            </span>
            <Button size="xs" variant="ghost" onClick={reofferApp}>
              Re-offer
            </Button>
          </div>
        )}
      </Panel>

      <Panel className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">omp binary</p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-mid tabular-nums">
              {ompUpdate.installedVersion ?? "not installed"}
            </p>
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {ompStatusLine(ompUpdate)}
            </p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {/* The same install OmpUpdateCard.tsx offers — reachable here
                because a user whose omp is missing has no card to click once
                they dismiss it. The available-update action joins it for the
                same reason (issue #89). */}
            {ompUpdate.status === "available" && (
              <Button
                size="xs"
                variant="solid"
                onClick={() => void downloadOmpUpdate()}
              >
                Update now
              </Button>
            )}
            {ompUpdate.status === "missing" && (
              <Button
                size="xs"
                variant="solid"
                onClick={() => void downloadOmpUpdate()}
              >
                Install
              </Button>
            )}
            <Button size="xs" onClick={() => void checkOmpUpdate()}>
              Check now
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-mid">Check on launch</span>
          <Switch
            on={state?.ompUpdateCheckOnLaunch ?? true}
            onChange={(next) => void setOmpUpdateCheckOnLaunch(next)}
            label="check for omp updates on launch"
          />
        </div>
        {typeof state?.dismissedOmpUpdateVersion === "string" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-mid">
              Dismissed: {state.dismissedOmpUpdateVersion}
            </span>
            <Button size="xs" variant="ghost" onClick={reofferOmp}>
              Re-offer
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}
