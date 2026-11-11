import { createElement, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  composeHtmlArtifactDocument,
  HEIGHT_HASH_PREFIX,
  HTML_ARTIFACT_MAX_HEIGHT,
  HTML_ARTIFACT_MIN_HEIGHT,
  HTML_ARTIFACT_PARTITION,
  htmlArtifactDataUrl,
  htmlArtifactThemeCss,
  parseHtmlArtifactArgs,
} from "@omp-ui/core/html-artifact";
import { artifactCanonicalJson, artifactFailure, validateArtifactJson, ARTIFACT_LIMITS, type ArtifactSourceLookup } from "@omp-ui/core/artifacts";
import { backend, displayMessage } from "../backend";
import { cn } from "../lib/cn";
import { strField } from "../lib/fields";
import { useT } from "../lib/i18n";
import { IS_ELECTRON } from "../lib/platform";
import type { ToolItem } from "../lib/transcript";
import { useTheme } from "../lib/themes";
import { OVERLAY_INSET } from "../lib/window-controls";
import { findOwner, useStore } from "../store";
import { linkify } from "./Markdown";
import { Slab } from "./ToolCard";
import { Button, ICON_STROKE, IconButton, IconClose, Modal, ProgressSweep } from "./ui";
import { ArtifactSurface as ManagedArtifactSurface } from "./artifacts/ArtifactSurface";
import { ArtifactContractDiff } from "./artifacts/ArtifactContractDiff";

function ArtifactGlyph({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className={cn("size-3.5 shrink-0", className)} {...ICON_STROKE}>
      <path d="M2.5 3.5h11v9h-11zM2.5 6h11M5.5 8.5 4 10l1.5 1.5M10.5 8.5 12 10l-1.5 1.5" />
    </svg>
  );
}

function ExpandGlyph() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-3.5" {...ICON_STROKE}>
      <path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" />
    </svg>
  );
}

/**
 * The document surface. Desktop with scripts on: a `<webview>` guest on the
 * locked artifact partition (main's html-artifact-guard: dead proxy, request
 * filter, no UDP, no permissions, no navigation) — the CSP alone cannot stop
 * WebRTC. Scripts off, or a browser client (no partition omp-ui controls): a
 * plain iframe with an empty sandbox and a script-src 'none' CSP, the plan
 * frames' posture (ADR-0082).
 *
 * Only the guest measures itself: the stub reports its content height as
 * `#omph<px>` on its own URL, which Chromium surfaces here as a
 * `did-navigate-in-page` event. The static iframe has no stub, so it keeps
 * whatever height the caller asked for.
 */
function ArtifactSurface({
  html,
  title,
  className,
  style,
  onMeasured,
}: {
  html: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  onMeasured?: (px: number) => void;
}) {
  const t = useT();
  const theme = useTheme();
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  const scriptsSetting = useStore((s) => s.state?.htmlArtifactScripts ?? true);
  const scripts = scriptsSetting && IS_ELECTRON;
  const doc = useMemo(
    () => composeHtmlArtifactDocument(html, htmlArtifactThemeCss(theme.tokens, theme.dark), scripts),
    [html, theme, scripts],
  );
  // Memoized: a webview re-navigates whenever its src attribute changes, so
  // only a new document (edit, theme switch) may produce a new URL.
  const src = useMemo(() => (scripts ? htmlArtifactDataUrl(doc) : null), [doc, scripts]);
  const frameClass = cn("block w-full", className);
  const ref = useRef<HTMLElement | null>(null);
  // The listener lives across renders (attached once per guest element), so
  // read the callback through a ref instead of closing over one render's prop.
  const measuredCb = useRef(onMeasured);
  measuredCb.current = onMeasured;
  useEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const onHeight = (event: Event): void => {
      // Electron surfaces the guest's fragment navigations with the target URL
      // on the event; React's DOM Event type knows nothing of it.
      const url = "url" in event && typeof event.url === "string" ? event.url : "";
      const at = url.lastIndexOf(HEIGHT_HASH_PREFIX);
      if (at === -1) return;
      const px = Number(url.slice(at + HEIGHT_HASH_PREFIX.length));
      if (Number.isFinite(px)) measuredCb.current?.(Math.round(px));
    };
    // Trusted failure chrome for plain guests: a crashed or failed-to-load
    // guest otherwise shows a dead rectangle with no explanation. Host-owned
    // text, same posture as `artifacts.staticHint`; no new guest capability.
    const onGone = (): void => setFailed(true);
    el.addEventListener("did-navigate-in-page", onHeight);
    el.addEventListener("did-fail-load", onGone);
    el.addEventListener("render-process-gone", onGone);
    return () => {
      el.removeEventListener("did-navigate-in-page", onHeight);
      el.removeEventListener("did-fail-load", onGone);
      el.removeEventListener("render-process-gone", onGone);
    };
  }, [src, reload]);
  if (failed) {
    return (
      <div role="alert" className={cn(frameClass, "flex items-center gap-2 border border-line bg-surface px-3 text-xs text-ink-dim")} style={style}>
        <span className="min-w-0 flex-1 break-words">{t("artifacts.guestFailed")}</span>
        <Button onClick={() => { setFailed(false); setReload((value) => value + 1); }}>{t("artifacts.reload")}</Button>
      </div>
    );
  }
  if (src === null) {
    return <iframe title={title} sandbox="" srcDoc={doc} className={frameClass} style={style} />;
  }
  return createElement("webview", {
    key: reload,
    ref,
    src,
    partition: HTML_ARTIFACT_PARTITION,
    title,
    className: frameClass,
    style: { display: "flex", ...style },
  });
}

function ArtifactViewer({ html, title, hint, onClose }: { html: string; title: string; hint?: string; onClose: () => void }) {
  const t = useT();
  const titleId = useId();
  return (
    <Modal
      onClose={onClose}
      labelledBy={titleId}
      width="w-[min(1400px,96vw)]"
      mobile="fullscreen"
      className="flex h-[min(92dvh,var(--app-viewport-height,92dvh))] max-h-[min(92dvh,var(--app-viewport-height,92dvh))] flex-col"
    >
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <ArtifactGlyph className="text-ink-dim" />
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {title}
        </h2>
        {hint !== undefined && <span className="max-w-[36rem] break-words text-xs text-ink-faint">{hint}</span>}
        <IconButton label={t("common.overlay.close")} onClick={onClose}>
          <IconClose />
        </IconButton>
      </header>
      <div className="flex min-h-0 flex-1 p-2">
        <ArtifactSurface html={html} title={title} className="min-h-0 flex-1" />
      </div>
    </Modal>
  );
}

function ArtifactActions({ item, tabId, title, onResolvedDraft, onHistorical, container }: { item: ToolItem; tabId: string; title: string; onResolvedDraft: (draftId: string | null) => void; onHistorical: (value: boolean) => void; container: HTMLElement | null }) {
  const t = useT();
  const enabled = useStore((s) => s.state?.artifactLibraryEnabled === true);
  const owner = useStore((s) => findOwner(s.state, tabId));
  const revision = useStore((s) => s.artifactLibraryRevision);
  const [lookup, setLookup] = useState<ArtifactSourceLookup | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [titling, setTitling] = useState(false);
  const [keepTitle, setKeepTitle] = useState(title);
  const resolution = useRef(0);
  const native = owner?.instanceId === null && owner.record.mode === "rpc-ui";
  useEffect(() => {
    let canceled = false;
    const generation = ++resolution.current;
    if (!enabled || !native || item.status !== "done") { onResolvedDraft(null); return; }
    void (async () => {
      let sourceHash = item.artifactDraft?.sourceHash;
      if (!sourceHash) {
        validateArtifactJson(item.args);
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(artifactCanonicalJson(item.args)));
        sourceHash = [...new Uint8Array(digest)].map((value) => value.toString(16).padStart(2, "0")).join("");
      }
      if (owner === undefined) return;
      const next = await backend.artifactResolveSource({ tabId, sessionId: owner.record.sessionId, toolCallId: item.toolCallId || null, sourceHash, ...(item.artifactDraft ? { draftId: item.artifactDraft.draftId } : {}) });
      if (canceled || generation !== resolution.current) return;
      setLookup(next); setError(null);
      if (next.status === "draft") { onHistorical(false); onResolvedDraft(next.draft.draftId); }
      else if (next.status === "kept") onHistorical(true);
      else { onResolvedDraft(null); onHistorical(false); }
    })().catch((reason: unknown) => { if (!canceled && generation === resolution.current) setError(displayMessage(reason)); });
    return () => { canceled = true; };
  }, [enabled, native, owner, item.args, item.artifactDraft, item.status, item.toolCallId, tabId, revision, onResolvedDraft, onHistorical]);
  const keep = async (accept: boolean): Promise<void> => {
    if (lookup?.status !== "draft") return;
    resolution.current++;
    const focused = document.activeElement;
    setBusy(true); setError(null);
    try {
      const draft = lookup.draft;
      const kept = accept && lookup.candidate ? await backend.artifactAcceptRevision({ draftId: draft.draftId, expectedCodeRevisionId: lookup.candidate.expectedCodeRevisionId }) : await backend.artifactKeep({ draftId: draft.draftId, title: keepTitle.trim() || title });
      resolution.current++;
      if (accept && document.activeElement === focused) container?.querySelector<HTMLButtonElement>("button")?.focus();
      // Keep the loaded guest as a revoked historical preview; never mount a second writer.
      onHistorical(true); setLookup({status: "kept", artifact: kept});
      useStore.getState().invalidateArtifactLibrary();
    } catch (reason) { setError(artifactFailure(reason)?.error === "over-limit" ? t("artifacts.overLimit") : displayMessage(reason)); }
    finally { setBusy(false); }
  };
  if (!enabled) return item.args && typeof item.args === "object" && "artifact" in item.args ? <p className="mt-2 text-xs text-ink-dim">{t("artifacts.disabledHint")}</p> : null;
  if (!native) return <p className="mt-2 text-xs text-ink-dim">{t("artifacts.foreignHint")}</p>;
  const publishable = lookup?.status === "draft" || lookup?.status === "kept" ? lookup : null;
  return <>
    {container && publishable && createPortal(<>
      <span className="text-xs text-ink-dim">{t(publishable.status === "kept" ? "artifacts.kept" : publishable.candidate ? "artifacts.draftCandidate" : "artifacts.draft")}</span>
      {titling && publishable.status === "draft"
        ? <>
          <label className="flex items-center gap-1"><span className="sr-only">{t("artifacts.keepTitleLabel")}</span><input autoFocus type="text" maxLength={ARTIFACT_LIMITS.titleChars} value={keepTitle} onChange={(event) => setKeepTitle(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); setTitling(false); void keep(false); } if (event.key === "Escape") { event.preventDefault(); setTitling(false); } }} className="w-48 min-w-0 rounded border border-line bg-raised px-2 py-0.5 text-xs outline-none focus-visible:border-copper" aria-label={t("artifacts.keepTitleLabel")} /></label>
          <Button disabled={busy} onClick={() => { setTitling(false); void keep(false); }}>{t("artifacts.keepConfirm")}</Button>
          <Button disabled={busy} onClick={() => setTitling(false)}>{t("artifacts.cancel")}</Button>
        </>
        : <>
      <Button disabled={busy} onClick={() => { if (publishable.status === "kept") useStore.getState().openArtifacts({artifactId: publishable.artifact.artifactId}); else if (publishable.draft.artifactId) void keep(false); else { setKeepTitle(title); setTitling(true); } }}>{t(publishable.status === "kept" ? "artifacts.openLibrary" : publishable.draft.artifactId ? "artifacts.keepAsNew" : "artifacts.keep")}</Button>
      {publishable.status === "draft" && publishable.candidate?.compatible && !publishable.candidate.stale && <Button disabled={busy} onClick={() => void keep(true)}>{t("artifacts.acceptRevision")}</Button>}
        </>}
    </>, container)}
    {lookup?.status === "draft" && lookup.candidate && <div className="mt-2 space-y-1 text-xs text-ink-dim"><p>{t(lookup.candidate.stale ? "artifacts.candidateStale" : lookup.candidate.compatible ? "artifacts.contractHint" : "artifacts.candidateSchema")}</p><details open={!lookup.candidate.compatible}><summary className="cursor-pointer">{t("artifacts.contractChanges")}</summary><div className="break-words"><ArtifactContractDiff current={lookup.candidate.currentDefinition} candidate={lookup.candidate.definition} /></div></details></div>}
    {lookup?.status === "missing" && <p className="mt-2 text-xs text-ink-dim">{t("artifacts.sourceUnavailable")}</p>}
    {lookup?.status === "deleted" && <p className="mt-2 text-xs text-ink-dim">{t("artifacts.wasDeleted")}</p>}
    {error && <p role="alert" className="mt-2 text-xs text-rose">{error}</p>}
  </>;
}

/**
 * An interactive HTML artifact (issue #994, flush posture issue #1041): the
 * document the agent passed to `omp-ui_render_html`. Plain documents replay
 * from arguments; managed data comes only from a main-resolved draft. The
 * same inline managed guest expands through the native top layer, with no
 * duplicate writer. It sizes itself: the guest stub reports its
 * content height over the `#omph` fragment channel, clamped between the core
 * bounds; before the first report the requested hint height shows. The expand
 * pill surfaces on hover only, so the artifact owns the space. While the
 * model streams the html, or when the tool refused it, the card shows status
 * and the reason instead of a document. While `deferred`, the card shows a
 * one-line note instead of the document, and mounts no guest and no Keep actions.
 */
export function HtmlArtifactCard({ item, tabId, deferred = false }: { item: ToolItem; tabId?: string; deferred?: boolean }) {
  const t = useT();
  const titleId = useId();
  const parsed = useMemo(() => parseHtmlArtifactArgs(item.args), [item.args]);
  const [measured, setMeasured] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [historical, setHistorical] = useState(false);
  const [actions, setActions] = useState<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const visible = useStore((s) => tabId === undefined || (s.activeTabId === tabId && s.artifacts === null && s.stats === null && s.lab === null && s.fleet === null && s.fleetTerminal === null));
  useEffect(() => { if (!visible) setExpanded(false); }, [visible]);
  // One-way mount latch for plain guests: mount when the card first approaches
  // the scroll viewport, never unmount on scroll-out. Scroll-driven teardown was
  // rejected (height/anchor thrash against `overflow-anchor: none` follow-mode,
  // broker rate-limit/ticket burn, and uncapturable guest interactive state —
  // ADR-0090). The placeholder before the first mount uses the agent hint
  // height; the first `#omph` report resizes it once, off-screen thanks to the
  // generous margin.
  const rowRef = useRef<HTMLDivElement | null>(null);
  const [latched, setLatched] = useState(false);
  useEffect(() => {
    if (latched || !visible) return;
    const row = rowRef.current;
    if (row === null || typeof IntersectionObserver === "undefined") { setLatched(true); return; }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setLatched(true); observer.disconnect(); }
    }, { rootMargin: "1200px 0px" });
    observer.observe(row);
    return () => observer.disconnect();
  }, [latched, visible]);
  const title = parsed.ok ? parsed.args.title : (strField(item.args, "title") ?? t("transcript.artifact.untitled"));
  const shown = item.status === "done" && parsed.ok ? parsed.args : null;
  const managed = shown?.artifact !== undefined;
  // Scripts-off hint (issue: post-#994 follow-through): the one sanctioned
  // exception to flush posture — only when a script-bearing document renders
  // statically, so a reader knows interactive behavior silently did not run.
  const scriptsSetting = useStore((s) => s.state?.htmlArtifactScripts ?? true);
  const scriptsOffHint = shown !== null && !managed && !(scriptsSetting && IS_ELECTRON) && /<script\b|\son[a-z]+\s*=/i.test(shown.html);
  const frameHeight = shown === null ? 0 : Math.min(Math.max(measured ?? shown.height, HTML_ARTIFACT_MIN_HEIGHT), HTML_ARTIFACT_MAX_HEIGHT);
  const slab = shown === null && item.status !== "running" && item.resultText ? item.resultText : null;
  const html = shown?.html;
  useEffect(() => { setMeasured(null); setDraftId(null); setHistorical(false); }, [html, item.toolCallId]);
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!expanded || !managed || !visible || !dialog) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    // Native top layer escapes transcript containment without reparenting/destroying the webview.
    dialog.showModal();
    dialog.querySelector<HTMLButtonElement>("button[aria-label]")?.focus();
    return () => { if (dialog.open) dialog.close(); if (opener?.isConnected) opener.focus(); };
  }, [expanded, managed, visible]);
  if (deferred && shown !== null) {
    return (
      <p className="flex items-center gap-1.5 text-xs text-ink-faint animate-rise">
        <ArtifactGlyph />
        {t("transcript.artifact.deferred", { title })}
      </p>
    );
  }
  return <>
    {shown !== null && <div ref={rowRef} className="group relative animate-rise">
      <div style={managed && expanded ? {height: frameHeight} : undefined}>
        {createElement(managed ? "dialog" : "div", {
          ref: managed ? dialogRef : undefined,
          className: managed ? expanded ? cn("fixed inset-3 m-0 flex h-[calc(100dvh-1.5rem)] w-[calc(100vw-1.5rem)] max-h-none max-w-none flex-col border-0 bg-void p-3 text-ink backdrop:bg-void/70 [app-region:no-drag]", IS_ELECTRON && "pt-9") : "relative m-0 block w-full max-w-none border-0 bg-transparent p-0 text-inherit" : "relative",
          role: managed ? expanded ? "dialog" : "presentation" : undefined,
          "aria-modal": managed && expanded || undefined,
          "aria-labelledby": managed && expanded ? titleId : undefined,
          onCancel: managed ? (event: {preventDefault(): void}) => { event.preventDefault(); setExpanded(false); } : undefined,
        }, <>
          <h3 id={titleId} className="sr-only">{title}</h3>
          {managed ? <ManagedArtifactSurface key="managed" html={shown.html} title={title} source={visible && draftId ? {draftId} : undefined} historical={historical} inline className={expanded ? "min-h-0 flex-1" : undefined} style={expanded ? undefined : {height: frameHeight}} onMeasured={expanded ? undefined : setMeasured} onEscape={() => setExpanded(false)} /> : visible && latched && !expanded
            ? <ArtifactSurface html={shown.html} title={title} style={{height: frameHeight}} onMeasured={setMeasured} />
            : <div aria-hidden className="w-full" style={{height: frameHeight}} />}
          <div className="pointer-events-none absolute inset-x-0 top-1.5 flex justify-end px-1.5" style={managed && expanded && IS_ELECTRON && OVERLAY_INSET > 0 ? { paddingRight: OVERLAY_INSET } : undefined}><div className="pointer-events-auto flex max-w-[calc(100vw-2rem)] flex-wrap items-center gap-1 rounded-md border border-line bg-overlay/85 px-1 py-0.5 opacity-0 backdrop-glass transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
            <span ref={setActions} className="flex flex-wrap items-center gap-1" />
            {scriptsOffHint && <span className="max-w-[24rem] truncate text-xs text-ink-faint" title={t(IS_ELECTRON ? "artifacts.scriptsOffSettings" : "artifacts.scriptsOffBrowser")}>{t(IS_ELECTRON ? "artifacts.scriptsOffSettings" : "artifacts.scriptsOffBrowser")}</span>}
            <IconButton label={t(managed && expanded ? "common.overlay.close" : "transcript.artifact.expand")} onClick={() => setExpanded(value => !value)}>{managed && expanded ? <IconClose /> : <ExpandGlyph />}</IconButton>
          </div></div>
        </>)}
      </div>
      {expanded && !managed && <ArtifactViewer html={shown.html} title={title} hint={scriptsOffHint ? t(IS_ELECTRON ? "artifacts.scriptsOffSettings" : "artifacts.scriptsOffBrowser") : undefined} onClose={() => setExpanded(false)} />}
      {tabId && <ArtifactActions item={item} tabId={tabId} title={title} onResolvedDraft={setDraftId} onHistorical={setHistorical} container={actions} />}
    </div>}
    {item.status === "running" && <div className="flex items-center gap-2 animate-rise"><span className="text-xs text-ink-faint">{t("transcript.tool.running")}</span><div className="flex-1"><ProgressSweep tone="copper" /></div></div>}
    {slab !== null && <Slab className="max-h-48 animate-rise" tone={item.status === "error" ? "rose" : "neutral"}>{linkify(slab)}</Slab>}
  </>;
}
