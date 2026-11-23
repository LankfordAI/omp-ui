import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ARTIFACT_LIMITS, ARTIFACT_PRUNE_KEEP_DEFAULTS, type ArtifactDescription, type ArtifactRecord } from "@omp-ui/core/artifacts";
import { composeHtmlArtifactDocument, htmlArtifactThemeCss } from "@omp-ui/core/html-artifact";
import { backend, displayMessage } from "../../backend";
import { formatBytes } from "../../lib/format";
import { downloadBlob, readAllPart, safeDownloadName } from "../../lib/artifact-parts";
import { useTheme } from "../../lib/themes";
import { useStore } from "../../store";
import { Button, IconButton, IconClose, Modal } from "../ui";
import { ArtifactSurface } from "./ArtifactSurface";
import { ArtifactDataSources } from "./ArtifactDataSources";
import { ArtifactReferencePicker } from "./ArtifactReferencePicker";
import { ArtifactCaptureCard } from "./ArtifactCaptureCard";
import { ArtifactCandidates } from "./ArtifactCandidates";
import { ARTIFACT_DRAG_MIME } from "../../lib/artifact-drag";
import { IS_ELECTRON } from "../../lib/platform";
import { OVERLAY_INSET } from "../../lib/window-controls";
import { findOwner } from "../../store/slices/view";

/** Bounded pages stay metadata-only; only the selected version mounts a guest. */
export function Artifacts() {
  const theme = useTheme();
  const selection = useStore((s) => s.artifacts);
  const revision = useStore((s) => s.artifactLibraryRevision);
  const open = useStore((s) => s.openArtifacts);
  const close = useStore((s) => s.closeArtifacts);
  const appState = useStore((s) => s.state);
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
  const [dismissing, setDismissing] = useState<string | null>(null);
  const [dismissBusy, setDismissBusy] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameTitle, setRenameTitle] = useState("");
  const [renameBusy, setRenameBusy] = useState(false);
  const [pruning, setPruning] = useState(false);
  const [pruneBusy, setPruneBusy] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);
  const [restoreBusy, setRestoreBusy] = useState(false);
  const [exportingHtml, setExportingHtml] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<"preview" | "data" | "history">("preview");
  const selectedId = selection?.artifactId;
  const queryRef = useRef(query);
  queryRef.current = query;
  const previewRef = useRef<HTMLDialogElement>(null);
  const selectedCode = selection?.codeRevisionId;
  const selectedSnapshot = selection?.dataSnapshotId;
  useEffect(() => {
    const requested = selection?.panel ?? (selection?.captureId ? "data" : null);
    if (requested) setPanel(requested);
  }, [selection?.captureId, selection?.panel]);
  useEffect(() => {
    if (!selection?.captureId || panel !== "data" || !description) return;
    const frame = requestAnimationFrame(() => document.getElementById(`artifact-capture-${selection.captureId}`)?.scrollIntoView({ block: "start" }));
    return () => cancelAnimationFrame(frame);
  }, [selection?.captureId, panel, description?.artifact.artifactId]);
  useEffect(() => {
    let canceled = false;
    const timer = window.setTimeout(() => {
      setLoading(true); setError(null);
      void backend.artifactList({ query, limit: 40 }).then((page) => { if (!canceled) { setRows(page.artifacts); setCursor(page.nextCursor); setQuotaUsed(page.libraryBytesUsed); } }).catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); }).finally(() => { if (!canceled) setLoading(false); });
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
        if (page.totalBytes > ARTIFACT_LIMITS.envelopeBytes) throw new Error("The definition is too large to preview.");
        text += page.text;
        if (page.nextOffset === null) break;
        if (page.nextOffset <= offset) throw new Error("The source returned an invalid data page.");
        offset = page.nextOffset;
      } while (!canceled);
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null || !("html" in parsed) || typeof parsed.html !== "string") throw new Error("The saved definition is invalid.");
      if (!canceled) setPreview({ html: parsed.html, source: { artifactId: selectedId, codeRevisionId: next.code.codeRevisionId, dataSnapshotId: next.snapshot.dataSnapshotId } });
    })().catch((reason: unknown) => { if (!canceled) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [selectedId, selectedCode, selectedSnapshot, panel, previewReload]);
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
  const dismiss = async (): Promise<void> => {
    if (!dismissing) return;
    setDismissBusy(true);
    try { await backend.artifactDismissRefresh({ refreshRequestId: dismissing }); setDismissing(null); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setDismissBusy(false); }
  };
  const rename = async (): Promise<void> => {
    if (!description) return;
    setRenameBusy(true);
    try { await backend.artifactRename({ artifactId: description.artifact.artifactId, expectedGeneration: description.artifact.generation, title: renameTitle }); setRenaming(false); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setRenameBusy(false); }
  };
  const prune = async (): Promise<void> => {
    if (!description) return;
    setPruneBusy(true);
    try { await backend.artifactPrune({ artifactId: description.artifact.artifactId, expectedGeneration: description.artifact.generation, ...ARTIFACT_PRUNE_KEEP_DEFAULTS }); setPruning(false); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setPruneBusy(false); }
  };
  const restore = async (): Promise<void> => {
    if (!description || restoring === null) return;
    setRestoreBusy(true);
    try { await backend.artifactRestoreSnapshot({ artifactId: description.artifact.artifactId, dataSnapshotId: restoring, expectedCodeRevisionId: description.artifact.currentCodeRevisionId }); setRestoring(null); useStore.getState().invalidateArtifactLibrary(); }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setRestoreBusy(false); }
  };
  const exportHtml = async (): Promise<void> => {
    if (!description) return;
    setExportBusy(true);
    try {
      if (IS_ELECTRON) await backend.artifactExportHtmlSource({ artifactId: description.artifact.artifactId, codeRevisionId: description.code.codeRevisionId, theme: { dark: theme.dark, tokens: theme.tokens } });
      else {
        const page = await readAllPart({ artifactId: description.artifact.artifactId, codeRevisionId: description.code.codeRevisionId, dataSnapshotId: description.snapshot.dataSnapshotId, part: "definition" });
        const parsed: unknown = JSON.parse(page);
        const html = typeof parsed === "object" && parsed !== null && "html" in parsed && typeof parsed.html === "string" ? parsed.html : null;
        if (html === null) throw new Error("The saved definition is invalid.");
        downloadBlob(safeDownloadName(description.artifact.title, "html"), "text/html", composeHtmlArtifactDocument(html, htmlArtifactThemeCss(theme.tokens, theme.dark), false));
      }
      setExportingHtml(false);
    }
    catch (reason) { setError(displayMessage(reason)); }
    finally { setExportBusy(false); }
  };
  const [quotaUsed, setQuotaUsed] = useState<number | null>(null);
  return <section className="absolute inset-0 flex min-h-0 min-w-0 flex-col bg-void" aria-label="Artifacts">
    <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-4 py-3"><h1 className="min-w-0 flex-1 text-lg font-semibold tracking-tight">Artifacts</h1>{quotaUsed !== null && <span className={`text-xs ${quotaUsed > ARTIFACT_LIMITS.libraryBytes * 0.8 ? "text-rose" : "text-ink-dim"}`}>{`Library ${formatBytes(quotaUsed)} of ${formatBytes(ARTIFACT_LIMITS.libraryBytes)}`}{quotaUsed > ARTIFACT_LIMITS.libraryBytes * 0.8 && <span className="ml-2">Free space with History → Prune old versions.</span>}</span>}<IconButton label="close dialog" onClick={close}><IconClose /></IconButton></header>
    <div className="flex min-h-0 flex-1 flex-col @container">
      <div className="flex min-h-0 flex-1 flex-col @[48rem]:flex-row">
        <aside className={`flex shrink-0 flex-col border-line @[48rem]:w-64 @[48rem]:border-r ${selectedId ? "max-h-40 @[48rem]:max-h-none" : "min-h-0 flex-1 @[48rem]:flex-none"}`}>
          <label className="block shrink-0 p-3"><span className="sr-only">Search artifacts</span><input type="search" placeholder="Search artifacts" value={query} onChange={(event) => setQuery(event.target.value)} className="w-full min-w-0 rounded border border-line bg-raised px-3 py-2 text-sm outline-none focus-visible:border-copper" /></label>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2" aria-label="Kept artifacts">
            {rows.map((row) => <button type="button" key={row.artifactId} draggable onDragStart={(event) => { event.dataTransfer.setData(ARTIFACT_DRAG_MIME, JSON.stringify({ artifactId: row.artifactId, codeRevisionId: row.currentCodeRevisionId, dataSnapshotId: row.currentDataSnapshotId, instanceId: null })); event.dataTransfer.effectAllowed = "copy"; }} aria-current={row.artifactId === selectedId ? "page" : undefined} onClick={() => open({ artifactId: row.artifactId })} className={`block w-full rounded px-2 py-2 text-left focus-visible:outline focus-visible:outline-2 focus-visible:outline-copper ${row.artifactId === selectedId ? "bg-hover text-ink" : "text-ink-mid hover:bg-hover"}`}>
              <span className="flex items-baseline gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium">{row.title}</span><span className="shrink-0 text-xs text-ink-dim">Kept</span></span>
              <span className="block truncate text-xs text-ink-dim" title={row.originContext.kind === "project" ? row.originContext.path : undefined}>{row.originContext.kind === "chat" ? "Chat" : row.originContext.label}</span>
              {row.originContext.kind === "project" && <span className="block truncate text-xs text-ink-faint">{row.originContext.path}</span>}
              <span className="block text-xs text-ink-faint">{new Date(row.updatedAt).toLocaleString()}</span>
            </button>)}
            {!loading && rows.length === 0 && <p className="px-2 py-4 text-sm text-ink-dim">{query ? "No artifacts match this search." : "Keep an artifact from a successful native session to see it here."}</p>}
            {cursor && <Button className="mt-2 w-full" disabled={loading} onClick={() => void loadMore()}>Load more</Button>}
          </div>
        </aside>
        <main className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto [scrollbar-gutter:stable]">
          {error && <p role="alert" className="m-4 shrink-0 break-words rounded border border-rose/30 p-3 text-sm text-rose">{error}</p>}
          {!selectedId && <div className="mx-auto max-w-lg px-5 py-12"><h2 className="text-xl font-semibold">Your kept work, independent of the session</h2><p className="mt-3 text-sm leading-relaxed text-ink-dim">Select an artifact to open its saved version, inspect where its data came from, or reference it in an ordinary session. There is no builder here; artifacts begin in your sessions.</p></div>}
          {description && <div className="flex flex-1 flex-col gap-4 p-3 @[48rem]:p-5">
            <div className="flex shrink-0 flex-wrap items-start gap-3"><div className="min-w-0 grow basis-48"><h2 className="break-words text-xl font-semibold tracking-tight">{description.artifact.title}</h2><p className="mt-1 text-xs text-ink-faint" title="Retained (logical) footprint of this artifact. Shared payloads mean per-artifact figures do not sum to the library total.">{description.artifact.managed ? "Managed artifact" : "Document"} · {`Revision ${description.code.revisionNumber}`} · {`Retained ≈ ${formatBytes(description.retainedBytes)} of ${formatBytes(ARTIFACT_LIMITS.artifactBytes)}`}</p></div><div className="flex flex-wrap gap-2"><Button onClick={() => setPicker("reference")}>Reference in session</Button>{description.snapshot.datasets.length > 0 && <Button onClick={() => setPicker("refresh")}>Refresh data</Button>}<Button onClick={() => { setRenaming(true); setRenameTitle(description.artifact.title); }}>Rename</Button><Button onClick={() => setExportingHtml(true)}>Export HTML source</Button><Button onClick={() => setDeleting(true)}>Delete artifact</Button></div></div>
            <div className="shrink-0"><ArtifactCandidates description={description} /></div>
            <div className="shrink-0">{description.sourceTarget?.sessionId ? <Button onClick={() => { if (description.sourceTarget) void useStore.getState().openArtifactSource(description.sourceTarget); }}>Open exact source</Button> : <p className="text-xs text-ink-dim">The exact source session is unavailable. Kept code and data remain available.</p>}</div>
            <nav className="flex shrink-0 flex-wrap gap-1 border-b border-line pb-2" aria-label="Artifact sections">{(["preview", "data", "history"] as const).map((key) => <Button key={key} selected={panel === key} onClick={() => setPanel(key)}>{key === "preview" ? "Preview" : key === "data" ? "Saved data" : "Version history"}</Button>)}</nav>
            {panel === "preview" && <dialog ref={previewRef} className={expanded ? "fixed inset-0 m-0 flex h-dvh max-h-none w-screen max-w-none flex-col border-0 bg-void p-3 text-ink [app-region:no-drag]" : "relative m-0 flex min-h-40 min-w-0 w-full max-w-none flex-1 flex-col border-0 bg-transparent p-0 text-inherit"} role={expanded ? "dialog" : "presentation"} aria-modal={expanded || undefined} aria-label={description.artifact.title} onCancel={(event) => { event.preventDefault(); setExpanded(false); }}>
              <div className="mb-2 flex shrink-0 justify-end" style={expanded && IS_ELECTRON && OVERLAY_INSET > 0 ? { paddingRight: OVERLAY_INSET } : undefined}><Button onClick={() => setExpanded((old) => !old)}>{expanded ? "Close expanded view" : "Expand"}</Button></div>
              {preview && <ArtifactSurface source={preview.source} html={preview.html} title={description.artifact.title} managed={description.artifact.managed} inline={true} className="min-h-0 min-w-0 flex-1" onReload={() => setPreviewReload((value) => value + 1)} onEscape={() => setExpanded(false)} />}
            </dialog>}
            {panel === "data" && <div className="shrink-0 space-y-5"><ArtifactDataSources key={`${description.code.codeRevisionId}/${description.snapshot.dataSnapshotId}`} description={description} />
              {description.refreshRequests.filter((request) => request.status !== "dismissed").map((request) => <p key={request.refreshRequestId} className="border-l-2 border-line-strong pl-3 text-sm text-ink-dim">{request.status === "failed" ? `Not applied: ${request.failure?.message ?? ""}. Last saved data is unchanged.` : request.status === "interrupted" ? "The refresh session stopped before reporting captured data. Last saved data is unchanged; start a new refresh to retry." : request.status === "applied" ? "Applied" : "Awaiting a capture from the session. Nothing has been applied."}<span className="mt-1 block text-xs">{request.failure?.recordedAt ?? request.createdAt}</span>{findOwner(appState, request.targetTabId) !== undefined && <Button variant="ghost" onClick={() => void useStore.getState().openSession(request.targetTabId)}>View run</Button>}{(request.status === "awaiting" || request.status === "failed" || request.status === "interrupted") && <Button variant="ghost" onClick={() => setDismissing(request.refreshRequestId)}>Dismiss</Button>}</p>)}
              {description.captures.map((capture) => <ArtifactCaptureCard key={capture.captureId} description={description} capture={capture} />)}
            </div>}
            {panel === "history" && <section className="shrink-0 space-y-4"><p className="text-sm text-ink-dim">Code and data versions are immutable. Choose the exact pair to inspect or reference; this does not replace the current version.</p><label className="block space-y-1 text-sm"><span>Code revision</span><select className="max-w-full rounded border border-line bg-raised p-2" value={description.code.codeRevisionId} onChange={(event) => open({ artifactId: description.artifact.artifactId, codeRevisionId: event.target.value, dataSnapshotId: description.snapshot.dataSnapshotId })}>{description.revisions.map((code) => <option key={code.codeRevisionId} value={code.codeRevisionId}>{`Revision ${code.revisionNumber}`} · {code.createdAt}</option>)}</select></label>{description.artifact.managed && <label className="block space-y-1 text-sm"><span>Data snapshot</span><select className="max-w-full rounded border border-line bg-raised p-2" value={description.snapshot.dataSnapshotId} onChange={(event) => open({ artifactId: description.artifact.artifactId, codeRevisionId: description.code.codeRevisionId, dataSnapshotId: event.target.value })}>{description.snapshots.map((snapshot) => <option key={snapshot.dataSnapshotId} value={snapshot.dataSnapshotId}>{new Date(snapshot.createdAt).toLocaleString()} · {snapshot.cause === "user-edit" ? "edit" : snapshot.cause === "refresh" ? "refresh" : snapshot.cause === "restore" ? "restore" : "initial"}</option>)}</select></label>}{description.artifact.managed && description.snapshot.dataSnapshotId !== description.artifact.currentDataSnapshotId && <div className="space-y-2"><Button variant="solid" onClick={() => setRestoring(description.snapshot.dataSnapshotId)}>Restore this version as new history</Button><p className="text-xs text-ink-dim">Restoring copies this version into a new current version. Manual edits made since then stay in history but are superseded.</p></div>}<div className="space-y-1"><Button onClick={() => setPruning(true)}>Prune old versions</Button><p className="text-xs text-ink-dim">{`Deletes old history beyond the newest ${ARTIFACT_PRUNE_KEEP_DEFAULTS.keepRevisions} code versions and ${ARTIFACT_PRUNE_KEEP_DEFAULTS.keepSnapshots} data versions. Referenced versions are always kept.`}</p></div><dl className="space-y-2 break-all text-xs text-ink-dim"><dt>Source</dt><dd>{description.code.source.sessionId}<br />{description.code.source.toolCallId}<br />{description.code.source.sourceHash}</dd></dl></section>}
          </div>}
        </main>
      </div>
    </div>
    {description && picker && <ArtifactReferencePicker description={description} mode={picker} onClose={() => setPicker(null)} onRefreshStarted={() => setPanel("data")} />}
    {deleting && description && <Modal labelledBy="artifact-delete-title" onClose={() => { if (!deleteBusy) setDeleting(false); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-delete-title" className="text-base font-semibold">Delete this artifact and its history?</h2><p className="text-sm text-ink-mid">Deletes kept code, saved state, data snapshots, capture drafts, and reference grants. Session transcripts remain, but old references stop resolving. This cannot be undone.</p>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={deleteBusy} onClick={() => setDeleting(false)}>Cancel</Button><Button disabled={deleteBusy} variant="solid" onClick={() => void remove()}>Delete artifact</Button></div></div></Modal>}
    {dismissing !== null && <Modal labelledBy="artifact-dismiss-title" onClose={() => { if (!dismissBusy) setDismissing(null); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-dismiss-title" className="text-base font-semibold">Dismiss this refresh request?</h2><p className="text-sm text-ink-mid">The request stops appearing here and later captures for it will be refused. The run itself is not stopped — it keeps running until it finishes on its own.</p>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={dismissBusy} onClick={() => setDismissing(null)}>Cancel</Button><Button disabled={dismissBusy} variant="solid" onClick={() => void dismiss()}>Dismiss</Button></div></div></Modal>}
    {renaming && description && <Modal labelledBy="artifact-rename-title" onClose={() => { if (!renameBusy) setRenaming(false); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-rename-title" className="text-base font-semibold">Rename artifact</h2><p className="text-sm text-ink-mid">Composer chips and transcript cards keep showing the title from when the artifact was kept until they are re-attached.</p><label className="block space-y-1 text-sm"><span className="sr-only">Rename artifact</span><input type="text" maxLength={ARTIFACT_LIMITS.titleChars} value={renameTitle} onChange={(event) => setRenameTitle(event.target.value)} className="w-full min-w-0 rounded border border-line bg-raised px-3 py-2 text-sm outline-none focus-visible:border-copper" /></label>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={renameBusy} onClick={() => setRenaming(false)}>Cancel</Button><Button disabled={renameBusy || !renameTitle.trim()} variant="solid" onClick={() => void rename()}>Rename</Button></div></div></Modal>}
    {pruning && description && <Modal labelledBy="artifact-prune-title" onClose={() => { if (!pruneBusy) setPruning(false); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-prune-title" className="text-base font-semibold">Prune old versions?</h2><p className="text-sm text-ink-mid">{`The newest ${ARTIFACT_PRUNE_KEEP_DEFAULTS.keepRevisions} code versions and ${ARTIFACT_PRUNE_KEEP_DEFAULTS.keepSnapshots} data versions are kept, along with every version a reference, capture, or candidate still uses.`}</p>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={pruneBusy} onClick={() => setPruning(false)}>Cancel</Button><Button disabled={pruneBusy} variant="solid" onClick={() => void prune()}>Prune old versions</Button></div></div></Modal>}
    {exportingHtml && description && <Modal labelledBy="artifact-export-html-title" onClose={() => { if (!exportBusy) setExportingHtml(false); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-export-html-title" className="text-base font-semibold">Export HTML source?</h2><p className="text-sm text-ink-mid">The saved file runs outside omp-ui's protections, in a normal browser tab with full network access. Interactive behavior is not included — this exports the static (scripts-off) document only.</p>{description.artifact.managed && <p className="text-sm text-ink-dim">Saved state and datasets are not embedded in the exported file.</p>}{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={exportBusy} onClick={() => setExportingHtml(false)}>Cancel</Button><Button disabled={exportBusy} variant="solid" onClick={() => void exportHtml()}>Export HTML source</Button></div></div></Modal>}
    {restoring !== null && description && <Modal labelledBy="artifact-restore-title" onClose={() => { if (!restoreBusy) setRestoring(null); }} width="w-[min(30rem,96vw)]"><div className="space-y-4 p-4"><h2 id="artifact-restore-title" className="text-base font-semibold">Restore this version?</h2><p className="text-sm text-ink-mid">This creates a new current data version from the selected one. Manual edits since then are superseded (not deleted — history keeps them). In-flight refresh captures will fail their dataset check and need a new refresh.</p>{error && <p role="alert" className="text-sm text-rose">{error}</p>}<div className="flex flex-wrap justify-end gap-2"><Button disabled={restoreBusy} onClick={() => setRestoring(null)}>Cancel</Button><Button disabled={restoreBusy} variant="solid" onClick={() => void restore()}>Restore this version as new history</Button></div></div></Modal>}
  </section>;
}
