// The goal command family in a native tab (ADR-0046): what the composer sends
// as omp's native `goal` command, how omp's answer settles the row, how goal
// frames reach the tab, and what automatic prompts may not do while a goal
// owns the session.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import type { GoalState, NativeGoal } from "@omp-ui/core/goal";
import type { SetSessionToolEnabledResult } from "@omp-ui/core/capabilities";
import { STALL_CONTINUE_LEAD, STALL_CONTINUE_SETTLE_MS } from "../../lib/stall-continue";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";
import type { UiStore } from "../types";

function nativeGoal(overrides: Partial<NativeGoal> = {}): NativeGoal {
  return {
    id: "g1",
    objective: "finish the migration",
    status: "active",
    tokenBudget: null,
    tokensUsed: 100,
    timeUsedSeconds: 12,
    createdAt: 1,
    updatedAt: 2,
    ...overrides,
  };
}

function goalState(goal: Partial<NativeGoal> = {}, enabled = true): GoalState {
  return { enabled, exiting: false, goal: nativeGoal(goal) };
}

/** omp's wire GoalModeState for one parsed state. */
function wireState(state: GoalState): Record<string, unknown> {
  return { enabled: state.enabled, mode: state.exiting ? "exiting" : "active", goal: state.goal };
}

/** One goal response's data, as omp answers every op. */
function goalData(state: GoalState | null): Record<string, unknown> {
  return state === null
    ? { goal: null, state: null }
    : { goal: state.goal, state: wireState(state) };
}

function goalCommands(): Array<Record<string, unknown>> {
  return h.sent.filter(({ cmd }) => cmd.type === "goal").map(({ cmd }) => cmd);
}

function allPrompts(): string[] {
  return h.sent
    .filter(({ cmd }) => cmd.type === "prompt" && typeof cmd.message === "string")
    .map(({ cmd }) => String(cmd.message));
}

function commandRows(): Array<{ name: string; args: string; status: string; output?: string; error?: string }> {
  return (h.useStore.getState().rpc[h.TAB]?.items ?? [])
    .filter((item) => item.kind === "command")
    .map((item) =>
      item.kind === "command"
        ? { name: item.name, args: item.args, status: item.status, output: item.output, error: item.error }
        : null,
    )
    .filter((row): row is NonNullable<typeof row> => row !== null);
}

type Reply = { data: unknown; ok?: boolean };

/**
 * Runs a slash line and answers each `goal` command it sends with the next
 * scripted reply, in order. Every other command is answered with an empty
 * success. Frames stay in `h.sent` — what left the tab is the evidence.
 */
async function runLine(line: string, replies: Reply[] = []): Promise<void> {
  const queue = [...replies];
  const answered = new Set<unknown>();
  const promise = h.useStore.getState().runSlashCommand(h.TAB, line);
  let settled = false;
  void promise.finally(() => (settled = true));
  for (let wave = 0; wave < 8 && !settled; wave++) {
    await h.flushMicrotasks();
    for (const { tabId, cmd } of [...h.sent]) {
      if (answered.has(cmd)) continue;
      answered.add(cmd);
      if (cmd.type === "goal") {
        const reply = queue.shift() ?? { data: goalData(null) };
        h.respond(tabId, cmd, reply.data, reply.ok ?? true);
      } else {
        h.respond(tabId, cmd, { agentInvoked: false });
      }
    }
  }
  await promise;
}

function seed(goal: GoalState | null, patch: Parameters<typeof rpcTabState>[0] = {}): void {
  h.useStore.setState({
    state: h.backendState,
    tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
    rpc: { [h.TAB]: rpcTabState({ goal, ...patch }) },
  });
}

describe("native goal commands (ADR-0046)", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.sent.length = 0;
  });

  describe("the composer's slash interception", () => {
    beforeEach(() => seed(null));

    it("sends /goal <objective> as exactly one create and no prompt", async () => {
      await runLine("/goal x", [{ data: goalData(goalState({ objective: "x" })) }]);
      expect(goalCommands()).toEqual([
        expect.objectContaining({ type: "goal", op: "create", objective: "x" }),
      ]);
      expect(goalCommands()[0]).not.toHaveProperty("token_budget");
      expect(allPrompts()).toEqual([]);
      expect(commandRows()[0]).toMatchObject({ name: "goal", args: "x", status: "done", output: "Goal set: x" });
    });

    it("carries --budget N as token_budget and sends the objective trimmed", async () => {
      await runLine("/goal --budget 5000   ship it  ", [{ data: goalData(goalState()) }]);
      expect(goalCommands()).toEqual([
        expect.objectContaining({ op: "create", objective: "ship it", token_budget: 5000 }),
      ]);
    });

    it.each([
      ["/goal --budget 0 ship it", "positive whole number"],
      ["/goal --budget abc ship it", "positive whole number"],
      ["/goal --budget 5000", "positive whole number"],
      ["/goal budget 10", "set when it is created"],
      ["/goal pause now", "takes no arguments"],
      ["/goal set", "Give the goal an objective"],
    ])("refuses %s and sends nothing", async (line, reason) => {
      await runLine(line);
      expect(goalCommands()).toEqual([]);
      expect(allPrompts()).toEqual([]);
      expect(commandRows()[0]?.status).toBe("failed");
      expect(commandRows()[0]?.error).toContain(reason);
    });

    it("leaves a terminal tab's goal line to omp's own TUI", async () => {
      h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, mode: "pty" })] });
      await runLine("/goal show");
      expect(goalCommands()).toEqual([]);
      expect(allPrompts()).toContain("/goal show");
    });

    it("does not intercept /goals", async () => {
      await runLine("/goals");
      expect(goalCommands()).toEqual([]);
      expect(allPrompts()).toContain("/goals");
    });

    it("shows omp's refusal sentence verbatim", async () => {
      await runLine("/goal x", [
        { data: "A goal is already active. Drop it before creating another.", ok: false },
      ]);
      expect(commandRows()[0]).toMatchObject({
        status: "failed",
        error: "A goal is already active. Drop it before creating another.",
      });
    });

    it("tells an omp without the command to update, with no fallback", async () => {
      await runLine("/goal x", [{ data: "Unknown command: goal", ok: false }]);
      expect(commandRows()[0]?.error).toContain("18.4.11");
      expect(h.sent.map(({ cmd }) => cmd.type)).toEqual(["goal"]);
    });

    it("refuses before sending when the session cannot take commands", async () => {
      seed(null, { status: "starting" });
      await runLine("/goal x");
      expect(goalCommands()).toEqual([]);
      expect(commandRows()[0]?.error).toContain("not ready");
    });

    it("refuses to start a goal while vibe mode is on", async () => {
      seed(null, { vibe: { enabled: true } as UiStore["rpc"][string]["vibe"] });
      await runLine("/goal x");
      expect(goalCommands()).toEqual([]);
      expect(commandRows()[0]?.error).toContain("vibe");
    });
  });

  describe("show, set, and the lifecycle ops", () => {
    it("bare /goal with no goal outputs the none text", async () => {
      seed(null);
      await runLine("/goal", [{ data: goalData(null) }]);
      expect(goalCommands()).toEqual([expect.objectContaining({ op: "get" })]);
      expect(commandRows()[0]).toMatchObject({ status: "done", output: expect.stringContaining("No goal is set") });
    });

    it("bare /goal with a goal outputs its details", async () => {
      const state = goalState({ tokenBudget: 1000, tokensUsed: 400 });
      seed(state);
      await runLine("/goal show", [{ data: goalData(state) }]);
      const output = commandRows()[0]?.output ?? "";
      expect(output).toContain("Objective: finish the migration");
      expect(output).toContain("Status: active");
      expect(output).toContain("Tokens: 400 of 1,000 used, 600 remaining");
      expect(output.split("\n")).toHaveLength(4);
    });

    it("/goal set over an enabled goal drops, then creates", async () => {
      seed(goalState());
      await runLine("/goal set y", [
        { data: goalData(null) },
        { data: goalData(goalState({ objective: "y" })) },
      ]);
      expect(goalCommands().map((cmd) => cmd.op)).toEqual(["drop", "create"]);
      expect(goalCommands()[1]).toMatchObject({ objective: "y" });
      expect(commandRows()[0]).toMatchObject({ status: "done", output: "Goal replaced: y" });
    });

    it("/goal set over a paused goal creates only", async () => {
      seed(goalState({ status: "paused" }, false));
      await runLine("/goal set y", [{ data: "Resume or drop the paused goal first.", ok: false }]);
      expect(goalCommands().map((cmd) => cmd.op)).toEqual(["create"]);
      expect(commandRows()[0]?.error).toBe("Resume or drop the paused goal first.");
    });

    it("a replace whose create fails says the old goal is gone", async () => {
      seed(goalState());
      await runLine("/goal set y", [
        { data: goalData(null) },
        { data: "token_budget must be a positive integer when provided", ok: false },
      ]);
      expect(commandRows()[0]?.error).toContain("previous goal was dropped");
      expect(commandRows()[0]?.error).toContain("token_budget must be a positive integer");
    });

    it.each([
      ["pause", goalState(), "Goal paused"],
      ["resume", goalState({ status: "paused" }, false), "Goal resumed"],
      ["drop", goalState(), "Goal dropped"],
      ["pause", null, "no goal to pause"],
      ["drop", null, "no goal to drop"],
    ] as const)("/goal %s settles with its outcome", async (op, before, text) => {
      seed(before);
      await runLine(`/goal ${op}`, [{ data: goalData(null) }]);
      expect(goalCommands()).toEqual([expect.objectContaining({ type: "goal", op })]);
      expect(commandRows()[0]).toMatchObject({ status: "done", output: expect.stringContaining(text) });
    });
  });

  describe("goal frame intake", () => {
    beforeEach(() => seed(null));
    const goal = (): GoalState | null => h.useStore.getState().rpc[h.TAB]?.goal ?? null;

    it("a goal_updated frame patches state, and a dropped one patches null", () => {
      const state = goalState();
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "goal_updated",
        goal: state.goal,
        state: wireState(state),
      });
      expect(goal()).toEqual(state);
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "goal_updated",
        goal: { ...state.goal, status: "dropped" },
      });
      expect(goal()).toBeNull();
    });

    it("a goal_updated frame adds no transcript row", () => {
      const state = goalState();
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "goal_updated", goal: state.goal, state: wireState(state) });
      expect(h.useStore.getState().rpc[h.TAB]?.items).toEqual([]);
    });

    it("a get_state response without the goal key leaves state alone", async () => {
      const state = goalState();
      seed(state);
      const pending = h.useStore.getState().rpcCommand(h.TAB, { type: "get_state" }, { quiet: true });
      h.respond(h.TAB, h.sent.pop()!.cmd, { isStreaming: false });
      await pending;
      expect(goal()).toEqual(state);
    });

    it("a get_state response with the goal key replaces state", async () => {
      const pending = h.useStore.getState().rpcCommand(h.TAB, { type: "get_state" }, { quiet: true });
      const state = goalState({ status: "paused" }, false);
      h.respond(h.TAB, h.sent.pop()!.cmd, { goal: wireState(state) });
      await pending;
      expect(goal()).toEqual(state);
    });

    const freshStore = async (): Promise<{
      fresh: typeof h.useStore;
      onStateChanged: (state: BackendState) => void;
    }> => {
      // A fresh store module per case: init latches once per module evaluation,
      // so the real onStateChanged handler can only be captured this way.
      vi.resetModules();
      const { useStore: fresh } = await import("../../store");
      const init = fresh.getState().init();
      const onStateChanged = h.mockBackend.onStateChanged.mock.calls[0]![0] as (
        state: BackendState,
      ) => void;
      await init;
      return { fresh, onStateChanged };
    };

    it("hydrates a late-joining renderer from the summary alone", async () => {
      const { fresh, onStateChanged } = await freshStore();
      fresh.setState({ rpc: { [h.TAB]: rpcTabState({ goal: null }) } });
      const state = goalState({ objective: "from main" });
      onStateChanged(summaryWithGoal(h.stateWithRecord("sess-1"), state));
      expect(fresh.getState().rpc[h.TAB]?.goal).toEqual(state);
      // A live process reporting no goal clears it.
      onStateChanged(summaryWithGoal(h.stateWithRecord("sess-1"), null));
      expect(fresh.getState().rpc[h.TAB]?.goal).toBeNull();
    });

    it("clears a goal no live process reports anymore", async () => {
      const { fresh, onStateChanged } = await freshStore();
      fresh.setState({ rpc: { [h.TAB]: rpcTabState({ goal: goalState() }) } });
      const base = h.stateWithRecord("sess-1");
      const dormant = {
        ...base,
        projects: [
          {
            ...base.projects[0]!,
            sessions: [{ ...base.projects[0]!.sessions[0]!, tabId: h.TAB, live: "dormant" as const }],
          },
        ],
      };
      onStateChanged(dormant);
      expect(fresh.getState().rpc[h.TAB]?.goal).toBeNull();
    });
  });

  describe("/guided-goal", () => {
    const setTool = vi.fn<UiStore["setSessionToolEnabled"]>();
    const sendPrompt = vi.fn<UiStore["sendPrompt"]>();
    const { setSessionToolEnabled: realSetTool, sendPrompt: realSendPrompt } = h.useStore.getState();
    // The store module outlives each case, so the real actions go back.
    afterEach(() => {
      h.useStore.setState({ setSessionToolEnabled: realSetTool, sendPrompt: realSendPrompt });
    });

    const arm = (result: SetSessionToolEnabledResult): void => {
      setTool.mockReset().mockResolvedValue(result);
      sendPrompt.mockReset().mockResolvedValue(true);
      h.useStore.setState({ setSessionToolEnabled: setTool, sendPrompt });
    };
    const applied = { status: "applied" } as SetSessionToolEnabledResult;

    it("enables the goal tool, then sends the interview prompt", async () => {
      seed(null);
      arm(applied);
      await runLine("/guided-goal speed up startup");
      expect(setTool).toHaveBeenCalledWith(h.TAB, "goal", true);
      expect(sendPrompt).toHaveBeenCalledTimes(1);
      expect(setTool.mock.invocationCallOrder[0]!).toBeLessThan(sendPrompt.mock.invocationCallOrder[0]!);
      const [, message, route] = sendPrompt.mock.calls[0]!;
      expect(message).toContain("speed up startup");
      expect(route).toBe("prompt");
      expect(goalCommands()).toEqual([]);
      expect(commandRows()[0]).toMatchObject({ status: "done", output: expect.stringContaining("interview started") });
    });

    it.each([
      [{ status: "busy" }, "Stop the current turn"],
      [{ status: "unsupported" }, "could not be enabled (unsupported)"],
    ] as const)("sends no prompt when the tool toggle answers %o", async (result, text) => {
      seed(null);
      arm(result as SetSessionToolEnabledResult);
      await runLine("/guided-goal");
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(commandRows()[0]?.error).toContain(text);
    });

    it.each([
      ["vibe", { vibe: { enabled: true } as UiStore["rpc"][string]["vibe"] }],
      ["plan", { plan: { enabled: true } as UiStore["rpc"][string]["plan"] }],
    ] as const)("refuses while %s mode is on", async (mode, patch) => {
      seed(null, patch);
      arm(applied);
      await runLine("/guided-goal");
      expect(setTool).not.toHaveBeenCalled();
      expect(sendPrompt).not.toHaveBeenCalled();
      expect(commandRows()[0]?.error).toContain(mode);
    });

    it("refuses while an unfinished goal owns the session", async () => {
      seed(goalState({ status: "paused" }, false));
      arm(applied);
      await runLine("/guided-goal");
      expect(setTool).not.toHaveBeenCalled();
      expect(commandRows()[0]?.error).toContain("already has a goal (paused)");
    });
  });

  describe("automatic prompts against a goal-owned session", () => {
    const stallFrames = (store: UiStore, T: string): void => {
      store.handleRpcFrame(T, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "half an answer" }],
          stopReason: "error",
          errorMessage: "OpenAI responses stream stalled while waiting for the next event",
          errorId: 397312,
        },
      });
      store.handleRpcFrame(T, { type: "agent_end" });
    };

    const continuePrompts = (): Array<{ cmd: Record<string, unknown> }> =>
      h.sent.filter((entry) => entry.cmd.type === "prompt" && entry.cmd.message === STALL_CONTINUE_LEAD);

    const runStall = async (goal: GoalState | null): Promise<void> => {
      const T = "tab-goal-stall-" + (goal?.goal.status ?? "none");
      vi.useFakeTimers();
      try {
        h.useStore.setState({
          state: { ...h.backendState, stallAutoContinue: true },
          rpc: { [T]: rpcTabState({ status: "running", goal }) },
        });
        h.sent.length = 0;
        stallFrames(h.useStore.getState(), T);
        await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      } finally {
        vi.useRealTimers();
      }
      await h.flushMicrotasks();
    };

    it("sends no stall continue while a paused goal owns the session", async () => {
      await runStall(goalState({ status: "paused" }, false));
      expect(continuePrompts()).toHaveLength(0);
    });

    it("sends no continue that would restart a budget-limited goal", async () => {
      await runStall(goalState({ status: "budget-limited", tokenBudget: 10, tokensUsed: 40 }));
      expect(continuePrompts()).toHaveLength(0);
    });

    it("restores ordinary stall policy once the goal is complete", async () => {
      await runStall(goalState({ status: "complete" }, false));
      expect(continuePrompts()).toHaveLength(1);
    });
  });
});

/** A backend state whose one session reports `goal`, for hydration cases. */
function summaryWithGoal(base: BackendState, goal: GoalState | null): BackendState {
  return {
    ...base,
    projects: [
      {
        ...base.projects[0]!,
        sessions: [{ ...base.projects[0]!.sessions[0]!, tabId: h.TAB, goal }],
      },
    ],
  };
}
