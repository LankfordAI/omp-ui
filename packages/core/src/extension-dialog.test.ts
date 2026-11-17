import { describe, expect, it } from "vitest";
import { parseExtensionDialogCancel } from "./extension-dialog";

describe("parseExtensionDialogCancel (issue #1191)", () => {
  it("reads the targeted dialog id off a cancel request", () => {
    expect(
      parseExtensionDialogCancel({
        type: "extension_ui_request",
        id: "c1",
        method: "cancel",
        targetId: "q1",
      }),
    ).toBe("q1");
  });

  it("returns null for any other frame", () => {
    expect(parseExtensionDialogCancel(null)).toBeNull();
    expect(parseExtensionDialogCancel("cancel")).toBeNull();
    expect(parseExtensionDialogCancel({ type: "response", method: "cancel", targetId: "q1" })).toBeNull();
    expect(
      parseExtensionDialogCancel({ type: "extension_ui_request", id: "s1", method: "select", targetId: "q1" }),
    ).toBeNull();
  });

  it("returns null for a cancel that names no usable target", () => {
    expect(parseExtensionDialogCancel({ type: "extension_ui_request", id: "c1", method: "cancel" })).toBeNull();
    expect(parseExtensionDialogCancel({ type: "extension_ui_request", id: "c1", method: "cancel", targetId: 7 })).toBeNull();
  });
});
