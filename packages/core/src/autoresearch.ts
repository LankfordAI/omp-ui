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

/** The bridge-registered tool the interview ends in; omp-ui intercepts its select (issue #567). */
export const AUTORESEARCH_PROPOSE_TOOL = "propose_experiment";
/** Prefix on the tool's `select` title; the JSON after it is an {@link ExperimentProposal}. */
export const EXPERIMENT_PROPOSAL_SENTINEL = "omp-ui:experiment-proposal:";
/** The select's two options. The renderer answers `launched:<json>` or `revise`. */
export const EXPERIMENT_PROPOSAL_OPTIONS = ["launch", "revise"] as const;
/** Prefix of the renderer's launch answer; the JSON after it is the spec as launched. */
export const EXPERIMENT_PROPOSAL_LAUNCHED_PREFIX = "launched:";
export const EXPERIMENT_PROPOSAL_REVISE = "revise";
/** What omp's `METRIC name=value` line accepts as a name. */
export const AUTORESEARCH_METRIC_NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** Hard cap on the sentinel title (UTF-8 bytes); the tool refuses a larger proposal. */
export const EXPERIMENT_PROPOSAL_BYTE_LIMIT = 16 * 1024;
export const EXPERIMENT_BRIEF_CHAR_LIMIT = 4000;
export const EXPERIMENT_LIST_LIMIT = 32;
export const EXPERIMENT_LIST_ENTRY_CHAR_LIMIT = 512;

/** The spec the model proposes; the New experiment dialog's fields minus model and worktree. */
export interface ExperimentProposal {
  goal: string;
  metric: string;
  unit: string;
  direction: "lower" | "higher";
  /** null = the loop writes ./autoresearch.sh itself. */
  command: string | null;
  scopePaths: string[];
  offLimits: string[];
  constraints: string[];
  maxIterations: number | null;
  /** What the proposing agent learned about the harness; appended to the kickoff. */
  brief: string | null;
}

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
  /** Why propose_experiment could not be mounted; null when it is (or the bridge predates it). */
  proposeUnavailable: string | null;
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
    proposeUnavailable: typeof record.proposeUnavailable === "string" ? record.proposeUnavailable : null,
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

/**
 * Total: null for anything that is not a well-formed proposal — wrong types,
 * a metric the METRIC line would reject, an unknown direction, an entry over
 * its cap. Shared by the extension's answer parser (interpolated) and the
 * renderer's frame router, so neither side can accept what the other rejects.
 */
export function parseExperimentProposal(value: unknown): ExperimentProposal | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.goal !== "string") return null;
  const goal = record.goal.trim();
  if (goal === "" || goal.length > AUTORESEARCH_GOAL_CHAR_LIMIT) return null;
  if (typeof record.metric !== "string" || !AUTORESEARCH_METRIC_NAME_RE.test(record.metric)) return null;
  if (typeof record.unit !== "string") return null;
  if (record.direction !== "lower" && record.direction !== "higher") return null;
  if (record.command !== null && !(typeof record.command === "string" && record.command !== "")) return null;
  const scopePaths = parseStringList(record.scopePaths);
  const offLimits = parseStringList(record.offLimits);
  const constraints = parseStringList(record.constraints);
  if (scopePaths === INVALID || offLimits === INVALID || constraints === INVALID) return null;
  const maxIterations = record.maxIterations;
  if (
    maxIterations !== null &&
    !(typeof maxIterations === "number" && Number.isInteger(maxIterations) && maxIterations > 0)
  ) {
    return null;
  }
  const brief = record.brief;
  if (brief !== null && !(typeof brief === "string" && brief.length <= EXPERIMENT_BRIEF_CHAR_LIMIT)) return null;
  return {
    goal,
    metric: record.metric,
    unit: record.unit,
    direction: record.direction,
    command: record.command as string | null,
    scopePaths,
    offLimits,
    constraints,
    maxIterations: maxIterations as number | null,
    brief: brief as string | null,
  };
}

/** Reads a proposal off an `extension_ui_request` title, or null when the title is not one. */
export function parseExperimentProposalTitle(title: string | undefined): ExperimentProposal | null {
  if (title === undefined || !title.startsWith(EXPERIMENT_PROPOSAL_SENTINEL)) return null;
  const parsed = safeParse(title.slice(EXPERIMENT_PROPOSAL_SENTINEL.length));
  if (parsed === null) return null;
  return parseExperimentProposal(parsed);
}

/** The renderer's launch answer: prefix + JSON of the branch and the spec as launched. */
export function experimentLaunchedValue(
  launched: ExperimentProposal & { branch: string | null },
): string {
  return EXPERIMENT_PROPOSAL_LAUNCHED_PREFIX + JSON.stringify(launched);
}

function parseStringList(value: unknown): string[] | typeof INVALID {
  if (!Array.isArray(value) || value.length > EXPERIMENT_LIST_LIMIT) return INVALID;
  const out: string[] = [];
  for (const raw of value) {
    if (typeof raw !== "string" || raw === "" || raw.length > EXPERIMENT_LIST_ENTRY_CHAR_LIMIT) return INVALID;
    out.push(raw);
  }
  return out;
}
