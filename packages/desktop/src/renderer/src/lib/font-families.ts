import { useSyncExternalStore } from "react";

/**
 * Runtime font families (issue #315).
 *
 * Mirrors lib/themes.ts: the registry's `fontFamilyId` is authoritative, the
 * localStorage mirror keeps the first frame in the chosen family before the
 * store's first backend round-trip resolves, and `applyFontFamily` is the
 * single runtime writer. It re-points the three `--font-*` properties on the
 * document root, which re-themes every Tailwind font utility and base rule
 * with no CSS rebuild — the same mechanism `applyTheme` uses for colour
 * tokens. The "default" stacks match the `@theme` values in style.css, which
 * stay the pre-JS first-paint fallback.
 */

export interface FontFamily {
  id: string;
  label: string;
  /** The --font-display, --font-sans and --font-mono stacks, in that order. */
  display: string;
  sans: string;
  mono: string;
}

export const FONT_FAMILIES: readonly FontFamily[] = [
  {
    id: "default",
    label: "Default",
    display: '"Bricolage Grotesque Variable", ui-sans-serif, system-ui, sans-serif',
    sans: '"Instrument Sans Variable", ui-sans-serif, system-ui, sans-serif',
    mono: '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", monospace',
  },
  {
    id: "ubuntu",
    label: "Ubuntu",
    display: "Ubuntu, ui-sans-serif, system-ui, sans-serif",
    sans: "Ubuntu, ui-sans-serif, system-ui, sans-serif",
    mono: '"Ubuntu Mono", ui-monospace, "SFMono-Regular", monospace',
  },
];

export const DEFAULT_FONT_FAMILY_ID = "default";

/**
 * Mirror of the store's `fontFamilyId`. The renderer needs the family before
 * the first backend round-trip resolves, so localStorage — not the backend —
 * is the read path here.
 */
const KEY = "omp-ui.fontFamilyId";

const DEFAULT_FONT_FAMILY: FontFamily =
  FONT_FAMILIES.find((f) => f.id === DEFAULT_FONT_FAMILY_ID) ?? FONT_FAMILIES[0];

/** Unknown id (renamed family, hand-edited storage) degrades, never throws. */
export function resolveFontFamily(id: string | undefined): FontFamily {
  return FONT_FAMILIES.find((f) => f.id === id) ?? DEFAULT_FONT_FAMILY;
}

let current: FontFamily = DEFAULT_FONT_FAMILY;
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Guarded like `applyTheme`: the store calls this
 * during its own boot, and the store's tests run in vitest's node environment
 * with no `document` and no `localStorage`.
 */
export function applyFontFamily(family: FontFamily): void {
  current = family;

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    root.style.setProperty("--font-display", family.display);
    root.style.setProperty("--font-sans", family.sans);
    root.style.setProperty("--font-mono", family.mono);
  }

  try {
    // The pre-paint boot below reads this mirror, so persisting is what keeps
    // the next launch from flashing the default before the store loads.
    window.localStorage.setItem(KEY, family.id);
  } catch {
    // Storage unavailable (or no DOM at all): the family still applies.
  }

  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied family's id — lets a caller skip a redundant re-apply. */
export function currentFontFamilyId(): string {
  return current.id;
}

/** Current font family, live across every consumer (chrome, code, terminals). */
export function useFontFamily(): FontFamily {
  return useSyncExternalStore(subscribe, () => current);
}

// Boot from the persisted mirror so the first frame paints in the chosen
// family, well before the store's first backend round-trip resolves.
try {
  applyFontFamily(resolveFontFamily(window.localStorage.getItem(KEY) ?? undefined));
} catch {
  // No storage (or no DOM): the default is already applied.
}
