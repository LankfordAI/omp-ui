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

  it("auto-cancels every other method", () => {
    for (const method of [
      "notify",
      "setStatus",
      "setWidget",
      "setTitle",
      "set_editor_text",
      "open_url",
      "cancel",
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
