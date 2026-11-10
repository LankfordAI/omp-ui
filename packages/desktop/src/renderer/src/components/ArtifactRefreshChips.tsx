import type { ArtifactRefreshEntry } from "@omp-ui/core/artifacts";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { Chip, IconButton, IconClose } from "./ui";

/**
 * Pending artifact refresh requests (ADR-0092): structural chips, not prose.
 * Each rides the prompt wire as a leading `<artifact refresh>` block; the
 * remove button drops the entry from the draft before send.
 */
export function ArtifactRefreshChips({ refreshes, onRemove, disabled = false, align = "start", className }: {
  refreshes: readonly ArtifactRefreshEntry[];
  onRemove?: (refreshRequestId: string) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const t = useT();
  return <div role="group" aria-label={t("artifacts.refreshRequested")} className={cn("flex max-w-full flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start", className)}>
    {refreshes.map(entry => {
      const label = t("artifacts.refreshChip", { title: entry.title });
      // The wire identities stay inspectable for audit: the request id and
      // the dataset ids are what the block will carry.
      const audit = `${label} — request ${entry.refreshRequestId}; datasets ${entry.datasetIds.join(", ")}`;
      return <Chip key={entry.refreshRequestId} tone="copper" className="min-w-0 max-w-full" aria-label={label} title={audit}>
        <span aria-hidden className="shrink-0">↻</span>
        <span className="min-w-0 max-w-[24rem] truncate">{entry.title}</span>
        {entry.datasetIds.length > 1 && <span className="shrink-0 text-ink-dim">({entry.datasetIds.length})</span>}
        {onRemove !== undefined && <IconButton label={t("artifacts.refreshRemove", { title: entry.title })} disabled={disabled} tone="rose" onClick={() => onRemove(entry.refreshRequestId)} className="size-4 rounded-full border border-line-strong bg-overlay"><IconClose /></IconButton>}
      </Chip>;
    })}
  </div>;
}
