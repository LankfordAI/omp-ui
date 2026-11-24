import { useSyncExternalStore } from "react";
import {
  backdropFloors,
  backdropKindForMime,
  stillScene,
  type ThemeBackdropKind,
  type ThemeBackdropMime,
} from "@omp-ui/core/theme-backdrop";
import { backend } from "../backend";
import { base64ToBytes } from "./clipboard-image";
import type { Theme } from "./themes";

/**
 * Theme backdrops in the renderer (issue #1168, ADR-0094).
 *
 * A backdrop's bytes live host-side under their SHA-256; this module fetches
 * each one once, turns it into blob URLs the backdrop layer shows through an
 * `<img>` (so a scene runs no script and loads nothing), and writes the root
 * attribute and floor variables style.css reads to keep text planes readable
 * over it.
 */

export interface BackdropAsset {
  url: string;
  stillUrl: string;
  kind: ThemeBackdropKind;
  mime: ThemeBackdropMime;
}

/** One load per hash, kept for the life of the page; a failed load is dropped so a later switch retries. */
const assets = new Map<string, Promise<BackdropAsset>>();

/** Fetches one asset through the backend, once per hash, and builds its blob URLs. Rejects when unavailable. */
export function loadBackdropAsset(assetHash: string): Promise<BackdropAsset> {
  let pending = assets.get(assetHash);
  if (pending === undefined) {
    pending = fetchBackdropAsset(assetHash);
    assets.set(assetHash, pending);
    pending.catch(() => {
      if (assets.get(assetHash) === pending) assets.delete(assetHash);
    });
  }
  return pending;
}

async function fetchBackdropAsset(assetHash: string): Promise<BackdropAsset> {
  // A client talking straight to a lite host has no backdrop channel: the
  // method is absent or the request is refused. Either way, no backdrop.
  if (typeof backend.readThemeBackdrop !== "function") throw new Error("backdrops are unavailable on this host");
  const read = await backend.readThemeBackdrop(assetHash);
  if (read === null) throw new Error("that backdrop is no longer stored");
  return backdropAssetFromBytes(base64ToBytes(read.data), read.mime);
}

/** Builds the same URLs from bytes the editor already holds, for a draft. */
export function backdropAssetFromBytes(bytes: Uint8Array, mime: ThemeBackdropMime): BackdropAsset {
  const kind = backdropKindForMime(mime);
  if (kind === "scene") {
    const text = new TextDecoder().decode(bytes);
    return {
      url: URL.createObjectURL(new Blob([text], { type: "image/svg+xml" })),
      stillUrl: URL.createObjectURL(new Blob([stillScene(text)], { type: "image/svg+xml" })),
      kind: "scene",
      mime,
    };
  }
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime }));
  return { url, stillUrl: url, kind, mime };
}

/** Revokes a draft asset's URLs. Cached assets from `loadBackdropAsset` are never released. */
export function releaseBackdropAsset(asset: BackdropAsset): void {
  URL.revokeObjectURL(asset.url);
  if (asset.stillUrl !== asset.url) URL.revokeObjectURL(asset.stillUrl);
}

const CHROME_PROPERTIES = [
  "--backdrop-floor-void",
  "--backdrop-floor-sunken",
  "--backdrop-floor-reading",
  "--backdrop-floor-overlay",
  "--stage-alpha",
  "--backdrop-blur",
] as const;

/** Writes or clears the root attribute and the floor variables for the theme being painted. */
export function applyBackdropChrome(theme: Theme, ready: boolean): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  const backdrop = theme.backdrop;
  if (!ready || backdrop === null) {
    delete root.dataset.backdrop;
    for (const property of CHROME_PROPERTIES) root.style.removeProperty(property);
    return;
  }
  const floors = backdropFloors(theme.tokens);
  root.dataset.backdrop = "";
  root.style.setProperty("--backdrop-floor-void", `${floors.void}%`);
  root.style.setProperty("--backdrop-floor-sunken", `${floors.sunken}%`);
  root.style.setProperty("--backdrop-floor-reading", `${floors.reading}%`);
  root.style.setProperty("--backdrop-floor-overlay", `${floors.overlay}%`);
  root.style.setProperty("--stage-alpha", "0%");
  root.style.setProperty("--backdrop-blur", `${backdrop.blur}px`);
}

/**
 * The editor's draft asset: shown instead of the theme's stored one while the
 * editor previews a draft in the app. The editor owns its lifetime.
 */
let draftAsset: BackdropAsset | null = null;
const draftListeners = new Set<() => void>();

/** Sets or clears the draft asset the backdrop layer shows for a previewed theme. */
export function setDraftBackdropAsset(asset: BackdropAsset | null): void {
  if (asset === draftAsset) return;
  draftAsset = asset;
  for (const cb of draftListeners) cb();
}

function subscribeDraft(cb: () => void): () => void {
  draftListeners.add(cb);
  return () => draftListeners.delete(cb);
}

/** The current draft asset, live. */
export function useDraftBackdropAsset(): BackdropAsset | null {
  return useSyncExternalStore(subscribeDraft, () => draftAsset);
}
