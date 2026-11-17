import { describe, expect, it } from "vitest";
import { extensionCancelResponse, routeExtensionRequest } from "./extension-router";

describe("routeExtensionRequest", () => {
  it("routes select/confirm/input/editor to dialogs", () => {
    for (const method of ["select", "confirm", "input", "editor"]) {
      expect(routeExtensionRequest({ type: "extension_ui_request", id: "1", method })).toEqual({
        action: "dialog",
        method,
      });
    }
  });

  it("routes open_url to the system browser", () => {
    expect(
      routeExtensionRequest({ type: "extension_ui_request", id: "1", method: "open_url" }),
    ).toEqual({ action: "open-url" });
  });

  it("routes a cancel to the dialog it targets, never an auto-cancel reply", () => {
    expect(
      routeExtensionRequest({
        type: "extension_ui_request",
        id: "2",
        method: "cancel",
        targetId: "q1",
      }),
    ).toEqual({ action: "cancel", targetId: "q1" });
  });

  it("routes a cancel with no usable target as inert — never auto-cancelled (issue #1191)", () => {
    for (const frame of [
      { type: "extension_ui_request", id: "2", method: "cancel" },
      { type: "extension_ui_request", id: "2", method: "cancel", targetId: 7 },
    ]) {
      expect(routeExtensionRequest(frame)).toEqual({ action: "cancel", targetId: null });
    }
  });

  it("auto-cancels every other method", () => {
    for (const method of [
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
    ]) {
      expect(routeExtensionRequest({ type: "extension_ui_request", id: "1", method })).toEqual({
        action: "auto-cancel",
      });
    }
  });

  it("auto-cancels malformed requests", () => {
    expect(routeExtensionRequest(null)).toEqual({ action: "auto-cancel" });
    expect(routeExtensionRequest({})).toEqual({ action: "auto-cancel" });
    expect(routeExtensionRequest("select")).toEqual({ action: "auto-cancel" });
  });
});

describe("extensionCancelResponse", () => {
  it("builds a cancelled protocol response", () => {
    expect(extensionCancelResponse("abc")).toEqual({
      type: "extension_ui_response",
      id: "abc",
      cancelled: true,
    });
  });
});
