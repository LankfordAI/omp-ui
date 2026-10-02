import { describe, expect, it } from "vitest";
import { goalStateFromFrame, parseGoalState } from "./goal";

const goal = {
  id: "g1",
  objective: "ship it",
  status: "active",
  tokenBudget: 5000,
  tokensUsed: 10,
  timeUsedSeconds: 2,
  createdAt: 1,
  updatedAt: 2,
};
const state = { enabled: true, mode: "active", goal };

describe("parseGoalState", () => {
  it("parses an active state", () => {
    expect(parseGoalState(state)).toEqual({ enabled: true, exiting: false, goal });
  });

  it("treats a dropped goal and an absent state as no goal", () => {
    expect(parseGoalState({ ...state, enabled: false, goal: { ...goal, status: "dropped" } })).toBeNull();
    expect(parseGoalState(null)).toBeNull();
    expect(parseGoalState(undefined)).toBeNull();
  });

  it("reads a missing tokenBudget as unbounded but rejects a zero budget", () => {
    const { tokenBudget: _omit, ...unbounded } = goal;
    expect(parseGoalState({ ...state, goal: unbounded })?.goal.tokenBudget).toBeNull();
    expect(parseGoalState({ ...state, goal: { ...goal, tokenBudget: 0 } })).toBeUndefined();
  });

  it("marks a completing goal as exiting", () => {
    const parsed = parseGoalState({ enabled: false, mode: "exiting", goal: { ...goal, status: "complete" } });
    expect(parsed?.exiting).toBe(true);
    expect(parsed?.goal.status).toBe("complete");
  });

  it("rejects malformed states", () => {
    expect(parseGoalState({ ...state, mode: "other" })).toBeUndefined();
    expect(parseGoalState({ ...state, enabled: "yes" })).toBeUndefined();
    expect(parseGoalState("text")).toBeUndefined();
  });
});

describe("goalStateFromFrame", () => {
  it("reads goal_updated, goal responses, and get_state responses", () => {
    expect(goalStateFromFrame({ type: "goal_updated", goal, state })?.goal.id).toBe("g1");
    expect(goalStateFromFrame({ type: "goal_updated", goal: null })).toBeNull();
    expect(
      goalStateFromFrame({ type: "response", command: "goal", success: true, data: { goal, state } })?.goal.id,
    ).toBe("g1");
    expect(
      goalStateFromFrame({ type: "response", command: "goal", success: true, data: { goal: null, state: null } }),
    ).toBeNull();
    expect(
      goalStateFromFrame({ type: "response", command: "get_state", success: true, data: { goal: state } })?.goal.id,
    ).toBe("g1");
    expect(
      goalStateFromFrame({ type: "response", command: "get_state", success: true, data: { goal: null } }),
    ).toBeNull();
  });

  it("says nothing for old omp, failures, and unrelated frames", () => {
    expect(
      goalStateFromFrame({ type: "response", command: "get_state", success: true, data: { model: null } }),
    ).toBeUndefined();
    expect(
      goalStateFromFrame({ type: "response", command: "goal", success: false, error: "Unknown command: goal" }),
    ).toBeUndefined();
    expect(goalStateFromFrame({ type: "agent_end" })).toBeUndefined();
    expect(goalStateFromFrame({ type: "response", command: "prompt", success: true })).toBeUndefined();
  });
});
