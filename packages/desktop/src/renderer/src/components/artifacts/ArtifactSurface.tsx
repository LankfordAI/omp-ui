import { createElement, useEffect, useMemo, useRef, useState } from "react";
import type { ArtifactPreparedSurface, ArtifactSurfaceSource } from "../../../../artifact-runtime-protocol";
import { composeHtmlArtifactDocument, htmlArtifactThemeCss, htmlArtifactDataUrl, HTML_ARTIFACT_PARTITION, HEIGHT_HASH_PREFIX } from "@omp-ui/core/html-artifact";
import { useStore } from "../../store";
import { useTheme } from "../../lib/themes";
import { displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { Button } from "../ui";

export type ArtifactSurfaceStatus = "saving" | "saved" | "not-saved" | "readOnly" | "loading";

export interface ArtifactSurfaceReadyHandle {
  surfaceId: string;
  captureThumbnail: (dark: boolean) => Promise<{ hash: string } | null>;
}

/** Only managed URLs carry main-issued authority; plain documents retain the legacy guest. */
export function ArtifactSurface({
  source,
  html,
  title,
  className,
  style,
  onReload,
  managed = true,
  historical = false,
  inline = false,
  onMeasured,
  onEscape,
  onSurfaceReady,
  onStatusChange,
}: {
  source?: ArtifactSurfaceSource;
  html: string;
  title: string;
  className?: string;
  style?: React.CSSProperties;
  onReload?: () => void;
  managed?: boolean;
  historical?: boolean;
  inline?: boolean;
  onMeasured?: (height: number) => void;
  onEscape?: () => void;
  onSurfaceReady?: (handle: ArtifactSurfaceReadyHandle | null) => void;
  onStatusChange?: (status: ArtifactSurfaceStatus) => void;
}) {
  const theme = useTheme();
  const enabled = useStore((s) => s.state?.artifactLibraryEnabled === true);
  const scripts = useStore((s) => s.state?.htmlArtifactScripts !== false);
  const [prepared, setPrepared] = useState<ArtifactPreparedSurface | null>(null);
  const [status, setStatus] = useState<ArtifactSurfaceStatus>("loading");
  const [reloadRequired, setReloadRequired] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const sourceKey = JSON.stringify(source);
  const themeRef = useRef(theme);
  themeRef.current = theme;
  const guestRef = useRef<HTMLElement | null>(null);
  const chromeRef = useRef<HTMLDivElement | null>(null);
  const measuredRef = useRef(onMeasured); measuredRef.current = onMeasured;
  const escapeRef = useRef(onEscape); escapeRef.current = onEscape;
  const surfaceReadyRef = useRef(onSurfaceReady); surfaceReadyRef.current = onSurfaceReady;
  const statusChangeRef = useRef(onStatusChange); statusChangeRef.current = onStatusChange;
  const historicalRef = useRef(historical); historicalRef.current = historical;
  const admission = useRef<Promise<void> | null>(null);
  const staticDocument = useMemo(() => composeHtmlArtifactDocument(html, htmlArtifactThemeCss(theme.tokens, theme.dark), false), [html, theme]);
  const legacyUrl = useMemo(() => !managed && window.ompArtifactHost && enabled && scripts
    ? htmlArtifactDataUrl(composeHtmlArtifactDocument(html, htmlArtifactThemeCss(theme.tokens, theme.dark), true)) : null, [managed, enabled, scripts, html, theme]);
  useEffect(() => {
    statusChangeRef.current?.(status);
  }, [status]);
  useEffect(() => {
    const host = window.ompArtifactHost;
    if (!managed || !source || !host || !enabled || !scripts || historicalRef.current) {
      setPrepared(null);
      setStatus("readOnly");
      surfaceReadyRef.current?.(null);
      return;
    }
    const previous = admission.current;
    const drained = Promise.withResolvers<void>();
    admission.current = drained.promise;
    let canceled = false;
    let surfaceId: string | null = null;
    let releasing: Promise<void> | null = null;
    const closeSurface = (): Promise<void> => {
      if (surfaceId === null) return Promise.resolve();
      releasing ??= host.releaseSurface(surfaceId);
      return releasing;
    };
    setError(null); setReloadRequired(false); setStatus("loading");
    surfaceReadyRef.current?.(null);
    const unsubscribe = host.onSurfaceNotice((notice) => {
      if (notice.surfaceId !== surfaceId) return;
      if (notice.reason === "escape") { escapeRef.current?.(); return; }
      if (notice.reason === "ready") {
        const activeId = surfaceId;
        if (activeId !== null && !canceled) {
          surfaceReadyRef.current?.({
            surfaceId: activeId,
            captureThumbnail: (dark) => host.captureThumbnail(activeId, dark),
          });
        }
        return;
      }
      if (notice.reloadRequired) {
        setReloadRequired(true);
        setStatus("readOnly");
        surfaceReadyRef.current?.(null);
      } else {
        setStatus(notice.reason);
      }
    });
    // StrictMode and fast source changes cannot race a cancelled ticket into a second writer.
    void (previous ?? Promise.resolve()).then(async () => {
      if (canceled || historicalRef.current) { drained.resolve(); return; }
      try {
        const next = await host.prepareSurface(source, {tokens: themeRef.current.tokens, dark: themeRef.current.dark});
        surfaceId = next.surfaceId;
        if (canceled || historicalRef.current) { await closeSurface(); drained.resolve(); return; }
        setPrepared(next); setStatus(next.readOnly ? "readOnly" : "saved");
      } catch (reason) {
        if (!canceled) { setError(displayMessage(reason)); setStatus("not-saved"); }
        else useStore.getState().reportError(reason);
        drained.resolve();
      }
    });
    return () => {
      canceled = true; unsubscribe();
      surfaceReadyRef.current?.(null);
      if (surfaceId !== null) void closeSurface().catch(reason => useStore.getState().reportError(reason)).finally(drained.resolve);
    };
    // Themes and expansion never replace the managed document URL.
  }, [sourceKey, enabled, scripts, reload, managed]);
  useEffect(() => {
    if (prepared && window.ompArtifactHost) void window.ompArtifactHost.updateTheme(prepared.surfaceId, { tokens: theme.tokens, dark: theme.dark }).catch((reason: unknown) => { setError(displayMessage(reason)); setStatus("not-saved"); });
  }, [prepared, theme]);
  useEffect(() => {
    const element = guestRef.current;
    if (!element || !onMeasured) return;
    const height = (event: Event): void => {
      const url = "url" in event && typeof event.url === "string" ? event.url : "";
      const at = url.lastIndexOf(HEIGHT_HASH_PREFIX);
      const pixels = at < 0 ? NaN : Number(url.slice(at + HEIGHT_HASH_PREFIX.length));
      if (Number.isFinite(pixels) && pixels >= 0) measuredRef.current?.(Math.round(pixels) + (chromeRef.current?.offsetHeight ?? 0));
    };
    element.addEventListener("did-navigate-in-page", height);
    return () => element.removeEventListener("did-navigate-in-page", height);
  }, [prepared?.surfaceId, legacyUrl, onMeasured]);
  // Stateless kept documents suppress the redundant "Read only" bar when rendering live with scripts on desktop.
  const suppressPlainChrome = !managed && !historical && !reloadRequired && !error && scripts && Boolean(window.ompArtifactHost);
  const showChrome = (Boolean(source) || historical) && !suppressPlainChrome;
  // Preload tickets are installed at attachment, while themes/expansion keep the same surface.
  return <div className={cn("flex min-h-0 min-w-0 flex-col", className)} style={style}>
    {showChrome && <div ref={chromeRef} className="flex shrink-0 flex-wrap items-center gap-2 border-b border-line px-2 py-1 text-xs text-ink-dim" role="status" aria-live="polite">
      <span>{historical ? "Historical preview — open in library to use saved data" : status === "saving" ? "Saving…" : status === "saved" ? "Saved" : status === "not-saved" ? "Not saved" : status === "loading" ? "Loading…" : "Read only"}</span>
      {(!scripts || !window.ompArtifactHost) && <span>Static preview. Data and version history remain available.</span>}
      {reloadRequired && !historical && <><span>A newer version is available or this writer was revoked. Reload to continue.</span><Button onClick={() => { if (onReload) { onReload(); return; } setPrepared(null); setReload((n) => n + 1); }}>Reload</Button></>}
      {error && <span className="text-rose">{error}</span>}
    </div>}
    {legacyUrl || prepared ? createElement("webview", { key: legacyUrl ? "legacy" : prepared!.surfaceId, ref: guestRef, src: legacyUrl ?? prepared!.url, partition: legacyUrl ? HTML_ARTIFACT_PARTITION : prepared!.partition, title, className: "block min-h-0 w-full flex-1", style: { display: "flex", minHeight: inline ? 0 : 280 } }) : <iframe title={title} sandbox="" srcDoc={staticDocument} className="block min-h-0 w-full flex-1 border-0" style={{ minHeight: inline ? 0 : 280 }} />}
  </div>;
}
