import { createElement, useEffect, useId, useMemo, useRef, useState } from "react";
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
import { cn } from "../lib/cn";
import { strField } from "../lib/fields";
import { useT } from "../lib/i18n";
import { IS_ELECTRON } from "../lib/platform";
import type { ToolItem } from "../lib/transcript";
import { useTheme } from "../lib/themes";
import { useStore } from "../store";
import { linkify } from "./Markdown";
import { Slab } from "./ToolCard";
import { ICON_STROKE, IconButton, IconClose, Modal, ProgressSweep } from "./ui";

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
  const theme = useTheme();
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
    el.addEventListener("did-navigate-in-page", onHeight);
    return () => el.removeEventListener("did-navigate-in-page", onHeight);
  }, [src]);
  if (src === null) {
    return <iframe title={title} sandbox="" srcDoc={doc} className={frameClass} style={style} />;
  }
  return createElement("webview", {
    ref,
    src,
    partition: HTML_ARTIFACT_PARTITION,
    title,
    className: frameClass,
    style: { display: "flex", ...style },
  });
}

function ArtifactViewer({ html, title, onClose }: { html: string; title: string; onClose: () => void }) {
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
      <header className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-2">
        <ArtifactGlyph className="text-ink-dim" />
        <h2 id={titleId} className="min-w-0 flex-1 truncate text-xs font-semibold text-ink">
          {title}
        </h2>
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

/**
 * An interactive HTML artifact (issue #994, flush posture issue #1041): the
 * document the agent passed to `omp-ui_render_html`, rendered from the tool
 * call's own arguments, so a reload or a joined viewer shows the same card
 * with nothing stored host-side. The card wears no chrome — the document sits
 * flush in the transcript flow and sizes itself: the guest stub reports its
 * content height over the `#omph` fragment channel, clamped between the core
 * bounds; before the first report the requested hint height shows. The expand
 * pill surfaces on hover only, so the artifact owns the space. While the
 * model streams the html, or when the tool refused it, the card shows status
 * and the reason instead of a document.
 */
export function HtmlArtifactCard({ item }: { item: ToolItem }) {
  const t = useT();
  const parsed = useMemo(() => parseHtmlArtifactArgs(item.args), [item.args]);
  const [measured, setMeasured] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const title = parsed.ok ? parsed.args.title : (strField(item.args, "title") ?? t("transcript.artifact.untitled"));
  const shown = item.status === "done" && parsed.ok ? parsed.args : null;
  const frameHeight =
    shown === null
      ? 0
      : Math.min(Math.max(measured ?? shown.height, HTML_ARTIFACT_MIN_HEIGHT), HTML_ARTIFACT_MAX_HEIGHT);
  const slab = shown === null && item.status !== "running" && item.resultText ? item.resultText : null;

  // A new document (the agent edited the artifact) starts a fresh measurement;
  // a theme swap recomposes and remounts the guest, which re-reports on load,
  // so it needs no reset here.
  const html = shown?.html;
  useEffect(() => {
    setMeasured(null);
  }, [html]);

  return (
    <>
      {shown !== null && (
        <div className="group relative animate-rise">
          <h3 className="sr-only">{title}</h3>
          <ArtifactSurface
            html={shown.html}
            title={title}
            style={{ height: frameHeight }}
            onMeasured={setMeasured}
          />
          <div className="pointer-events-none absolute inset-x-0 top-1.5 flex justify-end px-1.5">
            <div className="pointer-events-auto flex items-center gap-1 rounded-md border border-line bg-overlay/85 px-1 py-0.5 opacity-0 backdrop-glass transition-opacity duration-150 group-hover:opacity-100 group-focus-within:opacity-100">
              <IconButton label={t("transcript.artifact.expand")} onClick={() => setExpanded(true)}>
                <ExpandGlyph />
              </IconButton>
            </div>
          </div>
          {expanded && (
            <ArtifactViewer html={shown.html} title={title} onClose={() => setExpanded(false)} />
          )}
        </div>
      )}
      {item.status === "running" && (
        <div className="flex items-center gap-2 animate-rise">
          <span className="text-xs text-ink-faint">{t("transcript.tool.running")}</span>
          <div className="flex-1">
            <ProgressSweep tone="copper" />
          </div>
        </div>
      )}
      {slab !== null && (
        <Slab className="max-h-48 animate-rise" tone={item.status === "error" ? "rose" : "neutral"}>
          {linkify(slab)}
        </Slab>
      )}
    </>
  );
}
