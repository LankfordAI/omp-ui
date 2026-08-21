/**
 * Model-stream activity classification, shared by the renderer's stall
 * indicator (issue #228) and the main process's stall watchdog (issue #248).
 * Dependency-free: the renderer imports this subpath, so nothing Node-only
 * may leak in.
 */

function field(obj: unknown, key: string): unknown {
  if (obj === null || typeof obj !== "object" || !(key in obj)) return undefined;
  // Guarded by `key in obj` above; TS can't narrow indexing with a variable key.
  return (obj as Record<string, unknown>)[key];
}

function strField(obj: unknown, key: string): string | undefined {
  const value = field(obj, key);
  return typeof value === "string" ? value : undefined;
}

/**
 * The latest observed request/model progress checkpoint, or null when the
 * frame is not model-stream progress. Every model-stream frame counts —
 * deltas plus block start/end events (issue #228) — so a stalled stream is
 * detectable even in a gap between deltas. Local tool execution is
 * deliberately excluded: it cannot reset a provider-stream clock. (The main
 * process's watchdog tracks tool execution separately, as a guard against
 * aborting legitimate local work.)
 */
export function modelStreamCheckpointLabel(frame: unknown): string | null {
  const type = strField(frame, "type");
  switch (type) {
    case "turn_start":
      return "turn started";
    case "message_start":
      return strField(field(frame, "message"), "role") === "assistant"
        ? "response opened"
        : null;
    case "message_update": {
      switch (strField(field(frame, "assistantMessageEvent"), "type")) {
        case "text_start":
          return "text block started";
        case "text_delta":
          return "streaming text";
        case "text_end":
          return "text block complete";
        case "thinking_start":
          return "thinking block started";
        case "thinking_delta":
          return "streaming thinking";
        case "thinking_end":
          return "thinking block complete";
        case "toolcall_start":
        case "toolcall_delta":
          return "streaming tool-call arguments";
        case "toolcall_end":
          return "tool-call arguments complete";
        default:
          return null;
      }
    }
    default:
      return null;
  }
}
