// Pure helpers for the Settings → Providers web-search order control. Zero imports on
// purpose (like omp-settings-keys.ts) so the renderer bundles it through the
// @omp-ui/core/web-search-order subpath while the spawn half stays main-process only.
//
// omp owns this setting's truth: `providers.webSearchOrder` is a prioritized provider
// list in which UNLISTED providers keep omp's own fallback order. omp-ui therefore
// offers exactly one word — "which provider first" — and writes a one-element array.
// The module serves both bindings: that legacy one-element-order key and, on omp
// ≥ 18.2.x, the `web` role of `modelRoles` (ADR-0036).

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

/** The modelRoles.web selector prefix for a search provider from the model catalog. */
const WEB_ROLE_PREFIX = "web/";

/** What the role-bound select displays for a modelRoles record. */
export type WebSearchRoleSelection =
  | { kind: "automatic" }
  | { kind: "provider"; provider: string }
  | { kind: "selector"; selector: string };

/**
 * The record's `web` role as a select state: absent, empty, or non-string →
 * automatic (Automatic; a clean pick replaces whatever junk a hand-edit left);
 * `web/<id>` → that id verbatim (no level-stripping, so `web/brave:high` stays
 * round-trip-safe and reads as an unknown id); any other non-empty string →
 * the disabled `selector` state, shown rather than silently collapsed.
 */
export function webSearchRoleSelection(
  record: Record<string, unknown>,
): WebSearchRoleSelection {
  const role = record["web"];
  if (typeof role !== "string" || role === "") return { kind: "automatic" };
  if (role.startsWith(WEB_ROLE_PREFIX)) {
    const id = role.slice(WEB_ROLE_PREFIX.length);
    if (id !== "") return { kind: "provider", provider: id };
  }
  return { kind: "selector", selector: role };
}

/** What the role select writes: `""`/custom → null (omit the web key), else the selector. */
export function webSearchSelectorForOption(optionValue: string): string | null {
  return optionValue === "" || optionValue === WEB_SEARCH_CUSTOM_OPTION
    ? null
    : WEB_ROLE_PREFIX + optionValue;
}

/**
 * The full merged global modelRoles record to REPLACE with (ADR-0031): the
 * globalValue record with web set or deleted — merged against the GLOBAL layer,
 * never the effective value, so a project binding is not baked into global
 * config (the SubagentModelsSection precedent).
 */
export function mergeWebSearchRole(
  globalValue: unknown,
  selector: string | null,
): Record<string, unknown> {
  const merged: Record<string, unknown> =
    typeof globalValue === "object" && globalValue !== null && !Array.isArray(globalValue)
      ? { ...(globalValue as Record<string, unknown>) }
      : {};
  if (selector === null) delete merged["web"];
  else merged["web"] = selector;
  return merged;
}

/**
 * Which layer provides the web role's own value. The whole-record entry.layer
 * would badge `project` when an UNRELATED role (advisor) is project-overridden,
 * so derive it per key: web differs from global → project; web in the global
 * record → global; nowhere → default. Structural union mirrors OmpSettingLayer
 * without importing it (the module stays zero-import).
 */
export function webSearchRoleLayer(
  effectiveValue: unknown,
  globalValue: unknown,
): "project" | "global" | "default" {
  const web = (value: unknown): string | undefined => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
    const role = (value as Record<string, unknown>)["web"];
    return typeof role === "string" && role !== "" ? role : undefined;
  };
  const effective = web(effectiveValue);
  const global = web(globalValue);
  if (effective !== global) return "project";
  return global === undefined ? "default" : "global";
}
