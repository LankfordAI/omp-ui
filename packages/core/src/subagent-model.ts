// Subagent model selection (ADR-0031). Pure — zero imports — because the
// renderer imports this module directly via the @omp-ui/core/subagent-model
// subpath, exactly like omp-settings-keys.ts: the same constants name the
// wire values the renderer's picker emits and the main process writes into
// the per-lineage overlay, so the two sides can never drift.
//
// The value grammar is one string per agent, round-tripped unchanged through
// every omp config layer:
//
//   "*"                 — omp's DEFAULT_MODEL_ROLE_ALIAS: the subagent runs on
//                         the parent session's own model ("inherit").
//   "provider/id[:lvl]" — a concrete model, thinking level suffix kept verbatim.
//   "@role"             — an omp role alias, expanded through modelRoles.
//   key absent          — omp's default: the agent's frontmatter `model:` if it
//                         declares one, else the session model.
//
// "" is never a legal value: it resolves to "no pattern", a different and
// worse thing than an absent key (the same trap ADR-0005 records for
// modelRoles.advisor).

/** omp's DEFAULT_MODEL_ROLE_ALIAS: resolves to the parent session's model. */
export const SUBAGENT_MODEL_INHERIT = "*";

/** agent name → omp `model[:level]` selector, `"*"` included. */
export type SubagentModelMap = Record<string, string>;

/**
 * Agent names land as YAML mapping keys in the overlay and the project layer.
 * They are quoted on write, but a name outside identifier shape could never
 * match omp's own agents, so it is refused rather than carried.
 */
export function isSafeAgentName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name);
}

const ROLE_SELECTOR_RE = /^@[A-Za-z0-9][A-Za-z0-9_-]*$/;
// Concrete `provider/id[:level]`. Model ids may carry colons inside the id
// (OpenRouter's `model:exacto`), so the level suffix is not split out here —
// the whole selector is kept verbatim. The charset excludes whitespace,
// quotes, `#`, and every YAML node indicator, because `--config` is a strict
// loader and one malformed line takes the session down (ADR-0005).
const MODEL_SELECTOR_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/**
 * Accepts `"*"`, `"@role"`, and `provider/id[:level]`; rejects whitespace,
 * newline, and any character that could start a YAML node.
 */
export function isSafeSelector(value: string): boolean {
  if (value === SUBAGENT_MODEL_INHERIT) return true;
  if (ROLE_SELECTOR_RE.test(value)) return true;
  return value.includes("/") && MODEL_SELECTOR_RE.test(value);
}

/** Guard for registry/session records: a plain string→string map. */
export function isSubagentModelMap(value: unknown): value is SubagentModelMap {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.entries(value as Record<string, unknown>).every(
    ([name, selector]) =>
      typeof selector === "string" && isSafeAgentName(name) && isSafeSelector(selector),
  );
}

/**
 * Merges config layers, later winning, with null layers dropped. Pure key
 * replacement, matching omp's own deep merge of `task.agentModelOverrides`;
 * validation is the writer's job, not the merge's.
 */
export function mergeSubagentModelMaps(
  ...layers: ReadonlyArray<SubagentModelMap | null>
): SubagentModelMap {
  const out: SubagentModelMap = {};
  for (const layer of layers) {
    if (layer === null) continue;
    Object.assign(out, layer);
  }
  return out;
}

/**
 * The entries a session's overlay carries (ADR-0031): the inherit umbrella
 * fills the whole roster ONLY while the session has expressed no choice of
 * its own (`sessionModels === null`); the first explicit entry replaces the
 * umbrella outright, so an explicit map is the whole overlay. Shared by the
 * spawn path and the live `session:setSubagentModels` rewrite so both emit
 * the same file.
 */
export function resolveSubagentOverlayEntries(
  sessionModels: SubagentModelMap | null,
  inheritByDefault: boolean,
  roster: readonly string[],
): SubagentModelMap {
  const entries: SubagentModelMap = {};
  if (sessionModels === null && inheritByDefault) {
    for (const name of roster) entries[name] = SUBAGENT_MODEL_INHERIT;
  }
  Object.assign(entries, sessionModels ?? {});
  return entries;
}
