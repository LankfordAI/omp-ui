/**
 * Control-frame grammar, isolated from rpc/codec.ts so the web build (no node
 * globals) can import it — codec.ts itself references Buffer and belongs to
 * the node side.
 */
import { isObject } from "../guards";

/** A parsed NDJSON record; every field stays `unknown` until normalized. */
export type WireRecord = Record<string, unknown>;

/**
 * The control frames omp-ui answers or settles on, discriminated. Agent-event
 * frames (token_path, tool_execution_*, session_info_update, ...) are NOT
 * control frames: they flow to the transcript reducer with their fields left
 * `unknown` for the per-domain parsers. `null` never throws — a non-object or
 * an unknown type is simply not a control frame (the same tolerant posture as
 * the reassembler's callers).
 */
export type RpcControlFrame =
  | { kind: "response"; id: unknown; success: unknown; data: unknown; error: unknown; frame: WireRecord }
  | { kind: "ready"; frame: WireRecord }
  | { kind: "omp_ui_error"; message: string; frame: WireRecord }
  | { kind: "ext_request"; id: unknown; method: unknown; frame: WireRecord }
  | { kind: "ext_response"; id: unknown; value: unknown; frame: WireRecord };

/**
 * One normalization of the control-frame grammar, shared by the renderer's
 * frame reducer, the plan gate, and the hibernation probe (each kept a
 * private copy of these field tests). The original `frame` rides along:
 * payload internals stay `unknown` into the existing per-domain parsers, so
 * nothing here assumes upstream OMP changes.
 */
export function normalizeControlFrame(wire: unknown): RpcControlFrame | null {
  if (!isObject(wire)) return null;
  const frame: WireRecord = wire;
  switch (frame.type) {
    case "response":
      return {
        kind: "response",
        id: frame.id,
        success: frame.success,
        data: frame.data,
        error: frame.error,
        frame,
      };
    case "ready":
      return { kind: "ready", frame };
    case "omp_ui_error":
      return {
        kind: "omp_ui_error",
        message: typeof frame.message === "string" ? frame.message : "omp rpc error",
        frame,
      };
    case "extension_ui_request":
      return { kind: "ext_request", id: frame.id, method: frame.method, frame };
    case "extension_ui_response":
      return { kind: "ext_response", id: frame.id, value: frame.value, frame };
    default:
      return null;
  }
}
