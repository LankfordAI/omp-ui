import { useEffect, useMemo, useState } from "react";
import type { ArtifactDescription, ArtifactPartResult, ArtifactReadRequest } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { Button, Chip } from "../ui";
import { useStore } from "../../store";
import { IS_ELECTRON } from "../../lib/platform";
import { copyFallback } from "../../lib/clipboard";
import { downloadBlob, readAllPart, safeDownloadName } from "../../lib/artifact-parts";
import { relativeTime } from "../../lib/format";
import { describeSchedule } from "../routines/routine-format";

type ViewMode = "summary" | "pretty" | "raw";

function summarizeJson(raw: string): string | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null) return "null";
    if (Array.isArray(parsed)) {
      const sample = parsed[0];
      const keys = sample && typeof sample === "object" && !Array.isArray(sample) ? Object.keys(sample) : [];
      return keys.length > 0
        ? `Array of ${parsed.length} item${parsed.length === 1 ? "" : "s"} · columns: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ` (+${keys.length - 8})` : ""}`
        : `Array of ${parsed.length} item${parsed.length === 1 ? "" : "s"}`;
    }
    if (typeof parsed === "object") {
      const keys = Object.keys(parsed);
      return keys.length > 0
        ? `Object with ${keys.length} key${keys.length === 1 ? "" : "s"}: ${keys.slice(0, 8).join(", ")}${keys.length > 8 ? ` (+${keys.length - 8})` : ""}`
        : "Empty object {}";
    }
    return `${typeof parsed}: ${String(parsed)}`;
  } catch {
    return null;
  }
}

export function ArtifactDataSources({ description }: { description: ArtifactDescription }) {
  const [part, setPart] = useState<string>("state");
  const [viewMode, setViewMode] = useState<ViewMode>("pretty");
  const state = useStore((s) => s.state);
  const routinesState = useStore((s) => s.routinesState);
  const focusRoutine = useStore((s) => s.focusRoutine);
  const openNewRoutineForArtifact = useStore((s) => s.openNewRoutineForArtifact);
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
  const scheduledRoutines = (routinesState?.routines ?? []).filter((routine) => routine.artifact?.artifactId === artifact.artifactId);
  const canScheduleRefresh = state?.routinesEnabled === true && artifact.managed && (code.definition?.datasets.length ?? 0) > 0;
  const formattedText = useMemo(() => {
    if (!page) return "Loading…";
    if (viewMode === "raw") return page.text;
    if (page.offset === 0 && page.nextOffset === null) {
      if (viewMode === "summary") return summarizeJson(page.text) ?? page.text;
      try { return JSON.stringify(JSON.parse(page.text), null, 2); } catch { return page.text; }
    }
    if (viewMode === "summary") return `Chunked payload (${page.totalBytes} bytes total) — switch to Raw to inspect pages.`;
    return page.text;
  }, [page, viewMode]);

  return (
    <section className="min-w-0 space-y-3" aria-label="Saved data">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex min-w-0 items-center gap-2 text-xs text-ink-mid">
          <span>Saved data</span>
          <select
            aria-label="Saved data"
            className="min-w-0 max-w-full rounded border border-line bg-raised px-2 py-1 text-xs text-ink"
            value={part}
            onChange={(event) => { setPart(event.target.value); setOffsets([0]); }}
          >
            <option value="state">User state</option>
            {snapshot.datasets.map((dataset) => <option key={dataset.id} value={`dataset:${dataset.id}`}>{dataset.title}</option>)}
          </select>
        </label>
        <div className="inline-flex rounded border border-line bg-raised p-0.5 text-xs" role="group" aria-label="Data view mode">
          {(["summary", "pretty", "raw"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => setViewMode(m)}
              className={`rounded px-2 py-0.5 ${viewMode === m ? "bg-surface font-medium text-ink" : "text-ink-dim hover:text-ink"}`}
            >
              {m === "summary" ? "Summary" : m === "pretty" ? "Pretty JSON" : "Raw"}
            </button>
          ))}
        </div>
      </div>
      {selected && (
        <div className="space-y-2 border-l-2 border-line-strong pl-3 text-xs text-ink-mid">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="text-sm font-semibold text-ink">{selected.provenance.source.label}</h3>
            <Chip
              tone={selected.provenance.trust === "agent-reported" ? "neutral" : "signal"}
              title="Source and collection-method claims are agent-reported, not verified data lineage. Host-recorded time and session identity do not verify those claims."
            >
              {selected.provenance.trust === "agent-reported" ? "agent-reported" : "user-entered"}
            </Chip>
          </div>
          <dl className="grid min-w-0 grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
            <dt className="text-ink-faint">Schema</dt><dd className="font-mono">{selected.schema}</dd>
            <dt className="text-ink-faint">Source</dt><dd>{selected.provenance.source.kind}{selected.provenance.source.locator && <p className="font-mono text-ink-dim">{selected.provenance.source.locator}</p>}</dd>
            <dt className="text-ink-faint">Collection method</dt><dd>{selected.provenance.method.kind}: {selected.provenance.method.description}</dd>
            <dt className="text-ink-faint">Reported capture</dt><dd title={selected.provenance.capturedAt ?? undefined}>{selected.provenance.capturedAt ? relativeTime(selected.provenance.capturedAt) : "Not reported"}</dd>
            <dt className="text-ink-faint">Host recorded</dt><dd title={selected.provenance.recordedAt}>{relativeTime(selected.provenance.recordedAt)}</dd>
            <dt className="text-ink-faint">Refresh recipe</dt><dd>{selected.provenance.refresh.kind}<p className="whitespace-pre-wrap text-ink-dim">{selected.provenance.refresh.instructions ?? "No refresh instructions recorded."}</p>{selected.provenance.refresh.requiredSources.map((source) => <p key={source}>{source}</p>)}</dd>
          </dl>
          <div className="flex flex-wrap gap-1.5">
            {sourceSession && <Button size="xs" onClick={() => void useStore.getState().openArtifactSource({ tabId: sourceSession.tabId, sessionId: sourceSession.sessionId, toolCallId: selected.provenance.captureToolCallId })}>Open exact source</Button>}
            <Button size="xs" disabled={exporting} onClick={() => { void (async () => { setExporting(true); try { const text = await readAllPart({ artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: "dataset", datasetId: selected.id }); if (navigator.clipboard) await navigator.clipboard.writeText(text); else copyFallback(text); } catch (reason) { setError(displayMessage(reason)); } finally { setExporting(false); } })(); }}>Copy JSON</Button>
            {IS_ELECTRON ? <Button size="xs" disabled={exporting} onClick={() => { void (async () => { setExporting(true); try { await backend.artifactSavePart({ artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: "dataset", datasetId: selected.id }); } catch (reason) { setError(displayMessage(reason)); } finally { setExporting(false); } })(); }}>Save JSON…</Button> : <Button size="xs" disabled={exporting} onClick={() => { void (async () => { setExporting(true); try { const text = await readAllPart({ artifactId: artifact.artifactId, codeRevisionId: code.codeRevisionId, dataSnapshotId: snapshot.dataSnapshotId, part: "dataset", datasetId: selected.id }); downloadBlob(safeDownloadName(selected.title, "json"), "application/json", text); } catch (reason) { setError(displayMessage(reason)); } finally { setExporting(false); } })(); }}>Download JSON</Button>}
          </div>
          {selected.provenance.method.parameters && <details><summary className="cursor-pointer">Exact collection parameters</summary><pre className="mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-raised p-2 text-xs">{JSON.stringify(selected.provenance.method.parameters, null, 2)}</pre></details>}
        </div>
      )}
      {error && <p role="alert" className="text-xs text-rose">{error}</p>}
      {(scheduledRoutines.length > 0 || canScheduleRefresh) && (
        <div className="space-y-1.5 border-l-2 border-line-strong pl-3 text-xs" data-artifact-scheduled-refreshes>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold text-ink">Scheduled refreshes</h3>
            {canScheduleRefresh && (
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  openNewRoutineForArtifact({
                    artifactId: artifact.artifactId,
                    datasetIds: (code.definition?.datasets ?? []).map((d) => d.id),
                    projectCwd: artifact.originContext.kind === "project" ? artifact.originContext.path : null,
                    title: artifact.title,
                  })
                }
              >
                + Schedule refresh…
              </Button>
            )}
          </div>
          {scheduledRoutines.map((routine) => (
            <p key={routine.id} className="flex flex-wrap items-center gap-2 text-xs text-ink-mid">
              <Button variant="ghost" size="xs" onClick={() => focusRoutine(routine.id)}>{routine.name}</Button>
              <span>{describeSchedule(routine.schedule)}</span>
              <span>{routine.enabled ? (routine.artifact!.autoApply ? "auto-applies" : "stages for review") : "paused"}</span>
            </p>
          ))}
        </div>
      )}
      <pre tabIndex={0} aria-label="Saved data page" className="max-h-72 overflow-auto whitespace-pre-wrap break-all rounded border border-line bg-raised p-3 text-xs text-ink-mid">{formattedText}</pre>
      {page && (
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <span>{`Bytes ${page.offset}–${page.nextOffset ?? page.totalBytes} of ${page.totalBytes}`}</span>
          <Button size="xs" disabled={offsets.length === 1} onClick={() => setOffsets((old) => old.slice(0, -1))}>Previous page</Button>
          <Button size="xs" disabled={page.nextOffset === null} onClick={() => { if (page.nextOffset !== null) setOffsets((old) => [...old, page.nextOffset!]); }}>Next page</Button>
        </div>
      )}
    </section>
  );
}
