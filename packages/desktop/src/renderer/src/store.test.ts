import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateState,
  BackendState,
  LiveState,
  OmpSettingsSnapshot,
  OmpUpdateState,
  RemoteState,
} from "@omp-ui/core/types";
import { emptySessionRuntime } from "./lib/rpc-types";
import { generateTitleFromPrompt } from "./lib/session-title";
import { PLAN_STATUS_KEY } from "@omp-ui/core/plan";
import { MCP_RUNTIME_STATUS_KEY } from "@omp-ui/core/mcp-status";
import { commandItem, type NoticeItem } from "./lib/transcript";
import {
  ADVISOR_REPLY_CAP_NOTICE,
  ADVISOR_REPLY_LEAD,
  ADVISOR_REPLY_SETTLE_MS,
} from "./lib/advisor-reply";
import {
  STALL_CONTINUE_CAP_NOTICE,
  STALL_CONTINUE_LEAD,
  STALL_CONTINUE_SETTLE_MS,
} from "./lib/stall-continue";
import {
  backendState as makeBackendState,
  rpcTabState,
  tabInfo,
} from "./test/fixtures";
import { h } from "./test/store-harness";


describe("deriveSidebarSessionState", () => {
  const summary = () => h.stateWithRecord(null).projects[0]!.sessions[0]!;

  it("derives every lifecycle and native RPC activity state from authoritative inputs", () => {
    for (const live of ["dormant", "archived", "missing"] as const) {
      expect(
        h.deriveSidebarSessionState(
          { ...summary(), live },
          rpcTabState(),
          undefined,
        ),
      ).toBe(live);
    }

    expect(
      h.deriveSidebarSessionState(
        { ...summary(), mode: "pty" },
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("live");
    expect(h.deriveSidebarSessionState(summary(), undefined, undefined)).toBe(
      "live",
    );
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "running" }),
        0,
      ),
    ).toBe("dormant");

    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "starting" }),
        undefined,
      ),
    ).toBe("starting");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("working");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("ready");

    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({
          status: "running",
          planReview: {
            request: {
              title: "review",
              planFilePath: "local://p.md",
              planAbsPath: null,
            },
            frame: { id: "p" },
          },
        }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "error", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("error");
    // Issue #248: a watchdog-aborted turn badges the row stalled, outranking
    // an awaiting answer — the user must prompt to continue either way.
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      h.deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready", busy: true }),
        undefined,
      ),
    ).toBe("ready");
    expect(
      h.deriveSidebarSessionState(
        summary(),
        rpcTabState({
          status: "ready",
          session: { ...emptySessionRuntime(), isStreaming: true },
        }),
        undefined,
      ),
    ).toBe("ready");
  });

  it("tracks queued answers in FIFO order through a complete agent turn", () => {
    const current = () =>
      h.deriveSidebarSessionState(
        summary(),
        h.useStore.getState().rpc[h.TAB],
        undefined,
      );
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    expect(current()).toBe("ready");

    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    expect(current()).toBe("working");
    for (const id of ["q1", "q2"]) {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: `confirm ${id}`,
      });
    }
    expect(current()).toBe("awaiting-answer");

    let request = h.useStore.getState().rpc[h.TAB]!.extensionQueue[0];
    h.useStore.getState().answerExtension(h.TAB, request, { confirmed: true });
    expect(current()).toBe("awaiting-answer");
    request = h.useStore.getState().rpc[h.TAB]!.extensionQueue[0];
    h.useStore.getState().answerExtension(h.TAB, request, { confirmed: true });
    expect(current()).toBe("working");

    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("tracks a plan-review gate until refinePlan answers it", () => {
    const current = () =>
      h.deriveSidebarSessionState(
        summary(),
        h.useStore.getState().rpc[h.TAB],
        undefined,
      );
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "plan-1",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "p", planFilePath: "local://p.md" }),
    });
    expect(current()).toBe("awaiting-answer");

    h.useStore.getState().refinePlan(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toBeNull();
    expect(current()).toBe("working");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("does not mistake non-dialog extension traffic for a pending answer", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "done",
    });
    expect(
      h.deriveSidebarSessionState(
        summary(),
        h.useStore.getState().rpc[h.TAB],
        undefined,
      ),
    ).toBe("ready");
  });
});

describe("native RPC relaunch preparation", () => {
  const staleRpc = () =>
    rpcTabState({
      status: "running",
      items: [{ kind: "marker", id: "kept", label: "kept", tone: "neutral" }],
      session: { ...emptySessionRuntime(), isStreaming: true },
      plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
      extensionQueue: [{ id: "question" }],
      planReview: {
        request: {
          title: "review",
          planFilePath: "local://p.md",
          planAbsPath: null,
        },
        frame: { id: "plan" },
      },
      planText: "# stale plan",
      planHtml: "<h1>stale plan</h1>",
      failure: {
        message: "stale failure",
        kind: "command",
        fatal: false,
        recovery: "refresh state",
      },
    });

  const expectPrepared = () => {
    const rpc = h.useStore.getState().rpc[h.TAB]!;
    expect(rpc.status).toBe("starting");
    expect(rpc.plan).toBeNull();
    expect(rpc.session.isStreaming).toBe(false);
    expect(rpc.extensionQueue).toEqual([]);
    expect(rpc.planReview).toBeNull();
    expect(rpc.planText).toBeNull();
    expect(rpc.planHtml).toBeNull();
    expect(rpc.failure).toBeUndefined();
    expect(rpc.items).toEqual([expect.objectContaining({ id: "kept" })]);
  };

  it("prepares an exited native tab before its resume promise settles", async () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    const spawn = h.deferred<{ tabId: string }>();
    h.mockBackend.spawnSession.mockReturnValueOnce(spawn.promise);
    h.useStore.setState({
      state: h.backendState,
      exited: { [h.TAB]: 0 },
      rpc: { [h.TAB]: staleRpc() },
    });

    const resume = h.useStore.getState().resumeDead(h.TAB);
    expectPrepared();
    expect(h.useStore.getState().exited[h.TAB]).toBe(0);
    spawn.resolve({ tabId: h.TAB });
    await resume;
    expect(h.useStore.getState().exited[h.TAB]).toBeUndefined();
  });

  it("prepares a live mode switch involving native RPC before IPC settles", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    const switched = h.deferred<void>();
    h.mockBackend.switchMode.mockReturnValueOnce(switched.promise);
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: staleRpc() } });

    const change = h.useStore.getState().switchMode(h.TAB, "pty");
    expectPrepared();
    switched.resolve(undefined);
    await change;
  });

  it("prepares a changed live native advisor tuple before IPC settles", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    const changed = h.deferred<void>();
    h.mockBackend.setSessionAdvisor.mockReturnValueOnce(changed.promise);
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: staleRpc() } });

    const update = h.useStore
      .getState()
      .setSessionAdvisor(h.TAB, true, "openrouter/a/b:high");
    expectPrepared();
    changed.resolve(undefined);
    await update;
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
      true,
    );
  });

  it("drains a pending thinking change through persistence before relaunch", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "qwen", name: "Qwen", provider: "openrouter" },
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        }),
      },
    });

    const level = h.useStore.getState().setThinkingLevel(h.TAB, "medium");
    const command = h.sent.find((entry) => entry.cmd.type === "set_thinking_level")!;
    const relaunch = h.useStore
      .getState()
      .setSessionAdvisor(h.TAB, true, "openrouter/openai/gpt-5.6-sol:low");
    expect(h.mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("starting");

    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        [h.TAB]: {
          ...state.rpc[h.TAB]!,
          plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    h.respond(h.TAB, command.cmd, {});
    await Promise.all([level, relaunch]);

    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "openrouter/qwen",
      "medium",
    );
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/openai/gpt-5.6-sol:low",
      true,
    );
    expect(h.mockBackend.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      h.mockBackend.setSessionAdvisor.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves known Build posture when no newer status arrives", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        }),
      },
    });

    await h.useStore.getState().setSessionAdvisor(h.TAB, true, "openrouter/a/b:high");

    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
  });

  it("restores prior mode when an unsettled command cancels advisor relaunch", async () => {
    vi.useFakeTimers();
    try {
      h.backendState = h.stateWithRecord("sess-1");
      const priorPlan = {
        enabled: true,
        planFilePath: "local://plan.md",
        planAbsPath: "/plan.md",
        approved: false,
      };
      const rpc = staleRpc();
      rpc.plan = priorPlan;
      rpc.pendingCommands.set("blocked", {
        resolve: vi.fn(),
        reject: vi.fn(),
        timer: 0,
        quiet: false,
        command: "prompt",
        startedAt: Date.now(),
        timeoutMs: 60_000,
      });
      h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpc } });

      const relaunch = h.useStore.getState().setSessionAdvisor(h.TAB, true, "openrouter/a/b:high");
      expectPrepared();
      await vi.advanceTimersByTimeAsync(31_000);
      await relaunch;

      expect(h.useStore.getState().rpc[h.TAB]!.plan).toEqual(priorPlan);
      expect(h.mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks user-facing process commands while a relaunch is starting", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: { [h.TAB]: rpcTabState({ status: "starting" }) },
    });

    await Promise.all([
      h.useStore.getState().sendPrompt(h.TAB, "prompt"),
      h.useStore.getState().abortAndPrompt(h.TAB, "replace"),
      h.useStore.getState().setModel(h.TAB, { id: "m", name: "M", provider: "p" }),
      h.useStore.getState().setThinkingLevel(h.TAB, "medium"),
      h.useStore.getState().setPlanMode(h.TAB, true),
      h.useStore.getState().setSessionAdvisor(h.TAB, true, "p/a:low"),
    ]);

    expect(h.sent).toEqual([]);
    expect(h.mockBackend.setSessionModel).not.toHaveBeenCalled();
    expect(h.mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
  });

  it("leaves RPC state alone for an unchanged advisor tuple and a PTY resume", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: staleRpc() } });
    await h.useStore.getState().setSessionAdvisor(h.TAB, false, null);
    expect(h.useStore.getState().rpc[h.TAB]).toEqual(staleRpc());

    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.backendState.projects[0]!.sessions[0]!.mode = "pty";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    h.useStore.setState({
      state: h.backendState,
      exited: { [h.TAB]: 1 },
      rpc: { [h.TAB]: staleRpc() },
    });
    await h.useStore.getState().resumeDead(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]).toEqual(staleRpc());
  });
});

describe("bootRpcTab", () => {
  it("unwraps data payloads for state, models, commands, stats, and history", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({ state: h.backendState });
    const commands = await h.driveBoot(h.TAB, {
      get_state: {
        data: {
          todoPhases: [
            { phase: "P", tasks: [{ content: "do it", status: "pending" }] },
          ],
          model: { id: "m1", name: "M One", provider: "p" },
          thinkingLevel: "high",
          messageCount: 4,
          contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
        },
      },
      get_available_models: {
        data: { models: [{ id: "m1", name: "M One", provider: "p" }] },
      },
      get_available_commands: {
        data: {
          commands: [
            { name: "stats", description: "session stats", source: "builtin" },
          ],
        },
      },
      get_session_stats: {
        data: {
          userMessages: 2,
          assistantMessages: 3,
          tokens: { input: 10, output: 20, total: 30 },
          cost: 0.5,
        },
      },
      get_messages: {
        data: {
          messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
        },
      },
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.status).toBe("ready");
    expect(tab.todos).toEqual([
      { phase: "P", tasks: [{ content: "do it", status: "pending" }] },
    ]);
    expect(tab.model).toMatchObject({ id: "m1", name: "M One", provider: "p" });
    expect(tab.availableModels).toHaveLength(1);
    expect(tab.commands).toEqual([
      { name: "stats", description: "session stats", source: "builtin" },
    ]);
    expect(tab.stats).toMatchObject({ userMessages: 2, cost: 0.5 });
    expect(tab.stats?.tokens).toEqual({
      input: 10,
      output: 20,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 30,
    });
    expect(tab.session).toMatchObject({
      thinkingLevel: "high",
      messageCount: 4,
      contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
    });
    expect(tab.items).toEqual([
      expect.objectContaining({ kind: "user", text: "hi" }),
    ]);
    expect(commands).toContain("set_subagent_subscription");
  });

  it("subscribes to subagent progress and never wedges boot on a failed extra", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({ state: h.backendState });
    const levels: unknown[] = [];
    const boot = h.useStore.getState().bootRpcTab(h.TAB);
    for (let wave = 0; wave < 3; wave++) {
      await h.flushMicrotasks();
      for (const { cmd } of h.sent.splice(0)) {
        if (cmd.type === "set_subagent_subscription") levels.push(cmd.level);
        // Every optional boot command fails; only get_state decides readiness.
        const ok = cmd.type === "get_state";
        h.respond(h.TAB, cmd, ok ? {} : "unavailable", ok);
      }
    }
    await boot;
    expect(levels).toEqual(["progress"]);
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
  });

  it("fetches backend state when store state is null, then loads history", async () => {
    // Regression: boot outrunning init()'s first getState must not skip
    // get_messages — the record decides, so state is pulled from the backend.
    h.backendState = h.stateWithRecord("sess-2");
    const commands = await h.driveBoot(h.TAB, {
      get_messages: { data: { messages: [] } },
    });
    expect(h.mockBackend.getState).toHaveBeenCalled();
    expect(commands).toContain("get_messages");
  });

  it("does not request history for a never-materialized session", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({ state: h.backendState });
    const commands = await h.driveBoot(h.TAB);
    expect(commands).not.toContain("get_messages");
  });

  it("arms the advisor-stats extension even when the record's advisor flag is false", async () => {
    // A stale/false record (race with the broadcast after an advisor-toggle
    // relaunch) must not skip the arm: the runtime readout depends on it.
    // driveBoot drains `sent` wave-by-wave, so the fire-and-forget arm (pushed
    // after Promise.allSettled) must be captured during the drain, not after.
    h.backendState = h.stateWithRecord(null); // records built with advisor:false
    h.useStore.setState({ state: h.backendState });
    const boot = h.useStore.getState().bootRpcTab(h.TAB);
    const arms: unknown[] = [];
    for (let wave = 0; wave < 5; wave++) {
      await h.flushMicrotasks();
      for (const { cmd } of h.sent.splice(0)) {
        if (cmd.type === "prompt" && cmd.message === "/omp-ui-advisor-stats")
          arms.push(cmd);
        h.respond(h.TAB, cmd, {});
      }
    }
    await boot;
    for (const { cmd } of h.sent.splice(0)) {
      if (cmd.type === "prompt" && cmd.message === "/omp-ui-advisor-stats")
        arms.push(cmd);
      h.respond(h.TAB, cmd, {});
    }
    expect(arms).toHaveLength(1);
  });

  it("reports error, not ready, when get_state fails", async () => {
    h.backendState = h.stateWithRecord("s");
    h.useStore.setState({ state: h.backendState });
    await h.driveBoot(h.TAB, {
      get_state: { success: false, data: "process dead" },
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.failure).toMatchObject({
      message: expect.stringMatching(/process dead/),
      kind: "boot",
      fatal: true,
      command: "get_state",
      sessionStatus: "error",
      liveState: "live",
    });
  });

  it("clears the prior failure after a successful boot retry", async () => {
    h.backendState = h.stateWithRecord("s");
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          status: "error",
          failure: {
            message: "old boot failure",
            kind: "boot",
            fatal: true,
            recovery: "Retry boot.",
          },
        }),
      },
    });

    await h.driveBoot(h.TAB);

    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
  });

  it("seeds advisorReply from the persisted advisorAutoReply setting (issue #111)", async () => {
    h.backendState = { ...h.stateWithRecord(null), advisorAutoReply: false };
    h.useStore.setState({ state: h.backendState });
    await h.driveBoot(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.advisorReply).toBe(false);
  });

  it("sweeps advisorReply across open tabs when the setting flips (issue #111)", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({
      state: h.backendState,
      rpc: { [h.TAB]: rpcTabState({ advisorReply: true }) },
    });
    h.useStore.setState({ state: { ...h.backendState, advisorAutoReply: false } });
    expect(h.useStore.getState().rpc[h.TAB]!.advisorReply).toBe(false);
    h.useStore.setState({ state: { ...h.backendState, advisorAutoReply: true } });
    expect(h.useStore.getState().rpc[h.TAB]!.advisorReply).toBe(true);
  });
});

describe("rpcCommand / handleRpcFrame correlation", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  it("resolves a command by matching response id", async () => {
    const promise = h.useStore.getState().rpcCommand(h.TAB, { type: "get_state" });
    const cmd = h.sent.pop()!.cmd;
    h.respond(h.TAB, cmd, { ok: 1 });
    await expect(promise).resolves.toMatchObject({
      command: "get_state",
      data: { ok: 1 },
    });
  });

  it("rejects with the server error on success:false", async () => {
    const promise = h.useStore.getState().rpcCommand(h.TAB, { type: "set_model" });
    const cmd = h.sent.pop()!.cmd;
    h.respond(h.TAB, cmd, "unknown model", false);
    await expect(promise).rejects.toThrow("unknown model");
  });

  it("rejects a typed timeout and warns once with a safe diagnostic snapshot", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.backendState = h.stateWithRecord("s");
      h.useStore.setState({
        state: h.backendState,
        rpc: {
          [h.TAB]: rpcTabState({
            status: "running",
            session: { ...emptySessionRuntime(), isStreaming: true },
          }),
        },
      });
      const promise = h.useStore
        .getState()
        .rpcCommand(h.TAB, { type: "prompt", message: "private" });
      const cmd = h.sent.pop()!.cmd;
      const pending = h.useStore
        .getState()
        .rpc[h.TAB]!.pendingCommands.get(String(cmd.id));
      expect(pending).toMatchObject({
        command: "prompt",
        startedAt: expect.any(Number),
        timeoutMs: 30_000,
        quiet: false,
      });
      const typed = expect(promise).rejects.toBeInstanceOf(
        h.RpcCommandTimeoutError,
      );
      const fields = expect(promise).rejects.toMatchObject({
        name: "RpcCommandTimeoutError",
        command: "prompt",
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([typed, fields]);

      expect(h.useStore.getState().rpc[h.TAB]!.pendingCommands.size).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("[rpc] command timeout", {
        tabId: h.TAB,
        commandId: cmd.id,
        command: "prompt",
        timeoutMs: 30_000,
        elapsedMs: 30_000,
        pendingCommandCount: 0,
        pending: [],
        sessionStatus: "running",
        isStreaming: true,
        liveState: "live",
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a fresh ready frame re-boots the tab", async () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "ready", maxFrameBytes: 1048576 });
    await h.flushMicrotasks();
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // Let the re-boot finish: an in-flight boot blocks a later
    // bootRpcTab on the same tab via the module-level rpcBooting set.
    for (let wave = 0; wave < 4; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    }
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
  });

  it("boots an early ready frame before its renderer runtime exists", async () => {
    const earlyTab = "early-ready-tab";
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({ state: h.backendState, rpc: {} });

    h.useStore
      .getState()
      .handleRpcFrame(earlyTab, { type: "ready", maxFrameBytes: 1048576 });
    await h.flushMicrotasks();

    expect(h.useStore.getState().rpc[earlyTab]).toBeDefined();
    expect(
      h.sent.some(
        (entry) => entry.tabId === earlyTab && entry.cmd.type === "get_state",
      ),
    ).toBe(true);
  });
});

describe("handleRpcFrame routing", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  it("omp_ui_error records a fatal process failure", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, {
        type: "omp_ui_error",
        message: "handshake failed",
      });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.failure).toMatchObject({
      message: "handshake failed",
      kind: "process",
      fatal: true,
      sessionStatus: "error",
      recovery: expect.stringMatching(/Resume the session/),
    });
  });

  it("a successful loud command cannot clear a fatal process failure", async () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "omp_ui_error", message: "process gone" });
    const fatal = h.useStore.getState().rpc[h.TAB]!.failure;
    const command = h.useStore.getState().setThinkingLevel(h.TAB, "high");
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await command;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBe(fatal);
  });

  it("agent_end refreshes get_state and get_session_stats", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // get_session_stats carries the HUD cost/token totals; without this the
    // boot-time snapshot (a fresh session reads $0) lingers forever.
    expect(h.sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("agent_start flips status to running; prompt_result back to ready", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("running");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "prompt_result" });
    expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
  });

  it("refreshes get_state and get_session_stats live on message_end while the agent runs", () => {
    h.useStore.setState({
      rpc: { [`${h.TAB}-live`]: rpcTabState({ status: "running" }) },
    });
    h.useStore.getState().handleRpcFrame(`${h.TAB}-live`, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first turn" }],
      },
    });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // Spend lives on get_session_stats — without this tick the HUD cost
    // counter freezes for the whole run and only moves at agent_end.
    expect(h.sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("throttles a burst of message_ends to one live usage snapshot", () => {
    h.useStore.setState({
      rpc: { [`${h.TAB}-burst`]: rpcTabState({ status: "running" }) },
    });
    const end = (text: string) =>
      h.useStore.getState().handleRpcFrame(`${h.TAB}-burst`, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    end("a");
    end("b");
    end("c");
    expect(h.sent.filter((s) => s.cmd.type === "get_state")).toHaveLength(1);
    expect(h.sent.filter((s) => s.cmd.type === "get_session_stats")).toHaveLength(
      1,
    );
  });

  it("does not refresh get_state on message_end while idle", () => {
    h.useStore.setState({
      rpc: { [`${h.TAB}-idle`]: rpcTabState({ status: "ready" }) },
    });
    h.useStore.getState().handleRpcFrame(`${h.TAB}-idle`, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(false);
  });

  describe("queue settle re-fetch (issue #181)", () => {
    const getStateCalls = () =>
      h.sent.filter((s) => s.cmd.type === "get_state");

    /** Fires agent_end mid-run and answers the immediate get_state refresh. */
    const endTurnWithCount = async (key: string, count: number) => {
      h.useStore.getState().handleRpcFrame(key, { type: "agent_end" });
      h.respond(key, getStateCalls().at(-1)!.cmd, {
        queuedMessageCount: count,
      });
      await h.flushMicrotasks();
    };

    it("re-fetches once when a turn ends with a nonzero queue count", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-once`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 1);
        expect(getStateCalls()).toHaveLength(1);
        expect(h.useStore.getState().rpc[key]!.session.queuedMessageCount).toBe(
          1,
        );
        // omp-side settle work (advice reclaim, deferred flush) can land just
        // after agent_end — one delayed re-fetch catches it.
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(2);
        // The re-fetch settles the count; no further polling once it clears.
        h.respond(key, getStateCalls().at(-1)!.cmd, { queuedMessageCount: 0 });
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS * 4);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not re-fetch when the turn ends with an empty queue", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-empty`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 0);
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS * 2);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the settle timer when a new turn starts", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-cancel`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 1);
        h.useStore.getState().handleRpcFrame(key, { type: "agent_start" });
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS * 2);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-fetches when the agent_end get_state itself fails", async () => {
      vi.useFakeTimers();
      try {
        const key = `${h.TAB}-settle-fail`;
        h.useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        // Seed a nonzero last-known count through one clean cycle.
        await endTurnWithCount(key, 1);
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS);
        await h.flushMicrotasks();
        h.respond(key, getStateCalls().at(-1)!.cmd, { queuedMessageCount: 1 });
        await h.flushMicrotasks();
        // The next turn's closing refresh is lost: the settle timer is the
        // one retry, or the stale count would freeze in the composer.
        h.useStore.getState().handleRpcFrame(key, { type: "agent_start" });
        h.useStore.getState().handleRpcFrame(key, { type: "agent_end" });
        h.respond(key, getStateCalls().at(-1)!.cmd, "unavailable", false);
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.QUEUE_SETTLE_REFRESH_MS);
        await h.flushMicrotasks();
        expect(getStateCalls()).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("folds session events into render items", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "yo" }] },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({ kind: "user", text: "yo" }),
    ]);
  });

  it("queues dialog extension requests", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toHaveLength(1);
  });

  it("records a setWidget's text in extensionStatus AND still answers it", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e2",
      method: "setWidget",
      widgetKey: "ctx",
      widgetLines: ["ctx 12%", "cost $0.10"],
    });
    // omp blocks on the reply — recording the text must not replace answering.
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e2",
      cancelled: true,
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.extensionStatus).toEqual({ ctx: "ctx 12%\ncost $0.10" });
    expect(tab.extensionQueue).toHaveLength(0);
    // Displayed text is not transcript noise.
    expect(tab.items).toHaveLength(0);
  });

  it("records setStatus text and clears a widget when its lines go away", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e3",
      method: "setStatus",
      statusKey: "advisor",
      statusText: "reviewing",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionStatus).toEqual({
      advisor: "reviewing",
    });
    store.handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e4",
      method: "setStatus",
      statusKey: "advisor",
      statusText: undefined,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionStatus).toEqual({});
  });

  it("auto-cancels a non-status extension request with a marker", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e5",
      method: "notify",
      message: "hi",
    });
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e5",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "extension notify auto-cancelled",
      }),
    ]);
  });

  it("open_url opens the system browser, confirms, and stamps a marker", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "u1",
      method: "open_url",
      url: "https://auth.example.com/login?state=1",
    });
    expect(h.openedUrls).toEqual(["https://auth.example.com/login?state=1"]);
    expect(h.sent.pop()!.cmd).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: true,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "opened browser: https://auth.example.com",
      }),
    ]);
  });

  it("open_url without a url string is cancelled, never opened", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "u2",
      method: "open_url",
    });
    expect(h.openedUrls).toHaveLength(0);
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "u2",
      cancelled: true,
    });
  });

  it("claims the plan status frame as state, not as displayed text", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p1",
      method: "setStatus",
      statusKey: "omp-ui:plan",
      statusText: JSON.stringify({
        enabled: true,
        planFilePath: "local://a-plan.md",
        planAbsPath: "/lineage/local/a-plan.md",
        approved: false,
      }),
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.plan).toMatchObject({
      enabled: true,
      planFilePath: "local://a-plan.md",
    });
    // Plan state drives the toggle; it must never leak into the status chips.
    expect(tab.extensionStatus).toEqual({});
  });

  it("claims the advisor-stats frame as state, not as displayed text", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "a1",
      method: "setStatus",
      statusKey: "omp-ui:advisorStats",
      statusText: JSON.stringify({
        available: true,
        configured: true,
        active: true,
        model: "openrouter/anthropic/claude-opus-5",
        contextWindow: 200000,
        contextTokens: 40123,
        cost: 0.41,
        totalTokens: 900000,
      }),
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.advisorStats).toMatchObject({
      available: true,
      cost: 0.41,
      contextTokens: 40123,
      contextWindow: 200000,
    });
    // Advisor stats are state, never a status chip.
    expect(tab.extensionStatus).toEqual({});
    expect(tab.advisorStats?.active).toBe(true);
  });

  describe("MCP runtime failure state", () => {
    const statusFrame = (statusText: string, id = "mcp-status") => ({
      type: "extension_ui_request",
      id,
      method: "setStatus",
      statusKey: MCP_RUNTIME_STATUS_KEY,
      statusText,
    });

    it("derives one warning per new auth and connection failure", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [
          { serverName: "oauth-broken", kind: "auth" },
          { serverName: "offline", kind: "connection" },
        ],
      })));

      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items).toEqual([
        expect.objectContaining({
          kind: "notice",
          level: "warn",
          text: "MCP server “oauth-broken” failed authentication and is absent from this live session. Open the MCP manager, authenticate through omp’s TUI, then restart the session.",
        }),
        expect.objectContaining({
          kind: "notice",
          level: "warn",
          text: "MCP server “offline” failed to connect and is absent from this live session. Open the MCP manager to inspect its configuration, then restart the session.",
        }),
      ]);
      expect(tab.mcpStatus?.failedServers).toHaveLength(2);
      expect(tab.extensionStatus).toEqual({});
    });

    it("deduplicates repeated snapshots and clears active failure state on connection", () => {
      const failed = JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [{ serverName: "remote", kind: "auth" }],
      });
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(failed, "first"));
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(failed, "repeat"));
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: ["remote"],
        failedServers: [],
      }), "connected"));

      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items.filter((item) => item.kind === "notice")).toHaveLength(1);
      expect(tab.mcpStatus).toEqual({
        pendingServers: [],
        connectedServers: ["remote"],
        failedServers: [],
      });
    });

    it("claims malformed status without changing state or creating a generic chip", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame("{not-json"));
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.mcpStatus).toBeNull();
      expect(tab.items).toEqual([]);
      expect(tab.extensionStatus).toEqual({});
    });

    it("updates and warns a background tab", () => {
      h.useStore.setState({ activeTabId: "another-tab" });
      h.useStore.getState().handleRpcFrame(h.TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [{ serverName: "background", kind: "connection" }],
      })));
      expect(h.useStore.getState().rpc[h.TAB]!.mcpStatus?.failedServers).toEqual([
        { serverName: "background", kind: "connection" },
      ]);
      expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
    });
    it("clears process-scoped status and notices when the tab boots again", async () => {
      const relaunchTab = "mcp-relaunch-tab";
      const state = h.stateWithRecord("session-1");
      state.projects[0]!.sessions[0]!.tabId = relaunchTab;
      h.backendState = state;
      h.useStore.setState({
        state,
        rpc: {
          [relaunchTab]: rpcTabState({
            items: [{ kind: "notice", id: "old-mcp-notice", text: "old" }],
            mcpStatus: {
              pendingServers: [],
              connectedServers: [],
              failedServers: [{ serverName: "old-process", kind: "auth" }],
            },
          }),
        },
      });

      await h.driveBoot(relaunchTab);

      expect(h.useStore.getState().rpc[relaunchTab]!.mcpStatus).toBeNull();
      expect(h.useStore.getState().rpc[relaunchTab]!.items).toEqual([]);
    });
  });

  describe("provider stream stall notices (issue #100)", () => {
    const stallFrame = {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 10,
      delayMs: 2000,
      errorMessage:
        "OpenAI responses stream stalled while waiting for the next event",
    };

    it("reports idle watchdog time from the last model-stream checkpoint", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const store = h.useStore.getState();
        store.handleRpcFrame(h.TAB, {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        });
        vi.setSystemTime(1_000_000 + 123_000);
        h.useStore.getState().handleRpcFrame(h.TAB, stallFrame);
        const last = h.useStore.getState().rpc[h.TAB]!.items.at(-1);
        expect(last).toMatchObject({ kind: "notice", level: "warn" });
        if (last?.kind !== "notice") return;
        expect(last.text).toContain(
          "idle watchdog fired after 2m 03s since streaming text",
        );
        expect(last.text).toContain(
          "Upstream error: OpenAI responses stream stalled while waiting for the next event",
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not let local tool frames replace the last model checkpoint", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        const store = h.useStore.getState();
        store.handleRpcFrame(h.TAB, {
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_end" },
        });
        vi.setSystemTime(1_120_000);
        store.handleRpcFrame(h.TAB, {
          type: "tool_execution_start",
          toolCallId: "t1",
        });
        vi.setSystemTime(1_123_000);
        store.handleRpcFrame(h.TAB, {
          type: "tool_execution_update",
          toolCallId: "t1",
        });
        store.handleRpcFrame(h.TAB, stallFrame);
        const last = h.useStore.getState().rpc[h.TAB]!.items.at(-1);
        if (last?.kind !== "notice") return;
        expect(last.text).toContain(
          "2m 03s since tool-call arguments complete",
        );
        expect(last.text).not.toContain("running tools");
      } finally {
        vi.useRealTimers();
      }
    });

    it("increments the per-tab stall counter across stalls", () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(1_000_000);
        h.useStore.getState().handleRpcFrame(h.TAB, stallFrame);
        vi.setSystemTime(1_100_000);
        h.useStore.getState().handleRpcFrame(h.TAB, { ...stallFrame, attempt: 2 });
        const notices = h.useStore
          .getState()
          .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
        expect(notices).toHaveLength(2);
        if (notices[0]?.kind !== "notice" || notices[1]?.kind !== "notice")
          return;
        expect(notices[0].text).toContain("provider stream stall #1");
        expect(notices[1].text).toContain("provider stream stall #2");
      } finally {
        vi.useRealTimers();
      }
    });

    it("stays silent for a non-stall retry (no Timeout bit, no watchdog message)", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 10,
        delayMs: 2000,
        errorMessage: "429 rate limit",
      });
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items.filter((i) => i.kind === "notice")).toEqual([]);
      const last = tab.items[tab.items.length - 1];
      expect(last).toMatchObject({
        kind: "marker",
        label: "auto-retry 1/10 started — retrying in 2.0s",
      });
    });

    it("admits an unknown stage when only the Timeout bit is available", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 10,
        delayMs: 2000,
        errorId: 0x0006_0000,
      });
      const notice = h.useStore
        .getState()
        .rpc[h.TAB]!.items.find((i) => i.kind === "notice");
      if (notice?.kind !== "notice") return;
      expect(notice.level).toBe("warn");
      expect(notice.text).toContain("supplied no watchdog stage");
      expect(notice.text).not.toContain("Upstream error:");
    });

    it("distinguishes first-event from idle and avoids unsupported attribution", () => {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        ...stallFrame,
        errorMessage:
          "OpenAI responses stream timed out while waiting for the first event",
      });
      h.useStore.getState().handleRpcFrame(h.TAB, stallFrame);
      const notices = h.useStore
        .getState()
        .rpc[h.TAB]!.items.filter((i) => i.kind === "notice");
      if (notices[0]?.kind !== "notice" || notices[1]?.kind !== "notice")
        return;
      expect(notices[0].text).toContain("first-event watchdog fired");
      expect(notices[1].text).toContain("idle watchdog fired");
      for (const notice of notices) {
        expect(notice.text).not.toContain("defaults to 2m");
        expect(notice.text).not.toContain("provider leg");
        expect(notice.text).not.toContain("proxy or upstream model");
      }
    });
  });

  it("refreshAdvisorStats asks the extension over a slash command", async () => {
    const pending = h.useStore.getState().refreshAdvisorStats(h.TAB);
    const entry = h.sent.pop()!;
    expect(entry.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-advisor-stats",
    });
    // The extension answers by publishing a setStatus frame, not a response —
    // settle the command so the method promise resolves.
    h.respond(h.TAB, entry.cmd, {});
    await pending;
  });

  it("routes a plan review to the review pane instead of the generic dialog", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.md",
          planAbsPath: "/lineage/local/auth-plan.md",
        }),
      options: ["approve", "refine"],
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.planReview?.request).toMatchObject({
      planFilePath: "local://auth-plan.md",
    });
    expect(tab.extensionQueue).toHaveLength(0);
    // The agent is blocked on this select — nothing may answer it early.
    expect(h.sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(
      false,
    );
  });

  it("reads one file and flags an html plan for iframe rendering", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2h",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/lineage/local/auth-plan.html",
        }),
    });
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    // The html file IS the plan — one read, and planHtml is only the flag that
    // says "render this text in an iframe", never a second document.
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab.planText).toBe("<h1>Plan</h1>");
    expect(tab.planHtml).toBe("<h1>Plan</h1>");
  });

  it("leaves planHtml null for a markdown plan", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2m",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.md",
          planAbsPath: "/lineage/local/auth-plan.md",
        }),
    });
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(h.mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab.planText).toBe("# Plan\n\nstep one\n");
    expect(tab.planHtml).toBeNull();
  });

  it("clears both plan fields when an html plan cannot be read", async () => {
    h.mockBackend.readPlanFile.mockRejectedValueOnce(new Error("ENOENT"));
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p2f",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/lineage/local/auth-plan.html",
        }),
    });
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    // A failed read must not leave the pane flagged for iframe rendering with
    // nothing to render — the review itself stays open either way.
    expect(tab.planText).toBeNull();
    expect(tab.planHtml).toBeNull();
    expect(tab.planReview).not.toBeNull();
  });

  it("executing a review answers with the execute verdict and closes the pane", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p3",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().executePlan(h.TAB, "existing");
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p3", value: "execute" });
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toBeNull();
    await h.flushMicrotasks();
  });

  it("executing in the existing session queues an implementation prompt there", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p3b",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().executePlan(h.TAB, "existing");
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    // followUp queues the prompt until the just-accepted plan turn ends, so it
    // races nothing — the implementer runs after the planner stops.
    expect(prompt!.cmd.streamingBehavior).toBe("followUp");
    await h.flushMicrotasks();
  });

  it("holds the implementation prompt until the session reports Build after execute (issue #165)", async () => {
    // The proposing session published armed status; the verdict's exit frame
    // is still in flight when the verdict is answered.
    h.useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [h.TAB]: {
          ...s.rpc[h.TAB]!,
          plan: {
            enabled: true,
            planFilePath: "local://p.md",
            planAbsPath: "/p.md",
            approved: false,
          },
        },
      },
    }));
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p3c",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().executePlan(h.TAB, "existing");
    // Verdict landed, but no implementation prompt yet — it waits for Build.
    expect(h.sent.find((s) => s.cmd.type === "prompt")).toBeUndefined();
    // The extension's in-process exit publishes its status frame.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "st1",
      method: "setStatus",
      statusKey: PLAN_STATUS_KEY,
      statusText: JSON.stringify({
        enabled: false,
        planFilePath: null,
        planAbsPath: null,
        approved: true,
      }),
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    await h.flushMicrotasks();
  });

  it("forces plan mode off before dispatching when the verdict's exit never publishes (issue #165)", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState((s) => ({
        rpc: {
          ...s.rpc,
          [h.TAB]: {
            ...s.rpc[h.TAB]!,
            plan: {
              enabled: true,
              planFilePath: "local://p.md",
              planAbsPath: "/p.md",
              approved: false,
            },
          },
        },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "extension_ui_request",
        id: "p3d",
        method: "select",
        title:
          "omp-ui:plan-review:" +
          JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
      });
      h.useStore.getState().executePlan(h.TAB, "existing");
      // No exit frame ever arrives; the bounded wait expires and the mode
      // command is sent directly.
      await vi.advanceTimersByTimeAsync(15_000);
      await h.flushMicrotasks();
      const off = h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message) === "/omp-ui-plan off",
      );
      expect(off).toBeDefined();
      // The forced exit answers with its status frame; implementation follows.
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "extension_ui_request",
        id: "st2",
        method: "setStatus",
        statusKey: PLAN_STATUS_KEY,
        statusText: JSON.stringify({
          enabled: false,
          planFilePath: null,
          planAbsPath: null,
          approved: true,
        }),
      });
      await h.flushMicrotasks();
      expect(
        h.sent.find(
          (s) =>
            s.tabId === h.TAB &&
            s.cmd.type === "prompt" &&
            String(s.cmd.message).includes("execute the approved plan"),
        ),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refining a review answers with the refine verdict and sends no prompt", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p4",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().refinePlan(h.TAB);
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p4", value: "refine" });
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
  });

  it("refining with notes steers the planner with the requested changes", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p4b",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    h.useStore.getState().refinePlan(h.TAB, { text: "drop the API layer" });
    const prompt = h.sent.find((s) => s.tabId === h.TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.streamingBehavior).toBe("steer");
    expect(prompt!.cmd.message).toContain("drop the API layer");
    await h.flushMicrotasks();
  });

  it("executing in a fresh session spawns a new tab seeded with the plan", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p7",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p7", value: "execute" });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        startInPlanMode: false,
        planImplementationSource: {
          sourceTabId: h.TAB,
          planTitle: "t",
          planFilePath: "local://p.md",
        },
      }),
    );
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === "fresh-tab" &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("# Plan"),
    );
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.message).toContain("Implement it now");
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" && item.text.includes("implementation dispatched"),
        ),
    ).toBe(false);

    h.respond("fresh-tab", prompt!.cmd, {});
    await h.flushMicrotasks();

    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledOnce();
    expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "fresh-tab");
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" && item.text.includes("implementation dispatched"),
        ),
    ).toBe(true);
    await rearmHandoffSource();
  });

  it("seeds a fresh session with an html plan's spec, not its stylesheet", async () => {
    const htmlPlan = [
      "<!doctype html>",
      "<html><head><style>",
      "  h1 { color: rebeccapurple; }",
      "</style></head>",
      "<body><h1>Ship the auth rewrite</h1></body>",
      "</html>",
    ].join("\n");
    h.mockBackend.readPlanFile.mockResolvedValueOnce(htmlPlan);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p7h",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p-plan.html",
          planAbsPath: "/lineage/local/p-plan.html",
        }),
    });
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    // The implementer needs the spec inline; the presentation layer is pure
    // token cost in a prompt.
    expect(String(prompt!.cmd.message)).toContain("Ship the auth rewrite");
    expect(String(prompt!.cmd.message)).not.toContain("rebeccapurple");
    await h.flushMicrotasks();
  });

  /** An advisor review card as it lands over the live stream. */
  const advisorReviewFrame = (
    note: string,
    severity: string,
    advisor: string,
  ) => ({
    type: "message_end",
    message: {
      role: "custom",
      customType: "advisor",
      content: "<advisory/>",
      details: { notes: [{ note, severity, advisor }] },
    },
  });

  /** Opens a plan review ready for a verdict. */
  const openReview = (id: string) => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
  };

  const dispatchFreshSeed = async (id: string): Promise<(typeof h.sent)[number]> => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview(id);
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    }));
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt",
    );
    if (prompt === undefined) throw new Error("fresh implementation seed was not sent");
    return prompt;
  };

  const rearmHandoffSource = async (): Promise<void> => {
    const prompt = h.useStore.getState().sendPrompt(h.TAB, "test handoff cleanup", "prompt");
    const command = h.sent.at(-1);
    if (command?.tabId === h.TAB && command.cmd.type === "prompt") {
      h.respond(h.TAB, command.cmd, {});
    }
    await prompt;
  };

  it("does not hibernate after a fresh spawn failure or readiness timeout (issue #283)", async () => {
    h.mockBackend.spawnSession.mockRejectedValueOnce(new Error("spawn failed"));
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview("handoff-spawn-failure");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();

    vi.useFakeTimers();
    try {
      h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "never-ready" });
      openReview("handoff-ready-timeout");
      await h.flushMicrotasks();
      h.useStore.getState().executePlan(h.TAB, "fresh");
      await h.flushMicrotasks();
      await vi.advanceTimersByTimeAsync(15_000);
      await h.flushMicrotasks();
      expect(
        h.sent.some((entry) => entry.tabId === "never-ready" && entry.cmd.type === "prompt"),
      ).toBe(false);
      expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["set_model", { model: { id: "new", name: "New", provider: "provider" } }],
    ["set_thinking_level", { thinkingLevel: "high" }],
  ])("does not seed or hibernate after %s setup fails (issue #283)", async (command, options) => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReview(`handoff-${command}`);
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", options);
    await h.flushMicrotasks();
    h.useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    }));
    await h.flushMicrotasks();
    const setupCommand = h.sent.find(
      (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === command,
    );
    expect(setupCommand).toBeDefined();
    h.respond("fresh-tab", setupCommand!.cmd, "setup failed", false);
    await h.flushMicrotasks();

    expect(
      h.sent.some((entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt"),
    ).toBe(false);
    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
  });

  it("does not hibernate or claim dispatch when the seed command fails (issue #283)", async () => {
    const prompt = await dispatchFreshSeed("handoff-seed-failure");
    h.respond("fresh-tab", prompt.cmd, "seed rejected", false);
    await h.flushMicrotasks();

    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
    expect(
      h.useStore
        .getState()
        .rpc[h.TAB]!.items.some(
          (item) =>
            item.kind === "notice" && item.text.includes("implementation dispatched"),
        ),
    ).toBe(false);
  });

  it("suppresses a second advisor reply while source hibernation is unresolved (issue #283)", async () => {
    vi.useFakeTimers();
    const hibernation = h.deferred<boolean>();
    h.mockBackend.hibernatePlanSource.mockImplementationOnce(() => hibernation.promise);
    try {
      h.useStore.setState({
        state: h.stateWithRecord(null),
        rpc: {
          [h.TAB]: rpcTabState({
            advisorStats: {
              available: true,
              configured: true,
              active: true,
              model: "advisor",
              subscription: false,
              contextWindow: 200_000,
              contextTokens: 0,
              cost: 0,
              totalTokens: 0,
            },
          }),
        },
      });
      h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
      openReview("handoff-advisor-race");
      h.useStore.getState().executePlan(h.TAB, "fresh");
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("first finding", "concern", "advisor"));
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({
        rpc: {
          ...state.rpc,
          "fresh-tab": rpcTabState({ status: "ready", planText: null }),
        },
      }));
      await h.flushMicrotasks();
      const seed = h.sent.find(
        (entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt",
      );
      expect(seed).toBeDefined();
      h.respond("fresh-tab", seed!.cmd, {});
      await h.flushMicrotasks();
      expect(h.mockBackend.hibernatePlanSource).toHaveBeenCalledWith(h.TAB, "fresh-tab");

      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("late finding", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await h.flushMicrotasks();
      expect(h.sent.some((entry) => entry.tabId === h.TAB && entry.cmd.type === "prompt")).toBe(
        false,
      );
    } finally {
      hibernation.resolve(false);
      await rearmHandoffSource();
      vi.useRealTimers();
    }
  });

  it("suppresses stall auto-continue after a successful fresh seed (issue #283)", async () => {
    vi.useFakeTimers();
    const hibernation = h.deferred<boolean>();
    h.mockBackend.hibernatePlanSource.mockImplementationOnce(() => hibernation.promise);
    try {
      const seed = await dispatchFreshSeed("handoff-stall");
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "partial" }],
          stopReason: "error",
          errorMessage: "OpenAI responses stream stalled while waiting for the next event",
          errorId: 397312,
        },
      });
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
      await h.flushMicrotasks();

      expect(
        h.sent.some(
          (entry) => entry.tabId === h.TAB && entry.cmd.message === STALL_CONTINUE_LEAD,
        ),
      ).toBe(false);
    } finally {
      hibernation.resolve(false);
      await rearmHandoffSource();
      vi.useRealTimers();
    }
  });

  it.each([
    ["false result", async () => false],
    ["rejection", async () => Promise.reject(new Error("transport failed"))],
  ])("keeps source automation suppressed after backend %s (issue #283)", async (_case, result) => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    h.mockBackend.hibernatePlanSource.mockImplementationOnce(result);
    try {
      const seed = await dispatchFreshSeed(`handoff-${_case}`);
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("late", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await h.flushMicrotasks();

      expect(
        h.sent.filter((entry) => entry.tabId === "fresh-tab" && entry.cmd.type === "prompt"),
      ).toHaveLength(1);
      expect(h.sent.some((entry) => entry.tabId === h.TAB && entry.cmd.type === "prompt")).toBe(
        false,
      );
      expect(h.mockBackend.terminateSession).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      await rearmHandoffSource();
      vi.useRealTimers();
    }
  });

  it("a manual source prompt re-enables advisor replies after handoff (issue #283)", async () => {
    vi.useFakeTimers();
    h.mockBackend.hibernatePlanSource.mockResolvedValueOnce(false);
    try {
      const seed = await dispatchFreshSeed("handoff-manual-resume");
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      const manual = h.useStore.getState().sendPrompt(h.TAB, "new human direction", "prompt");
      const manualCommand = h.sent.find(
        (entry) => entry.tabId === h.TAB && entry.cmd.message === "new human direction",
      );
      h.respond(h.TAB, manualCommand!.cmd, {});
      await expect(manual).resolves.toBe(true);
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("review human work", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await h.flushMicrotasks();

      expect(
        h.sent.some(
          (entry) =>
            entry.tabId === h.TAB &&
            entry.cmd.type === "prompt" &&
            String(entry.cmd.message).includes("review human work"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("booting the source re-enables advisor replies after handoff (issue #283)", async () => {
    vi.useFakeTimers();
    h.mockBackend.hibernatePlanSource.mockResolvedValueOnce(false);
    try {
      const seed = await dispatchFreshSeed("handoff-boot-resume");
      h.respond("fresh-tab", seed.cmd, {});
      await h.flushMicrotasks();
      h.sent.length = 0;
      await h.driveBoot(h.TAB);
      h.useStore.setState((state) => ({
        rpc: { ...state.rpc, [h.TAB]: { ...state.rpc[h.TAB]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("review resumed work", "concern", "advisor"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await h.flushMicrotasks();

      expect(
        h.sent.some(
          (entry) =>
            entry.tabId === h.TAB &&
            entry.cmd.type === "prompt" &&
            String(entry.cmd.message).includes("review resumed work"),
        ),
      ).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never requests source hibernation for existing or compacted execution (issue #283)", async () => {
    openReview("handoff-existing");
    h.useStore.getState().executePlan(h.TAB, "existing");
    openReview("handoff-compacted");
    h.useStore.getState().executePlan(h.TAB, "compacted");
    await h.flushMicrotasks();

    expect(h.mockBackend.hibernatePlanSource).not.toHaveBeenCalled();
  });

  it("holds execute for the drafting turn's advisor review, then folds its concerns", async () => {
    // Fake timers for the whole test: the same review that feeds the fold also
    // arms the idle auto-reply, and only a fake clock can advance past its
    // settle window to prove the fold's dispatch stays the only prompt.
    vi.useFakeTimers();
    try {
      // Configured advisor = a review of the plan turn is on its way after the verdict.
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            advisorStats: {
              available: true,
              configured: true,
              active: true,
              model: "m",
              subscription: false,
              contextWindow: 200000,
              contextTokens: 0,
              cost: 0,
              totalTokens: 0,
            },
          }),
        },
      });
      openReview("c1");
      h.useStore.getState().executePlan(h.TAB, "existing");
      // The verdict lands immediately — omp's agent is blocked on it.
      const verdict = h.sent.find((s) => s.cmd.type === "extension_ui_response");
      expect(verdict!.cmd).toMatchObject({ id: "c1", value: "execute" });
      // …but the implementation waits for the review: the turn that produced the
      // plan is still ending, so its review cannot have landed yet.
      expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
      // The advisor reviews the now-finished plan turn.
      h.useStore
        .getState()
        .handleRpcFrame(
          h.TAB,
          advisorReviewFrame("Hardcoded key", "blocker", "security"),
        );
      await h.flushMicrotasks();
      const prompt = h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
      expect(prompt).toBeDefined();
      expect(String(prompt!.cmd.message)).toContain("advisor flagged");
      expect(String(prompt!.cmd.message)).toContain("Hardcoded key");
      expect(String(prompt!.cmd.message)).toContain("[blocker]");
      const tab = h.useStore.getState().rpc[h.TAB]!;
      expect(tab.items.at(-1)).toMatchObject({
        kind: "notice",
        text: expect.stringContaining("1 concern"),
      });
      // The fold already answered this review; the auto-reply must not send a second.
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await h.flushMicrotasks();
      expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("answers a review that lands on an idle session with a follow-up prompt", async () => {
    // The armed settle timer must be the fake one, so install before the frame.
    vi.useFakeTimers();
    try {
      // The production frame sequence, and it is load-bearing: an advisory can
      // only follow a turn, so `agent_end` always precedes it. The watcher feed
      // runs *before* that frame's status patch (store.ts), so the tab still
      // reads `running` there — which is exactly what baselines the cursor onto
      // the `agent finished` marker and leaves the next frame's advisory above
      // it. Feeding the advisory first would instead seed the baseline past it,
      // as a resumed tab's history correctly is.
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("Do it now", "concern", "ops"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    const replies = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(replies).toHaveLength(1);
    // followUp keeps the reply on the same session without restarting its turn.
    expect(replies[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
    expect(String(replies[0]!.cmd.message)).toContain("Do it now");
    expect(String(replies[0]!.cmd.message)).toContain("[concern]");
    // The transcript says why a prompt nobody typed appeared.
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    const announcement = items.find(
      (i) => i.kind === "notice" && /answering it \(1 finding\)/.test(i.text),
    );
    expect(announcement).toBeDefined();
  });

  it("sends nothing when the session has advisor auto-reply switched off", async () => {
    vi.useFakeTimers();
    try {
      // Same production sequence as the case above, so the only thing
      // suppressing the reply here is the opt-out.
      h.useStore.setState({
        rpc: { [h.TAB]: rpcTabState({ status: "running", advisorReply: false }) },
      });
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
      h.useStore
        .getState()
        .handleRpcFrame(h.TAB, advisorReviewFrame("Do it now", "concern", "ops"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    expect(h.sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("answering it")),
    ).toBe(false);
  });

  it("executes immediately, and reads no transcript, when the fold is off", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          items: [
            {
              kind: "advisory",
              id: "advisory-stale",
              notes: [
                {
                  note: "old unrelated nit",
                  severity: "nit",
                  advisor: "style",
                },
              ],
            },
          ],
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 200000,
            contextTokens: 0,
            cost: 0,
            totalTokens: 0,
          },
        }),
      },
    });
    openReview("c2");
    h.useStore.getState().executePlan(h.TAB, "existing", { addressAdvisor: false });
    await h.flushMicrotasks();
    const prompt = h.sent.find((s) => s.tabId === h.TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    // Stale pre-verdict advisories are never folded onto a fresh verdict.
    expect(String(prompt!.cmd.message)).not.toContain("old unrelated nit");
  });

  it("skips the wait entirely when the session has no configured advisor", () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ advisorStats: null }) } });
    openReview("c3");
    h.useStore.getState().executePlan(h.TAB, "existing");
    expect(h.sent.find((s) => s.cmd.type === "prompt")).toBeDefined();
  });

  it("refine stays immediate: user notes steer at once, never waiting on a review", () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 200000,
            contextTokens: 0,
            cost: 0,
            totalTokens: 0,
          },
        }),
      },
    });
    openReview("c4");
    h.useStore.getState().refinePlan(h.TAB, { text: "drop the API layer" });
    expect(
      h.sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd,
    ).toMatchObject({
      id: "c4",
      value: "refine",
    });
    // The planner revises in this same turn (the extension tells it to), so
    // there is no review to wait for — the user's notes steer immediately.
    const steer = h.sent.find((s) => s.tabId === h.TAB && s.cmd.type === "prompt");
    expect(steer!.cmd.streamingBehavior).toBe("steer");
    expect(String(steer!.cmd.message)).toContain("drop the API layer");
  });

  it("times out the execute concern wait and implements without concerns", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            advisorStats: {
              available: true,
              configured: true,
              active: true,
              model: "m",
              subscription: false,
              contextWindow: 200000,
              contextTokens: 0,
              cost: 0,
              totalTokens: 0,
            },
          }),
        },
      });
      openReview("c5");
      h.useStore.getState().executePlan(h.TAB, "existing");
      // The review never lands; the bounded deadline settles the wait.
      await vi.advanceTimersByTimeAsync(15_000);
      await h.flushMicrotasks();
      const prompt = h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
      expect(prompt).toBeDefined();
      expect(String(prompt!.cmd.message)).not.toContain("advisor flagged");
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds a fresh implementation session with the folded concerns", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          advisorStats: {
            available: true,
            configured: true,
            active: true,
            model: "m",
            subscription: false,
            contextWindow: 200000,
            contextTokens: 0,
            cost: 0,
            totalTokens: 0,
          },
        }),
      },
    });
    openReview("c6");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).toBeNull();
    h.useStore
      .getState()
      .handleRpcFrame(
        h.TAB,
        advisorReviewFrame("pin the toolchain", "concern", "ops"),
      );
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        planImplementationSource: {
          sourceTabId: h.TAB,
          planTitle: "t",
          planFilePath: "local://p.md",
        },
        startInPlanMode: false,
      }),
    );
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === "fresh-tab" &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("Implement it now"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("pin the toolchain");
    await h.flushMicrotasks();
  });

  it("fresh implementation spawns with the app default advisor when none is staged (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "fresh-default-on",
    });
    h.useStore.setState({
      state: { ...h.stateWithRecord(null), defaultAdvisor: true },
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReview("d1");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        advisor: true,
        startInPlanMode: false,
      }),
    );
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-default-on": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
  });

  it("fresh implementation defaults the advisor off against omp config when none is staged (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "fresh-default-off",
    });
    h.useStore.setState({
      state: h.stateWithRecord(null),
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });
    openReview("d2");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        advisor: false,
        startInPlanMode: false,
      }),
    );
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-default-off": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
  });

  /** Staged model with efforts, distinct from anything seeded on the tab. */
  const MODEL_X = {
    id: "mx",
    name: "MX",
    provider: "p2",
    thinking: { efforts: ["low", "high"] },
  };

  /** Review frame whose plan file read resolves — fresh spawns seed from it. */
  const openReviewWithPlan = (id: string) => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
  };

  it("prepends the orchestrate keyword to the implementation prompt (existing context)", async () => {
    openReview("o1");
    h.useStore.getState().executePlan(h.TAB, "existing", { orchestrate: true });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "orchestrate\n\nThe plan review is complete",
      ),
    ).toBe(true);
  });

  it("prepends the ultrathink keyword to the implementation prompt (existing context)", async () => {
    openReview("o1u");
    h.useStore.getState().executePlan(h.TAB, "existing", { ultrathink: true });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "ultrathink\n\nThe plan review is complete",
      ),
    ).toBe(true);
  });

  it("prepends armed keywords in notice order, not arming order", async () => {
    openReview("o1w");
    h.useStore.getState().executePlan(h.TAB, "existing", { workflowz: true, ultrathink: true });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "ultrathink\n\nworkflowz\n\nThe plan review is complete",
      ),
    ).toBe(true);
  });

  it("leaves the keyword off by default", async () => {
    openReview("o2");
    h.useStore.getState().executePlan(h.TAB, "existing");
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message).startsWith("orchestrate")).toBe(false);
  });

  it("prepends the orchestrate keyword to a fresh session's seed", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReviewWithPlan("o3");
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", { orchestrate: true });
    await h.flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "orchestrate\n\nA plan was approved",
      ),
    ).toBe(true);
  });

  it("prepends the workflowz keyword to a fresh session's seed", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReviewWithPlan("o3w");
    // Let the plan file read resolve so executePlan captures the plan text.
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", { workflowz: true });
    await h.flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const prompt = h.sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    expect(
      String(prompt!.cmd.message).startsWith(
        "workflowz\n\nA plan was approved",
      ),
    ).toBe(true);
  });

  it("applies staged model and thinking level before the same-session prompt", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    openReview("m1");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      model: MODEL_X,
      thinkingLevel: "high",
      advisor: false,
      advisorModel: null,
    });
    await h.flushMicrotasks();
    const onTab = (s: (typeof h.sent)[number]) => s.tabId === h.TAB;
    // The staged pair applies over RPC first; each awaited command stalls the
    // chain until the test answers it.
    const setModel = h.sent.find((s) => onTab(s) && s.cmd.type === "set_model");
    expect(setModel?.cmd).toMatchObject({ provider: "p2", modelId: "mx" });
    h.respond(h.TAB, setModel!.cmd, {});
    await h.flushMicrotasks();
    const setLevel = h.sent.find(
      (s) => onTab(s) && s.cmd.type === "set_thinking_level",
    );
    expect(setLevel?.cmd).toMatchObject({ level: "high" });
    h.respond(h.TAB, setLevel!.cmd, {});
    await h.flushMicrotasks();
    const modelIdx = h.sent.findIndex(
      (s) => onTab(s) && s.cmd.type === "set_model",
    );
    const levelIdx = h.sent.findIndex(
      (s) => onTab(s) && s.cmd.type === "set_thinking_level",
    );
    const promptIdx = h.sent.findIndex(
      (s) =>
        onTab(s) &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(promptIdx);
    // setModel persists the then-current level first; setThinkingLevel
    // re-persists with the new one, so the last call carries the final pair.
    expect(h.mockBackend.setSessionModel).toHaveBeenLastCalledWith(
      h.TAB,
      "p2/mx",
      "high",
    );
  });

  it("an unchanged staged tuple is a no-op", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    openReview("m2");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      model: { id: "m1", name: "M1", provider: "p" },
      thinkingLevel: "low",
      advisor: false,
      advisorModel: null,
    });
    await h.flushMicrotasks();
    expect(h.sent.some((s) => s.cmd.type === "set_model")).toBe(false);
    expect(h.sent.some((s) => s.cmd.type === "set_thinking_level")).toBe(false);
    expect(h.mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    // Staging what is already live must preserve today's behavior exactly.
    const prompt = h.sent.find(
      (s) =>
        s.tabId === h.TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
  });

  it("an advisor change relaunches the session before dispatching", async () => {
    h.useStore.setState({
      state: h.stateWithRecord(null),
      rpc: { [h.TAB]: rpcTabState() },
    });
    openReview("a1");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
    const implementationPrompt = () =>
      h.sent.find(
        (s) =>
          s.tabId === h.TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
    // The relaunch parked the tab at "starting" — the prompt waits on readiness.
    expect(implementationPrompt()).toBeUndefined();
    h.useStore.setState({
      rpc: { [h.TAB]: { ...h.useStore.getState().rpc[h.TAB]!, status: "ready" } },
    });
    await h.flushMicrotasks();
    const prompt = implementationPrompt();
    expect(prompt).toBeDefined();
    // A relaunched session has no plan turn in flight, so the prompt steers.
    expect(prompt!.cmd.streamingBehavior).toBe("steer");
  });

  it("a failed advisor relaunch never dispatches the prompt", async () => {
    h.useStore.setState({
      state: h.stateWithRecord(null),
      rpc: { [h.TAB]: rpcTabState() },
    });
    openReview("a2");
    h.useStore.getState().executePlan(h.TAB, "existing", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
    h.useStore.setState({
      rpc: { [h.TAB]: { ...h.useStore.getState().rpc[h.TAB]!, status: "error" } },
    });
    await h.flushMicrotasks();
    expect(
      h.sent.some(
        (s) =>
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      ),
    ).toBe(false);
  });

  it("a fresh session receives the staged advisor tuple and model", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openReviewWithPlan("a3");
    await h.flushMicrotasks();
    h.useStore.getState().executePlan(h.TAB, "fresh", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      model: MODEL_X,
      thinkingLevel: "high",
    });
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        advisor: true,
        advisorModel: "openrouter/a/b:high",
      }),
    );
    h.useStore.setState({
      rpc: {
        ...h.useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await h.flushMicrotasks();
    const onFresh = (s: (typeof h.sent)[number]) => s.tabId === "fresh-tab";
    const setModel = h.sent.find((s) => onFresh(s) && s.cmd.type === "set_model");
    expect(setModel?.cmd).toMatchObject({ provider: "p2", modelId: "mx" });
    h.respond("fresh-tab", setModel!.cmd, {});
    await h.flushMicrotasks();
    const setLevel = h.sent.find(
      (s) => onFresh(s) && s.cmd.type === "set_thinking_level",
    );
    expect(setLevel?.cmd).toMatchObject({ level: "high" });
    h.respond("fresh-tab", setLevel!.cmd, {});
    await h.flushMicrotasks();
    const modelIdx = h.sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "set_model",
    );
    const levelIdx = h.sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "set_thinking_level",
    );
    const promptIdx = h.sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "prompt",
    );
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(promptIdx);
  });

  it("still shows a plain select dialog when the title is not a plan review", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "p5",
      method: "select",
      title: "pick one",
      options: ["a", "b"],
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.extensionQueue).toHaveLength(1);
  });

  it("answers stray host_tool_call with an error result", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "host_tool_call", id: "h1", name: "x" });
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "host_tool_result",
      id: "h1",
    });
  });

  it("answers host_uri_request instead of leaving the agent blocked", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, {
        type: "host_uri_request",
        id: "u1",
        operation: "read",
        url: "db://x",
      });
    expect(h.sent.pop()!.cmd).toMatchObject({
      type: "host_uri_result",
      id: "u1",
      error: "omp-ui registers no uri schemes",
    });
  });

  it("command_output attaches to the newest running command row", () => {
    const first = commandItem("usage", "");
    const second = commandItem("context", "");
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState({ items: [first, second] }) },
    });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "out-1" });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "out-2" });
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items[0]).toBe(first);
    expect(items[1]).toMatchObject({ id: second.id, output: "out-1\nout-2" });
  });

  it("command_output with no running command row falls back to a notice", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "stray reply" });
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      text: "stray reply",
      level: "info",
    });
  });

  it("command_output accumulation is capped, head-preserving", () => {
    const item = commandItem("usage", "");
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ items: [item] }) } });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "x".repeat(64 * 1024) });
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "command_output", text: "tail" });
    const updated = h.useStore.getState().rpc[h.TAB]!.items[0]!;
    expect(updated.kind).toBe("command");
    const output = updated.kind === "command" ? updated.output! : "";
    expect(output.length).toBeLessThanOrEqual(64 * 1024 + 24);
    expect(output.startsWith("xxx")).toBe(true);
    expect(output.endsWith("… output truncated")).toBe(true);
  });

  it("available_commands_update replaces the command palette", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "available_commands_update",
      commands: [
        { name: "stats", description: "show stats", source: "builtin" },
        {
          name: "model",
          aliases: ["m"],
          description: "pick model",
          source: "builtin",
        },
        { name: 42 },
      ],
    });
    const { commands } = h.useStore.getState().rpc[h.TAB]!;
    expect(commands.map((c) => c.name)).toEqual(["stats", "model"]);
    expect(commands[1]).toMatchObject({
      aliases: ["m"],
      description: "pick model",
    });
  });

  it("extension_error surfaces as a rose-worthy error notice", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_error",
      extensionPath: "/ext/foo.ts",
      error: "boom",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: "boom",
        level: "error",
        source: "/ext/foo.ts",
      }),
    ]);
  });

  it("subagent frames mark the transcript and refresh the roster", () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "subagent_lifecycle",
      payload: { id: "s1", agent: "scout", status: "started", index: 0 },
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "subagent scout: started",
        tone: "copper",
      }),
    ]);
    expect(h.sent.some((s) => s.cmd.type === "get_subagents")).toBe(true);
  });

  it("thinking_level_changed patches the session as well as the transcript", () => {
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, {
        type: "thinking_level_changed",
        thinkingLevel: "max",
      });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.session.thinkingLevel).toBe("max");
    expect(tab.items).toEqual([
      expect.objectContaining({ kind: "marker", label: "thinking level: max" }),
    ]);
  });

  it("session_info_update and config_update merge into session/model", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "session_info_update",
      title: "Renamed",
      sessionId: "sess-9",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.session.sessionId).toBe("sess-9");
    store.handleRpcFrame(h.TAB, {
      type: "config_update",
      model: { id: "m2", name: "M Two", provider: "openai" },
      thinkingLevel: "low",
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.model).toMatchObject({ id: "m2", provider: "openai" });
    // A partial frame must not wipe what get_state already established.
    expect(tab.session).toMatchObject({
      sessionId: "sess-9",
      thinkingLevel: "low",
    });
  });
});

describe("stall auto-continue (issue #251)", () => {
  // The loop-guard state lives in module-scoped watchers keyed by tab id, so
  // each test owns its own tab: a shared id would leak counts between cases.
  /** The incident's terminal message_end: the provider watchdog's stall abort. */
  const stallEndFrame = () => ({
    type: "message_end",
    message: {
      role: "assistant",
      content: [{ type: "text", text: "Findings: …" }],
      stopReason: "error",
      errorMessage: "OpenAI responses stream stalled while waiting for the next event",
      errorId: 397312, // 0x4000 timeout bit set
    },
  });

  const continuePrompts = () =>
    h.sent.filter((s) => s.cmd.type === "prompt" && s.cmd.message === STALL_CONTINUE_LEAD);

  it("continues a stalled turn end with a bounded follow-up prompt (incident replay)", async () => {
    const T = "tab-stall-a";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      // The real frame sequence of session 01a024fc (issue #250's incident):
      // the ask's args are still streaming when the model stream goes silent.
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "tA",
        toolName: "ask",
        args: { i: "Choosing radiance build path" },
      });
      store.handleRpcFrame(T, {
        type: "message_update",
        assistantMessageEvent: {
          type: "toolcall_delta",
          contentIndex: 0,
          delta: "Choosing radiance build path",
          partial: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "tA",
                name: "ask",
                arguments: { i: "Choosing radiance build path" },
              },
            ],
          },
        },
      });
      // Ninety seconds of silence later, omp's provider watchdog aborts.
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    // The in-flight ask card reads aborted, not cancelled.
    const items = h.useStore.getState().rpc[T]!.items;
    const tools = items.filter((i) => i.kind === "tool");
    expect(tools).not.toHaveLength(0);
    for (const t of tools) expect(t).toMatchObject({ status: "aborted" });

    // The #100 diagnostic posted at the error turn-end.
    const diagnostic = items.find(
      (i): i is NoticeItem =>
        i.kind === "notice" && i.level === "warn" && i.text.includes("provider stream stall"),
    );
    expect(diagnostic).toBeDefined();
    expect(diagnostic!.text).toContain("OpenAI responses stream stalled");

    // The continue announced itself, then went out as a followUp prompt.
    const announced = items.find(
      (i) => i.kind === "notice" && i.level === "info" && i.text.includes("stall auto-continue #1"),
    );
    expect(announced).toBeDefined();
    const prompts = continuePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
  });

  it("posts the diagnostic but sends no continue when the app switch is off", async () => {
    const T = "tab-stall-b";
    vi.useFakeTimers();
    try {
      h.backendState = { ...h.backendState, stallAutoContinue: false };
      h.useStore.setState({
        state: h.backendState,
        rpc: { [T]: rpcTabState({ status: "running" }) },
      });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    const items = h.useStore.getState().rpc[T]!.items;
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(true);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("stall auto-continue")),
    ).toBe(false);
  });

  it("does not continue a user interrupt: the card cancels, no diagnostic, no prompt", async () => {
    const T = "tab-stall-c";
    h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
    const store = h.useStore.getState();
    store.handleRpcFrame(T, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    store.handleRpcFrame(T, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "on it" }],
        stopReason: "aborted",
      },
    });
    store.handleRpcFrame(T, { type: "agent_end" });
    await h.flushMicrotasks();
    const items = h.useStore.getState().rpc[T]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "cancelled" });
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
  });

  it("aborts cards on a non-stall error end, with no diagnostic and no continue", async () => {
    const T = "tab-stall-d";
    h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
    const store = h.useStore.getState();
    store.handleRpcFrame(T, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    store.handleRpcFrame(T, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "half done" }],
        stopReason: "error",
        errorMessage: "provider 500",
      },
    });
    store.handleRpcFrame(T, { type: "agent_end" });
    await h.flushMicrotasks();
    const items = h.useStore.getState().rpc[T]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "aborted" });
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
  });

  it("a watchdog abort notice feeds auto-continue", async () => {
    const T = "tab-stall-w1";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      // Main's stall watchdog aborted the turn and reported it (issue #253);
      // the tagged notice frame is the only stall marker — the turn itself
      // ends with stopReason "aborted", invisible to isStreamStallEnd.
      store.handleRpcFrame(T, {
        type: "omp_ui_notice",
        level: "warn",
        source: "omp-ui",
        reason: "stall-abort",
        message: "omp-ui aborted a stalled turn #1 — no stream events for 90s",
      });
      store.handleRpcFrame(T, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "half done" }],
          stopReason: "aborted",
        },
      });
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    const items = h.useStore.getState().rpc[T]!.items;
    // Main's notice is the diagnostic — no provider-stall diagnostic on top.
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
    expect(
      items.some(
        (i) =>
          i.kind === "notice" && i.level === "info" && i.text.includes("stall auto-continue #1"),
      ),
    ).toBe(true);
    const prompts = continuePrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
    // Consumed at the turn boundary: a later non-stall end must not continue.
    expect(h.useStore.getState().rpc[T]!.stallAbortPending ?? false).toBe(false);
  });

  it("the app switch also gates watchdog-abort continues", async () => {
    const T = "tab-stall-w2";
    vi.useFakeTimers();
    try {
      h.backendState = { ...h.backendState, stallAutoContinue: false };
      h.useStore.setState({
        state: h.backendState,
        rpc: { [T]: rpcTabState({ status: "running" }) },
      });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "omp_ui_notice",
        level: "warn",
        source: "omp-ui",
        reason: "stall-abort",
        message: "omp-ui aborted a stalled turn #1 — no stream events for 90s",
      });
      store.handleRpcFrame(T, {
        type: "message_end",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "half done" }],
          stopReason: "aborted",
        },
      });
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    const items = h.useStore.getState().rpc[T]!.items;
    // The abort report still lands in the transcript; only the continue is gated.
    expect(
      items.some(
        (i) =>
          i.kind === "notice" && i.level === "warn" && i.text.includes("aborted a stalled turn"),
      ),
    ).toBe(true);
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
  });

  it("an untagged omp_ui_notice does not arm auto-continue", async () => {
    const T = "tab-stall-w3";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "omp_ui_notice",
        level: "warn",
        source: "omp-ui",
        message: "omp-ui: some unrelated advisory",
      });
      store.handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();

    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(h.useStore.getState().rpc[T]!.stallAbortPending ?? false).toBe(false);
  });

  it("caps consecutive continues, then re-arms on a user prompt", async () => {
    const T = "tab-stall-e";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      // One stalled turn end: the continue prompt goes out, then its turn
      // (simulated) dies to a stall again.
      const stalledTurn = async () => {
        h.useStore.setState((s) => ({
          rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
        }));
        h.useStore.getState().handleRpcFrame(T, stallEndFrame());
        h.useStore.getState().handleRpcFrame(T, { type: "agent_end" });
        await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      };

      await stalledTurn();
      expect(continuePrompts()).toHaveLength(1);
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(2);

      // A third consecutive stall hits the cap: explained once, nothing sent.
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(2);
      const capped = h.useStore
        .getState()
        .rpc[T]!.items.filter(
          (i) => i.kind === "notice" && i.text === STALL_CONTINUE_CAP_NOTICE,
        );
      expect(capped).toHaveLength(1);

      // The OS-notification cap report latched exactly once, and clears on the
      // user prompt that re-arms the guard.
      expect(h.mockBackend.reportStallCap).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.reportStallCap).toHaveBeenCalledWith(T, true);

      // The per-session stall counter (issue #100 numbering) advanced across
      // stalls — stallNotice must mutate the live tab, not the frame-start
      // capture the ready patch above it replaced.
      const stallNotices = h.useStore
        .getState()
        .rpc[T]!.items.filter(
          (i): i is NoticeItem =>
            i.kind === "notice" && i.text.includes("provider stream stall"),
        );
      expect(stallNotices.map((n) => n.text)).toEqual([
        expect.stringContaining("provider stream stall #1"),
        expect.stringContaining("provider stream stall #2"),
        expect.stringContaining("provider stream stall #3"),
      ]);

      // A user prompt re-arms the guard: the next stall gets its continue.
      void h.useStore.getState().sendPrompt(T, "carry on");
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(3);
      expect(h.mockBackend.reportStallCap).toHaveBeenCalledTimes(2);
      expect(h.mockBackend.reportStallCap).toHaveBeenLastCalledWith(T, false);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
  });

  it("a user prompt inside the settle window wins the race", async () => {
    const T = "tab-stall-f";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      // The user sees the error and types their own continuation.
      void h.useStore.getState().sendPrompt(T, "carry on where you stopped");
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    const prompts = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd.message).toBe("carry on where you stopped");
  });

  it("does not dispatch into a process that died inside the settle window", async () => {
    const T = "tab-stall-g";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      // The session process dies before the settle window closes.
      h.useStore.setState((s) => ({ exited: { ...s.exited, [T]: 1 } }));
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
  });

  it("the auto-continue does not reset the advisor-reply streak", async () => {
    const T = "tab-stall-h";
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      // The production sequence, load-bearing for the advisor watcher's cursor:
      // the reviewed turn's agent_end lands while the tab still reads running
      // (seeding the baseline past the marker), then the review arrives on the
      // idle session.
      const review = async (note: string) => {
        h.useStore.setState((s) => ({
          rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
        }));
        h.useStore.getState().handleRpcFrame(T, { type: "agent_end" });
        h.useStore.getState().handleRpcFrame(T, {
          type: "message_end",
          message: {
            role: "custom",
            customType: "advisor",
            content: "<advisory/>",
            details: { notes: [{ note, severity: "concern", advisor: "ops" }] },
          },
        });
        await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      };
      const advisorReplies = () =>
        h.sent.filter(
          (s) => s.cmd.type === "prompt" && String(s.cmd.message).startsWith(ADVISOR_REPLY_LEAD),
        );

      // Two reviews fill the reply guard's budget.
      await review("first finding");
      expect(advisorReplies()).toHaveLength(1);
      await review("second finding");
      expect(advisorReplies()).toHaveLength(2);

      // A stall end dispatches its continue; the advisor guard must not reset.
      h.useStore.setState((s) => ({
        rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
      }));
      h.useStore.getState().handleRpcFrame(T, stallEndFrame());
      h.useStore.getState().handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      expect(continuePrompts()).toHaveLength(1);

      // A third review arrives: the guard is still capped, so it explains
      // instead of answering. Had the continue reset it, the reply would go out.
      await review("third finding");
      expect(advisorReplies()).toHaveLength(2);
      const capNotice = h.useStore.getState().rpc[T]!.items.find(
        (i) => i.kind === "notice" && i.text === ADVISOR_REPLY_CAP_NOTICE,
      );
      expect(capNotice).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    await h.flushMicrotasks();
  });
});

describe("auto-title gating (setInitialPrompt)", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: { [h.TAB]: rpcTabState({ status: "running" }) },
    });
    h.sent.length = 0;
  });

  it("renames immediately from a substantive first prompt, no agent_end needed", async () => {
    h.useStore.getState().setInitialPrompt(h.TAB, "Refactor the auth module");
    // Latched and phase-1 sent synchronously — the derived name goes out as
    // soon as the prompt is offered, not when the first run ends.
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBe(
      "Refactor the auth module",
    );
    expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(true);
    await h.flushMicrotasks();
    const renames = h.sent.filter((s) => s.cmd.type === "set_session_name");
    expect(renames).toHaveLength(1);
    expect(renames[0]!.cmd.name).toBe("Refactor the auth module");
    // Ack the derived send; the default model mock (null) means no upgrade.
    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Refactor the auth module",
    );
  });

  it("defers on a greeting, then titles from the next real prompt", async () => {
    h.useStore.getState().setInitialPrompt(h.TAB, "hi!");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(false);

    // agent_end on the greeting turn must not name the session.
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    expect(h.sent.find((s) => s.cmd.type === "set_session_name")).toBeUndefined();

    h.useStore
      .getState()
      .setInitialPrompt(h.TAB, "Add pagination to the sessions list");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    const rename = h.sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Add pagination to the sessions list");
  });

  it("keeps the first substantive prompt as the title source", () => {
    // The first prompt latches and renames; a second prompt must not displace it.
    h.useStore.getState().setInitialPrompt(h.TAB, "Fix the login redirect");
    h.useStore.getState().setInitialPrompt(h.TAB, "Actually, fix logout too");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBe(
      "Fix the login redirect",
    );
    expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(true);
  });

  it("never titles a session that already has a user-visible name", async () => {
    const base = h.stateWithRecord("sess-1");
    h.backendState = {
      ...base,
      projects: [
        {
          ...base.projects[0]!,
          sessions: [
            { ...base.projects[0]!.sessions[0]!, title: "My Named Session" },
          ],
        },
      ],
    };
    h.useStore.setState({ state: h.backendState });

    h.useStore.getState().setInitialPrompt(h.TAB, "Refactor the auth module");

    // Latched closed: no source captured, and no later prompt can reopen it.
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(true);
    h.useStore.getState().setInitialPrompt(h.TAB, "Add pagination to the list");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    expect(h.sent.find((s) => s.cmd.type === "set_session_name")).toBeUndefined();
  });

  it("titles a session whose record is still the 'New session' placeholder", async () => {
    h.useStore.getState().setInitialPrompt(h.TAB, "Create a login page with OAuth");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    const rename = h.sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Create a login page with OAuth");
  });

  it("titles from the captured prompt even if omp renamed mid-turn", async () => {
    h.useStore.getState().setInitialPrompt(h.TAB, "Build a feature for the app");
    const base = h.stateWithRecord("sess-1");
    h.backendState = {
      ...base,
      projects: [
        {
          ...base.projects[0]!,
          sessions: [
            { ...base.projects[0]!.sessions[0]!, title: "Some other title" },
          ],
        },
      ],
    };
    h.useStore.setState({ state: h.backendState });

    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    const rename = h.sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Build a feature for the app");
  });
});

describe("auto-title end-to-end", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: { [h.TAB]: rpcTabState({ status: "running" }) },
    });
    h.sent.length = 0;
  });

  it("sends set_session_name once, then clears the stored prompt", async () => {
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, "Create a login page with OAuth");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();

    // Deferred so phase 2 settles after the phase-1 ack, not ahead of it.
    const rename = h.sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Create a login page with OAuth");

    for (const { tabId: tid, cmd } of h.sent.splice(0)) h.respond(tid, cmd, {});
    await h.flushMicrotasks();
    model.resolve(null);
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Create a login page with OAuth",
    );

    // A later turn must not rename again.
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    expect(
      h.sent.splice(0).find((s) => s.cmd.type === "set_session_name"),
    ).toBeUndefined();
  });

  it("retries on the next agent_end when set_session_name fails", async () => {
    h.useStore.getState().setInitialPrompt(h.TAB, "Add a new API endpoint");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();

    const firstBatch = h.sent.splice(0);
    expect(
      firstBatch.find((s) => s.cmd.type === "set_session_name"),
    ).toBeTruthy();
    for (const { tabId: tid, cmd } of firstBatch) {
      const ok = cmd.type !== "set_session_name";
      h.respond(tid, cmd, ok ? {} : "rejected", ok);
    }
    await h.flushMicrotasks();

    expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(false);
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBe(
      "Add a new API endpoint",
    );

    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();
    expect(
      h.sent.splice(0).find((s) => s.cmd.type === "set_session_name"),
    ).toBeTruthy();
  });

  it("titles from omp's small model rather than the raw prompt", async () => {
    // The model title is a background upgrade: two sends, the derived name
    // first, the model's summary second.
    const prompt = "can you add pagination to the sessions list please";
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, prompt);
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();

    expect(
      h.sent.filter((s) => s.cmd.type === "set_session_name"),
    ).toHaveLength(1);
    expect(
      h.sent.filter((s) => s.cmd.type === "set_session_name").at(0)!.cmd.name,
    ).toBe(generateTitleFromPrompt(prompt));

    const wave1 = h.sent.splice(0);
    for (const { tabId, cmd } of wave1) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    model.resolve("Add sessions list pagination");
    await h.flushMicrotasks();
    const wave2 = h.sent.splice(0);
    const renames = [...wave1, ...wave2].filter(
      (s) => s.cmd.type === "set_session_name",
    );
    expect(renames).toHaveLength(2);
    expect(renames[0]!.cmd.name).toBe(generateTitleFromPrompt(prompt));
    expect(renames[1]!.cmd.name).toBe("Add sessions list pagination");
    for (const { tabId, cmd } of wave2) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();

    expect(h.mockBackend.generateTitle).toHaveBeenCalledWith("/p", prompt);
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Add sessions list pagination",
    );
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
  });

  it("falls back to the derived title when the model declines", async () => {
    // null covers every failure path in main: no omp, bad model, timeout,
    // or a `<title/>` answer. The session is already named by phase 1, so
    // the decline only forgoes the upgrade.
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, "Can you fix the login redirect");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();

    const wave1 = h.sent.splice(0);
    for (const { tabId, cmd } of wave1) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    model.resolve(null);
    await h.flushMicrotasks();

    const renames = [...wave1, ...h.sent].filter(
      (s) => s.cmd.type === "set_session_name",
    );
    expect(renames).toHaveLength(1);
    expect(renames[0]!.cmd.name).toBe("Fix the login redirect");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Fix the login redirect",
    );
  });

  it("falls back to the derived title when the model call rejects", async () => {
    let rejectModel!: (err: unknown) => void;
    const model = new Promise<string | null>((_resolve, reject) => {
      rejectModel = reject;
    });
    h.mockBackend.generateTitle.mockReturnValueOnce(model);
    h.useStore.getState().setInitialPrompt(h.TAB, "Refactor the auth module");
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    await h.flushMicrotasks();

    const wave1 = h.sent.splice(0);
    for (const { tabId, cmd } of wave1) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    rejectModel(new Error("ipc died"));
    await h.flushMicrotasks();

    const renames = [...wave1, ...h.sent].filter(
      (s) => s.cmd.type === "set_session_name",
    );
    expect(renames).toHaveLength(1);
    expect(renames[0]!.cmd.name).toBe("Refactor the auth module");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Refactor the auth module",
    );
  });

  it("sends the derived name before the model resolves", async () => {
    const prompt = "Can you fix the login redirect";
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, prompt);
    await h.flushMicrotasks();

    // Phase 1 is already in flight while the model is still pending.
    expect(
      h.sent.filter((s) => s.cmd.type === "set_session_name"),
    ).toHaveLength(1);
    expect(
      h.sent.filter((s) => s.cmd.type === "set_session_name").at(0)!.cmd.name,
    ).toBe("Fix the login redirect");

    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();

    model.resolve("Fix the login redirect race");
    await h.flushMicrotasks();
    expect(
      h.sent.filter((s) => s.cmd.type === "set_session_name"),
    ).toHaveLength(1);
    expect(
      h.sent.filter((s) => s.cmd.type === "set_session_name").at(0)!.cmd.name,
    ).toBe("Fix the login redirect race");

    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Fix the login redirect race",
    );
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
  });

  it("skips the upgrade when the model title equals the derived name", async () => {
    const prompt = "Create a login page with OAuth";
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, prompt);
    await h.flushMicrotasks();

    const wave1 = h.sent.splice(0);
    for (const { tabId, cmd } of wave1) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    model.resolve(generateTitleFromPrompt(prompt));
    await h.flushMicrotasks();

    const renames = [...wave1, ...h.sent].filter(
      (s) => s.cmd.type === "set_session_name",
    );
    expect(renames).toHaveLength(1);
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      generateTitleFromPrompt(prompt),
    );
  });

  it("does not upgrade after a manual rename in the interim", async () => {
    const prompt = "Refactor the auth module";
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, prompt);
    await h.flushMicrotasks();

    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();

    // The user's name is final: renameSessionTo clears initialPrompt, which
    // cancels the pending upgrade.
    const manual = h.useStore.getState().renameSessionTo(h.TAB, "My name");
    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await manual;
    await h.flushMicrotasks();

    model.resolve("Model upgrade attempt");
    await h.flushMicrotasks();

    expect(
      h.sent.filter(
        (s) =>
          s.cmd.type === "set_session_name" && s.cmd.name === "Model upgrade attempt",
      ),
    ).toHaveLength(0);
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
  });

  it("does not title a replacement session after /new", async () => {
    const prompt = "Refactor the auth module";
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, prompt);
    await h.flushMicrotasks();

    const wave1 = h.sent.splice(0);
    for (const { tabId, cmd } of wave1) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();

    // A /new or /branch while the model thought: the record now points at a
    // different session — the upgrade must not name it.
    h.backendState = h.stateWithRecord("sess-2");
    h.useStore.setState({ state: h.backendState });

    model.resolve("Model upgrade attempt");
    await h.flushMicrotasks();

    // Phase 1 already went out; the upgrade never reached the wire.
    const totalRenames = [...wave1, ...h.sent].filter(
      (s) => s.cmd.type === "set_session_name",
    );
    expect(totalRenames).toHaveLength(1);
  });

  it("keeps the derived name when the upgrade is rejected", async () => {
    const prompt = "Refactor the auth module";
    const model = h.deferred<string | null>();
    h.mockBackend.generateTitle.mockReturnValueOnce(model.promise);
    h.useStore.getState().setInitialPrompt(h.TAB, prompt);
    await h.flushMicrotasks();

    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await h.flushMicrotasks();
    model.resolve("Model upgrade attempt");
    await h.flushMicrotasks();

    // A future omp that refuses the user→user overwrite degrades to the
    // derived name standing; the titling still settles.
    for (const { tabId, cmd } of h.sent.splice(0)) {
      const ok = cmd.type !== "set_session_name";
      h.respond(tabId, cmd, ok ? {} : "rejected", ok);
    }
    await h.flushMicrotasks();

    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    expect(h.useStore.getState().rpc[h.TAB]!.autoTitleSent).toBe(
      "Refactor the auth module",
    );
    expect(h.useStore.getState().rpc[h.TAB]!.hasRenamed).toBe(true);
  });
});

describe("prompting, slash commands, and session ops", () => {
  beforeEach(() => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpcTabState() } });
    h.sent.length = 0;
  });

  /** Answers every outstanding command with `data`, so a method promise settles. */
  const settleAll = async (data: unknown = {}): Promise<void> => {
    for (let wave = 0; wave < 3; wave++) {
      await h.flushMicrotasks();
      for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, data);
    }
  };

  it("sendPrompt always sends the prompt frame, with steer as the streaming behaviour", async () => {
    const ready = h.useStore.getState().sendPrompt(h.TAB, "do the thing");
    // Phase 1 of auto-titling also sends on the first prompt, so select the
    // prompt frame by type rather than by position.
    const frame = h.sent.find((s) => s.cmd.type === "prompt");
    expect(frame).toBeDefined();
    expect(frame!.cmd).toMatchObject({
      type: "prompt",
      message: "do the thing",
      streamingBehavior: "steer",
    });
    await settleAll();
    await expect(ready).resolves.toBe(true);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
    const steering = h.useStore.getState().sendPrompt(h.TAB, "actually, wait");
    const steerFrame = h.sent.find((s) => s.cmd.type === "prompt");
    expect(steerFrame!.cmd).toMatchObject({
      type: "prompt",
      message: "actually, wait",
      streamingBehavior: "steer",
    });
    await settleAll();
    await expect(steering).resolves.toBe(true);
  });

  it("sendPrompt returns false when no command is accepted (issue #283)", async () => {
    h.useStore.setState({ rpc: {} });
    await expect(h.useStore.getState().sendPrompt(h.TAB, "missing")).resolves.toBe(false);
    expect(h.sent).toHaveLength(0);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "starting" }) } });
    await expect(h.useStore.getState().sendPrompt(h.TAB, "starting")).resolves.toBe(false);
    expect(h.sent).toHaveLength(0);

    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "ready" }) } });
    const failed = h.useStore.getState().sendPrompt(h.TAB, "rejected");
    const promptFrame = h.sent.find((s) => s.cmd.type === "prompt");
    h.respond(h.TAB, promptFrame!.cmd, "prompt rejected", false);
    await expect(failed).resolves.toBe(false);
  });

  it("sendPrompt honours an explicit follow_up route while running", async () => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
    const promise = h.useStore
      .getState()
      .sendPrompt(h.TAB, "and then this", "follow_up");
    const followFrame = h.sent.find((s) => s.cmd.type === "prompt");
    expect(followFrame!.cmd).toMatchObject({
      type: "prompt",
      message: "and then this",
      streamingBehavior: "followUp",
    });
    await settleAll();
    await promise;
  });

  it("sendPrompt feeds the auto-titler immediately, no agent_end needed", async () => {
    const promise = h.useStore
      .getState()
      .sendPrompt(h.TAB, "Refactor the auth module");
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBe(
      "Refactor the auth module",
    );
    // Flush once so the async rename's set_session_name lands, then capture it
    // before settleAll consumes the sent queue.
    await h.flushMicrotasks();
    const rename = h.sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Refactor the auth module");
    // settleAll answers the prompt (and the rename) so sendPrompt resolves.
    await settleAll();
    await promise;
  });

  it("runSlashCommand normalizes the leading slash and never titles", async () => {
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "advisor on");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/advisor on",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /new opens a new session tab instead of prompting omp", async () => {
    h.backendState = h.stateWithRecord(null);
    const project = h.backendState.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = null;
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    h.useStore.setState({
      state: h.backendState,
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().runSlashCommand(h.TAB, "/new");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
    });
    expect(h.sent).toEqual([]); // nothing reached omp
    expect(h.useStore.getState().activeTabId).toBe("fresh-tab");
  });

  it("runSlashCommand forwards /new with arguments to omp", async () => {
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/new later");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/new later",
    });
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /new falls back to omp when the tab is unknown", async () => {
    h.useStore.setState({ tabs: [] });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/new");
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/new" });
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan toggles plan mode on instead of prompting omp", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan");
    // The configured plan format rides the `on` command (issue #109).
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on html",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.initialPrompt).toBeNull();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan on matches the bare toggle", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan on");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on html",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan carries the markdown format when that is the setting", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
      state: { ...h.stateWithRecord("s1"), planFormat: "md" },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on md",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan off exits plan mode", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan off");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan off",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /no-plan exits plan mode", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [h.TAB]: rpcTabState() },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/no-plan");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan off",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand forwards /plan with arguments to omp", async () => {
    const promise = h.useStore
      .getState()
      .runSlashCommand(h.TAB, "/plan rewrite auth");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/plan rewrite auth",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand forwards /plan from a pty tab to its TUI", async () => {
    h.useStore.setState({
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "pty", projectCwd: "/p", hidden: false }),
      ],
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/plan");
    expect(h.sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/plan" });
    await settleAll();
    await promise;
  });

  /** Advertises commands so the echo path treats them as known (issue #241). */
  const seedCommands = (
    ...commands: Array<{ name: string; aliases?: string[] }>
  ): void => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: commands.map((c) => ({ ...c, description: "" })),
        }),
      },
    });
  };

  it("runSlashCommand echoes an advertised command and settles done when no agent ran", async () => {
    seedCommands({ name: "usage" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/usage");
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "usage",
      args: "",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("runSlashCommand matches aliases and marks the row agent when a turn starts", async () => {
    seedCommands({ name: "usage", aliases: ["cost"] });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/cost this month");
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "cost",
      args: "this month",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: true });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "agent",
    });
  });

  it("refreshes usage after an advertised soft compact command", async () => {
    seedCommands({ name: "compact", aliases: ["shrink"] });
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({
          commands: [
            { name: "compact", aliases: ["shrink"], description: "" },
          ],
          session: {
            ...emptySessionRuntime(),
            contextUsage: {
              tokens: 210049,
              contextWindow: 256000,
              percent: 82.1,
            },
          },
        }),
      },
    });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/shrink soft");
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await h.flushMicrotasks();
    const state = h.sent.find((s) => s.cmd.type === "get_state");
    const stats = h.sent.find((s) => s.cmd.type === "get_session_stats");
    expect(state).toBeDefined();
    expect(stats).toBeDefined();
    h.respond(h.TAB, state!.cmd, {
      contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
    });
    h.respond(h.TAB, stats!.cmd, {
      userMessages: 2,
      assistantMessages: 3,
      tokens: { input: 10, output: 20, total: 30 },
      cost: 0.5,
    });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(
      47247,
    );
  });

  it("does not refresh usage after a failed compact command", async () => {
    seedCommands({ name: "compact" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/compact soft");
    h.respond(h.TAB, h.sent[0]!.cmd, "compaction failed", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "failed",
    });
    expect(h.sent.some((s) => s.cmd.type === "get_state")).toBe(false);
    expect(h.sent.some((s) => s.cmd.type === "get_session_stats")).toBe(false);
  });

  it("keeps a completed compact command when half the usage refresh fails", async () => {
    seedCommands({ name: "compact" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/compact soft");
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await h.flushMicrotasks();
    const state = h.sent.find((s) => s.cmd.type === "get_state");
    const stats = h.sent.find((s) => s.cmd.type === "get_session_stats");
    h.respond(h.TAB, state!.cmd, {
      contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
    });
    h.respond(h.TAB, stats!.cmd, "stats unavailable", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(
      47247,
    );
  });

  it("runSlashCommand settles failed with omp's own error text", async () => {
    seedCommands({ name: "usage" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/usage");
    h.respond(h.TAB, h.sent[0]!.cmd, "prompt rejected while streaming", false);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "failed",
      error: 'RPC command "prompt" failed: prompt rejected while streaming',
    });
  });

  it("a bare ack without agentInvoked stays running until prompt_result settles it", async () => {
    seedCommands({ name: "usage" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/usage");
    const cmd = h.sent[0]!.cmd;
    h.respond(h.TAB, cmd, {});
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "running",
    });
    // A foreign prompt_result must not settle it.
    h.useStore
      .getState()
      .handleRpcFrame(h.TAB, { type: "prompt_result", id: "other" });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      status: "running",
    });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "prompt_result",
      id: cmd.id,
      agentInvoked: false,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("a bare ack settles to agent on the tab's next agent_start", async () => {
    seedCommands({ name: "commit" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/commit");
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await promise;
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    const row = h.useStore
      .getState()
      .rpc[h.TAB]!.items.find((i) => i.kind === "command");
    expect(row).toMatchObject({ kind: "command", status: "agent" });
  });

  it("an unadvertised /word forwards as a literal prompt with no command row", async () => {
    const promise = h.useStore
      .getState()
      .runSlashCommand(h.TAB, "/nonexistent-xyz do it");
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/nonexistent-xyz do it",
    });
    expect(
      h.useStore.getState().rpc[h.TAB]!.items.some((i) => i.kind === "command"),
    ).toBe(false);
    await settleAll();
    await promise;
  });

  it("bare /mcp and /mcp list open the MCP manager instead of prompting omp", async () => {
    h.useStore.setState({
      mcpManager: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      projectCwd: "/p",
      tabId: h.TAB,
    });
    h.useStore.getState().closeMcpManager();
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp list");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      projectCwd: "/p",
      tabId: h.TAB,
    });
    h.useStore.getState().closeMcpManager();
  });

  it("other /mcp subcommands forward with the command lifecycle", async () => {
    h.useStore.setState({
      mcpManager: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    seedCommands({ name: "mcp" });
    const promise = h.useStore.getState().runSlashCommand(h.TAB, "/mcp reauth linear");
    expect(h.useStore.getState().mcpManager).toBeNull();
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/mcp reauth linear",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "mcp",
      args: "reauth linear",
      status: "running",
    });
    h.respond(h.TAB, h.sent[0]!.cmd, { agentInvoked: false });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("busy is true while a command is in flight and survives a concurrent one", async () => {
    const first = h.useStore.getState().rpcCommand(h.TAB, { type: "get_state" });
    const second = h.useStore
      .getState()
      .rpcCommand(h.TAB, { type: "get_session_stats" });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);

    const [a, b] = h.sent.splice(0);
    h.respond(h.TAB, a!.cmd, {});
    await first;
    // One settled, one still outstanding — busy must not drop yet.
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);
    h.respond(h.TAB, b!.cmd, {});
    await second;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it("keeps busy ref-counted when one loud command times out beside another", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const timeout = h.useStore.getState().runSlashCommand(h.TAB, "/compact");
      await vi.advanceTimersByTimeAsync(5_000);
      const success = h.useStore.getState().setThinkingLevel(h.TAB, "high");
      const surviving = h.sent.at(-1)!.cmd;

      await vi.advanceTimersByTimeAsync(25_000);
      await timeout;
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toMatchObject({
        message: expect.stringContaining('RPC command "prompt"'),
        kind: "command",
        fatal: false,
        command: "prompt",
        timeoutMs: 30_000,
        sessionStatus: "ready",
        liveState: "live",
        recovery: expect.stringMatching(
          /may still complete.*resending can duplicate work/,
        ),
      });
      expect(h.useStore.getState().rpc[h.TAB]!.pendingCommands.size).toBe(1);
      expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);
      expect(warn).toHaveBeenCalledOnce();

      h.respond(h.TAB, surviving, {});
      await success;
      expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("quiet commands never raise busy, so background sync can't strobe the sweeps", async () => {
    const promise = h.useStore
      .getState()
      .rpcCommand(h.TAB, { type: "get_subagents" }, { quiet: true });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
    h.respond(h.TAB, h.sent.pop()!.cmd, { subagents: [] });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it("a quiet timeout posts one dim notice and never paints the session failure (issue #302)", async () => {
    const T = "wedge-tab-1";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const promise = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await promise;
      const tab = h.useStore.getState().rpc[T]!;
      expect(tab.failure).toBeUndefined();
      expect(tab.busy).toBe(false);
      expect(warn).toHaveBeenCalledWith(
        "[rpc] command timeout",
        expect.objectContaining({
          command: "get_subagents",
          pendingCommandCount: 0,
          pending: [],
        }),
      );
      const notices = tab.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!).toMatchObject({
        kind: "notice",
        level: "info",
        text: 'background "get_subagents" timed out after 30.0s — no other command in flight',
      });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("coalesces repeated quiet timeouts in one wedge episode to a single notice (issue #302)", async () => {
    const T = "wedge-tab-2";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = h.useStore.getState().refreshState(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      const second = h.useStore.getState().refreshStats(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await second;
      const tab = h.useStore.getState().rpc[T]!;
      expect(tab.failure).toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(2);
      const notices = tab.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toContain('background "get_state" timed out after 30.0s');
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a quiet timeout names the command still holding the chain, beside its loud banner (issue #302)", async () => {
    const T = "wedge-tab-3";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): compact t=0, heartbeat t=5, compact budget t=30,
      // heartbeat budget t=35.
      const wedge = h.useStore.getState().compactSession(T);
      await vi.advanceTimersByTimeAsync(5_000);
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(25_000);
      await wedge;
      const banner = h.useStore.getState().rpc[T]!.failure;
      expect(banner).toMatchObject({ command: "compact", kind: "command", fatal: false });
      await vi.advanceTimersByTimeAsync(5_000);
      await quiet;
      expect(h.useStore.getState().rpc[T]!.failure).toBe(banner);
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — queued behind compact (timed out 5.0s ago, response not yet observed)',
      );
      expect(warn).toHaveBeenNthCalledWith(
        1,
        "[rpc] command timeout",
        expect.objectContaining({
          command: "compact",
          pendingCommandCount: 1,
          pending: [{ command: "get_subagents", quiet: true, elapsedMs: 25_000 }],
        }),
      );
      expect(warn).toHaveBeenNthCalledWith(
        2,
        "[rpc] command timeout",
        expect.objectContaining({ command: "get_subagents", pending: [] }),
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("re-arms the quiet-failure notice on a quiet success; loud failures survive quiet timeouts (issue #302)", async () => {
    const T = "wedge-tab-4";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const first = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await first;
      const ok = h.useStore.getState().refreshState(T);
      h.respond(T, h.sent.pop()!.cmd, {});
      await ok;
      const second = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await second;
      expect(
        h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice"),
      ).toHaveLength(2);
      const failed = h.useStore.getState().setThinkingLevel(T, "high");
      h.respond(T, h.sent.pop()!.cmd, "unknown level", false);
      await failed;
      const transient = h.useStore.getState().rpc[T]!.failure;
      expect(transient).toBeDefined();
      const third = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await third;
      expect(h.useStore.getState().rpc[T]!.failure).toBe(transient);
      expect(
        h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice"),
      ).toHaveLength(2);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a late response retires the timed-out holder before the quiet timeout attributes it (issue #302)", async () => {
    const T = "wedge-tab-5";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, heartbeat t=5, set_model budget t=30,
      // late response t=32, heartbeat budget t=35.
      const wedge = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typed = expect(wedge).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(27_000);
      await typed;
      // The holder's late response arrives before the victim's budget: the
      // chain provably moved past it, so attribution must not fire (issue #302).
      h.useStore.getState().handleRpcFrame(T, {
        type: "response",
        id: h.sent[0]!.cmd.id,
        command: "set_model",
        success: true,
        data: {},
      });
      await vi.advanceTimersByTimeAsync(3_000);
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — no other command in flight',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a bash success does not retire the attribution: it bypasses the serial chain (issue #302)", async () => {
    const T = "wedge-tab-6";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, its budget t=30, bash t=32
      // (completes at t=32), heartbeat t=32, heartbeat budget t=62.
      const wedge = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typed = expect(wedge).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(32_000);
      await typed;
      const bash = h.useStore.getState().rpcCommand(T, { type: "bash", command: "true" });
      const bCmd = h.sent.at(-1)!.cmd;
      h.respond(T, bCmd, {});
      await bash; // completes — but it never queued, so it proves nothing (issue #302)
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(33_000);
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — queued behind set_model (timed out 32.0s ago, response not yet observed)',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a non-bash success retires earlier timeouts: the chain provably drained (issue #302)", async () => {
    const T = "wedge-tab-7";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, its budget t=30, set_steering_mode t=32
      // (completes at t=32), heartbeat t=32, heartbeat budget t=62.
      const wedge = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typed = expect(wedge).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(32_000);
      await typed;
      const loud = h.useStore
        .getState()
        .rpcCommand(T, { type: "set_steering_mode", mode: "manual" });
      const lCmd = h.sent.at(-1)!.cmd;
      h.respond(T, lCmd, {});
      await loud; // its completion proves the chain drained past the wedge (issue #302)
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(33_000);
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — no other command in flight',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("attributes the earliest unretired timeout, the command executing while the rest queue (issue #302)", async () => {
    const T = "wedge-tab-8";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Timeline (issue #302): set_model t=0, set_steering_mode t=10, heartbeat t=15;
      // budgets fire at t=30, t=40, t=45.
      const first = h.useStore.getState().rpcCommand(T, { type: "set_model" });
      const typedFirst = expect(first).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(10_000);
      const second = h.useStore
        .getState()
        .rpcCommand(T, { type: "set_steering_mode", mode: "manual" });
      const typedSecond = expect(second).rejects.toBeInstanceOf(h.RpcCommandTimeoutError);
      await vi.advanceTimersByTimeAsync(5_000);
      const quiet = h.useStore.getState().refreshSubagents(T);
      await vi.advanceTimersByTimeAsync(30_000);
      await typedFirst;
      await typedSecond;
      await quiet;
      const notices = h.useStore.getState().rpc[T]!.items.filter((i) => i.kind === "notice");
      expect(notices).toHaveLength(1);
      expect(notices[0]!.text).toBe(
        'background "get_subagents" timed out after 30.0s — queued behind set_model (timed out 15.0s ago, response not yet observed)',
      );
      expect(notices[0]!.text).not.toContain("set_steering_mode");
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("a loud command's busy survives an interleaved quiet one settling", async () => {
    const loud = h.useStore.getState().rpcCommand(h.TAB, { type: "compact" });
    const quiet = h.useStore
      .getState()
      .rpcCommand(h.TAB, { type: "get_state" }, { quiet: true });
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);

    const [a, b] = h.sent.splice(0);
    // The quiet one settles first — busy must hold for the loud one.
    h.respond(h.TAB, b!.cmd, {});
    await quiet;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(true);
    h.respond(h.TAB, a!.cmd, {});
    await loud;
    expect(h.useStore.getState().rpc[h.TAB]!.busy).toBe(false);
  });

  it("a failed command records a nonfatal command failure", async () => {
    const promise = h.useStore.getState().setThinkingLevel(h.TAB, "high");
    const cmd = h.sent.pop()!.cmd;
    h.respond(h.TAB, cmd, "unknown level", false);
    await expect(promise).resolves.toBeUndefined();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.failure).toMatchObject({
      message: 'RPC command "set_thinking_level" failed: unknown level',
      kind: "command",
      fatal: false,
      command: "set_thinking_level",
      liveState: "live",
      sessionStatus: "ready",
      recovery: expect.stringMatching(/Refresh state/),
    });
    // A rejected setting must not wedge a live tab into the error state.
    expect(tab.status).toBe("ready");
    expect(tab.session.thinkingLevel).toBeNull();
  });

  it("a quiet success preserves a nonfatal failure until a loud command succeeds", async () => {
    const failed = h.useStore.getState().setThinkingLevel(h.TAB, "high");
    h.respond(h.TAB, h.sent.pop()!.cmd, "unknown level", false);
    await failed;
    const transient = h.useStore.getState().rpc[h.TAB]!.failure;

    const refresh = h.useStore.getState().refreshState(h.TAB);
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await refresh;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBe(transient);

    const recovered = h.useStore.getState().setThinkingLevel(h.TAB, "low");
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await recovered;
    expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
  });

  it("setModel sends provider + modelId, not the whole model object", async () => {
    const model = {
      id: "claude-opus-5",
      name: "Opus 5",
      provider: "anthropic",
    };
    const promise = h.useStore.getState().setModel(h.TAB, model);
    expect(h.sent[0]!.cmd).toMatchObject({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    await settleAll(model);
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.model).toMatchObject({
      id: "claude-opus-5",
    });
  });

  it("setModel remembers the model with the current thinking level", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [h.TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), thinkingLevel: "high" },
        }),
      },
    });
    const model = {
      id: "claude-opus-5",
      name: "Opus 5",
      provider: "anthropic",
    };
    const promise = h.useStore.getState().setModel(h.TAB, model);
    await settleAll(model);
    await promise;
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "anthropic/claude-opus-5",
      "high",
    );
  });

  it("setThinkingLevel remembers the level without changing the main model", async () => {
    h.useStore.setState({
      rpc: {
        [h.TAB]: rpcTabState({ model: { id: "m1", name: "M1", provider: "p" } }),
      },
    });
    const promise = h.useStore.getState().setThinkingLevel(h.TAB, "max");
    await settleAll({});
    await promise;
    expect(h.mockBackend.setSessionModel).toHaveBeenCalledWith(
      h.TAB,
      "p/m1",
      "max",
    );
  });

  it("setAdvisorModel persists the advisor tuple through one backend call", async () => {
    await h.useStore.getState().setAdvisorModel(h.TAB, "openrouter/a/b:high");
    expect(h.mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      h.TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
  });

  it("newSession uses the persisted mode and restores the last advisor tuple", async () => {
    h.backendState = h.stateWithRecord(null);
    const project = h.backendState.projects[0]!.project;
    project.lastAdvisor = false;
    project.lastAdvisorModel = "openrouter/a/b:high";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "new-tab" });
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
    });
  });

  it("newSession mode override wins without changing the persisted default", async () => {
    h.backendState = h.stateWithRecord(null);
    const project = h.backendState.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "openrouter/a/b:high";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "terminal-tab" });
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p", "pty");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
    });
    expect(h.mockBackend.setDefaultMode).not.toHaveBeenCalled();
  });

  it("newSession falls back to terminal mode without backend state", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fallback-tab" });
    h.useStore.setState({
      state: null,
      advisorDefaults: {
        "/p": { enabled: true, model: "openrouter/a/b:high" },
      },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
    });
  });

  it("newSession uses the app default advisor when the project has none (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "default-on-tab" });
    h.useStore.setState({
      state: { ...h.stateWithRecord(null), defaultAdvisor: true },
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
    });
  });

  it("the app default of false overrides omp config for new sessions (issue #174)", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "default-off-tab",
    });
    h.useStore.setState({
      state: h.stateWithRecord(null),
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
    });
  });

  it("exportHtml pushes the returned path as a notice", async () => {
    const promise = h.useStore.getState().exportHtml(h.TAB);
    await settleAll({ path: "/tmp/session.html" });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: "exported to /tmp/session.html",
        // The path rides along as data so the view can open/reveal the file
        // without parsing the text (issue #84).
        path: "/tmp/session.html",
      }),
    ]);
  });

  it("exportHtml without a path in the response leaves a plain notice", async () => {
    const promise = h.useStore.getState().exportHtml(h.TAB);
    await settleAll({});
    await promise;
    const [item] = h.useStore.getState().rpc[h.TAB]!.items;
    expect(item).toMatchObject({ kind: "notice", text: "export finished" });
    expect(item).not.toHaveProperty("path");
  });

  it("compactSession marks the transcript without pasting the summary into it", async () => {
    const promise = h.useStore.getState().compactSession(h.TAB);
    await settleAll({ summary: "x".repeat(5000) });
    await promise;
    const { items } = h.useStore.getState().rpc[h.TAB]!;
    expect(items.map((i) => i.kind)).toEqual(["marker", "marker"]);
    expect(JSON.stringify(items)).not.toContain("xxxx");
  });

  describe("automatic compaction usage convergence", () => {
    const seedUsage = (tokens = 210049): void => {
      h.useStore.setState({
        rpc: {
          [h.TAB]: rpcTabState({
            session: {
              ...emptySessionRuntime(),
              contextUsage: {
                tokens,
                contextWindow: 256000,
                percent: (tokens / 256000) * 100,
              },
            },
          }),
        },
      });
    };
    const stateRequests = (): Array<{ tabId: string; cmd: Record<string, unknown> }> =>
      h.sent.filter((request) => request.cmd.type === "get_state");
    const emitSuccessfulEnd = (tokensBefore = 210049): void =>
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "auto_compaction_end",
        result: { tokensBefore },
      });

    it("waits through a stale first snapshot and applies the reduced state", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        expect(stateRequests()).toHaveLength(1);
        expect(h.sent.filter((request) => request.cmd.type === "get_session_stats")).toHaveLength(1);
        h.respond(h.TAB, stateRequests()[0]!.cmd, {
          contextUsage: { tokens: 210049, contextWindow: 256000, percent: 82.1 },
        });
        await h.flushMicrotasks();
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(210049);
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS);
        expect(stateRequests()).toHaveLength(2);
        h.respond(h.TAB, stateRequests()[1]!.cmd, {
          contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
        });
        await h.flushMicrotasks();
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(47247);
        expect(h.useStore.getState().rpc[h.TAB]!.items).toContainEqual(
          expect.objectContaining({
            kind: "marker",
            label: "auto-compaction finished",
            tone: "copper",
          }),
        );
      } finally {
        vi.useRealTimers();
      }
    });

    it("applies a reduced first snapshot without scheduling a retry", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        h.respond(h.TAB, stateRequests()[0]!.cmd, {
          contextUsage: { tokens: 47247, contextWindow: 256000, percent: 18.5 },
        });
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 2);
        expect(stateRequests()).toHaveLength(1);
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(47247);
      } finally {
        vi.useRealTimers();
      }
    });

    it("bounds stale and failed snapshots to the configured attempt count", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        for (let attempt = 0; attempt < h.COMPACTION_USAGE_MAX_ATTEMPTS; attempt++) {
          const request = stateRequests()[attempt]!;
          h.respond(
            h.TAB,
            request.cmd,
            attempt % 2 === 0
              ? { contextUsage: { tokens: 210049, contextWindow: 256000, percent: 82.1 } }
              : "not ready",
            attempt % 2 === 0,
          );
          await h.flushMicrotasks();
          await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS);
        }
        expect(stateRequests()).toHaveLength(h.COMPACTION_USAGE_MAX_ATTEMPTS);
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 10);
        expect(stateRequests()).toHaveLength(h.COMPACTION_USAGE_MAX_ATTEMPTS);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not apply a response from a superseded compaction", async () => {
      vi.useFakeTimers();
      try {
        seedUsage();
        emitSuccessfulEnd();
        await h.flushMicrotasks();
        emitSuccessfulEnd(180000);
        await h.flushMicrotasks();
        const [older, newer] = stateRequests();
        h.respond(h.TAB, newer!.cmd, {
          contextUsage: { tokens: 50000, contextWindow: 256000, percent: 19.5 },
        });
        await h.flushMicrotasks();
        h.respond(h.TAB, older!.cmd, {
          contextUsage: { tokens: 40000, contextWindow: 256000, percent: 15.6 },
        });
        await h.flushMicrotasks();
        await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 2);
        expect(h.useStore.getState().rpc[h.TAB]!.session.contextUsage?.tokens).toBe(50000);
        expect(stateRequests()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("keeps one-shot behavior for aborted or malformed ends", async () => {
      vi.useFakeTimers();
      try {
        for (const frame of [
          { type: "auto_compaction_end", aborted: true, result: { tokensBefore: 210049 } },
          { type: "auto_compaction_end" },
        ]) {
          h.sent.length = 0;
          seedUsage();
          h.useStore.getState().handleRpcFrame(h.TAB, frame);
          await h.flushMicrotasks();
          expect(stateRequests()).toHaveLength(1);
          expect(h.sent.filter((request) => request.cmd.type === "get_session_stats")).toHaveLength(1);
          h.respond(h.TAB, stateRequests()[0]!.cmd, {});
          await h.flushMicrotasks();
          await vi.advanceTimersByTimeAsync(h.COMPACTION_USAGE_RETRY_MS * 10);
          expect(stateRequests()).toHaveLength(1);
        }
      } finally {
        vi.useRealTimers();
      }
    });
  });

  it("branchSession forks the transcript into a new tab and leaves the source untouched (issue #83)", async () => {
    const forked = {
      ...h.stateWithRecord("sess-fork").projects[0]!.sessions[0]!,
      tabId: "tab-fork",
    };
    h.backendState.projects[0]!.sessions.push(forked);
    h.mockBackend.forkSession.mockResolvedValueOnce({ tabId: "tab-fork" });
    h.useStore.setState({
      tabs: [
        tabInfo({
          tabId: h.TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: h.TAB,
    });

    await h.useStore.getState().branchSession(h.TAB);

    expect(h.mockBackend.forkSession).toHaveBeenCalledWith(h.TAB);
    // The fork opens through the normal resume path and takes focus.
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeTabId: "tab-fork",
        projectCwd: "/p",
        mode: "rpc-ui",
      }),
    );
    expect(h.useStore.getState().activeTabId).toBe("tab-fork");
    expect(h.useStore.getState().tabs.map((t) => t.tabId)).toEqual([
      h.TAB,
      "tab-fork",
    ]);
    // The source tab's transcript and runtime are exactly as they were.
    expect(h.useStore.getState().rpc[h.TAB]).toEqual(rpcTabState());
  });

  it("a failed branch alerts and changes nothing", async () => {
    h.mockBackend.forkSession.mockRejectedValueOnce(
      new Error("this session has no transcript to branch yet"),
    );
    h.useStore.setState({ activeTabId: h.TAB });

    await h.useStore.getState().branchSession(h.TAB);

    expect(h.alerts.at(-1)).toBe("this session has no transcript to branch yet");
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().activeTabId).toBe(h.TAB);
  });

  it("setTodos sends phases with tasks and re-reads the server's copy", async () => {
    const phases = [
      { phase: "Build", tasks: [{ content: "wire it", status: "pending" }] },
    ];
    const promise = h.useStore.getState().setTodos(h.TAB, phases);
    expect(h.sent[0]!.cmd).toMatchObject({ type: "set_todos", phases });
    await settleAll({ todoPhases: phases });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.todos).toEqual(phases);
  });

  it("refreshSubagents parses the roster", async () => {
    const promise = h.useStore.getState().refreshSubagents(h.TAB);
    await settleAll({
      subagents: [
        {
          id: "s1",
          agent: "scout",
          status: "running",
          description: "map the store",
        },
        { agent: "nameless" },
      ],
    });
    await promise;
    expect(h.useStore.getState().rpc[h.TAB]!.subagents).toEqual([
      {
        id: "s1",
        name: undefined,
        agent: "scout",
        status: "running",
        label: "map the store",
      },
    ]);
  });

  it("toggleConsole flips one tab's drawer without touching another's (issue #33)", () => {
    h.useStore.setState({ consoleOpen: {} });
    h.useStore.getState().toggleConsole(h.TAB);
    expect(h.useStore.getState().consoleOpen[h.TAB]).toBe(true);
    expect(h.useStore.getState().consoleOpen[`${h.TAB}-other`]).toBeUndefined();
    h.useStore.getState().toggleConsole(h.TAB);
    expect(h.useStore.getState().consoleOpen[h.TAB]).toBe(false);
  });

  it("openSearch/closeSearch set and clear one tab's find bar without touching another's (issue #270)", () => {
    h.useStore.setState({ searchOpen: {} });
    h.useStore.getState().openSearch(h.TAB);
    expect(h.useStore.getState().searchOpen[h.TAB]).toBe(true);
    expect(h.useStore.getState().searchOpen[`${h.TAB}-other`]).toBeUndefined();
    h.useStore.getState().closeSearch(h.TAB);
    expect(h.useStore.getState().searchOpen[h.TAB]).toBe(false);
    expect(h.useStore.getState().searchOpen[`${h.TAB}-other`]).toBeUndefined();
  });
});

describe("project default models (issue #257)", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  /** Review frame whose plan file read resolves — fresh spawns seed from it. */
  const openReviewWithPlan = (id: string) => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({
          title: "t",
          planFilePath: "local://p.md",
          planAbsPath: "/lineage/local/p.md",
        }),
    });
  };

  it("newSession boots the pinned advisor model ahead of last-used memory", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = "pin/advisor:high";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "pin-tab" });
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "pin/advisor:high",
      cols: 80,
      rows: 24,
    });
  });

  it("newSession falls back to the last-used advisor model when the pin is null", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = null;
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "last-tab" });
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: true, advisorModel: "last/advisor" }),
    );
  });

  it("newSession falls back to omp's configured advisor model when no app state exists", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "cfg-tab" });
    h.useStore.setState({
      state: null,
      advisorDefaults: { "/p": { enabled: true, model: "openrouter/a/b:high" } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: true, advisorModel: "openrouter/a/b:high" }),
    );
  });

  it("keeps the pinned advisor model while the on/off chain resolves off", async () => {
    // Inert-while-off is intended: the pin is a model value, and advisor
    // on/off keeps its own chain (issue #174).
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = false;
    project.defaultAdvisorModel = "p/pin";
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "dormant-tab" });
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "p/pin",
      cols: 80,
      rows: 24,
    });
  });

  it("plan dispatch in a fresh session: the staged advisor tuple beats the pin", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.defaultAdvisorModel = "pin/advisor";
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReviewWithPlan("pd1");
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-staged" });
    h.useStore.getState().executePlan(h.TAB, "fresh", {
      advisor: true,
      advisorModel: "staged/advisor",
    });
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: true, advisorModel: "staged/advisor" }),
    );
  });

  it("plan dispatch in a fresh session: the pin wins the fallback branch", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = "pin/advisor";
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });
    openReviewWithPlan("pd2");
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-pin" });
    h.useStore.getState().executePlan(h.TAB, "fresh");
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: false, advisorModel: "pin/advisor" }),
    );
  });

  it("pin setters forward to the backend channel", async () => {
    await h.useStore.getState().setProjectDefaultModel("/p", "p/m");
    expect(h.mockBackend.setProjectDefaultModel).toHaveBeenCalledWith("/p", "p/m");
    await h.useStore.getState().setProjectDefaultAdvisorModel("/p", null);
    expect(h.mockBackend.setProjectDefaultAdvisorModel).toHaveBeenCalledWith("/p", null);
  });
});

describe("settings", () => {
  it("opens on general by default, honours an explicit page, and closes back to null", () => {
    h.useStore.getState().openSettings();
    expect(h.useStore.getState().settingsPage).toBe("general");

    h.useStore.getState().openSettings("memory");
    expect(h.useStore.getState().settingsPage).toBe("memory");

    h.useStore.getState().closeSettings();
    expect(h.useStore.getState().settingsPage).toBeNull();
  });

  it("caches the effective compaction threshold per project (issue #249)", async () => {
    h.mockBackend.readOmpSettings.mockResolvedValueOnce({
      ...h.emptyOmpSettings,
      entries: [
        { key: "compaction.thresholdPercent", type: "number", description: "", value: -1, options: null, layer: "default" },
        { key: "compaction.thresholdTokens", type: "number", description: "", value: -1, options: null, layer: "default" },
      ],
    });

    await h.useStore.getState().ensureCompactionSettings("/p");

    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledWith("/p");
    expect(h.useStore.getState().compactionSettings["/p"]).toEqual({
      thresholdPercent: -1,
      thresholdTokens: -1,
    });

    // A second ensure is a cache hit — no second backend round trip.
    await h.useStore.getState().ensureCompactionSettings("/p");
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent compaction settings reads for one project", async () => {
    let resolveRead!: (snapshot: OmpSettingsSnapshot) => void;
    h.mockBackend.readOmpSettings.mockImplementationOnce(
      () => new Promise<OmpSettingsSnapshot>((resolve) => { resolveRead = resolve; }),
    );
    const inFlight = Promise.all([
      h.useStore.getState().ensureCompactionSettings("/p"),
      h.useStore.getState().ensureCompactionSettings("/p"),
    ]);
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    resolveRead(h.emptyOmpSettings);
    await inFlight;
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    expect(h.useStore.getState().compactionSettings["/p"]).toEqual({});
  });

  it("caches a failed compaction settings read as null, not a default", async () => {
    h.mockBackend.readOmpSettings.mockResolvedValueOnce({
      ...h.emptyOmpSettings,
      error: "omp binary not found",
    });

    await h.useStore.getState().ensureCompactionSettings("/p");

    expect(h.useStore.getState().compactionSettings["/p"]).toBeNull();
    // The failure is cached too: the next ensure must not hammer a missing
    // binary — the HUD only refetches after a compaction.* write or relaunch.
    await h.useStore.getState().ensureCompactionSettings("/p");
    expect(h.mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
  });

  it("clears the compaction cache on compaction.* writes only", async () => {
    await h.useStore.getState().ensureCompactionSettings("/p");
    expect("/p" in h.useStore.getState().compactionSettings).toBe(true);

    await h.useStore.getState().writeOmpSetting("advisor.enabled", true);
    expect("/p" in h.useStore.getState().compactionSettings).toBe(true);

    await h.useStore.getState().writeOmpSetting("compaction.thresholdPercent", 50);
    expect(h.useStore.getState().compactionSettings).toEqual({});
  });

  it("rejects writeOmpSetting to its caller instead of alerting", async () => {
    h.mockBackend.writeOmpSetting.mockRejectedValueOnce(
      new Error("unknown setting"),
    );

    // The omp settings page renders this inline, so the rejection must survive
    // the store rather than being swallowed into window.alert.
    await expect(
      h.useStore.getState().writeOmpSetting("advisor.enabled", true),
    ).rejects.toThrow("unknown setting");
    expect(h.alerts).toEqual([]);
  });
});

describe("remote access settings", () => {
  it("renders remote state only from the push, never an optimistic set", () => {
    // The pushed RemoteState IS the rendered one: main/remote-server.ts publishes a full state
    // per transition, so the store never patches a field itself.
    const push = (s: RemoteState): void => h.useStore.setState({ remote: s });
    push({ ...h.idleRemoteState, status: "starting", enabled: true });
    expect(h.useStore.getState().remote.status).toBe("starting");
    push({
      ...h.idleRemoteState,
      status: "listening",
      enabled: true,
      urls: ["http://127.0.0.1:4677/?t=t"],
    });
    expect(h.useStore.getState().remote.urls).toEqual([
      "http://127.0.0.1:4677/?t=t",
    ]);

    // An action's resolution changes nothing on its own — only the next push does.
    void h.useStore.getState().setRemoteEnabled(false);
    expect(h.useStore.getState().remote.enabled).toBe(true);
  });

  it("alerts a real remote-settings failure", async () => {
    h.mockBackend.setRemotePort.mockRejectedValueOnce(
      new Error("port must be a whole number between 1024 and 65535"),
    );
    await h.useStore.getState().setRemotePort(80);
    expect(h.alerts).toEqual([
      "port must be a whole number between 1024 and 65535",
    ]);
  });

  it("swallows the self-inflicted disconnect a remote client causes", async () => {
    // A REMOTE client changing bind/port/token restarts the server it is asking over, so its own
    // call never gets a reply. That is the requested outcome — the reconnect banner handles it,
    // and a modal alert would both lie and block the banner's reload.
    for (const [action, arg] of [
      ["setRemoteEnabled", true],
      ["setRemoteBind", "lan"],
      ["setRemotePort", 5000],
      ["regenerateRemoteToken", undefined],
      ["setRemotePassword", "short"],
      ["clearRemotePassword", undefined],
    ] as const) {
      h.mockBackend[action].mockRejectedValueOnce(
        new Error("remote connection lost"),
      );
      await (h.useStore.getState()[action] as (a?: unknown) => Promise<void>)(
        arg,
      );
    }
    expect(h.alerts).toEqual([]);
  });
});

describe("subagent marker coalescing, buffers, and drill-down (issues #62, #63)", () => {
  const THROTTLE_TAB = `${h.TAB}-throttle`;

  beforeEach(() => {
    h.useStore.setState({
      rpc: { [h.TAB]: rpcTabState(), [THROTTLE_TAB]: rpcTabState() },
    });
  });

  const heartbeat = (tabId: string, id: string, agent: string) =>
    h.useStore.getState().handleRpcFrame(tabId, {
      type: "subagent_progress",
      payload: { id, agent, progress: { status: "running" } },
    });

  const markerLabels = (tabId: string) =>
    h.useStore
      .getState()
      .rpc[tabId]!.items.filter((i) => i.kind === "marker")
      .map((i) => i.label);

  it("interleaved running heartbeats from two agents stamp exactly one marker each", () => {
    heartbeat(h.TAB, "a", "scout");
    heartbeat(h.TAB, "b", "task");
    heartbeat(h.TAB, "a", "scout");
    heartbeat(h.TAB, "b", "task");
    heartbeat(h.TAB, "a", "scout");
    expect(markerLabels(h.TAB)).toEqual([
      "subagent scout: running",
      "subagent task: running",
    ]);
  });

  it("a status change for one agent appends exactly one more marker, for that agent only", () => {
    heartbeat(h.TAB, "a", "scout");
    heartbeat(h.TAB, "b", "task");
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "subagent_lifecycle",
      payload: { id: "a", agent: "scout", status: "finished" },
    });
    heartbeat(h.TAB, "b", "task");
    expect(markerLabels(h.TAB)).toEqual([
      "subagent scout: running",
      "subagent task: running",
      "subagent scout: finished",
    ]);
  });

  it("heartbeat-driven roster refresh coalesces to one in-flight get_subagents, with a trailing call", async () => {
    vi.useFakeTimers();
    try {
      const rosterCalls = () =>
        h.sent.filter((s) => s.cmd.type === "get_subagents");
      heartbeat(THROTTLE_TAB, "a", "scout");
      expect(rosterCalls()).toHaveLength(1);
      // Frames landing mid-request only schedule the trailing call.
      heartbeat(THROTTLE_TAB, "a", "scout");
      heartbeat(THROTTLE_TAB, "b", "task");
      expect(rosterCalls()).toHaveLength(1);
      h.respond(THROTTLE_TAB, rosterCalls()[0]!.cmd, { subagents: [] });
      await h.flushMicrotasks();
      await vi.advanceTimersByTimeAsync(500);
      expect(rosterCalls()).toHaveLength(2);
      h.respond(THROTTLE_TAB, rosterCalls()[1]!.cmd, { subagents: [] });
      await h.flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2000);
      expect(rosterCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("event frames append to the per-agent buffer with dedupe and a 500-item cap", () => {
    const text = (t: string) =>
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "subagent_event",
        payload: { id: "a", text: t },
      });
    text("hello");
    text("hello");
    expect(h.useStore.getState().rpc[h.TAB]!.subagentItems?.a).toHaveLength(1);
    for (let i = 0; i < 505; i++) text(`note ${i}`);
    const buffer = h.useStore.getState().rpc[h.TAB]!.subagentItems!.a!;
    expect(buffer).toHaveLength(500);
    expect(buffer.at(-1)).toMatchObject({ text: "note 504" });
  });

  it("opening a detail escalates the subscription to events; closing drops back, without redundant sends", () => {
    const levels = () =>
      h.sent
        .filter((s) => s.cmd.type === "set_subagent_subscription")
        .map((s) => s.cmd.level);
    h.useStore.getState().openSubagent(h.TAB, "a");
    expect(h.useStore.getState().rpc[h.TAB]!.selectedSubagent).toBe("a");
    h.useStore.getState().openSubagent(h.TAB, "a");
    expect(levels()).toEqual(["events"]);
    h.useStore.getState().closeSubagent(h.TAB);
    h.useStore.getState().closeSubagent(h.TAB);
    expect(levels()).toEqual(["events", "progress"]);
    expect(h.useStore.getState().rpc[h.TAB]!.selectedSubagent).toBeNull();
  });

  it("a ready-frame re-boot sends progress, then re-escalates while a detail is open", async () => {
    // A dedicated tab id: an earlier suite leaves TAB's boot latch held, and
    // rpcBooting short-circuits a second bootRpcTab for the same tab.
    const REBOOT_TAB = `${h.TAB}-reboot`;
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({
      state: h.backendState,
      rpc: {
        [REBOOT_TAB]: rpcTabState({
          selectedSubagent: "a",
          subagentLevel: "events",
        }),
      },
    });
    const levels: unknown[] = [];
    const boot = h.useStore.getState().bootRpcTab(REBOOT_TAB);
    for (let wave = 0; wave < 6; wave++) {
      await h.flushMicrotasks();
      for (const { cmd } of h.sent.splice(0)) {
        if (cmd.type === "set_subagent_subscription") levels.push(cmd.level);
        h.respond(REBOOT_TAB, cmd, {});
      }
    }
    await boot;
    expect(levels).toEqual(["progress", "events"]);
    expect(h.useStore.getState().rpc[REBOOT_TAB]!.selectedSubagent).toBe("a");
  });

  it("openSubagent backfills the run's history from its transcript file", async () => {
    h.useStore.getState().openSubagent(h.TAB, "s1");
    expect(h.useStore.getState().rpc[h.TAB]!.selectedSubagent).toBe("s1");
    await h.flushMicrotasks();
    const cmds = h.sent.splice(0);
    const levels = cmds.filter((c) => c.cmd.type === "set_subagent_subscription");
    expect(levels.map((c) => c.cmd.level)).toEqual(["events"]);
    const backfill = cmds.find((c) => c.cmd.type === "get_subagent_messages");
    expect(backfill?.cmd.subagentId).toBe("s1");
    h.respond(h.TAB, backfill!.cmd, {
      sessionFile: "/x/s1.jsonl",
      fromByte: 0,
      nextByte: 100,
      reset: false,
      entries: [],
      messages: [
        { role: "user", content: [{ type: "text", text: "map the store" }] },
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
    });
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.subagentItems?.["s1"]).toEqual([
      expect.objectContaining({ kind: "user", text: "map the store" }),
      expect.objectContaining({ kind: "assistant", text: "done" }),
    ]);
  });

  it("openSubagent keeps the live buffer and raises no panel when backfill fails", async () => {
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "subagent_event",
      payload: { id: "s1", text: "live line" },
    });
    const before = h.useStore.getState().rpc[h.TAB]!.subagentItems?.["s1"];
    h.useStore.getState().openSubagent(h.TAB, "s1");
    await h.flushMicrotasks();
    const backfill = h.sent.splice(0).find((c) => c.cmd.type === "get_subagent_messages");
    h.respond(h.TAB, backfill!.cmd, "Unknown subagent or session file unavailable: s1", false);
    await h.flushMicrotasks();
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.subagentItems?.["s1"]).toEqual(before);
    expect(tab.failure).toBeUndefined();
  });

  it("drops a late backfill response when the selection moved on", async () => {
    h.useStore.getState().openSubagent(h.TAB, "s1");
    await h.flushMicrotasks();
    const stale = h.sent.splice(0).find((c) => c.cmd.type === "get_subagent_messages");
    h.useStore.getState().openSubagent(h.TAB, "s2");
    await h.flushMicrotasks();
    h.respond(h.TAB, stale!.cmd, {
      messages: [{ role: "user", content: [{ type: "text", text: "stale" }] }],
    });
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.subagentItems?.["s1"]).toBeUndefined();
  });

  it("re-selecting the open agent is a no-op", async () => {
    h.useStore.getState().openSubagent(h.TAB, "s1");
    await h.flushMicrotasks();
    h.sent.splice(0);
    h.useStore.getState().openSubagent(h.TAB, "s1");
    await h.flushMicrotasks();
    expect(h.sent.splice(0)).toEqual([]);
  });

  it("live frames for the viewed agent grow past the retained-buffer cap; others stay capped", () => {
    h.useStore.getState().openSubagent(h.TAB, "s1");
    for (let i = 0; i < 510; i++) {
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "subagent_event",
        payload: { id: "s1", text: `live ${i}` },
      });
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "subagent_event",
        payload: { id: "s2", text: `bg ${i}` },
      });
    }
    const buffers = h.useStore.getState().rpc[h.TAB]!.subagentItems!;
    expect(buffers["s1"]).toHaveLength(510);
    expect(buffers["s2"]).toHaveLength(500);
  });
});

describe("initialization snapshot ordering", () => {
  it("registers listeners first, starts all reads together, and commits only after the slowest", async () => {
    const stateRead = h.deferred<BackendState>();
    const appRead = h.deferred<AppUpdateState>();
    const ompRead = h.deferred<OmpUpdateState>();
    const remoteRead = h.deferred<RemoteState>();
    const initialState = makeBackendState();
    const initialApp = { ...h.idleAppUpdate, currentVersion: "9.8.7" };
    const initialOmp = { ...h.idleOmpUpdate, installedVersion: "1.2.3" };
    const initialRemote = { ...h.idleRemoteState, enabled: true };
    h.mockBackend.getState.mockImplementationOnce(() => stateRead.promise);
    h.mockBackend.getAppUpdateState.mockImplementationOnce(() => appRead.promise);
    h.mockBackend.getOmpUpdateState.mockImplementationOnce(() => ompRead.promise);
    h.mockBackend.getRemoteState.mockImplementationOnce(() => remoteRead.promise);
    // init's StrictMode latch is module-scoped; an earlier routing test initializes
    // the shared store, so this contract test intentionally needs a fresh evaluation.
    vi.resetModules();
    const { useStore: freshStore } = await import("./store");

    const init = freshStore.getState().init();
    const duplicate = freshStore.getState().init();

    const listeners = [
      h.mockBackend.onStateChanged,
      h.mockBackend.onPtyData,
      h.mockBackend.onPtyExit,
      h.mockBackend.onSessionHibernated,
      h.mockBackend.onShellData,
      h.mockBackend.onShellExit,
      h.mockBackend.onRpcFrame,
      h.mockBackend.onAppUpdateState,
      h.mockBackend.onOmpUpdateState,
      h.mockBackend.onRemoteState,
    ];
    const reads = [
      h.mockBackend.getState,
      h.mockBackend.getAppUpdateState,
      h.mockBackend.getOmpUpdateState,
      h.mockBackend.getRemoteState,
    ];
    expect(
      listeners.every((listener) => listener.mock.calls.length === 1),
    ).toBe(true);
    expect(reads.every((read) => read.mock.calls.length === 1)).toBe(true);
    expect(
      Math.max(
        ...listeners.map((listener) => listener.mock.invocationCallOrder[0]!),
      ),
    ).toBeLessThan(
      Math.min(...reads.map((read) => read.mock.invocationCallOrder[0]!)),
    );

    stateRead.resolve(initialState);
    appRead.resolve(initialApp);
    ompRead.resolve(initialOmp);
    await h.flushMicrotasks();
    expect(freshStore.getState()).toMatchObject({
      state: null,
      appUpdate: h.idleAppUpdate,
      ompUpdate: h.idleOmpUpdate,
      remote: { ...h.idleRemoteState, token: "" },
    });

    remoteRead.resolve(initialRemote);
    await Promise.all([init, duplicate]);
    expect(freshStore.getState()).toMatchObject({
      state: initialState,
      appUpdate: initialApp,
      ompUpdate: initialOmp,
      remote: initialRemote,
    });
  });
});

describe("transcript commit batching (issue #187)", () => {
  // The file-level window stub executes rAF synchronously so every other
  // suite sees committed items immediately. These tests capture the frame
  // instead and run it by hand, which is what proves the coalescing.
  let rafQueue: FrameRequestCallback[];
  let syncRaf: typeof window.requestAnimationFrame;
  let syncCancel: typeof window.cancelAnimationFrame;

  const runFrame = (): void => {
    const callbacks = rafQueue.splice(0);
    for (const cb of callbacks) cb(0);
  };

  const advisorFrame = (note: string) => ({
    type: "message_end",
    message: {
      role: "custom",
      customType: "advisor",
      content: "<advisory/>",
      details: { notes: [{ note, severity: "concern", advisor: "ops" }] },
    },
  });

  beforeEach(() => {
    rafQueue = [];
    syncRaf = window.requestAnimationFrame;
    syncCancel = window.cancelAnimationFrame;
    window.requestAnimationFrame = (cb: FrameRequestCallback): number =>
      rafQueue.push(cb);
    window.cancelAnimationFrame = (): void => {};
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  afterEach(() => {
    window.requestAnimationFrame = syncRaf;
    window.cancelAnimationFrame = syncCancel;
    // Never leak a pending batch into the next test's state.
    runFrame();
  });

  it("coalesces a burst of transcript frames into one render commit", () => {
    const commits: number[] = [];
    const unsub = h.useStore.subscribe((state, prev) => {
      if (state.rpc[h.TAB]?.items !== prev.rpc[h.TAB]?.items)
        commits.push(state.rpc[h.TAB]!.items.length);
    });
    try {
      const store = h.useStore.getState();
      store.handleRpcFrame(h.TAB, {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      });
      store.handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a" },
      });
      store.handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "b" },
      });
      // Nothing committed yet — the renderer stays free for input mid-burst.
      expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
      expect(rafQueue).toHaveLength(1);
      runFrame();
      expect(commits).toEqual([2]);
      const items = h.useStore.getState().rpc[h.TAB]!.items;
      expect(items[0]).toMatchObject({ kind: "user", text: "go" });
      expect(items[1]).toMatchObject({
        kind: "assistant",
        text: "ab",
        streaming: true,
      });
    } finally {
      unsub();
    }
  });

  it("commits each later burst separately with frame order preserved", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "q1" }] },
    });
    runFrame();
    store.handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "q2" }] },
    });
    expect(
      h.useStore.getState().rpc[h.TAB]!.items.map((i) => i.kind),
    ).toEqual(["user"]);
    runFrame();
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items.map((i) => (i.kind === "user" ? i.text : ""))).toEqual([
      "q1",
      "q2",
    ]);
  });

  it("keeps control frames immediate while a transcript commit is pending", async () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
    expect(rafQueue).toHaveLength(1);
    // A dialog request must not wait for the flush — omp blocks on its reply.
    store.handleRpcFrame(h.TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(h.useStore.getState().rpc[h.TAB]!.extensionQueue).toHaveLength(1);
    // A command response also resolves without waiting for the flush.
    const cmd = store.rpcCommand(h.TAB, { type: "get_state" });
    h.respond(h.TAB, h.sent.pop()!.cmd, {});
    await expect(cmd).resolves.toBeDefined();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
    runFrame();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
  });

  it("settles running tools from the pending batch on process death", () => {
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "make" },
    });
    // The card exists only in the pending batch.
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
    store.handleRpcFrame(h.TAB, { type: "omp_ui_error", message: "process gone" });
    const items = h.useStore.getState().rpc[h.TAB]!.items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "t1",
        status: "aborted",
      }),
    ]);
    // The aborted commit landed immediately; the dead batch is gone.
    runFrame();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toHaveLength(1);
  });

  it("drops a pending batch on relaunch so stale frames cannot land", async () => {
    h.useStore.setState({ state: h.stateWithRecord(null) });
    const store = h.useStore.getState();
    store.handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "old" },
    });
    expect(rafQueue).toHaveLength(1);
    h.mockBackend.restartSession.mockResolvedValueOnce(undefined);
    await store.restartSession(h.TAB);
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
    runFrame();
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);
  });

  it("feeds the advisor reply watcher from the pending batch, not the commit", async () => {
    vi.useFakeTimers();
    try {
      h.useStore.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
      const store = h.useStore.getState();
      store.handleRpcFrame(h.TAB, { type: "agent_end" });
      runFrame(); // commits only the "agent finished" marker
      store.handleRpcFrame(h.TAB, advisorFrame("Do it now"));
      // The advisory lives only in the pending batch — never flushed here.
      expect(
        h.useStore.getState().rpc[h.TAB]!.items.some((i) => i.kind === "advisory"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await h.flushMicrotasks();
      const replies = h.sent.filter((s) => s.cmd.type === "prompt");
      expect(replies).toHaveLength(1);
      expect(String(replies[0]!.cmd.message)).toContain("Do it now");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("live stream-stall indicator (issue #228)", () => {
  const BLOCK_EVENTS = [
    "text_start",
    "text_end",
    "thinking_start",
    "thinking_end",
  ] as const;

  const BLOCK_LABELS = [
    "text block started",
    "text block complete",
    "thinking block started",
    "thinking block complete",
  ] as const;

  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  /** agent_start plus an open assistant response: the stall gate is armed. */
  const openAssistant = (): void => {
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "turn_start" });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
  };

  afterEach(() => {
    // Terminate any armed interval before the fake clock is discarded; a
    // stale map entry would block re-arming in a later test.
    if (vi.isFakeTimers()) {
      h.useStore.setState({ rpc: {} });
      vi.advanceTimersByTime(1_000);
    }
    vi.useRealTimers();
  });

  it("pins the 30s threshold and 1Hz tick from the plan", () => {
    expect(h.STREAM_STALL_THRESHOLD_MS).toBe(30_000);
    expect(h.STREAM_STALL_TICK_MS).toBe(1_000);
  });

  it("arms at the threshold and ticks once per second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    vi.advanceTimersByTime(2_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS + 2_000,
    );
  });

  it("clears within one tick when a model-stream frame resumes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    vi.advanceTimersByTime(1_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });

  it("classifies each block start/end event as its own checkpoint", () => {
    vi.useFakeTimers();
    for (const [i, type] of BLOCK_EVENTS.entries()) {
      // A distinct time per event: an unclassified event would leave the
      // previous checkpoint in place and fail both assertions.
      vi.setSystemTime(1_000_000 + i * 10_000);
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      expect(h.useStore.getState().rpc[h.TAB]!.streamCheckpoint).toMatchObject({
        at: 1_000_000 + i * 10_000,
        label: BLOCK_LABELS[i],
      });
    }
  });

  it("publishes whole-second (floor) values for off-boundary checkpoints", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    // The response opens 37ms after the interval armed, so every 1s tick
    // boundary sees an off-boundary silence (ceil would overstate it).
    vi.advanceTimersByTime(37);
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    // Until the first tick that reaches the threshold (silence 30,963ms).
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS + 963);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("block start/end frames reset the silence clock mid-stall", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    for (const type of BLOCK_EVENTS) {
      // Each classified block event restarts the silence clock...
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
      expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
        h.STREAM_STALL_THRESHOLD_MS,
      );
      // ...and the next frame clears the indicator within one tick.
      h.useStore.getState().handleRpcFrame(h.TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      vi.advanceTimersByTime(1_000);
      expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    }
  });

  it("keeps ticking while an auto-retry notice is on screen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    // omp gives up and schedules a retry: the #100 notice lands...
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "auto_retry_start",
      attempt: 1,
      maxAttempts: 10,
      delayMs: 2000,
      errorMessage:
        "OpenAI responses stream stalled while waiting for the next event",
    });
    // ...and the live indicator keeps ticking on the same clock (the retry
    // frame does not reset it).
    vi.advanceTimersByTime(1_000);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.streamStallMs).toBe(h.STREAM_STALL_THRESHOLD_MS + 1_000);
    expect(tab.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  it("never arms during local tool execution, then re-arms on the next response", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_end",
      message: { role: "assistant" },
    });
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    vi.advanceTimersByTime(60_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    // The next assistant response in the same run re-arms the clock:
    // every frame while "running" defensively arms it.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("agent_end clears the field and stops the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_end" });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.status).toBe("ready");
    // The clock is stopped: no re-arm, no re-patch, ever.
    vi.advanceTimersByTime(120_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });

  it("relaunch resets the field and the checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.useStore.setState({ state: h.stateWithRecord(null) });
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    expect(h.useStore.getState().rpc[h.TAB]!.streamCheckpoint).toBeDefined();
    // The explicit stop is observable without advancing the clock: the armed
    // interval is gone the moment the relaunch lands (self-termination would
    // only remove it on the next tick).
    const timersBefore = vi.getTimerCount();
    h.mockBackend.restartSession.mockResolvedValueOnce(undefined);
    await h.useStore.getState().restartSession(h.TAB);
    expect(vi.getTimerCount()).toBe(timersBefore - 1);
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.status).toBe("starting");
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.streamCheckpoint).toBeUndefined();
    // The clock is stopped: nothing can re-arm it while "starting".
    vi.advanceTimersByTime(120_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });

  it("does not claim a stall before it has seen a checkpoint (late joiner)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    // A client that joined mid-response: the transcript shows an open
    // assistant, but this client has seen no model-stream frame — it cannot
    // time what it never saw.
    h.useStore.setState((s) => {
      const t = s.rpc[h.TAB]!;
      return {
        rpc: {
          ...s.rpc,
          [h.TAB]: {
            ...t,
            items: [
              {
                kind: "assistant",
                id: "a-late",
                text: "",
                thinking: "",
                streaming: true,
              },
            ],
          },
        },
      };
    });
    vi.advanceTimersByTime(60_000);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    // The first frame this client sees sets the clock — and arms it.
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("omp_ui_error clears the field and sets the error status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(h.useStore.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    h.useStore.getState().handleRpcFrame(h.TAB, {
      type: "omp_ui_error",
      message: "boom",
    });
    const tab = h.useStore.getState().rpc[h.TAB]!;
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.status).toBe("error");
  });

  it("silent process death stops the clock and clears the field", async () => {
    // A fresh module: init latches per evaluation, and the shell-routing
    // suite already owns the shared module's listener captures.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    fresh.setState({ rpc: { [h.TAB]: rpcTabState() } });
    fresh.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
    fresh.getState().handleRpcFrame(h.TAB, { type: "turn_start" });
    fresh.getState().handleRpcFrame(h.TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    const init = fresh.getState().init();
    // No tool cards were running — the pure-text-stall shape.
    const exitCb = h.mockBackend.onPtyExit.mock.calls[0]![0] as (
      tabId: string,
      code: number,
    ) => void;
    await init;
    vi.advanceTimersByTime(h.STREAM_STALL_THRESHOLD_MS);
    expect(fresh.getState().rpc[h.TAB]!.streamStallMs).toBe(
      h.STREAM_STALL_THRESHOLD_MS,
    );
    exitCb(h.TAB, 1);
    expect(fresh.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
    expect(fresh.getState().exited[h.TAB]).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(fresh.getState().rpc[h.TAB]!.streamStallMs).toBeUndefined();
  });
});

describe("hibernation (issue #246)", () => {
  it("settles running tools and marks the tab hibernated, not crashed", async () => {
    // A fresh module: init latches per evaluation, and the earlier suites
    // already own the shared module's listener captures.
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    fresh.setState({ rpc: { [h.TAB]: rpcTabState({ status: "running" }) } });
    // A tool card mid-flight: the process is stopped with it still running.
    fresh.getState().handleRpcFrame(h.TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    expect(fresh.getState().rpc[h.TAB]!.items).toHaveLength(1);

    const init = fresh.getState().init();
    const hibernateCb =
      h.mockBackend.onSessionHibernated.mock.calls[0]![0] as (tabId: string) => void;
    await init;

    hibernateCb(h.TAB);

    // The dead gates see a plain exit (code 0); the framing is hibernated.
    expect(fresh.getState().exited[h.TAB]).toBe(0);
    expect(fresh.getState().hibernated[h.TAB]).toBe(true);
    const [item] = fresh.getState().rpc[h.TAB]!.items;
    expect(item).toMatchObject({ kind: "tool", toolCallId: "t1", status: "aborted" });
    vi.useRealTimers();
  });
});

describe("viewed-tab reporter (issue #266)", () => {
  it("reports the active tab on init, on focus change, and on the heartbeat", async () => {
    // A fresh module — a static import cannot work: init latches per
    // evaluation, and the earlier suites already own the shared module's
    // listener captures.
    vi.useFakeTimers();
    try {
      vi.resetModules();
      const { useStore: fresh } = await import("./store");
      const init = fresh.getState().init();
      await init;
      expect(h.mockBackend.tabViewed).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.tabViewed).toHaveBeenLastCalledWith(expect.any(String), null);

      h.mockBackend.tabViewed.mockClear();
      fresh.getState().focusTab(h.TAB);
      expect(h.mockBackend.tabViewed).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.tabViewed).toHaveBeenLastCalledWith(expect.any(String), h.TAB);

      h.mockBackend.tabViewed.mockClear();
      await vi.advanceTimersByTimeAsync(5 * 60_000); // heartbeat
      expect(h.mockBackend.tabViewed).toHaveBeenCalledTimes(1);
      expect(h.mockBackend.tabViewed).toHaveBeenLastCalledWith(expect.any(String), h.TAB);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("notification click focus (issue #271)", () => {
  // A fresh module evaluation per test: init() latches per evaluation, and the
  // earlier suites already own the shared module's listener capture.
  const projectState = (
    sessions: BackendState["projects"][0]["sessions"],
  ): BackendState =>
    makeBackendState({
      projects: [
        {
          project: {
            path: "/p",
            name: "p",
            addedAt: "t",
            lastModel: null,
            lastThinkingLevel: null,
            lastAdvisor: null,
            lastAdvisorModel: null,
            defaultModel: null,
            defaultAdvisorModel: null,
          },
          sessions,
        },
      ],
    });
  const rec = (tabId: string, live: LiveState = "live") => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    worktree: null,
    planImplementationSource: null,
    agentMode: "build" as const,
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    lastViewedAt: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title: "New session",
    status: null,
    live,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });
  it("a notification click resurfaces and focuses a hidden tab", async () => {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    h.backendState = projectState([rec(h.TAB)]);
    fresh.setState({
      state: h.backendState,
      tabs: [
        tabInfo({ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
      activeTabId: null,
    });

    const init = fresh.getState().init();
    await init;
    const cb = h.mockBackend.onFocusSession.mock.calls[0]![0] as (tabId: string) => void;

    void cb(h.TAB);
    await h.flushMicrotasks();

    const st = fresh.getState();
    expect(st.tabs.find((t) => t.tabId === h.TAB)?.hidden).toBe(false);
    expect(st.activeTabId).toBe(h.TAB);
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("a notification click resumes a session the store has no tab for", async () => {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    h.backendState = projectState([rec(h.TAB, "dormant")]);
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: h.TAB });
    fresh.setState({ state: h.backendState });

    const init = fresh.getState().init();
    await init;
    const cb = h.mockBackend.onFocusSession.mock.calls[0]![0] as (tabId: string) => void;

    void cb(h.TAB);
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeTabId: h.TAB,
        projectCwd: "/p",
        mode: "rpc-ui",
      }),
    );
  });
});