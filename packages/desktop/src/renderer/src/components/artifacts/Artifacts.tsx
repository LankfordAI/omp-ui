import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ARTIFACT_LIMITS, type ArtifactDescription, type ArtifactRecord } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../../backend";
import { useStore } from "../../store";
import { useT } from "../../lib/i18n";
import { Button, IconButton, IconClose, Modal } from "../ui";
import { ArtifactSurface } from "./ArtifactSurface";
import { ArtifactDataSources } from "./ArtifactDataSources";
import { ArtifactReferencePicker } from "./ArtifactReferencePicker";
import { ArtifactCaptureCard } from "./ArtifactCaptureCard";
import { ArtifactCandidates } from "./ArtifactCandidates";
import { ARTIFACT_DRAG_MIME } from "../../lib/artifact-drag";
import { IS_ELECTRON } from "../../lib/platform";
import { OVERLAY_INSET } from "../../lib/window-controls";

/** Bounded pages stay metadata-only; only the selected version mounts a guest. */
export function Artifacts() {
  const t = useT();
  const selection = useStore((s) => s.artifacts);
  const revision = useStore((s) => s.artifactLibraryRevision);
  const open = useStore((s) => s.openArtifacts);
  const close = useStore((s) => s.closeArtifacts);
  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<ArtifactRecord[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [description, setDescription] = useState<ArtifactDescription | null>(null);
  const [preview, setPreview] = useState<{ html: string; source: { artifactId: string; codeRevisionId: string; dataSnapshotId: string } } | null>(null);
  const [previewReload, setPreviewReload] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<"reference" | "refresh" | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<"preview" | "data" | "history">("preview");
  const selectedId = selection?.artifactId;
  const queryRef = useRef(query);
  queryRef.current = query;
  const previewRef = useRef<HTMLDialogElement>(null);
  const selectedCode = selection?.codeRevisionId;
  const selectedSnapshot = selection?.dataSnapshotId;
  useEffect(() => {
    if (selection?.captureId) setPanel("data");
  }, [selection?.captureId]);
  useEffect(() => {
    if (!selection?.captureId || panel !== "data" || !description) return;
    const frame = requestAnimationFrame(() => document.getElementById(`artifact-capture-${selection.captureId}`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [selection?.captureId, panel, description?.artifact.artifactId]);
  useEffect(() => {
    let canceled = false;
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      void backend.artifactList({ query, limit: 40 }).then((page) => { if (!canceled) { setRows(page.artifacts); setCursor(page.nextCursor); } }).catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); }).finally(() => { if (!canceled) setLoading(false); });
    }, 150);
    return () => { canceled = true; window.clearTimeout(timer); };
  }, [query, revision]);
  useEffect(() => {
    let canceled = false;
    setPreview(null); setError(null);
    if (!selectedId || panel !== "preview") return;
    void (async () => {
      const next = await backend.artifactDescribe({ artifactId: selectedId, ...(selectedCode ? { codeRevisionId: selectedCode } : {}), ...(selectedSnapshot ? { dataSnapshotId: selectedSnapshot } : {}) });
      if (canceled) return;
      // Metadata follows the current selection independently; this exact writer
      // stays pinned until the user leaves Preview or explicitly reloads it.
      let text = ""; let offset = 0;
      do {
        const page = await backend.artifactReadPart({ artifactId: selectedId, codeRevisionId: next.code.codeRevisionId, dataSnapshotId: next.snapshot.dataSnapshotId, part: "definition", offset, limit: 65536 });
        if (canceled) return;
        if (page.totalBytes > ARTIFACT_LIMITS.envelopeBytes) throw new Error(t("artifacts.definitionTooLarge"));
        text += page.text;
        if (page.nextOffset === null) break;
        if (page.nextOffset <= offset) throw new Error(t("artifacts.invalidPage"));
        offset = page.nextOffset;
      } while (!canceled);
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || !("html" in parsed) || typeof parsed.html !== "string") throw new Error(t("artifacts.invalidDefinition"));
      if (!canceled) setPreview({ html: parsed.html, source: { artifactId: selectedId, codeRevisionId: next.code.codeRevisionId, dataSnapshotId: next.snapshot.dataSnapshotId } });
    })().catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [selectedId, selectedCode, selectedSnapshot, panel, previewReload, t]);
  useEffect(() => { setDescription(null); }, [selectedId, selectedCode, selectedSnapshot]);
  useEffect(() => {
    if (!selectedId) return;
    let canceled = false;
    // Omitted IDs mean current heads, not the IDs resolved by a previous read.
    void backend.artifactDescribe({ artifactId: selectedId, ...(selectedCode ? { codeRevisionId: selectedCode } : {}), ...(selectedSnapshot ? { dataSnapshotId: selectedSnapshot } : {}) }).then((next) => { if (!canceled) setDescription(next); }).catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [revision, selectedId, selectedCode, selectedSnapshot]);
  useLayoutEffect(() => {
    const dialog = previewRef.current;
    if (!expanded || !dialog) return;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button")?.focus();
    return () => { if (dialog.open) dialog.close(); if (trigger?.isConnected) trigger.focus(); };
  }, [expanded]);
  const loadMore = async (): Promise<void> => {
    if (!cursor || loading) return;
    const requestQuery = query; setLoading(true);
    try { const page = await backend.artifactList({ query, limit: 40, cursor }); if (requestQuery === queryRef.current) { setRows((old) => [...old, ...page.artifacts.filter((item) => !old.some((row) => row.artifactId === item.artifactId))]); setCursor(page.nextCursor); } }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setLoading(false); }
  };
  const remove = async (): Promise<void> => {
    if (!description) return;
    setDeleteBusy(true);
    try { await backend.artifactDelete({ artifactId: description.artifact.artifactId, expectedGeneration: description.artifact.generation }); setDeleting(false); open(); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setDeleteBusy(false); }
  };
  return <section className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-void" aria-label={t("artifacts.title")}>
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3"><h1 className="min-w-0 flex-1 text-lg font-semibold tracking-tight">{t("artifacts.title")}</h1><IconButton label={t("common.overlay.close")} onClick={close}><IconClose /></IconButton></header>
    <div className="flex min-h-0 flex-1 flex-col @container">
      <div className="flex min-h-0 flex-1 flex-col @[48rem]:flex-row">
        <aside className={`flex shrink-0 flex-col border-line @[48rem]:w-64 @[48rem]:border-r ${selectedId ? "max-h-40 @[48rem]:max-h-none" : "min-h-0 flex-1 @[48rem]:flex-none"}`}>
          <label className="block shrink-0 p-3"><span className="sr-only">{t("artifacts.search")}</span><input type="search" placeholder={t("artifacts.search")} value={query} onChange={(event) => setQuery(event.target.value)} className="w-full min-w-0 rounded border border-line bg-raised px-3 py-2 text-sm outline-none focus-visible:border-copper" /></label>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label={t("artifacts.savedItems")}>
            {rows.map((row) => <button type="button" key={row.artifactId} draggable onDragStart={(event) => { event.dataTransfer.setData(ARTIFACT_DRAG_MIME, JSON.stringify({ artifactId: row.artifactId, codeRevisionId: row.currentCodeRevisionId, dataSnapshotId: row.currentDataSnapshotId, instanceId: null })); event.dataTransfer.effectAllowed = "copy"; }} aria-current={row.artifactId === selectedId ? "page" : undefined} onClick={() => open({ artifactId: row.artifactId })} className={`block w-full rounded px-2 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper ${row.artifactId === selectedId ? "bg-hover text-ink" : "text-ink-mid hover:bg-hover"}`}>
              <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span><span className="shrink-0 text-xs text-ink-dim">{t("artifacts.kept")}</span></span>
              <span className="block truncate text-xs text-ink-dim" title={row.originContext.kind === "project" ? row.originContext.path : undefined}>{row.originContext.kind === "chat" ? t("palette.chat.desc") : row.originContext.label}</span>
              {row.originContext.kind === "project" && <span className="block truncate text-xs text-ink-faint">{row.originContext.path}</span>}
              <span className="block text-xs text-ink-faint">{new Date(row.updatedAt).toLocaleString()}</span>
            </button>)}
            {!loading && rows.length === 0 && <p className="px-2 py-4 text-sm text-ink-dim">{t(query ? "artifacts.noResults" : "artifacts.empty")}</p>}
            {cursor && <Button className="mt-2 w-full" disabled={loading} onClick={() => void loadMore()}>{t("artifacts.loadMore")}</Button>}
          </div>
        </aside>
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto [scrollbar-gutter:stable]">
          {error && <p role="alert" className="m-4 break-words rounded border border-rose/30 p-3 text-sm text-rose">{error}</p>}
          {!selectedId && <div className="mx-auto max-w-lg px-5 py-12"><h2 className="text-xl font-semibold">{t("artifacts.selectTitle")}</h2><p className="mt-3 text-sm leading-relaxed text-ink-dim">{t("artifacts.selectHint")}</p></div>}
          {description && <div className="space-y-4 p-3 @[48rem]:p-5">
            <div className="flex flex-wrap items-start gap-3"><div className="min-w-0 flex-1"><h2 className="break-words text-xl font-semibold tracking-tight">{description.artifact.title}</h2><p className="mt-1 text-xs text-ink-faint">{t(description.artifact.managed ? "artifacts.managed" : "artifacts.document")} · {t("artifacts.version", { number: description.code.revisionNumber })}</p></div><div className="flex flex-wrap gap-2"><Button onClick={() => setPicker("reference")}>{t("artifacts.reference")}</Button>{description.snapshot.datasets.length > 0 && <Button onClick={() => setPicker("refresh")}>{t("artifacts.refresh")}</Button>}<Button onClick={() => setDeleting(true)}>{t("artifacts.delete")}</Button></div></div>
            <ArtifactCandidates description={description} />
            <nav className="flex flex-wrap gap-1 border-b border-line pb-2" aria-label={t("artifacts.sections")}>{(["preview", "data", "history"] as const).map((key) => <Button key={key} aria-pressed={panel === key} variant={panel === key ? "solid" : "ghost"} onClick={() => setPanel(key)}>{t(key === "preview" ? "artifacts.preview" : key === "data" ? "artifacts.data" : "artifacts.history")}</Button>)}</nav>
            {panel === "preview" && <dialog ref={previewRef} className={expanded ? "fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-void p-3 text-ink [app-region:no-drag]" : "relative m-0 flex min-h-[24rem] w-full max-w-none flex-col border-0 bg-transparent p-0 text-inherit"} role={expanded ? "dialog" : "presentation"} aria-modal={expanded || undefined} aria-label={description.artifact.title} onCancel={(event) => { event.preventDefault(); setExpanded(false); }}>
              <div className="mb-2 flex shrink-0 justify-end" style={expanded && IS_ELECTRON && OVERLAY_INSET > 0 ? { paddingRight: OVERLAY_INSET } : undefined}><Button onClick={() => setExpanded((old) => !old)}>{t(expanded ? "artifacts.collapse" : "artifacts.expand")}</Button></div>
              {preview && <ArtifactSurface source={preview.source} html={preview.html} title={description.artifact.title} managed={description.artifact.managed} className="min-h-[24rem] flex-1" onReload={() => setPreviewReload((value) => value + 1)} onEscape={() => setExpanded(false)} />}
            </dialog>}
            {panel === "data" && <div className="space-y-5"><ArtifactDataSources key={`${description.code.codeRevisionId}/${description.snapshot.dataSnapshotId}`} description={description} />
              {description.refreshRequests.filter((request) => request.status === "failed" || request.status === "interrupted" || !description.captures.some((capture) => capture.refreshRequestId === request.refreshRequestId)).map((request) => <p key={request.refreshRequestId} className="border-l-2 border-line-strong pl-3 text-sm text-ink-dim">{request.status === "failed" ? t("artifacts.captureFailed", {reason: request.failure?.message ?? ""}) : t(request.status === "interrupted" ? "artifacts.captureInterrupted" : "artifacts.awaitingCapture")}<span className="mt-1 block text-xs">{request.failure?.recordedAt ?? request.createdAt}</span></p>)}
              {description.captures.map((capture) => <ArtifactCaptureCard key={capture.captureId} description={description} capture={capture} />)}
            </div>}
            {panel === "history" && <section className="space-y-4"><p className="text-sm text-ink-dim">{t("artifacts.historyHint")}</p><label className="block space-y-1 text-sm"><span>{t("artifacts.codeVersion")}</span><select className="max-w-full rounded border border-line bg-raised p-2" value={description.code.codeRevisionId} onChange={(event) => open({ artifactId: description.artifact.artifactId, codeRevisionId: event.target.value, dataSnapshotId: description.snapshot.dataSnapshotId })}>{description.revisions.map((code) => <option key={code.codeRevisionId} value={code.codeRevisionId}>{t("artifacts.version", { number: code.revisionNumber })} · {code.createdAt}</option>)}</select></label><label className="block space-y-1 text-sm"><span>{t("artifacts.dataVersion")}</span><select className="max-w-full rounded border border-line bg-raised p-2" value={description.snapshot.dataSnapshotId} onChange={(event) => open({ artifactId: description.artifact.artifactId, codeRevisionId: description.code.codeRevisionId, dataSnapshotId: event.target.value })}>{description.snapshots.map((snapshot) => <option key={snapshot.dataSnapshotId} value={snapshot.dataSnapshotId}>{snapshot.createdAt}</option>)}</select></label><dl className="space-y-2 break-all text-xs text-ink-dim"><dt>{t("artifacts.source")}</dt><dd>{description.code.source.sessionId}<br />{description.code.source.toolCallId}<br />{description.code.source.sourceHash}</dd></dl></section>}
            {description.sourceTarget?.sessionId ? <Button onClick={() => { if (description.sourceTarget) void useStore.getState().openArtifactSource(description.sourceTarget); }}>{t("artifacts.openSource")}</Button> : <p className="text-xs text-ink-dim">{t("artifacts.sourceUnavailable")}</p>}
          </div>}
        </main>
      </div>
    </div>
    {description && picker && <ArtifactReferencePicker description={description} mode={picker} onClose={() => setPicker(null)} />}
    {deleting && description && <Modal labelledBy="artifact-delete-title" onClose={() => { if (!deleteBusy) setDeleting(false); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-delete-title" className="text-base font-semibold">{t("artifacts.deleteTitle")}</h2><p className="text-sm text-ink-mid">{t("artifacts.deleteHint")}</p>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={deleteBusy} onClick={() => setDeleting(false)}>{t("artifacts.cancel")}</Button><Button disabled={deleteBusy} variant="solid" onClick={() => void remove()}>{t("artifacts.delete")}</Button></div></div></Modal>}
  </section>;
}
