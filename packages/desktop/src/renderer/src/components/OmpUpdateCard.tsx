import type { ReactNode } from "react";
import { MIN_SUPPORTED_OMP } from "@omp-ui/core/harness-floor";
import { useStore } from "../store";
import { Button, UpdateCard } from "./ui";

/**
 * The omp binary install/update card (issue #19): a small non-modal card
 * announcing a newer omp release — or, when no omp is installed at all, an
 * install offer. Same corner-stack pattern as the app update card (App.tsx
 * owns the positioning); renders nothing for idle/checking so background
 * failures stay silent by design. No `signal` tokens: ADR-0004 reserves
 * signal for agent liveness. Below the harness floor the copy switches to
 * required-must language: this is a requirement, not an offer, and a "Later"
 * here is transient.
 */
export function OmpUpdateCard() {
  const ompUpdate = useStore((s) => s.ompUpdate);
  const downloadOmpUpdate = useStore((s) => s.downloadOmpUpdate);
  const dismissOmpUpdate = useStore((s) => s.dismissOmpUpdate);

  const { status, installedVersion, latestVersion, progress, error, belowMinimum } = ompUpdate;
  const version = latestVersion ?? "";
  // A below-floor "Later" must never persist: the requirement returns next check.
  const dismissOfferedVersion = () => void dismissOmpUpdate(version, !belowMinimum);

  if (status === "idle" || status === "checking") return null;

  let body: ReactNode;
  if (status === "available") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">
          {belowMinimum
            ? `omp-ui needs omp ${MIN_SUPPORTED_OMP} or later`
            : `omp ${version} available`}
        </p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {`installed: ${installedVersion ?? ""}`}
        </p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {belowMinimum ? "some features are disabled until it's upgraded" : "new sessions will use it — running sessions keep their version"}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void downloadOmpUpdate()}>
            Update now
          </Button>
          <Button variant="ghost" onClick={dismissOfferedVersion}>
            Later
          </Button>
        </div>
      </>
    );
  } else if (status === "missing") {
    // An install offer, not an update — never the word "update" here.
    body = (
      <>
        <p className="text-sm font-medium text-ink">omp is not installed</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          new sessions can't run until omp-ui installs its managed copy
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void downloadOmpUpdate()}>
            Install
          </Button>
          <Button variant="ghost" onClick={dismissOfferedVersion}>
            Later
          </Button>
        </div>
      </>
    );
  } else if (status === "downloading") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">
          {belowMinimum
            ? `omp-ui needs omp ${MIN_SUPPORTED_OMP} or later`
            : `Installing omp ${version}…`}
        </p>
        <div className="mt-2.5 h-1 rounded bg-raised">
          {progress === null ? (
            <div className="h-1 w-full animate-pulse rounded bg-iris" />
          ) : (
            <div className="h-1 rounded bg-iris" style={{ width: `${progress}%` }} />
          )}
        </div>
        {progress !== null && (
          <p className="mt-1.5 text-xs tabular-nums text-ink-dim">{progress}%</p>
        )}
      </>
    );
  } else if (status === "installed") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{`omp ${version} installed`}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          new sessions will use it — running sessions are unaffected
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="ghost" onClick={() => void dismissOmpUpdate(version, false)}>
            Dismiss
          </Button>
        </div>
      </>
    );
  } else {
    // The shared shell auto-dismisses up-to-date; errors stay sticky.
    const title =
      belowMinimum && status === "error"
        ? `omp-ui needs omp ${MIN_SUPPORTED_OMP} or later`
        : status === "up-to-date"
          ? `omp is up to date (${installedVersion ?? ""})`
          : error?.kind === "unreachable"
            ? "Update check failed"
            : "Install failed";
    body = (
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {status === "error" && error !== null && (
          <p className="mt-0.5 break-words text-xs text-ink-dim">{error.message}</p>
        )}
      </div>
    );
  }

  const offered = status === "available" || status === "missing";
  const transient = status === "up-to-date";
  const onDismiss = offered
    ? dismissOfferedVersion
    : transient || status === "error"
      ? () => void dismissOmpUpdate("", false)
      : undefined;

  return (
    <UpdateCard
      dismissLabel={
        offered ? `dismiss omp ${version} offer` : onDismiss ? "dismiss" : undefined
      }
      onDismiss={onDismiss}
      autoDismissMs={transient ? 5000 : undefined}
    >
      {body}
    </UpdateCard>
  );
}
