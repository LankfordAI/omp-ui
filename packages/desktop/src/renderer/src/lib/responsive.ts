import { useEffect, useState } from "react";

export const COMPACT_SHELL_QUERY = "(max-width: 899px)";

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
  return typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(COMPACT_SHELL_QUERY).matches;
}

export function useCompactShell(): boolean {
  const [compact, setCompact] = useState(isCompactShell);

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_SHELL_QUERY);
    setCompact(query.matches);
    return listen(query, (event) => setCompact(event.matches));
  }, []);

  return compact;
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
