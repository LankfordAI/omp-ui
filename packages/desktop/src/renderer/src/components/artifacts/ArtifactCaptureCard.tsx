import { useEffect, useState } from "react";
import type { ArtifactCaptureDescription, ArtifactDescription, ArtifactPartResult } from "@omp-ui/core/artifacts";
import { artifactFailure } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { findOwner, useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Button, Modal } from "../ui";

export function ArtifactCaptureCard({ description, capture }: { description: ArtifactDescription; capture: ArtifactCaptureDescription }) {
  const t = useT();
  const [datasetId, setDatasetId] = useState(capture.datasets[0]?.id ?? "");
  const [offsets, setOffsets] = useState<[number[], number[]]>([[0], [0]]);
  const [pages, setPages] = useState<[ArtifactPartResult | null, ArtifactPartResult | null]>([null, null]);
  const [reviewed, setReviewed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [appliedLocally, setAppliedLocally] = useState(false);
  const applied = appliedLocally || capture.appliedDataSnapshotId !== null;
  const leftOffset = offsets[0].at(-1) ?? 0;
  const rightOffset = offsets[1].at(-1) ?? 0;
  const captureSourceSnapshot = description.refreshRequests.find((request) => request.refreshRequestId === capture.refreshRequestId)?.dataSnapshotId;
  useEffect(() => { setReviewed(new Set()); setOffsets([[0], [0]]); }, [capture.captureId, description.code.codeRevisionId, description.snapshot.dataSnapshotId]);
  useEffect(() => {
    let canceled = false; setError(null); setPages([null, null]);
    if (!captureSourceSnapshot) { setError(t("artifacts.sourceUnavailable")); return; }
    void Promise.all(([0, 1] as const).map((side) => backend.artifactReadPart({ artifactId: description.artifact.artifactId, codeRevisionId: side === 1 ? capture.codeRevisionId : description.code.codeRevisionId, dataSnapshotId: side === 1 ? captureSourceSnapshot : description.snapshot.dataSnapshotId, part: "dataset", datasetId, offset: side === 0 ? leftOffset : rightOffset, limit: 16384, ...(side === 1 ? { captureId: capture.captureId } : {}) }))).then((next) => {
      if (canceled) return;
      setPages([next[0]!, next[1]!]);
      setReviewed((old) => { const result = new Set(old); next.forEach((page, side) => { if (page.nextOffset === null) result.add(`${datasetId}:${side}`); }); return result; });
    }).catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [capture.captureId, capture.codeRevisionId, captureSourceSnapshot, description.artifact.artifactId, description.code.codeRevisionId, description.snapshot.dataSnapshotId, datasetId, leftOffset, rightOffset, t]);
  const stale = !applied && (capture.codeRevisionId !== description.artifact.currentCodeRevisionId || description.code.codeRevisionId !== description.artifact.currentCodeRevisionId || Object.entries(capture.expectedDatasetHeads).some(([id, head]) => description.snapshot.datasets.find((dataset) => dataset.id === id)?.head !== head));
  const complete = capture.datasets.every((dataset) => reviewed.has(`${dataset.id}:0`) && reviewed.has(`${dataset.id}:1`));
  const apply = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await backend.artifactApplyCapture({ captureId: capture.captureId, expectedCodeRevisionId: capture.codeRevisionId, expectedDatasetHeads: capture.expectedDatasetHeads }); setAppliedLocally(true); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(artifactFailure(reason)?.error === "over-limit" ? t("artifacts.overLimit") : displayMessage(reason)); }
    finally { setBusy(false); }
  };
  const selected = capture.datasets.find((dataset) => dataset.id === datasetId);
  const runTabId = description.refreshRequests.find((request) => request.refreshRequestId === capture.refreshRequestId)?.targetTabId;
  const runOwner = useStore((s) => findOwner(s.state, runTabId ?? ""));
  const discard = async (): Promise<void> => {
    setBusy(true); setError(null);
    try { await backend.artifactDiscardCapture({ captureId: capture.captureId }); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setBusy(false); }
  };
  return <section id={`artifact-capture-${capture.captureId}`} className="min-w-0 space-y-3 rounded border border-line p-3" aria-label={t("artifacts.captureReview")}>
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-semibold">{t("artifacts.captureReview")}</h3><span className="flex flex-wrap items-center gap-2 text-xs text-ink-dim">{t(applied ? "artifacts.applied" : "artifacts.awaitingReview")}{runOwner !== undefined && <Button variant="ghost" onClick={() => void useStore.getState().openSession(runTabId!)}>{t("artifacts.viewRun")}</Button>}{!applied && <Button variant="ghost" disabled={busy} onClick={() => setDiscardConfirm(true)}>{t("artifacts.discardCapture")}</Button>}</span></div>
    <p className="text-sm text-ink-dim">{t("artifacts.captureHint")}</p>
    <label className="flex flex-wrap items-center gap-2 text-sm">{t("artifacts.data")}<select className="max-w-full rounded border border-line bg-raised p-1" value={datasetId} onChange={(event) => { setDatasetId(event.target.value); setOffsets([[0], [0]]); }}>{capture.datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.title}</option>)}</select></label>
    {selected && <details><summary className="cursor-pointer text-sm">{t("artifacts.source")}</summary><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all p-2 text-xs text-ink-dim">{JSON.stringify({ schema: selected.schema, beforeBytes: selected.currentValueBytes, afterBytes: selected.valueBytes, provenance: selected.provenance }, null, 2)}</pre></details>}
    <div className="grid min-w-0 gap-3 @[48rem]:grid-cols-2">{([0, 1] as const).map((side) => <div key={side} className="min-w-0"><h4 className="mb-1 text-xs font-semibold text-ink-mid">{t(side === 0 ? "artifacts.before" : "artifacts.after")}</h4><pre tabIndex={0} className="max-h-56 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-2 text-xs">{pages[side]?.text ?? t("artifacts.loading")}</pre><div className="mt-1 flex flex-wrap gap-2"><Button disabled={offsets[side].length === 1} onClick={() => setOffsets((old) => { const next: [number[], number[]] = [...old]; next[side] = old[side].slice(0, -1); return next; })}>{t("artifacts.previous")}</Button><Button disabled={!pages[side] || pages[side]?.nextOffset === null} onClick={() => { const nextOffset = pages[side]?.nextOffset; if (nextOffset != null) setOffsets((old) => { const next: [number[], number[]] = [...old]; next[side] = [...old[side], nextOffset]; return next; }); }}>{t("artifacts.next")}</Button></div></div>)}</div>
    {stale && <p className="text-sm text-rose">{t("artifacts.captureStale")}</p>}{error && <p role="alert" className="text-sm text-rose">{t("artifacts.captureFailed", { reason: error })}</p>}
    {!applied && <div className="flex flex-wrap items-center gap-2"><Button variant="solid" disabled={busy || stale || !complete} onClick={() => void apply()}>{t("artifacts.apply")}</Button>{!complete && <span className="text-xs text-ink-dim">{t("artifacts.reviewAllPages")}</span>}</div>}
    {discardConfirm && <Modal labelledBy={`artifact-discard-${capture.captureId}`} onClose={() => { if (!busy) setDiscardConfirm(false); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id={`artifact-discard-${capture.captureId}`} className="text-base font-semibold">{t("artifacts.discardCaptureTitle")}</h2><p className="text-sm text-ink-mid">{t("artifacts.discardCaptureHint")}</p>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={busy} onClick={() => setDiscardConfirm(false)}>{t("artifacts.cancel")}</Button><Button disabled={busy} variant="solid" onClick={() => void discard()}>{t("artifacts.discardCapture")}</Button></div></div></Modal>}
  </section>;
}

export function ArtifactCaptureTranscriptCard({ artifactId, captureId, tabId }: { artifactId: string; captureId: string; tabId: string }) {
  const t = useT();
  const allowed = useStore((s) => s.state?.artifactLibraryEnabled === true && findOwner(s.state, tabId)?.instanceId === null && findOwner(s.state, tabId)?.record.mode === "rpc-ui");
  return allowed ? <Button onClick={() => useStore.getState().openArtifacts({ artifactId, captureId })} data-artifact-capture-id={captureId}>{t("artifacts.reviewCapture")}</Button> : <p className="text-xs text-ink-dim">{t("artifacts.foreignHint")}</p>;
}

export function ArtifactCaptureFailure({message}: {message: string}) {
  const t = useT();
  return <p role="status" className="text-sm text-ink-dim">{t("artifacts.captureFailed", {reason: message})}</p>;
}
