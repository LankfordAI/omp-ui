import { useSyncExternalStore } from "react";
import {
  DEFAULT_THEME_ID,
  deriveTheme,
  effectiveThemeId,
  isImportedTheme,
  mixHex,
  parseThemePreference,
  type Theme,
  type ThemePreference,
  type ThemeSource,
} from "@omp-ui/core/theme";
import themeSourcesJson from "./theme-sources.json";

/**
 * Runtime themes (issues #36, #999).
 *
 * `theme-sources.json` holds the curated themes' raw colours; imported VS Code
 * themes arrive from the registry already past the contrast gate. Both derive
 * through `@omp-ui/core/theme`: semantic tokens drive CSS directly, while
 * xterm and shiki receive deterministic projections because neither can
 * consume CSS custom properties. The painted theme is the preference's fixed
 * pick, or — in system mode — its light or dark pick, following
 * `prefers-color-scheme`.
 */

// This annotation deliberately type-checks the imported JSON at the boundary:
// missing tokens/seeds and misspelled override slots fail compilation here.
const THEME_SOURCES: readonly ThemeSource[] = themeSourcesJson;

export type { Theme, ThemeSource };
export { DEFAULT_THEME_ID, mixHex };

/** The curated themes, in grid order. */
export const THEMES: readonly Theme[] = THEME_SOURCES.map(deriveTheme);

/**
 * The theme applied when nothing else resolves — an unknown id, an empty
 * store, or storage that refuses to be read.
 */
const DEFAULT_THEME: Theme = THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0]!;

/**
 * Derived imported themes keyed by id, kept with the serialized source they
 * came from. Every state broadcast structured-clones the sources, so identity
 * cannot key this: content does, which keeps the same Theme object (and so no
 * repaint, re-theme, or re-tokenize) until the theme really changes.
 */
const importedCache = new Map<string, { json: string; theme: Theme }>();

/** The imported themes as consumers read them, in import order. */
export function importedThemes(sources: readonly ThemeSource[]): Theme[] {
  return sources.map((source) => {
    const json = JSON.stringify(source);
    const hit = importedCache.get(source.id);
    if (hit !== undefined && hit.json === json) return hit.theme;
    const theme = deriveTheme(source);
    importedCache.set(source.id, { json, theme });
    return theme;
  });
}

/**
 * Unknown id (renamed theme, removed import, hand-edited storage) degrades,
 * never throws. Curated ids win: an imported id never shadows one, because
 * every imported id carries the `vscode-` prefix.
 */
export function resolveTheme(id: string | undefined, imported: readonly ThemeSource[] = []): Theme {
  return THEMES.find((t) => t.id === id) ?? importedThemes(imported).find((t) => t.id === id) ?? DEFAULT_THEME;
}

/**
 * Mirror of the store's theme preference and imported themes. The renderer
 * needs the palette before the first backend round-trip resolves, so
 * localStorage — not the backend — is the boot read path. The legacy
 * `omp-ui.themeId` key still seeds a fixed preference on the first launch
 * after an upgrade.
 */
const KEY = "omp-ui.theme";
const LEGACY_KEY = "omp-ui.themeId";

/** What the mirror persists: the preference plus the one imported theme it may paint. */
interface ThemeMirror {
  preference: ThemePreference;
  imported: ThemeSource[];
}

let preference: ThemePreference = parseThemePreference(undefined);
let imported: readonly ThemeSource[] = [];
let current: Theme = DEFAULT_THEME;
const listeners = new Set<(theme: Theme) => void>();

/** The OS scheme query; null without a window or matchMedia (node tests, jsdom). */
const schemeQuery: MediaQueryList | null =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;

/** True while the OS prefers a dark scheme; dark when the query is unavailable. */
export function prefersDarkScheme(): boolean {
  return schemeQuery?.matches ?? true;
}

/**
 * The single runtime writer. Everything a palette touches that is not a
 * Tailwind utility — `color-scheme` and the persisted mirror — is repainted
 * here, so no caller has to remember the list. Native window chrome follows
 * through `subscribeTheme` in the store, which owns the backend bridge: this
 * module stays bridge-free because the preload-less plan verifier page imports
 * it (issue #657).
 *
 * Every side effect is individually guarded rather than assumed: the store
 * calls this during its own boot, and the store's tests run in vitest's node
 * environment with no `document` and no `localStorage`.
 */
export function applyTheme(theme: Theme): void {
  current = theme;

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    // Tailwind v4 emits each `@theme` token as a `:root` custom property and
    // utilities that dereference it, so overriding the properties here
    // re-themes every utility and every base rule with no CSS rebuild.
    for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(k, v);
    root.style.colorScheme = theme.dark ? "dark" : "light";
    // For the light-theme utilities and for debugging only — the palette
    // rides the custom properties above, not this attribute.
    root.dataset.theme = theme.id;
  }

  for (const cb of listeners) cb(theme);
}

/** The mirror last written, so an unchanged broadcast writes nothing. */
let persisted: string | null = null;

/** Persist the preference and only the imported themes it names, for the next first paint. */
function persistMirror(): void {
  const named = new Set([preference.themeId, preference.lightThemeId, preference.darkThemeId]);
  const mirror: ThemeMirror = { preference, imported: imported.filter((t) => named.has(t.id)) };
  const json = JSON.stringify(mirror);
  if (json === persisted) return;
  try {
    window.localStorage.setItem(KEY, json);
    persisted = json;
  } catch {
    // Storage unavailable (or no DOM at all): the palette still applies.
  }
}

/**
 * Adopt a theme preference and the imported themes it may name, then paint
 * the effective theme. The identity guard is what stops a redundant broadcast
 * from re-writing ~29 custom properties on every state change; imported
 * themes keep their identity across broadcasts until their content changes.
 */
export function applyThemePreference(next: ThemePreference, nextImported: readonly ThemeSource[]): void {
  preference = next;
  imported = nextImported;
  persistMirror();
  const theme = resolveTheme(effectiveThemeId(next, prefersDarkScheme()), nextImported);
  if (theme !== current) applyTheme(theme);
}

/** The persisted preference, for the store's optimistic switch and rollback. */
export function currentThemePreference(): ThemePreference {
  return preference;
}

/** The imported themes the renderer last adopted. */
export function currentImportedThemes(): readonly ThemeSource[] {
  return imported;
}

/** Runs `cb` with every applied theme; returns the unsubscribe. */
export function subscribeTheme(cb: (theme: Theme) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied theme — the plan surfaces paint with it outside React. */
export function currentTheme(): Theme {
  return current;
}

/** Current theme, live across every consumer (terminal, code blocks, chrome). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribeTheme, () => current);
}

/** Live OS scheme, for the Appearance page's "now showing" line. */
export function usePrefersDarkScheme(): boolean {
  return useSyncExternalStore(
    (cb) => {
      schemeQuery?.addEventListener("change", cb);
      return () => schemeQuery?.removeEventListener("change", cb);
    },
    prefersDarkScheme,
  );
}

/** Read the mirror; an absent one yields null, a malformed one throws to the default. */
function readMirror(): ThemeMirror | null {
  const raw = window.localStorage.getItem(KEY);
  persisted = raw;
  if (raw !== null) {
    const parsed = JSON.parse(raw) as { preference?: unknown; imported?: unknown } | null;
    return {
      preference: parseThemePreference(parsed?.preference),
      imported: Array.isArray(parsed?.imported) ? parsed.imported.filter(isImportedTheme) : [],
    };
  }
  const legacy = window.localStorage.getItem(LEGACY_KEY);
  return legacy === null ? null : { preference: parseThemePreference({ themeId: legacy }), imported: [] };
}

// Boot from the persisted mirror so the palette is right on the first paint,
// well before the store's first backend round-trip resolves.
try {
  // No mirror yet: adopt (and so persist) the default preference, as every
  // launch before the first broadcast has always done.
  const mirror = readMirror() ?? { preference, imported: [] };
  applyThemePreference(mirror.preference, mirror.imported);
  // The default theme is `current` before any paint, so the guard above
  // skips it; paint once so color-scheme and data-theme are set too.
  if (current === DEFAULT_THEME) applyTheme(DEFAULT_THEME);
} catch {
  // No storage (or no DOM), or a corrupt mirror: paint the default.
  applyTheme(DEFAULT_THEME);
}

// System mode follows the OS live: a scheme flip repaints without a backend round-trip.
schemeQuery?.addEventListener("change", () => {
  if (preference.themeMode === "system") applyThemePreference(preference, imported);
});
