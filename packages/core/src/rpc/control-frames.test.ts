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

  it("lifts a usable failedModel and drops a malformed one (issue #774)", () => {
    expect(
      normalizeControlFrame({ type: "omp_ui_error", message: "died", failedModel: "p/m" }),
    ).toMatchObject({ kind: "omp_ui_error", message: "died", failedModel: "p/m" });
    for (const failedModel of ["", 42, null, undefined]) {
      const frame = normalizeControlFrame({ type: "omp_ui_error", message: "died", failedModel });
      expect(frame).toMatchObject({ kind: "omp_ui_error" });
      expect(frame).not.toHaveProperty("failedModel");
    }
  });

  it("discriminates the host frames (issue #688)", () => {
    const toolCall = { type: "host_tool_call", id: "h1", toolCallId: "c1", toolName: "omp-ui_notify", arguments: {} };
    expect(normalizeControlFrame(toolCall)).toEqual({ kind: "host_tool_call", id: "h1", frame: toolCall });
    expect(normalizeControlFrame({ type: "host_tool_cancel", id: "h2", targetId: "h1" })).toMatchObject({
      kind: "host_tool_cancel",
      id: "h2",
    });
    expect(normalizeControlFrame({ type: "host_uri_request", id: "h3", operation: "read", url: "omp-ui://plan" })).toMatchObject({
      kind: "host_uri_request",
      id: "h3",
    });
    expect(normalizeControlFrame({ type: "host_uri_cancel", id: "h4", targetId: "h1" })).toMatchObject({
      kind: "host_uri_cancel",
      id: "h4",
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
      { type: "host_tool_update", id: "h5", toolCallId: "c1", partialContent: [] },
      { hello: "world" },
    ]) {
      expect(normalizeControlFrame(wire)).toBeNull();
    }
  });
});
