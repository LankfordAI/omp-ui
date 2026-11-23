import { useEffect, useState } from "react";
import type { ArtifactDescription, ArtifactPartResult, ArtifactReadRequest } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { Button } from "../ui";
import { useStore } from "../../store";
import { IS_ELECTRON } from "../../lib/platform";
import { copyFallback } from "../../lib/clipboard";
import { downloadBlob, readAllPart, safeDownloadName } from "../../lib/artifact-parts";
import { describeSchedule } from "../routines/routine-format";

export function ArtifactDataSources({ description }: { description: ArtifactDescription }) {
  const [part, setPart] = useState<string>("state");
  const state = useStore((s) => s.state);
  const routinesState = useStore((s) => s.routinesState);
  const focusRoutine = useStore((s) => s.focusRoutine);
  const [offsets, setOffsets] = useState<number[]>([0]);
  const [page, setPage] = useState<ArtifactPartResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const offset = offsets.at(-1) ?? 0;
  const { artifact, code, snapshot } = description;
  useEffect(() => {
    let canceled = false;
    setPage(null); setError(null);
    const request: ArtifactReadRequest = { artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: part === "state" ? "state" : "dataset", ...(part === "state" ? {} : { datasetId: part.slice(8) }), offset, limit: 16384 };
    void backend.artifactReadPart(request).then((result) => { if (!canceled) setPage(result); }).catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [artifact.artifactId, code.codeRevisionId, snapshot.dataSnapshotId, part, offset]);
  const selected = snapshot.datasets.find((dataset) => `dataset:${dataset.id}` === part);
  const sourceSession = selected?.provenance.captureSessionId == null ? undefined : [...(state?.chats ?? []), ...(state?.projects.flatMap((group) => group.sessions) ?? [])].find((session) => session.sessionId === selected.provenance.captureSessionId && session.live !== "missing");
  return <section className="min-w-0 space-y-3" aria-label="Saved data">
    <label className="flex flex-wrap items-center gap-2 text-sm">Saved data<select className="min-w-0 max-w-full rounded border border-line bg-raised px-2 py-1 text-ink" value={part} onChange={(event) => { setPart(event.target.value); setOffsets([0]); }}><option value="state">User state</option>{snapshot.datasets.map((dataset) => <option key={dataset.id} value={`dataset:${dataset.id}`}>{dataset.title}</option>)}</select></label>
    {selected && <div className="space-y-2 border-l-2 border-line-strong pl-3 text-sm text-ink-mid">
      <h3 className="font-semibold text-ink">{selected.provenance.source.label}</h3>
      <p className="text-xs leading-relaxed text-ink-dim">Source and collection-method claims are agent-reported, not verified data lineage. Host-recorded time and session identity do not verify those claims.</p>
      <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
        <dt>Schema</dt><dd>{selected.schema}</dd>
        <dt>Source</dt><dd>{selected.provenance.source.kind}{selected.provenance.source.locator && <p>{selected.provenance.source.locator}</p>}</dd>
        <dt>Collection method</dt><dd>{selected.provenance.method.kind}: {selected.provenance.method.description}</dd>
        <dt>Reported capture</dt><dd>{selected.provenance.capturedAt ?? "Not reported"}</dd>
        <dt>Host recorded</dt><dd>{selected.provenance.recordedAt}</dd>
        <dt>Provenance trust</dt><dd>{selected.provenance.trust === "agent-reported" ? "Agent-reported" : "User-entered"}</dd>
        <dt>Refresh recipe</dt><dd>{selected.provenance.refresh.kind}<p className="whitespace-pre-wrap">{selected.provenance.refresh.instructions ?? "No refresh instructions recorded."}</p>{selected.provenance.refresh.requiredSources.map((source) => <p key={source}>{source}</p>)}</dd>
      </dl>
      {sourceSession && <Button onClick={() => void useStore.getState().openArtifactSource({ tabId: sourceSession.tabId, sessionId: sourceSession.sessionId, toolCallId: selected.provenance.captureToolCallId })}>Open exact source</Button>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={exporting} onClick={() => { void (async () => { setExporting(true); try { const text = await readAllPart({ artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: "dataset", datasetId: selected.id }); if (navigator.clipboard) await navigator.clipboard.writeText(text); else copyFallback(text); } catch (reason) { setError(displayMessage(reason)); } finally { setExporting(false); } })(); }}>Copy JSON</Button>
        {IS_ELECTRON ? <Button disabled={exporting} onClick={() => { void (async () => { setExporting(true); try { await backend.artifactSavePart({ artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: "dataset", datasetId: selected.id }); } catch (reason) { setError(displayMessage(reason)); } finally { setExporting(false); } })(); }}>Save JSON…</Button> : <Button disabled={exporting} onClick={() => { void (async () => { setExporting(true); try { const text = await readAllPart({ artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: "dataset", datasetId: selected.id }); downloadBlob(safeDownloadName(selected.title, "json"), "application/json", text); } catch (reason) { setError(displayMessage(reason)); } finally { setExporting(false); } })(); }}>Download JSON</Button>}
      </div>
      {selected.provenance.method.parameters && <details><summary className="cursor-pointer">Exact collection parameters</summary><pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-2 text-xs">{JSON.stringify(selected.provenance.method.parameters, null, 2)}</pre></details>}
    </div>}
    {error && <p role="alert" className="text-sm text-rose">{error}</p>}
    {(routinesState?.routines ?? []).some((routine) => routine.artifact?.artifactId === artifact.artifactId) && (
      <div className="space-y-1 border-l-2 border-line-strong pl-3 text-sm" data-artifact-scheduled-refreshes>
        <h3 className="font-semibold text-ink">Scheduled refreshes</h3>
        {(routinesState?.routines ?? [])
          .filter((routine) => routine.artifact?.artifactId === artifact.artifactId)
          .map((routine) => (
            <p key={routine.id} className="flex flex-wrap items-center gap-2 text-xs text-ink-mid">
              <Button variant="ghost" size="xs" onClick={() => focusRoutine(routine.id)}>{routine.name}</Button>
              <span>{describeSchedule(routine.schedule)}</span>
              <span>{routine.enabled ? (routine.artifact!.autoApply ? "auto-applies" : "stages for review") : "paused"}</span>
            </p>
          ))}
      </div>
    )}
    <pre tabIndex={0} aria-label="Saved data page" className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-raised p-3 text-xs text-ink-mid">{page?.text ?? "Loading…"}</pre>
    {page && <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint"><span>{`Bytes ${page.offset}–${page.nextOffset ?? page.totalBytes} of ${page.totalBytes}`}</span><Button disabled={offsets.length === 1} onClick={() => setOffsets((old) => old.slice(0, -1))}>Previous page</Button><Button disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffsets((old) => [...old, page.nextOffset!]); }}>Next page</Button></div>}
  </section>;
}
