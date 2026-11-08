import { createContext, useContext, useEffect, useRef, type RefObject } from "react";

/** Native Back is visual navigation, never an Escape key or an agent response. */
export const ANDROID_BACK_EVENT = "omp-android-back";

/** React ownership survives portals, including surfaces opened inside a hidden tab. */
export const AndroidBackTab = createContext<string | null>(null);
export const AndroidBackOwner = createContext<symbol | null>(null);

type SurfaceRefs = RefObject<Element | null> | readonly RefObject<Element | null>[];
type BackAction = (() => void) | "block";
interface BackOptions {
  open: boolean;
  refs: SurfaceRefs;
  onBack: BackAction;
  kind?: "overlay" | "popover" | "blocker";
  /** Matches the shared overlay chrome: sheets at 60, modals at 70. */
  overlayLayer?: 60 | 70;
}
interface Surface {
  token: symbol;
  parent: symbol | null;
  tab: string | null;
  current: BackOptions;
}

const surfaces: Surface[] = [];

function refsOf(surface: Surface): readonly RefObject<Element | null>[] {
  const refs = surface.current.refs;
  return Array.isArray(refs) ? refs : [refs as RefObject<Element | null>];
}

function visible(element: Element | null): boolean {
  if (element === null || !element.isConnected) return false;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if (node.hasAttribute("hidden") || style.display === "none" || style.visibility === "hidden") return false;
  }
  return true;
}

function owns(parent: Surface, child: Surface): boolean {
  for (let token = child.parent; token !== null;) {
    if (token === parent.token) return true;
    token = surfaces.find((surface) => surface.token === token)?.parent ?? null;
  }
  return refsOf(parent).some((outer) => refsOf(child).some((inner) =>
    outer.current !== null && inner.current !== null && outer.current !== inner.current && outer.current.contains(inner.current),
  ));
}

function active(surface: Surface): boolean {
  if (!surface.current.open) return false;
  if (surface.tab !== null) {
    const tab = [...document.querySelectorAll<HTMLElement>("[data-tab-id]")]
      .find((node) => node.dataset.tabId === surface.tab);
    if (!visible(tab ?? null)) return false;
  }
  // The first ref is the anchor/owner, not a portaled panel that can outlive
  // its hidden tab. Null/disposed anchors must not consume native navigation.
  return visible(refsOf(surface)[0]?.current ?? null);
}

function handleBack(event: Event): void {
  if (!event.cancelable || event.defaultPrevented) return;
  const eligible = surfaces.filter(active);
  // Overlays outrank unrelated menus; descendants (including portaled menus)
  // outrank their owning overlay even when child effects registered first.
  let overlay: Surface | undefined;
  for (const surface of eligible) {
    if (surface.current.kind !== "overlay") continue;
    if (overlay === undefined) {
      overlay = surface;
      continue;
    }
    const layer = surface.current.overlayLayer ?? 70;
    const topLayer = overlay.current.overlayLayer ?? 70;
    if (layer > topLayer || (layer === topLayer && !owns(surface, overlay))) overlay = surface;
  }
  let top = overlay;
  for (const surface of eligible) {
    if (surface === overlay || surface.current.kind === "overlay") continue;
    if (overlay !== undefined && !owns(overlay, surface)) continue;
    if (top !== undefined && owns(surface, top)) continue;
    if (top?.current.kind === "blocker" && surface.current.kind === "popover" && !owns(top, surface)) continue;
    top = surface;
  }
  if (top === undefined) return;
  event.preventDefault();
  if (top.current.onBack !== "block") top.current.onBack();
}

/** Only register callbacks audited as visual-only; decision surfaces use "block". */
export function useAndroidBack(options: BackOptions): symbol {
  const parent = useContext(AndroidBackOwner);
  const tab = useContext(AndroidBackTab);
  const surface = useRef<Surface>({ token: Symbol("android-back"), parent, tab, current: options });
  surface.current.parent = parent;
  surface.current.tab = tab;
  surface.current.current = options;
  useEffect(() => {
    if (!options.open) return;
    const entry = surface.current;
    if (surfaces.length === 0) window.addEventListener(ANDROID_BACK_EVENT, handleBack);
    surfaces.push(entry);
    return () => {
      const index = surfaces.indexOf(entry);
      if (index >= 0) surfaces.splice(index, 1);
      if (surfaces.length === 0) window.removeEventListener(ANDROID_BACK_EVENT, handleBack);
    };
  }, [options.open]);
  return surface.current.token;
}
