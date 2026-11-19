// The whole-session spend wire contract (issue #866, ADR-0056). Pure — zero
// runtime imports — because the renderer imports it directly via the
// @omp-ui/core/session-spend subpath, exactly like async-jobs.ts. The
// generating half lives in session-spend-extension.ts and interpolates these
// same constants, so the publisher and the parser can never drift.
//
// omp's get_session_stats sums only the live LLM context: compaction drops
// every earlier assistant message and background subagents never count. The
// bridge reads the session's own transcripts from disk instead — the root
// journal plus every non-advisor transcript under its artifacts dir.

/** setStatus key the generated bridge publishes on. Routed, never rendered raw. */
export const SESSION_SPEND_STATUS_KEY = "omp-ui:session-spend";

/** Hidden slash command: bare = arm + force-publish. */
export const SESSION_SPEND_COMMAND = "omp-ui-session-spend";

/** Poll cadence; a publish only leaves the process when the digest changed. */
export const SESSION_SPEND_POLL_MS = 2_000;
/** Idle cadence once a poll published nothing new; a change returns to SESSION_SPEND_POLL_MS. */
export const SESSION_SPEND_POLL_IDLE_MS = 10_000;

export interface SpendTotals {
  cost: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  premiumRequests: number;
  /** Assistant messages plus model_usage entries counted. */
  requests: number;
}

/**
 * How a prompt-cache refresh reaches the provider, as omp's
 * `cache_warming_start`/`cache_warming_end` frames report it (omp 19; older
 * harnesses send these frames without a method). "prewarm" is a
 * `max_tokens: 0` pre-warm, "replay" a one-token replay cut off at its first
 * output — the vocabularies are omp's, verified against v19.0.0
 * `packages/coding-agent/src/session/cache-warmer.ts`.
 */
export type CacheWarmingMethod = "prewarm" | "replay";

/** The two refresh-lifecycle frames that carry the method. */
const CACHE_WARMING_EVENT_TYPES: Record<string, true> = {
  cache_warming_start: true,
  cache_warming_end: true,
};

/**
 * The method of a `cache_warming_start`/`cache_warming_end` frame, or null
 * for any other frame and for frames without a reported method — a 18.22.x
 * refresh frame, or a v19 frame whose request could not be refreshed safely.
 * Never inferred from anything but the `method` field itself.
 */
export function parseCacheWarmingMethod(value: unknown): CacheWarmingMethod | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  // The hasOwn guard before the mapped value, same defense every frame
  // parser here runs against wire strings like "constructor".
  if (typeof record.type !== "string" || !Object.hasOwn(CACHE_WARMING_EVENT_TYPES, record.type)) return null;
  return record.method === "prewarm" || record.method === "replay" ? record.method : null;
}

export interface SessionSpendSnapshot {
  version: 1;
  processKey: string;
  revision: number;
  available: boolean;
  unavailable: string | null;
  /** Root session file the totals describe; null when unpersisted. */
  sessionFile: string | null;
  /** Root journal direct usage. */
  main: SpendTotals;
  /** Every non-advisor transcript under the artifacts dir, all depths. */
  subagents: SpendTotals;
  /** main + subagents. */
  total: SpendTotals;
  /** Subagent transcripts that contributed (not ignored). */
  transcripts: number;
  /**
   * Billed cache-warm refreshes journaled under model_usage purpose
   * "cache-warm" (or "cache-warm:extension-override"), main plus subagents.
   * A subset of `total`, never an addition to it: omp journals these entries
   * itself, so the totals above already carry their cost — this block only
   * attributes part of it back to warming (issue #1238).
   */
  cacheWarm: SpendTotals;
}

/** model_usage purpose omp writes for a billed cache-warm refresh. */
export const CACHE_WARM_PURPOSE = "cache-warm";

const SPEND_TOTALS_KEYS = [
  "cost",
  "input",
  "output",
  "reasoning",
  "cacheRead",
  "cacheWrite",
  "totalTokens",
  "premiumRequests",
  "requests",
] as const satisfies ReadonlyArray<keyof SpendTotals>;

/** The bare arm prompt that binds the bridge and force-republishes. */
export function sessionSpendArmMessage(): string {
  return `/${SESSION_SPEND_COMMAND}`;
}

export function emptySpendTotals(): SpendTotals {
  return {
    cost: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    premiumRequests: 0,
    requests: 0,
  };
}

/** One wire totals block; null when any field is missing, non-finite, or negative. */
function readTotals(value: unknown): SpendTotals | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const totals = emptySpendTotals();
  for (const key of SPEND_TOTALS_KEYS) {
    const field = record[key];
    if (typeof field !== "number" || !Number.isFinite(field) || field < 0) return null;
    totals[key] = field;
  }
  return totals;
}

/** Parses the JSON published on SESSION_SPEND_STATUS_KEY; null when malformed in any part. */
export function parseSessionSpendSnapshot(text: string | undefined): SessionSpendSnapshot | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  const { processKey, revision, available, unavailable, sessionFile, transcripts } = record;
  if (typeof processKey !== "string" || processKey === "") return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof available !== "boolean") return null;
  if (!(unavailable === null || typeof unavailable === "string")) return null;
  if (!(sessionFile === null || typeof sessionFile === "string")) return null;
  if (typeof transcripts !== "number" || !Number.isInteger(transcripts) || transcripts < 0) return null;
  const main = readTotals(record.main);
  const subagents = readTotals(record.subagents);
  const total = readTotals(record.total);
  const cacheWarm = readTotals(record.cacheWarm);
  if (main === null || subagents === null || total === null || cacheWarm === null) return null;
  return {
    version: 1,
    processKey,
    revision,
    available,
    unavailable: unavailable as string | null,
    sessionFile: sessionFile as string | null,
    main,
    subagents,
    total,
    transcripts,
    cacheWarm,
  };
}
