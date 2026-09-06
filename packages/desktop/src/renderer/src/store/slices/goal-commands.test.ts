// The goal command family in a native tab (issue #381): what the composer
// dispatches, how a snapshot's correlated result settles the row it belongs to,
// and what automatic prompts may not do while the child owns the session.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import { STALL_CONTINUE_LEAD, STALL_CONTINUE_SETTLE_MS } from "../../lib/stall-continue";
import { GOAL_COMMAND, GOAL_STATUS_KEY, type GoalSnapshot } from "@omp-ui/core/goal";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";
import type { UiStore } from "../types";

function goalSnapshot(overrides: Partial<GoalSnapshot> = {}): GoalSnapshot {
  return {
    version: 1,
    processKey: "proc-1",
    sessionId: "sess-1",
    revision: 1,
    available: true,
    unavailable: null,
    enabled: true,
    goal: {
      id: "g1",
      objective: "finish the migration",
      status: "active",
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 12,
      createdAt: 1,
      updatedAt: 2,
    },
    continuation: "idle",
    pauseReason: null,
    result: null,
    ...overrides,
  };
}

function publish(tabId: string, snapshot: GoalSnapshot | string): void {
  h.useStore.getState().handleRpcFrame(tabId, {
    type: "extension_ui_request",
    id: "frame-" + Math.random().toString(36).slice(2),
    method: "setStatus",
    statusKey: GOAL_STATUS_KEY,
    statusText: typeof snapshot === "string" ? snapshot : JSON.stringify(snapshot),
  });
}

/**
 * The hidden prompt frames this tab was asked to send, including the ones
 * `runLine` already answered: a dispatched line leaves the tab exactly once.
 */
function goalPrompts(): string[] {
  return allPrompts().filter((message) => message.startsWith(`/${GOAL_COMMAND} command `));
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

/**
 * Runs a slash line and answers every rpc call it makes. `runSlashCommand`
 * resolves only when the prompt's response lands, so a test that asserts on what
 * left the tab must answer before it awaits.
 */
async function runLine(
  tabId: string,
  line: string,
  reply: unknown = { agentInvoked: false },
  success = true,
): Promise<void> {
  const promise = h.useStore.getState().runSlashCommand(tabId, line);
  // Answered in place, never drained: the frames a line produced are the
  // evidence the assertion reads.
  for (const { tabId: sentTab, cmd } of [...h.sent]) h.respond(sentTab, cmd, reply, success);
  await promise;
}

describe("native goal commands (issue #381)", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.sent.length = 0;
  });

  describe("the composer's slash interception", () => {
    beforeEach(() => {
      h.useStore.setState({
        state: h.backendState,
        tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
        rpc: { [h.TAB]: rpcTabState({ goal: goalSnapshot() }) },
      });
    });

    it("dispatches /goal as the hidden bridge command, never as prose", async () => {
      await runLine(h.TAB, "/goal pause");
      const decoded = JSON.parse(
        goalPrompts().at(-1)!.slice(`/${GOAL_COMMAND} command `.length),
      ) as { command: string; args: string; sessionId: string; processKey: string };
      expect(decoded).toMatchObject({
        command: "goal",
        args: "pause",
        sessionId: "sess-1",
        processKey: "proc-1",
      });
      // Nothing else went to the model: no plain prompt carries the user's line.
      expect(allPrompts().filter((m) => m === "/goal pause")).toEqual([]);
    });

    it("keeps the guided-goal family on the same path with its own command name", async () => {
      await runLine(h.TAB, "/guided-goal speed up startup");
      const decoded = JSON.parse(
        goalPrompts().at(-1)!.slice(`/${GOAL_COMMAND} command `.length),
      ) as {
        command: string;
        args: string;
      };
      expect(decoded).toMatchObject({ command: "guided-goal", args: "speed up startup" });
    });

    it("leaves a terminal tab's goal line to omp's own TUI", async () => {
      h.useStore.setState({ tabs: [tabInfo({ tabId: h.TAB, mode: "pty" })] });
      await runLine(h.TAB, "/goal show");
      expect(goalPrompts()).toEqual([]);
      expect(allPrompts()).toContain("/goal show");
    });

    it("does not intercept a command that merely starts with the word goal", async () => {
      await runLine(h.TAB, "/goalkeeper status");
      expect(goalPrompts()).toEqual([]);
      expect(allPrompts()).toContain("/goalkeeper status");
    });

    it("answers with the bridge's reason and sends nothing when it is unavailable", async () => {
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            goal: goalSnapshot({
              available: false,
              unavailable: "goalRuntime is missing: createGoal",
              enabled: false,
              goal: null,
            }),
          }),
        },
      });
      await h.useStore.getState().runSlashCommand(h.TAB, "/goal ship it");
      expect(goalPrompts()).toEqual([]);
      const [row] = commandRows();
      expect(row?.status).toBe("failed");
      expect(row?.error ?? row?.output).toContain("goalRuntime is missing: createGoal");
    });

    it("says what an old live process needs when no bridge ever reported", async () => {
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ goal: null }) } });
      await h.useStore.getState().runSlashCommand(h.TAB, "/goal");
      expect(goalPrompts()).toEqual([]);
      const [row] = commandRows();
      expect(row?.status).toBe("failed");
      expect(row?.error ?? row?.output).toContain("restarting this live session");
    });

    it("keeps an over-budget line out of the wire entirely", async () => {
      await h.useStore
        .getState()
        .runSlashCommand(h.TAB, "/goal " + "x".repeat(20_000));
      expect(goalPrompts()).toEqual([]);
      expect(commandRows()[0]?.status).toBe("failed");
    });
  });

  describe("command rows and correlated results", () => {
    /** Starts the line without answering; the case settles it in its own order. */
    const start = (line: string): Promise<void> => {
      h.useStore.setState({
        state: h.backendState,
        tabs: [tabInfo({ tabId: h.TAB, mode: "rpc-ui" })],
        rpc: { [h.TAB]: rpcTabState({ goal: goalSnapshot() }) },
      });
      h.sent.length = 0;
      return h.useStore.getState().runSlashCommand(h.TAB, line);
    };

    const promptFrame = (): Record<string, unknown> => h.sent.at(-1)!.cmd;

    it("settles the row from the snapshot result when the result arrives first", async () => {
      const promise = start("/goal show");
      publish(
        h.TAB,
        goalSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(promptFrame()), ok: true, text: "Status: active" },
        }),
      );
      expect(commandRows()[0]).toMatchObject({ name: "goal", args: "show", status: "done" });
      expect(commandRows()[0]?.output).toBe("Status: active");
      h.respond(h.TAB, promptFrame(), { agentInvoked: false });
      await promise;
      // A settled row is never re-decided by the acknowledgement that follows.
      expect(commandRows()[0]?.output).toBe("Status: active");
    });

    it("settles the row when the acknowledgement arrives first", async () => {
      const promise = start("/goal drop");
      const frame = promptFrame();
      h.respond(h.TAB, frame, { agentInvoked: false });
      await promise;
      // The acknowledgement alone must not claim an outcome the bridge has not
      // reported: the row waits for its result.
      expect(commandRows()[0]?.status).toBe("running");
      publish(
        h.TAB,
        goalSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(frame), ok: true, text: "Goal dropped." },
        }),
      );
      expect(commandRows()[0]?.status).toBe("done");
    });

    it("settles a lost rpc call as failed and drops the correlation", async () => {
      const promise = start("/goal pause");
      const frame = promptFrame();
      h.respond(h.TAB, frame, "child gone", false);
      await promise;
      expect(commandRows()[0]?.status).toBe("failed");
      // A late result for the abandoned request finds no row to settle.
      publish(
        h.TAB,
        goalSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(frame), ok: true, text: "too late" },
        }),
      );
      expect(commandRows()[0]?.output).not.toBe("too late");
    });

    it("never lets another client's retained result settle this tab's row", async () => {
      const promise = start("/goal budget 5000");
      publish(
        h.TAB,
        goalSnapshot({
          revision: 2,
          result: { requestId: "someone-elses-request", ok: true, text: "answered elsewhere" },
        }),
      );
      expect(commandRows()[0]?.status).toBe("running");
      h.respond(h.TAB, promptFrame(), { agentInvoked: false });
      await promise;
    });

    it("drops pending correlations when the process is torn down", async () => {
      const promise = start("/goal pause");
      const frame = promptFrame();
      // The renderer's real process-death signal.
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "omp_ui_error", message: "child died" });
      await promise;
      expect(commandRows()[0]?.status).toBe("failed");
      publish(
        h.TAB,
        goalSnapshot({
          revision: 2,
          result: { requestId: requestIdOf(frame), ok: true, text: "late" },
        }),
      );
      expect(commandRows()[0]?.output).not.toBe("late");
    });
  });

  describe("snapshot acceptance", () => {
    beforeEach(() => {
      h.useStore.setState({
        state: h.backendState,
        rpc: { [h.TAB]: rpcTabState({ goal: goalSnapshot({ revision: 5 }) }) },
      });
    });

    it("rejects an older revision from the same bridge", () => {
      publish(h.TAB, goalSnapshot({ revision: 4, goal: null, enabled: false }));
      expect(h.useStore.getState().rpc[h.TAB]?.goal?.revision).toBe(5);
      expect(h.useStore.getState().rpc[h.TAB]?.goal?.goal?.objective).toBe("finish the migration");
    });

    it("accepts a replacement bridge's first revision", () => {
      publish(h.TAB, goalSnapshot({ processKey: "proc-2", revision: 1, continuation: "scheduled" }));
      const goal = h.useStore.getState().rpc[h.TAB]?.goal;
      expect(goal?.processKey).toBe("proc-2");
      expect(goal?.continuation).toBe("scheduled");
    });

    it("keeps the last real goal when a publish is malformed", () => {
      publish(h.TAB, "{ not json");
      expect(h.useStore.getState().rpc[h.TAB]?.goal?.revision).toBe(5);
    });

    it("hydrates a late-joining renderer from the summary alone", async () => {
      // A fresh store module per case: init latches once per module evaluation,
      // so the real onStateChanged handler can only be captured this way.
      vi.resetModules();
      const { useStore: fresh } = await import("../../store");
      const init = fresh.getState().init();
      const onStateChanged = h.mockBackend.onStateChanged.mock.calls[0]![0] as (
        state: BackendState,
      ) => void;
      await init;
      fresh.setState({ rpc: { [h.TAB]: rpcTabState({ goal: goalSnapshot({ revision: 9 }) }) } });
      const base = h.stateWithRecord("sess-1");

      // Older than what the tab already holds: the summary cannot roll it back.
      onStateChanged(summaryWithGoal(base, goalSnapshot({ revision: 3, goal: null, enabled: false })));
      expect(fresh.getState().rpc[h.TAB]?.goal?.revision).toBe(9);

      // A newer process's report wins outright.
      onStateChanged(summaryWithGoal(base, goalSnapshot({ processKey: "proc-9", revision: 1 })));
      expect(fresh.getState().rpc[h.TAB]?.goal?.processKey).toBe("proc-9");
    });

    it("claims the goal channel ahead of the generic extension status", () => {
      publish(h.TAB, goalSnapshot({ revision: 6 }));
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.goal?.revision).toBe(6);
      // The HUD's status chips render unclaimed extension status; a goal publish
      // is state, so it must never surface there as a chip.
      expect(Object.keys(tab.extensionStatus ?? {})).not.toContain("omp-ui:goal");
    });

    it("clears a goal no live process reports anymore", async () => {
      vi.resetModules();
      const { useStore: fresh } = await import("../../store");
      const init = fresh.getState().init();
      const onStateChanged = h.mockBackend.onStateChanged.mock.calls[0]![0] as (
        state: BackendState,
      ) => void;
      await init;
      fresh.setState({ rpc: { [h.TAB]: rpcTabState({ goal: goalSnapshot() }) } });
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

    const runStall = async (goal: GoalSnapshot | null): Promise<void> => {
      const T = "tab-goal-stall-" + (goal?.pauseReason ?? "none");
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
      await runStall(
        goalSnapshot({ enabled: false, goal: { ...goalSnapshot().goal!, status: "paused" }, pauseReason: "Paused" }),
      );
      expect(continuePrompts()).toHaveLength(0);
    });

    it("sends no continue that would restart a budget-limited goal", async () => {
      await runStall(
        goalSnapshot({
          goal: { ...goalSnapshot().goal!, status: "budget-limited", tokenBudget: 10, tokensUsed: 40 },
        }),
      );
      expect(continuePrompts()).toHaveLength(0);
    });

    it("restores ordinary stall policy once the goal is complete", async () => {
      await runStall(
        goalSnapshot({ enabled: false, goal: { ...goalSnapshot().goal!, status: "complete" } }),
      );
      expect(continuePrompts()).toHaveLength(1);
    });
  });
});

/** The requestId the dispatcher minted into one hidden prompt frame. */
function requestIdOf(cmd: Record<string, unknown>): string {
  const message = String(cmd.message ?? "");
  const json = message.slice(message.indexOf("command ") + "command ".length);
  return (JSON.parse(json) as { requestId: string }).requestId;
}

/** A backend state whose one session reports `goal`, for hydration cases. */
function summaryWithGoal(base: BackendState, goal: GoalSnapshot): BackendState {
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
