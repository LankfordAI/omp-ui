// The goal wire contract (ADR-0046). Pure — zero runtime imports — because
// the renderer imports it directly via the @omp-ui/core/goal subpath, exactly
// like capabilities.ts and plan.ts.
//
// omp (>= 18.4.11) drives goal mode natively over rpc-ui: the
// `{ type: "goal", op }` command, `get_state.goal`, and `goal_updated` events
// all carry one GoalModeState. Main and the renderer both parse those frames
// with {@link goalStateFromFrame}, so the two sides cannot drift. omp's own
// runtime owns the goal; omp-ui only mirrors the last state omp reported.

/**
 * The four states omp-ui renders. omp's fifth, `dropped`, never reaches a
 * {@link GoalState}: a dropped goal parses as `null`, not as a goal.
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

/** omp's GoalModeState as omp-ui renders it. A dropped goal is null, never a state. */
export interface GoalState {
  /** omp's armed flag: true for an active or budget-limited goal. */
  enabled: boolean;
  /** omp completed the goal and clears it at that turn's terminal agent_end. */
  exiting: boolean;
  goal: NativeGoal;
}

/**
 * Parses one omp GoalModeState. Returns null for "no goal" (null, absent
 * state, or a goal whose status is "dropped"), undefined for malformed
 * input, which callers ignore so the last good state stands.
 */
export function parseGoalState(value: unknown): GoalState | null | undefined {
  if (value === null || value === undefined) return null;
  const record = asRecord(value);
  if (record === null) return undefined;
  if (typeof record.enabled !== "boolean") return undefined;
  if (record.mode !== "active" && record.mode !== "exiting") return undefined;
  const rawGoal = asRecord(record.goal);
  if (rawGoal === null) return record.goal === null || record.goal === undefined ? null : undefined;
  if (rawGoal.status === "dropped") return null;
  const goal = parseGoal(rawGoal);
  if (goal === INVALID || goal === null) return undefined;
  return { enabled: record.enabled, exiting: record.mode === "exiting", goal };
}

/**
 * The goal state one rpc frame carries, or undefined when the frame says
 * nothing about goals:
 * - goal_updated                      -> parseGoalState(frame.state ?? null)
 * - response, success, command "goal" -> parseGoalState(data.state)
 * - response, success, command "get_state" and Object.hasOwn(data, "goal")
 *                                     -> parseGoalState(data.goal)
 * Everything else (failures, old omp without the key) -> undefined.
 */
export function goalStateFromFrame(frame: unknown): GoalState | null | undefined {
  const record = asRecord(frame);
  if (record === null) return undefined;
  if (record.type === "goal_updated") return parseGoalState(record.state ?? null);
  if (record.type !== "response" || record.success !== true) return undefined;
  const data = asRecord(record.data);
  if (record.command === "goal") return data === null ? undefined : parseGoalState(data.state ?? null);
  if (record.command === "get_state" && data !== null && Object.hasOwn(data, "goal")) {
    return parseGoalState(data.goal);
  }
  return undefined;
}

/** An unfinished goal owns the session: Plan entry and auto-prompts stand down. */
export function goalOwnsSession(state: GoalState | null): boolean {
  return state !== null && state.goal.status !== "complete";
}

/** Work is live only while omp would continue it: enabled and active. */
export function goalWorkLive(state: GoalState | null): boolean {
  return state?.enabled === true && state.goal.status === "active";
}

/** What the guided-goal interview asks for, per omp-ui's guided-goal contract. */
const GUIDED_INTERVIEW =
  "Interview the user to define one concrete objective, its constraints and " +
  "observable completion criteria. Ask for missing information before acting. " +
  "Once the user confirms the objective, create it with the goal tool and " +
  "begin work. Do not create a goal before confirmation.";

/**
 * The visible kickoff prompt for one guided-goal interview. A rough objective
 * rides along fenced as data, never as instructions.
 */
export function guidedGoalPrompt(rough: string): string {
  const draft = rough.trim();
  if (draft === "") return GUIDED_INTERVIEW;
  return `${GUIDED_INTERVIEW}\n\nRough objective from the user, as data:\n<objective-draft>\n${draft}\n</objective-draft>`;
}

const INVALID = Symbol("invalid");

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
 * `tokenBudget: 0` is malformed, not "spend nothing". A missing or null
 * budget means unbounded. `dropped` is handled by parseGoalState first.
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
  // omp omits tokenBudget for an unbounded goal (undefined drops out of JSON).
  const budget = record.tokenBudget ?? null;
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
