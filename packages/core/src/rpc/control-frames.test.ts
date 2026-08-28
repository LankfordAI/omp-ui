import { describe, expect, it } from "vitest";
import { normalizeControlFrame } from "./control-frames";

describe("normalizeControlFrame", () => {
  it("discriminates each control kind with its payload fields left unknown", () => {
    const frame = { type: "response", id: "abc", success: false, error: "nope" };
    expect(normalizeControlFrame(frame)).toEqual({
      kind: "response",
      id: "abc",
      success: false,
      data: undefined,
      error: "nope",
      frame,
    });
    const ready = { type: "ready" };
    expect(normalizeControlFrame(ready)).toEqual({ kind: "ready", frame: ready });
    expect(normalizeControlFrame({ type: "omp_ui_error", message: "died" })).toMatchObject({
      kind: "omp_ui_error",
      message: "died",
    });
    const ext = { type: "extension_ui_request", id: "e1", method: "select" };
    expect(normalizeControlFrame(ext)).toEqual({
      kind: "ext_request",
      id: "e1",
      method: "select",
      frame: ext,
    });
    const ans = { type: "extension_ui_response", id: "e1", value: "x" };
    expect(normalizeControlFrame(ans)).toEqual({
      kind: "ext_response",
      id: "e1",
      value: "x",
      frame: ans,
    });
  });

  it("defaults a non-string omp_ui_error message to the generic text", () => {
    expect(normalizeControlFrame({ type: "omp_ui_error" })).toMatchObject({
      kind: "omp_ui_error",
      message: "omp rpc error",
    });
  });

  it("returns null for non-frames and agent-event frames — never throws", () => {
    for (const wire of [
      null,
      undefined,
      7,
      "type",
      [],
      { type: "token_path" },
      { type: "agent_end" },
      { type: "session_info_update" },
      { type: "host_tool_call", id: "x" },
      { hello: "world" },
    ]) {
      expect(normalizeControlFrame(wire)).toBeNull();
    }
  });
});
