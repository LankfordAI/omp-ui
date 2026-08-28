// RPC command slice tests (moved verbatim from store.test.ts for #295).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../../lib/rpc-types";
import { generateTitleFromPrompt } from "../../lib/session-title";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";
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
      h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpc } });
      const blocked = h.useStore
        .getState()
        .rpcCommand(h.TAB, { type: "compact" });
      const blockedCommand = h.sent.pop()!.cmd;

      const relaunch = h.useStore.getState().setSessionAdvisor(h.TAB, true, "openrouter/a/b:high");
      expectPrepared();
      await vi.advanceTimersByTimeAsync(25_000);
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "session_info_update" });
      await vi.advanceTimersByTimeAsync(6_000);
      await relaunch;

      expect(h.useStore.getState().rpc[h.TAB]!.plan).toEqual(priorPlan);
      expect(h.mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
      h.respond(h.TAB, blockedCommand, {});
      await blocked;
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
    expect(tab.subagentAckLevel).toBe("progress");
  });

  it("delivers a notice raised across the relaunch after history loads (issue #334)", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({
      state: h.backendState,
      rpc: { [h.TAB]: rpcTabState({ status: "starting" }) },
    });
    // The worktree release appends its notice while the respawn is in flight;
    // boot resets `items` and replaces them with fetched history.
    h.useStore.getState().appendNotice(h.TAB, "merged omp-ui/deadbeef", "info");
    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([]);

    await h.driveBoot(h.TAB, {
      get_messages: {
        data: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      },
    });

    expect(h.useStore.getState().rpc[h.TAB]!.items).toEqual([
      expect.objectContaining({ kind: "user", text: "hi" }),
      expect.objectContaining({ kind: "notice", text: "merged omp-ui/deadbeef", level: "info" }),
    ]);
  });

  it("subscribes to subagent progress and never wedges boot on a failed extra", async () => {
    h.backendState = h.stateWithRecord(null);
    h.useStore.setState({ state: h.backendState });
    const levels: unknown[] = [];
    const boot = h.useStore.getState().bootRpcTab(h.TAB);
    for (let wave = 0; wave < 4; wave++) {
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
    expect(h.useStore.getState().rpc[h.TAB]!.subagentAckLevel).toBeUndefined();
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
      expect(
        h.rpcCommandMachinery.hasPending(h.TAB, String(cmd.id)),
      ).toBe(true);
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

      expect(h.rpcCommandMachinery.snapshotPending(h.TAB).size).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("[rpc] command timeout", {
        tabId: h.TAB,
        commandId: cmd.id,
        command: "prompt",
        timeoutMs: 30_000,
        elapsedMs: 30_000,
        lateAck: false,
        // The silence clock is per tab and outlives a single case; the
        // re-arm contract itself is asserted in the late-ack budget suite.
        quietForMs: expect.any(Number),
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

describe("late-ack command classification (issue #335)", () => {
  it("classifies commands omp awaits before its ack as late-ack", () => {
    // omp awaits these handlers before acking: a model call, a provider
    // refresh, a turn unwind, file/network work, or a UI round-trip.
    for (const type of [
      "compact",
      "handoff",
      "abort",
      "abort_and_prompt",
      "export_html",
      "login",
      "new_session",
      "switch_session",
      "branch",
      "set_model",
      "cycle_model",
      "get_available_models",
      "bash",
    ]) {
      expect(h.isLateAckCommand({ type })).toBe(true);
    }
  });

  it("keeps commands omp answers from memory strict", () => {
    for (const type of [
      "get_state",
      "get_session_stats",
      "get_subagents",
      "get_messages",
      "get_available_commands",
      "set_todos",
      "set_thinking_level",
      "set_steering_mode",
    ]) {
      expect(h.isLateAckCommand({ type })).toBe(false);
    }
  });

  it("splits prompt by message: slash and /skill: are late-ack, plain text is not", () => {
    // omp awaits tryRunRpcSkillCommand and the builtin slash dispatcher before
    // acking a prompt; a plain-text prompt acks immediately.
    expect(h.isLateAckCommand({ type: "prompt", message: "/skill:research go" })).toBe(true);
    expect(h.isLateAckCommand({ type: "prompt", message: "please run /skill:tdd now" })).toBe(true);
    expect(h.isLateAckCommand({ type: "prompt", message: "/usage" })).toBe(true);
    expect(h.isLateAckCommand({ type: "prompt", message: "  /compact" })).toBe(true);
    expect(h.isLateAckCommand({ type: "prompt", message: "fix the bug" })).toBe(false);
    expect(h.isLateAckCommand({ type: "prompt", message: "use http://x/y" })).toBe(false);
    expect(h.isLateAckCommand({ type: "prompt" })).toBe(false);
  });
});

describe("late-ack silence budget (issue #335)", () => {
  beforeEach(() => {
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  it("keeps a late-ack command pending while the process keeps emitting frames", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const promise = h.useStore.getState().rpcCommand(h.TAB, { type: "compact" });
      let settled = false;
      void promise.then(
        () => (settled = true),
        () => (settled = true),
      );
      const cmd = h.sent.pop()!.cmd;
      await vi.advanceTimersByTimeAsync(25_000);
      // Any frame proves omp is alive and the chain is merely slow.
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
      await vi.advanceTimersByTimeAsync(25_000);

      expect(settled).toBe(false);
      expect(warn).not.toHaveBeenCalled();
      expect(h.rpcCommandMachinery.snapshotPending(h.TAB).size).toBe(1);

      h.respond(h.TAB, cmd, { summary: "…" });
      await expect(promise).resolves.toMatchObject({ type: "response" });
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("fails a late-ack command once the process has been silent for a full window", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const promise = h.useStore.getState().rpcCommand(h.TAB, { type: "compact" });
      const typed = expect(promise).rejects.toMatchObject({
        name: "RpcCommandTimeoutError",
        command: "compact",
        kind: "silence",
      });
      await vi.advanceTimersByTimeAsync(10_000);
      h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
      await vi.advanceTimersByTimeAsync(41_000);
      await typed;
      await expect(promise).rejects.toThrow(
        /stopped responding — no session activity for 30\.0s/,
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not re-arm a strict command when frames arrive", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const promise = h.useStore.getState().rpcCommand(h.TAB, { type: "get_state" });
      const typed = expect(promise).rejects.toMatchObject({
        name: "RpcCommandTimeoutError",
        command: "get_state",
        kind: "response",
      });
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(10_000);
        h.useStore.getState().handleRpcFrame(h.TAB, { type: "agent_start" });
      }
      await typed;
      await expect(promise).rejects.toThrow(
        'RPC command "get_state" timed out after its 30.0s response budget',
      );
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });
});

describe("pending commands are abandoned when the process goes away (issue #338)", () => {
  /**
   * Sends a loud prompt on `store`, tears its process down, then outlives the
   * budget: an orphaned wait would fire here and paint a phantom banner.
   */
  const outliveBudget = async (
    store: typeof h.useStore,
    teardown: () => void,
  ): Promise<void> => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const promise = store
        .getState()
        .rpcCommand(h.TAB, { type: "prompt", message: "do the thing" });
      const rejected = expect(promise).rejects.toMatchObject({
        name: "RpcCommandAbandonedError",
        command: "prompt",
      });
      teardown();
      await rejected;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(store.getState().rpc[h.TAB]?.failure).toBeUndefined();
      expect(store.getState().rpc[h.TAB]?.busy).toBe(false);
      expect(warn).not.toHaveBeenCalledWith(
        "[rpc] command timeout",
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
  };

  /** init latches per module evaluation, so a listener capture needs a fresh one. */
  const freshStoreWithListeners = async (): Promise<{
    store: typeof h.useStore;
    exit: (tabId: string, code: number) => void;
    hibernate: (tabId: string) => void;
  }> => {
    vi.resetModules();
    const { useStore: fresh } = await import("../../store");
    fresh.setState({ rpc: { [h.TAB]: rpcTabState() } });
    const init = fresh.getState().init();
    const exit = h.mockBackend.onPtyExit.mock.calls.at(-1)![0] as (
      tabId: string,
      code: number,
    ) => void;
    const hibernate = h.mockBackend.onSessionHibernated.mock.calls.at(-1)![0] as (
      tabId: string,
    ) => void;
    await init;
    return { store: fresh, exit, hibernate };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    h.useStore.setState({ rpc: { [h.TAB]: rpcTabState() } });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("drops the wait on process exit with no banner", async () => {
    const { store, exit } = await freshStoreWithListeners();
    await outliveBudget(store, () => exit(h.TAB, 1));
  });

  it("drops the wait on hibernation with no banner", async () => {
    const { store, hibernate } = await freshStoreWithListeners();
    await outliveBudget(store, () => hibernate(h.TAB));
  });

  it("drops the wait when a relaunched process boots", async () => {
    // prepareRpcRelaunch runs while the old process is still alive (the
    // advisor drain depends on that); the wait dies when the fresh process
    // announces itself and boots.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      h.backendState = h.stateWithRecord(null);
      h.useStore.setState({ state: h.backendState });
      const promise = h.useStore
        .getState()
        .rpcCommand(h.TAB, { type: "prompt", message: "do the thing" });
      const rejected = expect(promise).rejects.toMatchObject({
        name: "RpcCommandAbandonedError",
        command: "prompt",
      });
      h.sent.splice(0);
      await h.driveBoot(h.TAB);
      await rejected;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(h.useStore.getState().rpc[h.TAB]!.status).toBe("ready");
      expect(h.useStore.getState().rpc[h.TAB]!.failure).toBeUndefined();
      expect(warn).not.toHaveBeenCalledWith(
        "[rpc] command timeout",
        expect.anything(),
      );
    } finally {
      warn.mockRestore();
    }
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

  it("opening a detail escalates the subscription to events; closing drops back, without redundant sends", async () => {
    const levels = () =>
      h.sent
        .filter((s) => s.cmd.type === "set_subagent_subscription")
        .map((s) => s.cmd.level);
    h.useStore.getState().openSubagent(h.TAB, "a");
    expect(h.useStore.getState().rpc[h.TAB]!.selectedSubagent).toBe("a");
    h.useStore.getState().openSubagent(h.TAB, "a");
    expect(levels()).toEqual(["events"]);
    h.respond(h.TAB, h.sent[0]!.cmd, {});
    await h.flushMicrotasks();
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
          subagentAckLevel: "events",
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
    expect(h.useStore.getState().rpc[REBOOT_TAB]!.subagentAckLevel).toBe("events");
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
