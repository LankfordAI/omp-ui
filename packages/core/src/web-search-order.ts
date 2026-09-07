// Pure helpers for the Settings → Providers web-search order control. Zero imports on
// purpose (like omp-settings-keys.ts) so the renderer bundles it through the
// @omp-ui/core/web-search-order subpath while the spawn half stays main-process only.
//
// omp owns this setting's truth: `providers.webSearchOrder` is a prioritized provider
// list in which UNLISTED providers keep omp's own fallback order. omp-ui therefore
// offers exactly one word — "which provider first" — and writes a one-element array.

/** The sentinel omp's own `omp search --provider` choices give to "no preference". */
export const WEB_SEARCH_AUTO_CHOICE = "auto";

/**
 * The value the discovery probe passes to `--provider`. It is not a provider id, so omp
 * rejects it and prints the ids it accepts — the only machine-readable publication of
 * that list in 18.1.10 (ADR-0027). Never writable as a preference.
 */
export const WEB_SEARCH_PROBE_SENTINEL = "omp-ui-provider-probe";

/** Select value for the display-only "several providers already ordered" state. */
export const WEB_SEARCH_CUSTOM_OPTION = "__custom__";

/** `Expected --provider to be one of: auto, exa, …; got "…"` */
const CHOICE_LIST_RE = /Expected --provider to be one of:\s*([^;]+);/;

/** omp's provider ids from a probe's stderr text; null when it published no list. */
export function parseWebSearchProviderList(text: string): string[] | null {
  const match = CHOICE_LIST_RE.exec(text);
  if (match === null || match[1] === undefined) return null;
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const raw of match[1].split(",")) {
    const id = raw.trim();
    if (id === "" || id === WEB_SEARCH_AUTO_CHOICE || seen.has(id)) continue;
    seen.add(id);
    providers.push(id);
  }
  return providers.length > 0 ? providers : null;
}

/** The stored order normalized to unique non-empty strings; never throws. */
export function normalizeWebSearchOrder(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const order: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item === "" || seen.has(item)) continue;
    seen.add(item);
    order.push(item);
  }
  return order;
}

/** What the select displays for a stored order. */
export type WebSearchSelection =
  | { kind: "automatic" }
  | { kind: "provider"; provider: string }
  | { kind: "custom"; providers: string[] };

export function webSearchSelection(value: unknown): WebSearchSelection {
  const order = normalizeWebSearchOrder(value);
  if (order.length === 0) return { kind: "automatic" };
  if (order.length === 1) return { kind: "provider", provider: order[0]! };
  return { kind: "custom", providers: order };
}

/** What a chosen option writes back: `""` clears the preference, else one provider first. */
export function webSearchOrderForOption(optionValue: string): string[] {
  return optionValue === "" || optionValue === WEB_SEARCH_CUSTOM_OPTION
    ? []
    : [optionValue];
}

/** Ids already configured that omp's published list lacks, so they stay selectable. */
export function unknownWebSearchProviders(order: string[], discovered: string[]): string[] {
  const known = new Set(discovered);
  return order.filter((id) => !known.has(id));
}
