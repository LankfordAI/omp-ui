// Session parameter slice tests (moved verbatim from store.test.ts for #295).
import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../../lib/rpc-types";
import { rpcTabState, tabInfo } from "../../test/fixtures";
import { h } from "../../test/store-harness";
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
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
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
      // A record without a worktree: sessionCwd is its project root.
      state: h.stateWithRecord("sess-1", "live", null),
      mcpManager: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      scopeCwd: "/p",
      tabId: h.TAB,
    });
    h.useStore.getState().closeMcpManager();
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp list");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      scopeCwd: "/p",
      tabId: h.TAB,
    });
    h.useStore.getState().closeMcpManager();
  });

  it("bare /mcp in a worktree session opens the manager at the checkout (issue #325)", async () => {
    h.backendState = h.stateWithRecord("sess-1", "live", {
      path: "/wt",
      branch: "omp-ui/abc",
      base: "main",
    });
    h.useStore.setState({
      state: h.backendState,
      mcpManager: null,
      // The tab still carries the project root, so only the record's
      // worktree can produce /wt here.
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      scopeCwd: "/wt",
      tabId: h.TAB,
    });
    h.useStore.getState().closeMcpManager();
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp list");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      scopeCwd: "/wt",
      tabId: h.TAB,
    });
    h.useStore.getState().closeMcpManager();
  });

  it("bare /mcp falls back to the tab's project root when no record is loaded", async () => {
    h.useStore.setState({
      state: null,
      mcpManager: null,
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
    });
    await h.useStore.getState().runSlashCommand(h.TAB, "/mcp");
    expect(h.sent).toHaveLength(0);
    expect(h.useStore.getState().mcpManager).toEqual({
      scopeCwd: "/p",
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
      expect(h.rpcCommandMachinery.snapshotPending(h.TAB).size).toBe(1);
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

  it("the loud banner names the command holding omp's chain (issue #337)", async () => {
    const T = "wedge-tab-loud";
    h.useStore.setState({ rpc: { ...h.useStore.getState().rpc, [T]: rpcTabState() } });
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // compact t=0 (holds the chain), a second loud command t=5, compact
      // budget t=30, second budget t=35.
      const held = h.useStore.getState().compactSession(T);
      await vi.advanceTimersByTimeAsync(5_000);
      const queued = h.useStore.getState().setSteeringMode(T, "manual");
      await vi.advanceTimersByTimeAsync(25_000);
      await held;
      await vi.advanceTimersByTimeAsync(5_000);
      await queued;

      expect(h.useStore.getState().rpc[T]!.failure!.message).toBe(
        'RPC command "set_steering_mode" timed out after its 30.0s response budget' +
          " — queued behind compact (timed out 5.0s ago, response not yet observed)",
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
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
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
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
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
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
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
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
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
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: null,
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

  it("compactSession reports whether omp acknowledged the compaction (issue #336)", async () => {
    const acked = h.useStore.getState().compactSession(h.TAB);
    await settleAll({ summary: "…" });
    await expect(acked).resolves.toBe(true);

    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const held = h.useStore.getState().compactSession(h.TAB);
      await vi.advanceTimersByTimeAsync(31_000);
      await expect(held).resolves.toBe(false);
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
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
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "resume",
      resumeTabId: "tab-fork",
      cols: 80,
      rows: 24,
    });
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
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "pin/advisor:high",
      cols: 80,
      rows: 24,
      worktree: null,
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

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "last/advisor",
      cols: 80,
      rows: 24,
      worktree: null,
    });
  });

  it("newSession falls back to omp's configured advisor model when no app state exists", async () => {
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "cfg-tab" });
    h.useStore.setState({
      state: null,
      advisorDefaults: { "/p": { enabled: true, model: "openrouter/a/b:high" } },
    });

    await h.useStore.getState().newSession("/p");

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
      worktree: null,
    });
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
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "p/pin",
      cols: 80,
      rows: 24,
      worktree: null,
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

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "staged/advisor",
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
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

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "pin/advisor",
      cols: 80,
      rows: 24,
      worktree: null,
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("plan dispatch in a worktree session: the spec and staged advisor ride one spawn", async () => {
    const state = h.stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.defaultAdvisorModel = "pin/advisor";
    h.useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReviewWithPlan("pd-wt");
    await h.flushMicrotasks();
    expect(h.useStore.getState().rpc[h.TAB]!.planReview).not.toBeNull();
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "wt-staged" });
    h.useStore.getState().executePlan(h.TAB, "worktree", {
      worktree: { branch: "omp-ui/cafebabe", baseRef: "main" },
      advisor: true,
      advisorModel: "staged/advisor",
    });
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "staged/advisor",
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "omp-ui/cafebabe", baseRef: "main" } },
      planMode: false,
      planImplementationSource: {
        sourceTabId: h.TAB,
        planTitle: "t",
        planFilePath: "local://p.md",
      },
    });
  });

  it("pin setters forward to the backend channel", async () => {
    await h.useStore.getState().setProjectDefaultModel("/p", "p/m");
    expect(h.mockBackend.setProjectDefaultModel).toHaveBeenCalledWith("/p", "p/m");
    await h.useStore.getState().setProjectDefaultAdvisorModel("/p", null);
    expect(h.mockBackend.setProjectDefaultAdvisorModel).toHaveBeenCalledWith("/p", null);
  });
});

