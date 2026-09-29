// The vibe-command wire contract. Pure — zero runtime imports — because the
// renderer imports it directly via the @omp-ui/core/vibe subpath, exactly like
// goal.ts and plan.ts. The generating half (which writes the extension file)
// lives in vibe-extension.ts and consumes these same constants, so the two
// sides of the channel can never drift.
//
// omp's vibe family is rpc-reachable only through its tools: over rpc-ui no
// `/vibe` slash command exists, and the `vibe_*` tools mount solely when vibe
// mode is active. The bridge in vibe-extension.ts drives omp's own vibe
// runtime through those tools' `execute` implementations — omp-ui never
// re-implements worker semantics — and publishes the roster it reads back.

/**
 * `setStatus` key carrying the JSON vibe snapshot. Routed, never rendered raw.
 */
export const VIBE_STATUS_KEY = "omp-ui:vibe";

/** Hidden slash command the spawner arms with, and the renderer dispatches on. */
export const VIBE_COMMAND = "omp-ui-vibe";

/** Arg prefix separating the hidden arm from one correlated vibe command. */
export const VIBE_COMMAND_ARG_PREFIX = "command ";

/**
 * Cap on the serialized JSON a command's args may carry (worker prompts,
 * send messages). Checked before anything is sent, so an oversized command is
 * refused rather than silently truncated on the way into omp's runtime.
 */
export const VIBE_ARGS_BYTE_LIMIT = 64 * 1024;

/**
 * Hard cap on the serialized snapshot (UTF-8 bytes). The publisher replaces an
 * impossible payload with an `unavailable` snapshot instead of emitting half a
 * roster, and the parser rejects anything over it.
 */
export const VIBE_STATUS_BYTE_LIMIT = 256 * 1024;

/** Poll interval while vibe mode is on and workers may be moving. */
export const VIBE_POLL_MS = 1_500;

/** Custom-entry type omp's own vibe runtime writes worker lifecycle to. */
export const VIBE_LIFECYCLE_CUSTOM_TYPE = "vibe-session-lifecycle";

/** The five worker-control tools omp mounts while vibe mode is on. */
export const VIBE_TOOL_NAMES = ["vibe_spawn", "vibe_send", "vibe_wait", "vibe_kill", "vibe_list"] as const;
/**
 * Registry key holding the one root-local mode-transition chain shared by the
 * plan, goal, and vibe bridges, so two mode activations cannot both win.
 * `Symbol.for` makes it one chain per process across independently generated
 * extension modules; the value is goal.ts's key verbatim.
 */
export const VIBE_MODE_TRANSITION_KEY = "omp-ui:mode-transition";

/** Worker flavor omp's vibe_spawn accepts. */
export type VibeCli = "fast" | "good";

/**
 * The five states omp-ui renders. `starting`/`running`/`idle`/`dead` mirror
 * omp's screen-row states; `parked` is omp-ui's restore-side state for a
 * worker whose transcript survived into a later process but whose runtime
 * scope died with the old one — such a worker is read-only.
 */
export type VibeWorkerState = "starting" | "running" | "idle" | "parked" | "dead";

/** One vibe worker, read back from omp's own runtime. Never a second copy. */
export interface VibeWorker {
  /** omp's friendly worker name (e.g. "LivelyMarlin"); unique per scope. */
  id: string;
  cli: VibeCli;
  state: VibeWorkerState;
  /** omp's explicit-kill flag; a killed worker is a tombstone row. */
  killed: boolean;
  /** Resolved model id when omp has one; null while starting or parked. */
  model: string | null;
  /** Settled turns so far. */
  turns: number;
  /** Follow-up turns queued behind the in-flight one. */
  queued: number;
  /** First line of the in-flight turn's kickoff message, truncated by omp. */
  turnMessage: string | null;
  /** Tool executing right now; null when none is. */
  currentTool: string | null;
  /** Latest one-line intent omp distilled; null until there is one. */
  lastIntent: string | null;
  /** Spawn wall-clock time (epoch ms). */
  createdAt: number;
}

/** What the root bridge publishes on {@link VIBE_STATUS_KEY}. */
export interface VibeSnapshot {
  version: 1;
  /** Identifies this generated bridge instance; a restart mints a new one. */
  processKey: string;
  sessionId: string;
  /** Increases with every publish from this process; stale ones are dropped. */
  revision: number;
  /** False only when the bridge cannot drive vibe at all. */
  available: boolean;
  /** Why the bridge is unavailable; null exactly when `available` is true. */
  unavailable: string | null;
  /** omp's vibe-mode armed flag; mirrors `VibeModeState.enabled`. */
  enabled: boolean;
  /** The roster in scope order (oldest first); empty when mode is off. */
  workers: VibeWorker[];
  /** The latest command result, correlated by the client's requestId. */
  result: {
    requestId: string;
    ok: boolean;
    text: string;
  } | null;
}

/** The subcommands the renderer may dispatch. */
export const VIBE_COMMANDS = ["toggle", "off", "spawn", "send", "wait", "kill", "list"] as const;
export type VibeSubcommand = (typeof VIBE_COMMANDS)[number];

/** One dispatched vibe command, sent inside {@link vibeMessage}. */
export interface VibeCommandRequest {
  /** Correlation id minted by the client that owns the command row. */
  requestId: string;
  sessionId: string;
  processKey: string;
  command: VibeSubcommand;
  /** Everything after the subcommand name, verbatim (may be empty). */
  args: string;
}

/** Hidden slash command that arms the bridge and binds its UI context. */
export function vibeArmMessage(): string {
  return `/${VIBE_COMMAND}`;
}

/** Hidden slash command carrying one correlated vibe command. */
export function vibeMessage(request: VibeCommandRequest): string {
  return `/${VIBE_COMMAND} ${VIBE_COMMAND_ARG_PREFIX}${JSON.stringify(request)}`;
}

/** True when a roster holds at least one worker a turn could still follow. */
export function vibeWorkLive(snapshot: VibeSnapshot): boolean {
  return snapshot.workers.some(
    (worker) => worker.state === "starting" || worker.state === "running" || worker.queued > 0,
  );
}

/**
 * Parses the JSON published on {@link VIBE_STATUS_KEY}, from either a decoded
 * object or a JSON string, and is total: anything malformed returns null and
 * is never mistaken for "no vibe". Unknown fields are dropped rather than
 * trusted. `available` and `unavailable` must agree, and a worker is
 * self-consistent (only an explicit kill is dead by flag, parked workers are
 * never live), so a half-written snapshot can never render as running work.
 */
export function parseVibeSnapshot(value: unknown): VibeSnapshot | null {
  const record = asRecord(typeof value === "string" ? safeParse(value) : value);
  if (record === null) return null;
  if (utf8Length(JSON.stringify(record)) > VIBE_STATUS_BYTE_LIMIT) return null;
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
  if (typeof record.enabled !== "boolean") return null;
  if (!Array.isArray(record.workers)) return null;
  const workers: VibeWorker[] = [];
  for (const entry of record.workers) {
    const worker = parseWorker(entry);
    if (worker === INVALID) return null;
    workers.push(worker);
  }
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
    workers,
    result,
  };
}

/**
 * Strictly parses one command request out of hidden-command args. Malformed or
 * over-budget payloads return null — never a half-applied command. Unknown
 * fields are rejected so a future schema cannot be silently partially read.
 */
export function parseVibeCommandRequest(args: string): VibeCommandRequest | null {
  const trimmed = args.trim();
  if (trimmed === "") return null;
  const spaceAt = trimmed.search(/\s/);
  const prefix = spaceAt === -1 ? trimmed : trimmed.slice(0, spaceAt);
  if (prefix !== "command") return null;
  const json = spaceAt === -1 ? "" : trimmed.slice(spaceAt + 1);
  if (utf8Length(json) > VIBE_ARGS_BYTE_LIMIT) return null;
  const record = asRecord(safeParse(json));
  if (record === null) return null;
  const keys = Object.keys(record).sort();
  const expected = ["args", "command", "processKey", "requestId", "sessionId"];
  if (keys.length !== expected.length || keys.some((key, i) => key !== expected[i])) return null;
  const requestId = nonEmptyString(record.requestId);
  const processKey = nonEmptyString(record.processKey);
  const sessionId = nonEmptyString(record.sessionId);
  if (requestId === null || processKey === null || sessionId === null) return null;
  if (typeof record.command !== "string" || !(VIBE_COMMANDS as readonly string[]).includes(record.command)) {
    return null;
  }
  if (typeof record.args !== "string") return null;
  return {
    requestId,
    processKey,
    sessionId,
    command: record.command as VibeSubcommand,
    args: record.args,
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

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function finiteNonNegative(value: unknown): number | typeof INVALID {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return INVALID;
  return value;
}

function nullableString(value: unknown): string | null | typeof INVALID {
  if (value === null || value === undefined || value === "") return null;
  return typeof value === "string" ? value : INVALID;
}

/**
 * A worker is complete and self-consistent or the whole snapshot is invalid:
 * omp's id charset, one of the two clis, one of the five states, non-negative
 * integer counters, and a kill flag that never contradicts the state (only an
 * explicit kill is dead by flag; a parked worker is never live).
 */
function parseWorker(value: unknown): VibeWorker | typeof INVALID {
  const record = asRecord(value);
  if (record === null) return INVALID;
  const id = nonEmptyString(record.id);
  if (id === null || !/^[A-Za-z0-9_-]+$/.test(id)) return INVALID;
  if (record.cli !== "fast" && record.cli !== "good") return INVALID;
  const state = record.state;
  if (
    state !== "starting" &&
    state !== "running" &&
    state !== "idle" &&
    state !== "parked" &&
    state !== "dead"
  ) {
    return INVALID;
  }
  if (typeof record.killed !== "boolean") return INVALID;
  if (record.killed && state !== "dead") return INVALID;
  const model = nullableString(record.model);
  const turnMessage = nullableString(record.turnMessage);
  const currentTool = nullableString(record.currentTool);
  const lastIntent = nullableString(record.lastIntent);
  if (model === INVALID || turnMessage === INVALID || currentTool === INVALID || lastIntent === INVALID) {
    return INVALID;
  }
  const turns = finiteNonNegative(record.turns);
  const queued = finiteNonNegative(record.queued);
  const createdAt = finiteNonNegative(record.createdAt);
  if (
    turns === INVALID ||
    queued === INVALID ||
    createdAt === INVALID ||
    !Number.isInteger(turns) ||
    !Number.isInteger(queued)
  ) {
    return INVALID;
  }
  if (state === "parked" && queued > 0) return INVALID;
  return {
    id,
    cli: record.cli,
    state,
    killed: record.killed,
    model,
    turns,
    queued,
    turnMessage,
    currentTool,
    lastIntent,
    createdAt,
  };
}

function parseResult(
  value: unknown,
): VibeSnapshot["result"] | null | typeof INVALID {
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
