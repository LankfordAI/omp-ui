import { useEffect, type ReactNode } from "react";
import { useStore } from "../store";
import { Button, IconButton } from "./ui";

/**
 * The omp binary install/update card (issue #19): a small non-modal card
 * announcing a newer omp release — or, when no omp is installed at all, an
 * install offer. Same corner-stack pattern as the app update card (App.tsx
 * owns the positioning); renders nothing for idle/checking so background
 * failures stay silent by design. No `signal` tokens: ADR-0004 reserves
 * signal for agent liveness.
 */
export function OmpUpdateCard() {
  const ompUpdate = useStore((s) => s.ompUpdate);
  const downloadOmpUpdate = useStore((s) => s.downloadOmpUpdate);
  const dismissOmpUpdate = useStore((s) => s.dismissOmpUpdate);

  const { status, installedVersion, latestVersion, progress, error } = ompUpdate;
  const version = latestVersion ?? "";

  // Transient answers to a manual check clear themselves (the TerminalTab
  // note-pill idiom); sticky states wait for an explicit click.
  useEffect(() => {
    if (status !== "up-to-date") return;
    const timer = window.setTimeout(() => void dismissOmpUpdate("", false), 5000);
    return () => window.clearTimeout(timer);
  }, [status, dismissOmpUpdate]);

  if (status === "idle" || status === "checking") return null;

  const close = (
    <IconButton label="dismiss" onClick={() => void dismissOmpUpdate("", false)}>
      <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.6} className="size-2.5">
        <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
      </svg>
    </IconButton>
  );

  let body: ReactNode;
  if (status === "available") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">omp {version} available</p>
        <p className="mt-0.5 text-xs text-ink-dim">installed: {installedVersion}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          new sessions will use it — running sessions keep their version
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void downloadOmpUpdate()}>
            Update now
          </Button>
          <Button variant="ghost" onClick={() => void dismissOmpUpdate(version, true)}>
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
          new sessions can&apos;t run until omp-ui installs its managed copy
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void downloadOmpUpdate()}>
            Install
          </Button>
          <Button variant="ghost" onClick={() => void dismissOmpUpdate(version, true)}>
            Later
          </Button>
        </div>
      </>
    );
  } else if (status === "downloading") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">Installing omp {version}…</p>
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
  } else if (status === "installed") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">omp {version} installed</p>
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
    // up-to-date / error: a single line plus the ✕. up-to-date auto-dismisses
    // via the effect above; an error is sticky.
    const title =
      status === "up-to-date"
        ? `omp is up to date (${installedVersion})`
        : error === "could not reach the omp release registry"
          ? "Update check failed"
          : "Install failed";
    body = (
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-medium text-ink">{title}</p>
          {status === "error" && error !== null && (
            <p className="mt-0.5 break-words text-xs text-ink-dim">{error}</p>
          )}
        </div>
        {close}
      </div>
    );
  }

  return (
    <div className="edge-lit animate-rise rounded-xl border border-line-strong bg-overlay p-4 shadow-lg">
      {body}
    </div>
  );
}
