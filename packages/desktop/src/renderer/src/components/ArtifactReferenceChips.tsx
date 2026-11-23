import { useId, useRef, useState } from "react";
import type { ArtifactReference, DraftArtifactReference } from "@omp-ui/core/artifacts";
import { backendFor } from "../backend";
import { cn } from "../lib/cn";
import { useDismissal } from "../lib/use-dismissal";
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
  return <div role="group" aria-label="Artifact references" className={cn("flex max-w-full flex-wrap gap-1.5", align === "end" ? "justify-end" : "justify-start", className)}>
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
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const popoverId = useId();
  const triggerRef = useRef<HTMLSpanElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  useDismissal({
    open: confirming,
    refs: [triggerRef, popoverRef],
    onClose: () => { if (!busy) setConfirming(false); },
    onEscape: () => { if (!busy) setConfirming(false); },
    restoreFocus: () => triggerRef.current?.querySelector<HTMLButtonElement>("button")?.focus(),
  });
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
  return <span className="relative inline-flex max-w-full">
    <Chip tone="iris" className="min-w-0 max-w-full" title={`${reference.title}\nMachine: ${reference.machine}\nSnapshot: ${reference.snapshotAt}\nCode: ${reference.codeRevisionId}\nConsent: ${reference.includeData ? "Saved data included" : "Definition only"}`}>
      <span aria-hidden className="shrink-0">@</span>
      <span className="min-w-0 max-w-[24rem] truncate">{reference.title}</span>
      <span className="shrink-0 text-ink-dim">{reference.includeData ? "Saved data included" : "Definition only"}</span>
      {togglable && (reference.includeData
        ? <Button variant="ghost" disabled={disabled || busy} className="h-auto px-1 py-0 text-xs text-ink-dim underline decoration-dotted" onClick={() => void mint(false)}>Stop sharing data</Button>
        : <span ref={triggerRef} className="inline-flex"><Button variant="ghost" disabled={disabled || busy} className="h-auto px-1 py-0 text-xs text-ink-dim underline decoration-dotted" onClick={() => setConfirming(open => !open)}>Include data</Button></span>)}
      {onRemove !== undefined && <IconButton label={`Remove ${reference.title} reference`} disabled={disabled} tone="rose" onClick={() => onRemove(reference.referenceId)} className="size-4 rounded-full border border-line-strong bg-overlay"><IconClose /></IconButton>}
    </Chip>
    {togglable && !reference.includeData && confirming && (
      <div
        id={popoverId}
        ref={popoverRef}
        role="dialog"
        aria-label={`Include saved data for ${reference.title}`}
        className="absolute bottom-full left-0 z-30 mb-1.5 w-80 max-w-[90vw] space-y-2.5 rounded-lg border border-line-strong bg-overlay p-3 text-xs shadow-lg backdrop-glass"
      >
        <p className="leading-relaxed text-ink-mid">
          Off shares the definition only. HTML itself can contain sensitive information or bundled data. With consent, this exact saved data snapshot is also readable by the session.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button size="xs" variant="ghost" disabled={disabled || busy} onClick={() => setConfirming(false)}>Cancel</Button>
          <Button size="xs" variant="solid" disabled={disabled || busy} onClick={() => void mint(true)}>Include saved data</Button>
        </div>
      </div>
    )}
  </span>;
}
