import { useEffect, useState } from "react";
import type { HostUpdateState } from "@omp-ui/core/types";
import { backend, displayMessage } from "../backend";
import { t, useT, type MessageKey } from "../lib/i18n";
import { useStore } from "../store";
import { Button, Panel } from "./ui";

/**
 * The persistent host's own update (issue #442 §10.2), one Settings panel shown to every client:
 * a browser sees this and nothing about the desktop artifact, a desktop client sees both. The
 * state is the host's, read from `BackendState.hostUpdate`, and every action is a host request —
 * apply/defer policy lives there, so this card only names what the host will do and when.
 */

/** Ticks once a second while a countdown deadline is armed so the remaining time reads live. */
function useRemainingMs(deadlineMs: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadlineMs === null) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [deadlineMs]);
  return deadlineMs === null ? null : Math.max(0, deadlineMs - now);
}

const LAST_ATTEMPT_KEY = {
  applied: "update.host.lastApplied",
  "rolled-back": "update.host.lastRolledBack",
  failed: "update.host.lastFailed",
} as const satisfies Record<NonNullable<HostUpdateState["lastAttempt"]>["outcome"], MessageKey>;

function formatRemaining(ms: number): string {
  const total = Math.ceil(ms / 1_000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function statusLine(u: HostUpdateState, remainingMs: number | null): string {
  const latest = u.latestVersion ?? "";
  const staged = u.stagedVersion ?? latest;
  switch (u.status) {
    case "idle":
      return u.latestVersion !== null && u.latestVersion === u.currentVersion
        ? t("update.host.upToDate")
        : t("update.host.noCheckYet");
    case "checking":
      return t("update.host.checking");
    case "available":
      return t("update.host.available", { version: latest });
    case "downloading":
      return t("update.host.downloading", { version: latest });
    case "staged":
      return t("update.host.staged", { version: staged });
    case "countdown":
      return t("update.host.countdown", {
        version: staged,
        remaining: formatRemaining(remainingMs ?? 0),
      });
    case "applying":
      return t("update.host.applying", { version: staged });
    case "error":
      return t("update.host.failed");
  }
}

export function HostUpdateCard() {
  // Subscribes this card to locale changes; `t` itself is the module function.
  useT();
  const u = useStore((s) => s.state?.hostUpdate ?? null);
  const hostVersion = useStore((s) => s.state?.hostVersion ?? "");
  const hostProtocol = useStore((s) => s.state?.hostProtocol ?? 0);
  const reportError = useStore((s) => s.reportError);
  const remainingMs = useRemainingMs(u?.graceDeadlineMs ?? null);
  const [busy, setBusy] = useState(false);

  if (u === null) return null;

  const run = (action: () => Promise<unknown>): void => {
    if (busy) return;
    setBusy(true);
    action()
      .catch((err: unknown) => reportError(new Error(displayMessage(err))))
      .finally(() => setBusy(false));
  };

  const inFlight = u.status === "checking" || u.status === "downloading" || u.status === "applying";
  const canApply = u.status === "staged" || u.status === "countdown";
  const canDefer = u.status === "countdown" && u.deferrals < u.deferralLimit;
  const lastAttempt = u.lastAttempt;

  return (
    <Panel className="px-4 py-3">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-xs font-medium text-ink">{t("update.host.title")}</p>
          <p className="mt-0.5 font-mono text-[11px] text-ink-mid tabular-nums">
            {t("update.host.version", { version: hostVersion, protocol: hostProtocol })}
          </p>
          <p className="mt-0.5 text-[11px] text-ink-dim">{statusLine(u, remainingMs)}</p>
          {u.status === "countdown" && (
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {t("update.host.countdownDetail", {
                sessions: u.affectedTabIds.length,
                deferrals: u.deferrals,
                limit: u.deferralLimit,
              })}
            </p>
          )}
          {u.currentIsStaged && (
            <p className="mt-0.5 text-[11px] text-ink-dim">{t("update.host.currentIsStaged")}</p>
          )}
          {u.status === "error" && u.error !== null && (
            <p className="mt-0.5 break-words text-[11px] text-rose">{u.error}</p>
          )}
          {lastAttempt !== null && (
            <p className="mt-0.5 text-[11px] text-ink-dim">
              {t(LAST_ATTEMPT_KEY[lastAttempt.outcome], {
                from: lastAttempt.fromVersion,
                to: lastAttempt.toVersion,
              })}
            </p>
          )}
          {u.status === "downloading" && (
            <div className="mt-2 h-1 w-48 rounded bg-raised">
              {u.progress === null ? (
                <div className="h-1 w-full animate-pulse rounded bg-iris" />
              ) : (
                <div className="h-1 rounded bg-iris" style={{ width: `${u.progress}%` }} />
              )}
            </div>
          )}
        </div>
        <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
          {u.status === "available" && (
            <Button size="xs" variant="solid" disabled={busy} onClick={() => run(() => backend.downloadHostUpdate())}>
              {t("update.host.download")}
            </Button>
          )}
          {canApply && (
            <Button size="xs" variant="solid" disabled={busy} onClick={() => run(() => backend.applyHostUpdate())}>
              {t("update.host.applyNow")}
            </Button>
          )}
          {u.status === "countdown" && (
            <Button size="xs" disabled={busy || !canDefer} onClick={() => run(() => backend.deferHostUpdate())}>
              {t("update.host.defer")}
            </Button>
          )}
          {u.rollbackVersion !== null && !inFlight && (
            <Button size="xs" variant="ghost" disabled={busy} onClick={() => run(() => backend.rollbackHostUpdate())}>
              {t("update.host.rollback", { version: u.rollbackVersion })}
            </Button>
          )}
          <Button size="xs" disabled={busy || inFlight} onClick={() => run(() => backend.checkHostUpdate())}>
            {t("update.host.check")}
          </Button>
        </div>
      </div>
    </Panel>
  );
}
