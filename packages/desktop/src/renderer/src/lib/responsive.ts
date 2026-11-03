import { useEffect, useState } from "react";

export const COMPACT_SHELL_QUERY = "(max-width: 899px)";
/** Compact shell with room for the sidebar beside the transcript (foldable inner screen, small tablet). Implies compact. */
export const DOCKED_SIDEBAR_QUERY = "(min-width: 600px) and (max-width: 899px) and (min-height: 600px)";
/** Book posture: a vertical hinge splits the viewport into left and right segments (Chrome 138 Viewport Segments). */
export const BOOK_POSTURE_QUERY = "(horizontal-viewport-segments: 2)";

function listen(
  query: MediaQueryList,
  listener: (event: MediaQueryListEvent) => void,
): () => void {
  if (typeof query.addEventListener === "function") {
    query.addEventListener("change", listener);
    return () => query.removeEventListener("change", listener);
  }
  query.addListener(listener);
  return () => query.removeListener(listener);
}

/**
 * The compact shell test outside React, for store actions that route a pane
 * onto the compact sheet stack. False without a window or matchMedia (jsdom).
 */
export function isCompactShell(): boolean {
  return matchesQuery(COMPACT_SHELL_QUERY);
}

function matchesQuery(query: string): boolean {
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(query).matches;
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => matchesQuery(query));

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const list = window.matchMedia(query);
    setMatches(list.matches);
    return listen(list, (event) => setMatches(event.matches));
  }, [query]);

  return matches;
}

export function useCompactShell(): boolean {
  return useMediaQuery(COMPACT_SHELL_QUERY);
}

export function useDockedSidebar(): boolean {
  return useMediaQuery(DOCKED_SIDEBAR_QUERY);
}

type SegmentedWindow = Window & { viewport?: { segments?: readonly { left: number }[] | null } };

/**
 * x where the right segment starts in book posture, else null (no support,
 * unfolded, or not two segments). The right segment's left, not the left
 * segment's width, so a hinge mask stays under the sidebar.
 */
function bookSplitX(): number | null {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return null;
  if (!window.matchMedia(BOOK_POSTURE_QUERY).matches) return null;
  const segments = (window as SegmentedWindow).viewport?.segments;
  if (segments == null || segments.length !== 2) return null;
  return Math.round(segments[1]!.left);
}

export function useBookSplitX(): number | null {
  const [x, setX] = useState(bookSplitX);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const update = () => setX(bookSplitX());
    update();
    const unlisten = listen(window.matchMedia(BOOK_POSTURE_QUERY), update);
    // Segment geometry changes on rotation without a media change.
    window.addEventListener("resize", update);
    return () => {
      unlisten();
      window.removeEventListener("resize", update);
    };
  }, []);

  return x;
}

function viewportWidth(): number {
  if (typeof window === "undefined") return 0;
  return window.visualViewport?.width ?? window.innerWidth;
}

export function useViewportWidth(): number {
  const [width, setWidth] = useState(viewportWidth);

  useEffect(() => {
    const viewport = window.visualViewport;
    const target: VisualViewport | Window = viewport ?? window;
    const update = () => setWidth(viewportWidth());
    update();
    target.addEventListener("resize", update);
    return () => target.removeEventListener("resize", update);
  }, []);

  return width;
}

export function useAppViewport(): void {
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;

    const update = () => {
      document.documentElement.style.setProperty("--app-viewport-height", `${viewport.height}px`);
    };
    update();
    viewport.addEventListener("resize", update);
    viewport.addEventListener("scroll", update);
    return () => {
      viewport.removeEventListener("resize", update);
      viewport.removeEventListener("scroll", update);
      document.documentElement.style.removeProperty("--app-viewport-height");
    };
  }, []);
}
