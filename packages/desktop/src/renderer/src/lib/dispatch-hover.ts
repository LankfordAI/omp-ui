import { useSyncExternalStore } from "react";

/**
 * Cross-highlight between a dispatch tether line and the child's own sidebar
 * row (#1226, ADR-0098). In memory only: a pointer state, never a preference.
 * `source` says where the pointer is: "tether" lights the target's row,
 * "row" lights the target's tether line.
 */
export type DispatchHoverSource = "tether" | "row";
export interface DispatchHover {
  tabId: string;
  source: DispatchHoverSource;
}

let current: DispatchHover | null = null;
const listeners = new Set<() => void>();

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Replace the current hover; null clears. */
export function setDispatchHover(next: DispatchHover | null): void {
  if (current === next) return;
  if (current !== null && next !== null && current.tabId === next.tabId && current.source === next.source) return;
  current = next;
  for (const cb of listeners) cb();
}

/** Clear only when the current hover is exactly `owned` (unmount and leave cleanup). */
export function releaseDispatchHover(owned: DispatchHover): void {
  if (current !== null && current.tabId === owned.tabId && current.source === owned.source) setDispatchHover(null);
}

/** True while `tabId` is the hovered target and the hover came from `from`. */
export function useDispatchHover(tabId: string, from: DispatchHoverSource): boolean {
  return useSyncExternalStore(subscribe, () => current !== null && current.tabId === tabId && current.source === from);
}
