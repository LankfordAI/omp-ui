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

export function useCompactShell(): boolean {
  const [compact, setCompact] = useState(() =>
    typeof window === "undefined" || typeof window.matchMedia !== "function"
      ? false
      : window.matchMedia(COMPACT_SHELL_QUERY).matches,
  );

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(COMPACT_SHELL_QUERY);
    setCompact(query.matches);
    return listen(query, (event) => setCompact(event.matches));
  }, []);

  return compact;
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
