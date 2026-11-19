import { describe, expect, it } from "vitest";
import { PLAN_REVIEW_SENTINEL, type RpcFrame } from "@omp-ui/core";
import { DialogGateTracker } from "./dialog-gate-tracker";

const request = (id: unknown, method = "select", title?: string): RpcFrame =>
  ({
    type: "extension_ui_request",
    id,
    method,
    ...(title !== undefined ? { title } : {}),
  }) as RpcFrame;

const response = (id: string): RpcFrame =>
  ({ type: "extension_ui_response", id, value: "yes" }) as RpcFrame;

const cancel = (id: string, targetId?: unknown): RpcFrame =>
  ({
    type: "extension_ui_request",
    id,
    method: "cancel",
    ...(targetId !== undefined ? { targetId } : {}),
  }) as RpcFrame;

describe("DialogGateTracker (issue #555)", () => {
  it("tracks blocking selects in arrival order and drops them on the answer", () => {
    const gates = new DialogGateTracker();
    gates.onFrame("t1", request("q1"));
    gates.onFrame("t1", request("q2", "confirm"));
    expect(gates.hasOpen("t1")).toBe(true);
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q1", "q2"]);

    gates.onSend("t1", response("q1"));
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q2"]);

    gates.onSend("t1", response("q2"));
    expect(gates.hasOpen("t1")).toBe(false);
    expect(gates.openFrames("t1")).toEqual([]);
  });

  it("keeps tabs independent and clears on exit and dispose", () => {
    const gates = new DialogGateTracker();
    gates.onFrame("t1", request("q1"));
    gates.onFrame("t2", request("q1"));
    gates.onSend("t1", response("q1"));
    expect(gates.hasOpen("t1")).toBe(false);
    expect(gates.hasOpen("t2")).toBe(true);

    gates.onExit("t2");
    expect(gates.hasOpen("t2")).toBe(false);

    gates.onFrame("t3", request("q9"));
    gates.dispose("t3");
    expect(gates.hasOpen("t3")).toBe(false);
  });

  it("tracks a multi-question ask like the other blocking dialogs (issue #1234)", () => {
    const gates = new DialogGateTracker();
    // The probed ask frame carries questions and no title: an ask with no
    // usable title must still hold — it blocks omp exactly like a select.
    gates.onFrame("t1", {
      type: "extension_ui_request",
      id: "a1",
      method: "ask",
      questions: [{ id: "db", question: "Which?", options: ["SQLite"] }],
    } as RpcFrame);
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["a1"]);
    gates.onSend("t1", response("a1"));
    expect(gates.hasOpen("t1")).toBe(false);
  });

  it("excludes the plan-review select — its gate owns that frame", () => {
    const gates = new DialogGateTracker();
    const title = `${PLAN_REVIEW_SENTINEL}${JSON.stringify({
      title: "add auth",
      planFilePath: "local://auth-plan.md",
      planAbsPath: "/l/auth-plan.md",
    })}`;
    gates.onFrame("t1", request("p1", "select", title));
    expect(gates.hasOpen("t1")).toBe(false);
    expect(gates.openFrames("t1")).toEqual([]);
  });

  it("ignores fire-and-forget methods and frames without a usable id", () => {
    const gates = new DialogGateTracker();
    gates.onFrame("t1", request("n1", "notify"));
    gates.onFrame("t1", request("s1", "setStatus"));
    gates.onFrame("t1", request(undefined));
    gates.onFrame("t1", request(42));
    expect(gates.hasOpen("t1")).toBe(false);
    expect(gates.openFrames("t1")).toEqual([]);
  });

  it("treats an unrelated answer or an unknown tab as a no-op", () => {
    const gates = new DialogGateTracker();
    gates.onFrame("t1", request("q1"));
    gates.onSend("t1", response("zz"));
    gates.onSend("t9", response("q1"));
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q1"]);
    expect(gates.openFrames("t9")).toEqual([]);
  });

  it("drops the targeted dialog on a cancel frame (issue #1191)", () => {
    const gates = new DialogGateTracker();
    gates.onFrame("t1", request("q1"));
    gates.onFrame("t1", request("q2", "confirm"));
    // omp settled q1 itself (abort/timeout): the cancel carries a fresh frame
    // id and names q1 as its target. The session must stop reporting it.
    gates.onFrame("t1", cancel("c1", "q1"));
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q2"]);
    expect(gates.hasOpen("t1")).toBe(true);

    // A second answer for a settled frame stays a no-op delete.
    gates.onSend("t1", response("q1"));
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q2"]);
  });

  it("ignores cancels that name no open dialog, another tab, or no target", () => {
    const gates = new DialogGateTracker();
    gates.onFrame("t1", request("q1"));
    gates.onFrame("t1", cancel("c-unknown", "zz"));
    gates.onFrame("t2", cancel("c-other-tab", "q1"));
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q1"]);

    // A malformed cancel (no usable targetId) is inert too: never tracked.
    gates.onFrame("t1", cancel("c-bad"));
    gates.onFrame("t1", cancel("c-bad", 42));
    expect(gates.hasOpen("t1")).toBe(true);
    expect(gates.openFrames("t1").map((f) => f.id)).toEqual(["q1"]);
  });
});
