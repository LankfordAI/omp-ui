import type { AppUpdateState, OmpUpdateState } from "@omp-ui/core/types";
import { useStore } from "../../store";
import { AppUpdateRestartAction } from "../AppUpdateCard";
import { Button, Panel, Switch } from "../ui";
import { t, useT } from "../../lib/i18n";

function appStatusLine(u: AppUpdateState): string {
  switch (u.status) {
    case "available":
      return t("settings.updates.available", {
        version: u.latestVersion ?? t("settings.updates.newerRelease"),
      });
    case "downloading":
      return t("settings.updates.downloading", {
        version: u.latestVersion ?? "",
      });
    case "downloaded":
      return t("settings.updates.downloaded", {
        version: u.latestVersion ?? t("settings.updates.update"),
      }) + (u.installOnQuit ? t("settings.updates.installsOnQuit") : "");
    case "installing":
      return t("settings.updates.applying", {
        version: u.latestVersion ?? t("settings.updates.update"),
      });
    case "up-to-date":
      return t("settings.updates.upToDate");
    case "checking":
      return t("settings.updates.checking");
    case "disabled":
      return t("settings.updates.appChecksDisabled");
    case "error":
      return u.error ?? t("settings.updates.checkFailed");
    default:
      return t("settings.updates.noCheckYet");
  }
}

function ompStatusLine(u: OmpUpdateState): string {
  switch (u.status) {
    case "missing":
      return t("settings.updates.notInstalled");
    case "available":
      return t("settings.updates.available", {
        version: u.latestVersion ?? t("settings.updates.newerRelease"),
      });
    case "downloading":
      return t("settings.updates.installing", {
        version: u.latestVersion ?? "",
      });
    case "installed":
      return t("settings.updates.installed", {
        version: u.latestVersion ?? t("settings.updates.update"),
      });
    case "up-to-date":
      return t("settings.updates.upToDate");
    case "checking":
      return t("settings.updates.checking");
    case "error":
      return u.error ?? t("settings.updates.checkFailed");
    default:
      return t("settings.updates.noCheckYet");
  }
}

export function UpdatesPage() {
  const t = useT();
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
              {appUpdate.currentVersion ?? t("settings.updates.unversionedBuild")}
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
                  {t("settings.updates.viewRelease")}
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
                    ? t("settings.updates.updateAction")
                    : t("settings.updates.download")}
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
                      ? t("settings.updates.undoInstallOnQuit")
                      : t("settings.updates.installOnQuit")}
                  </Button>
                </>
              ) : (
                <Button
                  size="xs"
                  variant="solid"
                  onClick={() => void showAppUpdateDownload()}
                >
                  {t("settings.updates.showInFolder")}
                </Button>
              ))}
            <Button
              size="xs"
              disabled={appUpdate.status === "installing"}
              onClick={() => void checkAppUpdate()}
            >
              {t("settings.updates.checkNow")}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-mid">{t("settings.updates.checkOnLaunch")}</span>
          <Switch
            on={state?.appUpdateCheckOnLaunch ?? true}
            onChange={(next) => void setAppUpdateCheckOnLaunch(next)}
            label={t("settings.updates.checkAppOnLaunchLabel")}
          />
        </div>
        {typeof state?.dismissedAppUpdateVersion === "string" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-mid">
              {t("settings.updates.dismissed", {
                version: state.dismissedAppUpdateVersion,
              })}
            </span>
            <Button size="xs" variant="ghost" onClick={reofferApp}>
              {t("settings.updates.reoffer")}
            </Button>
          </div>
        )}
      </Panel>

      <Panel className="px-4 py-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-xs font-medium text-ink">{t("settings.updates.ompBinary")}</p>
            <p className="mt-0.5 font-mono text-[11px] text-ink-mid tabular-nums">
              {ompUpdate.installedVersion ?? t("settings.updates.notInstalled")}
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
                {t("settings.updates.updateNow")}
              </Button>
            )}
            {ompUpdate.status === "missing" && (
              <Button
                size="xs"
                variant="solid"
                onClick={() => void downloadOmpUpdate()}
              >
                {t("settings.updates.install")}
              </Button>
            )}
            <Button size="xs" onClick={() => void checkOmpUpdate()}>
              {t("settings.updates.checkNow")}
            </Button>
          </div>
        </div>
        <div className="mt-3 flex items-center justify-between gap-3">
          <span className="text-xs text-ink-mid">{t("settings.updates.checkOnLaunch")}</span>
          <Switch
            on={state?.ompUpdateCheckOnLaunch ?? true}
            onChange={(next) => void setOmpUpdateCheckOnLaunch(next)}
            label={t("settings.updates.checkOmpOnLaunchLabel")}
          />
        </div>
        {typeof state?.dismissedOmpUpdateVersion === "string" && (
          <div className="mt-2 flex items-center justify-between gap-3">
            <span className="text-xs text-ink-mid">
              {t("settings.updates.dismissed", {
                version: state.dismissedOmpUpdateVersion,
              })}
            </span>
            <Button size="xs" variant="ghost" onClick={reofferOmp}>
              {t("settings.updates.reoffer")}
            </Button>
          </div>
        )}
      </Panel>
    </div>
  );
}

export function UpdatesFooter() {
  const t = useT();
  // Auto-download is deliberately absent: both download paths end in an
  // installer launch or an app restart.
  return <p>{t("settings.updates.footnote")}</p>;
}
