import { useState, type ReactNode } from "react";
import { useStore } from "../store";
import { Button, ConfirmDialog, UpdateCard } from "./ui";

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

  const restart = async (confirmed = false): Promise<void> => {
    const result = await restartForAppUpdate(confirmed);
    setConfirming(result === "confirmation-required");
  };

  return (
    <>
      <Button size={size} variant="solid" onClick={() => void restart()}>
        Restart now
      </Button>
      {confirming && (
        <ConfirmDialog
          kicker="Live sessions"
          title="Restart omp-ui now?"
          tone="copper"
          onClose={() => setConfirming(false)}
          width="w-[28rem]"
          actions={
            <>
              <Button variant="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
              <Button variant="solid" tone="copper" onClick={() => void restart(true)}>
                Restart and stop sessions
              </Button>
            </>
          }
        >
          <p className="text-sm leading-relaxed text-ink-dim">
            One or more sessions are still live. Restarting will stop their agents and apply the update.
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

  const { status, currentVersion, latestVersion, format, progress, installOnQuit, error } =
    appUpdate;
  const version = latestVersion ?? "";

  if (status === "idle" || status === "checking") return null;

  let body: ReactNode;
  if (status === "available") {
    const primary =
      format === "unknown"
        ? { label: "View release", run: () => void openAppUpdateReleaseNotes() }
        : {
            label: format === "appimage" || format === "nsis" ? "Update" : "Download",
            run: () => void downloadAppUpdate(),
          };
    body = (
      <>
        <p className="text-sm font-medium text-ink">omp-ui {version} available</p>
        <p className="mt-0.5 text-xs text-ink-dim">installed: {currentVersion}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={primary.run}>
            {primary.label}
          </Button>
          <Button variant="ghost" onClick={() => void openAppUpdateReleaseNotes()}>
            Release notes
          </Button>
          <Button variant="ghost" onClick={() => void dismissAppUpdate(version, true)}>
            Later
          </Button>
        </div>
      </>
    );
  } else if (status === "downloading") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">Downloading omp-ui {version}…</p>
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
  } else if (status === "downloaded" && (format === "appimage" || format === "nsis")) {
    body = (
      <>
        <p className="text-sm font-medium text-ink">omp-ui {version} ready</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {installOnQuit
            ? "will install when you quit — or restart now to apply immediately"
            : "restart to apply — your sessions keep running until then"}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <AppUpdateRestartAction />
          <Button
            variant="ghost"
            onClick={() => void setAppUpdateInstallOnQuit(!installOnQuit)}
          >
            {installOnQuit ? "Undo" : "Install when I quit"}
          </Button>
          <Button variant="ghost" onClick={() => void dismissAppUpdate(version, false)}>
            Later
          </Button>
        </div>
      </>
    );
  } else if (status === "downloaded") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">Downloaded omp-ui {version}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          the installer was opened — finish the install there
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void showAppUpdateDownload()}>
            Show in folder
          </Button>
          <Button variant="ghost" onClick={() => void openAppUpdateReleaseNotes()}>
            Release notes
          </Button>
          <Button variant="ghost" onClick={() => void dismissAppUpdate(version, false)}>
            Dismiss
          </Button>
        </div>
      </>
    );
  } else {
    // The shared shell auto-dismisses up-to-date/disabled; errors stay sticky.
    const title =
      status === "up-to-date"
        ? `omp-ui is up to date (${currentVersion})`
        : status === "disabled"
          ? "Update checks are disabled in this build"
          : error === "could not reach GitHub"
            ? "Update check failed"
            : "Download failed";
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
      dismissLabel={offered ? `dismiss omp-ui ${version} update` : onDismiss ? "dismiss" : undefined}
      onDismiss={onDismiss}
      autoDismissMs={transient ? 5000 : undefined}
    >
      {body}
    </UpdateCard>
  );
}
