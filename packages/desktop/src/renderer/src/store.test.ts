import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateState, BackendState, LiveState, OmpUpdateState } from "@omp-ui/core/types";
import { emptySessionRuntime } from "./lib/rpc-types";
import type { RpcTabState } from "./store";

// --- Bridge mock: store.ts reads window.ompBackend at module load -----------

const sent: Array<{ tabId: string; cmd: Record<string, unknown> }> = [];
let backendState: BackendState = {
  projects: [],
  defaultMode: "rpc-ui",
  modelFavorites: [],
  skipDeleteConfirmation: false,
};

const idleAppUpdate: AppUpdateState = {
  status: "idle",
  currentVersion: null,
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  format: "unknown",
  progress: null,
  downloadedPath: null,
  error: null,
};

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

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
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  setSessionAdvisor: vi.fn(),
  setSessionModel: vi.fn(async () => {}),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  generateTitle: vi.fn(async (): Promise<string | null> => null),
  readPlanFile: vi.fn(async (): Promise<string | null> => "# Plan\n\nstep one\n"),
  ptyPasteImage: vi.fn(),
  setDefaultMode: vi.fn(),
  setSkipDeleteConfirmation: vi.fn(async () => {}),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  toggleFavorite: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  getOmpUpdateState: vi.fn(async () => idleOmpUpdate),
  checkOmpUpdate: vi.fn(),
  downloadOmpUpdate: vi.fn(),
  dismissOmpUpdate: vi.fn(),
  onOmpUpdateState: vi.fn(),
  getAppUpdateState: vi.fn(async () => idleAppUpdate),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  openAppUpdateReleaseNotes: vi.fn(),
  showAppUpdateDownload: vi.fn(),
  restartForAppUpdate: vi.fn(),
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
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
const { deriveSidebarSessionState, useStore } = await import("./store");

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

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
    plan: null,
    planReview: null,
    planText: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    ...patch,
  };
}

function stateWithRecord(sessionId: string | null, live: LiveState = "live"): BackendState {
  return {
    defaultMode: "rpc-ui",
    modelFavorites: [],
    skipDeleteConfirmation: false,
    projects: [
      {
        project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastAdvisorModel: null },
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
  backendState = {
    projects: [],
    defaultMode: "rpc-ui",
    modelFavorites: [],
    skipDeleteConfirmation: false,
  };
  useStore.setState({
    state: null,
    tabs: [],
    activeTabId: null,
    exited: {},
    rpc: {},
    deleteConfirmation: null,
  });
  vi.clearAllMocks();
});

describe("deriveSidebarSessionState", () => {
  const summary = () => stateWithRecord(null).projects[0]!.sessions[0]!;

  it("derives every lifecycle and native RPC activity state from authoritative inputs", () => {
    for (const live of ["dormant", "archived", "missing"] as const) {
      expect(deriveSidebarSessionState({ ...summary(), live }, tabState(), undefined)).toBe(live);
    }

    expect(
      deriveSidebarSessionState({ ...summary(), mode: "pty" }, tabState({ status: "running" }), undefined),
    ).toBe("live");
    expect(deriveSidebarSessionState(summary(), undefined, undefined)).toBe("live");
    expect(deriveSidebarSessionState(summary(), tabState({ status: "running" }), 0)).toBe(
      "dormant",
    );

    expect(deriveSidebarSessionState(summary(), tabState({ status: "starting" }), undefined)).toBe(
      "starting",
    );
    expect(deriveSidebarSessionState(summary(), tabState({ status: "error" }), undefined)).toBe(
      "error",
    );
    expect(deriveSidebarSessionState(summary(), tabState({ status: "running" }), undefined)).toBe(
      "working",
    );
    expect(deriveSidebarSessionState(summary(), tabState({ status: "ready" }), undefined)).toBe(
      "ready",
    );

    expect(
      deriveSidebarSessionState(
        summary(),
        tabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      deriveSidebarSessionState(
        summary(),
        tabState({
          status: "running",
          planReview: {
            request: { title: "review", planFilePath: "local://p.md", planAbsPath: null },
            frame: { id: "p" },
          },
        }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      deriveSidebarSessionState(
        summary(),
        tabState({ status: "error", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("error");
    expect(
      deriveSidebarSessionState(summary(), tabState({ status: "ready", busy: true }), undefined),
    ).toBe("ready");
    expect(
      deriveSidebarSessionState(
        summary(),
        tabState({
          status: "ready",
          session: { ...emptySessionRuntime(), isStreaming: true },
        }),
        undefined,
      ),
    ).toBe("ready");
  });

  it("tracks queued answers in FIFO order through a complete agent turn", () => {
    const current = () => deriveSidebarSessionState(summary(), useStore.getState().rpc[TAB], undefined);
    useStore.setState({ rpc: { [TAB]: tabState() } });
    expect(current()).toBe("ready");

    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    expect(current()).toBe("working");
    for (const id of ["q1", "q2"]) {
      useStore.getState().handleRpcFrame(TAB, {
        type: "extension_ui_request",
        id,
        method: "confirm",
        title: `confirm ${id}`,
      });
    }
    expect(current()).toBe("awaiting-answer");

    let request = useStore.getState().rpc[TAB]!.extensionQueue[0];
    useStore.getState().answerExtension(TAB, request, { confirmed: true });
    expect(current()).toBe("awaiting-answer");
    request = useStore.getState().rpc[TAB]!.extensionQueue[0];
    useStore.getState().answerExtension(TAB, request, { confirmed: true });
    expect(current()).toBe("working");

    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("tracks a plan-review gate until refinePlan answers it", () => {
    const current = () => deriveSidebarSessionState(summary(), useStore.getState().rpc[TAB], undefined);
    useStore.setState({ rpc: { [TAB]: tabState() } });
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "plan-1",
      method: "select",
      title: "omp-ui:plan-review:" + JSON.stringify({ title: "p", planFilePath: "local://p.md" }),
    });
    expect(current()).toBe("awaiting-answer");

    useStore.getState().refinePlan(TAB);
    expect(useStore.getState().rpc[TAB]!.planReview).toBeNull();
    expect(current()).toBe("working");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("does not mistake non-dialog extension traffic for a pending answer", () => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "done",
    });
    expect(deriveSidebarSessionState(summary(), useStore.getState().rpc[TAB], undefined)).toBe(
      "ready",
    );
  });
});

describe("proposed plans: defer keeps the gate unanswered, history tracks verdicts", () => {
  const planReviewFrame = (id: string, planFilePath = "local://p.md") => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath }),
  });

  it("records a proposal, defers without answering, and re-opens on demand", () => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d1"));
    let rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.planReview?.request.planFilePath).toBe("local://p.md");
    expect(rpc.planDeferred).toBe(false);
    expect(rpc.plans).toEqual([{ key: "local://p.md", title: "t", status: "pending" }]);

    // "not now" dismisses the pane but never answers the blocked gate: the
    // agent stays paused and the plan stays pending for later.
    useStore.getState().deferPlanReview(TAB);
    rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.planDeferred).toBe(true);
    expect(rpc.planReview).not.toBeNull();
    expect(sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(false);
    expect(
      deriveSidebarSessionState(stateWithRecord(null).projects[0]!.sessions[0]!, rpc, undefined),
    ).toBe("awaiting-answer");

    // Restoring the review from the plans tab clears the deferral.
    useStore.getState().showPlanReview(TAB);
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(false);
  });

  it("settles the pending record to refined on a refine verdict", () => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d2"));
    useStore.getState().refinePlan(TAB);
    const rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.plans).toEqual([{ key: "local://p.md", title: "t", status: "refined" }]);
    expect(sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd.value).toBe("refine");
  });

  it("settles the pending record to executed, and a repropose keeps one record", () => {
    useStore.setState({ rpc: { [TAB]: tabState() } });
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d3"));
    useStore.getState().executePlan(TAB, "existing");
    let rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.plans[0]!.status).toBe("executed");
    // The planner comes back with a revised draft for the same plan file.
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d4"));
    rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.plans).toHaveLength(1);
    expect(rpc.plans[0]).toEqual({ key: "local://p.md", title: "t", status: "pending" });
  });
});

describe("native RPC relaunch preparation", () => {
  const staleRpc = () =>
    tabState({
      status: "running",
      items: [{ kind: "marker", id: "kept", label: "kept", tone: "neutral" }],
      session: { ...emptySessionRuntime(), isStreaming: true },
      extensionQueue: [{ id: "question" }],
      planReview: {
        request: { title: "review", planFilePath: "local://p.md", planAbsPath: null },
        frame: { id: "plan" },
      },
      planText: "# stale plan",
      error: "stale failure",
    });

  const expectPrepared = () => {
    const rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.status).toBe("starting");
    expect(rpc.session.isStreaming).toBe(false);
    expect(rpc.extensionQueue).toEqual([]);
    expect(rpc.planReview).toBeNull();
    expect(rpc.planText).toBeNull();
    expect(rpc.error).toBeUndefined();
    expect(rpc.items).toEqual([expect.objectContaining({ id: "kept" })]);
  };

  it("prepares an exited native tab before its resume promise settles", async () => {
    backendState = stateWithRecord("sess-1", "dormant");
    const spawn = deferred<{ tabId: string }>();
    mockBackend.spawnSession.mockReturnValueOnce(spawn.promise);
    useStore.setState({ state: backendState, exited: { [TAB]: 0 }, rpc: { [TAB]: staleRpc() } });

    const resume = useStore.getState().resumeDead(TAB);
    expectPrepared();
    expect(useStore.getState().exited[TAB]).toBe(0);
    spawn.resolve({ tabId: TAB });
    await resume;
    expect(useStore.getState().exited[TAB]).toBeUndefined();
  });

  it("prepares a live mode switch involving native RPC before IPC settles", async () => {
    backendState = stateWithRecord("sess-1");
    const switched = deferred<void>();
    mockBackend.switchMode.mockReturnValueOnce(switched.promise);
    useStore.setState({ state: backendState, rpc: { [TAB]: staleRpc() } });

    const change = useStore.getState().switchMode(TAB, "pty");
    expectPrepared();
    switched.resolve(undefined);
    await change;
  });

  it("prepares a changed live native advisor tuple before IPC settles", async () => {
    backendState = stateWithRecord("sess-1");
    const changed = deferred<void>();
    mockBackend.setSessionAdvisor.mockReturnValueOnce(changed.promise);
    useStore.setState({ state: backendState, rpc: { [TAB]: staleRpc() } });

    const update = useStore.getState().setSessionAdvisor(TAB, true, "openrouter/a/b:high");
    expectPrepared();
    changed.resolve(undefined);
    await update;
  });

  it("leaves RPC state alone for an unchanged advisor tuple and a PTY resume", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({ state: backendState, rpc: { [TAB]: staleRpc() } });
    await useStore.getState().setSessionAdvisor(TAB, false, null);
    expect(useStore.getState().rpc[TAB]).toEqual(staleRpc());

    backendState = stateWithRecord("sess-1", "dormant");
    backendState.projects[0]!.sessions[0]!.mode = "pty";
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: TAB });
    useStore.setState({ state: backendState, exited: { [TAB]: 1 }, rpc: { [TAB]: staleRpc() } });
    await useStore.getState().resumeDead(TAB);
    expect(useStore.getState().rpc[TAB]).toEqual(staleRpc());
  });
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

  it("arms the advisor-stats extension even when the record's advisor flag is false", async () => {
    // A stale/false record (race with the broadcast after an advisor-toggle
    // relaunch) must not skip the arm: the runtime readout depends on it.
    // driveBoot drains `sent` wave-by-wave, so the fire-and-forget arm (pushed
    // after Promise.allSettled) must be captured during the drain, not after.
    backendState = stateWithRecord(null); // records built with advisor:false
    useStore.setState({ state: backendState });
    const boot = useStore.getState().bootRpcTab(TAB);
    const arms: unknown[] = [];
    for (let wave = 0; wave < 5; wave++) {
      await flushMicrotasks();
      for (const { cmd } of sent.splice(0)) {
        if (cmd.type === "prompt" && cmd.message === "/omp-ui-advisor-stats") arms.push(cmd);
        respond(TAB, cmd, {});
      }
    }
    await boot;
    for (const { cmd } of sent.splice(0)) {
      if (cmd.type === "prompt" && cmd.message === "/omp-ui-advisor-stats") arms.push(cmd);
      respond(TAB, cmd, {});
    }
    expect(arms).toHaveLength(1);
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

  it("agent_end refreshes get_state and get_session_stats", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // get_session_stats carries the HUD cost/token totals; without this the
    // boot-time snapshot (a fresh session reads $0) lingers forever.
    expect(sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("agent_start flips status to running; prompt_result back to ready", () => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    expect(useStore.getState().rpc[TAB]!.status).toBe("running");
    useStore.getState().handleRpcFrame(TAB, { type: "prompt_result" });
    expect(useStore.getState().rpc[TAB]!.status).toBe("ready");
  });

  it("refreshes get_state and get_session_stats live on message_end while the agent runs", () => {
    useStore.setState({ rpc: { [`${TAB}-live`]: tabState({ status: "running" }) } });
    useStore.getState().handleRpcFrame(`${TAB}-live`, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "first turn" }] },
    });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // Spend lives on get_session_stats — without this tick the HUD cost
    // counter freezes for the whole run and only moves at agent_end.
    expect(sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("throttles a burst of message_ends to one live usage snapshot", () => {
    useStore.setState({ rpc: { [`${TAB}-burst`]: tabState({ status: "running" }) } });
    const end = (text: string) =>
      useStore.getState().handleRpcFrame(`${TAB}-burst`, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    end("a");
    end("b");
    end("c");
    expect(sent.filter((s) => s.cmd.type === "get_state")).toHaveLength(1);
    expect(sent.filter((s) => s.cmd.type === "get_session_stats")).toHaveLength(1);
  });

  it("does not refresh get_state on message_end while idle", () => {
    useStore.setState({ rpc: { [`${TAB}-idle`]: tabState({ status: "ready" }) } });
    useStore.getState().handleRpcFrame(`${TAB}-idle`, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(false);
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

  it("claims the plan status frame as state, not as displayed text", () => {
    useStore.getState().handleRpcFrame(TAB, {
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
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.plan).toMatchObject({ enabled: true, planFilePath: "local://a-plan.md" });
    // Plan state drives the toggle; it must never leak into the status chips.
    expect(tab.extensionStatus).toEqual({});
  });

  it("claims the advisor-stats frame as state, not as displayed text", () => {
    useStore.getState().handleRpcFrame(TAB, {
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
    const tab = useStore.getState().rpc[TAB]!;
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

  it("refreshAdvisorStats asks the extension over a slash command", async () => {
    const pending = useStore.getState().refreshAdvisorStats(TAB);
    const entry = sent.pop()!;
    expect(entry.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-advisor-stats",
    });
    // The extension answers by publishing a setStatus frame, not a response —
    // settle the command so the method promise resolves.
    respond(TAB, entry.cmd, {});
    await pending;
  });

  it("routes a plan review to the review pane instead of the generic dialog", () => {
    useStore.getState().handleRpcFrame(TAB, {
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
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.planReview?.request).toMatchObject({ planFilePath: "local://auth-plan.md" });
    expect(tab.extensionQueue).toHaveLength(0);
    // The agent is blocked on this select — nothing may answer it early.
    expect(sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(false);
  });

  it("executing a review answers with the execute verdict and closes the pane", async () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p3",
      method: "select",
      title:
        "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    useStore.getState().executePlan(TAB, "existing");
    const response = sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p3", value: "execute" });
    expect(useStore.getState().rpc[TAB]!.planReview).toBeNull();
    await flushMicrotasks();
  });

  it("executing in the existing session queues an implementation prompt there", async () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p3b",
      method: "select",
      title:
        "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    useStore.getState().executePlan(TAB, "existing");
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    // followUp queues the prompt until the just-accepted plan turn ends, so it
    // races nothing — the implementer runs after the planner stops.
    expect(prompt!.cmd.streamingBehavior).toBe("followUp");
    await flushMicrotasks();
  });

  it("refining a review answers with the refine verdict and sends no prompt", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p4",
      method: "select",
      title:
        "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    useStore.getState().refinePlan(TAB);
    const response = sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p4", value: "refine" });
    expect(sent.some((s) => s.cmd.type === "prompt")).toBe(false);
  });

  it("refining with notes steers the planner with the requested changes", async () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p4b",
      method: "select",
      title:
        "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    useStore.getState().refinePlan(TAB, { text: "drop the API layer" });
    const prompt = sent.find((s) => s.tabId === TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.streamingBehavior).toBe("steer");
    expect(prompt!.cmd.message).toContain("drop the API layer");
    await flushMicrotasks();
  });

  it("executing in a fresh session spawns a new tab seeded with the plan", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    useStore.getState().handleRpcFrame(TAB, {
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
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh");
    const response = sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response?.cmd).toMatchObject({ id: "p7", value: "execute" });
    await flushMicrotasks();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectCwd: "/p", mode: "rpc-ui" }),
    );
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: { ...useStore.getState().rpc, "fresh-tab": tabState({ status: "ready", planText: null }) },
    });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === "fresh-tab" && s.cmd.type === "prompt" && String(s.cmd.message).includes("# Plan"),
    );
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.message).toContain("Implement it now");
    await flushMicrotasks();
  });

  /** An advisor review card as it lands over the live stream. */
  const advisorReviewFrame = (note: string, severity: string, advisor: string) => ({
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
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title: "omp-ui:plan-review:" + JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
  };

  it("holds execute for the drafting turn's advisor review, then folds its concerns", async () => {
    // Configured advisor = a review of the plan turn is on its way after the verdict.
    useStore.setState({
      rpc: {
        [TAB]: tabState({
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
    useStore.getState().executePlan(TAB, "existing");
    // The verdict lands immediately — omp's agent is blocked on it.
    const verdict = sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(verdict!.cmd).toMatchObject({ id: "c1", value: "execute" });
    // …but the implementation waits for the review: the turn that produced the
    // plan is still ending, so its review cannot have landed yet.
    expect(sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    // The advisor reviews the now-finished plan turn.
    useStore.getState().handleRpcFrame(TAB, advisorReviewFrame("Hardcoded key", "blocker", "security"));
    await flushMicrotasks();
    const prompt = sent.find(
      (s) => s.tabId === TAB && s.cmd.type === "prompt" && String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("advisor flagged");
    expect(String(prompt!.cmd.message)).toContain("Hardcoded key");
    expect(String(prompt!.cmd.message)).toContain("[blocker]");
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.items.at(-1)).toMatchObject({ kind: "notice", text: expect.stringContaining("1 concern") });
  });

  it("executes immediately, and reads no transcript, when the fold is off", async () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
          items: [
            {
              kind: "advisory",
              id: "advisory-stale",
              notes: [{ note: "old unrelated nit", severity: "nit", advisor: "style" }],
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
    useStore.getState().executePlan(TAB, "existing", false);
    await flushMicrotasks();
    const prompt = sent.find((s) => s.tabId === TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    // Stale pre-verdict advisories are never folded onto a fresh verdict.
    expect(String(prompt!.cmd.message)).not.toContain("old unrelated nit");
  });

  it("skips the wait entirely when the session has no configured advisor", () => {
    useStore.setState({ rpc: { [TAB]: tabState({ advisorStats: null }) } });
    openReview("c3");
    useStore.getState().executePlan(TAB, "existing");
    expect(sent.find((s) => s.cmd.type === "prompt")).toBeDefined();
  });

  it("refine stays immediate: user notes steer at once, never waiting on a review", () => {
    useStore.setState({
      rpc: {
        [TAB]: tabState({
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
    useStore.getState().refinePlan(TAB, { text: "drop the API layer" });
    expect(sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd).toMatchObject({
      id: "c4",
      value: "refine",
    });
    // The planner revises in this same turn (the extension tells it to), so
    // there is no review to wait for — the user's notes steer immediately.
    const steer = sent.find((s) => s.tabId === TAB && s.cmd.type === "prompt");
    expect(steer!.cmd.streamingBehavior).toBe("steer");
    expect(String(steer!.cmd.message)).toContain("drop the API layer");
  });

  it("times out the execute concern wait and implements without concerns", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({
        rpc: {
          [TAB]: tabState({
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
      useStore.getState().executePlan(TAB, "existing");
      // The review never lands; the bounded deadline settles the wait.
      await vi.advanceTimersByTimeAsync(15_000);
      await flushMicrotasks();
      const prompt = sent.find(
        (s) => s.tabId === TAB && s.cmd.type === "prompt" && String(s.cmd.message).includes("execute the approved plan"),
      );
      expect(prompt).toBeDefined();
      expect(String(prompt!.cmd.message)).not.toContain("advisor flagged");
    } finally {
      vi.useRealTimers();
    }
  });

  it("seeds a fresh implementation session with the folded concerns", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    useStore.setState({
      rpc: {
        [TAB]: tabState({
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
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh");
    useStore.getState().handleRpcFrame(TAB, advisorReviewFrame("pin the toolchain", "concern", "ops"));
    await flushMicrotasks();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ projectCwd: "/p", mode: "rpc-ui" }),
    );
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: { ...useStore.getState().rpc, "fresh-tab": tabState({ status: "ready", planText: null }) },
    });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt" && String(s.cmd.message).includes("Implement it now"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("pin the toolchain");
    await flushMicrotasks();
  });

  it("still shows a plain select dialog when the title is not a plan review", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p5",
      method: "select",
      title: "pick one",
      options: ["a", "b"],
    });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.extensionQueue).toHaveLength(1);
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

  it("renames immediately from a substantive first prompt, no agent_end needed", async () => {
    useStore.getState().setInitialPrompt(TAB, "Refactor the auth module");
    // Latched and renamed synchronously — the title goes out as soon as the
    // prompt is offered, not when the first run ends.
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Refactor the auth module");
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(true);
    await flushMicrotasks();
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Refactor the auth module");
  });

  it("defers on a greeting, then titles from the next real prompt", async () => {
    useStore.getState().setInitialPrompt(TAB, "hi!");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(false);

    // agent_end on the greeting turn must not name the session.
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();
    expect(sent.find((s) => s.cmd.type === "set_session_name")).toBeUndefined();

    useStore.getState().setInitialPrompt(TAB, "Add pagination to the sessions list");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Add pagination to the sessions list");
  });

  it("keeps the first substantive prompt as the title source", () => {
    // The first prompt latches and renames; a second prompt must not displace it.
    useStore.getState().setInitialPrompt(TAB, "Fix the login redirect");
    useStore.getState().setInitialPrompt(TAB, "Actually, fix logout too");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Fix the login redirect");
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(true);
  });

  it("never titles a session that already has a user-visible name", async () => {
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
    await flushMicrotasks();
    expect(sent.find((s) => s.cmd.type === "set_session_name")).toBeUndefined();
  });

  it("titles a session whose record is still the 'New session' placeholder", async () => {
    useStore.getState().setInitialPrompt(TAB, "Create a login page with OAuth");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Create a login page with OAuth");
  });

  it("titles from the captured prompt even if omp renamed mid-turn", async () => {
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
    await flushMicrotasks();
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
    await flushMicrotasks();

    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Create a login page with OAuth");

    for (const { tabId: tid, cmd } of sent.splice(0)) respond(tid, cmd, {});
    await flushMicrotasks();
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();

    // A later turn must not rename again.
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();
    expect(sent.splice(0).find((s) => s.cmd.type === "set_session_name")).toBeUndefined();
  });

  it("retries on the next agent_end when set_session_name fails", async () => {
    useStore.getState().setInitialPrompt(TAB, "Add a new API endpoint");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();

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
    await flushMicrotasks();
    expect(sent.splice(0).find((s) => s.cmd.type === "set_session_name")).toBeTruthy();
  });

  it("titles from omp's small model rather than the raw prompt", async () => {
    // The whole point of routing through the model: the title is a summary,
    // not a copy of the prompt.
    mockBackend.generateTitle.mockResolvedValueOnce("Add sessions list pagination");
    useStore
      .getState()
      .setInitialPrompt(TAB, "can you add pagination to the sessions list please");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();

    expect(mockBackend.generateTitle).toHaveBeenCalledWith(
      "/p",
      "can you add pagination to the sessions list please",
    );
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Add sessions list pagination");
  });

  it("falls back to the derived title when the model declines", async () => {
    // null covers every failure path in main: no omp, bad model, timeout, or a
    // `<title/>` answer. A session must still get named.
    mockBackend.generateTitle.mockResolvedValueOnce(null);
    useStore.getState().setInitialPrompt(TAB, "Can you fix the login redirect");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();

    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Fix the login redirect");
  });

  it("falls back to the derived title when the model call rejects", async () => {
    mockBackend.generateTitle.mockRejectedValueOnce(new Error("ipc died"));
    useStore.getState().setInitialPrompt(TAB, "Refactor the auth module");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();

    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Refactor the auth module");
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

  it("sendPrompt always sends the prompt frame, with steer as the streaming behaviour", async () => {
    const ready = useStore.getState().sendPrompt(TAB, "do the thing");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "do the thing",
      streamingBehavior: "steer",
    });
    await settleAll();
    await ready;

    useStore.setState({ rpc: { [TAB]: tabState({ status: "running" }) } });
    const steering = useStore.getState().sendPrompt(TAB, "actually, wait");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "actually, wait",
      streamingBehavior: "steer",
    });
    await settleAll();
    await steering;
  });

  it("sendPrompt honours an explicit follow_up route while running", async () => {
    useStore.setState({ rpc: { [TAB]: tabState({ status: "running" }) } });
    const promise = useStore.getState().sendPrompt(TAB, "and then this", "follow_up");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "and then this",
      streamingBehavior: "followUp",
    });
    await settleAll();
    await promise;
  });

  it("sendPrompt feeds the auto-titler immediately, no agent_end needed", async () => {
    const promise = useStore.getState().sendPrompt(TAB, "Refactor the auth module");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe("Refactor the auth module");
    // Flush once so the async rename's set_session_name lands, then capture it
    // before settleAll consumes the sent queue.
    await flushMicrotasks();
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Refactor the auth module");
    // settleAll answers the prompt (and the rename) so sendPrompt resolves.
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

  it("runSlashCommand /new opens a new session tab instead of prompting omp", async () => {
    backendState = stateWithRecord(null);
    const project = backendState.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = null;
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({
      state: backendState,
      tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await useStore.getState().runSlashCommand(TAB, "/new");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
    });
    expect(sent).toEqual([]); // nothing reached omp
    expect(useStore.getState().activeTabId).toBe("fresh-tab");
  });

  it("runSlashCommand forwards /new with arguments to omp", async () => {
    const promise = useStore.getState().runSlashCommand(TAB, "/new later");
    expect(sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/new later" });
    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /new falls back to omp when the tab is unknown", async () => {
    useStore.setState({ tabs: [] });
    const promise = useStore.getState().runSlashCommand(TAB, "/new");
    expect(sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/new" });
    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
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

  it("quiet commands never raise busy, so background sync can't strobe the sweeps", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "get_subagents" }, { quiet: true });
    expect(useStore.getState().rpc[TAB]!.busy).toBe(false);
    respond(TAB, sent.pop()!.cmd, { subagents: [] });
    await promise;
    expect(useStore.getState().rpc[TAB]!.busy).toBe(false);
  });

  it("a loud command's busy survives an interleaved quiet one settling", async () => {
    const loud = useStore.getState().rpcCommand(TAB, { type: "compact" });
    const quiet = useStore.getState().rpcCommand(TAB, { type: "get_state" }, { quiet: true });
    expect(useStore.getState().rpc[TAB]!.busy).toBe(true);

    const [a, b] = sent.splice(0);
    // The quiet one settles first — busy must hold for the loud one.
    respond(TAB, b!.cmd, {});
    await quiet;
    expect(useStore.getState().rpc[TAB]!.busy).toBe(true);
    respond(TAB, a!.cmd, {});
    await loud;
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

  it("setModel remembers the model with the current thinking level", async () => {
    backendState = stateWithRecord(null);
    useStore.setState({
      state: backendState,
      rpc: {
        [TAB]: tabState({
          session: { ...emptySessionRuntime(), thinkingLevel: "high" },
        }),
      },
    });
    const model = { id: "claude-opus-5", name: "Opus 5", provider: "anthropic" };
    const promise = useStore.getState().setModel(TAB, model);
    await settleAll(model);
    await promise;
    expect(mockBackend.setSessionModel).toHaveBeenCalledWith(
      TAB,
      "anthropic/claude-opus-5",
      "high",
    );
  });

  it("setThinkingLevel remembers the level without changing the main model", async () => {
    useStore.setState({
      rpc: { [TAB]: tabState({ model: { id: "m1", name: "M1", provider: "p" } }) },
    });
    const promise = useStore.getState().setThinkingLevel(TAB, "max");
    await settleAll({});
    await promise;
    expect(mockBackend.setSessionModel).toHaveBeenCalledWith(TAB, "p/m1", "max");
  });

  it("setAdvisorModel persists the advisor tuple through one backend call", async () => {
    await useStore.getState().setAdvisorModel(TAB, "openrouter/a/b:high");
    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(TAB, true, "openrouter/a/b:high");
  });

  it("newSession uses the persisted mode and restores the last advisor tuple", async () => {
    backendState = stateWithRecord(null);
    const project = backendState.projects[0]!.project;
    project.lastAdvisor = false;
    project.lastAdvisorModel = "openrouter/a/b:high";
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "new-tab" });
    useStore.setState({
      state: backendState,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
    });
  });

  it("newSession mode override wins without changing the persisted default", async () => {
    backendState = stateWithRecord(null);
    const project = backendState.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "openrouter/a/b:high";
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "terminal-tab" });
    useStore.setState({
      state: backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await useStore.getState().newSession("/p", "pty");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
    });
    expect(mockBackend.setDefaultMode).not.toHaveBeenCalled();
  });

  it("newSession falls back to terminal mode without backend state", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fallback-tab" });
    useStore.setState({
      state: null,
      advisorDefaults: { "/p": { enabled: true, model: "openrouter/a/b:high" } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "pty",
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      cols: 80,
      rows: 24,
    });
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

  it("toggleConsole flips one tab's drawer without touching another's (issue #33)", () => {
    useStore.setState({ consoleOpen: {} });
    useStore.getState().toggleConsole(TAB);
    expect(useStore.getState().consoleOpen[TAB]).toBe(true);
    expect(useStore.getState().consoleOpen[`${TAB}-other`]).toBeUndefined();
    useStore.getState().toggleConsole(TAB);
    expect(useStore.getState().consoleOpen[TAB]).toBe(false);
  });
});

describe("deleteSession", () => {
  it("opens a warning that deleting a live session stops its agent", async () => {
    useStore.setState({
      state: stateWithRecord("sess-1", "live"),
      tabs: [{ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      activeTabId: TAB,
      rpc: { [TAB]: tabState() },
    });
    await useStore.getState().deleteSession(TAB);

    expect(mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().deleteConfirmation).toEqual({
      tabId: TAB,
      title: "New session",
      running: true,
      hasFiles: true,
    });

    await useStore.getState().confirmDeleteSession(false);
    expect(mockBackend.deleteSession).toHaveBeenCalledWith(TAB);
    expect(useStore.getState().tabs).toEqual([]);
  });

  it("does nothing when the warning is dismissed", async () => {
    useStore.setState({ state: stateWithRecord("sess-1", "dormant") });
    await useStore.getState().deleteSession(TAB);
    useStore.getState().cancelDeleteSession();

    expect(mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().deleteConfirmation).toBeNull();
  });

  it("drops the tab, its rpc slot, and its exit code once confirmed", async () => {
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
    await useStore.getState().confirmDeleteSession(false);

    expect(mockBackend.deleteSession).toHaveBeenCalledWith(TAB);
    const st = useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["other"]);
    expect(st.rpc[TAB]).toBeUndefined();
    expect(st.exited[TAB]).toBeUndefined();
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
    await useStore.getState().confirmDeleteSession(false);

    const st = useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual([TAB]);
    expect(st.rpc[TAB]).toBeDefined();
    expect(alerts[0]).toBe("EBUSY");
  });

  it("marks a record whose files are gone without a file-erasure warning", async () => {
    useStore.setState({ state: stateWithRecord("sess-1", "missing") });
    await useStore.getState().deleteSession(TAB);

    expect(useStore.getState().deleteConfirmation?.hasFiles).toBe(false);
  });

  it("persists the opt-out only when deletion is confirmed", async () => {
    useStore.setState({ state: stateWithRecord("sess-1", "dormant") });
    await useStore.getState().deleteSession(TAB);
    useStore.getState().cancelDeleteSession();
    expect(mockBackend.setSkipDeleteConfirmation).not.toHaveBeenCalled();

    await useStore.getState().deleteSession(TAB);
    await useStore.getState().confirmDeleteSession(true);
    expect(mockBackend.setSkipDeleteConfirmation).toHaveBeenCalledWith(true);
  });

  it("deletes immediately after warnings have been disabled", async () => {
    const state = stateWithRecord("sess-1", "dormant");
    state.skipDeleteConfirmation = true;
    useStore.setState({ state });

    await useStore.getState().deleteSession(TAB);

    expect(useStore.getState().deleteConfirmation).toBeNull();
    expect(mockBackend.deleteSession).toHaveBeenCalledWith(TAB);
  });
});
