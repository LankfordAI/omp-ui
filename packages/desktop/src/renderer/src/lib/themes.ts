import { useSyncExternalStore } from "react";
import { DEFAULT_THEME_ID, resolveTheme, type Theme } from "@omp-ui/plan-doc";
import { desktop } from "../desktop";

/**
 * Runtime themes (issue #36): the applied-theme state.
 *
 * The palette table itself — token names, derivations, `THEMES`,
 * `resolveTheme` — lives in `@omp-ui/plan-doc` so the plan pipeline and the
 * headless verifier share it. This module owns what only a live document
 * has: the one applied theme, its DOM/storage/native-chrome side effects,
 * and the React subscription.
 */
export { DEFAULT_THEME_ID, resolveTheme, THEMES, type Theme } from "@omp-ui/plan-doc";

/**
 * Mirror of the store's `themeId`. The renderer needs the palette before the
 * first backend round-trip resolves, and the pre-paint boot script needs it
 * synchronously, so localStorage — not the backend — is the read path here.
 */
const KEY = "omp-ui.themeId";

let current: Theme = resolveTheme(DEFAULT_THEME_ID);
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Everything a palette touches that is not a
 * Tailwind utility — `color-scheme`, the persisted mirror, the native window
 * chrome — is repainted here, so no caller has to remember the list.
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

  try {
    // The pre-paint boot script reads this mirror, so persisting is what
    // keeps the next launch from flashing graphite before the store loads.
    window.localStorage.setItem(KEY, theme.id);
  } catch {
    // Storage unavailable (or no DOM at all): the palette still applies.
  }

  // Native chrome is painted by the OS, not CSS — the frameless titlebar
  // overlay only changes through the desktop client. A browser client has no
  // adapter and no native chrome to repaint. The module may load under test
  // with no window, and main already swallows platform errors, so neither a
  // missing adapter nor a rejected call may take the switch down with it.
  try {
    void desktop
      ?.setWindowChrome(theme.tokens["--color-void"], theme.tokens["--color-ink-mid"])
      .catch(() => {});
  } catch {
    // No adapter: native chrome keeps its previous colour.
  }

  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied theme's id — lets a caller skip a redundant re-apply. */
export function currentThemeId(): string {
  return current.id;
}

/** Current theme, live across every consumer (terminal, code blocks, chrome). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current);
}

// Boot from the persisted mirror so the palette is right on the first paint,
// well before the store's first backend round-trip resolves.
try {
  applyTheme(resolveTheme(window.localStorage.getItem(KEY) ?? undefined));
} catch {
  // No storage (or no DOM): the default is already applied.
}
