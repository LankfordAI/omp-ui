import type { ReactNode } from "react";
import { useStore } from "../store";
import { Button, UpdateCard } from "./ui";
import { useT } from "../lib/i18n";

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
  const t = useT();

  const { status, installedVersion, latestVersion, progress, error } = ompUpdate;
  const version = latestVersion ?? "";
  const dismissOfferedVersion = () => void dismissOmpUpdate(version, true);

  if (status === "idle" || status === "checking") return null;

  let body: ReactNode;
  if (status === "available") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.omp.available", { version })}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {t("update.omp.installedVersion", { version: installedVersion ?? "" })}
        </p>
        <p className="mt-0.5 text-xs text-ink-dim">{t("update.omp.availableHint")}</p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void downloadOmpUpdate()}>
            {t("update.omp.updateNow")}
          </Button>
          <Button variant="ghost" onClick={dismissOfferedVersion}>
            {t("update.omp.later")}
          </Button>
        </div>
      </>
    );
  } else if (status === "missing") {
    // An install offer, not an update — never the word "update" here.
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.omp.notInstalled")}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {t("update.omp.notInstalledHint")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="solid" onClick={() => void downloadOmpUpdate()}>
            {t("update.omp.install")}
          </Button>
          <Button variant="ghost" onClick={dismissOfferedVersion}>
            {t("update.omp.later")}
          </Button>
        </div>
      </>
    );
  } else if (status === "downloading") {
    body = (
      <>
        <p className="text-sm font-medium text-ink">{t("update.omp.installing", { version })}</p>
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
        <p className="text-sm font-medium text-ink">{t("update.omp.installed", { version })}</p>
        <p className="mt-0.5 text-xs text-ink-dim">
          {t("update.omp.installedHint")}
        </p>
        <div className="mt-3 flex items-center gap-2">
          <Button variant="ghost" onClick={() => void dismissOmpUpdate(version, false)}>
            {t("update.omp.dismiss")}
          </Button>
        </div>
      </>
    );
  } else {
    // The shared shell auto-dismisses up-to-date; errors stay sticky.
    const title =
      status === "up-to-date"
        ? t("update.omp.upToDate", { version: installedVersion ?? "" })
        : error === "could not reach the omp release registry"
          ? t("update.omp.checkFailed")
          : t("update.omp.installFailed");
    body = (
      <div className="min-w-0">
        <p className="text-sm font-medium text-ink">{title}</p>
        {status === "error" && error !== null && (
          <p className="mt-0.5 break-words text-xs text-ink-dim">{error}</p>
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
        offered ? t("update.omp.dismissLabel", { version }) : onDismiss ? t("update.card.dismiss") : undefined
      }
      onDismiss={onDismiss}
      autoDismissMs={transient ? 5000 : undefined}
    >
      {body}
    </UpdateCard>
  );
}
