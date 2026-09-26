// Pure helpers for the Settings → Providers web-search order control. Zero imports on
// purpose (like omp-settings-keys.ts) so the renderer bundles it through the
// @omp-ui/core/web-search-order subpath while the spawn half stays main-process only.
//
// omp owns this setting's truth: `providers.webSearchOrder` is a prioritized provider
// list in which UNLISTED providers keep omp's own fallback order. omp-ui therefore
// offers exactly one word — "which provider first" — and writes a one-element array.

/** Select value for the display-only "several providers already ordered" state. */
export const WEB_SEARCH_CUSTOM_OPTION = "__custom__";

/**
 * Parse of `omp models --kind search --json` → provider ids, in catalog
 * order. Unparseable shapes and catalogs with no usable row yield null;
 * rows are dropped unless kind is "search", provider is "web", and id is a
 * non-empty string. Duplicates collapse to the first occurrence.
 */
export function parseWebSearchProviderCatalog(json: unknown): string[] | null {
  const models = (json as { models?: unknown } | null)?.models;
  if (!Array.isArray(models)) return null;
  const seen = new Set<string>();
  const providers: string[] = [];
  for (const raw of models) {
    if (typeof raw !== "object" || raw === null) continue;
    const row = raw as Record<string, unknown>;
    if (row["kind"] !== "search" || row["provider"] !== "web") continue;
    const id = row["id"];
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
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
