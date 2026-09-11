import { useState, type ReactNode } from "react";
import { useStore } from "../store";
import { Button, ConfirmDialog, UpdateCard } from "./ui";
import { useT } from "../lib/i18n";

/**
 * The update card (issue #18): a small non-modal card in the lower-right
 * corner announcing an omp-ui release — versions, the package-appropriate
 * update action, release notes, Later. Lower-right because the top-right
 * belongs to the native title-bar overlay controls; z-40 sits between the
 * modal (z-30) and context menus (z-50).
 *
 * Renders nothing for idle/checking — background failures stay silent by
 * design. No `signal` tokens: ADR-0004 reserves signal for agent liveness.
 */
/** Shared restart action used by both update surfaces. */
export function AppUpdateRestartAction({ size }: { size?: "xs" }) {
  const restartForAppUpdate = useStore((s) => s.restartForAppUpdate);
  const [confirming, setConfirming] = useState(false);
  const t = useT();

  const restart = async (confirmed = false): Promise<void> => {
    const result = await restartForAppUpdate(confirmed);
    setConfirming(result === "confirmation-required");
  };

  return (
    <>
      <Button size={size} variant="solid" onClick={() => void restart()}>
        {t("update.app.restartNow")}
      </Button>
      {confirming && (
        <ConfirmDialog
          kicker={t("update.app.restartKicker")}
          title={t("update.app.restartTitle")}
          tone="copper"
          onClose={() => setConfirming(false)}
          width="w-[28rem]"
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                {t("update.app.cancel")}
              </Button>
              <Button variant="solid" tone="copper" onClick={() => void restart(true)}>
                {t("update.app.restartAndStop")}
              </Button>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-ink-dim">
            {t("update.app.restartBody")}
          </p>
        </ConfirmDialog>
      )}
    </>
  );
}

export function AppUpdateCard() {
  const appUpdate = useStore((s) => s.appUpdate);
  const downloadAppUpdate = useStore((s) => s.downloadAppUpdate);
  const openAppUpdateReleaseNotes = useStore((s) => s.openAppUpdateReleaseNotes);
  const showAppUpdateDownload = useStore((s) => s.showAppUpdateDownload);
  const setAppUpdateInstallOnQuit = useStore((s) => s.setAppUpdateInstallOnQuit);
  const dismissAppUpdate = useStore((s) => s.dismissAppUpdate);
  const t = useT();

  const { status, currentVersion, latestVersion, format, progress, installOnQuit, error } =
    appUpdate;
  const version = latestVersion ?? "";

  if (status === "idle" || status === "checking") return null;

  let body: ReactNode;
  if (status === "available") {
    const primary =
      format === "unknown"
        ? { label: t("update.app.viewRelease"), run: () => void openAppUpdateReleaseNotes() }
        : {
            label:
              format === "appimage" || format === "nsis" || format === "maczip"
                ? t("update.app.update")
                : t("update.app.download"),
            run: () => void downloadAppUpdate(),
          };
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.app.available", { version })}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {t("update.app.installedVersion", { version: currentVersion ?? "" })}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={primary.run}>
            {primary.label}
          </Button>
          <Button variant="ghost" onClick={() => void openAppUpdateReleaseNotes()}>
            {t("update.app.releaseNotes")}
          </Button>
          <Button variant="ghost" onClick={() => void dismissAppUpdate(version, true)}>
            {t("update.app.later")}
          </Button>
        </div>
      </>
    );
  } else if (status === "downloading") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.app.downloading", { version })}</p>
        <div className="mt-2.5 h-1 rounded bg-raised">
          {progress === null ? (
            <div className="h-1 w-full animate-pulse rounded bg-iris" />
          ) : (
            <div className="h-1 rounded bg-iris" style={{ width: `${progress}%` }} />
          )}
        </div>
        {progress !== null && (
          <p className="mt-1.5 text-[11px] tabular-nums text-ink-dim">{progress}%</p>
        )}
      </>
    );
  } else if (status === "installing") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.app.installing", { version })}</p>
        <div className="mt-2.5 h-1 rounded bg-raised">
          <div className="h-1 w-full animate-pulse rounded bg-iris" />
        </div>
        <p className="mt-2 text-xs text-ink-dim">
          {format === "maczip"
            ? t("update.app.installingMac")
            : t("update.app.installingRestart")}
        </p>
      </>
    );
  } else if (status === "downloaded" && (format === "appimage" || format === "nsis" || format === "maczip")) {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.app.ready", { version })}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {installOnQuit
            ? t("update.app.readyInstallOnQuit")
            : t("update.app.readyRestart")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <AppUpdateRestartAction />
          <Button
            variant="ghost"
            onClick={() => void setAppUpdateInstallOnQuit(!installOnQuit)}
          >
            {installOnQuit ? t("update.app.undo") : t("update.app.installOnQuit")}
          </Button>
          <Button variant="ghost" onClick={() => void dismissAppUpdate(version, false)}>
            {t("update.app.later")}
          </Button>
        </div>
      </>
    );
  } else if (status === "downloaded") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.app.downloaded", { version })}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {t("update.app.downloadedHint")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void showAppUpdateDownload()}>
            {t("update.app.showInFolder")}
          </Button>
          <Button variant="ghost" onClick={() => void openAppUpdateReleaseNotes()}>
            {t("update.app.releaseNotes")}
          </Button>
          <Button variant="ghost" onClick={() => void dismissAppUpdate(version, false)}>
            {t("update.app.dismiss")}
          </Button>
        </div>
      </>
    );
  } else {
    // The shared shell auto-dismisses up-to-date/disabled; errors stay sticky.
    const title =
      status === "up-to-date"
        ? t("update.app.upToDate", { version: currentVersion ?? "" })
        : status === "disabled"
          ? t("update.app.disabled")
          : error === "could not reach GitHub"
            ? t("update.app.checkFailed")
            : t("update.app.failed");
    body = (
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {status === "error" && error !== null && (
          <p className="mt-0.5 break-words text-xs text-ink-dim">{error}</p>
        )}
      </div>
    );
  }

  const offered = status === "available";
  const transient = status === "up-to-date" || status === "disabled";
  const onDismiss = offered
    ? () => void dismissAppUpdate(version, true)
    : transient || status === "error"
      ? () => void dismissAppUpdate("", false)
      : undefined;

  return (
    <UpdateCard
      dismissLabel={
        offered ? t("update.app.dismissLabel", { version }) : onDismiss ? t("update.card.dismiss") : undefined
      }
      onDismiss={onDismiss}
      autoDismissMs={transient ? 5000 : undefined}
    >
      {body}
    </UpdateCard>
  );
}
