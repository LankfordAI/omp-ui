// The autoresearch wire contract. Pure — zero runtime imports — because the
// renderer imports it directly via the @omp-ui/core/autoresearch subpath,
// exactly like goal.ts. The generating half (which writes the bridge
// extension) lives in autoresearch-extension.ts and consumes these same
// constants, so the publishing side and the parser can never drift.
//
// omp's `/autoresearch` is a real extension command over rpc-ui (verified on
// v18.2.4): it dispatches without a dialog, and omp keeps its control state as
// `custom` session entries (`autoresearch-control`) that no rpc frame carries.
// The bridge reads those entries through `sessionManager.getBranch()` and
// publishes a reduced snapshot; run history is read from omp's SQLite DB by
// autoresearch-store.ts (ADR-0030). omp-ui never re-implements the loop.

/** setStatus key the generated bridge publishes on. Routed, never rendered raw. */
export const AUTORESEARCH_STATUS_KEY = "omp-ui:autoresearch";

/** Hidden arm command the spawner sends; binds ctx.ui and publishes the first snapshot. */
export const AUTORESEARCH_COMMAND = "omp-ui-autoresearch";

/** omp's own setWidget key for its TUI dashboard; swallowed in native tabs. */
export const AUTORESEARCH_WIDGET_KEY = "autoresearch";

/** omp's session-entry customType carrying mode/goal changes. */
export const AUTORESEARCH_CONTROL_TYPE = "autoresearch-control";

/** omp's visible command; the launch flow sends it bare. */
export const AUTORESEARCH_SLASH = "autoresearch";

/** Branch prefix omp checks for "dedicated autoresearch branch" behavior. */
export const AUTORESEARCH_BRANCH_PREFIX = "autoresearch/";

export const AUTORESEARCH_TOOLS = [
  "init_experiment",
  "run_experiment",
  "log_experiment",
  "update_notes",
] as const;
export type AutoresearchTool = (typeof AUTORESEARCH_TOOLS)[number];

/** Hard cap on the serialized snapshot (UTF-8 bytes); over it publishes `unavailable`. */
export const AUTORESEARCH_STATUS_BYTE_LIMIT = 64 * 1024;

/** Goal text is published verbatim up to this many chars; longer goals publish `goalTruncated: true`. */
export const AUTORESEARCH_GOAL_CHAR_LIMIT = 4096;

export type AutoresearchMode = "on" | "off";

/** What the root bridge publishes on {@link AUTORESEARCH_STATUS_KEY}. */
export interface AutoresearchSnapshot {
  version: 1;
  /** Identifies this generated bridge instance; a restart mints a new one. */
  processKey: string;
  /** "" until the session materializes. */
  sessionId: string;
  /** Increases with every publish from this process; stale ones are dropped. */
  revision: number;
  /** False only when the bridge cannot read control state at all. */
  available: boolean;
  /** Why the bridge is unavailable; null exactly when `available` is true. */
  unavailable: string | null;
  /** Latest `autoresearch-control` on the session branch; "clear" reads as off. */
  mode: AutoresearchMode;
  /** Latest control goal; null after "clear" or when never set. */
  goal: string | null;
  goalTruncated: boolean;
  /** Last autoresearch tool this bridge saw finish; null before the first one. */
  lastTool: { name: AutoresearchTool; at: number; isError: boolean } | null;
}

/** Hidden slash command that arms the bridge and binds its UI context. */
export function autoresearchArmMessage(): string {
  return `/${AUTORESEARCH_COMMAND}`;
}

/**
 * Parses the JSON published on {@link AUTORESEARCH_STATUS_KEY}, from either a
 * decoded object or the raw status text. Total: malformed or over-budget
 * input returns null — never "off" — so a bad publish leaves the last good
 * snapshot standing. Same discipline as parseGoalSnapshot.
 */
export function parseAutoresearchSnapshot(value: unknown): AutoresearchSnapshot | null {
  const record = asRecord(typeof value === "string" ? safeParse(value) : value);
  if (record === null) return null;
  if (utf8Length(JSON.stringify(record)) > AUTORESEARCH_STATUS_BYTE_LIMIT) return null;
  if (record.version !== 1) return null;
  const processKey = record.processKey;
  if (typeof processKey !== "string" || processKey.length === 0) return null;
  if (typeof record.sessionId !== "string") return null;
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 0) {
    return null;
  }
  if (typeof record.available !== "boolean") return null;
  if (record.unavailable !== null && typeof record.unavailable !== "string") return null;
  if (record.available === (record.unavailable !== null)) return null;
  const mode = record.mode;
  if (mode !== "on" && mode !== "off") return null;
  if (record.goal !== null && typeof record.goal !== "string") return null;
  if (typeof record.goalTruncated !== "boolean") return null;
  const lastTool = parseLastTool(record.lastTool);
  if (lastTool === INVALID) return null;
  return {
    version: 1,
    processKey,
    sessionId: record.sessionId,
    revision: record.revision,
    available: record.available,
    unavailable: record.unavailable as string | null,
    mode,
    goal: record.goal as string | null,
    goalTruncated: record.goalTruncated,
    lastTool,
  };
}

const INVALID = Symbol("invalid");

function safeParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function isAutoresearchTool(value: unknown): value is AutoresearchTool {
  return typeof value === "string" && (AUTORESEARCH_TOOLS as readonly string[]).includes(value);
}

function parseLastTool(
  value: unknown,
): AutoresearchSnapshot["lastTool"] | typeof INVALID {
  if (value === null) return null;
  const record = asRecord(value);
  if (record === null) return INVALID;
  if (!isAutoresearchTool(record.name)) return INVALID;
  if (typeof record.at !== "number" || !Number.isFinite(record.at) || record.at < 0) return INVALID;
  if (typeof record.isError !== "boolean") return INVALID;
  return { name: record.name, at: record.at, isError: record.isError };
}

/** UTF-8 byte length without runtime imports (pure scan, no allocation). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xdc00 && code < 0xe000) bytes += 0;
    else if (code >= 0xd800 && code < 0xdc00) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
