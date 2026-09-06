// The goal-command wire contract. Pure — zero runtime imports — because the
// renderer imports it directly via the @omp-ui/core/goal subpath, exactly like
// capabilities.ts and plan.ts. The generating half (which writes the extension
// file) lives in goal-extension.ts and consumes these same constants, so the
// two sides of the channel can never drift.
//
// omp's own goal surface is TUI-only: `builtin-registry.ts` gives `goal` and
// `guided-goal` a `handleTui` and no `handle`, `available-commands.ts` excludes
// definitions without `handle`, and the noninteractive dispatcher skips them —
// so over rpc-ui a `/goal` line would reach the model as literal prompt text.
// The bridge below is what lets omp-ui drive omp's real `GoalRuntime` instead.

/**
 * `setStatus` key carrying the JSON goal snapshot. Routed, never rendered raw.
 */
export const GOAL_STATUS_KEY = "omp-ui:goal";

/** Hidden slash command the spawner arms with, and the renderer dispatches on. */
export const GOAL_COMMAND = "omp-ui-goal";

/** Arg prefix separating the hidden arm from one correlated goal command. */
export const GOAL_COMMAND_ARG_PREFIX = "command ";

/**
 * Cap on the objective text a command may carry. Checked before anything is
 * sent, so an oversized goal is refused rather than silently truncated on the
 * way into omp's runtime.
 */
export const GOAL_OBJECTIVE_CHAR_LIMIT = 16_384;

/**
 * Hard cap on the serialized snapshot (UTF-8 bytes). The publisher replaces an
 * impossible payload with an `unavailable` snapshot instead of emitting half a
 * goal, and the parser rejects anything over it.
 */
export const GOAL_STATUS_BYTE_LIMIT = 256 * 1024;

/**
 * Settle window before an autonomous continuation, matching omp's interactive
 * mode (which defers 800 ms so the user can press Esc between turns).
 */
export const GOAL_SETTLE_MS = 800;

/**
 * The custom-message type omp's own runtime names for a continuation turn.
 * Reused verbatim so omp-ui's continuation is indistinguishable from the TUI's.
 */
export const GOAL_CONTINUATION_CUSTOM_TYPE = "goal-continuation";

/** Visible kickoff message type for a goal this UI created or replaced. */
export const GOAL_START_CUSTOM_TYPE = "omp-ui:goal-start";

/** Visible kickoff message type for one guided-goal interview. */
export const GOAL_GUIDED_CUSTOM_TYPE = "omp-ui:guided-goal";

/**
 * Registry key holding the one root-local mode-transition chain shared by the
 * plan and goal bridges, so Plan entry and goal activation cannot both win.
 * `Symbol.for` makes it one chain per process across independently generated
 * extension modules.
 */
export const GOAL_MODE_TRANSITION_KEY = "omp-ui:mode-transition";

/**
 * The four states omp-ui renders. omp's fifth, `dropped`, is never published:
 * a dropped goal means `goal: null`, not a goal whose status is "dropped".
 */
export type GoalStatus = "active" | "paused" | "budget-limited" | "complete";

/** One goal, read back from omp's own runtime. Never a second copy of it. */
export interface NativeGoal {
  id: string;
  objective: string;
  status: GoalStatus;
  /** Total token budget for the goal, or null when unbounded. */
  tokenBudget: number | null;
  tokensUsed: number;
  timeUsedSeconds: number;
  createdAt: number;
  updatedAt: number;
}

/** What the root bridge publishes on {@link GOAL_STATUS_KEY}. */
export interface GoalSnapshot {
  version: 1;
  /** Identifies this generated bridge instance; a restart mints a new one. */
  processKey: string;
  sessionId: string;
  /** Increases with every publish from this process; stale ones are dropped. */
  revision: number;
  /** False only when the bridge cannot drive goals at all. */
  available: boolean;
  /** Why the bridge is unavailable; null exactly when `available` is true. */
  unavailable: string | null;
  /** omp's goal-mode armed flag; mirrors `GoalModeState.enabled`. */
  enabled: boolean;
  goal: NativeGoal | null;
  /** Whether this bridge has an autonomous continuation pending or in flight. */
  continuation: "idle" | "scheduled" | "running";
  /** Why the goal stopped being driven autonomously, when it has. */
  pauseReason: string | null;
  /** The latest command result, correlated by the client's requestId. */
  result: {
    requestId: string;
    ok: boolean;
    text: string;
  } | null;
}

/** One dispatched goal command, sent inside {@link goalMessage}. */
export interface GoalCommandRequest {
  /** Correlation id minted by the client that owns the command row. */
  requestId: string;
  sessionId: string;
  processKey: string;
  command: "goal" | "guided-goal";
  /** Everything after the command name, verbatim (may be empty). */
  args: string;
}

/** Hidden slash command that arms the bridge and binds its UI context. */
export function goalArmMessage(): string {
  return `/${GOAL_COMMAND}`;
}

/** Hidden slash command carrying one correlated goal command. */
export function goalMessage(request: GoalCommandRequest): string {
  return `/${GOAL_COMMAND} ${GOAL_COMMAND_ARG_PREFIX}${JSON.stringify(request)}`;
}

/** Tokens left before the budget is met; unbounded goals have none to show. */
export function goalRemainingTokens(goal: NativeGoal): number | null {
  return goal.tokenBudget === null ? null : Math.max(0, goal.tokenBudget - goal.tokensUsed);
}

/**
 * Parses the JSON published on {@link GOAL_STATUS_KEY}, from either a decoded
 * object or a JSON string, and is total: anything malformed returns null and
 * is never mistaken for "no goal". Unknown fields are dropped rather than
 * trusted. `available` and `unavailable` must agree, and `enabled` must agree
 * with the goal's status (only an active or budget-limited goal is armed), so a
 * half-written snapshot can never render as a live goal.
 */
export function parseGoalSnapshot(value: unknown): GoalSnapshot | null {
  const record = asRecord(typeof value === "string" ? safeParse(value) : value);
  if (record === null) return null;
  if (utf8Length(JSON.stringify(record)) > GOAL_STATUS_BYTE_LIMIT) return null;
  if (record.version !== 1) return null;
  const processKey = nonEmptyString(record.processKey);
  const sessionId = nonEmptyString(record.sessionId);
  if (processKey === null || sessionId === null) return null;
  if (typeof record.revision !== "number" || !Number.isInteger(record.revision) || record.revision < 0) {
    return null;
  }
  if (typeof record.available !== "boolean") return null;
  if (record.unavailable !== null && typeof record.unavailable !== "string") return null;
  if (record.available === (record.unavailable !== null)) return null;
  const continuation = record.continuation;
  if (continuation !== "idle" && continuation !== "scheduled" && continuation !== "running") {
    return null;
  }
  if (record.pauseReason !== null && typeof record.pauseReason !== "string") return null;
  if (typeof record.enabled !== "boolean") return null;
  const goal = parseGoal(record.goal);
  if (goal === INVALID) return null;
  // `enabled` is omp's armed flag: it holds for exactly the accounting statuses.
  const armed = goal !== null && (goal.status === "active" || goal.status === "budget-limited");
  if (record.enabled !== armed) return null;
  const result = parseResult(record.result);
  if (result === INVALID) return null;
  return {
    version: 1,
    processKey,
    sessionId,
    revision: record.revision,
    available: record.available,
    unavailable: record.unavailable as string | null,
    enabled: record.enabled,
    goal,
    continuation,
    pauseReason: record.pauseReason as string | null,
    result,
  };
}

/**
 * Strictly parses one command request out of hidden-command args. Malformed or
 * over-budget payloads return null — never a half-applied command. Unknown
 * fields are rejected so a future schema cannot be silently partially read.
 */
export function parseGoalCommandRequest(args: string): GoalCommandRequest | null {
  const trimmed = args.trim();
  if (trimmed === "") return null;
  const spaceAt = trimmed.search(/\s/);
  const prefix = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  if (prefix !== "command") return null;
  const json = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1);
  const record = asRecord(safeParse(json));
  if (record === null) return null;
  const keys = Object.keys(record).sort();
  const expected = ["args", "command", "processKey", "requestId", "sessionId"];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return null;
  const requestId = nonEmptyString(record.requestId);
  const processKey = nonEmptyString(record.processKey);
  const sessionId = nonEmptyString(record.sessionId);
  if (requestId === null || processKey === null || sessionId === null) return null;
  if (record.command !== "goal" && record.command !== "guided-goal") return null;
  if (typeof record.args !== "string") return null;
  return { requestId, processKey, sessionId, command: record.command, args: record.args };
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNonNegative(value: unknown): number | typeof INVALID {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return INVALID;
  return value;
}

/**
 * A goal is either absent (null) or complete and self-consistent. omp's own
 * budget rule is a positive safe integer, so that is the only shape accepted;
 * `tokenBudget: 0` is malformed, not "spend nothing".
 */
function parseGoal(value: unknown): NativeGoal | null | typeof INVALID {
  if (value === null) return null;
  const record = asRecord(value);
  if (record === null) return INVALID;
  const id = nonEmptyString(record.id);
  const objective = typeof record.objective === "string" ? record.objective : null;
  if (id === null || objective === null) return INVALID;
  const status = record.status;
  if (
    status !== "active" &&
    status !== "paused" &&
    status !== "budget-limited" &&
    status !== "complete"
  ) {
    return INVALID;
  }
  const budget = record.tokenBudget;
  if (budget !== null && !(typeof budget === "number" && Number.isSafeInteger(budget) && budget > 0)) {
    return INVALID;
  }
  const tokensUsed = finiteNonNegative(record.tokensUsed);
  const timeUsedSeconds = finiteNonNegative(record.timeUsedSeconds);
  const createdAt = finiteNonNegative(record.createdAt);
  const updatedAt = finiteNonNegative(record.updatedAt);
  if (tokensUsed === INVALID || timeUsedSeconds === INVALID || createdAt === INVALID || updatedAt === INVALID) {
    return INVALID;
  }
  return {
    id,
    objective,
    status,
    tokenBudget: budget === null ? null : budget,
    tokensUsed,
    timeUsedSeconds,
    createdAt,
    updatedAt,
  };
}

function parseResult(
  value: unknown,
): GoalSnapshot["result"] | null | typeof INVALID {
  if (value === null) return null;
  const record = asRecord(value);
  if (record === null) return INVALID;
  const requestId = nonEmptyString(record.requestId);
  if (requestId === null || typeof record.ok !== "boolean" || typeof record.text !== "string") {
    return INVALID;
  }
  return { requestId, ok: record.ok, text: record.text };
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
