import { useSyncExternalStore } from "react";

/**
 * Sidebar Work/Chat mode (issue #894). A view preference, not session state,
 * so it lives outside the store. Deliberately not in DesktopViewStateV1: that
 * snapshot is version-gated and dropped on a schema bump, while a preference
 * must survive app updates — hence its own localStorage key.
 */
const KEY = "omp-ui.sidebarMode";

export type SidebarMode = "work" | "chat";

function load(): SidebarMode {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (raw === "work" || raw === "chat") return raw;
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return "work";
}

let mode = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current mode, live across every sidebar instance. */
export function useSidebarMode(): SidebarMode {
  return useSyncExternalStore(subscribe, () => mode);
}

export function setSidebarMode(next: SidebarMode): void {
  if (next === mode) return;
  mode = next;
  try {
    window.localStorage.setItem(KEY, next);
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  for (const cb of listeners) cb();
}
