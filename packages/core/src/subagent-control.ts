// The subagent-control wire contract (issue #684). Pure — zero imports —
// because the renderer imports it directly via the @omp-ui/core/subagent-control
// subpath, exactly like goal.ts, session-tree.ts, and side-questions.ts. The
// generating half (which writes the extension file) lives in
// subagent-control-extension.ts and consumes these same constants, so the two
// sides of the channel can never drift.
//
// omp's rpc surface reads the roster (`get_subagents`) but offers no verb that
// steers, kills, or revives one subagent: those APIs — AgentLifecycleManager
// (ensureLive/release) and AgentRegistry refs (session.abort) — are in-process
// only (verified against the managed 18.4.2 binary: the rpc dispatch switch has
// no case for them; Agent Hub and the collab host are the only callers). Per
// ADR-0007/0024 that makes this one more per-lineage generated bridge: the
// extension drives omp's own runtime APIs from inside the owned process and
// publishes the correlated result over `ui.setStatus` (ADR-0040).

/** Hidden command family the renderer dispatches (bare args arm; `tool ` verbs). */
export const SUBAGENT_CONTROL_COMMAND = "omp-ui-subagent";

/** `setStatus` key carrying the JSON control snapshot. Routed, never rendered raw. */
export const SUBAGENT_CONTROL_STATUS_KEY = "omp-ui:subagent-control";

/** The arm frame's args: republishes the snapshot without running a verb. */
export const SUBAGENT_CONTROL_ARM_PREFIX = SUBAGENT_CONTROL_COMMAND + " arm";

/** Prefix of a frame carrying one strict-JSON verb envelope. */
export const SUBAGENT_CONTROL_ARG_PREFIX = SUBAGENT_CONTROL_COMMAND + " tool ";

/** Cap on one steer message, checked before anything is sent (never silently truncated). */
export const SUBAGENT_STEER_CHAR_LIMIT = 32_000;

/**
 * Hard cap on the serialized snapshot (UTF-8 bytes). The publisher drops the
 * oldest results to fit; the parser rejects anything over it, leaving the last
 * good snapshot standing.
 */
export const SUBAGENT_CONTROL_STATUS_BYTE_LIMIT = 64 * 1024;

/** The three verbs the Agents pane offers; mirrors omp's Agent Hub controls. */
export type SubagentControlAction = "steer" | "kill" | "revive";

const ACTIONS: readonly SubagentControlAction[] = ["steer", "kill", "revive"];

/** Why the bridge cannot run verbs at all (or could not publish one). */
export type SubagentControlReason = "missing-api" | "read-failed" | "payload-too-large";

const REASONS: readonly SubagentControlReason[] = [
  "missing-api",
  "read-failed",
  "payload-too-large",
];

/** One settled verb, correlated to its dispatch by `requestId`. */
export interface SubagentControlResult {
  requestId: string;
  agentId: string;
  action: SubagentControlAction;
  ok: boolean;
  /** omp's own refusal/failure sentence when `ok` is false — verbatim, never rewritten. */
  error?: string;
  at: number;
}

/** What the root bridge publishes on {@link SUBAGENT_CONTROL_STATUS_KEY}. */
export interface SubagentControlSnapshot {
  available: boolean;
  /** Why the bridge cannot control agents; absent exactly when `available` is true. */
  reason?: SubagentControlReason;
  /** Identifies this generated bridge instance; a respawn mints a new one. */
  processKey: string;
  /** Increases with every publish from this process; stale ones are dropped. */
  revision: number;
  /** Newest-last, ring-capped by the publisher; the renderer correlates by `requestId`. */
  results: SubagentControlResult[];
}

/** One hidden-bridge verb request. */
export interface SubagentControlRequest {
  requestId: string;
  agentId: string;
  action: SubagentControlAction;
  /** The steer text; required for `steer`, ignored otherwise. */
  text?: string;
}

/** The arm frame: bare args republish the snapshot (and bind `ui`). */
export function subagentControlArmMessage(): string {
  return "/" + SUBAGENT_CONTROL_COMMAND;
}

/** The hidden slash command carrying one verb envelope. */
export function subagentControlMessage(request: SubagentControlRequest): string {
  return (
    "/" +
    SUBAGENT_CONTROL_ARG_PREFIX +
    JSON.stringify({ v: 1, request })
  );
}

/**
 * Parses the JSON published on {@link SUBAGENT_CONTROL_STATUS_KEY}. Total:
 * malformed or over-budget input returns null, and the caller keeps the last
 * good snapshot — nothing is ever half-applied (the side-questions discipline).
 */
export function parseSubagentControlSnapshot(
  text: string | undefined,
): SubagentControlSnapshot | null {
  if (text === undefined) return null;
  if (utf8Length(text) > SUBAGENT_CONTROL_STATUS_BYTE_LIMIT) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (record === null) return null;
  if (typeof record.available !== "boolean") return null;
  if (record.reason !== undefined) {
    if (typeof record.reason !== "string" || !REASONS.includes(record.reason as SubagentControlReason))
      return null;
  }
  const processKey = nonEmptyString(record.processKey);
  if (processKey === null) return null;
  if (
    typeof record.revision !== "number" ||
    !Number.isInteger(record.revision) ||
    record.revision < 0
  )
    return null;
  if (!Array.isArray(record.results)) return null;
  const results: SubagentControlResult[] = [];
  for (const value of record.results) {
    const item = asRecord(value);
    if (item === null) return null;
    const requestId = nonEmptyString(item.requestId);
    const agentId = nonEmptyString(item.agentId);
    if (requestId === null || agentId === null) return null;
    if (typeof item.action !== "string" || !ACTIONS.includes(item.action as SubagentControlAction))
      return null;
    if (typeof item.ok !== "boolean") return null;
    if (item.error !== undefined && typeof item.error !== "string") return null;
    if (
      typeof item.at !== "number" ||
      !Number.isFinite(item.at) ||
      item.at < 0 ||
      item.at > 8_640_000_000_000_000
    )
      return null;
    results.push({
      requestId,
      agentId,
      action: item.action as SubagentControlAction,
      ok: item.ok,
      ...(item.error !== undefined ? { error: item.error } : {}),
      at: item.at,
    });
  }
  return {
    available: record.available,
    ...(record.reason !== undefined ? { reason: record.reason as SubagentControlReason } : {}),
    processKey,
    revision: record.revision,
    results,
  };
}

/** The settled result of one dispatch, newest-last scan. */
export function findSubagentControlResult(
  snapshot: SubagentControlSnapshot | null,
  requestId: string,
): SubagentControlResult | undefined {
  if (snapshot === null) return undefined;
  for (let i = snapshot.results.length - 1; i >= 0; i--) {
    const result = snapshot.results[i];
    if (result.requestId === requestId) return result;
  }
  return undefined;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** UTF-8 byte length without runtime imports (pure scan, no allocation). */
function utf8Length(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      bytes += 4;
      i++;
    } else bytes += 3;
  }
  return bytes;
}
