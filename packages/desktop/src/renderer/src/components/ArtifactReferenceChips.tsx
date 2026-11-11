import { useState } from "react";
import type { ArtifactReference, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { backendFor } from "../backend";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { Button, Chip, IconButton, IconClose } from "./ui";

/**
 * Draft grant chips. With `onReplace` (composer usage only), a managed chip
 * gains the two-step data-consent toggle: grants are immutable (ADR-0090), so
 * changing consent mints a fresh grant and swaps it into the same list slot.
 * Transcript-side chips stay an inert read-only render.
 */
export function ArtifactReferenceChips({ references, onRemove, onReplace, tabId, instanceId, disabled = false, align = "start", className }: {
  references: readonly ArtifactReference[];
  onRemove?: (referenceId: string) => void;
  onReplace?: (old: DraftArtifactReference, next: DraftArtifactReference) => void;
  tabId?: string;
  instanceId?: string | null;
  disabled?: boolean;
  align?: "start" | "end";
  className?: string;
}) {
  const t = useT();
  return <div role="group" aria-label={t("artifacts.reference.chips")} className={cn("flex max-w-full flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start", className)}>
    {references.map(reference => <ConsentChip key={reference.referenceId} reference={reference} tabId={tabId} instanceId={instanceId} disabled={disabled} onRemove={onRemove} onReplace={onReplace} />)}
  </div>;
}

function ConsentChip({ reference, tabId, instanceId, disabled, onRemove, onReplace }: {
  reference: ArtifactReference;
  tabId?: string;
  instanceId?: string | null;
  disabled?: boolean;
  onRemove?: (referenceId: string) => void;
  onReplace?: (old: DraftArtifactReference, next: DraftArtifactReference) => void;
}) {
  const t = useT();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  // Only composer chips with a destination tab and an owner mint replacements;
  // transcript chips (`onReplace` omitted) never gain controls.
  const togglable = onReplace !== undefined && tabId !== undefined;
  const mint = async (includeData: boolean): Promise<void> => {
    if (tabId === undefined || onReplace === undefined) return;
    setBusy(true);
    try {
      const next = await backendFor(instanceId ?? null).artifactReference({ targetTabId: tabId, artifactId: reference.artifactId, codeRevisionId: reference.codeRevisionId, dataSnapshotId: reference.dataSnapshotId, includeData });
      onReplace({ ...reference, instanceId: instanceId ?? null }, { ...next, instanceId: instanceId ?? null });
    } catch { /* the chip keeps its current grant; the store surfaces failures */ }
    finally { setBusy(false); setConfirming(false); }
  };
  return <Chip tone="iris" className="min-w-0 max-w-full" title={t("artifacts.reference.tooltip", { title: reference.title, machine: reference.machine, snapshot: reference.snapshotAt, code: reference.codeRevisionId, data: reference.includeData ? t("artifacts.reference.withData") : t("artifacts.reference.definitionOnly") })}>
    <span aria-hidden className="shrink-0">@</span>
    <span className="min-w-0 max-w-[24rem] truncate">{reference.title}</span>
    <span className="shrink-0 text-ink-dim">{reference.includeData ? t("artifacts.reference.withData") : t("artifacts.reference.definitionOnly")}</span>
    {togglable && (reference.includeData
      ? <Button variant="ghost" disabled={disabled || busy} className="h-auto px-1 py-0 text-xs text-ink-dim underline decoration-dotted" onClick={() => void mint(false)}>{t("artifacts.reference.stopSharingData")}</Button>
      : confirming
        ? <>
          <span className="min-w-0 max-w-[24rem] break-words text-xs text-rose">{t("artifacts.consentWarning")}</span>
          <Button variant="ghost" disabled={disabled || busy} className="h-auto px-1 py-0 text-xs" onClick={() => void mint(true)}>{t("artifacts.keepConfirm")}</Button>
          <Button variant="ghost" disabled={disabled || busy} className="h-auto px-1 py-0 text-xs text-ink-dim" onClick={() => setConfirming(false)}>{t("artifacts.cancel")}</Button>
        </>
        : <Button variant="ghost" disabled={disabled || busy} className="h-auto px-1 py-0 text-xs text-ink-dim underline decoration-dotted" onClick={() => setConfirming(true)}>{t("artifacts.reference.includeData")}</Button>)}
    {onRemove !== undefined && <IconButton label={t("artifacts.reference.remove", { title: reference.title })} disabled={disabled} tone="rose" onClick={() => onRemove(reference.referenceId)} className="size-4 rounded-full border border-line-strong bg-overlay"><IconClose /></IconButton>}
  </Chip>;
}
