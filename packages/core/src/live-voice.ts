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
}

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
  return { phase: null, levels: null, turns: [], ended: false, error: null };
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
