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
}

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
  if (main === null || subagents === null || total === null) return null;
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
  };
}
