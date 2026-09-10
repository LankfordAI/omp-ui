import { describe, expect, it } from "vitest";
import { GOAL_STATUS_KEY, type GoalSnapshot, type NativeGoal, type RpcFrame } from "@omp-ui/core";
import { GoalStatusTracker } from "./goal-status-tracker";

const GOAL: NativeGoal = {
  id: "g1",
  objective: "finish the migration",
  status: "active",
  tokenBudget: null,
  tokensUsed: 0,
  timeUsedSeconds: 0,
  createdAt: 1,
  updatedAt: 1,
};

function snapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    version: 1,
    processKey: "proc-a",
    sessionId: "session-1",
    revision: 1,
    available: true,
    unavailable: null,
    enabled: true,
    goal: { ...GOAL },
    continuation: "idle",
    pauseReason: null,
    result: null,
    ...overrides,
  };
}

/** The goal every fixture shares, so a case can vary one field at a time. */
function baseGoal(): NativeGoal {
  const value = snapshot().goal;
  if (value === null) throw new Error("fixture goal must exist");
  return value;
}

function statusFrame(value: GoalSnapshot | string): RpcFrame {
  return {
    type: "extension_ui_request",
    id: "frame-1",
    method: "setStatus",
    statusKey: GOAL_STATUS_KEY,
    statusText: typeof value === "string" ? value : JSON.stringify(value),
  } as RpcFrame;
}

function tracker(): { goals: GoalStatusTracker; broadcasts: () => number } {
  let broadcasts = 0;
  const goals = new GoalStatusTracker({
    broadcast: () => {
      broadcasts += 1;
      return Promise.resolve();
    },
  });
  return { goals, broadcasts: () => broadcasts };
}

/** Drains the tracker's fire-and-forget broadcasts. */
async function drain(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe("GoalStatusTracker", () => {
  it("keeps the newest snapshot from one bridge and drops an older revision", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot({ revision: 4 })));
    expect(goals.snapshot("tab")?.revision).toBe(4);
    goals.onFrame("tab", statusFrame(snapshot({ revision: 3 })));
    expect(goals.snapshot("tab")?.revision).toBe(4);
    goals.onFrame("tab", statusFrame(snapshot({ revision: 5, pauseReason: "later" })));
    expect(goals.snapshot("tab")?.pauseReason).toBe("later");
  });

  it("accepts a replacement process and drops the retired generation's late frames", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot({ processKey: "proc-a", revision: 9 })));
    goals.onFrame("tab", statusFrame(snapshot({ processKey: "proc-b", revision: 1 })));
    expect(goals.snapshot("tab")?.processKey).toBe("proc-b");
    // A frame still in flight from the killed spawn cannot outvote the successor,
    // no matter how high its own counter runs.
    goals.onFrame("tab", statusFrame(snapshot({ processKey: "proc-a", revision: 99 })));
    expect(goals.snapshot("tab")?.processKey).toBe("proc-b");
  });

  it("keeps the last good snapshot when a publish is malformed", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot()));
    goals.onFrame("tab", statusFrame("{not json"));
    expect(goals.snapshot("tab")?.goal?.objective).toBe("finish the migration");
    expect(goals.preventsHibernation("tab")).toBe(true);
  });

  it("vetoes hibernation for active goals and live continuations only", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot({ revision: 1, goal: null, enabled: false })));
    expect(goals.preventsHibernation("tab")).toBe(false);

    goals.onFrame("tab", statusFrame(snapshot({ revision: 2, goal: null, enabled: false, continuation: "scheduled" })));
    expect(goals.preventsHibernation("tab")).toBe(true);
    goals.onFrame("tab", statusFrame(snapshot({ revision: 3, goal: null, enabled: false, continuation: "running" })));
    expect(goals.preventsHibernation("tab")).toBe(true);

    // A paused or budget-limited idle goal owns no loop: ordinary idle rules apply.
    goals.onFrame(
      "tab",
      statusFrame(snapshot({ revision: 4, enabled: false, goal: { ...baseGoal(), status: "paused" }, continuation: "idle" })),
    );
    expect(goals.preventsHibernation("tab")).toBe(false);
    goals.onFrame(
      "tab",
      statusFrame(
        snapshot({ revision: 5, goal: { ...baseGoal(), status: "budget-limited" }, continuation: "idle" }),
      ),
    );
    expect(goals.preventsHibernation("tab")).toBe(false);
  });

  it("treats lost status after a known active goal conservatively", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot()));
    expect(goals.preventsHibernation("tab")).toBe(true);
    // The bridge broke: no loop is observable, but the goal is still unfinished,
    // so nothing may be reaped until a valid state or the process says otherwise.
    goals.onFrame(
      "tab",
      statusFrame(
        snapshot({
          available: false,
          unavailable: "goalRuntime is missing: resumeGoal",
          enabled: false,
          goal: null,
          continuation: "idle",
          revision: 2,
        }),
      ),
    );
    expect(goals.snapshot("tab")?.available).toBe(false);
    expect(goals.preventsHibernation("tab")).toBe(true);
    goals.onFrame("tab", statusFrame(snapshot({ goal: null, enabled: false, revision: 3 })));
    expect(goals.preventsHibernation("tab")).toBe(false);
  });

  it("stops vetoing the moment the process dies", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot({ continuation: "running" })));
    expect(goals.preventsHibernation("tab")).toBe(true);
    goals.onExit("tab");
    expect(goals.snapshot("tab")).toBeUndefined();
    expect(goals.preventsHibernation("tab")).toBe(false);
    // A successor starts clean: nothing from the dead generation survives.
    goals.onFrame("tab", statusFrame(snapshot({ goal: null, enabled: false, processKey: "proc-b" })));
    expect(goals.preventsHibernation("tab")).toBe(false);
  });

  it("broadcasts only when the accepted state actually changes", async () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", statusFrame(snapshot()));
    await drain();
    expect(broadcasts()).toBe(1);
    goals.onFrame("tab", statusFrame(snapshot()));
    await drain();
    expect(broadcasts()).toBe(1);
    goals.onFrame("tab", statusFrame(snapshot({ revision: 2, continuation: "scheduled" })));
    await drain();
    expect(broadcasts()).toBe(2);
  });

  it("ignores another bridge's status channel entirely", () => {
    const { goals } = tracker();
    goals.onFrame("tab", {
      type: "extension_ui_request",
      id: "x",
      method: "setStatus",
      statusKey: "omp-ui:capabilities",
      statusText: JSON.stringify(snapshot()),
    } as RpcFrame);
    expect(goals.snapshot("tab")).toBeUndefined();
  });

  it("clears on dispose so a deleted tab cannot keep a session awake", async () => {
    const { goals } = tracker();
    goals.onFrame("tab", statusFrame(snapshot()));
    goals.dispose("tab");
    await drain();
    expect(goals.preventsHibernation("tab")).toBe(false);
  });
});
