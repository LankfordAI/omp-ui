import type { RoutineRunRow } from "@omp-ui/core/routine";
import { cn } from "../../lib/cn";
import { relativeTime } from "../../lib/format";
import { useT } from "../../lib/i18n";
import { findRecord, useStore } from "../../store";
import { Button, Chip } from "../ui";
import { OUTCOME_LABEL, OUTCOME_TONE, REASON_LABEL } from "./routine-format";

/**
 * One routine's run history (ADR-0100): routine-runs.json is the sole audit
 * log, fixed strings only. A row whose session still exists opens it; a
 * pruned or never-started run says so instead of offering a dead link.
 */
export function RunHistoryList({ runs, onOpen }: { runs: readonly RoutineRunRow[]; onOpen: () => void }) {
  const t = useT();
  const openSession = useStore((s) => s.openSession);
  const state = useStore((s) => s.state);
  if (runs.length === 0) return <p className="text-xs text-ink-faint">{t("routines.history.empty")}</p>;
  return (
    <ul data-run-history className="divide-y divide-line-soft rounded-lg border border-line bg-raised">
      {runs.map((run) => {
        const reachable = run.tabId !== null && !run.pruned && findRecord(state, run.tabId) !== undefined;
        const waiting = run.outcome === "waiting-approval";
        return (
          <li
            key={run.id}
            data-run-row={run.outcome}
            className={cn("flex flex-wrap items-center gap-2 px-3 py-2 text-xs", waiting && "bg-copper-wash/40")}
          >
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <Chip tone={OUTCOME_TONE[run.outcome]}>{t(OUTCOME_LABEL[run.outcome])}</Chip>
                {run.trigger === "manual" && <Chip>{t("routines.history.manual")}</Chip>}
                {run.trigger === "late" && run.missed > 0 && (
                  <span className="text-ink-faint">{t("routines.history.missed", { n: run.missed })}</span>
                )}
                <span className="tabular-nums text-ink-faint">{relativeTime(new Date(run.firedAtMs).toISOString())}</span>
                {run.pruned && <span className="text-ink-faint">· {t("routines.history.pruned")}</span>}
              </div>
              {run.reasonCode !== null && <p className="text-ink-mid">{t(REASON_LABEL[run.reasonCode])}</p>}
              {run.staleCatalog && <p className="text-copper">{t("routines.policy.staleCatalog")}</p>}
            </div>
            {reachable ? (
              <Button
                size="xs"
                variant={waiting ? "solid" : "ghost"}
                tone={waiting ? "copper" : "neutral"}
                onClick={() => {
                  void openSession(run.tabId!);
                  onOpen();
                }}
              >
                {waiting ? t("routines.reviewApproval") : t("routines.history.open")}
              </Button>
            ) : (
              <span className="px-2 text-ink-faint">{t("routines.history.noSession")}</span>
            )}
          </li>
        );
      })}
    </ul>
  );
}
