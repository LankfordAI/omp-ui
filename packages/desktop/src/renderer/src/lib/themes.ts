import { useSyncExternalStore } from "react";
import {
  DEFAULT_THEME_ID,
  deriveTheme,
  effectiveThemeId,
  isStoredTheme,
  mixHex,
  parseThemePreference,
  type Theme,
  type ThemePreference,
  type ThemeSource,
} from "@omp-ui/core/theme";
import { CURATED_THEME_SOURCES } from "@omp-ui/core/theme-sources";

/**
 * Runtime themes (issues #36, #999, #1168).
 *
 * `@omp-ui/core`'s theme-sources table holds the curated themes' raw colours;
 * stored themes (imported VS Code themes and authored ones) arrive from the
 * registry already past the theme gate. Both derive
 * through `@omp-ui/core/theme`: semantic tokens drive CSS directly, while
 * xterm and shiki receive deterministic projections because neither can
 * consume CSS custom properties. The painted theme is the preference's fixed
 * pick, or — in system mode — its light or dark pick, following
 * `prefers-color-scheme`.
 */

export type { Theme, ThemeSource };
export { DEFAULT_THEME_ID, mixHex };

/** The curated themes, in grid order. */
export const THEMES: readonly Theme[] = CURATED_THEME_SOURCES.map(deriveTheme);

/**
 * The theme applied when nothing else resolves — an unknown id, an empty
 * store, or storage that refuses to be read.
 */
const DEFAULT_THEME: Theme = THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0]!;

/**
 * Derived stored themes keyed by id, kept with the serialized source they
 * came from. Every state broadcast structured-clones the sources, so identity
 * cannot key this: content does, which keeps the same Theme object (and so no
 * repaint, re-theme, or re-tokenize) until the theme really changes.
 */
const storedCache = new Map<string, { json: string; theme: Theme }>();

/** The stored themes as consumers read them, in registry order. */
export function storedThemes(sources: readonly ThemeSource[]): Theme[] {
  return sources.map((source) => {
    const json = JSON.stringify(source);
    const hit = storedCache.get(source.id);
    if (hit !== undefined && hit.json === json) return hit.theme;
    const theme = deriveTheme(source);
    storedCache.set(source.id, { json, theme });
    return theme;
  });
}

/**
 * Unknown id (renamed theme, removed stored theme, hand-edited storage)
 * degrades, never throws. Curated ids win: a stored id never shadows one,
 * because every stored id carries the `vscode-` or `custom-` prefix.
 */
export function resolveTheme(id: string | undefined, stored: readonly ThemeSource[] = []): Theme {
  return THEMES.find((t) => t.id === id) ?? storedThemes(stored).find((t) => t.id === id) ?? DEFAULT_THEME;
}

/**
 * Mirror of the store's theme preference and stored themes. The renderer
 * needs the palette before the first backend round-trip resolves, so
 * localStorage — not the backend — is the boot read path. The legacy
 * `omp-ui.themeId` key still seeds a fixed preference on the first launch
 * after an upgrade.
 */
const KEY = "omp-ui.theme";
const LEGACY_KEY = "omp-ui.themeId";

/** What the mirror persists: the preference plus the stored themes it may paint. */
interface ThemeMirror {
  preference: ThemePreference;
  stored: ThemeSource[];
}

let preference: ThemePreference = parseThemePreference(undefined);
let stored: readonly ThemeSource[] = [];
let current: Theme = DEFAULT_THEME;
/** A theme painted over the preference until cleared (the editor's preview). */
let preview: Theme | null = null;
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

/** Persist the preference and only the stored themes it names, for the next first paint. */
function persistMirror(): void {
  const named = new Set([preference.themeId, preference.lightThemeId, preference.darkThemeId]);
  const mirror: ThemeMirror = { preference, stored: stored.filter((t) => named.has(t.id)) };
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
 * Adopt a theme preference and the stored themes it may name, then paint
 * the effective theme. The identity guard is what stops a redundant broadcast
 * from re-writing ~29 custom properties on every state change; stored themes
 * keep their identity across broadcasts until their content changes. While a
 * preview is set the preference is still adopted and mirrored, but the
 * preview keeps the paint.
 */
export function applyThemePreference(next: ThemePreference, nextStored: readonly ThemeSource[]): void {
  preference = next;
  stored = nextStored;
  persistMirror();
  if (preview !== null) return;
  const theme = persistedTheme();
  if (theme !== current) applyTheme(theme);
}

/** The theme the persisted preference resolves to under the current OS scheme. */
function persistedTheme(): Theme {
  return resolveTheme(effectiveThemeId(preference, prefersDarkScheme()), stored);
}

/**
 * Paints `theme` everywhere and holds it against broadcasts and OS scheme
 * flips until cleared. null restores the persisted preference's theme.
 * The mirror never stores a preview: it only ever holds the preference.
 */
export function setThemePreview(theme: Theme | null): void {
  preview = theme;
  if (theme !== null) {
    if (theme !== current) applyTheme(theme);
    return;
  }
  const restored = persistedTheme();
  if (restored !== current) applyTheme(restored);
}

/** The theme being previewed, or null when the preference paints. */
export function currentThemePreview(): Theme | null {
  return preview;
}

/** The persisted preference, for the store's optimistic switch and rollback. */
export function currentThemePreference(): ThemePreference {
  return preference;
}

/** The stored themes the renderer last adopted. */
export function currentStoredThemes(): readonly ThemeSource[] {
  return stored;
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
    const parsed = JSON.parse(raw) as { preference?: unknown; stored?: unknown; imported?: unknown } | null;
    // A mirror written before #1168 names the field `imported`; read it so the
    // first launch after an upgrade still paints the user's theme.
    const rows = parsed?.stored ?? parsed?.imported;
    return {
      preference: parseThemePreference(parsed?.preference),
      stored: Array.isArray(rows) ? rows.filter(isStoredTheme) : [],
    };
  }
  const legacy = window.localStorage.getItem(LEGACY_KEY);
  return legacy === null ? null : { preference: parseThemePreference({ themeId: legacy }), stored: [] };
}

// Boot from the persisted mirror so the palette is right on the first paint,
// well before the store's first backend round-trip resolves.
try {
  // No mirror yet: adopt (and so persist) the default preference, as every
  // launch before the first broadcast has always done.
  const mirror = readMirror() ?? { preference, stored: [] };
  applyThemePreference(mirror.preference, mirror.stored);
  // The default theme is `current` before any paint, so the guard above
  // skips it; paint once so color-scheme and data-theme are set too.
  if (current === DEFAULT_THEME) applyTheme(DEFAULT_THEME);
} catch {
  // No storage (or no DOM), or a corrupt mirror: paint the default.
  applyTheme(DEFAULT_THEME);
}

// System mode follows the OS live: a scheme flip repaints without a backend round-trip.
schemeQuery?.addEventListener("change", () => {
  if (preference.themeMode === "system") applyThemePreference(preference, stored);
});
