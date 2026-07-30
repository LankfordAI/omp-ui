import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, LiveState } from "@omp-ui/core/types";
import { emptySessionRuntime } from "./lib/rpc-types";
import type { RpcTabState } from "./store";

// --- Bridge mock: store.ts reads window.ompBackend at module load -----------

const sent: Array<{ tabId: string; cmd: Record<string, unknown> }> = [];
let backendState: BackendState = { projects: [], defaultMode: "rpc-ui" };

const mockBackend = {
  getState: vi.fn(async () => backendState),
  rpcSend: vi.fn((tabId: string, cmd: Record<string, unknown>) => {
    sent.push({ tabId, cmd });
  }),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  addProject: vi.fn(),
  removeProject: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  ptyPasteImage: vi.fn(),
  setDefaultMode: vi.fn(),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
};

// Dialog text is an assertable part of a destructive action's contract, so the
// stubs record what they were asked; `confirm` accepts unless a case says no.
const prompts: string[] = [];
const alerts: string[] = [];

const windowStub = {
  ompBackend: mockBackend,
  alert: (msg: string): void => {
    alerts.push(msg);
  },
  confirm: (msg: string): boolean => {
    prompts.push(msg);
    return true;
  },
  get setTimeout() {
    return globalThis.setTimeout;
  },
  get clearTimeout() {
    return globalThis.clearTimeout;
  },
};
Object.assign(globalThis, { window: windowStub });

// Dynamic import is required: ./backend reads window.ompBackend at module
// load, so the stub above must land before the store module evaluates.
const { useStore } = await import("./store");

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const TAB = "tab-test-1";

function tabState(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    bashLines: [],
    commandOutput: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: false,
    ...patch,
  };
}

function stateWithRecord(sessionId: string | null, live: LiveState = "live"): BackendState {
  return {
    defaultMode: "rpc-ui",
    projects: [
      {
        project: { path: "/p", name: "p", addedAt: "t" },
        sessions: [
          {
            tabId: TAB,
            sessionId,
            lineageDir: "omp-ui--p--11111111-2222-3333-4444-555555555555",
            projectCwd: "/p",
            launchedAt: "t",
            mode: "rpc-ui",
            advisor: false,
            advisorModel: null,
            cachedTitle: null,
            cachedModified: null,
            title: "New session",
            status: null,
            live,
          },
        ],
      },
    ],
  };
}

function respond(tabId: string, cmd: Record<string, unknown>, data: unknown, success = true) {
  useStore.getState().handleRpcFrame(tabId, {
    type: "response",
    id: cmd.id,
    command: cmd.type,
    success,
    ...(success ? { data } : { error: String(data) }),
  });
}

/** Runs bootRpcTab while answering every command it emits, in wave order. */
async function driveBoot(
  tabId: string,
  responses: Record<string, { data?: unknown; success?: boolean }> = {},
): Promise<string[]> {
  const boot = useStore.getState().bootRpcTab(tabId);
  const answered: string[] = [];
  // Commands arrive in waves: get_state is awaited first, then
  // models/messages — drain and answer each wave deterministically.
  for (let wave = 0; wave < 3; wave++) {
    await flushMicrotasks();
    for (const { cmd } of sent.splice(0)) {
      answered.push(String(cmd.type));
      const r = responses[String(cmd.type)] ?? {};
      respond(tabId, cmd, r.data ?? {}, r.success ?? true);
    }
  }
  await boot;
  return answered;
}

beforeEach(() => {
  sent.length = 0;
  prompts.length = 0;
  alerts.length = 0;
  // Cases that answer "no" overwrite confirm; reinstall the default each time.
  windowStub.confirm = (msg: string): boolean => {
    prompts.push(msg);
    return true;
  };
  backendState = { projects: [], defaultMode: "rpc-ui" };
  useStore.setState({ state: null, tabs: [], activeTabId: null, exited: {}, rpc: {} });
  vi.clearAllMocks();
});

describe("bootRpcTab", () => {
  it("unwraps data payloads for state, models, commands, stats, and history", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({ state: backendState });
    const commands = await driveBoot(TAB, {
      get_state: {
        data: {
          todoPhases: [{ phase: "P", tasks: [{ content: "do it", status: "pending" }] }],
          model: { id: "m1", name: "M One", provider: "p" },
          thinkingLevel: "high",
          messageCount: 4,
          contextUsage: { tokens: 100, contextWindow: 1000, percent: 10 },
        },
      },
      get_available_models: { data: { models: [{ id: "m1", name: "M One", provider: "p" }] } },
      get_available_commands: {
        data: { commands: [{ name: "stats", description: "session stats", source: "builtin" }] },
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
        data: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] },
      },
    });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("ready");
    expect(tab.todos).toEqual([{ phase: "P", tasks: [{ content: "do it", status: "pending" }] }]);
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
    expect(tab.items).toEqual([expect.objectContaining({ kind: "user", text: "hi" })]);
    expect(commands).toContain("set_subagent_subscription");
  });

  it("subscribes to subagent progress and never wedges boot on a failed extra", async () => {
    backendState = stateWithRecord(null);
    useStore.setState({ state: backendState });
    const levels: unknown[] = [];
    const boot = useStore.getState().bootRpcTab(TAB);
    for (let wave = 0; wave < 3; wave++) {
      await flushMicrotasks();
      for (const { cmd } of sent.splice(0)) {
        if (cmd.type === "set_subagent_subscription") levels.push(cmd.level);
        // Every optional boot command fails; only get_state decides readiness.
        const ok = cmd.type === "get_state";
        respond(TAB, cmd, ok ? {} : "unavailable", ok);
      }
    }
    await boot;
    expect(levels).toEqual(["progress"]);
    expect(useStore.getState().rpc[TAB]!.status).toBe("ready");
  });

  it("fetches backend state when store state is null, then loads history", async () => {
    // Regression: boot outrunning init()'s first getState must not skip
    // get_messages — the record decides, so state is pulled from the backend.
    backendState = stateWithRecord("sess-2");
    const commands = await driveBoot(TAB, { get_messages: { data: { messages: [] } } });
    expect(mockBackend.getState).toHaveBeenCalled();
    expect(commands).toContain("get_messages");
  });

  it("does not request history for a never-materialized session", async () => {
    backendState = stateWithRecord(null);
    useStore.setState({ state: backendState });
    const commands = await driveBoot(TAB);
    expect(commands).not.toContain("get_messages");
  });

  it("reports error, not ready, when get_state fails", async () => {
    backendState = stateWithRecord("s");
    useStore.setState({ state: backendState });
    await driveBoot(TAB, { get_state: { success: false, data: "process dead" } });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.error).toMatch(/process dead/);
  });
});

describe("rpcCommand / handleRpcFrame correlation", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
  });

  it("resolves a command by matching response id", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "get_state" });
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, { ok: 1 });
    await expect(promise).resolves.toMatchObject({ command: "get_state", data: { ok: 1 } });
  });

  it("rejects with the server error on success:false", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "set_model" });
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, "unknown model", false);
    await expect(promise).rejects.toThrow("unknown model");
  });

  it("rejects after the 30s timeout", async () => {
    vi.useFakeTimers();
    try {
      const promise = useStore.getState().rpcCommand(TAB, { type: "get_state" });
      const assertion = expect(promise).rejects.toThrow(/timed out/);
      await vi.advanceTimersByTimeAsync(30_000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });

  it("a fresh ready frame re-boots the tab", async () => {
    useStore.getState().handleRpcFrame(TAB, { type: "ready", maxFrameBytes: 1048576 });
    await flushMicrotasks();
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
  });
});

describe("handleRpcFrame routing", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
  });

  it("omp_ui_error sets the error banner", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "omp_ui_error", message: "handshake failed" });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("error");
    expect(tab.error).toBe("handshake failed");
  });

  it("agent_end refreshes get_state", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
  });

  it("agent_start flips status to running; prompt_result back to ready", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    expect(useStore.getState().rpc[TAB]!.status).toBe("running");
    useStore.getState().handleRpcFrame(TAB, { type: "prompt_result" });
    expect(useStore.getState().rpc[TAB]!.status).toBe("ready");
  });

  it("folds session events into render items", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "yo" }] },
    });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({ kind: "user", text: "yo" }),
    ]);
  });

  it("queues dialog extension requests", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(useStore.getState().rpc[TAB]!.extensionQueue).toHaveLength(1);
  });

  it("records a setWidget's text in extensionStatus AND still answers it", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e2",
      method: "setWidget",
      widgetKey: "ctx",
      widgetLines: ["ctx 12%", "cost $0.10"],
    });
    // omp blocks on the reply — recording the text must not replace answering.
    expect(sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e2",
      cancelled: true,
    });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.extensionStatus).toEqual({ ctx: "ctx 12%\ncost $0.10" });
    expect(tab.extensionQueue).toHaveLength(0);
    // Displayed text is not transcript noise.
    expect(tab.items).toHaveLength(0);
  });

  it("records setStatus text and clears a widget when its lines go away", () => {
    const store = useStore.getState();
    store.handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e3",
      method: "setStatus",
      statusKey: "advisor",
      statusText: "reviewing",
    });
    expect(useStore.getState().rpc[TAB]!.extensionStatus).toEqual({ advisor: "reviewing" });
    store.handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e4",
      method: "setStatus",
      statusKey: "advisor",
      statusText: undefined,
    });
    expect(useStore.getState().rpc[TAB]!.extensionStatus).toEqual({});
  });

  it("auto-cancels a non-status extension request with a marker", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e5",
      method: "notify",
      message: "hi",
    });
    expect(sent.pop()!.cmd).toMatchObject({ type: "extension_ui_response", id: "e5" });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({ kind: "marker", label: "extension notify auto-cancelled" }),
    ]);
  });

  it("answers stray host_tool_call with an error result", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "host_tool_call", id: "h1", name: "x" });
    expect(sent.pop()!.cmd).toMatchObject({ type: "host_tool_result", id: "h1" });
  });

  it("answers host_uri_request instead of leaving the agent blocked", () => {
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "host_uri_request", id: "u1", operation: "read", url: "db://x" });
    expect(sent.pop()!.cmd).toMatchObject({
      type: "host_uri_result",
      id: "u1",
      error: "omp-ui registers no uri schemes",
    });
  });

  it("appends command_output to both bash lines and command output", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "command_output", text: "out-1" });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.bashLines).toEqual(["out-1"]);
    expect(tab.commandOutput).toEqual(["out-1"]);
  });

  it("available_commands_update replaces the command palette", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "available_commands_update",
      commands: [
        { name: "stats", description: "show stats", source: "builtin" },
        { name: "model", aliases: ["m"], description: "pick model", source: "builtin" },
        { name: 42 },
      ],
    });
    const { commands } = useStore.getState().rpc[TAB]!;
    expect(commands.map((c) => c.name)).toEqual(["stats", "model"]);
    expect(commands[1]).toMatchObject({ aliases: ["m"], description: "pick model" });
  });

  it("extension_error surfaces as a rose-worthy error notice", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_error",
      extensionPath: "/ext/foo.ts",
      error: "boom",
    });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "notice",
        text: "boom",
        level: "error",
        source: "/ext/foo.ts",
      }),
    ]);
  });

  it("subagent frames mark the transcript and refresh the roster", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "subagent_lifecycle",
      payload: { id: "s1", agent: "scout", status: "started", index: 0 },
    });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({ kind: "marker", label: "subagent scout: started", tone: "copper" }),
    ]);
    expect(sent.some((s) => s.cmd.type === "get_subagents")).toBe(true);
  });

  it("thinking_level_changed patches the session as well as the transcript", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "thinking_level_changed", thinkingLevel: "max" });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.session.thinkingLevel).toBe("max");
    expect(tab.items).toEqual([
      expect.objectContaining({ kind: "marker", label: "thinking level: max" }),
    ]);
  });

  it("session_info_update and config_update merge into session/model", () => {
    const store = useStore.getState();
    store.handleRpcFrame(TAB, {
      type: "session_info_update",
      title: "Renamed",
      sessionId: "sess-9",
    });
    expect(useStore.getState().rpc[TAB]!.session.sessionId).toBe("sess-9");
    store.handleRpcFrame(TAB, {
      type: "config_update",
      model: { id: "m2", name: "M Two", provider: "openai" },
      thinkingLevel: "low",
    });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.model).toMatchObject({ id: "m2", provider: "openai" });
    // A partial frame must not wipe what get_state already established.
    expect(tab.session).toMatchObject({ sessionId: "sess-9", thinkingLevel: "low" });
  });
});

describe("auto-title gating (setInitialPrompt)", () => {
  beforeEach(() => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({
      state: backendState,
      rpc: { [TAB]: tabState({ status: "running" }) },
    });
    sent.length = 0;
  });

  it("accepts a substantive first prompt as the title source", () => {
    useStore.getState().setInitialPrompt(TAB, "Refactor the auth module");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Refactor the auth module");
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(false);
  });

  it("defers on a greeting, then titles from the next real prompt", () => {
    useStore.getState().setInitialPrompt(TAB, "hi!");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(false);

    // agent_end on the greeting turn must not name the session.
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.find((s) => s.cmd.type === "set_session_name")).toBeUndefined();

    useStore.getState().setInitialPrompt(TAB, "Add pagination to the sessions list");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Add pagination to the sessions list");
  });

  it("keeps the first substantive prompt when more arrive before agent_end", () => {
    useStore.getState().setInitialPrompt(TAB, "Fix the login redirect");
    useStore.getState().setInitialPrompt(TAB, "Actually, fix logout too");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Fix the login redirect");
  });

  it("never titles a session that already has a user-visible name", () => {
    const base = stateWithRecord("sess-1");
    backendState = {
      ...base,
      projects: [
        {
          ...base.projects[0]!,
          sessions: [{ ...base.projects[0]!.sessions[0]!, title: "My Named Session" }],
        },
      ],
    };
    useStore.setState({ state: backendState });

    useStore.getState().setInitialPrompt(TAB, "Refactor the auth module");

    // Latched closed: no source captured, and no later prompt can reopen it.
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(true);
    useStore.getState().setInitialPrompt(TAB, "Add pagination to the list");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.find((s) => s.cmd.type === "set_session_name")).toBeUndefined();
  });

  it("titles a session whose record is still the 'New session' placeholder", () => {
    useStore.getState().setInitialPrompt(TAB, "Create a login page with OAuth");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Create a login page with OAuth");
  });

  it("titles from the captured prompt even if omp renamed mid-turn", () => {
    useStore.getState().setInitialPrompt(TAB, "Build a feature for the app");
    const base = stateWithRecord("sess-1");
    backendState = {
      ...base,
      projects: [
        {
          ...base.projects[0]!,
          sessions: [{ ...base.projects[0]!.sessions[0]!, title: "Some other title" }],
        },
      ],
    };
    useStore.setState({ state: backendState });

    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Build a feature for the app");
  });
});

describe("auto-title end-to-end", () => {
  beforeEach(() => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({
      state: backendState,
      rpc: { [TAB]: tabState({ status: "running" }) },
    });
    sent.length = 0;
  });

  it("sends set_session_name once, then clears the stored prompt", async () => {
    useStore.getState().setInitialPrompt(TAB, "Create a login page with OAuth");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });

    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Create a login page with OAuth");

    for (const { tabId: tid, cmd } of sent.splice(0)) respond(tid, cmd, {});
    await flushMicrotasks();
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();

    // A later turn must not rename again.
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.splice(0).find((s) => s.cmd.type === "set_session_name")).toBeUndefined();
  });

  it("retries on the next agent_end when set_session_name fails", async () => {
    useStore.getState().setInitialPrompt(TAB, "Add a new API endpoint");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });

    const firstBatch = sent.splice(0);
    expect(firstBatch.find((s) => s.cmd.type === "set_session_name")).toBeTruthy();
    for (const { tabId: tid, cmd } of firstBatch) {
      const ok = cmd.type !== "set_session_name";
      respond(tid, cmd, ok ? {} : "rejected", ok);
    }
    await flushMicrotasks();

    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(false);
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Add a new API endpoint");

    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.splice(0).find((s) => s.cmd.type === "set_session_name")).toBeTruthy();
  });
});

describe("prompting, slash commands, and session ops", () => {
  beforeEach(() => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({ state: backendState, rpc: { [TAB]: tabState() } });
    sent.length = 0;
  });

  /** Answers every outstanding command with `data`, so a method promise settles. */
  const settleAll = async (data: unknown = {}): Promise<void> => {
    for (let wave = 0; wave < 3; wave++) {
      await flushMicrotasks();
      for (const { tabId, cmd } of sent.splice(0)) respond(tabId, cmd, data);
    }
  };

  it("sendPrompt uses prompt when ready and steer while running", async () => {
    const ready = useStore.getState().sendPrompt(TAB, "do the thing");
    expect(sent[0]!.cmd).toMatchObject({ type: "prompt", message: "do the thing" });
    await settleAll();
    await ready;

    useStore.setState({ rpc: { [TAB]: tabState({ status: "running" }) } });
    const steering = useStore.getState().sendPrompt(TAB, "actually, wait");
    expect(sent[0]!.cmd).toMatchObject({ type: "steer", message: "actually, wait" });
    await settleAll();
    await steering;
  });

  it("sendPrompt honours an explicit follow_up route while running", async () => {
    useStore.setState({ rpc: { [TAB]: tabState({ status: "running" }) } });
    const promise = useStore.getState().sendPrompt(TAB, "and then this", "follow_up");
    expect(sent[0]!.cmd).toMatchObject({ type: "follow_up", message: "and then this" });
    await settleAll();
    await promise;
  });

  it("sendPrompt still feeds the auto-titler", async () => {
    const promise = useStore.getState().sendPrompt(TAB, "Refactor the auth module");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Refactor the auth module");
    await settleAll();
    await promise;
  });

  it("runSlashCommand normalizes the leading slash and never titles", async () => {
    const promise = useStore.getState().runSlashCommand(TAB, "advisor on");
    expect(sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/advisor on" });
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();
    await settleAll();
    await promise;
  });

  it("busy is true while a command is in flight and survives a concurrent one", async () => {
    const first = useStore.getState().rpcCommand(TAB, { type: "get_state" });
    const second = useStore.getState().rpcCommand(TAB, { type: "get_session_stats" });
    expect(useStore.getState().rpc[TAB]!.busy).toBe(true);

    const [a, b] = sent.splice(0);
    respond(TAB, a!.cmd, {});
    await first;
    // One settled, one still outstanding — busy must not drop yet.
    expect(useStore.getState().rpc[TAB]!.busy).toBe(true);
    respond(TAB, b!.cmd, {});
    await second;
    expect(useStore.getState().rpc[TAB]!.busy).toBe(false);
  });

  it("a failed command reports through error rather than rejecting", async () => {
    const promise = useStore.getState().setThinkingLevel(TAB, "high");
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, "unknown level", false);
    await expect(promise).resolves.toBeUndefined();
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.error).toBe("unknown level");
    // A rejected setting must not wedge a live tab into the error state.
    expect(tab.status).toBe("ready");
    expect(tab.session.thinkingLevel).toBeNull();
  });

  it("setModel sends provider + modelId, not the whole model object", async () => {
    const model = { id: "claude-opus-5", name: "Opus 5", provider: "anthropic" };
    const promise = useStore.getState().setModel(TAB, model);
    expect(sent[0]!.cmd).toMatchObject({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    await settleAll(model);
    await promise;
    expect(useStore.getState().rpc[TAB]!.model).toMatchObject({ id: "claude-opus-5" });
  });

  it("exportHtml pushes the returned path as a notice", async () => {
    const promise = useStore.getState().exportHtml(TAB);
    await settleAll({ path: "/tmp/session.html" });
    await promise;
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({ kind: "notice", text: "exported to /tmp/session.html" }),
    ]);
  });

  it("compactSession marks the transcript without pasting the summary into it", async () => {
    const promise = useStore.getState().compactSession(TAB);
    await settleAll({ summary: "x".repeat(5000) });
    await promise;
    const { items } = useStore.getState().rpc[TAB]!;
    expect(items.map((i) => i.kind)).toEqual(["marker", "marker"]);
    expect(JSON.stringify(items)).not.toContain("xxxx");
  });

  it("setTodos sends phases with tasks and re-reads the server's copy", async () => {
    const phases = [{ phase: "Build", tasks: [{ content: "wire it", status: "pending" }] }];
    const promise = useStore.getState().setTodos(TAB, phases);
    expect(sent[0]!.cmd).toMatchObject({ type: "set_todos", phases });
    await settleAll({ todoPhases: phases });
    await promise;
    expect(useStore.getState().rpc[TAB]!.todos).toEqual(phases);
  });

  it("refreshSubagents parses the roster", async () => {
    const promise = useStore.getState().refreshSubagents(TAB);
    await settleAll({
      subagents: [
        { id: "s1", agent: "scout", status: "running", description: "map the store" },
        { agent: "nameless" },
      ],
    });
    await promise;
    expect(useStore.getState().rpc[TAB]!.subagents).toEqual([
      { id: "s1", name: undefined, agent: "scout", status: "running", label: "map the store" },
    ]);
  });

  it("clearCommandOutput and clearBash empty only their own rail", () => {
    useStore.setState({
      rpc: { [TAB]: tabState({ bashLines: ["b"], commandOutput: ["c"] }) },
    });
    useStore.getState().clearCommandOutput(TAB);
    expect(useStore.getState().rpc[TAB]!.commandOutput).toEqual([]);
    expect(useStore.getState().rpc[TAB]!.bashLines).toEqual(["b"]);
    useStore.getState().clearBash(TAB);
    expect(useStore.getState().rpc[TAB]!.bashLines).toEqual([]);
  });
});

describe("deleteSession", () => {
  it("refuses a live session without prompting or calling the backend", async () => {
    useStore.setState({ state: stateWithRecord("sess-1", "live") });
    await useStore.getState().deleteSession(TAB);

    expect(mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(prompts).toEqual([]);
    expect(alerts[0]).toMatch(/still running — terminate it/);
  });

  it("does nothing when the confirm is dismissed", async () => {
    windowStub.confirm = () => false;
    useStore.setState({ state: stateWithRecord("sess-1", "dormant") });
    await useStore.getState().deleteSession(TAB);

    expect(mockBackend.deleteSession).not.toHaveBeenCalled();
  });

  it("drops the tab, its rpc slot, and its exit code once the backend confirms", async () => {
    useStore.setState({
      state: stateWithRecord("sess-1", "dormant"),
      tabs: [
        { tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false },
        { tabId: "other", mode: "pty", projectCwd: "/p", hidden: false },
      ],
      activeTabId: TAB,
      exited: { [TAB]: 1 },
      rpc: { [TAB]: tabState() },
    });

    await useStore.getState().deleteSession(TAB);

    expect(mockBackend.deleteSession).toHaveBeenCalledWith(TAB);
    expect(prompts[0]).toMatch(/transcript and artifacts are erased/);
    const st = useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["other"]);
    expect(st.rpc[TAB]).toBeUndefined();
    expect(st.exited[TAB]).toBeUndefined();
    // Focus falls to a surviving visible tab rather than going blank.
    expect(st.activeTabId).toBe("other");
  });

  it("keeps the tab and surfaces the error when the backend delete fails", async () => {
    mockBackend.deleteSession.mockRejectedValueOnce(new Error("EBUSY"));
    useStore.setState({
      state: stateWithRecord("sess-1", "dormant"),
      tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      activeTabId: TAB,
      rpc: { [TAB]: tabState() },
    });

    await useStore.getState().deleteSession(TAB);

    const st = useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual([TAB]);
    expect(st.rpc[TAB]).toBeDefined();
    expect(alerts[0]).toBe("EBUSY");
  });

  it("omits the file warning for a record whose files are already gone", async () => {
    useStore.setState({ state: stateWithRecord("sess-1", "missing") });
    await useStore.getState().deleteSession(TAB);

    expect(prompts[0]).not.toMatch(/transcript and artifacts/);
    expect(mockBackend.deleteSession).toHaveBeenCalledWith(TAB);
  });
});
