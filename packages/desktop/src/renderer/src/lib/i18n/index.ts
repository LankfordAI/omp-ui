import { useSyncExternalStore } from "react";
import { en } from "./en";
import { ko } from "./ko";
import type { MessageKey } from "./types";

export type { MessageKey } from "./types";

export interface UiLocale {
  id: "en" | "ko";
  /** Native name, as shown in the settings row. */
  label: string;
  /** BCP-47 tag for Intl formatting. */
  tag: string;
}

export const UI_LOCALES: readonly UiLocale[] = [
  { id: "en", label: "English", tag: "en" },
  { id: "ko", label: "한국어", tag: "ko" },
];

export const DEFAULT_LOCALE_ID = "en";
const KEY = "omp-ui.localeId";

/** Unknown id (hand-edited registry, newer build) degrades to English, never throws. */
export function resolveLocale(id: string | undefined): UiLocale {
  return UI_LOCALES.find((l) => l.id === id) ?? UI_LOCALES[0]!;
}

let current: UiLocale = resolveLocale(DEFAULT_LOCALE_ID);
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Mirrors applyTheme/applyFontFamily: guarded for
 * the store's node-environment tests (no document, no localStorage).
 */
export function applyLocale(locale: UiLocale): void {
  current = locale;
  try {
    window.localStorage.setItem(KEY, locale.id);
  } catch {
    // Storage unavailable (or no DOM at all): the locale still applies.
  }
  for (const cb of listeners) cb();
}

export function currentLocaleId(): string {
  return current.id;
}

/** BCP-47 tag for Intl.DateTimeFormat / toLocaleString / toLocaleTimeString. */
export function localeTag(): string {
  return current.tag;
}

/**
 * Translate one catalog key under the ACTIVE locale: Korean only while the
 * locale is ko (falling back to English for a key ko lacks), English
 * otherwise. Then {var} substitution; a var absent from `vars` substitutes
 * to "" (never the raw placeholder, never HTML).
 */
export function t(key: MessageKey, vars?: Record<string, string | number>): string {
  const template = current.id === "ko" ? (ko[key] ?? en[key]) : en[key];
  if (vars === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (_, name: string) =>
    name in vars ? String(vars[name]) : "",
  );
}

/**
 * Subscribe to locale changes. Exposed as a test seam (mirrors the module's
 * public surface: components reach it through useT).
 */
export function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Re-renders the component when the locale changes; returns stable t. */
export function useT(): (key: MessageKey, vars?: Record<string, string | number>) => string {
  useSyncExternalStore(subscribe, () => current);
  return t;
}

// Pre-paint boot: the localStorage mirror keeps the first frame in the
// persisted locale, well before the store's first state:changed (same pattern
// as font-families.ts / themes.ts).
try {
  applyLocale(resolveLocale(window.localStorage.getItem(KEY) ?? undefined));
} catch {
  // No storage (or no DOM): the default is already applied.
}
