import { createElement, useId, useMemo, useState } from "react";
import {
  composeHtmlArtifactDocument,
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
import { CheckGlyph, Slab } from "./ToolCard";
import { Chip, ICON_STROKE, IconButton, IconClose, Modal, Panel, ProgressSweep } from "./ui";

const HEIGHT_STEP = 160;

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
 */
function ArtifactSurface({
  html,
  title,
  className,
  style,
}: {
  html: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
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
  const frameClass = cn("block w-full rounded-md border border-line bg-surface", className);
  if (src === null) {
    return <iframe title={title} sandbox="" srcDoc={doc} className={frameClass} style={style} />;
  }
  return createElement("webview", {
    src,
    partition: HTML_ARTIFACT_PARTITION,
    title,
    className: frameClass,
    style: { display: "flex", ...style },
  });
}

function StatusMark({ status }: { status: ToolItem["status"] }) {
  const t = useT();
  switch (status) {
    case "running":
      return <Chip tone="copper">{t("transcript.tool.running")}</Chip>;
    case "error":
      return <Chip tone="rose">{t("transcript.tool.error")}</Chip>;
    case "aborted":
      return <Chip tone="copper">{t("transcript.tool.aborted")}</Chip>;
    case "cancelled":
      return <Chip>{t("transcript.tool.cancelled")}</Chip>;
    case "done":
      return <CheckGlyph />;
  }
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
        <h2 id={titleId} className="min-w-0 flex-1 truncate font-display text-xs font-semibold text-ink">
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
 * An interactive HTML artifact (issue #994): the document the agent passed to
 * `omp-ui_render_html`, rendered from the tool call's own arguments, so a
 * reload or a joined viewer shows the same card with nothing stored host-side.
 * The frame mounts once the call settles as done; while the model streams the
 * html, or when the tool refused it, the card shows status and the reason.
 */
export function HtmlArtifactCard({ item }: { item: ToolItem }) {
  const t = useT();
  const parsed = useMemo(() => parseHtmlArtifactArgs(item.args), [item.args]);
  const [height, setHeight] = useState<number | null>(null);
  const [expanded, setExpanded] = useState(false);
  const title = parsed.ok ? parsed.args.title : (strField(item.args, "title") ?? t("transcript.artifact.untitled"));
  const shown = item.status === "done" && parsed.ok ? parsed.args : null;
  const frameHeight = shown === null ? 0 : (height ?? shown.height);
  const slab = shown === null && item.status !== "running" && item.resultText ? item.resultText : null;

  return (
    <Panel tone="neutral" className="animate-rise">
      <div className="flex w-full min-w-0 flex-wrap items-center gap-x-2 gap-y-1 px-2.5 py-1.5">
        <span className="flex min-w-[8rem] flex-1 items-center gap-2">
          <ArtifactGlyph className={item.status === "running" ? "text-copper" : "text-ink-dim"} />
          <span className="min-w-0 flex-1 truncate text-xs font-semibold text-ink" title={title}>
            {title}
          </span>
        </span>
        <span className="ml-auto flex min-w-0 flex-wrap items-center justify-end gap-x-1.5 gap-y-1">
          <Chip tone="signal">{t("transcript.artifact.chip")}</Chip>
          <StatusMark status={item.status} />
          {shown !== null && (
            <>
              <IconButton
                label={t("transcript.artifact.shorter")}
                disabled={frameHeight <= HTML_ARTIFACT_MIN_HEIGHT}
                onClick={() => setHeight(Math.max(HTML_ARTIFACT_MIN_HEIGHT, frameHeight - HEIGHT_STEP))}
              >
                <span aria-hidden className="text-sm leading-none">−</span>
              </IconButton>
              <IconButton
                label={t("transcript.artifact.taller")}
                disabled={frameHeight >= HTML_ARTIFACT_MAX_HEIGHT}
                onClick={() => setHeight(Math.min(HTML_ARTIFACT_MAX_HEIGHT, frameHeight + HEIGHT_STEP))}
              >
                <span aria-hidden className="text-sm leading-none">+</span>
              </IconButton>
              <IconButton label={t("transcript.artifact.expand")} onClick={() => setExpanded(true)}>
                <ExpandGlyph />
              </IconButton>
            </>
          )}
        </span>
      </div>
      {item.status === "running" && <ProgressSweep tone="copper" />}
      {shown !== null && (
        <div className="border-t border-line-soft p-2">
          <ArtifactSurface html={shown.html} title={title} style={{ height: frameHeight }} />
        </div>
      )}
      {slab !== null && (
        <div className="border-t border-line-soft px-2.5 py-2">
          <Slab className="max-h-48" tone={item.status === "error" ? "rose" : "neutral"}>
            {linkify(slab)}
          </Slab>
        </div>
      )}
      {expanded && shown !== null && (
        <ArtifactViewer html={shown.html} title={title} onClose={() => setExpanded(false)} />
      )}
    </Panel>
  );
}
