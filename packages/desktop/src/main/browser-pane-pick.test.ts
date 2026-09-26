import { describe, expect, it, vi } from "vitest";
import { BROWSER_PANE_PICK_SELECTOR_MAX } from "@omp-ui/core";
import type { PaneDebugger } from "./browser-pane-contents";
import { PICK_FUNCTION, pickElement } from "./browser-pane-pick";

function debuggerWith(replies: Record<string, unknown>): PaneDebugger {
  return {
    attach: vi.fn(),
    detach: vi.fn(),
    isAttached: () => true,
    sendCommand: vi.fn(async (method: string) => {
      const reply = replies[method];
      if (reply instanceof Error) throw reply;
      return reply ?? {};
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
}

const picked = {
  selector: "#save",
  tag: "button",
  text: "Save",
  framed: false,
  rect: { x: 1, y: 2, width: 30, height: 20 },
};

describe("browser pane element picking", () => {
  it("adds scroll to the hit point and releases the resolved object", async () => {
    const dbg = debuggerWith({
      "Runtime.evaluate": { result: { value: [0, 300] } },
      "DOM.getNodeForLocation": { backendNodeId: 42 },
      "DOM.resolveNode": { object: { objectId: "node-1" } },
      "Runtime.callFunctionOn": { result: { value: picked } },
    });
    await expect(pickElement(dbg, 10, 20)).resolves.toEqual({ status: "picked", ...picked });
    expect(dbg.sendCommand).toHaveBeenCalledWith("DOM.getNodeForLocation", {
      x: 10,
      y: 320,
      includeUserAgentShadowDOM: false,
      ignorePointerEventsNone: false,
    });
    expect(dbg.sendCommand).toHaveBeenCalledWith("DOM.resolveNode", { backendNodeId: 42 });
    expect(dbg.sendCommand).toHaveBeenCalledWith("Runtime.callFunctionOn", {
      objectId: "node-1",
      functionDeclaration: PICK_FUNCTION,
      returnByValue: true,
    });
    expect(dbg.sendCommand).toHaveBeenLastCalledWith("Runtime.releaseObject", { objectId: "node-1" });
  });

  it("returns miss when hit testing rejects", async () => {
    const dbg = debuggerWith({
      "Runtime.evaluate": { result: { value: [0, 0] } },
      "DOM.getNodeForLocation": new Error("No node found at given location"),
    });
    await expect(pickElement(dbg, 1, 2)).resolves.toEqual({ status: "miss" });
  });

  it("bounds page strings and rejects a non-finite rect", async () => {
    const replies = {
      "Runtime.evaluate": { result: { value: [0, 0] } },
      "DOM.getNodeForLocation": { backendNodeId: 1 },
      "DOM.resolveNode": { object: { objectId: "node" } },
      "Runtime.callFunctionOn": { result: { value: { ...picked, selector: "x".repeat(2_000) } } },
    };
    const dbg = debuggerWith(replies);
    const result = await pickElement(dbg, 1, 2);
    expect(result.status === "picked" ? result.selector.length : 0).toBe(BROWSER_PANE_PICK_SELECTOR_MAX);
    replies["Runtime.callFunctionOn"] = {
      result: { value: { ...picked, rect: { ...picked.rect, width: Number.POSITIVE_INFINITY } } },
    };
    await expect(pickElement(dbg, 1, 2)).resolves.toEqual({ status: "miss" });
  });
});
