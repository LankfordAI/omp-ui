import { useEffect, useState } from "react";
import type { ArtifactCaptureDescription, ArtifactDescription, ArtifactJson, ArtifactPartResult } from "@omp-ui/core/artifacts";
import { artifactFailure } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { diffArtifactValues, type ArtifactValueDiff } from "../../lib/artifact-diff";
import { ArtifactPartTooLargeError, readAllPart } from "../../lib/artifact-parts";
import { formatBytes, relativeTime } from "../../lib/format";
import { findOwner, useStore } from "../../store";
import { Button, Chip, Modal } from "../ui";

const DIFF_MAX_BYTES = 2 * 1024 * 1024;

type DiffState =
  | { status: "loading" }
  | { status: "ready"; diff: ArtifactValueDiff }
  | { status: "too-large"; bytes: number }
  | { status: "error"; message: string };

function formatSnippet(value: ArtifactJson): string {
  const json = JSON.stringify(value, null, 2);
  return json.length > 600 ? `${json.slice(0, 600)}…` : json;
}

export function ArtifactCaptureCard({ description, capture }: { description: ArtifactDescription; capture: ArtifactCaptureDescription }) {
  const [datasetId, setDatasetId] = useState(capture.datasets[0]?.id ?? "");
  const [mode, setMode] = useState<"diff" | "raw">("diff");
  const [diffState, setDiffState] = useState<DiffState>({ status: "loading" });
  const [offsets, setOffsets] = useState<[number[], number[]]>([[0], [0]]);
  const [pages, setPages] = useState<[ArtifactPartResult | null, ArtifactPartResult | null]>([null, null]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [discardConfirm, setDiscardConfirm] = useState(false);
  const [appliedLocally, setAppliedLocally] = useState(false);
  const applied = appliedLocally || capture.appliedDataSnapshotId !== null;
  const leftOffset = offsets[0].at(-1) ?? 0;
  const rightOffset = offsets[1].at(-1) ?? 0;
  const refreshRequest = description.refreshRequests.find((request) => request.refreshRequestId === capture.refreshRequestId);
  const captureSourceSnapshot = refreshRequest?.dataSnapshotId;

  useEffect(() => {
    setOffsets([[0], [0]]);
  }, [capture.captureId, description.code.codeRevisionId, description.snapshot.dataSnapshotId, datasetId]);

  useEffect(() => {
    let canceled = false;
    setError(null);
    if (!captureSourceSnapshot) {
      setDiffState({ status: "error", message: "The exact source session is unavailable. Kept code and data remain available." });
      return;
    }
    if (!datasetId) return;
    setDiffState({ status: "loading" });
    void Promise.all([
      readAllPart(
        {
          artifactId: description.artifact.artifactId,
          codeRevisionId: description.code.codeRevisionId,
          dataSnapshotId: description.snapshot.dataSnapshotId,
          part: "dataset",
          datasetId,
        },
        { maxBytes: DIFF_MAX_BYTES },
      ),
      readAllPart(
        {
          artifactId: description.artifact.artifactId,
          codeRevisionId: capture.codeRevisionId,
          dataSnapshotId: captureSourceSnapshot,
          part: "dataset",
          datasetId,
          captureId: capture.captureId,
        },
        { maxBytes: DIFF_MAX_BYTES },
      ),
    ])
      .then(([leftText, rightText]) => {
        if (canceled) return;
        const before = JSON.parse(leftText) as ArtifactJson;
        const after = JSON.parse(rightText) as ArtifactJson;
        setDiffState({ status: "ready", diff: diffArtifactValues(before, after) });
      })
      .catch((reason: unknown) => {
        if (canceled) return;
        if (reason instanceof ArtifactPartTooLargeError) {
          setDiffState({ status: "too-large", bytes: reason.totalBytes });
        } else {
          setDiffState({ status: "error", message: displayMessage(reason) });
        }
      });
    return () => { canceled = true; };
  }, [capture.captureId, capture.codeRevisionId, captureSourceSnapshot, description.artifact.artifactId, description.code.codeRevisionId, description.snapshot.dataSnapshotId, datasetId]);

  useEffect(() => {
    if (mode !== "raw" && diffState.status !== "too-large") return;
    let canceled = false;
    setPages([null, null]);
    if (!captureSourceSnapshot || !datasetId) return;
    void Promise.all(([0, 1] as const).map((side) =>
      backend.artifactReadPart({
        artifactId: description.artifact.artifactId,
        codeRevisionId: side === 1 ? capture.codeRevisionId : description.code.codeRevisionId,
        dataSnapshotId: side === 1 ? captureSourceSnapshot : description.snapshot.dataSnapshotId,
        part: "dataset",
        datasetId,
        offset: side === 0 ? leftOffset : rightOffset,
        limit: 16384,
        ...(side === 1 ? { captureId: capture.captureId } : {}),
      }),
    ))
      .then((next) => { if (!canceled) setPages([next[0]!, next[1]!]); })
      .catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [mode, diffState.status, capture.captureId, capture.codeRevisionId, captureSourceSnapshot, description.artifact.artifactId, description.code.codeRevisionId, description.snapshot.dataSnapshotId, datasetId, leftOffset, rightOffset]);

  const stale = !applied && (
    capture.codeRevisionId !== description.artifact.currentCodeRevisionId ||
    description.code.codeRevisionId !== description.artifact.currentCodeRevisionId ||
    Object.entries(capture.expectedDatasetHeads).some(([id, head]) => description.snapshot.datasets.find((dataset) => dataset.id === id)?.head !== head)
  );
  const apply = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await backend.artifactApplyCapture({ captureId: capture.captureId, expectedCodeRevisionId: capture.codeRevisionId, expectedDatasetHeads: capture.expectedDatasetHeads });
      setAppliedLocally(true);
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(artifactFailure(reason)?.error === "over-limit" ? "Library is over its size limit — free space in Artifacts → Data or History, then try again." : displayMessage(reason));
    } finally {
      setBusy(false);
    }
  };
  const selected = capture.datasets.find((dataset) => dataset.id === datasetId);
  const runTabId = refreshRequest?.targetTabId;
  const runOwner = useStore((s) => findOwner(s.state, runTabId ?? ""));
  const discard = async (): Promise<void> => {
    setBusy(true); setError(null);
    try {
      await backend.artifactDiscardCapture({ captureId: capture.captureId });
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) {
      setError(displayMessage(reason));
    } finally {
      setBusy(false);
    }
  };

  const showRaw = mode === "raw" || diffState.status === "too-large";

  return (
    <section id={`artifact-capture-${capture.captureId}`} className="min-w-0 space-y-3 rounded-lg border border-line bg-surface/60 p-3" aria-label="Review captured data">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-1.5">
          <h3 className="text-sm font-semibold">Review captured data</h3>
          <Chip tone={applied ? "signal" : "copper"}>{applied ? "Applied" : "Awaiting review"}</Chip>
          {refreshRequest?.scheduledBy && <Chip tone="neutral">{`Scheduled · ${refreshRequest.scheduledBy}`}</Chip>}
        </div>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-ink-dim">
          {runOwner !== undefined && <Button size="xs" variant="ghost" onClick={() => void useStore.getState().openSession(runTabId!)}>View run</Button>}
          {!applied && <Button size="xs" variant="ghost" disabled={busy} onClick={() => setDiscardConfirm(true)}>Discard</Button>}
        </span>
      </div>
      <p className="text-xs leading-relaxed text-ink-dim">
        Compare requested datasets before applying. Apply preserves current manual state and untouched datasets; artifact code does not change.
      </p>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2 text-xs text-ink-mid">
          <span>Dataset</span>
          <select
            aria-label="Saved data"
            className="max-w-full rounded border border-line bg-raised px-2 py-1 text-xs text-ink"
            value={datasetId}
            onChange={(event) => { setDatasetId(event.target.value); setOffsets([[0], [0]]); }}
          >
            {capture.datasets.map((dataset) => <option key={dataset.id} value={dataset.id}>{dataset.title}</option>)}
          </select>
        </label>
        <div className="inline-flex rounded border border-line bg-raised p-0.5 text-xs" role="group" aria-label="Comparison view">
          <button type="button" onClick={() => setMode("diff")} className={`rounded px-2 py-0.5 ${mode === "diff" ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink"}`}>Diff</button>
          <button type="button" onClick={() => setMode("raw")} className={`rounded px-2 py-0.5 ${mode === "raw" ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink"}`}>Raw pages</button>
        </div>
      </div>
      {selected && (
        <details className="rounded border border-line-soft bg-raised/50 px-2.5 py-1.5 text-xs">
          <summary className="cursor-pointer font-medium text-ink-mid">Source &amp; size</summary>
          <dl className="mt-2 grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 break-words text-ink-dim">
            <dt className="text-ink-faint">Schema</dt><dd className="font-mono">{selected.schema}</dd>
            <dt className="text-ink-faint">Size</dt><dd>{`${formatBytes(selected.currentValueBytes)} → ${formatBytes(selected.valueBytes)}`}</dd>
            <dt className="text-ink-faint">Source</dt><dd>{`${selected.provenance.source.label} (${selected.provenance.source.kind})`}</dd>
            <dt className="text-ink-faint">Method</dt><dd>{`${selected.provenance.method.kind}: ${selected.provenance.method.description}`}</dd>
            <dt className="text-ink-faint">Captured</dt><dd title={selected.provenance.capturedAt ?? undefined}>{selected.provenance.capturedAt ? relativeTime(selected.provenance.capturedAt) : "Not reported"}</dd>
            <dt className="text-ink-faint">Recorded</dt><dd title={selected.provenance.recordedAt}>{relativeTime(selected.provenance.recordedAt)}</dd>
          </dl>
        </details>
      )}
      {!showRaw && (
        <div className="space-y-2 rounded border border-line bg-raised/60 p-2.5 text-xs" data-capture-diff>
          {diffState.status === "loading" && <p className="text-ink-dim">Comparing saved and captured values…</p>}
          {diffState.status === "error" && <p className="text-rose">{diffState.message}</p>}
          {diffState.status === "ready" && (
            diffState.diff.kind === "summary" ? (
              <div className="space-y-1 text-ink-mid">
                <p className="font-medium text-ink">
                  {diffState.diff.identical ? "No value changes detected." : `Type/size summary: ${diffState.diff.beforeType}${diffState.diff.beforeCount !== null ? ` (${diffState.diff.beforeCount})` : ""} → ${diffState.diff.afterType}${diffState.diff.afterCount !== null ? ` (${diffState.diff.afterCount})` : ""}`}
                </p>
                {selected && <p className="text-ink-dim">{`${formatBytes(selected.currentValueBytes)} → ${formatBytes(selected.valueBytes)}`}</p>}
              </div>
            ) : (
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Chip tone="signal">{`+${diffState.diff.added.length} added`}</Chip>
                  <Chip tone="copper">{`~${diffState.diff.changed.length} changed`}</Chip>
                  <Chip tone="rose">{`-${diffState.diff.removed.length} removed`}</Chip>
                  <span className="text-ink-faint">{`${diffState.diff.unchangedCount} unchanged`}</span>
                </div>
                {diffState.diff.added.length === 0 && diffState.diff.changed.length === 0 && diffState.diff.removed.length === 0 ? (
                  <p className="text-ink-dim">Values match.</p>
                ) : (
                  <div className="max-h-56 space-y-1.5 overflow-y-auto pr-1">
                    {diffState.diff.added.slice(0, 20).map((entry) => (
                      <div key={`add:${entry.key}`} className="rounded border border-signal/30 bg-signal/5 p-1.5">
                        <div className="font-mono font-medium text-signal">{`+ ${entry.key}`}</div>
                        <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-ink-mid">{formatSnippet(entry.value)}</pre>
                      </div>
                    ))}
                    {diffState.diff.changed.slice(0, 20).map((entry) => (
                      <div key={`chg:${entry.key}`} className="rounded border border-copper/30 bg-copper/5 p-1.5">
                        <div className="font-mono font-medium text-copper">{`~ ${entry.key}`}</div>
                        <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-ink-dim">{`- ${formatSnippet(entry.before)}`}</pre>
                        <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-ink">{`+ ${formatSnippet(entry.after)}`}</pre>
                      </div>
                    ))}
                    {diffState.diff.removed.slice(0, 20).map((entry) => (
                      <div key={`rem:${entry.key}`} className="rounded border border-rose/30 bg-rose/5 p-1.5">
                        <div className="font-mono font-medium text-rose">{`- ${entry.key}`}</div>
                        <pre className="mt-0.5 overflow-x-auto whitespace-pre-wrap break-all text-ink-dim">{formatSnippet(entry.value)}</pre>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )
          )}
        </div>
      )}
      {showRaw && (
        <div className="space-y-2">
          {diffState.status === "too-large" && (
            <p className="text-xs text-ink-dim">
              {`Payload is ${formatBytes(diffState.bytes)} (over ${formatBytes(DIFF_MAX_BYTES)} diff limit). Showing paged inspection; you can still apply without paging every chunk.`}
            </p>
          )}
          <div className="grid min-w-0 gap-3 @[36rem]:grid-cols-2">
            {([0, 1] as const).map((side) => (
              <div key={side} className="min-w-0">
                <h4 className="mb-1 text-xs font-semibold text-ink-mid">{side === 0 ? "Saved value" : "Captured value"}</h4>
                <pre tabIndex={0} className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-2 text-xs">{pages[side]?.text ?? "Loading…"}</pre>
                <div className="mt-1 flex flex-wrap gap-1.5">
                  <Button size="xs" disabled={offsets[side].length === 1} onClick={() => setOffsets((old) => { const next: [number[], number[]] = [...old]; next[side] = old[side].slice(0, -1); return next; })}>Previous page</Button>
                  <Button size="xs" disabled={!pages[side] || pages[side]?.nextOffset === null} onClick={() => { const nextOffset = pages[side]?.nextOffset; if (nextOffset != null) setOffsets((old) => { const next: [number[], number[]] = [...old]; next[side] = [...old[side], nextOffset]; return next; }); }}>Next page</Button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
      {stale && <p className="text-xs text-rose">Saved code or a requested dataset changed. This capture cannot be applied; prepare a new refresh.</p>}
      {error && <p role="alert" className="text-xs text-rose">{`Not applied: ${error}. Last saved data is unchanged.`}</p>}
      {!applied && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" variant="solid" disabled={busy || stale} onClick={() => void apply()}>Apply captured data</Button>
        </div>
      )}
      {discardConfirm && (
        <Modal labelledBy={`artifact-discard-${capture.captureId}`} onClose={() => { if (!busy) setDiscardConfirm(false); }} width="w-[min(30rem,96vw)]">
          <div className="space-y-4 p-4">
            <h2 id={`artifact-discard-${capture.captureId}`} className="text-base font-semibold">Discard this capture?</h2>
            <p className="text-sm text-ink-mid">The captured data is deleted from the library. Applied captures cannot be discarded.</p>
            {error && <p role="alert" className="text-sm text-rose">{error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              <Button disabled={busy} onClick={() => setDiscardConfirm(false)}>Cancel</Button>
              <Button disabled={busy} variant="solid" onClick={() => void discard()}>Discard</Button>
            </div>
          </div>
        </Modal>
      )}
    </section>
  );
}

export function ArtifactCaptureTranscriptCard({ artifactId, captureId, tabId }: { artifactId: string; captureId: string; tabId: string }) {
  const allowed = useStore((s) => s.state?.artifactLibraryEnabled === true && findOwner(s.state, tabId)?.instanceId === null && findOwner(s.state, tabId)?.record.mode === "rpc-ui");
  return allowed ? <Button onClick={() => useStore.getState().openArtifacts({ artifactId, captureId })} data-artifact-capture-id={captureId}>Review capture in library</Button> : <p className="text-xs text-ink-dim">Open this artifact on its owning host to keep it or use managed state. Joined-owner actions are not supported.</p>;
}

export function ArtifactCaptureFailure({message}: {message: string}) {
  return <p role="status" className="text-sm text-ink-dim">{`Not applied: ${message}. Last saved data is unchanged.`}</p>;
}
