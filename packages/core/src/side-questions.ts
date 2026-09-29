// The side-question (`/btw`) wire contract. Pure — zero runtime imports —
// because the renderer imports it directly via the @omp-ui/core/side-questions
// subpath, exactly like goal.ts and session-tree.ts. The generating half
// (which writes the extension file) lives in side-questions-extension.ts and
// consumes these same constants, so the two sides of the channel can never
// drift.
//
// omp's `/btw` is TUI-only: the built-in registry entry defines `handleTui`
// and no `handle`, the noninteractive dispatcher skips entries without
// `handle`, and `get_available_commands` omits it — so over rpc-ui a `/btw`
// line would fall through to `session.prompt()` and reach the model as literal
// prompt text (issue #682; the same hole ADR-0007 documents for `/plan`). The
// bridge drives `AgentSession.runEphemeralTurn` — the API omp's own
// BtwController uses — from inside the owned process and keeps omp's own
// `btw-history/` file grammar, so a topic started here is readable by omp's
// TUI history overlay too.

/** Hidden command family the renderer dispatches (`ask`, `cancel`, `refresh`). */
export const BTW_COMMAND = "omp-ui-btw";

/** `setStatus` key carrying the JSON side-question snapshot. Routed, never rendered raw. */
export const BTW_STATUS_KEY = "omp-ui:btw";

/** Cap on one question, checked before anything is sent (never silently truncated). */
export const BTW_QUESTION_CHAR_LIMIT = 32_000;

/**
 * Hard cap on the serialized snapshot (UTF-8 bytes). The publisher drops the
 * oldest topics to fit; the parser rejects anything over it, leaving the last
 * good snapshot standing.
 */
export const BTW_STATUS_BYTE_LIMIT = 512 * 1024;

/** Per-turn answer cap inside a snapshot; the history file always holds the full text. */
export const BTW_SNAPSHOT_ANSWER_CHAR_LIMIT = 64 * 1024;

/** Appended to an answer the snapshot had to cut. */
export const BTW_TRUNCATION_MARKER = "\n\n[… answer truncated in this view; the full text is in the session's btw-history]";

/** Refusal line while a side question is already running (one at a time, no queue). */
export const BTW_BUSY_REFUSAL = "A side question is still running — wait for it or cancel it.";

/** omp's own sentence for a session with no model yet. */
export const BTW_NO_MODEL_MESSAGE = "No active model available for /btw.";

/** The five turn states omp's history grammar allows. */
export type BtwTurnStatus =
  | "running"
  | "complete"
  | "cancelled"
  | "error"
  | "interrupted";

const TURN_STATUSES: readonly BtwTurnStatus[] = [
  "running",
  "complete",
  "cancelled",
  "error",
  "interrupted",
];

/** One question/answer exchange inside a topic. */
export interface BtwTurn {
  question: string;
  answer: string;
  status: BtwTurnStatus;
  updatedAt: number;
  error?: string;
}

/**
 * One topic: a root question and its follow-ups. `question` is the root
 * question (the topic's title); `answer`, `status`, `updatedAt` and `error`
 * describe the LATEST turn, so a row reads correctly without walking `turns`.
 */
export interface BtwTopic {
  id: string;
  question: string;
  answer: string;
  status: BtwTurnStatus;
  updatedAt: number;
  error?: string;
  /** Root turn first, then follow-ups. */
  turns: BtwTurn[];
}

/** What the bridge publishes on {@link BTW_STATUS_KEY}. */
export interface BtwSnapshot {
  available: boolean;
  /** Why the bridge cannot answer (older omp, missing API). */
  unavailableReason?: string;
  /** The last refusal, cleared by the next publish. */
  busy?: string;
  /** The running turn, or null. */
  active: { topicId: string; question: string; answer: string } | null;
  /** Newest `updatedAt` first. */
  topics: BtwTopic[];
  publishedAt: number;
}

/** One hidden-bridge request. */
export interface BtwRequest {
  requestId: string;
  question?: string;
  topicId?: string;
}

/** Hidden slash command carrying one side question (or a follow-up on `topicId`). */
export function btwAskMessage(request: {
  requestId: string;
  question: string;
  topicId?: string;
}): string {
  return `/${BTW_COMMAND} ask ${JSON.stringify(request)}`;
}

/** Hidden slash command cancelling the running side question. */
export function btwCancelMessage(request: { requestId: string }): string {
  return `/${BTW_COMMAND} cancel ${JSON.stringify(request)}`;
}

/** Hidden slash command republishing the snapshot after re-reading `btw-history/`. */
export function btwRefreshMessage(request: { requestId: string }): string {
  return `/${BTW_COMMAND} refresh ${JSON.stringify(request)}`;
}

/**
 * omp's own wrapper around a side question (`prompts/system/btw-user.md`,
 * read from the shipped 18.4.2 binary). Cosmetic — `runEphemeralTurn`
 * supplies the no-tools directive itself — but kept verbatim so a follow-up's
 * history reads the way omp's TUI would have written it.
 */
export const OMP_BTW_USER_TEMPLATE = `<btw>
Ephemeral side question for current interactive session.
Answer briefly, directly; use conversation context already provided.
NEVER use tools.
NEVER ask follow-up questions.
Question:
{{question}}
</btw>`;

/** The wrapped question exactly as the ephemeral turn's prompt text. */
export function btwPromptText(question: string): string {
  return OMP_BTW_USER_TEMPLATE.replace("{{question}}", () => question);
}

// ---------------------------------------------------------- history file grammar

/** Epoch-ms bound omp's history schema enforces. */
const MAX_TIMESTAMP = 8_640_000_000_000_000;

const ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

/** One turn as a history file stores it (root turn and follow-ups share the shape). */
export interface BtwRecordTurn {
  question: string;
  answer: string;
  status: BtwTurnStatus;
  createdAt: number;
  updatedAt: number;
  error?: string;
}

/** One `entry-<id>.json` file: the root turn plus its follow-ups. */
export interface BtwRecord extends BtwRecordTurn {
  id: string;
  leafId: string | null;
  followUps?: BtwRecordTurn[];
}

export const btwEntryFileName = (id: string): string => `entry-${id}.json`;

const TURN_KEYS: Record<string, true> = {
  question: true,
  answer: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  error: true,
};
const RECORD_KEYS: Record<string, true> = {
  ...TURN_KEYS,
  id: true,
  leafId: true,
  followUps: true,
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= MAX_TIMESTAMP
  );
}

function readTurn(
  raw: Record<string, unknown>,
  allowedKeys: Record<string, true>,
): BtwRecordTurn | null {
  for (const key of Object.keys(raw)) if (allowedKeys[key] !== true) return null;
  const { question, answer, status, createdAt, updatedAt, error } = raw;
  if (typeof question !== "string" || typeof answer !== "string") return null;
  if (!TURN_STATUSES.includes(status as BtwTurnStatus)) return null;
  if (!isTimestamp(createdAt) || !isTimestamp(updatedAt)) return null;
  if (error !== undefined && typeof error !== "string") return null;
  return {
    question,
    answer,
    status: status as BtwTurnStatus,
    createdAt,
    updatedAt,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Strict parse of one history file, mirroring omp's `BtwHistoryStore` schema:
 * unknown keys rejected (also inside follow-ups, which cannot nest), the id
 * grammar enforced, statuses and timestamps range-checked. Returns null for
 * anything else. The `running` → `interrupted` normalisation omp applies when a
 * store opens is the loader's job, not the parser's. Whether the id matches
 * the filename is the caller's check ({@link btwEntryFileName}).
 */
export function parseBtwRecord(json: string): BtwRecord | null {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (record === null) return null;
  const { id, leafId, followUps } = record;
  if (typeof id !== "string" || id.length === 0 || !ID_PATTERN.test(id))
    return null;
  if (leafId !== null && typeof leafId !== "string") return null;
  const root = readTurn(record, RECORD_KEYS);
  if (root === null) return null;
  let turns: BtwRecordTurn[] | undefined;
  if (followUps !== undefined) {
    if (!Array.isArray(followUps)) return null;
    turns = [];
    for (const value of followUps) {
      const turnRecord = asRecord(value);
      if (turnRecord === null) return null;
      const turn = readTurn(turnRecord, TURN_KEYS);
      if (turn === null) return null;
      turns.push(turn);
    }
  }
  return {
    ...root,
    id,
    leafId: leafId as string | null,
    ...(turns !== undefined ? { followUps: turns } : {}),
  };
}

// ---------------------------------------------------------- snapshot parsing

/**
 * Parses the JSON published on {@link BTW_STATUS_KEY}. Total: malformed or
 * over-budget input returns null, and the caller keeps the last good snapshot —
 * nothing is ever half-applied.
 */
export function parseBtwSnapshot(text: string | undefined): BtwSnapshot | null {
  if (text === undefined || utf8Length(text) > BTW_STATUS_BYTE_LIMIT)
    return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const record = asRecord(raw);
  if (record === null) return null;
  if (typeof record.available !== "boolean") return null;
  if (
    record.unavailableReason !== undefined &&
    typeof record.unavailableReason !== "string"
  )
    return null;
  if (record.busy !== undefined && typeof record.busy !== "string") return null;
  if (
    typeof record.publishedAt !== "number" ||
    !Number.isFinite(record.publishedAt)
  )
    return null;
  let active: BtwSnapshot["active"] = null;
  if (record.active !== null) {
    const value = asRecord(record.active);
    if (
      value === null ||
      typeof value.topicId !== "string" ||
      typeof value.question !== "string" ||
      typeof value.answer !== "string"
    )
      return null;
    active = {
      topicId: value.topicId,
      question: value.question,
      answer: value.answer,
    };
  }
  if (!Array.isArray(record.topics)) return null;
  const topics: BtwTopic[] = [];
  for (const value of record.topics) {
    const topic = readTopic(value);
    if (topic === null) return null;
    topics.push(topic);
  }
  return {
    available: record.available,
    ...(record.unavailableReason !== undefined
      ? { unavailableReason: record.unavailableReason as string }
      : {}),
    ...(record.busy !== undefined ? { busy: record.busy as string } : {}),
    active,
    topics,
    publishedAt: record.publishedAt,
  };
}

function readSnapshotTurn(value: unknown): BtwTurn | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.question !== "string" || typeof record.answer !== "string")
    return null;
  if (!TURN_STATUSES.includes(record.status as BtwTurnStatus)) return null;
  if (typeof record.updatedAt !== "number" || !Number.isFinite(record.updatedAt))
    return null;
  if (record.error !== undefined && typeof record.error !== "string")
    return null;
  return {
    question: record.question,
    answer: record.answer,
    status: record.status as BtwTurnStatus,
    updatedAt: record.updatedAt,
    ...(record.error !== undefined ? { error: record.error as string } : {}),
  };
}

function readTopic(value: unknown): BtwTopic | null {
  const record = asRecord(value);
  if (record === null) return null;
  if (typeof record.id !== "string" || record.id.length === 0) return null;
  const head = readSnapshotTurn(record);
  if (head === null || !Array.isArray(record.turns)) return null;
  const turns: BtwTurn[] = [];
  for (const raw of record.turns) {
    const turn = readSnapshotTurn(raw);
    if (turn === null) return null;
    turns.push(turn);
  }
  return { ...head, id: record.id, turns };
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
