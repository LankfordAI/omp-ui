// The live voice (`live_*`) wire contract. Pure — zero runtime imports —
// because the renderer imports it directly via the @omp-ui/core/live-voice
// subpath, exactly like side-questions.ts. omp ≥ 18.5.1 runs the realtime
// session and records audio itself; omp-ui only sends three commands
// (`live_start`, `live_stop`, `live_mute`) and renders four frame types
// (`live_phase`, `live_levels`, `live_transcript`, `live_end`). omp owns the
// phase machine — this file only renders what the frames say; it never drives
// transitions.
//
// Live state is a snapshot slice, not transcript rows: a `live_transcript`
// frame REPLACES earlier frames with the same (role, turn), which is snapshot
// semantics — interleaving into the main transcript would double-render any
// turn omp also emits as ordinary message frames, and the reducer's
// unknown-type path would drop the frames anyway.

/** omp's full phase enum (18.7.0 binary strings; issue #778). */
export type LivePhase =
  | "connecting"
  | "listening"
  | "working"
  | "speaking"
  | "muted"
  | "error";

export type LiveRole = "user" | "assistant";

/** One recording's identity: session AND connection are both load-bearing (#809). */
export interface LiveAudioRef {
  /** The owned session's UUID — from the capability frame / OwnedSessionRecord. */
  sessionId: string;
  /** A fresh UUID the renderer mints on each successful `live_start`. */
  connectionId: string;
  role: LiveRole;
  /** omp's per-connection integer. Reused across connections is fine: the
   * connection segment keeps the refs (and files) from ever colliding. */
  turn: number;
}

/**
 * One recording on disk as the confined lister reports it. Keys are the ref
 * minus the session (the lister is already scoped to one lineage dir), plus
 * the file's size and mtime.
 */
export interface LiveAudioEntry {
  connectionId: string;
  role: LiveRole;
  turn: number;
  sizeBytes: number;
  /** ISO timestamp of the file's last write. */
  modifiedAt: string;
}

/**
 * One load attempt. `ready` carries the bytes; `unavailable` means no file
 * answers the reference — including "omp exposed no audio at all", which is
 * every reference with omp ≤ 18.8.6 (ADR-0049); `incomplete` means only a
 * `.partial` sibling exists — a writer left a half recording. A load never
 * substitutes anything.
 */
export interface LiveAudioLoad {
  status: "ready" | "unavailable" | "incomplete";
  /** Only with status "ready". */
  wavBase64?: string;
  sizeBytes?: number;
}

/** One realtime turn: a frame replaces earlier frames with the same (role, turn). */
export interface LiveTurn {
  role: LiveRole;
  turn: number;
  text: string;
  final: boolean;
}

/** What the composer renders, built by the appliers below from omp's frames. */
export interface LiveSnapshot {
  phase: LivePhase | null; // null only before the first live_phase frame
  /** Latest RMS levels, both clamped to [0, 1]; null until the first frame. */
  levels: { input: number; output: number } | null;
  /** One entry per (role, turn), latest text wins. */
  turns: LiveTurn[];
  /** Set by live_end. */
  ended: boolean;
  /** live_end's error text, or a live_start/live_stop/live_mute failure line. */
  error: string | null;
  /**
   * The connection these turns belong to (#809): minted by the renderer on
   * each successful `live_start` and kept until the next start replaces it,
   * so history keys on it even after `ended`. Null before any local start.
   * `applyLivePhase` deliberately leaves it alone — omp owns the phase
   * machine; the start/stop actions own this field's lifecycle.
   */
  connectionId: string | null;
}

/**
 * The custom message type omp's live controller hands a spoken request to the
 * agent with: `sendCustomMessage({ customType: "live-delegation", content,
 * display: true, attribution: "agent" }, { triggerTurn: true })` (omp 18.8.5
 * `live/controller.ts`, exported there as LIVE_DELEGATION_MESSAGE_TYPE). It is
 * not a user prompt, so no send path arms Auto-title for it (issue #803).
 */
export const LIVE_DELEGATION_CUSTOM_TYPE = "live-delegation";

const LIVE_PHASES: readonly LivePhase[] = [
  "connecting",
  "listening",
  "working",
  "speaking",
  "muted",
  "error",
];

const LIVE_ROLES: readonly LiveRole[] = ["user", "assistant"];

const isLivePhase = (value: unknown): value is LivePhase =>
  typeof value === "string" && (LIVE_PHASES as readonly string[]).includes(value);

const isLiveRole = (value: unknown): value is LiveRole =>
  typeof value === "string" && (LIVE_ROLES as readonly string[]).includes(value);

const clampLevel = (value: number): number => Math.min(1, Math.max(0, value));

function frameField(frame: unknown, key: string): unknown {
  if (typeof frame !== "object" || frame === null) return undefined;
  return (frame as Record<string, unknown>)[key];
}

export function emptyLiveSnapshot(): LiveSnapshot {
  return { phase: null, levels: null, turns: [], ended: false, error: null, connectionId: null };
}

/** Tolerant: an unknown value (a newer omp's new phase) keeps the previous phase. */
export function parseLivePhaseFrame(frame: unknown): LivePhase | null {
  return isLivePhase(frameField(frame, "phase"))
    ? (frameField(frame, "phase") as LivePhase)
    : null;
}

/** Tolerant: both levels present and finite, or the frame drops. */
export function parseLiveLevelsFrame(
  frame: unknown,
): { input: number; output: number } | null {
  const input = frameField(frame, "input");
  const output = frameField(frame, "output");
  if (typeof input !== "number" || !Number.isFinite(input)) return null;
  if (typeof output !== "number" || !Number.isFinite(output)) return null;
  return { input, output };
}

/** Tolerant: role/turn/text required, `final` defaults false when absent. */
export function parseLiveTranscriptFrame(frame: unknown): LiveTurn | null {
  const role = frameField(frame, "role");
  const turn = frameField(frame, "turn");
  const text = frameField(frame, "text");
  if (!isLiveRole(role)) return null;
  if (typeof turn !== "number" || !Number.isInteger(turn)) return null;
  if (typeof text !== "string") return null;
  return { role, turn, text, final: frameField(frame, "final") === true };
}

/**
 * Sets the phase. A `connecting` after a live_end (or after a local failure
 * line) is a new session: the stale verdict clears. An unrecognized phase
 * never reaches here — the parser kept the previous one instead.
 */
export function applyLivePhase(snap: LiveSnapshot, phase: LivePhase): LiveSnapshot {
  return {
    ...snap,
    phase,
    ...(phase === "connecting" ? { ended: false, error: null } : {}),
  };
}

/** Replaces both levels, clamped — omp reports RMS in [0, 1], at most every 100 ms. */
export function applyLiveLevels(
  snap: LiveSnapshot,
  input: number,
  output: number,
): LiveSnapshot {
  return { ...snap, levels: { input: clampLevel(input), output: clampLevel(output) } };
}

/** Replace-or-append by (role, turn): the latest text wins. */
export function applyLiveTranscript(snap: LiveSnapshot, turn: LiveTurn): LiveSnapshot {
  const index = snap.turns.findIndex(
    (t) => t.role === turn.role && t.turn === turn.turn,
  );
  const turns =
    index === -1
      ? [...snap.turns, turn]
      : snap.turns.map((t, i) => (i === index ? turn : t));
  return { ...snap, turns };
}

/**
 * The session's end. `error` only lands when the frame carries one; a clean
 * end keeps any earlier error line standing. Phase and turns stay so the
 * strip can show the last exchange until dismissal.
 */
export function applyLiveEnd(snap: LiveSnapshot, error: string | null): LiveSnapshot {
  return {
    ...snap,
    ended: true,
    ...(error !== null && error !== "" ? { error } : {}),
  };
}

/**
 * True while a live snapshot names a session that could still be talked to or
 * muted: frames booted, not ended, no error verdict, phase reported. The #801
 * visibility guard's mutability test and the plan-handoff carry-over are the
 * same question — one session's running realtime connection — so one
 * predicate serves both.
 */
export function isLiveSessionActive(snap: LiveSnapshot | null | undefined): boolean {
  return (
    snap !== null &&
    snap !== undefined &&
    !snap.ended &&
    snap.phase !== null &&
    snap.phase !== "error"
  );
}

/**
 * Voice recording reference (#809): `v1/<sessionId>/<connectionId>/<role>/<turn>`.
 * Both the session AND the connection ride in the key, so a numeric turn
 * reused by a later connection can never attach a recording to the wrong
 * message. Storage mirrors the shape:
 * `<lineageDir>/live-audio/<connectionId>/<role>-<turn>.wav`.
 */
export function formatLiveAudioRef(ref: LiveAudioRef): string {
  return `v1/${ref.sessionId}/${ref.connectionId}/${ref.role}/${ref.turn}`;
}

const UUID_SEGMENT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Strict parse: the v1 prefix, two UUID segments (session UUIDv7, connection
 * UUIDv4 — both validated by shape, not version nibble), the role enum, and
 * a non-negative integer turn. Anything else is null; a stored or crafted
 * string never reaches the filesystem unvalidated.
 */
export function parseLiveAudioRef(ref: string): LiveAudioRef | null {
  const parts = ref.split("/");
  if (parts.length !== 5 || parts[0] !== "v1") return null;
  const [, sessionId, connectionId, role, turnRaw] = parts;
  if (!UUID_SEGMENT.test(sessionId) || !UUID_SEGMENT.test(connectionId)) return null;
  if (!isLiveRole(role)) return null;
  if (!/^\d+$/.test(turnRaw)) return null;
  const turn = Number(turnRaw);
  if (!Number.isSafeInteger(turn)) return null;
  return { sessionId, connectionId, role, turn };
}
