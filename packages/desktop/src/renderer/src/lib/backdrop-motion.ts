import { useSyncExternalStore } from "react";

/**
 * Backdrop motion (issue #1168).
 *
 * The store syncs the persisted `backdropMotion` setting from the backend and
 * this module holds it for the backdrop layer, which swaps a scene for its
 * still when motion is off. On by default: a theme that carries a scene
 * animates unless the user turns it off.
 */

/**
 * Mirror of the store's `backdropMotion`. The backdrop layer needs the
 * setting before the first backend round-trip resolves, so localStorage — not
 * the backend — is the read path here. Stored as "on" or "off"; anything
 * else reads as on.
 */
const KEY = "omp-ui.backdropMotion";

let current = true;
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Guarded like `applyGlassChrome`: the store calls
 * this during its own boot, and the store's tests run in vitest's node
 * environment with no `localStorage`.
 */
export function applyBackdropMotion(on: boolean): void {
  current = on;

  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // Storage unavailable (or no DOM at all): the setting still applies.
  }

  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied setting — lets a caller skip a redundant re-apply. */
export function currentBackdropMotion(): boolean {
  return current;
}

/** Current backdrop motion, live across every consumer. */
export function useBackdropMotion(): boolean {
  return useSyncExternalStore(subscribe, () => current);
}

// Boot from the persisted mirror so a scene does not start moving on a launch
// where the user turned motion off, before the store's first round-trip.
try {
  applyBackdropMotion(window.localStorage.getItem(KEY) !== "off");
} catch {
  // No storage (or no DOM): the default is already applied.
}
