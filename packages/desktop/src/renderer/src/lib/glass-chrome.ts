import { useSyncExternalStore } from "react";
import type { GlassChrome } from "@omp-ui/core/types";

/**
 * Glass chrome steps (issue #393, ADR-0026).
 *
 * The store syncs the persisted `glassChrome` setting from the backend and
 * this module writes the step id to `data-glass` on the document root. The
 * visual values per step live in style.css keyed on `[data-glass]` — the
 * `--glass-alpha` / `--glass-filter` / `--glass-wash` knobs and nothing else
 * may add per-component translucency.
 */

export interface GlassChromeStep {
  id: GlassChrome;
}

export const GLASS_CHROME_STEPS: readonly GlassChromeStep[] = [
  { id: "off" },
  { id: "subtle" },
  { id: "frosted" },
];

export const DEFAULT_GLASS_CHROME_ID: GlassChrome = "subtle";

/**
 * Mirror of the store's `glassChrome`. The renderer needs the chrome fill
 * before the first backend round-trip resolves, so localStorage — not the
 * backend — is the read path here.
 */
const KEY = "omp-ui.glassChrome";

const DEFAULT_GLASS_CHROME: GlassChromeStep =
  GLASS_CHROME_STEPS.find((g) => g.id === DEFAULT_GLASS_CHROME_ID) ?? GLASS_CHROME_STEPS[0];

/** Unknown id (renamed step, hand-edited storage) degrades, never throws. */
export function resolveGlassChrome(id: string | undefined): GlassChromeStep {
  return GLASS_CHROME_STEPS.find((g) => g.id === id) ?? DEFAULT_GLASS_CHROME;
}

let current: GlassChromeStep = DEFAULT_GLASS_CHROME;
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Guarded like `applyFontFamily`: the store calls
 * this during its own boot, and the store's tests run in vitest's node
 * environment with no `document` and no `localStorage`.
 */
export function applyGlassChrome(step: GlassChromeStep): void {
  current = step;

  if (typeof document !== "undefined") {
    document.documentElement.dataset.glass = step.id;
  }

  try {
    // The pre-paint boot below reads this mirror, so persisting is what keeps
    // the next launch from flashing the default chrome before the store loads.
    window.localStorage.setItem(KEY, step.id);
  } catch {
    // Storage unavailable (or no DOM at all): the step still applies.
  }

  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied step's id — lets a caller skip a redundant re-apply. */
export function currentGlassChromeId(): GlassChrome {
  return current.id;
}

/** Current glass chrome step, live across every consumer. */
export function useGlassChrome(): GlassChromeStep {
  return useSyncExternalStore(subscribe, () => current);
}

// Boot from the persisted mirror so the first frame paints with the chosen
// chrome translucency, well before the store's first backend round-trip resolves.
try {
  applyGlassChrome(resolveGlassChrome(window.localStorage.getItem(KEY) ?? undefined));
} catch {
  // No storage (or no DOM): the default is already applied.
}
