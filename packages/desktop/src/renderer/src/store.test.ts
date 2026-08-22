import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  AppUpdateState,
  BackendState,
  BranchList,
  LiveState,
  OmpSettingsSnapshot,
  OmpUpdateState,
  PendingPlan,
  PlanSettle,
  RemoteState,
} from "@omp-ui/core/types";
import { emptySessionRuntime } from "./lib/rpc-types";
import { PLAN_STATUS_KEY } from "@omp-ui/core/plan";
import { MCP_RUNTIME_STATUS_KEY } from "@omp-ui/core/mcp-status";
import { commandItem, planProposalItem, type NoticeItem } from "./lib/transcript";
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

// --- Bridge mock: store.ts reads window.ompBackend at module load -----------

const sent: Array<{ tabId: string; cmd: Record<string, unknown> }> = [];
let backendState: BackendState = makeBackendState();

const idleAppUpdate: AppUpdateState = {
  status: "idle",
  currentVersion: null,
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  format: "unknown",
  progress: null,
  downloadedPath: null,
  installOnQuit: false,
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

const idleRemoteState: RemoteState = {
  status: "stopped",
  enabled: false,
  bind: "localhost",
  port: 4677,
  token: "t",
  hasPassword: false,
  urls: [],
  tokenUrls: [],
  webBundleMissing: false,
  error: null,
};

const emptyOmpSettings: OmpSettingsSnapshot = {
  entries: [],
  agentDir: null,
  projectConfigPath: null,
  error: null,
};

// init() registers the shell-exit listener once per file and the global
// beforeEach wipes mock.calls, so suites running after it read the callback
// from here instead of re-reading the registration.
let shellExitCb: ((tabId: string, code: number) => void) | null = null;

const mockBackend = {
  getState: vi.fn(async () => backendState),
  rpcSend: vi.fn((tabId: string, cmd: Record<string, unknown>) => {
    sent.push({ tabId, cmd });
  }),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onSessionHibernated: vi.fn(),
  onShellData: vi.fn(),
  onShellExit: vi.fn((cb: (tabId: string, code: number) => void) => {
    shellExitCb = cb;
  }),
  shellSpawn: vi.fn(),
  shellKill: vi.fn(),
  shellWrite: vi.fn(),
  shellResize: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  moveProject: vi.fn(async () => {}),
  setSessionAdvisor: vi.fn(),
  setSessionModel: vi.fn(async () => {}),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  generateTitle: vi.fn(async (): Promise<string | null> => null),
  readPlanFile: vi.fn(
    async (_tabId: string, absPath: string): Promise<string | null> =>
      absPath.endsWith(".html") ? "<h1>Plan</h1>" : "# Plan\n\nstep one\n",
  ),
  listBranches: vi.fn(),
  checkoutBranch: vi.fn(),
  pullBranch: vi.fn(),
  ptyPasteImage: vi.fn(),
  setDefaultMode: vi.fn(),
  setPlanFormat: vi.fn(async () => {}),
  setAdvisorAutoReply: vi.fn(async () => {}),
  setStallAutoContinue: vi.fn(async () => {}),
  setDefaultAdvisor: vi.fn(async () => {}),
  setSkipDeleteConfirmation: vi.fn(async () => {}),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  restartSession: vi.fn(),
  convertToWorktree: vi.fn(async () => {}),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
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
  setAppUpdateInstallOnQuit: vi.fn(),
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
  setThemeId: vi.fn(async () => {}),
  setAppUpdateCheckOnLaunch: vi.fn(async () => {}),
  setOmpUpdateCheckOnLaunch: vi.fn(async () => {}),
  clearDismissedAppUpdate: vi.fn(async () => {}),
  clearDismissedOmpUpdate: vi.fn(async () => {}),
  setWindowChrome: vi.fn(async () => {}),
  readOmpSettings: vi.fn(async () => emptyOmpSettings),
  writeOmpSetting: vi.fn(async () => {}),
  getRemoteState: vi.fn(async () => idleRemoteState),
  setRemoteEnabled: vi.fn(async () => {}),
  setRemoteBind: vi.fn(async () => {}),
  setRemotePort: vi.fn(async () => {}),
  regenerateRemoteToken: vi.fn(async () => {}),
  setRemotePassword: vi.fn(async () => {}),
  clearRemotePassword: vi.fn(async () => {}),
  onRemoteState: vi.fn(),
};

// Dialog text is an assertable part of a destructive action's contract, so the
// stubs record what they were asked; `confirm` accepts unless a case says no.
const prompts: string[] = [];
const alerts: string[] = [];
// open_url extension requests route through window.open; main's
// setWindowOpenHandler owns the real policy, the stub just records the ask.
const openedUrls: string[] = [];

const windowStub = {
  ompBackend: mockBackend,
  alert: (msg: string): void => {
    alerts.push(msg);
  },
  confirm: (msg: string): boolean => {
    prompts.push(msg);
    return true;
  },
  open: (url?: string | URL): null => {
    openedUrls.push(String(url ?? ""));
    return null;
  },
  get setTimeout() {
    return globalThis.setTimeout;
  },
  get clearTimeout() {
    return globalThis.clearTimeout;
  },
  get setInterval() {
    return globalThis.setInterval;
  },
  get clearInterval() {
    return globalThis.clearInterval;
  },
  // The transcript scheduler (issue #187) coalesces onto rAF in production.
  // Tests commit synchronously by default; batching tests replace this with a
  // capturing stub and run the frame themselves.
  requestAnimationFrame: (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  },
  cancelAnimationFrame: (): void => {},
};
Object.assign(globalThis, { window: windowStub });

// Dynamic import is required: ./backend reads window.ompBackend at module
// load, so the stub above must land before the store module evaluates.
const {
  deriveSidebarSessionState,
  QUEUE_SETTLE_REFRESH_MS,
  registerShellWriter,
  RpcCommandTimeoutError,
  STREAM_STALL_THRESHOLD_MS,
  STREAM_STALL_TICK_MS,
  useStore,
} = await import("./store");

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

function stateWithRecord(
  sessionId: string | null,
  live: LiveState = "live",
): BackendState {
  return makeBackendState({
    projects: [
      {
        project: {
          path: "/p",
          name: "p",
          addedAt: "t",
          lastModel: null,
          lastAdvisorModel: null,
        },
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
            pendingPlan: null,
            planSettle: null,
              streamStalled: false,
          },
        ],
      },
    ],
  });
}

function respond(
  tabId: string,
  cmd: Record<string, unknown>,
  data: unknown,
  success = true,
) {
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
      answered.push(
        cmd.type === "prompt" ? String(cmd.message) : String(cmd.type),
      );
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
  openedUrls.length = 0;
  // Cases that answer "no" overwrite confirm; reinstall the default each time.
  windowStub.confirm = (msg: string): boolean => {
    prompts.push(msg);
    return true;
  };
  backendState = makeBackendState();
  useStore.setState({
    state: null,
    tabs: [],
    activeTabId: null,
    focusedTabByProject: {},
    restoringTabs: false,
    exited: {},
    rpc: {},
    compactionSettings: {},
    deleteConfirmation: null,
    appUpdate: idleAppUpdate,
    ompUpdate: idleOmpUpdate,
    remote: idleRemoteState,
  });
  vi.clearAllMocks();
});

describe("deriveSidebarSessionState", () => {
  const summary = () => stateWithRecord(null).projects[0]!.sessions[0]!;

  it("derives every lifecycle and native RPC activity state from authoritative inputs", () => {
    for (const live of ["dormant", "archived", "missing"] as const) {
      expect(
        deriveSidebarSessionState(
          { ...summary(), live },
          rpcTabState(),
          undefined,
        ),
      ).toBe(live);
    }

    expect(
      deriveSidebarSessionState(
        { ...summary(), mode: "pty" },
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("live");
    expect(deriveSidebarSessionState(summary(), undefined, undefined)).toBe(
      "live",
    );
    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "running" }),
        0,
      ),
    ).toBe("dormant");

    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "starting" }),
        undefined,
      ),
    ).toBe("starting");
    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "running" }),
        undefined,
      ),
    ).toBe("working");
    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("ready");

    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("awaiting-answer");
    expect(
      deriveSidebarSessionState(
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
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "error", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("error");
    // Issue #248: a watchdog-aborted turn badges the row stalled, outranking
    // an awaiting answer — the user must prompt to continue either way.
    expect(
      deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "ready" }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "ready", extensionQueue: [{ id: "q" }] }),
        undefined,
      ),
    ).toBe("stalled");
    expect(
      deriveSidebarSessionState(
        { ...summary(), streamStalled: true },
        rpcTabState({ status: "error" }),
        undefined,
      ),
    ).toBe("error");
    expect(
      deriveSidebarSessionState(
        summary(),
        rpcTabState({ status: "ready", busy: true }),
        undefined,
      ),
    ).toBe("ready");
    expect(
      deriveSidebarSessionState(
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
      deriveSidebarSessionState(
        summary(),
        useStore.getState().rpc[TAB],
        undefined,
      );
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
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
    const current = () =>
      deriveSidebarSessionState(
        summary(),
        useStore.getState().rpc[TAB],
        undefined,
      );
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "plan-1",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "p", planFilePath: "local://p.md" }),
    });
    expect(current()).toBe("awaiting-answer");

    useStore.getState().refinePlan(TAB);
    expect(useStore.getState().rpc[TAB]!.planReview).toBeNull();
    expect(current()).toBe("working");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    expect(current()).toBe("ready");
  });

  it("does not mistake non-dialog extension traffic for a pending answer", () => {
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "notice-1",
      method: "notify",
      message: "done",
    });
    expect(
      deriveSidebarSessionState(
        summary(),
        useStore.getState().rpc[TAB],
        undefined,
      ),
    ).toBe("ready");
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
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d1"));
    let rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.planReview?.request.planFilePath).toBe("local://p.md");
    expect(rpc.planDeferred).toBe(false);
    expect(rpc.plans).toEqual([
      { key: "local://p.md", title: "t", status: "pending" },
    ]);

    // "not now" dismisses the pane but never answers the blocked gate: the
    // agent stays paused and the plan stays pending for later.
    useStore.getState().deferPlanReview(TAB);
    rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.planDeferred).toBe(true);
    expect(rpc.planReview).not.toBeNull();
    expect(sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(
      false,
    );
    expect(
      deriveSidebarSessionState(
        stateWithRecord(null).projects[0]!.sessions[0]!,
        rpc,
        undefined,
      ),
    ).toBe("awaiting-answer");

    // Restoring the review from the plans tab clears the deferral.
    useStore.getState().showPlanReview(TAB);
    expect(useStore.getState().rpc[TAB]!.planDeferred).toBe(false);
  });

  it("settles the pending record to refined on a refine verdict", () => {
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d2"));
    useStore.getState().refinePlan(TAB);
    const rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.plans).toEqual([
      { key: "local://p.md", title: "t", status: "refined" },
    ]);
    expect(
      sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd.value,
    ).toBe("refine");
  });

  it("settles the pending record to executed, and a repropose keeps one record", () => {
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d3"));
    useStore.getState().executePlan(TAB, "existing");
    let rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.plans[0]!.status).toBe("executed");
    // The planner comes back with a revised draft for the same plan file.
    useStore.getState().handleRpcFrame(TAB, planReviewFrame("d4"));
    rpc = useStore.getState().rpc[TAB]!;
    expect(rpc.plans).toHaveLength(1);
    expect(rpc.plans[0]).toEqual({
      key: "local://p.md",
      title: "t",
      status: "pending",
    });
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
    const rpc = useStore.getState().rpc[TAB]!;
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
    backendState = stateWithRecord("sess-1", "dormant");
    const spawn = deferred<{ tabId: string }>();
    mockBackend.spawnSession.mockReturnValueOnce(spawn.promise);
    useStore.setState({
      state: backendState,
      exited: { [TAB]: 0 },
      rpc: { [TAB]: staleRpc() },
    });

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

    const update = useStore
      .getState()
      .setSessionAdvisor(TAB, true, "openrouter/a/b:high");
    expectPrepared();
    changed.resolve(undefined);
    await update;
    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      TAB,
      true,
      "openrouter/a/b:high",
      true,
    );
  });

  it("drains a pending thinking change through persistence before relaunch", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({
      state: backendState,
      rpc: {
        [TAB]: rpcTabState({
          model: { id: "qwen", name: "Qwen", provider: "openrouter" },
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        }),
      },
    });

    const level = useStore.getState().setThinkingLevel(TAB, "medium");
    const command = sent.find((entry) => entry.cmd.type === "set_thinking_level")!;
    const relaunch = useStore
      .getState()
      .setSessionAdvisor(TAB, true, "openrouter/openai/gpt-5.6-sol:low");
    expect(mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    expect(useStore.getState().rpc[TAB]!.status).toBe("starting");

    useStore.setState((state) => ({
      rpc: {
        ...state.rpc,
        [TAB]: {
          ...state.rpc[TAB]!,
          plan: { enabled: true, planFilePath: null, planAbsPath: null, approved: false },
        },
      },
    }));
    respond(TAB, command.cmd, {});
    await Promise.all([level, relaunch]);

    expect(mockBackend.setSessionModel).toHaveBeenCalledWith(
      TAB,
      "openrouter/qwen",
      "medium",
    );
    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      TAB,
      true,
      "openrouter/openai/gpt-5.6-sol:low",
      true,
    );
    expect(mockBackend.setSessionModel.mock.invocationCallOrder[0]).toBeLessThan(
      mockBackend.setSessionAdvisor.mock.invocationCallOrder[0]!,
    );
  });

  it("preserves known Build posture when no newer status arrives", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({
      state: backendState,
      rpc: {
        [TAB]: rpcTabState({
          plan: { enabled: false, planFilePath: null, planAbsPath: null, approved: false },
        }),
      },
    });

    await useStore.getState().setSessionAdvisor(TAB, true, "openrouter/a/b:high");

    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
  });

  it("restores prior mode when an unsettled command cancels advisor relaunch", async () => {
    vi.useFakeTimers();
    try {
      backendState = stateWithRecord("sess-1");
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
      useStore.setState({ state: backendState, rpc: { [TAB]: rpc } });

      const relaunch = useStore.getState().setSessionAdvisor(TAB, true, "openrouter/a/b:high");
      expectPrepared();
      await vi.advanceTimersByTimeAsync(31_000);
      await relaunch;

      expect(useStore.getState().rpc[TAB]!.plan).toEqual(priorPlan);
      expect(mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("blocks user-facing process commands while a relaunch is starting", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({
      state: backendState,
      rpc: { [TAB]: rpcTabState({ status: "starting" }) },
    });

    await Promise.all([
      useStore.getState().sendPrompt(TAB, "prompt"),
      useStore.getState().abortAndPrompt(TAB, "replace"),
      useStore.getState().setModel(TAB, { id: "m", name: "M", provider: "p" }),
      useStore.getState().setThinkingLevel(TAB, "medium"),
      useStore.getState().setPlanMode(TAB, true),
      useStore.getState().setSessionAdvisor(TAB, true, "p/a:low"),
    ]);

    expect(sent).toEqual([]);
    expect(mockBackend.setSessionModel).not.toHaveBeenCalled();
    expect(mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
  });

  it("leaves RPC state alone for an unchanged advisor tuple and a PTY resume", async () => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({ state: backendState, rpc: { [TAB]: staleRpc() } });
    await useStore.getState().setSessionAdvisor(TAB, false, null);
    expect(useStore.getState().rpc[TAB]).toEqual(staleRpc());

    backendState = stateWithRecord("sess-1", "dormant");
    backendState.projects[0]!.sessions[0]!.mode = "pty";
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: TAB });
    useStore.setState({
      state: backendState,
      exited: { [TAB]: 1 },
      rpc: { [TAB]: staleRpc() },
    });
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
    const tab = useStore.getState().rpc[TAB]!;
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
    const commands = await driveBoot(TAB, {
      get_messages: { data: { messages: [] } },
    });
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
        if (cmd.type === "prompt" && cmd.message === "/omp-ui-advisor-stats")
          arms.push(cmd);
        respond(TAB, cmd, {});
      }
    }
    await boot;
    for (const { cmd } of sent.splice(0)) {
      if (cmd.type === "prompt" && cmd.message === "/omp-ui-advisor-stats")
        arms.push(cmd);
      respond(TAB, cmd, {});
    }
    expect(arms).toHaveLength(1);
  });

  it("reports error, not ready, when get_state fails", async () => {
    backendState = stateWithRecord("s");
    useStore.setState({ state: backendState });
    await driveBoot(TAB, {
      get_state: { success: false, data: "process dead" },
    });
    const tab = useStore.getState().rpc[TAB]!;
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
    backendState = stateWithRecord("s");
    useStore.setState({
      state: backendState,
      rpc: {
        [TAB]: rpcTabState({
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

    await driveBoot(TAB);

    expect(useStore.getState().rpc[TAB]!.status).toBe("ready");
    expect(useStore.getState().rpc[TAB]!.failure).toBeUndefined();
  });

  it("seeds advisorReply from the persisted advisorAutoReply setting (issue #111)", async () => {
    backendState = { ...stateWithRecord(null), advisorAutoReply: false };
    useStore.setState({ state: backendState });
    await driveBoot(TAB);
    expect(useStore.getState().rpc[TAB]!.advisorReply).toBe(false);
  });

  it("sweeps advisorReply across open tabs when the setting flips (issue #111)", async () => {
    backendState = stateWithRecord(null);
    useStore.setState({
      state: backendState,
      rpc: { [TAB]: rpcTabState({ advisorReply: true }) },
    });
    useStore.setState({ state: { ...backendState, advisorAutoReply: false } });
    expect(useStore.getState().rpc[TAB]!.advisorReply).toBe(false);
    useStore.setState({ state: { ...backendState, advisorAutoReply: true } });
    expect(useStore.getState().rpc[TAB]!.advisorReply).toBe(true);
  });
});

describe("rpcCommand / handleRpcFrame correlation", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
  });

  it("resolves a command by matching response id", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "get_state" });
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, { ok: 1 });
    await expect(promise).resolves.toMatchObject({
      command: "get_state",
      data: { ok: 1 },
    });
  });

  it("rejects with the server error on success:false", async () => {
    const promise = useStore.getState().rpcCommand(TAB, { type: "set_model" });
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, "unknown model", false);
    await expect(promise).rejects.toThrow("unknown model");
  });

  it("rejects a typed timeout and warns once with a safe diagnostic snapshot", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      backendState = stateWithRecord("s");
      useStore.setState({
        state: backendState,
        rpc: {
          [TAB]: rpcTabState({
            status: "running",
            session: { ...emptySessionRuntime(), isStreaming: true },
          }),
        },
      });
      const promise = useStore
        .getState()
        .rpcCommand(TAB, { type: "prompt", message: "private" });
      const cmd = sent.pop()!.cmd;
      const pending = useStore
        .getState()
        .rpc[TAB]!.pendingCommands.get(String(cmd.id));
      expect(pending).toMatchObject({
        command: "prompt",
        startedAt: expect.any(Number),
        timeoutMs: 30_000,
        quiet: false,
      });
      const typed = expect(promise).rejects.toBeInstanceOf(
        RpcCommandTimeoutError,
      );
      const fields = expect(promise).rejects.toMatchObject({
        name: "RpcCommandTimeoutError",
        command: "prompt",
        timeoutMs: 30_000,
      });

      await vi.advanceTimersByTimeAsync(30_000);
      await Promise.all([typed, fields]);

      expect(useStore.getState().rpc[TAB]!.pendingCommands.size).toBe(0);
      expect(warn).toHaveBeenCalledOnce();
      expect(warn).toHaveBeenCalledWith("[rpc] command timeout", {
        tabId: TAB,
        commandId: cmd.id,
        command: "prompt",
        timeoutMs: 30_000,
        elapsedMs: 30_000,
        pendingCommandCount: 0,
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
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "ready", maxFrameBytes: 1048576 });
    await flushMicrotasks();
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
  });

  it("boots an early ready frame before its renderer runtime exists", async () => {
    const earlyTab = "early-ready-tab";
    backendState = stateWithRecord(null);
    useStore.setState({ state: backendState, rpc: {} });

    useStore
      .getState()
      .handleRpcFrame(earlyTab, { type: "ready", maxFrameBytes: 1048576 });
    await flushMicrotasks();

    expect(useStore.getState().rpc[earlyTab]).toBeDefined();
    expect(
      sent.some(
        (entry) => entry.tabId === earlyTab && entry.cmd.type === "get_state",
      ),
    ).toBe(true);
  });
});

describe("handleRpcFrame routing", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
  });

  it("omp_ui_error records a fatal process failure", () => {
    useStore
      .getState()
      .handleRpcFrame(TAB, {
        type: "omp_ui_error",
        message: "handshake failed",
      });
    const tab = useStore.getState().rpc[TAB]!;
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
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "omp_ui_error", message: "process gone" });
    const fatal = useStore.getState().rpc[TAB]!.failure;
    const command = useStore.getState().setThinkingLevel(TAB, "high");
    respond(TAB, sent.pop()!.cmd, {});
    await command;
    expect(useStore.getState().rpc[TAB]!.failure).toBe(fatal);
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
    useStore.setState({
      rpc: { [`${TAB}-live`]: rpcTabState({ status: "running" }) },
    });
    useStore.getState().handleRpcFrame(`${TAB}-live`, {
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "first turn" }],
      },
    });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(true);
    // Spend lives on get_session_stats — without this tick the HUD cost
    // counter freezes for the whole run and only moves at agent_end.
    expect(sent.some((s) => s.cmd.type === "get_session_stats")).toBe(true);
  });

  it("throttles a burst of message_ends to one live usage snapshot", () => {
    useStore.setState({
      rpc: { [`${TAB}-burst`]: rpcTabState({ status: "running" }) },
    });
    const end = (text: string) =>
      useStore.getState().handleRpcFrame(`${TAB}-burst`, {
        type: "message_end",
        message: { role: "assistant", content: [{ type: "text", text }] },
      });
    end("a");
    end("b");
    end("c");
    expect(sent.filter((s) => s.cmd.type === "get_state")).toHaveLength(1);
    expect(sent.filter((s) => s.cmd.type === "get_session_stats")).toHaveLength(
      1,
    );
  });

  it("does not refresh get_state on message_end while idle", () => {
    useStore.setState({
      rpc: { [`${TAB}-idle`]: rpcTabState({ status: "ready" }) },
    });
    useStore.getState().handleRpcFrame(`${TAB}-idle`, {
      type: "message_end",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    expect(sent.some((s) => s.cmd.type === "get_state")).toBe(false);
  });

  describe("queue settle re-fetch (issue #181)", () => {
    const getStateCalls = () =>
      sent.filter((s) => s.cmd.type === "get_state");

    /** Fires agent_end mid-run and answers the immediate get_state refresh. */
    const endTurnWithCount = async (key: string, count: number) => {
      useStore.getState().handleRpcFrame(key, { type: "agent_end" });
      respond(key, getStateCalls().at(-1)!.cmd, {
        queuedMessageCount: count,
      });
      await flushMicrotasks();
    };

    it("re-fetches once when a turn ends with a nonzero queue count", async () => {
      vi.useFakeTimers();
      try {
        const key = `${TAB}-settle-once`;
        useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 1);
        expect(getStateCalls()).toHaveLength(1);
        expect(useStore.getState().rpc[key]!.session.queuedMessageCount).toBe(
          1,
        );
        // omp-side settle work (advice reclaim, deferred flush) can land just
        // after agent_end — one delayed re-fetch catches it.
        await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_REFRESH_MS);
        await flushMicrotasks();
        expect(getStateCalls()).toHaveLength(2);
        // The re-fetch settles the count; no further polling once it clears.
        respond(key, getStateCalls().at(-1)!.cmd, { queuedMessageCount: 0 });
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_REFRESH_MS * 4);
        await flushMicrotasks();
        expect(getStateCalls()).toHaveLength(2);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not re-fetch when the turn ends with an empty queue", async () => {
      vi.useFakeTimers();
      try {
        const key = `${TAB}-settle-empty`;
        useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 0);
        await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_REFRESH_MS * 2);
        await flushMicrotasks();
        expect(getStateCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("cancels the settle timer when a new turn starts", async () => {
      vi.useFakeTimers();
      try {
        const key = `${TAB}-settle-cancel`;
        useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        await endTurnWithCount(key, 1);
        useStore.getState().handleRpcFrame(key, { type: "agent_start" });
        await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_REFRESH_MS * 2);
        await flushMicrotasks();
        expect(getStateCalls()).toHaveLength(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("re-fetches when the agent_end get_state itself fails", async () => {
      vi.useFakeTimers();
      try {
        const key = `${TAB}-settle-fail`;
        useStore.setState({
          rpc: { [key]: rpcTabState({ status: "running" }) },
        });
        // Seed a nonzero last-known count through one clean cycle.
        await endTurnWithCount(key, 1);
        await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_REFRESH_MS);
        await flushMicrotasks();
        respond(key, getStateCalls().at(-1)!.cmd, { queuedMessageCount: 1 });
        await flushMicrotasks();
        // The next turn's closing refresh is lost: the settle timer is the
        // one retry, or the stale count would freeze in the composer.
        useStore.getState().handleRpcFrame(key, { type: "agent_start" });
        useStore.getState().handleRpcFrame(key, { type: "agent_end" });
        respond(key, getStateCalls().at(-1)!.cmd, "unavailable", false);
        await flushMicrotasks();
        await vi.advanceTimersByTimeAsync(QUEUE_SETTLE_REFRESH_MS);
        await flushMicrotasks();
        expect(getStateCalls()).toHaveLength(4);
      } finally {
        vi.useRealTimers();
      }
    });
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
    expect(useStore.getState().rpc[TAB]!.extensionStatus).toEqual({
      advisor: "reviewing",
    });
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
    expect(sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "e5",
    });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "extension notify auto-cancelled",
      }),
    ]);
  });

  it("open_url opens the system browser, confirms, and stamps a marker", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "u1",
      method: "open_url",
      url: "https://auth.example.com/login?state=1",
    });
    expect(openedUrls).toEqual(["https://auth.example.com/login?state=1"]);
    expect(sent.pop()!.cmd).toEqual({
      type: "extension_ui_response",
      id: "u1",
      confirmed: true,
    });
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
      expect.objectContaining({
        kind: "marker",
        label: "opened browser: https://auth.example.com",
      }),
    ]);
  });

  it("open_url without a url string is cancelled, never opened", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "u2",
      method: "open_url",
    });
    expect(openedUrls).toHaveLength(0);
    expect(sent.pop()!.cmd).toMatchObject({
      type: "extension_ui_response",
      id: "u2",
      cancelled: true,
    });
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
    expect(tab.plan).toMatchObject({
      enabled: true,
      planFilePath: "local://a-plan.md",
    });
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

  describe("MCP runtime failure state", () => {
    const statusFrame = (statusText: string, id = "mcp-status") => ({
      type: "extension_ui_request",
      id,
      method: "setStatus",
      statusKey: MCP_RUNTIME_STATUS_KEY,
      statusText,
    });

    it("derives one warning per new auth and connection failure", () => {
      useStore.getState().handleRpcFrame(TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [
          { serverName: "oauth-broken", kind: "auth" },
          { serverName: "offline", kind: "connection" },
        ],
      })));

      const tab = useStore.getState().rpc[TAB]!;
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
      useStore.getState().handleRpcFrame(TAB, statusFrame(failed, "first"));
      useStore.getState().handleRpcFrame(TAB, statusFrame(failed, "repeat"));
      useStore.getState().handleRpcFrame(TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: ["remote"],
        failedServers: [],
      }), "connected"));

      const tab = useStore.getState().rpc[TAB]!;
      expect(tab.items.filter((item) => item.kind === "notice")).toHaveLength(1);
      expect(tab.mcpStatus).toEqual({
        pendingServers: [],
        connectedServers: ["remote"],
        failedServers: [],
      });
    });

    it("claims malformed status without changing state or creating a generic chip", () => {
      useStore.getState().handleRpcFrame(TAB, statusFrame("{not-json"));
      const tab = useStore.getState().rpc[TAB]!;
      expect(tab.mcpStatus).toBeNull();
      expect(tab.items).toEqual([]);
      expect(tab.extensionStatus).toEqual({});
    });

    it("updates and warns a background tab", () => {
      useStore.setState({ activeTabId: "another-tab" });
      useStore.getState().handleRpcFrame(TAB, statusFrame(JSON.stringify({
        pendingServers: [],
        connectedServers: [],
        failedServers: [{ serverName: "background", kind: "connection" }],
      })));
      expect(useStore.getState().rpc[TAB]!.mcpStatus?.failedServers).toEqual([
        { serverName: "background", kind: "connection" },
      ]);
      expect(useStore.getState().rpc[TAB]!.items).toHaveLength(1);
    });
    it("clears process-scoped status and notices when the tab boots again", async () => {
      const relaunchTab = "mcp-relaunch-tab";
      const state = stateWithRecord("session-1");
      state.projects[0]!.sessions[0]!.tabId = relaunchTab;
      backendState = state;
      useStore.setState({
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

      await driveBoot(relaunchTab);

      expect(useStore.getState().rpc[relaunchTab]!.mcpStatus).toBeNull();
      expect(useStore.getState().rpc[relaunchTab]!.items).toEqual([]);
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
        const store = useStore.getState();
        store.handleRpcFrame(TAB, {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        });
        vi.setSystemTime(1_000_000 + 123_000);
        useStore.getState().handleRpcFrame(TAB, stallFrame);
        const last = useStore.getState().rpc[TAB]!.items.at(-1);
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
        const store = useStore.getState();
        store.handleRpcFrame(TAB, {
          type: "message_update",
          assistantMessageEvent: { type: "toolcall_end" },
        });
        vi.setSystemTime(1_120_000);
        store.handleRpcFrame(TAB, {
          type: "tool_execution_start",
          toolCallId: "t1",
        });
        vi.setSystemTime(1_123_000);
        store.handleRpcFrame(TAB, {
          type: "tool_execution_update",
          toolCallId: "t1",
        });
        store.handleRpcFrame(TAB, stallFrame);
        const last = useStore.getState().rpc[TAB]!.items.at(-1);
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
        useStore.getState().handleRpcFrame(TAB, stallFrame);
        vi.setSystemTime(1_100_000);
        useStore.getState().handleRpcFrame(TAB, { ...stallFrame, attempt: 2 });
        const notices = useStore
          .getState()
          .rpc[TAB]!.items.filter((i) => i.kind === "notice");
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
      useStore.getState().handleRpcFrame(TAB, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 10,
        delayMs: 2000,
        errorMessage: "429 rate limit",
      });
      const tab = useStore.getState().rpc[TAB]!;
      expect(tab.items.filter((i) => i.kind === "notice")).toEqual([]);
      const last = tab.items[tab.items.length - 1];
      expect(last).toMatchObject({
        kind: "marker",
        label: "auto-retry 1/10 started — retrying in 2.0s",
      });
    });

    it("admits an unknown stage when only the Timeout bit is available", () => {
      useStore.getState().handleRpcFrame(TAB, {
        type: "auto_retry_start",
        attempt: 1,
        maxAttempts: 10,
        delayMs: 2000,
        errorId: 0x0006_0000,
      });
      const notice = useStore
        .getState()
        .rpc[TAB]!.items.find((i) => i.kind === "notice");
      if (notice?.kind !== "notice") return;
      expect(notice.level).toBe("warn");
      expect(notice.text).toContain("supplied no watchdog stage");
      expect(notice.text).not.toContain("Upstream error:");
    });

    it("distinguishes first-event from idle and avoids unsupported attribution", () => {
      useStore.getState().handleRpcFrame(TAB, {
        ...stallFrame,
        errorMessage:
          "OpenAI responses stream timed out while waiting for the first event",
      });
      useStore.getState().handleRpcFrame(TAB, stallFrame);
      const notices = useStore
        .getState()
        .rpc[TAB]!.items.filter((i) => i.kind === "notice");
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
    expect(tab.planReview?.request).toMatchObject({
      planFilePath: "local://auth-plan.md",
    });
    expect(tab.extensionQueue).toHaveLength(0);
    // The agent is blocked on this select — nothing may answer it early.
    expect(sent.some((s) => s.cmd.type === "extension_ui_response")).toBe(
      false,
    );
  });

  it("reads one file and flags an html plan for iframe rendering", async () => {
    useStore.getState().handleRpcFrame(TAB, {
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
    await flushMicrotasks();
    const tab = useStore.getState().rpc[TAB]!;
    // The html file IS the plan — one read, and planHtml is only the flag that
    // says "render this text in an iframe", never a second document.
    expect(mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab.planText).toBe("<h1>Plan</h1>");
    expect(tab.planHtml).toBe("<h1>Plan</h1>");
  });

  it("leaves planHtml null for a markdown plan", async () => {
    useStore.getState().handleRpcFrame(TAB, {
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
    await flushMicrotasks();
    const tab = useStore.getState().rpc[TAB]!;
    expect(mockBackend.readPlanFile).toHaveBeenCalledTimes(1);
    expect(tab.planText).toBe("# Plan\n\nstep one\n");
    expect(tab.planHtml).toBeNull();
  });

  it("clears both plan fields when an html plan cannot be read", async () => {
    mockBackend.readPlanFile.mockRejectedValueOnce(new Error("ENOENT"));
    useStore.getState().handleRpcFrame(TAB, {
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
    await flushMicrotasks();
    const tab = useStore.getState().rpc[TAB]!;
    // A failed read must not leave the pane flagged for iframe rendering with
    // nothing to render — the review itself stays open either way.
    expect(tab.planText).toBeNull();
    expect(tab.planHtml).toBeNull();
    expect(tab.planReview).not.toBeNull();
  });

  it("executing a review answers with the execute verdict and closes the pane", async () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p3",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
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
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
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

  it("holds the implementation prompt until the session reports Build after execute (issue #165)", async () => {
    // The proposing session published armed status; the verdict's exit frame
    // is still in flight when the verdict is answered.
    useStore.setState((s) => ({
      rpc: {
        ...s.rpc,
        [TAB]: {
          ...s.rpc[TAB]!,
          plan: {
            enabled: true,
            planFilePath: "local://p.md",
            planAbsPath: "/p.md",
            approved: false,
          },
        },
      },
    }));
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p3c",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
    useStore.getState().executePlan(TAB, "existing");
    // Verdict landed, but no implementation prompt yet — it waits for Build.
    expect(sent.find((s) => s.cmd.type === "prompt")).toBeUndefined();
    // The extension's in-process exit publishes its status frame.
    useStore.getState().handleRpcFrame(TAB, {
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
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    await flushMicrotasks();
  });

  it("forces plan mode off before dispatching when the verdict's exit never publishes (issue #165)", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState((s) => ({
        rpc: {
          ...s.rpc,
          [TAB]: {
            ...s.rpc[TAB]!,
            plan: {
              enabled: true,
              planFilePath: "local://p.md",
              planAbsPath: "/p.md",
              approved: false,
            },
          },
        },
      }));
      useStore.getState().handleRpcFrame(TAB, {
        type: "extension_ui_request",
        id: "p3d",
        method: "select",
        title:
          "omp-ui:plan-review:" +
          JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
      });
      useStore.getState().executePlan(TAB, "existing");
      // No exit frame ever arrives; the bounded wait expires and the mode
      // command is sent directly.
      await vi.advanceTimersByTimeAsync(15_000);
      await flushMicrotasks();
      const off = sent.find(
        (s) =>
          s.tabId === TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message) === "/omp-ui-plan off",
      );
      expect(off).toBeDefined();
      // The forced exit answers with its status frame; implementation follows.
      useStore.getState().handleRpcFrame(TAB, {
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
      await flushMicrotasks();
      expect(
        sent.find(
          (s) =>
            s.tabId === TAB &&
            s.cmd.type === "prompt" &&
            String(s.cmd.message).includes("execute the approved plan"),
        ),
      ).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("refining a review answers with the refine verdict and sends no prompt", () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "p4",
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
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
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
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
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        startInPlanMode: false,
        planImplementationSource: {
          sourceTabId: TAB,
          planTitle: "t",
          planFilePath: "local://p.md",
        },
      }),
    );
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === "fresh-tab" &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("# Plan"),
    );
    expect(prompt).toBeDefined();
    expect(prompt!.cmd.message).toContain("Implement it now");
    await flushMicrotasks();
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
    mockBackend.readPlanFile.mockResolvedValueOnce(htmlPlan);
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    useStore.getState().handleRpcFrame(TAB, {
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
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh");
    await flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) => s.tabId === "fresh-tab" && s.cmd.type === "prompt",
    );
    expect(prompt).toBeDefined();
    // The implementer needs the spec inline; the presentation layer is pure
    // token cost in a prompt.
    expect(String(prompt!.cmd.message)).toContain("Ship the auth rewrite");
    expect(String(prompt!.cmd.message)).not.toContain("rebeccapurple");
    await flushMicrotasks();
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
    useStore.getState().handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id,
      method: "select",
      title:
        "omp-ui:plan-review:" +
        JSON.stringify({ title: "t", planFilePath: "local://p.md" }),
    });
  };

  it("holds execute for the drafting turn's advisor review, then folds its concerns", async () => {
    // Fake timers for the whole test: the same review that feeds the fold also
    // arms the idle auto-reply, and only a fake clock can advance past its
    // settle window to prove the fold's dispatch stays the only prompt.
    vi.useFakeTimers();
    try {
      // Configured advisor = a review of the plan turn is on its way after the verdict.
      useStore.setState({
        rpc: {
          [TAB]: rpcTabState({
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
      useStore
        .getState()
        .handleRpcFrame(
          TAB,
          advisorReviewFrame("Hardcoded key", "blocker", "security"),
        );
      await flushMicrotasks();
      const prompt = sent.find(
        (s) =>
          s.tabId === TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
      expect(prompt).toBeDefined();
      expect(String(prompt!.cmd.message)).toContain("advisor flagged");
      expect(String(prompt!.cmd.message)).toContain("Hardcoded key");
      expect(String(prompt!.cmd.message)).toContain("[blocker]");
      const tab = useStore.getState().rpc[TAB]!;
      expect(tab.items.at(-1)).toMatchObject({
        kind: "notice",
        text: expect.stringContaining("1 concern"),
      });
      // The fold already answered this review; the auto-reply must not send a second.
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
      await flushMicrotasks();
      expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(1);
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
      useStore.setState({ rpc: { [TAB]: rpcTabState({ status: "running" }) } });
      useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
      expect(useStore.getState().rpc[TAB]!.status).toBe("ready");
      useStore
        .getState()
        .handleRpcFrame(TAB, advisorReviewFrame("Do it now", "concern", "ops"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
    } finally {
      vi.useRealTimers();
    }
    await flushMicrotasks();
    const replies = sent.filter((s) => s.cmd.type === "prompt");
    expect(replies).toHaveLength(1);
    // followUp keeps the reply on the same session without restarting its turn.
    expect(replies[0]!.cmd).toMatchObject({ streamingBehavior: "followUp" });
    expect(String(replies[0]!.cmd.message)).toContain("Do it now");
    expect(String(replies[0]!.cmd.message)).toContain("[concern]");
    // The transcript says why a prompt nobody typed appeared.
    const items = useStore.getState().rpc[TAB]!.items;
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
      useStore.setState({
        rpc: { [TAB]: rpcTabState({ status: "running", advisorReply: false }) },
      });
      useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
      useStore
        .getState()
        .handleRpcFrame(TAB, advisorReviewFrame("Do it now", "concern", "ops"));
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await flushMicrotasks();
    expect(sent.some((s) => s.cmd.type === "prompt")).toBe(false);
    const items = useStore.getState().rpc[TAB]!.items;
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("answering it")),
    ).toBe(false);
  });

  it("executes immediately, and reads no transcript, when the fold is off", async () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
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
    useStore.getState().executePlan(TAB, "existing", { addressAdvisor: false });
    await flushMicrotasks();
    const prompt = sent.find((s) => s.tabId === TAB && s.cmd.type === "prompt");
    expect(prompt).toBeDefined();
    // Stale pre-verdict advisories are never folded onto a fresh verdict.
    expect(String(prompt!.cmd.message)).not.toContain("old unrelated nit");
  });

  it("skips the wait entirely when the session has no configured advisor", () => {
    useStore.setState({ rpc: { [TAB]: rpcTabState({ advisorStats: null }) } });
    openReview("c3");
    useStore.getState().executePlan(TAB, "existing");
    expect(sent.find((s) => s.cmd.type === "prompt")).toBeDefined();
  });

  it("refine stays immediate: user notes steer at once, never waiting on a review", () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
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
    expect(
      sent.find((s) => s.cmd.type === "extension_ui_response")!.cmd,
    ).toMatchObject({
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
          [TAB]: rpcTabState({
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
        (s) =>
          s.tabId === TAB &&
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
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
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
    expect(useStore.getState().rpc[TAB]!.planReview).toBeNull();
    useStore
      .getState()
      .handleRpcFrame(
        TAB,
        advisorReviewFrame("pin the toolchain", "concern", "ops"),
      );
    await flushMicrotasks();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        planImplementationSource: {
          sourceTabId: TAB,
          planTitle: "t",
          planFilePath: "local://p.md",
        },
        startInPlanMode: false,
      }),
    );
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === "fresh-tab" &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("Implement it now"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message)).toContain("pin the toolchain");
    await flushMicrotasks();
  });

  it("fresh implementation spawns with the app default advisor when none is staged (issue #174)", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "fresh-default-on",
    });
    useStore.setState({
      state: { ...stateWithRecord(null), defaultAdvisor: true },
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReview("d1");
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh");
    await flushMicrotasks();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        advisor: true,
        startInPlanMode: false,
      }),
    );
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-default-on": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
  });

  it("fresh implementation defaults the advisor off against omp config when none is staged (issue #174)", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "fresh-default-off",
    });
    useStore.setState({
      state: stateWithRecord(null),
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });
    openReview("d2");
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh");
    await flushMicrotasks();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        advisor: false,
        startInPlanMode: false,
      }),
    );
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-default-off": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
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
    useStore.getState().handleRpcFrame(TAB, {
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
    useStore.getState().executePlan(TAB, "existing", { orchestrate: true });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
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
    useStore.getState().executePlan(TAB, "existing", { ultrathink: true });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
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
    useStore.getState().executePlan(TAB, "existing", { workflowz: true, ultrathink: true });
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
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
    useStore.getState().executePlan(TAB, "existing");
    await flushMicrotasks();
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
    expect(String(prompt!.cmd.message).startsWith("orchestrate")).toBe(false);
  });

  it("prepends the orchestrate keyword to a fresh session's seed", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    openReviewWithPlan("o3");
    // Let the plan file read resolve so executePlan captures the plan text.
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh", { orchestrate: true });
    await flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
    const prompt = sent.find(
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
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    openReviewWithPlan("o3w");
    // Let the plan file read resolve so executePlan captures the plan text.
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh", { workflowz: true });
    await flushMicrotasks();
    // Boot the fresh tab to ready — resolves the spawn's readiness wait.
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
    const prompt = sent.find(
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
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    openReview("m1");
    useStore.getState().executePlan(TAB, "existing", {
      model: MODEL_X,
      thinkingLevel: "high",
      advisor: false,
      advisorModel: null,
    });
    await flushMicrotasks();
    const onTab = (s: (typeof sent)[number]) => s.tabId === TAB;
    // The staged pair applies over RPC first; each awaited command stalls the
    // chain until the test answers it.
    const setModel = sent.find((s) => onTab(s) && s.cmd.type === "set_model");
    expect(setModel?.cmd).toMatchObject({ provider: "p2", modelId: "mx" });
    respond(TAB, setModel!.cmd, {});
    await flushMicrotasks();
    const setLevel = sent.find(
      (s) => onTab(s) && s.cmd.type === "set_thinking_level",
    );
    expect(setLevel?.cmd).toMatchObject({ level: "high" });
    respond(TAB, setLevel!.cmd, {});
    await flushMicrotasks();
    const modelIdx = sent.findIndex(
      (s) => onTab(s) && s.cmd.type === "set_model",
    );
    const levelIdx = sent.findIndex(
      (s) => onTab(s) && s.cmd.type === "set_thinking_level",
    );
    const promptIdx = sent.findIndex(
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
    expect(mockBackend.setSessionModel).toHaveBeenLastCalledWith(
      TAB,
      "p2/mx",
      "high",
    );
  });

  it("an unchanged staged tuple is a no-op", async () => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          model: { id: "m1", name: "M1", provider: "p" },
          session: { ...emptySessionRuntime(), thinkingLevel: "low" },
        }),
      },
    });
    openReview("m2");
    useStore.getState().executePlan(TAB, "existing", {
      model: { id: "m1", name: "M1", provider: "p" },
      thinkingLevel: "low",
      advisor: false,
      advisorModel: null,
    });
    await flushMicrotasks();
    expect(sent.some((s) => s.cmd.type === "set_model")).toBe(false);
    expect(sent.some((s) => s.cmd.type === "set_thinking_level")).toBe(false);
    expect(mockBackend.setSessionAdvisor).not.toHaveBeenCalled();
    // Staging what is already live must preserve today's behavior exactly.
    const prompt = sent.find(
      (s) =>
        s.tabId === TAB &&
        s.cmd.type === "prompt" &&
        String(s.cmd.message).includes("execute the approved plan"),
    );
    expect(prompt).toBeDefined();
  });

  it("an advisor change relaunches the session before dispatching", async () => {
    useStore.setState({
      state: stateWithRecord(null),
      rpc: { [TAB]: rpcTabState() },
    });
    openReview("a1");
    useStore.getState().executePlan(TAB, "existing", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
    });
    await flushMicrotasks();
    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
    const implementationPrompt = () =>
      sent.find(
        (s) =>
          s.tabId === TAB &&
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      );
    // The relaunch parked the tab at "starting" — the prompt waits on readiness.
    expect(implementationPrompt()).toBeUndefined();
    useStore.setState({
      rpc: { [TAB]: { ...useStore.getState().rpc[TAB]!, status: "ready" } },
    });
    await flushMicrotasks();
    const prompt = implementationPrompt();
    expect(prompt).toBeDefined();
    // A relaunched session has no plan turn in flight, so the prompt steers.
    expect(prompt!.cmd.streamingBehavior).toBe("steer");
  });

  it("a failed advisor relaunch never dispatches the prompt", async () => {
    useStore.setState({
      state: stateWithRecord(null),
      rpc: { [TAB]: rpcTabState() },
    });
    openReview("a2");
    useStore.getState().executePlan(TAB, "existing", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
    });
    await flushMicrotasks();
    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
    useStore.setState({
      rpc: { [TAB]: { ...useStore.getState().rpc[TAB]!, status: "error" } },
    });
    await flushMicrotasks();
    expect(
      sent.some(
        (s) =>
          s.cmd.type === "prompt" &&
          String(s.cmd.message).includes("execute the approved plan"),
      ),
    ).toBe(false);
  });

  it("a fresh session receives the staged advisor tuple and model", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-tab" });
    useStore.setState({ state: stateWithRecord(null) });
    openReviewWithPlan("a3");
    await flushMicrotasks();
    useStore.getState().executePlan(TAB, "fresh", {
      advisor: true,
      advisorModel: "openrouter/a/b:high",
      model: MODEL_X,
      thinkingLevel: "high",
    });
    await flushMicrotasks();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        advisor: true,
        advisorModel: "openrouter/a/b:high",
      }),
    );
    useStore.setState({
      rpc: {
        ...useStore.getState().rpc,
        "fresh-tab": rpcTabState({ status: "ready", planText: null }),
      },
    });
    await flushMicrotasks();
    const onFresh = (s: (typeof sent)[number]) => s.tabId === "fresh-tab";
    const setModel = sent.find((s) => onFresh(s) && s.cmd.type === "set_model");
    expect(setModel?.cmd).toMatchObject({ provider: "p2", modelId: "mx" });
    respond("fresh-tab", setModel!.cmd, {});
    await flushMicrotasks();
    const setLevel = sent.find(
      (s) => onFresh(s) && s.cmd.type === "set_thinking_level",
    );
    expect(setLevel?.cmd).toMatchObject({ level: "high" });
    respond("fresh-tab", setLevel!.cmd, {});
    await flushMicrotasks();
    const modelIdx = sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "set_model",
    );
    const levelIdx = sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "set_thinking_level",
    );
    const promptIdx = sent.findIndex(
      (s) => onFresh(s) && s.cmd.type === "prompt",
    );
    expect(modelIdx).toBeGreaterThanOrEqual(0);
    expect(modelIdx).toBeLessThan(levelIdx);
    expect(levelIdx).toBeLessThan(promptIdx);
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
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "host_tool_call", id: "h1", name: "x" });
    expect(sent.pop()!.cmd).toMatchObject({
      type: "host_tool_result",
      id: "h1",
    });
  });

  it("answers host_uri_request instead of leaving the agent blocked", () => {
    useStore
      .getState()
      .handleRpcFrame(TAB, {
        type: "host_uri_request",
        id: "u1",
        operation: "read",
        url: "db://x",
      });
    expect(sent.pop()!.cmd).toMatchObject({
      type: "host_uri_result",
      id: "u1",
      error: "omp-ui registers no uri schemes",
    });
  });

  it("command_output attaches to the newest running command row", () => {
    const first = commandItem("usage", "");
    const second = commandItem("context", "");
    useStore.setState({
      rpc: { [TAB]: rpcTabState({ items: [first, second] }) },
    });
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "command_output", text: "out-1" });
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "command_output", text: "out-2" });
    const items = useStore.getState().rpc[TAB]!.items;
    expect(items[0]).toBe(first);
    expect(items[1]).toMatchObject({ id: second.id, output: "out-1\nout-2" });
  });

  it("command_output with no running command row falls back to a notice", () => {
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "command_output", text: "stray reply" });
    const items = useStore.getState().rpc[TAB]!.items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: "notice",
      text: "stray reply",
      level: "info",
    });
  });

  it("command_output accumulation is capped, head-preserving", () => {
    const item = commandItem("usage", "");
    useStore.setState({ rpc: { [TAB]: rpcTabState({ items: [item] }) } });
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "command_output", text: "x".repeat(64 * 1024) });
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "command_output", text: "tail" });
    const updated = useStore.getState().rpc[TAB]!.items[0]!;
    expect(updated.kind).toBe("command");
    const output = updated.kind === "command" ? updated.output! : "";
    expect(output.length).toBeLessThanOrEqual(64 * 1024 + 24);
    expect(output.startsWith("xxx")).toBe(true);
    expect(output.endsWith("… output truncated")).toBe(true);
  });

  it("available_commands_update replaces the command palette", () => {
    useStore.getState().handleRpcFrame(TAB, {
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
    const { commands } = useStore.getState().rpc[TAB]!;
    expect(commands.map((c) => c.name)).toEqual(["stats", "model"]);
    expect(commands[1]).toMatchObject({
      aliases: ["m"],
      description: "pick model",
    });
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
      expect.objectContaining({
        kind: "marker",
        label: "subagent scout: started",
        tone: "copper",
      }),
    ]);
    expect(sent.some((s) => s.cmd.type === "get_subagents")).toBe(true);
  });

  it("thinking_level_changed patches the session as well as the transcript", () => {
    useStore
      .getState()
      .handleRpcFrame(TAB, {
        type: "thinking_level_changed",
        thinkingLevel: "max",
      });
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
    sent.filter((s) => s.cmd.type === "prompt" && s.cmd.message === STALL_CONTINUE_LEAD);

  it("continues a stalled turn end with a bounded follow-up prompt (incident replay)", async () => {
    const T = "tab-stall-a";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = useStore.getState();
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
    await flushMicrotasks();

    // The in-flight ask card reads aborted, not cancelled.
    const items = useStore.getState().rpc[T]!.items;
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
      backendState = { ...backendState, stallAutoContinue: false };
      useStore.setState({
        state: backendState,
        rpc: { [T]: rpcTabState({ status: "running" }) },
      });
      const store = useStore.getState();
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
    await flushMicrotasks();
    expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    const items = useStore.getState().rpc[T]!.items;
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(true);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("stall auto-continue")),
    ).toBe(false);
  });

  it("does not continue a user interrupt: the card cancels, no diagnostic, no prompt", async () => {
    const T = "tab-stall-c";
    useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
    const store = useStore.getState();
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
    await flushMicrotasks();
    const items = useStore.getState().rpc[T]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "cancelled" });
    expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
  });

  it("aborts cards on a non-stall error end, with no diagnostic and no continue", async () => {
    const T = "tab-stall-d";
    useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
    const store = useStore.getState();
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
    await flushMicrotasks();
    const items = useStore.getState().rpc[T]!.items;
    const tool = items.find((i) => i.kind === "tool");
    expect(tool).toMatchObject({ status: "aborted" });
    expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(
      items.some((i) => i.kind === "notice" && i.text.includes("provider stream stall")),
    ).toBe(false);
  });

  it("a watchdog abort notice feeds auto-continue", async () => {
    const T = "tab-stall-w1";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = useStore.getState();
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
    await flushMicrotasks();

    const items = useStore.getState().rpc[T]!.items;
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
    expect(useStore.getState().rpc[T]!.stallAbortPending ?? false).toBe(false);
  });

  it("the app switch also gates watchdog-abort continues", async () => {
    const T = "tab-stall-w2";
    vi.useFakeTimers();
    try {
      backendState = { ...backendState, stallAutoContinue: false };
      useStore.setState({
        state: backendState,
        rpc: { [T]: rpcTabState({ status: "running" }) },
      });
      const store = useStore.getState();
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
    await flushMicrotasks();

    const items = useStore.getState().rpc[T]!.items;
    // The abort report still lands in the transcript; only the continue is gated.
    expect(
      items.some(
        (i) =>
          i.kind === "notice" && i.level === "warn" && i.text.includes("aborted a stalled turn"),
      ),
    ).toBe(true);
    expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
  });

  it("an untagged omp_ui_notice does not arm auto-continue", async () => {
    const T = "tab-stall-w3";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = useStore.getState();
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
    await flushMicrotasks();

    expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
    expect(useStore.getState().rpc[T]!.stallAbortPending ?? false).toBe(false);
  });

  it("caps consecutive continues, then re-arms on a user prompt", async () => {
    const T = "tab-stall-e";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      // One stalled turn end: the continue prompt goes out, then its turn
      // (simulated) dies to a stall again.
      const stalledTurn = async () => {
        useStore.setState((s) => ({
          rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
        }));
        useStore.getState().handleRpcFrame(T, stallEndFrame());
        useStore.getState().handleRpcFrame(T, { type: "agent_end" });
        await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      };

      await stalledTurn();
      expect(continuePrompts()).toHaveLength(1);
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(2);

      // A third consecutive stall hits the cap: explained once, nothing sent.
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(2);
      const capped = useStore
        .getState()
        .rpc[T]!.items.filter(
          (i) => i.kind === "notice" && i.text === STALL_CONTINUE_CAP_NOTICE,
        );
      expect(capped).toHaveLength(1);

      // The per-session stall counter (issue #100 numbering) advanced across
      // stalls — stallNotice must mutate the live tab, not the frame-start
      // capture the ready patch above it replaced.
      const stallNotices = useStore
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
      void useStore.getState().sendPrompt(T, "carry on");
      await stalledTurn();
      expect(continuePrompts()).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
    await flushMicrotasks();
  });

  it("a user prompt inside the settle window wins the race", async () => {
    const T = "tab-stall-f";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      // The user sees the error and types their own continuation.
      void useStore.getState().sendPrompt(T, "carry on where you stopped");
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await flushMicrotasks();
    const prompts = sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]!.cmd.message).toBe("carry on where you stopped");
  });

  it("does not dispatch into a process that died inside the settle window", async () => {
    const T = "tab-stall-g";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      const store = useStore.getState();
      store.handleRpcFrame(T, {
        type: "tool_execution_start",
        toolCallId: "t1",
        toolName: "bash",
      });
      store.handleRpcFrame(T, stallEndFrame());
      store.handleRpcFrame(T, { type: "agent_end" });
      // The session process dies before the settle window closes.
      useStore.setState((s) => ({ exited: { ...s.exited, [T]: 1 } }));
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS * 2);
    } finally {
      vi.useRealTimers();
    }
    await flushMicrotasks();
    expect(sent.filter((s) => s.cmd.type === "prompt")).toHaveLength(0);
  });

  it("the auto-continue does not reset the advisor-reply streak", async () => {
    const T = "tab-stall-h";
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [T]: rpcTabState({ status: "running" }) } });
      // The production sequence, load-bearing for the advisor watcher's cursor:
      // the reviewed turn's agent_end lands while the tab still reads running
      // (seeding the baseline past the marker), then the review arrives on the
      // idle session.
      const review = async (note: string) => {
        useStore.setState((s) => ({
          rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
        }));
        useStore.getState().handleRpcFrame(T, { type: "agent_end" });
        useStore.getState().handleRpcFrame(T, {
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
        sent.filter(
          (s) => s.cmd.type === "prompt" && String(s.cmd.message).startsWith(ADVISOR_REPLY_LEAD),
        );

      // Two reviews fill the reply guard's budget.
      await review("first finding");
      expect(advisorReplies()).toHaveLength(1);
      await review("second finding");
      expect(advisorReplies()).toHaveLength(2);

      // A stall end dispatches its continue; the advisor guard must not reset.
      useStore.setState((s) => ({
        rpc: { ...s.rpc, [T]: { ...s.rpc[T]!, status: "running" } },
      }));
      useStore.getState().handleRpcFrame(T, stallEndFrame());
      useStore.getState().handleRpcFrame(T, { type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_CONTINUE_SETTLE_MS);
      expect(continuePrompts()).toHaveLength(1);

      // A third review arrives: the guard is still capped, so it explains
      // instead of answering. Had the continue reset it, the reply would go out.
      await review("third finding");
      expect(advisorReplies()).toHaveLength(2);
      const capNotice = useStore.getState().rpc[T]!.items.find(
        (i) => i.kind === "notice" && i.text === ADVISOR_REPLY_CAP_NOTICE,
      );
      expect(capNotice).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
    await flushMicrotasks();
  });
});

describe("auto-title gating (setInitialPrompt)", () => {
  beforeEach(() => {
    backendState = stateWithRecord("sess-1");
    useStore.setState({
      state: backendState,
      rpc: { [TAB]: rpcTabState({ status: "running" }) },
    });
    sent.length = 0;
  });

  it("renames immediately from a substantive first prompt, no agent_end needed", async () => {
    useStore.getState().setInitialPrompt(TAB, "Refactor the auth module");
    // Latched and renamed synchronously — the title goes out as soon as the
    // prompt is offered, not when the first run ends.
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe(
      "Refactor the auth module",
    );
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

    useStore
      .getState()
      .setInitialPrompt(TAB, "Add pagination to the sessions list");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();
    const rename = sent.find((s) => s.cmd.type === "set_session_name");
    expect(rename!.cmd.name).toBe("Add pagination to the sessions list");
  });

  it("keeps the first substantive prompt as the title source", () => {
    // The first prompt latches and renames; a second prompt must not displace it.
    useStore.getState().setInitialPrompt(TAB, "Fix the login redirect");
    useStore.getState().setInitialPrompt(TAB, "Actually, fix logout too");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe(
      "Fix the login redirect",
    );
    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(true);
  });

  it("never titles a session that already has a user-visible name", async () => {
    const base = stateWithRecord("sess-1");
    backendState = {
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
          sessions: [
            { ...base.projects[0]!.sessions[0]!, title: "Some other title" },
          ],
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
      rpc: { [TAB]: rpcTabState({ status: "running" }) },
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
    expect(
      sent.splice(0).find((s) => s.cmd.type === "set_session_name"),
    ).toBeUndefined();
  });

  it("retries on the next agent_end when set_session_name fails", async () => {
    useStore.getState().setInitialPrompt(TAB, "Add a new API endpoint");
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();

    const firstBatch = sent.splice(0);
    expect(
      firstBatch.find((s) => s.cmd.type === "set_session_name"),
    ).toBeTruthy();
    for (const { tabId: tid, cmd } of firstBatch) {
      const ok = cmd.type !== "set_session_name";
      respond(tid, cmd, ok ? {} : "rejected", ok);
    }
    await flushMicrotasks();

    expect(useStore.getState().rpc[TAB]!.hasRenamed).toBe(false);
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe(
      "Add a new API endpoint",
    );

    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    await flushMicrotasks();
    expect(
      sent.splice(0).find((s) => s.cmd.type === "set_session_name"),
    ).toBeTruthy();
  });

  it("titles from omp's small model rather than the raw prompt", async () => {
    // The whole point of routing through the model: the title is a summary,
    // not a copy of the prompt.
    mockBackend.generateTitle.mockResolvedValueOnce(
      "Add sessions list pagination",
    );
    useStore
      .getState()
      .setInitialPrompt(
        TAB,
        "can you add pagination to the sessions list please",
      );
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
    useStore.setState({ state: backendState, rpc: { [TAB]: rpcTabState() } });
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

    useStore.setState({ rpc: { [TAB]: rpcTabState({ status: "running" }) } });
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
    useStore.setState({ rpc: { [TAB]: rpcTabState({ status: "running" }) } });
    const promise = useStore
      .getState()
      .sendPrompt(TAB, "and then this", "follow_up");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "and then this",
      streamingBehavior: "followUp",
    });
    await settleAll();
    await promise;
  });

  it("sendPrompt feeds the auto-titler immediately, no agent_end needed", async () => {
    const promise = useStore
      .getState()
      .sendPrompt(TAB, "Refactor the auth module");
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBe(
      "Refactor the auth module",
    );
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
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/advisor on",
    });
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
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
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
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/new later",
    });
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

  it("runSlashCommand /plan toggles plan mode on instead of prompting omp", async () => {
    useStore.setState({
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [TAB]: rpcTabState() },
    });
    const promise = useStore.getState().runSlashCommand(TAB, "/plan");
    // The configured plan format rides the `on` command (issue #109).
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on html",
    });
    expect(useStore.getState().rpc[TAB]!.initialPrompt).toBeNull();
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan on matches the bare toggle", async () => {
    useStore.setState({
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [TAB]: rpcTabState() },
    });
    const promise = useStore.getState().runSlashCommand(TAB, "/plan on");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on html",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan carries the markdown format when that is the setting", async () => {
    useStore.setState({
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [TAB]: rpcTabState() },
      state: { ...stateWithRecord("s1"), planFormat: "md" },
    });
    const promise = useStore.getState().runSlashCommand(TAB, "/plan");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan on md",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /plan off exits plan mode", async () => {
    useStore.setState({
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [TAB]: rpcTabState() },
    });
    const promise = useStore.getState().runSlashCommand(TAB, "/plan off");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan off",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand /no-plan exits plan mode", async () => {
    useStore.setState({
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      rpc: { [TAB]: rpcTabState() },
    });
    const promise = useStore.getState().runSlashCommand(TAB, "/no-plan");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/omp-ui-plan off",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand forwards /plan with arguments to omp", async () => {
    const promise = useStore
      .getState()
      .runSlashCommand(TAB, "/plan rewrite auth");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/plan rewrite auth",
    });
    await settleAll();
    await promise;
  });

  it("runSlashCommand forwards /plan from a pty tab to its TUI", async () => {
    useStore.setState({
      tabs: [
        tabInfo({ tabId: TAB, mode: "pty", projectCwd: "/p", hidden: false }),
      ],
    });
    const promise = useStore.getState().runSlashCommand(TAB, "/plan");
    expect(sent[0]!.cmd).toMatchObject({ type: "prompt", message: "/plan" });
    await settleAll();
    await promise;
  });

  /** Advertises commands so the echo path treats them as known (issue #241). */
  const seedCommands = (
    ...commands: Array<{ name: string; aliases?: string[] }>
  ): void => {
    useStore.setState({
      rpc: {
        [TAB]: rpcTabState({
          commands: commands.map((c) => ({ ...c, description: "" })),
        }),
      },
    });
  };

  it("runSlashCommand echoes an advertised command and settles done when no agent ran", async () => {
    seedCommands({ name: "usage" });
    const promise = useStore.getState().runSlashCommand(TAB, "/usage");
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "usage",
      args: "",
      status: "running",
    });
    respond(TAB, sent[0]!.cmd, { agentInvoked: false });
    await promise;
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("runSlashCommand matches aliases and marks the row agent when a turn starts", async () => {
    seedCommands({ name: "usage", aliases: ["cost"] });
    const promise = useStore.getState().runSlashCommand(TAB, "/cost this month");
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "cost",
      args: "this month",
      status: "running",
    });
    respond(TAB, sent[0]!.cmd, { agentInvoked: true });
    await promise;
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "agent",
    });
  });

  it("runSlashCommand settles failed with omp's own error text", async () => {
    seedCommands({ name: "usage" });
    const promise = useStore.getState().runSlashCommand(TAB, "/usage");
    respond(TAB, sent[0]!.cmd, "prompt rejected while streaming", false);
    await promise;
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "failed",
      error: 'RPC command "prompt" failed: prompt rejected while streaming',
    });
  });

  it("a bare ack without agentInvoked stays running until prompt_result settles it", async () => {
    seedCommands({ name: "usage" });
    const promise = useStore.getState().runSlashCommand(TAB, "/usage");
    const cmd = sent[0]!.cmd;
    respond(TAB, cmd, {});
    await promise;
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "running",
    });
    // A foreign prompt_result must not settle it.
    useStore
      .getState()
      .handleRpcFrame(TAB, { type: "prompt_result", id: "other" });
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      status: "running",
    });
    useStore.getState().handleRpcFrame(TAB, {
      type: "prompt_result",
      id: cmd.id,
      agentInvoked: false,
    });
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("a bare ack settles to agent on the tab's next agent_start", async () => {
    seedCommands({ name: "commit" });
    const promise = useStore.getState().runSlashCommand(TAB, "/commit");
    respond(TAB, sent[0]!.cmd, {});
    await promise;
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    const row = useStore
      .getState()
      .rpc[TAB]!.items.find((i) => i.kind === "command");
    expect(row).toMatchObject({ kind: "command", status: "agent" });
  });

  it("an unadvertised /word forwards as a literal prompt with no command row", async () => {
    const promise = useStore
      .getState()
      .runSlashCommand(TAB, "/nonexistent-xyz do it");
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/nonexistent-xyz do it",
    });
    expect(
      useStore.getState().rpc[TAB]!.items.some((i) => i.kind === "command"),
    ).toBe(false);
    await settleAll();
    await promise;
  });

  it("bare /mcp and /mcp list open the MCP manager instead of prompting omp", async () => {
    useStore.setState({
      mcpManager: null,
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    });
    await useStore.getState().runSlashCommand(TAB, "/mcp");
    expect(sent).toHaveLength(0);
    expect(useStore.getState().mcpManager).toEqual({
      projectCwd: "/p",
      tabId: TAB,
    });
    useStore.getState().closeMcpManager();
    await useStore.getState().runSlashCommand(TAB, "/mcp list");
    expect(sent).toHaveLength(0);
    expect(useStore.getState().mcpManager).toEqual({
      projectCwd: "/p",
      tabId: TAB,
    });
    useStore.getState().closeMcpManager();
  });

  it("other /mcp subcommands forward with the command lifecycle", async () => {
    useStore.setState({
      mcpManager: null,
      tabs: [tabInfo({ tabId: TAB, projectCwd: "/p" })],
    });
    seedCommands({ name: "mcp" });
    const promise = useStore.getState().runSlashCommand(TAB, "/mcp reauth linear");
    expect(useStore.getState().mcpManager).toBeNull();
    expect(sent[0]!.cmd).toMatchObject({
      type: "prompt",
      message: "/mcp reauth linear",
    });
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      name: "mcp",
      args: "reauth linear",
      status: "running",
    });
    respond(TAB, sent[0]!.cmd, { agentInvoked: false });
    await promise;
    expect(useStore.getState().rpc[TAB]!.items.at(-1)).toMatchObject({
      kind: "command",
      status: "done",
    });
  });

  it("busy is true while a command is in flight and survives a concurrent one", async () => {
    const first = useStore.getState().rpcCommand(TAB, { type: "get_state" });
    const second = useStore
      .getState()
      .rpcCommand(TAB, { type: "get_session_stats" });
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

  it("keeps busy ref-counted when one loud command times out beside another", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const timeout = useStore.getState().runSlashCommand(TAB, "/compact");
      await vi.advanceTimersByTimeAsync(5_000);
      const success = useStore.getState().setThinkingLevel(TAB, "high");
      const surviving = sent.at(-1)!.cmd;

      await vi.advanceTimersByTimeAsync(25_000);
      await timeout;
      expect(useStore.getState().rpc[TAB]!.failure).toMatchObject({
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
      expect(useStore.getState().rpc[TAB]!.pendingCommands.size).toBe(1);
      expect(useStore.getState().rpc[TAB]!.busy).toBe(true);
      expect(warn).toHaveBeenCalledOnce();

      respond(TAB, surviving, {});
      await success;
      expect(useStore.getState().rpc[TAB]!.busy).toBe(false);
      expect(useStore.getState().rpc[TAB]!.failure).toBeUndefined();
    } finally {
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("quiet commands never raise busy, so background sync can't strobe the sweeps", async () => {
    const promise = useStore
      .getState()
      .rpcCommand(TAB, { type: "get_subagents" }, { quiet: true });
    expect(useStore.getState().rpc[TAB]!.busy).toBe(false);
    respond(TAB, sent.pop()!.cmd, { subagents: [] });
    await promise;
    expect(useStore.getState().rpc[TAB]!.busy).toBe(false);
  });

  it("a loud command's busy survives an interleaved quiet one settling", async () => {
    const loud = useStore.getState().rpcCommand(TAB, { type: "compact" });
    const quiet = useStore
      .getState()
      .rpcCommand(TAB, { type: "get_state" }, { quiet: true });
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

  it("a failed command records a nonfatal command failure", async () => {
    const promise = useStore.getState().setThinkingLevel(TAB, "high");
    const cmd = sent.pop()!.cmd;
    respond(TAB, cmd, "unknown level", false);
    await expect(promise).resolves.toBeUndefined();
    const tab = useStore.getState().rpc[TAB]!;
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
    const failed = useStore.getState().setThinkingLevel(TAB, "high");
    respond(TAB, sent.pop()!.cmd, "unknown level", false);
    await failed;
    const transient = useStore.getState().rpc[TAB]!.failure;

    const refresh = useStore.getState().refreshState(TAB);
    respond(TAB, sent.pop()!.cmd, {});
    await refresh;
    expect(useStore.getState().rpc[TAB]!.failure).toBe(transient);

    const recovered = useStore.getState().setThinkingLevel(TAB, "low");
    respond(TAB, sent.pop()!.cmd, {});
    await recovered;
    expect(useStore.getState().rpc[TAB]!.failure).toBeUndefined();
  });

  it("setModel sends provider + modelId, not the whole model object", async () => {
    const model = {
      id: "claude-opus-5",
      name: "Opus 5",
      provider: "anthropic",
    };
    const promise = useStore.getState().setModel(TAB, model);
    expect(sent[0]!.cmd).toMatchObject({
      type: "set_model",
      provider: "anthropic",
      modelId: "claude-opus-5",
    });
    await settleAll(model);
    await promise;
    expect(useStore.getState().rpc[TAB]!.model).toMatchObject({
      id: "claude-opus-5",
    });
  });

  it("setModel remembers the model with the current thinking level", async () => {
    backendState = stateWithRecord(null);
    useStore.setState({
      state: backendState,
      rpc: {
        [TAB]: rpcTabState({
          session: { ...emptySessionRuntime(), thinkingLevel: "high" },
        }),
      },
    });
    const model = {
      id: "claude-opus-5",
      name: "Opus 5",
      provider: "anthropic",
    };
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
      rpc: {
        [TAB]: rpcTabState({ model: { id: "m1", name: "M1", provider: "p" } }),
      },
    });
    const promise = useStore.getState().setThinkingLevel(TAB, "max");
    await settleAll({});
    await promise;
    expect(mockBackend.setSessionModel).toHaveBeenCalledWith(
      TAB,
      "p/m1",
      "max",
    );
  });

  it("setAdvisorModel persists the advisor tuple through one backend call", async () => {
    await useStore.getState().setAdvisorModel(TAB, "openrouter/a/b:high");
    expect(mockBackend.setSessionAdvisor).toHaveBeenCalledWith(
      TAB,
      true,
      "openrouter/a/b:high",
      false,
    );
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
      advisorDefaults: {
        "/p": { enabled: true, model: "openrouter/a/b:high" },
      },
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

  it("newSession uses the app default advisor when the project has none (issue #174)", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "default-on-tab" });
    useStore.setState({
      state: { ...stateWithRecord(null), defaultAdvisor: true },
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: null,
      cols: 80,
      rows: 24,
    });
  });

  it("the app default of false overrides omp config for new sessions (issue #174)", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({
      tabId: "default-off-tab",
    });
    useStore.setState({
      state: stateWithRecord(null),
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
    });
  });

  it("exportHtml pushes the returned path as a notice", async () => {
    const promise = useStore.getState().exportHtml(TAB);
    await settleAll({ path: "/tmp/session.html" });
    await promise;
    expect(useStore.getState().rpc[TAB]!.items).toEqual([
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
    const promise = useStore.getState().exportHtml(TAB);
    await settleAll({});
    await promise;
    const [item] = useStore.getState().rpc[TAB]!.items;
    expect(item).toMatchObject({ kind: "notice", text: "export finished" });
    expect(item).not.toHaveProperty("path");
  });

  it("compactSession marks the transcript without pasting the summary into it", async () => {
    const promise = useStore.getState().compactSession(TAB);
    await settleAll({ summary: "x".repeat(5000) });
    await promise;
    const { items } = useStore.getState().rpc[TAB]!;
    expect(items.map((i) => i.kind)).toEqual(["marker", "marker"]);
    expect(JSON.stringify(items)).not.toContain("xxxx");
  });

  it("branchSession forks the transcript into a new tab and leaves the source untouched (issue #83)", async () => {
    const forked = {
      ...stateWithRecord("sess-fork").projects[0]!.sessions[0]!,
      tabId: "tab-fork",
    };
    backendState.projects[0]!.sessions.push(forked);
    mockBackend.forkSession.mockResolvedValueOnce({ tabId: "tab-fork" });
    useStore.setState({
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
    });

    await useStore.getState().branchSession(TAB);

    expect(mockBackend.forkSession).toHaveBeenCalledWith(TAB);
    // The fork opens through the normal resume path and takes focus.
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeTabId: "tab-fork",
        projectCwd: "/p",
        mode: "rpc-ui",
      }),
    );
    expect(useStore.getState().activeTabId).toBe("tab-fork");
    expect(useStore.getState().tabs.map((t) => t.tabId)).toEqual([
      TAB,
      "tab-fork",
    ]);
    // The source tab's transcript and runtime are exactly as they were.
    expect(useStore.getState().rpc[TAB]).toEqual(rpcTabState());
  });

  it("a failed branch alerts and changes nothing", async () => {
    mockBackend.forkSession.mockRejectedValueOnce(
      new Error("this session has no transcript to branch yet"),
    );
    useStore.setState({ activeTabId: TAB });

    await useStore.getState().branchSession(TAB);

    expect(alerts.at(-1)).toBe("this session has no transcript to branch yet");
    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(useStore.getState().activeTabId).toBe(TAB);
  });

  it("setTodos sends phases with tasks and re-reads the server's copy", async () => {
    const phases = [
      { phase: "Build", tasks: [{ content: "wire it", status: "pending" }] },
    ];
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
    expect(useStore.getState().rpc[TAB]!.subagents).toEqual([
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
    useStore.setState({ consoleOpen: {} });
    useStore.getState().toggleConsole(TAB);
    expect(useStore.getState().consoleOpen[TAB]).toBe(true);
    expect(useStore.getState().consoleOpen[`${TAB}-other`]).toBeUndefined();
    useStore.getState().toggleConsole(TAB);
    expect(useStore.getState().consoleOpen[TAB]).toBe(false);
  });
});

describe("project default models (issue #257)", () => {
  beforeEach(() => {
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
  });

  /** Review frame whose plan file read resolves — fresh spawns seed from it. */
  const openReviewWithPlan = (id: string) => {
    useStore.getState().handleRpcFrame(TAB, {
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
    const state = stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = "pin/advisor:high";
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "pin-tab" });
    useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: true,
      advisorModel: "pin/advisor:high",
      cols: 80,
      rows: 24,
    });
  });

  it("newSession falls back to the last-used advisor model when the pin is null", async () => {
    const state = stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = true;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = null;
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "last-tab" });
    useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: true, advisorModel: "last/advisor" }),
    );
  });

  it("newSession falls back to omp's configured advisor model when no app state exists", async () => {
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "cfg-tab" });
    useStore.setState({
      state: null,
      advisorDefaults: { "/p": { enabled: true, model: "openrouter/a/b:high" } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: true, advisorModel: "openrouter/a/b:high" }),
    );
  });

  it("keeps the pinned advisor model while the on/off chain resolves off", async () => {
    // Inert-while-off is intended: the pin is a model value, and advisor
    // on/off keeps its own chain (issue #174).
    const state = stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisor = false;
    project.defaultAdvisorModel = "p/pin";
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "dormant-tab" });
    useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });

    await useStore.getState().newSession("/p");

    expect(mockBackend.spawnSession).toHaveBeenCalledWith({
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: "p/pin",
      cols: 80,
      rows: 24,
    });
  });

  it("plan dispatch in a fresh session: the staged advisor tuple beats the pin", async () => {
    const state = stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.defaultAdvisorModel = "pin/advisor";
    useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });
    openReviewWithPlan("pd1");
    await flushMicrotasks();
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-staged" });
    useStore.getState().executePlan(TAB, "fresh", {
      advisor: true,
      advisorModel: "staged/advisor",
    });
    await flushMicrotasks();

    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: true, advisorModel: "staged/advisor" }),
    );
  });

  it("plan dispatch in a fresh session: the pin wins the fallback branch", async () => {
    const state = stateWithRecord(null);
    const project = state.projects[0]!.project;
    project.lastAdvisorModel = "last/advisor";
    project.defaultAdvisorModel = "pin/advisor";
    useStore.setState({
      state,
      advisorDefaults: { "/p": { enabled: true, model: null } },
    });
    openReviewWithPlan("pd2");
    await flushMicrotasks();
    expect(useStore.getState().rpc[TAB]!.planReview).not.toBeNull();
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh-pin" });
    useStore.getState().executePlan(TAB, "fresh");
    await flushMicrotasks();

    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ advisor: false, advisorModel: "pin/advisor" }),
    );
  });

  it("pin setters forward to the backend channel", async () => {
    await useStore.getState().setProjectDefaultModel("/p", "p/m");
    expect(mockBackend.setProjectDefaultModel).toHaveBeenCalledWith("/p", "p/m");
    await useStore.getState().setProjectDefaultAdvisorModel("/p", null);
    expect(mockBackend.setProjectDefaultAdvisorModel).toHaveBeenCalledWith("/p", null);
  });
});

describe("console-drawer shell routing (issue #42)", () => {
  // init() latches a module-level `initialized` flag, so it can run exactly
  // once per file — no other suite calls it. The captures below must happen
  // in the same test: beforeEach's vi.clearAllMocks() wipes mock.calls.
  it("routes shell:data to the registered writer and tracks shell exit", async () => {
    useStore.setState({ shellExited: {} });
    await useStore.getState().init();
    const dataCb = mockBackend.onShellData.mock.calls[0]?.[0] as (
      tabId: string,
      data: Uint8Array,
    ) => void;
    const exitCb = mockBackend.onShellExit.mock.calls[0]?.[0] as (
      tabId: string,
      code: number,
    ) => void;
    expect(dataCb).toBeDefined();
    expect(exitCb).toBeDefined();
    // Same latch, same test: onRemoteState is registered and the initial getRemoteState()
    // seeds the store, so the settings page has a token to show before any transition.
    const remoteCb = mockBackend.onRemoteState.mock.calls[0]?.[0] as (
      s: RemoteState,
    ) => void;
    expect(remoteCb).toBeDefined();
    expect(useStore.getState().remote).toEqual(idleRemoteState);
    remoteCb({ ...idleRemoteState, status: "listening", enabled: true });
    expect(useStore.getState().remote.status).toBe("listening");

    const writer = vi.fn();
    const unregister = registerShellWriter(TAB, writer);
    dataCb(TAB, new Uint8Array([65]));
    expect(writer).toHaveBeenCalledWith(new Uint8Array([65]));
    unregister();
    dataCb(TAB, new Uint8Array([66]));
    expect(writer).toHaveBeenCalledTimes(1); // unregistered: dropped

    exitCb(TAB, 7);
    expect(useStore.getState().shellExited[TAB]).toBe(7);
    useStore.getState().clearShellExited(TAB);
    expect(useStore.getState().shellExited[TAB]).toBeUndefined();
  });
});

describe("TUI handoff staging (issue #243)", () => {
  // init() is latched, so this is a no-op once the suite above has run; it
  // still registers the shell-exit listener when only these cases are run.
  beforeEach(async () => {
    await useStore.getState().init();
    useStore.setState({ consoleOpen: {}, shellExited: {}, tuiHandoff: {} });
  });

  it("stages a handoff, sends it on demand, and retires it when omp exits", () => {
    // A previous login shell's exit code must not paint its notice over the
    // omp TUI the drawer is about to spawn.
    useStore.setState({ shellExited: { [TAB]: 0 } });

    useStore.getState().startTuiHandoff(TAB, "/mcp reauth linear");
    expect(useStore.getState().consoleOpen[TAB]).toBe(true);
    expect(useStore.getState().shellExited[TAB]).toBeUndefined();
    expect(useStore.getState().tuiHandoff[TAB]).toEqual({
      line: "/mcp reauth linear",
      key: 1,
      phase: "running",
    });

    useStore.getState().sendTuiHandoff(TAB);
    expect(mockBackend.shellWrite).toHaveBeenCalledWith(
      TAB,
      "/mcp reauth linear\r",
    );

    shellExitCb!(TAB, 0);
    expect(useStore.getState().tuiHandoff[TAB]!.phase).toBe("exited");
    expect(useStore.getState().shellExited[TAB]).toBe(0);

    // Nothing is listening once omp is gone — the banner offers a restart.
    mockBackend.shellWrite.mockClear();
    useStore.getState().sendTuiHandoff(TAB);
    expect(mockBackend.shellWrite).not.toHaveBeenCalled();

    useStore.getState().dismissTuiHandoff(TAB);
    expect(useStore.getState().tuiHandoff[TAB]).toBeUndefined();
  });

  it("bumps the key so a second handoff respawns the drawer's omp", () => {
    useStore.getState().startTuiHandoff(TAB, "/mcp reauth linear");
    useStore.getState().startTuiHandoff(TAB, "/mcp reauth github");
    expect(useStore.getState().tuiHandoff[TAB]).toEqual({
      line: "/mcp reauth github",
      key: 2,
      phase: "running",
    });
  });

  it("tracks a plain shell's exit without minting a handoff", () => {
    shellExitCb!(TAB, 1);
    expect(useStore.getState().shellExited[TAB]).toBe(1);
    expect(useStore.getState().tuiHandoff).toEqual({});
  });

  it("drops the staged handoff with the deleted session", async () => {
    useStore.setState({
      state: stateWithRecord("sess-1", "dormant"),
      tuiHandoff: { [TAB]: { line: "/mcp reauth linear", key: 1, phase: "running" } },
    });
    await useStore.getState().deleteSession(TAB);
    await useStore.getState().confirmDeleteSession(false);
    expect(useStore.getState().tuiHandoff[TAB]).toBeUndefined();
  });

  it("drops the staged handoff when the agent is terminated", async () => {
    // killShell suppresses the drawer program's exit event, so no shell:exit
    // ever arrives to retire the handoff — terminate must do it itself.
    useStore.setState({
      tuiHandoff: {
        [TAB]: { line: "/mcp reauth linear", key: 1, phase: "running" },
      },
    });

    await useStore.getState().terminate(TAB);

    expect(mockBackend.terminateSession).toHaveBeenCalledWith(TAB);
    expect(useStore.getState().tuiHandoff[TAB]).toBeUndefined();
  });

  it("keeps the staged handoff when terminate is declined", async () => {
    windowStub.confirm = (msg: string): boolean => {
      prompts.push(msg);
      return false;
    };
    const staged = {
      line: "/mcp reauth linear",
      key: 1,
      phase: "running" as const,
    };
    useStore.setState({ tuiHandoff: { [TAB]: staged } });

    await useStore.getState().terminate(TAB);

    expect(mockBackend.terminateSession).not.toHaveBeenCalled();
    expect(useStore.getState().tuiHandoff[TAB]).toEqual(staged);
  });
});

describe("branch switching (issue #35)", () => {
  it("checkoutGitBranch success refreshes the shared listing and returns null", async () => {
    const fixture: BranchList = {
      repoRoot: "/p",
      current: "feature/x",
      branches: ["main", "feature/x"],
      defaultBranch: "main",
      upstreamRef: null,
      upstreamRemote: null,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: null,
      upstreamRefreshError: null,
    };
    mockBackend.checkoutBranch.mockResolvedValueOnce(undefined);
    mockBackend.listBranches.mockResolvedValueOnce(fixture);
    useStore.setState({ branches: {} });

    const err = await useStore.getState().checkoutGitBranch("/p", "feature/x");
    expect(err).toBeNull();
    expect(mockBackend.checkoutBranch).toHaveBeenCalledWith(
      "/p",
      "feature/x",
      undefined,
    );
    expect(useStore.getState().branches["/p"]).toEqual(fixture);
  });

  it("checkoutGitBranch rejection returns git's message and keeps the last listing", async () => {
    const existing: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: null,
      upstreamRemote: null,
      hasUpstream: false,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: null,
      upstreamRefreshError: null,
    };
    mockBackend.checkoutBranch.mockRejectedValueOnce(
      new Error("error: would be overwritten"),
    );
    useStore.setState({ branches: { "/p": existing } });

    const err = await useStore.getState().checkoutGitBranch("/p", "other");
    expect(err).toBe("error: would be overwritten");
    expect(useStore.getState().branches["/p"]).toEqual(existing);
  });

  it("refreshBranches keeps the previous snapshot until the deferred listing completes", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    const refreshed: BranchList = {
      ...previous,
      branches: ["main", "feature/x"],
      behind: 0,
      upstreamFetchedAt: 20,
    };
    const listing = deferred<BranchList>();
    mockBackend.listBranches.mockReturnValueOnce(listing.promise);
    useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: {},
    });

    const refresh = useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: false });
    await flushMicrotasks();

    expect(mockBackend.listBranches).toHaveBeenCalledWith("/p", {
      fetchUpstream: false,
    });
    expect(useStore.getState().branches["/p"]).toEqual(previous);
    expect(useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: true,
      pulling: false,
    });

    listing.resolve(refreshed);
    await refresh;

    expect(useStore.getState().branches["/p"]).toEqual(refreshed);
    expect(useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });

  it("queues one network refresh behind an in-flight local-only refresh", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    const localSnapshot = { ...previous, branches: ["main", "local"] };
    const networkSnapshot = {
      ...localSnapshot,
      behind: 0,
      upstreamFetchedAt: 20,
    };
    const localListing = deferred<BranchList>();
    mockBackend.listBranches
      .mockReturnValueOnce(localListing.promise)
      .mockResolvedValueOnce(networkSnapshot);
    useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: {},
    });

    const localRefresh = useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: false });
    const networkRefresh = useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: true });
    await flushMicrotasks();

    expect(mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(useStore.getState().branches["/p"]).toEqual(previous);

    localListing.resolve(localSnapshot);
    await Promise.all([localRefresh, networkRefresh]);

    expect(mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
      ["/p", { fetchUpstream: true }],
    ]);
    expect(useStore.getState().branches["/p"]).toEqual(networkSnapshot);
    expect(useStore.getState().branchActivity["/p"]?.refreshing).toBe(false);
  });

  it("coalesces duplicate in-flight network refreshes", async () => {
    const snapshot: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 0,
      upstreamFetchedAt: 20,
      upstreamRefreshError: null,
    };
    const listing = deferred<BranchList>();
    mockBackend.listBranches.mockReturnValueOnce(listing.promise);
    useStore.setState({
      branches: {},
      branchActivity: {},
      branchDiffRevision: {},
    });

    const first = useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: true });
    const duplicate = useStore
      .getState()
      .refreshBranches("/p", { fetchUpstream: true });
    await flushMicrotasks();

    expect(mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: true }],
    ]);

    listing.resolve(snapshot);
    await Promise.all([first, duplicate]);

    expect(mockBackend.listBranches).toHaveBeenCalledTimes(1);
    expect(useStore.getState().branches["/p"]).toEqual(snapshot);
    expect(useStore.getState().branchActivity["/p"]?.refreshing).toBe(false);
  });

  it("pullGitBranch failure preserves the snapshot and diff revision and clears activity", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    mockBackend.pullBranch.mockRejectedValueOnce(
      new Error("network unavailable"),
    );
    useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: { "/p": 4, "/other": 9 },
    });

    const pull = useStore.getState().pullGitBranch("/p");
    expect(useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: true,
    });

    await expect(pull).resolves.toBe("network unavailable");

    expect(mockBackend.pullBranch).toHaveBeenCalledWith("/p");
    expect(mockBackend.listBranches).not.toHaveBeenCalled();
    expect(useStore.getState().branches["/p"]).toEqual(previous);
    expect(useStore.getState().branchDiffRevision).toEqual({
      "/p": 4,
      "/other": 9,
    });
    expect(useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });

  it("pullGitBranch coalesces pulls, locally refreshes, and increments only its revision once", async () => {
    const previous: BranchList = {
      repoRoot: "/p",
      current: "main",
      branches: ["main"],
      defaultBranch: "main",
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 0,
      behind: 1,
      upstreamFetchedAt: 10,
      upstreamRefreshError: null,
    };
    const pulling = deferred<void>();
    mockBackend.pullBranch.mockReturnValueOnce(pulling.promise);
    mockBackend.listBranches.mockRejectedValueOnce(new Error("refresh failed"));
    useStore.setState({
      branches: { "/p": previous },
      branchActivity: {},
      branchDiffRevision: { "/p": 4, "/other": 9 },
    });

    const first = useStore.getState().pullGitBranch("/p");
    const duplicate = useStore.getState().pullGitBranch("/p");

    expect(mockBackend.pullBranch.mock.calls).toEqual([["/p"]]);
    await expect(duplicate).resolves.toBeNull();

    pulling.resolve(undefined);
    await expect(first).resolves.toBeNull();

    expect(mockBackend.pullBranch).toHaveBeenCalledTimes(1);
    expect(mockBackend.listBranches.mock.calls).toEqual([
      ["/p", { fetchUpstream: false }],
    ]);
    expect(useStore.getState().branches["/p"]).toEqual(previous);
    expect(useStore.getState().branchDiffRevision).toEqual({
      "/p": 5,
      "/other": 9,
    });
    expect(useStore.getState().branchActivity["/p"]).toEqual({
      refreshing: false,
      pulling: false,
    });
  });
});

describe("deleteSession", () => {
  it("opens a warning that deleting a live session stops its agent", async () => {
    useStore.setState({
      state: stateWithRecord("sess-1", "live"),
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      rpc: { [TAB]: rpcTabState() },
    });
    await useStore.getState().deleteSession(TAB);

    expect(mockBackend.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().deleteConfirmation).toEqual({
      tabId: TAB,
      title: "New session",
      running: true,
      hasFiles: true,
      worktreeBranch: null,
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
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
        tabInfo({
          tabId: "other",
          mode: "pty",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      exited: { [TAB]: 1 },
      rpc: { [TAB]: rpcTabState() },
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
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      rpc: { [TAB]: rpcTabState() },
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

describe("convertSessionToWorktree (issue #225)", () => {
  it("converts via the backend channel and rethrows failures", async () => {
    await useStore
      .getState()
      .convertSessionToWorktree(TAB, { branch: "omp-ui/abcd1234", baseRef: "main" });
    expect(mockBackend.convertToWorktree).toHaveBeenCalledWith(TAB, "omp-ui/abcd1234", "main");

    mockBackend.convertToWorktree.mockRejectedValueOnce(new Error("branch already exists"));
    await expect(
      useStore
        .getState()
        .convertSessionToWorktree(TAB, { branch: "omp-ui/abcd1234", baseRef: null }),
    ).rejects.toThrow("branch already exists");
  });
});

describe("focusedTabByProject tracks every tab-activation path (issue #99)", () => {
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
            lastAdvisorModel: null,
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

  it("newSession records the spawned tab as the project's focus", async () => {
    backendState = projectState([rec(TAB)]);
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: "fresh" });
    useStore.setState({
      state: backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
    });

    await useStore.getState().newSession("/p");

    const st = useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe("fresh");
    expect(st.activeTabId).toBe("fresh");
  });

  it("openSession on a dormant record resumes and records focus", async () => {
    backendState = projectState([rec(TAB, "dormant")]);
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: TAB });
    useStore.setState({ state: backendState });

    await useStore.getState().openSession(TAB);

    const st = useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(TAB);
    expect(st.activeTabId).toBe(TAB);
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        projectCwd: "/p",
        mode: "rpc-ui",
        advisor: false,
        resumeTabId: TAB,
      }),
    );
  });

  it("openSession on an existing tab unhides and records focus without reseeding", async () => {
    backendState = projectState([rec(TAB)]);
    useStore.setState({
      state: backendState,
      tabs: [
        tabInfo({ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
    });

    await useStore.getState().openSession(TAB);

    const st = useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(TAB);
    expect(st.activeTabId).toBe(TAB);
    expect(st.tabs.find((t) => t.tabId === TAB)?.hidden).toBe(false);
    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
  });

  it("focusTab records the focused tab's project", () => {
    useStore.setState({
      tabs: [
        tabInfo({ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
    });

    useStore.getState().focusTab(TAB);

    const st = useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(TAB);
    expect(st.activeTabId).toBe(TAB);
  });

  it("resumeDead behind a dormant record records focus", async () => {
    backendState = projectState([rec(TAB, "dormant")]);
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: TAB });
    useStore.setState({
      state: backendState,
      tabs: [
        tabInfo({ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
    });

    await useStore.getState().resumeDead(TAB);

    const st = useStore.getState();
    expect(st.focusedTabByProject["/p"]).toBe(TAB);
    expect(st.activeTabId).toBe(TAB);
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        resumeTabId: TAB,
        projectCwd: "/p",
        mode: "rpc-ui",
      }),
    );
  });

  it("resumeDead behind a hibernated tab wakes it and clears the flag", async () => {
    backendState = projectState([rec(TAB, "dormant")]);
    mockBackend.spawnSession.mockResolvedValueOnce({ tabId: TAB });
    useStore.setState({
      state: backendState,
      tabs: [
        tabInfo({ tabId: TAB, mode: "rpc-ui", projectCwd: "/p", hidden: true }),
      ],
      exited: { [TAB]: 0 },
      hibernated: { [TAB]: true },
    });

    await useStore.getState().resumeDead(TAB);

    const st = useStore.getState();
    expect(st.exited[TAB]).toBeUndefined();
    expect(st.hibernated[TAB]).toBeUndefined();
    expect(mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ resumeTabId: TAB, projectCwd: "/p", mode: "rpc-ui" }),
    );
  });
});

describe("hiding or deleting a project's remembered focus moves or drops it (issue #99)", () => {
  const rec = (tabId: string) => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui" as const,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title: "New session",
    status: null,
    live: "live" as const,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });
  const twoSessionState = (): BackendState =>
    makeBackendState({
      skipDeleteConfirmation: true,
      projects: [
        {
          project: {
            path: "/p",
            name: "p",
            addedAt: "t",
            lastModel: null,
            lastAdvisorModel: null,
          },
          sessions: [rec(TAB), rec("other")],
        },
      ],
    });

  it("hideTab moves the project's focus to its last non-hidden tab", () => {
    useStore.setState({
      state: twoSessionState(),
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
        tabInfo({
          tabId: "other",
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      focusedTabByProject: { "/p": TAB },
    });

    useStore.getState().hideTab(TAB);

    const st = useStore.getState();
    // Per-project focus moves to the surviving tab of the same project…
    expect(st.focusedTabByProject["/p"]).toBe("other");
    // …and the global fallback also lands on the last non-hidden tab overall.
    expect(st.activeTabId).toBe("other");
  });

  it("hideTab drops the project entry when the hidden tab was its only one", () => {
    useStore.setState({
      state: {
        ...twoSessionState(),
        projects: [{ ...twoSessionState().projects[0]!, sessions: [rec(TAB)] }],
      },
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      focusedTabByProject: { "/p": TAB },
    });

    useStore.getState().hideTab(TAB);

    expect(useStore.getState().focusedTabByProject).toEqual({});
  });

  it("deleting the focused tab moves focus to the surviving sibling", async () => {
    useStore.setState({
      state: twoSessionState(),
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
        tabInfo({
          tabId: "other",
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      focusedTabByProject: { "/p": TAB },
    });

    await useStore.getState().deleteSession(TAB);

    expect(mockBackend.deleteSession).toHaveBeenCalledWith(TAB);
    expect(useStore.getState().focusedTabByProject["/p"]).toBe("other");
  });

  it("deleting the last tab of a project drops its focus entry", async () => {
    useStore.setState({
      state: {
        ...twoSessionState(),
        projects: [{ ...twoSessionState().projects[0]!, sessions: [rec(TAB)] }],
      },
      tabs: [
        tabInfo({
          tabId: TAB,
          mode: "rpc-ui",
          projectCwd: "/p",
          hidden: false,
        }),
      ],
      activeTabId: TAB,
      focusedTabByProject: { "/p": TAB },
    });

    await useStore.getState().deleteSession(TAB);

    expect(useStore.getState().focusedTabByProject).toEqual({});
  });
});

describe("settings", () => {
  it("opens on general by default, honours an explicit page, and closes back to null", () => {
    useStore.getState().openSettings();
    expect(useStore.getState().settingsPage).toBe("general");

    useStore.getState().openSettings("memory");
    expect(useStore.getState().settingsPage).toBe("memory");

    useStore.getState().closeSettings();
    expect(useStore.getState().settingsPage).toBeNull();
  });

  it("caches the effective compaction threshold per project (issue #249)", async () => {
    mockBackend.readOmpSettings.mockResolvedValueOnce({
      ...emptyOmpSettings,
      entries: [
        { key: "compaction.thresholdPercent", type: "number", description: "", value: -1, options: null, layer: "default" },
        { key: "compaction.thresholdTokens", type: "number", description: "", value: -1, options: null, layer: "default" },
      ],
    });

    await useStore.getState().ensureCompactionSettings("/p");

    expect(mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    expect(mockBackend.readOmpSettings).toHaveBeenCalledWith("/p");
    expect(useStore.getState().compactionSettings["/p"]).toEqual({
      thresholdPercent: -1,
      thresholdTokens: -1,
    });

    // A second ensure is a cache hit — no second backend round trip.
    await useStore.getState().ensureCompactionSettings("/p");
    expect(mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent compaction settings reads for one project", async () => {
    let resolveRead!: (snapshot: OmpSettingsSnapshot) => void;
    mockBackend.readOmpSettings.mockImplementationOnce(
      () => new Promise<OmpSettingsSnapshot>((resolve) => { resolveRead = resolve; }),
    );
    const inFlight = Promise.all([
      useStore.getState().ensureCompactionSettings("/p"),
      useStore.getState().ensureCompactionSettings("/p"),
    ]);
    expect(mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    resolveRead(emptyOmpSettings);
    await inFlight;
    expect(mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
    expect(useStore.getState().compactionSettings["/p"]).toEqual({});
  });

  it("caches a failed compaction settings read as null, not a default", async () => {
    mockBackend.readOmpSettings.mockResolvedValueOnce({
      ...emptyOmpSettings,
      error: "omp binary not found",
    });

    await useStore.getState().ensureCompactionSettings("/p");

    expect(useStore.getState().compactionSettings["/p"]).toBeNull();
    // The failure is cached too: the next ensure must not hammer a missing
    // binary — the HUD only refetches after a compaction.* write or relaunch.
    await useStore.getState().ensureCompactionSettings("/p");
    expect(mockBackend.readOmpSettings).toHaveBeenCalledTimes(1);
  });

  it("clears the compaction cache on compaction.* writes only", async () => {
    await useStore.getState().ensureCompactionSettings("/p");
    expect("/p" in useStore.getState().compactionSettings).toBe(true);

    await useStore.getState().writeOmpSetting("advisor.enabled", true);
    expect("/p" in useStore.getState().compactionSettings).toBe(true);

    await useStore.getState().writeOmpSetting("compaction.thresholdPercent", 50);
    expect(useStore.getState().compactionSettings).toEqual({});
  });

  it("rejects writeOmpSetting to its caller instead of alerting", async () => {
    mockBackend.writeOmpSetting.mockRejectedValueOnce(
      new Error("unknown setting"),
    );

    // The omp settings page renders this inline, so the rejection must survive
    // the store rather than being swallowed into window.alert.
    await expect(
      useStore.getState().writeOmpSetting("advisor.enabled", true),
    ).rejects.toThrow("unknown setting");
    expect(alerts).toEqual([]);
  });
});

describe("remote access settings", () => {
  it("renders remote state only from the push, never an optimistic set", () => {
    // The pushed RemoteState IS the rendered one: main/remote-server.ts publishes a full state
    // per transition, so the store never patches a field itself.
    const push = (s: RemoteState): void => useStore.setState({ remote: s });
    push({ ...idleRemoteState, status: "starting", enabled: true });
    expect(useStore.getState().remote.status).toBe("starting");
    push({
      ...idleRemoteState,
      status: "listening",
      enabled: true,
      urls: ["http://127.0.0.1:4677/?t=t"],
    });
    expect(useStore.getState().remote.urls).toEqual([
      "http://127.0.0.1:4677/?t=t",
    ]);

    // An action's resolution changes nothing on its own — only the next push does.
    void useStore.getState().setRemoteEnabled(false);
    expect(useStore.getState().remote.enabled).toBe(true);
  });

  it("alerts a real remote-settings failure", async () => {
    mockBackend.setRemotePort.mockRejectedValueOnce(
      new Error("port must be a whole number between 1024 and 65535"),
    );
    await useStore.getState().setRemotePort(80);
    expect(alerts).toEqual([
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
      mockBackend[action].mockRejectedValueOnce(
        new Error("remote connection lost"),
      );
      await (useStore.getState()[action] as (a?: unknown) => Promise<void>)(
        arg,
      );
    }
    expect(alerts).toEqual([]);
  });
});

describe("subagent marker coalescing, buffers, and drill-down (issues #62, #63)", () => {
  const THROTTLE_TAB = `${TAB}-throttle`;

  beforeEach(() => {
    useStore.setState({
      rpc: { [TAB]: rpcTabState(), [THROTTLE_TAB]: rpcTabState() },
    });
  });

  const heartbeat = (tabId: string, id: string, agent: string) =>
    useStore.getState().handleRpcFrame(tabId, {
      type: "subagent_progress",
      payload: { id, agent, progress: { status: "running" } },
    });

  const markerLabels = (tabId: string) =>
    useStore
      .getState()
      .rpc[tabId]!.items.filter((i) => i.kind === "marker")
      .map((i) => i.label);

  it("interleaved running heartbeats from two agents stamp exactly one marker each", () => {
    heartbeat(TAB, "a", "scout");
    heartbeat(TAB, "b", "task");
    heartbeat(TAB, "a", "scout");
    heartbeat(TAB, "b", "task");
    heartbeat(TAB, "a", "scout");
    expect(markerLabels(TAB)).toEqual([
      "subagent scout: running",
      "subagent task: running",
    ]);
  });

  it("a status change for one agent appends exactly one more marker, for that agent only", () => {
    heartbeat(TAB, "a", "scout");
    heartbeat(TAB, "b", "task");
    useStore.getState().handleRpcFrame(TAB, {
      type: "subagent_lifecycle",
      payload: { id: "a", agent: "scout", status: "finished" },
    });
    heartbeat(TAB, "b", "task");
    expect(markerLabels(TAB)).toEqual([
      "subagent scout: running",
      "subagent task: running",
      "subagent scout: finished",
    ]);
  });

  it("heartbeat-driven roster refresh coalesces to one in-flight get_subagents, with a trailing call", async () => {
    vi.useFakeTimers();
    try {
      const rosterCalls = () =>
        sent.filter((s) => s.cmd.type === "get_subagents");
      heartbeat(THROTTLE_TAB, "a", "scout");
      expect(rosterCalls()).toHaveLength(1);
      // Frames landing mid-request only schedule the trailing call.
      heartbeat(THROTTLE_TAB, "a", "scout");
      heartbeat(THROTTLE_TAB, "b", "task");
      expect(rosterCalls()).toHaveLength(1);
      respond(THROTTLE_TAB, rosterCalls()[0]!.cmd, { subagents: [] });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(500);
      expect(rosterCalls()).toHaveLength(2);
      respond(THROTTLE_TAB, rosterCalls()[1]!.cmd, { subagents: [] });
      await flushMicrotasks();
      await vi.advanceTimersByTimeAsync(2000);
      expect(rosterCalls()).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("event frames append to the per-agent buffer with dedupe and a 500-item cap", () => {
    const text = (t: string) =>
      useStore.getState().handleRpcFrame(TAB, {
        type: "subagent_event",
        payload: { id: "a", text: t },
      });
    text("hello");
    text("hello");
    expect(useStore.getState().rpc[TAB]!.subagentItems?.a).toHaveLength(1);
    for (let i = 0; i < 505; i++) text(`note ${i}`);
    const buffer = useStore.getState().rpc[TAB]!.subagentItems!.a!;
    expect(buffer).toHaveLength(500);
    expect(buffer.at(-1)).toMatchObject({ text: "note 504" });
  });

  it("opening a detail escalates the subscription to events; closing drops back, without redundant sends", () => {
    const levels = () =>
      sent
        .filter((s) => s.cmd.type === "set_subagent_subscription")
        .map((s) => s.cmd.level);
    useStore.getState().openSubagent(TAB, "a");
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBe("a");
    useStore.getState().openSubagent(TAB, "a");
    expect(levels()).toEqual(["events"]);
    useStore.getState().closeSubagent(TAB);
    useStore.getState().closeSubagent(TAB);
    expect(levels()).toEqual(["events", "progress"]);
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBeNull();
  });

  it("a ready-frame re-boot sends progress, then re-escalates while a detail is open", async () => {
    // A dedicated tab id: an earlier suite leaves TAB's boot latch held, and
    // rpcBooting short-circuits a second bootRpcTab for the same tab.
    const REBOOT_TAB = `${TAB}-reboot`;
    backendState = stateWithRecord(null);
    useStore.setState({
      state: backendState,
      rpc: {
        [REBOOT_TAB]: rpcTabState({
          selectedSubagent: "a",
          subagentLevel: "events",
        }),
      },
    });
    const levels: unknown[] = [];
    const boot = useStore.getState().bootRpcTab(REBOOT_TAB);
    for (let wave = 0; wave < 6; wave++) {
      await flushMicrotasks();
      for (const { cmd } of sent.splice(0)) {
        if (cmd.type === "set_subagent_subscription") levels.push(cmd.level);
        respond(REBOOT_TAB, cmd, {});
      }
    }
    await boot;
    expect(levels).toEqual(["progress", "events"]);
    expect(useStore.getState().rpc[REBOOT_TAB]!.selectedSubagent).toBe("a");
  });

  it("openSubagent backfills the run's history from its transcript file", async () => {
    useStore.getState().openSubagent(TAB, "s1");
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBe("s1");
    await flushMicrotasks();
    const cmds = sent.splice(0);
    const levels = cmds.filter((c) => c.cmd.type === "set_subagent_subscription");
    expect(levels.map((c) => c.cmd.level)).toEqual(["events"]);
    const backfill = cmds.find((c) => c.cmd.type === "get_subagent_messages");
    expect(backfill?.cmd.subagentId).toBe("s1");
    respond(TAB, backfill!.cmd, {
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
    await flushMicrotasks();
    expect(useStore.getState().rpc[TAB]!.subagentItems?.["s1"]).toEqual([
      expect.objectContaining({ kind: "user", text: "map the store" }),
      expect.objectContaining({ kind: "assistant", text: "done" }),
    ]);
  });

  it("openSubagent keeps the live buffer and raises no panel when backfill fails", async () => {
    useStore.getState().handleRpcFrame(TAB, {
      type: "subagent_event",
      payload: { id: "s1", text: "live line" },
    });
    const before = useStore.getState().rpc[TAB]!.subagentItems?.["s1"];
    useStore.getState().openSubagent(TAB, "s1");
    await flushMicrotasks();
    const backfill = sent.splice(0).find((c) => c.cmd.type === "get_subagent_messages");
    respond(TAB, backfill!.cmd, "Unknown subagent or session file unavailable: s1", false);
    await flushMicrotasks();
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.subagentItems?.["s1"]).toEqual(before);
    expect(tab.failure).toBeUndefined();
  });

  it("drops a late backfill response when the selection moved on", async () => {
    useStore.getState().openSubagent(TAB, "s1");
    await flushMicrotasks();
    const stale = sent.splice(0).find((c) => c.cmd.type === "get_subagent_messages");
    useStore.getState().openSubagent(TAB, "s2");
    await flushMicrotasks();
    respond(TAB, stale!.cmd, {
      messages: [{ role: "user", content: [{ type: "text", text: "stale" }] }],
    });
    await flushMicrotasks();
    expect(useStore.getState().rpc[TAB]!.subagentItems?.["s1"]).toBeUndefined();
  });

  it("re-selecting the open agent is a no-op", async () => {
    useStore.getState().openSubagent(TAB, "s1");
    await flushMicrotasks();
    sent.splice(0);
    useStore.getState().openSubagent(TAB, "s1");
    await flushMicrotasks();
    expect(sent.splice(0)).toEqual([]);
  });

  it("live frames for the viewed agent grow past the retained-buffer cap; others stay capped", () => {
    useStore.getState().openSubagent(TAB, "s1");
    for (let i = 0; i < 510; i++) {
      useStore.getState().handleRpcFrame(TAB, {
        type: "subagent_event",
        payload: { id: "s1", text: `live ${i}` },
      });
      useStore.getState().handleRpcFrame(TAB, {
        type: "subagent_event",
        payload: { id: "s2", text: `bg ${i}` },
      });
    }
    const buffers = useStore.getState().rpc[TAB]!.subagentItems!;
    expect(buffers["s1"]).toHaveLength(510);
    expect(buffers["s2"]).toHaveLength(500);
  });
});

describe("initialization snapshot ordering", () => {
  it("registers listeners first, starts all reads together, and commits only after the slowest", async () => {
    const stateRead = deferred<BackendState>();
    const appRead = deferred<AppUpdateState>();
    const ompRead = deferred<OmpUpdateState>();
    const remoteRead = deferred<RemoteState>();
    const initialState = makeBackendState();
    const initialApp = { ...idleAppUpdate, currentVersion: "9.8.7" };
    const initialOmp = { ...idleOmpUpdate, installedVersion: "1.2.3" };
    const initialRemote = { ...idleRemoteState, enabled: true };
    mockBackend.getState.mockImplementationOnce(() => stateRead.promise);
    mockBackend.getAppUpdateState.mockImplementationOnce(() => appRead.promise);
    mockBackend.getOmpUpdateState.mockImplementationOnce(() => ompRead.promise);
    mockBackend.getRemoteState.mockImplementationOnce(() => remoteRead.promise);
    // init's StrictMode latch is module-scoped; an earlier routing test initializes
    // the shared store, so this contract test intentionally needs a fresh evaluation.
    vi.resetModules();
    const { useStore: freshStore } = await import("./store");

    const init = freshStore.getState().init();
    const duplicate = freshStore.getState().init();

    const listeners = [
      mockBackend.onStateChanged,
      mockBackend.onPtyData,
      mockBackend.onPtyExit,
      mockBackend.onSessionHibernated,
      mockBackend.onShellData,
      mockBackend.onShellExit,
      mockBackend.onRpcFrame,
      mockBackend.onAppUpdateState,
      mockBackend.onOmpUpdateState,
      mockBackend.onRemoteState,
    ];
    const reads = [
      mockBackend.getState,
      mockBackend.getAppUpdateState,
      mockBackend.getOmpUpdateState,
      mockBackend.getRemoteState,
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
    await flushMicrotasks();
    expect(freshStore.getState()).toMatchObject({
      state: null,
      appUpdate: idleAppUpdate,
      ompUpdate: idleOmpUpdate,
      remote: { ...idleRemoteState, token: "" },
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
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
  });

  afterEach(() => {
    window.requestAnimationFrame = syncRaf;
    window.cancelAnimationFrame = syncCancel;
    // Never leak a pending batch into the next test's state.
    runFrame();
  });

  it("coalesces a burst of transcript frames into one render commit", () => {
    const commits: number[] = [];
    const unsub = useStore.subscribe((state, prev) => {
      if (state.rpc[TAB]?.items !== prev.rpc[TAB]?.items)
        commits.push(state.rpc[TAB]!.items.length);
    });
    try {
      const store = useStore.getState();
      store.handleRpcFrame(TAB, {
        type: "message_start",
        message: { role: "user", content: [{ type: "text", text: "go" }] },
      });
      store.handleRpcFrame(TAB, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "a" },
      });
      store.handleRpcFrame(TAB, {
        type: "message_update",
        assistantMessageEvent: { type: "text_delta", delta: "b" },
      });
      // Nothing committed yet — the renderer stays free for input mid-burst.
      expect(useStore.getState().rpc[TAB]!.items).toEqual([]);
      expect(rafQueue).toHaveLength(1);
      runFrame();
      expect(commits).toEqual([2]);
      const items = useStore.getState().rpc[TAB]!.items;
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
    const store = useStore.getState();
    store.handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "q1" }] },
    });
    runFrame();
    store.handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "user", content: [{ type: "text", text: "q2" }] },
    });
    expect(
      useStore.getState().rpc[TAB]!.items.map((i) => i.kind),
    ).toEqual(["user"]);
    runFrame();
    const items = useStore.getState().rpc[TAB]!.items;
    expect(items.map((i) => (i.kind === "user" ? i.text : ""))).toEqual([
      "q1",
      "q2",
    ]);
  });

  it("keeps control frames immediate while a transcript commit is pending", async () => {
    const store = useStore.getState();
    store.handleRpcFrame(TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "x" },
    });
    expect(rafQueue).toHaveLength(1);
    // A dialog request must not wait for the flush — omp blocks on its reply.
    store.handleRpcFrame(TAB, {
      type: "extension_ui_request",
      id: "e1",
      method: "confirm",
      title: "sure?",
    });
    expect(useStore.getState().rpc[TAB]!.extensionQueue).toHaveLength(1);
    // A command response also resolves without waiting for the flush.
    const cmd = store.rpcCommand(TAB, { type: "get_state" });
    respond(TAB, sent.pop()!.cmd, {});
    await expect(cmd).resolves.toBeDefined();
    expect(useStore.getState().rpc[TAB]!.items).toEqual([]);
    runFrame();
    expect(useStore.getState().rpc[TAB]!.items).toHaveLength(1);
  });

  it("settles running tools from the pending batch on process death", () => {
    const store = useStore.getState();
    store.handleRpcFrame(TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
      args: { command: "make" },
    });
    // The card exists only in the pending batch.
    expect(useStore.getState().rpc[TAB]!.items).toEqual([]);
    store.handleRpcFrame(TAB, { type: "omp_ui_error", message: "process gone" });
    const items = useStore.getState().rpc[TAB]!.items;
    expect(items).toEqual([
      expect.objectContaining({
        kind: "tool",
        toolCallId: "t1",
        status: "aborted",
      }),
    ]);
    // The aborted commit landed immediately; the dead batch is gone.
    runFrame();
    expect(useStore.getState().rpc[TAB]!.items).toHaveLength(1);
  });

  it("drops a pending batch on relaunch so stale frames cannot land", async () => {
    useStore.setState({ state: stateWithRecord(null) });
    const store = useStore.getState();
    store.handleRpcFrame(TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "old" },
    });
    expect(rafQueue).toHaveLength(1);
    mockBackend.restartSession.mockResolvedValueOnce(undefined);
    await store.restartSession(TAB);
    expect(useStore.getState().rpc[TAB]!.items).toEqual([]);
    runFrame();
    expect(useStore.getState().rpc[TAB]!.items).toEqual([]);
  });

  it("feeds the advisor reply watcher from the pending batch, not the commit", async () => {
    vi.useFakeTimers();
    try {
      useStore.setState({ rpc: { [TAB]: rpcTabState({ status: "running" }) } });
      const store = useStore.getState();
      store.handleRpcFrame(TAB, { type: "agent_end" });
      runFrame(); // commits only the "agent finished" marker
      store.handleRpcFrame(TAB, advisorFrame("Do it now"));
      // The advisory lives only in the pending batch — never flushed here.
      expect(
        useStore.getState().rpc[TAB]!.items.some((i) => i.kind === "advisory"),
      ).toBe(false);
      await vi.advanceTimersByTimeAsync(ADVISOR_REPLY_SETTLE_MS);
      await flushMicrotasks();
      const replies = sent.filter((s) => s.cmd.type === "prompt");
      expect(replies).toHaveLength(1);
      expect(String(replies[0]!.cmd.message)).toContain("Do it now");
    } finally {
      vi.useRealTimers();
    }
  });
});


describe("plan-review gate reconciliation (issue #215)", () => {
  const PENDING: PendingPlan = {
    title: "add auth",
    planFilePath: "local://auth-plan.html",
    planAbsPath: "/l/auth-plan.html",
    frameId: "p1",
    proposedAt: "2026-08-17T00:00:00.000Z",
  };

  const gateState = (gate: {
    pendingPlan?: PendingPlan | null;
    planSettle?: PlanSettle | null;
  }): BackendState => {
    const base = stateWithRecord(null);
    return {
      ...base,
      projects: [
        {
          ...base.projects[0]!,
          sessions: [
            {
              ...base.projects[0]!.sessions[0]!,
              pendingPlan: gate.pendingPlan ?? null,
              planSettle: gate.planSettle ?? null,
            },
          ],
        },
      ],
    };
  };

  /**
   * A fresh store module (init latches per evaluation) with the real
   * onStateChanged handler captured — the entry point every broadcast
   * passes through, and where reconciliation runs.
   */
  const initFreshStore = async (): Promise<{
    store: typeof import("./store").useStore;
    onStateChanged: (state: BackendState) => void;
  }> => {
    vi.resetModules();
    const { useStore: fresh } = await import("./store");
    const init = fresh.getState().init();
    const onStateChanged = mockBackend.onStateChanged.mock.calls[0]![0] as (
      state: BackendState,
    ) => void;
    await init;
    return { store: fresh, onStateChanged };
  };

  const reviewedTab = (patch: Partial<ReturnType<typeof rpcTabState>> = {}) =>
    rpcTabState({
      planReview: {
        request: {
          title: "add auth",
          planFilePath: "local://auth-plan.html",
          planAbsPath: "/l/auth-plan.html",
        },
        frame: { id: "p1" },
      },
      plans: [{ key: "local://auth-plan.html", title: "add auth", status: "pending" }],
      ...patch,
    });

  it("hydrates a late-joining renderer from the record alone", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [TAB]: rpcTabState() } });

    onStateChanged(gateState({ pendingPlan: PENDING }));
    let tab = store.getState().rpc[TAB]!;
    expect(tab.planReview).toEqual({
      request: {
        title: "add auth",
        planFilePath: "local://auth-plan.html",
        planAbsPath: "/l/auth-plan.html",
      },
      frame: { id: "p1" },
    });
    expect(tab.planDeferred).toBe(false);
    expect(tab.plans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "pending" },
    ]);
    expect(mockBackend.readPlanFile).toHaveBeenCalledWith(TAB, "/l/auth-plan.html");
    await flushMicrotasks();
    tab = store.getState().rpc[TAB]!;
    expect(tab.planText).toBe("<h1>Plan</h1>");
    expect(tab.planHtml).toBe("<h1>Plan</h1>");
  });

  it("settles a verdict another client made, matching the proposal frame id", async () => {
    const { store, onStateChanged } = await initFreshStore();
    const planItem = planProposalItem("add auth", "local://auth-plan.html", "/l/auth-plan.html");
    store.setState({ rpc: { [TAB]: reviewedTab({ items: [planItem] }) } });

    onStateChanged(gateState({ planSettle: { frameId: "p1", verdict: "executed" } }));
    const tab = store.getState().rpc[TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.plans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "executed" },
    ]);
    expect(tab.items).toEqual([{ ...planItem, status: "executed" }]);
  });

  it("closes the pane when the settle is for a different gate", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({ rpc: { [TAB]: reviewedTab() } });

    onStateChanged(gateState({ planSettle: { frameId: "p2", verdict: "executed" } }));
    const tab = store.getState().rpc[TAB]!;
    expect(tab.planReview).toBeNull();
    expect(tab.planText).toBeNull();
    expect(tab.planDeferred).toBe(false);
    // The row stays a dimmed pending record — no verdict was observed for it.
    expect(tab.plans).toEqual([
      { key: "local://auth-plan.html", title: "add auth", status: "pending" },
    ]);
  });

  it("replaces a stale local review when the record proposes a different frame", async () => {
    const { store, onStateChanged } = await initFreshStore();
    store.setState({
      rpc: {
        [TAB]: reviewedTab({
          planReview: {
            request: {
              title: "add auth",
              planFilePath: "local://auth-plan.html",
              planAbsPath: "/l/auth-plan.html",
            },
            frame: { id: "old" },
          },
        }),
      },
    });

    onStateChanged(gateState({ pendingPlan: { ...PENDING, frameId: "new" } }));
    expect(store.getState().rpc[TAB]!.planReview?.frame).toEqual({ id: "new" });
  });

  it("marks the sidebar awaiting-answer from the record alone", () => {
    const record = {
      ...stateWithRecord(null).projects[0]!.sessions[0]!,
      pendingPlan: PENDING,
    };
    expect(deriveSidebarSessionState(record, undefined, undefined)).toBe(
      "awaiting-answer",
    );
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
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });
  });

  /** agent_start plus an open assistant response: the stall gate is armed. */
  const openAssistant = (): void => {
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    useStore.getState().handleRpcFrame(TAB, { type: "turn_start" });
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
  };

  afterEach(() => {
    // Terminate any armed interval before the fake clock is discarded; a
    // stale map entry would block re-arming in a later test.
    if (vi.isFakeTimers()) {
      useStore.setState({ rpc: {} });
      vi.advanceTimersByTime(1_000);
    }
    vi.useRealTimers();
  });

  it("pins the 30s threshold and 1Hz tick from the plan", () => {
    expect(STREAM_STALL_THRESHOLD_MS).toBe(30_000);
    expect(STREAM_STALL_TICK_MS).toBe(1_000);
  });

  it("arms at the threshold and ticks once per second", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    vi.advanceTimersByTime(2_000);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS + 2_000,
    );
  });

  it("clears within one tick when a model-stream frame resumes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    vi.advanceTimersByTime(1_000);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
  });

  it("classifies each block start/end event as its own checkpoint", () => {
    vi.useFakeTimers();
    for (const [i, type] of BLOCK_EVENTS.entries()) {
      // A distinct time per event: an unclassified event would leave the
      // previous checkpoint in place and fail both assertions.
      vi.setSystemTime(1_000_000 + i * 10_000);
      useStore.getState().handleRpcFrame(TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      expect(useStore.getState().rpc[TAB]!.streamCheckpoint).toMatchObject({
        at: 1_000_000 + i * 10_000,
        label: BLOCK_LABELS[i],
      });
    }
  });

  it("publishes whole-second (floor) values for off-boundary checkpoints", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    // The response opens 37ms after the interval armed, so every 1s tick
    // boundary sees an off-boundary silence (ceil would overstate it).
    vi.advanceTimersByTime(37);
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    // Until the first tick that reaches the threshold (silence 30,963ms).
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS + 963);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("block start/end frames reset the silence clock mid-stall", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    for (const type of BLOCK_EVENTS) {
      // Each classified block event restarts the silence clock...
      useStore.getState().handleRpcFrame(TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
      expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
        STREAM_STALL_THRESHOLD_MS,
      );
      // ...and the next frame clears the indicator within one tick.
      useStore.getState().handleRpcFrame(TAB, {
        type: "message_update",
        assistantMessageEvent: { type, contentIndex: 0 },
      });
      vi.advanceTimersByTime(1_000);
      expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
    }
  });

  it("keeps ticking while an auto-retry notice is on screen", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    // omp gives up and schedules a retry: the #100 notice lands...
    useStore.getState().handleRpcFrame(TAB, {
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
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.streamStallMs).toBe(STREAM_STALL_THRESHOLD_MS + 1_000);
    expect(tab.items.at(-1)).toMatchObject({ kind: "notice", level: "warn" });
  });

  it("never arms during local tool execution, then re-arms on the next response", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_end",
      message: { role: "assistant" },
    });
    useStore.getState().handleRpcFrame(TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    vi.advanceTimersByTime(60_000);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
    // The next assistant response in the same run re-arms the clock:
    // every frame while "running" defensively arms it.
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("agent_end clears the field and stops the clock", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    useStore.getState().handleRpcFrame(TAB, { type: "agent_end" });
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.status).toBe("ready");
    // The clock is stopped: no re-arm, no re-patch, ever.
    vi.advanceTimersByTime(120_000);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
  });

  it("relaunch resets the field and the checkpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    useStore.setState({ state: stateWithRecord(null) });
    openAssistant();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    expect(useStore.getState().rpc[TAB]!.streamCheckpoint).toBeDefined();
    // The explicit stop is observable without advancing the clock: the armed
    // interval is gone the moment the relaunch lands (self-termination would
    // only remove it on the next tick).
    const timersBefore = vi.getTimerCount();
    mockBackend.restartSession.mockResolvedValueOnce(undefined);
    await useStore.getState().restartSession(TAB);
    expect(vi.getTimerCount()).toBe(timersBefore - 1);
    const tab = useStore.getState().rpc[TAB]!;
    expect(tab.status).toBe("starting");
    expect(tab.streamStallMs).toBeUndefined();
    expect(tab.streamCheckpoint).toBeUndefined();
    // The clock is stopped: nothing can re-arm it while "starting".
    vi.advanceTimersByTime(120_000);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
  });

  it("does not claim a stall before it has seen a checkpoint (late joiner)", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    useStore.getState().handleRpcFrame(TAB, { type: "agent_start" });
    // A client that joined mid-response: the transcript shows an open
    // assistant, but this client has seen no model-stream frame — it cannot
    // time what it never saw.
    useStore.setState((s) => {
      const t = s.rpc[TAB]!;
      return {
        rpc: {
          ...s.rpc,
          [TAB]: {
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
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
    // The first frame this client sees sets the clock — and arms it.
    useStore.getState().handleRpcFrame(TAB, {
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", delta: "hi" },
    });
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
  });

  it("omp_ui_error clears the field and sets the error status", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    openAssistant();
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(useStore.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    useStore.getState().handleRpcFrame(TAB, {
      type: "omp_ui_error",
      message: "boom",
    });
    const tab = useStore.getState().rpc[TAB]!;
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
    fresh.setState({ rpc: { [TAB]: rpcTabState() } });
    fresh.getState().handleRpcFrame(TAB, { type: "agent_start" });
    fresh.getState().handleRpcFrame(TAB, { type: "turn_start" });
    fresh.getState().handleRpcFrame(TAB, {
      type: "message_start",
      message: { role: "assistant" },
    });
    const init = fresh.getState().init();
    // No tool cards were running — the pure-text-stall shape.
    const exitCb = mockBackend.onPtyExit.mock.calls[0]![0] as (
      tabId: string,
      code: number,
    ) => void;
    await init;
    vi.advanceTimersByTime(STREAM_STALL_THRESHOLD_MS);
    expect(fresh.getState().rpc[TAB]!.streamStallMs).toBe(
      STREAM_STALL_THRESHOLD_MS,
    );
    exitCb(TAB, 1);
    expect(fresh.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
    expect(fresh.getState().exited[TAB]).toBe(1);
    vi.advanceTimersByTime(120_000);
    expect(fresh.getState().rpc[TAB]!.streamStallMs).toBeUndefined();
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
    fresh.setState({ rpc: { [TAB]: rpcTabState({ status: "running" }) } });
    // A tool card mid-flight: the process is stopped with it still running.
    fresh.getState().handleRpcFrame(TAB, {
      type: "tool_execution_start",
      toolCallId: "t1",
      toolName: "bash",
    });
    expect(fresh.getState().rpc[TAB]!.items).toHaveLength(1);

    const init = fresh.getState().init();
    const hibernateCb =
      mockBackend.onSessionHibernated.mock.calls[0]![0] as (tabId: string) => void;
    await init;

    hibernateCb(TAB);

    // The dead gates see a plain exit (code 0); the framing is hibernated.
    expect(fresh.getState().exited[TAB]).toBe(0);
    expect(fresh.getState().hibernated[TAB]).toBe(true);
    const [item] = fresh.getState().rpc[TAB]!.items;
    expect(item).toMatchObject({ kind: "tool", toolCallId: "t1", status: "aborted" });
    vi.useRealTimers();
  });
});