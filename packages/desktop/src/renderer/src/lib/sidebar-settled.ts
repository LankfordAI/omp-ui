import { useSyncExternalStore } from "react";

/**
 * Whether the sidebar's Settled block is expanded. A view preference, not
 * session state, so it lives outside the store. Deliberately not in
 * DesktopViewStateV1: that snapshot is version-gated and dropped on a schema
 * bump, while a preference must survive app updates — hence its own
 * localStorage key.
 */
const KEY = "omp-ui.sidebarSettledOpen";

function load(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    // Storage unavailable: fall through to the default.
  }
  return false;
}

let open = load();
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current choice, live across every sidebar instance. */
export function useSettledOpen(): boolean {
  return useSyncExternalStore(subscribe, () => open);
}

export function setSettledOpen(next: boolean): void {
  if (next === open) return;
  open = next;
  try {
    window.localStorage.setItem(KEY, next ? "1" : "0");
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  for (const cb of listeners) cb();
}
