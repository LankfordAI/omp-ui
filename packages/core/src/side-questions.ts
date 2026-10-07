// The side-question (`/btw`) wire contract. Pure — zero runtime imports —
// because the renderer imports it directly via the @omp-ui/core/side-questions
// subpath, exactly like goal.ts and session-tree.ts. The channel is omp's own
// native rpc-ui commands — `btw`, `btw_cancel`, `get_btw_history` (omp ≥ 18.6.3,
// upstream #14110; issue #775) — and the `btw_delta` / `btw_record` frames they
// stream. omp owns `btw-history/` as reader and writer, so the snapshot below
// is built from those frames and records here, never parsed from a publish.
// omp's `/btw` slash entry is still `handleTui`-only, which is why the
// composer intercepts the line and dispatches the command itself.
//
// omp's history records ride the frames as objects, so the strict grammar
// below stays as the validation gate every record passes before it can touch a
// snapshot. The `running` → `interrupted` normalisation omp applies when a
// store opens remains omp's loader's job, not this file's.

/** Cap on one question, checked before anything is sent (never silently truncated). */
export const BTW_QUESTION_CHAR_LIMIT = 32_000;

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

/** What the pane renders, built by the reducers below from omp's frames. */
export interface BtwSnapshot {
  available: boolean;
  /** Why this omp cannot answer side questions (retained from an earlier snapshot). */
  unavailableReason?: string;
  /** The last refusal, cleared by the next snapshot-producing publish. */
  busy?: string;
  /** The running turn, or null. */
  active: { topicId: string; question: string; answer: string } | null;
  /** Newest `updatedAt` first. */
  topics: BtwTopic[];
  publishedAt: number;
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
 * Strict parse of one history record, mirroring omp's `BtwHistoryStore` schema:
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

// ---------------------------------------------------------- snapshot reducers

/** One history record → one topic: root question as title, latest turn's verdict. */
export function btwTopicFromRecord(record: BtwRecord): BtwTopic {
  // The view turn drops the record's `createdAt`; the root plus follow-ups map
  // through the same projection so `turns` stays BtwTurn-clean.
  const turns: BtwTurn[] = [record, ...(record.followUps ?? [])].map(
    ({ question, answer, status, updatedAt, error }) => ({
      question,
      answer,
      status,
      updatedAt,
      ...(error !== undefined ? { error } : {}),
    }),
  );
  const latest = turns[turns.length - 1] as BtwTurn;
  return {
    id: record.id,
    question: record.question,
    answer: latest.answer,
    status: latest.status,
    updatedAt: latest.updatedAt,
    ...(latest.error !== undefined ? { error: latest.error } : {}),
    turns,
  };
}

function deriveActive(topics: readonly BtwTopic[]): BtwSnapshot["active"] {
  for (const topic of topics) {
    const latest = topic.turns[topic.turns.length - 1];
    if (latest !== undefined && latest.status === "running")
      return {
        topicId: topic.id,
        question: latest.question,
        answer: latest.answer,
      };
  }
  return null;
}

const byNewestUpdate = (a: BtwTopic, b: BtwTopic): number =>
  b.updatedAt - a.updatedAt;

/**
 * The full snapshot from `get_btw_history`'s records (the in-memory running
 * record is already merged in by omp). Total: each entry round-trips through
 * {@link parseBtwRecord} and malformed entries drop; nothing is half-applied.
 */
export function btwSnapshotFromRecords(
  records: readonly unknown[],
  publishedAt: number,
): BtwSnapshot {
  const topics: BtwTopic[] = [];
  for (const value of records) {
    const record = parseBtwRecord(JSON.stringify(value));
    if (record !== null) topics.push(btwTopicFromRecord(record));
  }
  topics.sort(byNewestUpdate);
  return {
    available: true,
    active: deriveActive(topics),
    topics,
    publishedAt,
  };
}

/** One `btw_record` frame (or a `btw` response): replace-or-insert by id. */
export function applyBtwRecord(
  snapshot: BtwSnapshot | null,
  record: BtwRecord,
): BtwSnapshot {
  const topic = btwTopicFromRecord(record);
  const topics = (snapshot?.topics ?? []).filter((t) => t.id !== topic.id);
  topics.push(topic);
  topics.sort(byNewestUpdate);
  // Every snapshot-producing publish clears the last refusal line.
  return {
    available: true,
    active: deriveActive(topics),
    topics,
    publishedAt: Date.now(),
  };
}

/**
 * One `btw_delta` frame: append to the running topic's latest answer. A delta
 * for an unknown id (the pane opened mid-run) or a topic that is not running
 * changes nothing — the next `btw_record` or refresh is the truth.
 */
export function applyBtwDelta(
  snapshot: BtwSnapshot | null,
  recordId: string,
  delta: string,
): BtwSnapshot | null {
  if (snapshot === null) return null;
  let touched = false;
  const topics = snapshot.topics.map((topic) => {
    if (topic.id !== recordId) return topic;
    const latest = topic.turns[topic.turns.length - 1];
    if (latest === undefined || latest.status !== "running") return topic;
    touched = true;
    const answer = latest.answer + delta;
    return {
      ...topic,
      answer,
      turns: [...topic.turns.slice(0, -1), { ...latest, answer }],
    };
  });
  // The running card reads `active`, so the streamed answer must land there
  // too; re-deriving keeps it equal to the running topic's latest turn.
  return touched ? { ...snapshot, topics, active: deriveActive(topics) } : snapshot;
}
