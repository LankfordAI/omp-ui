import { memo, useEffect, useRef, useState, useSyncExternalStore, type ReactElement } from "react";
import { BACKDROP_SCENE_FRAME_NAME } from "@omp-ui/core/theme-backdrop";
import { applyBackdropChrome, loadBackdropAsset, useDraftBackdropAsset, type BackdropAsset } from "../lib/backdrop";
import { useBackdropMotion } from "../lib/backdrop-motion";
import { currentThemePreview, useTheme } from "../lib/themes";

/**
 * The theme's backdrop, painted once under the whole app (issue #1168,
 * ADR-0094). Images and scenes render through `<img>` (so a scene runs no
 * script and loads no subresource); video loops render through a muted,
 * looping `<video>`; blurred once here so no plane above needs a filter; never
 * dimmed, so it shows as authored (#1187).
 * Scenes and videos animate only while motion is on, the window is visible,
 * the system does not ask for reduced motion, and `origin.animate !== false`.
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

export const BackdropLayer = memo(function BackdropLayer(): ReactElement | null {
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

  // An installed repository theme's scene stays still until the user allows it (#1178).
  const animate =
    asset !== null &&
    (asset.kind === "scene" || asset.kind === "video") &&
    motion &&
    !reducedMotion &&
    !hidden &&
    theme.origin?.animate !== false;
  const src = asset === null ? null : asset.kind === "video" ? asset.url : animate ? asset.url : asset.stillUrl;

  // Ready once this exact media URL has decoded; the floors and the transparent
  // stage are written only then, so a failed load leaves today's paint.
  const [readySrc, setReadySrc] = useState<string | null>(null);
  const ready =
    src !== null &&
    readySrc !== null &&
    (asset?.kind === "video"
      ? readySrc === asset.url
      : readySrc === asset?.url || readySrc === asset?.stillUrl);

  const videoRef = useRef<HTMLVideoElement | null>(null);
  useEffect(() => {
    if (asset?.kind !== "video") return;
    const video = videoRef.current;
    if (video === null) return;
    video.muted = true;
    video.defaultMuted = true;
    if (animate) {
      void video.play()?.catch(() => {});
    } else {
      video.pause();
    }
  }, [asset?.url, asset?.kind, animate, ready]);

  useEffect(() => {
    applyBackdropChrome(theme, ready);
  }, [theme, ready]);
  useEffect(() => () => applyBackdropChrome(theme, false), [theme]);

  if (src === null || asset === null) return null;
  const useSceneFrame = asset.kind === "scene" && animate && asset.sceneFrameDoc !== undefined;
  return (
    <div aria-hidden className="backdrop-layer">
      {asset.kind === "video" ? (
        <video
          key={asset.url}
          ref={videoRef}
          src={asset.url}
          muted
          loop
          playsInline
          preload="auto"
          disablePictureInPicture
          disableRemotePlayback
          tabIndex={-1}
          aria-hidden
          onLoadedData={() => setReadySrc(asset.url)}
          onError={() => setReadySrc(null)}
        />
      ) : useSceneFrame ? (
        <iframe
          key={asset.url}
          name={BACKDROP_SCENE_FRAME_NAME}
          title=""
          aria-hidden
          tabIndex={-1}
          sandbox=""
          srcDoc={asset.sceneFrameDoc}
          onLoad={() => setReadySrc(asset.url)}
          onError={() => setReadySrc(null)}
        />
      ) : (
        <img
          alt=""
          draggable={false}
          src={src}
          onLoad={() => setReadySrc(src)}
          onError={() => setReadySrc(null)}
        />
      )}
    </div>
  );
});
