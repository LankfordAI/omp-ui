import { describe, expect, it } from "vitest";
import type { GoalStatus, NativeGoal, RpcFrame } from "@omp-ui/core";
import { GoalStatusTracker } from "./goal-status-tracker";

const GOAL: NativeGoal = {
  id: "g1",
  objective: "finish the migration",
  status: "active",
  tokenBudget: 5000,
  tokensUsed: 120,
  timeUsedSeconds: 3,
  createdAt: 1,
  updatedAt: 1,
};

/** omp's GoalModeState wire shape for one goal status ("dropped" included). */
function wireState(status: GoalStatus | "dropped", overrides: Partial<NativeGoal> = {}) {
  return {
    enabled: status === "active" || status === "budget-limited",
    mode: "active",
    goal: { ...GOAL, status, ...overrides },
  };
}

function goalUpdated(status: GoalStatus | "dropped", overrides: Partial<NativeGoal> = {}): RpcFrame {
  const state = wireState(status, overrides);
  return { type: "goal_updated", goal: state.goal, state } as RpcFrame;
}

function response(command: string, success: boolean, data: unknown, error?: string): RpcFrame {
  return { type: "response", id: "r1", command, success, data, ...(error ? { error } : {}) } as RpcFrame;
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

describe("GoalStatusTracker", () => {
  it("stores an active goal from goal_updated and vetoes hibernation", () => {
    const { goals, broadcasts } = tracker();
    expect(goals.state("tab")).toBeUndefined();
    goals.onFrame("tab", goalUpdated("active"));
    expect(goals.state("tab")).toEqual({ enabled: true, exiting: false, goal: GOAL });
    expect(goals.preventsHibernation("tab")).toBe(true);
    expect(broadcasts()).toBe(1);
  });

  it("stores a paused goal without vetoing hibernation", () => {
    const { goals } = tracker();
    goals.onFrame("tab", goalUpdated("active"));
    goals.onFrame("tab", response("goal", true, { goal: { ...GOAL, status: "paused" }, state: wireState("paused") }));
    expect(goals.state("tab")?.goal.status).toBe("paused");
    expect(goals.state("tab")?.enabled).toBe(false);
    expect(goals.preventsHibernation("tab")).toBe(false);
  });

  it("does not veto hibernation for a budget-limited goal", () => {
    const { goals } = tracker();
    goals.onFrame("tab", goalUpdated("budget-limited"));
    expect(goals.state("tab")?.goal.status).toBe("budget-limited");
    expect(goals.preventsHibernation("tab")).toBe(false);
  });

  it("a dropped goal_updated becomes null and releases the veto", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", goalUpdated("active"));
    goals.onFrame("tab", goalUpdated("dropped"));
    expect(goals.state("tab")).toBeNull();
    expect(goals.preventsHibernation("tab")).toBe(false);
    expect(broadcasts()).toBe(2);
  });

  it("reads get_state.goal, and a get_state without the key leaves state untouched", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", response("get_state", true, { goal: wireState("active") }));
    expect(goals.state("tab")?.goal.id).toBe("g1");
    goals.onFrame("tab", response("get_state", true, { thinkingLevel: "high" }));
    expect(goals.state("tab")?.goal.id).toBe("g1");
    expect(broadcasts()).toBe(1);
  });

  it("an old omp's get_state without the key reports nothing, keeping the tab absent", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", response("get_state", true, { thinkingLevel: "high" }));
    expect(goals.state("tab")).toBeUndefined();
    expect(broadcasts()).toBe(0);
  });

  it("a failed goal response is ignored", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", goalUpdated("active"));
    goals.onFrame(
      "tab",
      response("goal", false, undefined, "A goal is already active. Drop it before creating another."),
    );
    expect(goals.state("tab")?.goal.status).toBe("active");
    expect(broadcasts()).toBe(1);
  });

  it("a malformed state keeps the last good one", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", goalUpdated("active"));
    goals.onFrame("tab", goalUpdated("active", { tokensUsed: -1 }));
    goals.onFrame("tab", { type: "goal_updated", goal: null, state: "garbage" } as RpcFrame);
    expect(goals.state("tab")).toEqual({ enabled: true, exiting: false, goal: GOAL });
    expect(goals.preventsHibernation("tab")).toBe(true);
    expect(broadcasts()).toBe(1);
  });

  it("an identical state does not broadcast again", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", goalUpdated("active"));
    goals.onFrame("tab", response("get_state", true, { goal: wireState("active") }));
    expect(broadcasts()).toBe(1);
    goals.onFrame("tab", goalUpdated("active", { tokensUsed: 500 }));
    expect(broadcasts()).toBe(2);
  });

  it("onExit clears the tab and broadcasts once", () => {
    const { goals, broadcasts } = tracker();
    goals.onFrame("tab", goalUpdated("active"));
    goals.onFrame("other", goalUpdated("active"));
    expect(broadcasts()).toBe(2);
    goals.onExit("tab");
    goals.onExit("tab");
    expect(goals.state("tab")).toBeUndefined();
    expect(goals.preventsHibernation("tab")).toBe(false);
    expect(goals.state("other")?.goal.id).toBe("g1");
    expect(broadcasts()).toBe(3);
  });
});
