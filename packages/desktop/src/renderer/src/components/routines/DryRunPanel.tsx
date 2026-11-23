import type { RoutineDryRunResult } from "@omp-ui/core/routine";
import { useT } from "../../lib/i18n";
import { Button } from "../ui";
import { formatUsd, formatWhen } from "./routine-format";

/**
 * The Dry run preview (ADR-0100 §11.1): the exact fire-time compile over the
 * live catalog, as main returned it. Main writes nothing and starts no
 * session for a dry run; this panel only renders the result.
 */
export function DryRunPanel({
  result,
  projectName,
  modelLabel,
  onDismiss,
}: {
  result: RoutineDryRunResult;
  projectName: string;
  modelLabel: string;
  onDismiss: () => void;
}) {
  const t = useT();
  const entries = Object.entries(result.compiled.overlayEntries);
  const allowed = entries.filter(([, d]) => d === "allow").map(([k]) => k);
  const prompted = entries.filter(([, d]) => d === "prompt").map(([k]) => k);
  const denied = entries.filter(([, d]) => d === "deny").map(([k]) => k);
  const columns = [
    { title: t("routines.dryRun.autoAllowed"), keys: allowed, tone: "text-signal" },
    { title: t("routines.dryRun.willPause"), keys: prompted, tone: "text-copper" },
    { title: t("routines.dryRun.hardDenied"), keys: denied, tone: "text-rose" },
  ];
  return (
    <div className="studio-card space-y-2.5 rounded-xl border-iris-dim/80 px-4 py-3 text-xs">
      <div data-dry-run className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">{t("routines.dryRun.title")}</p>
          <p className="mt-0.5 break-words text-ink-mid">
            {t("routines.dryRun.summary", {
              project: projectName,
              model: modelLabel,
              next: result.nextFireAtMs === null ? t("routines.paused") : formatWhen(result.nextFireAtMs),
              warn: result.warnCostUsd === 0 ? t("routines.noCap") : formatUsd(result.warnCostUsd),
              max: result.maxCostUsd === 0 ? t("routines.noCap") : formatUsd(result.maxCostUsd),
            })}
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          {t("routines.dismiss")}
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {columns.map((col) => (
          <div key={col.title} className="min-w-0 rounded-lg border border-line-soft bg-raised/70 p-2.5">
            <p className={`font-medium ${col.tone}`}>
              {col.title} ({col.keys.length})
            </p>
            <p className="mt-1 break-words font-mono text-ink-mid">{col.keys.join(", ") || "—"}</p>
          </div>
        ))}
      </div>
      {result.compiled.addedLater.length > 0 && (
        <p className="break-words text-copper">
          {t("routines.dryRun.addedSinceReview")}: <span className="font-mono">{result.compiled.addedLater.join(", ")}</span>
        </p>
      )}
      {result.compiled.warnings.map((warning) => (
        <p key={warning} className="break-words text-ink-mid">
          {warning}
        </p>
      ))}
    </div>
  );
}
