// The advisor-stats wire contract. Pure — zero imports — because the renderer
// imports it directly via the @omp-ui/core/advisor-stats subpath, exactly like
// plan.ts. The generating half (which writes the extension file) lives in
// advisor-stats-extension.ts and consumes these same constants, so the two
// sides of the channel can never drift.

/**
 * `setStatus` key carrying the JSON advisor stats. Routed, never rendered raw.
 *
 * omp's rpc surface reports no advisor accounting at all (ADR-0005 verified
 * against v17.1.8): `get_session_stats` and `get_state` carry no advisor
 * breakdown. The live `AgentSession` does — `getAdvisorStats()` returns cost,
 * context tokens, and context window — so omp-ui ships a generated `-e`
 * extension (same delivery as ADR-0007's plan mode) that publishes a reduced
 * view of it over this key.
 */
export const ADVISOR_STATS_KEY = "omp-ui:advisorStats";

/** Slash command the renderer sends to pull fresh advisor stats. */
export const ADVISOR_STATS_COMMAND = "omp-ui-advisor-stats";

/**
 * The reduced advisor-accounting view the extension publishes. Mirrors the
 * fields omp's `getAdvisorStats()` exposes that the HUD renders; `model` is
 * flattened to an id string because omp's `Model` object does not serialize.
 */
export interface AdvisorStatsView {
  /** True when the extension reached the session and read stats at all. */
  available: boolean;
  /** Populated when the extension could not drive omp's surface. */
  unavailable?: string;
  /** `advisor.enabled`, from omp's own runtime — not the UI's record. */
  configured: boolean;
  /** Whether an advisor runtime is actually attached right now. */
  active: boolean;
  /** The resolved advisor model id, or null while unset / unreadable. */
  model: string | null;
  /** Current advisor context window (provider capacity). */
  contextWindow: number;
  /** Current advisor context tokens in use — how deep its context is. */
  contextTokens: number;
  /** Cumulative advisor spend for this session. */
  cost: number;
  /** Cumulative advisor tokens (all kinds) for this session. */
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
      return { available: false, unavailable: record.unavailable, configured: false, active: false, model: null, contextWindow: 0, contextTokens: 0, cost: 0, totalTokens: 0 };
    }
    return null;
  }
  return {
    available: true,
    configured: record.configured === true,
    active: record.active === true,
    model: typeof record.model === "string" ? record.model : null,
    contextWindow: num(record.contextWindow),
    contextTokens: num(record.contextTokens),
    cost: num(record.cost),
    totalTokens: num(record.totalTokens),
  };
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
