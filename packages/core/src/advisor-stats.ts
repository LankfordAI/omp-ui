// The advisor-stats wire contract. Pure — zero imports — because the renderer
// imports it directly via the @omp-ui/core/advisor-stats subpath, exactly like
// plan.ts. The generating half (which writes the extension file) lives in
// advisor-stats-extension.ts and consumes these same constants, so the two
// sides of the channel can never drift.

/**
 * `setStatus` key carrying the JSON advisor stats. Routed, never rendered raw.
 *
 * omp's rpc surface reports no advisor accounting. The generated extension
 * reads the root `AgentSession` plus its task descendants and publishes the
 * reduced session-tree view over this key.
 */
export const ADVISOR_STATS_KEY = "omp-ui:advisorStats";

/** Slash command the renderer sends to pull fresh advisor stats. */
export const ADVISOR_STATS_COMMAND = "omp-ui-advisor-stats";

/**
 * The stable advisor wire view. Configuration, model, subscription, and
 * context fields describe the root advisor. Cost and total tokens cover the
 * root plus every tracked descendant in the current session tree.
 */
export interface AdvisorStatsView {
  /** True when the extension reached the session and read stats at all. */
  available: boolean;
  /** Populated when the extension could not drive omp's surface. */
  unavailable?: string;
  /** Root `advisor.enabled`, from omp's runtime rather than the UI record. */
  configured: boolean;
  /** Whether any advisor runtime in the current session tree is active. */
  active: boolean;
  /** The resolved root advisor model id, or null while unset or unreadable. */
  model: string | null;
  /**
   * True when the root advisor model bills through an OAuth subscription.
   * Absent in frames from older extensions and treated as false. A nonzero
   * aggregate descendant cost still renders numerically.
   */
  subscription: boolean;
  /** Root advisor context window in tokens. */
  contextWindow: number;
  /** Root advisor context tokens currently in use. */
  contextTokens: number;
  /** Cumulative root-plus-descendant advisor spend for this session tree. */
  cost: number;
  /** Cumulative root-plus-descendant advisor tokens of all kinds. */
  totalTokens: number;
}

/** Parses the JSON published on {@link ADVISOR_STATS_KEY}; null when malformed. */
export function parseAdvisorStats(text: string | undefined): AdvisorStatsView | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const record = parsed as Record<string, unknown>;
  if (record.available !== true) {
    // An unavailable publisher still carries the reason to show.
    if (typeof record.unavailable === "string") {
      return { available: false, unavailable: record.unavailable, configured: false, active: false, model: null, subscription: false, contextWindow: 0, contextTokens: 0, cost: 0, totalTokens: 0 };
    }
    return null;
  }
  return {
    available: true,
    configured: record.configured === true,
    active: record.active === true,
    model: typeof record.model === "string" ? record.model : null,
    subscription: record.subscription === true,
    contextWindow: num(record.contextWindow),
    contextTokens: num(record.contextTokens),
    cost: num(record.cost),
    totalTokens: num(record.totalTokens),
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
