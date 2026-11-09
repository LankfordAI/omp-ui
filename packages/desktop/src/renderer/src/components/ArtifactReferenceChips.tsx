import type { ArtifactReference } from "@omp-ui/core/artifacts";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { Chip, IconButton, IconClose } from "./ui";

export function ArtifactReferenceChips({ references, onRemove, disabled = false, align = "start", className }: {
  references: readonly ArtifactReference[];
  onRemove?: (referenceId: string) => void;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const t = useT();
  return <div role="group" aria-label={t("artifacts.reference.chips")} className={cn("flex max-w-full flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start", className)}>
    {references.map(reference => <Chip key={reference.referenceId} tone="iris" className="min-w-0 max-w-full" title={t("artifacts.reference.tooltip", { title: reference.title, machine: reference.machine, snapshot: reference.snapshotAt, code: reference.codeRevisionId, data: reference.includeData ? t("artifacts.reference.withData") : t("artifacts.reference.definitionOnly") })}>
      <span aria-hidden className="shrink-0">@</span>
      <span className="min-w-0 max-w-[24rem] truncate">{reference.title}</span>
      <span className="shrink-0 text-ink-dim">{reference.includeData ? t("artifacts.reference.withData") : t("artifacts.reference.definitionOnly")}</span>
      {onRemove !== undefined && <IconButton label={t("artifacts.reference.remove", { title: reference.title })} disabled={disabled} tone="rose" onClick={() => onRemove(reference.referenceId)} className="size-4 rounded-full border border-line-strong bg-overlay"><IconClose /></IconButton>}
    </Chip>)}
  </div>;
}
