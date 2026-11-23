import type { RoutineDryRunResult } from "@omp-ui/core/routine";
import { Button } from "../ui";
import { formatTimeout, formatUsd, formatWhen } from "./routine-format";

const HOOK_PHASE_LABEL = {
  pre: "Run shell before starting",
  post: "Run shell after the run ends",
} as const;

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
  const entries = Object.entries(result.compiled.overlayEntries);
  const allowed = entries.filter(([, d]) => d === "allow").map(([k]) => k);
  const prompted = entries.filter(([, d]) => d === "prompt").map(([k]) => k);
  const denied = entries.filter(([, d]) => d === "deny").map(([k]) => k);
  const columns = [
    { title: "Auto-allowed", keys: allowed, tone: "text-signal" },
    { title: "Will pause on Approval card", keys: prompted, tone: "text-copper" },
    { title: "Hard denied", keys: denied, tone: "text-rose" },
  ];
  return (
    <div className="studio-card space-y-2.5 rounded-xl border-iris-dim/80 px-4 py-3 text-xs">
      <div data-dry-run className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="font-semibold text-ink">Dry run preview</p>
          <p className="mt-0.5 break-words text-ink-mid">
            {`${projectName} · ${modelLabel} · next ${result.nextFireAtMs === null ? "Paused" : formatWhen(result.nextFireAtMs)} · timeout ${formatTimeout(result.timeoutMinutes)} · warn ${result.warnCostUsd === 0 ? "no cap" : formatUsd(result.warnCostUsd)} · stop ${result.maxCostUsd === 0 ? "no cap" : formatUsd(result.maxCostUsd)} · no session started`}
          </p>
        </div>
        <Button size="xs" variant="ghost" onClick={onDismiss}>
          Dismiss
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
          Added after last review: <span className="font-mono">{result.compiled.addedLater.join(", ")}</span>
        </p>
      )}
      {result.compiled.warnings.map((warning) => (
        <p key={warning} className="break-words text-ink-mid">
          {warning}
        </p>
      ))}
      {(["pre", "post"] as const).map((phase) => {
        // Render each phase independently: one guard for both would hide a
        // post-only routine's hook (#1283).
        const command = phase === "pre" ? result.scripts.pre : result.scripts.post;
        if (command === "") return null;
        return (
          <div key={phase} data-dry-run-hook={phase} className="rounded-lg border border-copper-dim bg-copper-wash/40 px-2.5 py-2">
            <p className="text-copper">{HOOK_PHASE_LABEL[phase]}</p>
            <pre className="mt-1 overflow-auto font-mono text-[11px] leading-relaxed text-ink-mid">{command}</pre>
            <p className="mt-1 text-[11px] text-ink-faint">listed only — Dry run never runs hooks</p>
          </div>
        );
      })}
    </div>
  );
}
