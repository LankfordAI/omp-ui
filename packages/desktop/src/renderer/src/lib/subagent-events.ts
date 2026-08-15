/**
 * Tolerant reduction of `subagent_*` rpc frames into per-agent render items
 * (issue #63): the subagent view renders one buffer per agent. Same
 * contract as the transcript reducer — unknown or empty shapes add NOTHING,
 * so new upstream shapes never break the pane.
 */
import { field, strField } from "./fields";
import { markerItem, reduceEvent, type RenderItem } from "./transcript";

/**
 * Hard cap per retained background buffer. A settled agent's buffer is
 * retained for the subagent view until the session resets, so unbounded
 * growth is not an option — the viewed agent is exempt (its on-screen
 * transcript must be complete).
 */
export const SUBAGENT_BUFFER_CAP = 500;

/**
 * The identity of one subagent across all three frame types, id first: the
 * display name flips between lifecycle and progress frames for a single
 * agent (part of the issue #62 flood), so names can never key the maps.
 */
export function subagentKey(frame: unknown): string {
  const payload = field(frame, "payload");
  const progress = field(payload, "progress");
  return (
    strField(payload, "id") ??
    strField(payload, "agent") ??
    strField(progress, "agent") ??
    "subagent"
  );
}

let counter = 0;

function isObj(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

/** Entry equality ignoring the generated id — heartbeat dedupe compares content. */
function sameEntry(a: RenderItem | undefined, b: RenderItem | undefined): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  const { id: _a, ...restA } = a;
  const { id: _b, ...restB } = b;
  return JSON.stringify(restA) === JSON.stringify(restB);
}

/**
 * Folds one `subagent_*` frame into the agent's buffer. Priority: an
 * AgentSessionEvent-shaped object goes through the transcript's own
 * `reduceEvent`; plain text/message content becomes an assistant render
 * item; a bare status becomes a marker; anything else adds nothing. The
 * buffer is deduped against consecutive identical entries (heartbeats must
 * not flood it either). Returns the input array unchanged when the frame
 * added nothing.
 *
 * `cap` bounds retained background buffers (default SUBAGENT_BUFFER_CAP,
 * oldest dropped); the agent open in the subagent view passes `false` —
 * the on-screen transcript must be complete.
 */
export function reduceSubagentFrame(
  items: RenderItem[],
  frame: unknown,
  cap: number | false = SUBAGENT_BUFFER_CAP,
): RenderItem[] {
  // Where the content can live, most nested first: payload.event /
  // progress.event carry the AgentSessionEvent when there is one; payload
  // and progress themselves may carry plain text or a bare status.
  const payload = field(frame, "payload");
  const progress = field(payload, "progress");
  const candidates = [field(payload, "event"), field(progress, "event"), payload, progress];
  let next = items;
  for (const candidate of candidates) {
    if (!isObj(candidate)) continue;
    // AgentSessionEvent-shaped — reduceEvent returns the input by identity
    // for unknown types, which doubles as the shape check.
    const reduced = reduceEvent(next, candidate);
    if (reduced !== next) {
      next = reduced;
      break;
    }
    const text = strField(candidate, "text") ?? strField(candidate, "message");
    if (text) {
      next = [
        ...next,
        {
          kind: "assistant",
          id: `subagent-${++counter}`,
          text,
          thinking: "",
          streaming: false,
        },
      ];
      break;
    }
    const status = strField(candidate, "status");
    if (status) {
      next = [...next, markerItem(status)];
      break;
    }
  }
  if (next === items) return items;
  if (next.length === items.length + 1 && sameEntry(next.at(-1), items.at(-1))) return items;
  if (cap !== false && next.length > cap) return next.slice(next.length - cap);
  return next;
}
