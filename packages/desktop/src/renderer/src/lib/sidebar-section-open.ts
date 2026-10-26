import { useSyncExternalStore } from "react";

/**
 * One collapsible sidebar section's open choice. A view preference, not
 * session state, so it lives outside the store and outside the version-gated
 * DesktopViewStateV1 snapshot — its own localStorage key per section, so a
 * schema bump never resets it (the sidebar-settled.ts reasoning, generalized
 * for the Working and Snoozed sections, issue #935).
 */
interface SectionStore {
  open: boolean;
  listeners: Set<() => void>;
}

const stores = new Map<string, SectionStore>();

function storeFor(key: string, fallback: boolean): SectionStore {
  let store = stores.get(key);
  if (store === undefined) {
    let open = fallback;
    try {
      const saved = window.localStorage.getItem(key);
      if (saved === "1") open = true;
      else if (saved === "0") open = false;
    } catch {
      // Storage unavailable: the fallback still applies.
    }
    store = { open, listeners: new Set() };
    stores.set(key, store);
  }
  return store;
}

/** Current choice for one section, live across every sidebar instance. */
export function useSidebarSectionOpen(key: string, fallback: boolean): boolean {
  const store = storeFor(key, fallback);
  return useSyncExternalStore(
    (cb) => {
      store.listeners.add(cb);
      return () => store.listeners.delete(cb);
    },
    () => store.open,
  );
}

export function setSidebarSectionOpen(key: string, next: boolean): void {
  const store = storeFor(key, next);
  if (next === store.open) return;
  store.open = next;
  try {
    window.localStorage.setItem(key, next ? "1" : "0");
  } catch {
    // Persisting is best-effort; the in-memory value still applies.
  }
  for (const cb of store.listeners) cb();
}
