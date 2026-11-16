import { useEffect, useState, useSyncExternalStore, type ReactElement } from "react";
import { applyBackdropChrome, loadBackdropAsset, useDraftBackdropAsset, type BackdropAsset } from "../lib/backdrop";
import { useBackdropMotion } from "../lib/backdrop-motion";
import { currentThemePreview, useTheme } from "../lib/themes";

/**
 * The theme's backdrop, painted once under the whole app (issue #1168,
 * ADR-0094). Shown only through `<img>`, so a scene runs no script and loads
 * no subresource; blurred and dimmed here so no plane above needs a filter.
 * A scene animates only while motion is on, the window is visible and the
 * system does not ask for reduced motion: neither signal reaches inside an
 * image, so the layer swaps in the scene's still instead.
 */

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";

function subscribeReducedMotion(cb: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};
  const query = window.matchMedia(REDUCED_MOTION);
  query.addEventListener("change", cb);
  return () => query.removeEventListener("change", cb);
}

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(REDUCED_MOTION).matches
    : false;
}

function subscribeVisibility(cb: () => void): () => void {
  document.addEventListener("visibilitychange", cb);
  return () => document.removeEventListener("visibilitychange", cb);
}

export function BackdropLayer(): ReactElement | null {
  const theme = useTheme();
  const motion = useBackdropMotion();
  const reducedMotion = useSyncExternalStore(subscribeReducedMotion, prefersReducedMotion);
  const hidden = useSyncExternalStore(subscribeVisibility, () => document.hidden);
  const draftAsset = useDraftBackdropAsset();
  // The editor's draft asset belongs to the theme it previews, never to another one.
  const draft = draftAsset !== null && currentThemePreview() === theme ? draftAsset : null;

  const hash = theme.backdrop?.assetHash ?? null;
  // The loaded asset, tagged with the hash it belongs to so a stale one is never shown.
  const [loaded, setLoaded] = useState<{ hash: string; asset: BackdropAsset } | null>(null);
  useEffect(() => {
    if (hash === null || draft !== null) return;
    let live = true;
    loadBackdropAsset(hash).then(
      (asset) => {
        if (live) setLoaded({ hash, asset });
      },
      () => {
        // Unavailable (lite host, pruned asset): no backdrop, today's paint.
        if (live) setLoaded(null);
      },
    );
    return () => {
      live = false;
    };
  }, [hash, draft]);

  const asset = theme.backdrop === null
    ? null
    : draft ?? (loaded !== null && loaded.hash === hash ? loaded.asset : null);

  const animate = asset !== null && asset.kind === "scene" && motion && !reducedMotion && !hidden;
  const src = asset === null ? null : animate ? asset.url : asset.stillUrl;

  // Ready once this exact image has decoded; the floors and the transparent
  // stage are written only then, so a failed load leaves today's paint.
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const ready = src !== null && readySrc !== null && (readySrc === asset?.url || readySrc === asset?.stillUrl);

  useEffect(() => {
    applyBackdropChrome(theme, ready);
  }, [theme, ready]);
  useEffect(() => () => applyBackdropChrome(theme, false), [theme]);

  if (src === null) return null;
  return (
    <div aria-hidden className="backdrop-layer">
      <img
        alt=""
        draggable={false}
        src={src}
        onLoad={() => setReadySrc(src)}
        onError={() => setReadySrc(null)}
      />
      <div className="backdrop-scrim" />
    </div>
  );
}
