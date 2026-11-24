// @vitest-environment jsdom
import { Profiler, act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ASYNC_JOBS_SNAPSHOT_VERSION, type AsyncJobsSnapshot } from "@omp-ui/core/async-jobs";
import type { BackendState, OmpUpdateState, RemoteInstanceSummary, SessionSummary } from "@omp-ui/core/types";
import { backendState, remoteInstance, rpcTabState } from "../test/fixtures";
import { setSettledOpen } from "../lib/sidebar-settled";
import { setSidebarSectionOpen } from "../lib/sidebar-section-open";
import { SIDEBAR_DEFAULT_WIDTH } from "../lib/panel-layout";
import { BOOK_POSTURE_QUERY, COMPACT_SHELL_QUERY, DOCKED_SIDEBAR_QUERY } from "../lib/responsive";
import type { LiveSnapshot } from "@omp-ui/core/live-voice";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.setPointerCapture = vi.fn();

function resizePointer(type: string, x: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  belowMinimum: false,
  progress: null,
  error: null,
};

// store.ts captures the preload bridge at module load, so install the mock
// before dynamically importing either the store or Sidebar.
const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  setDefaultMode: vi.fn(),
  setAutoSettleMergedPullRequests: vi.fn(async () => {}),
  setRemoteVsCodeEnabled: vi.fn(async () => {}),
  spawnSession: vi.fn(),
  settleSession: vi.fn(async () => true),
  switchMode: vi.fn(),
  deleteSession: vi.fn(async (tabId: string) => ({ deleted: [tabId], failed: [] })),
  deleteSessionPreview: vi.fn(async () => ({ descendants: [] })),
  forkSession: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  setSessionModel: vi.fn(),
  setSessionSnoozed: vi.fn(async () => {}),
  setSessionPinned: vi.fn(async () => {}),
  setSessionAutoSettleOnMerge: vi.fn(async () => {}),
  refreshPullRequests: vi.fn(async () => {}),
  readPlanFile: vi.fn(),
  getBranchDiff: vi.fn(),
  ptyPasteImage: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  rpcSend: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  toggleFavorite: vi.fn(),
  getOmpUpdateState: vi.fn(async () => idleOmpUpdate),
  checkOmpUpdate: vi.fn(),
  downloadOmpUpdate: vi.fn(),
  dismissOmpUpdate: vi.fn(),
  onOmpUpdateState: vi.fn(),
  getAppUpdateState: vi.fn(),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  openAppUpdateReleaseNotes: vi.fn(),
  showAppUpdateDownload: vi.fn(),
  restartForAppUpdate: vi.fn(),
  setAppUpdateInstallOnQuit: vi.fn(),
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
  // The GPU-process notice subscription (performance plan Phase 4).
  onGpuProcessCrashed: vi.fn(() => () => {}),
  refreshRemoteInstanceState: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { Sidebar } = await import("./Sidebar");
const { resetDispatchTetherState } = await import("./DispatchTether");
const { setDispatchHover } = await import("../lib/dispatch-hover");
const originalNewSession = useStore.getState().newSession;
const originalOpenSession = useStore.getState().openSession;
const openSession = vi.fn(async () => {});
const newSession = vi.fn(async () => null);

const projectPath = "/projects/one";
const state = backendState({
  projects: [
    {
      project: {
        path: projectPath,
        name: "Project One",
        addedAt: "2026-08-03T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
        browserClock: false,
        councilRoster: null,
        knowledgeHome: null,
        repositoryKey: null,
        icon: null,
      },
      sessions: [
        {
          tabId: "tab-1",
          sessionId: "session-1",
          lineageDir: "omp-ui--one--session-1",
          projectCwd: projectPath,
          launchedAt: "2026-08-03T00:00:00.000Z",
          mode: "rpc-ui",
          worktree: null,
          planImplementationSource: null, experiment: null, fleet: null,
          agentMode: "build",
          compactionMethod: null,
          approvalMode: null,
          serviceTier: null,
          model: null,
          thinkingLevel: null,
          advisor: false,
          advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 snoozed: false,
 snoozedUntilMs: null,
 reminderAtMs: null,
 pinnedAtMs: null,
 settledAtMs: null,
 heldPrompt: null,
 scheduledPrompt: null,
 routine: null,
 pullRequests: [],
 autoSettleOnMerge: null,
 private: false,
 chat: false,
 askSource: null,
          cachedTitle: "Owned session",
          cachedModified: "2026-08-03T00:00:00.000Z",
          title: "Owned session",
          status: "complete",
          live: "live",
          pendingPlan: null,
          planSettle: null,
              streamStalled: false,
        },
        {
          tabId: "tab-2",
          sessionId: "session-2",
          lineageDir: "omp-ui--one--session-2",
          projectCwd: projectPath,
          launchedAt: "2026-08-03T01:00:00.000Z",
          mode: "rpc-ui",
          worktree: null,
          planImplementationSource: null, experiment: null, fleet: null,
          agentMode: "build",
          compactionMethod: null,
          approvalMode: null,
          serviceTier: null,
          model: null,
          thinkingLevel: null,
          advisor: false,
          advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 snoozed: false,
 snoozedUntilMs: null,
 reminderAtMs: null,
 pinnedAtMs: null,
 settledAtMs: null,
 heldPrompt: null,
 scheduledPrompt: null,
 routine: null,
 pullRequests: [],
 autoSettleOnMerge: null,
 private: false,
 chat: false,
 askSource: null,
          cachedTitle: "Second owned session",
          cachedModified: "2026-08-03T01:00:00.000Z",
          title: "Second owned session",
          status: "complete",
          live: "live",
          pendingPlan: null,
          planSettle: null,
              streamStalled: false,
        },
      ],
    },
  ],
});

let root: Root | null = null;
const originalMatchMedia = window.matchMedia;
const originalVisualViewport = Object.getOwnPropertyDescriptor(window, "visualViewport");

function renderSidebar(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Sidebar />));
}

function button(label: string): HTMLButtonElement {
  const found = document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
  if (found === null) throw new Error(`button not found: ${label}`);
  return found;
}

function openContextMenu(trigger: HTMLElement): MouseEvent {
  const event = new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: 24,
    clientY: 32,
  });
  act(() => trigger.dispatchEvent(event));
  return event;
}

function openMenuItems(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

beforeEach(() => {
  newSession.mockClear();
  openSession.mockClear();
  useStore.setState({
    state,
    tabs: [],
    activeTabId: null,
    restoringTabs: false,
    exited: {},
    rpc: {},
    advisorDefaults: {},
    sidebarCollapsed: false,
    compactSurface: null,
    sidebarWidth: 272,
    inspectorWidth: 304,
    inspectorOpen: false,
    newSession,
    openSession,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  act(() => {
    setSettledOpen(false);
    setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true);
    setSidebarSectionOpen("omp-ui.sidebarSnoozedOpen", false);
  });
  window.localStorage.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  if (originalVisualViewport === undefined) {
    Reflect.deleteProperty(window, "visualViewport");
  } else {
    Object.defineProperty(window, "visualViewport", originalVisualViewport);
  }
  useStore.setState({
    state: null,
    tabs: [],
    activeTabId: null,
    restoringTabs: false,
    exited: {},
    rpc: {},
    advisorDefaults: {},
    newSession: originalNewSession,
    openSession: originalOpenSession,
  });
});

describe("Sidebar resizing", () => {
  it("previews, commits, resets, and preserves the expanded preference across collapse", () => {
    renderSidebar();
    const aside = document.body.querySelector<HTMLElement>("aside")!;
    const handle = document.body.querySelector<HTMLElement>('[role="separator"][aria-label="resize sidebar"]')!;
    expect(aside.style.width).toBe("272px");

    act(() => {
      handle.dispatchEvent(resizePointer("pointerdown", 100));
      handle.dispatchEvent(resizePointer("pointermove", 180));
    });
    expect(aside.style.width).toBe("352px");
    expect(useStore.getState().sidebarWidth).toBe(272);
    act(() => handle.dispatchEvent(resizePointer("pointerup", 180)));
    expect(useStore.getState().sidebarWidth).toBe(352);

    act(() => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useStore.getState().sidebarWidth).toBe(SIDEBAR_DEFAULT_WIDTH);
    act(() => useStore.getState().setSidebarWidth(400));
    act(() => useStore.getState().toggleSidebarCollapsed());
    expect(document.body.querySelector("aside")).toBeNull();
    expect(useStore.getState().sidebarWidth).toBe(400);
    act(() => useStore.getState().toggleSidebarCollapsed());
    expect(document.body.querySelector<HTMLElement>("aside")!.style.width).toBe("400px");
  });

  it("renders no separator in the compact project sheet", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({
      matches: query === COMPACT_SHELL_QUERY,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) });
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();
    expect(document.body.querySelector('[role="separator"]')).toBeNull();
  });
});

describe("Sidebar docked in the compact shell (issue #1015)", () => {
  const stubPosture = (book: boolean) => {
    const on = new Set([COMPACT_SHELL_QUERY, DOCKED_SIDEBAR_QUERY, ...(book ? [BOOK_POSTURE_QUERY] : [])]);
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn((query: string) => ({
      matches: on.has(query),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) });
    Object.defineProperty(window, "visualViewport", {
      configurable: true,
      value: Object.assign(new EventTarget(), { width: 739, height: 979 }),
    });
  };

  beforeEach(() => {
    useStore.setState({ compactSurface: null, sidebarCollapsed: false });
  });

  afterEach(() => {
    Reflect.deleteProperty(window, "viewport");
  });

  it("renders the aside beside the transcript with a resize separator", () => {
    stubPosture(false);
    renderSidebar();
    const aside = document.body.querySelector<HTMLElement>("aside")!;
    expect(aside).not.toBeNull();
    expect(aside.closest('[role="dialog"]')).toBeNull();
    expect(aside.style.width).toBe("272px");
    expect(document.body.querySelector('[role="separator"]')).not.toBeNull();
  });

  it("honours the sidebar collapse", () => {
    stubPosture(false);
    renderSidebar();
    act(() => useStore.getState().toggleSidebarCollapsed());
    expect(document.body.querySelector("aside")).toBeNull();
  });

  it("pins the width to the hinge in book posture with no separator", () => {
    stubPosture(true);
    Object.defineProperty(window, "viewport", {
      configurable: true,
      value: { segments: [{ left: 0 }, { left: 369 }] },
    });
    renderSidebar();
    expect(document.body.querySelector<HTMLElement>("aside")!.style.width).toBe("369px");
    expect(document.body.querySelector('[role="separator"]')).toBeNull();
  });
});

describe("Sidebar Ask about this session menu (issue #895)", () => {
  const originalAsk = useStore.getState().askAboutSession;
  const originalOmpUpdate = useStore.getState().ompUpdate;
  const askAboutSession = vi.fn(async () => {});
  const withFirst = (patch: Partial<SessionSummary>): typeof state => ({
    ...state,
    projects: [
      {
        ...state.projects[0]!,
        sessions: [
          { ...state.projects[0]!.sessions[0]!, settledAtMs: (patch.live ?? "live") === "live" ? null : 1_000, ...patch },
          state.projects[0]!.sessions[1]!,
        ],
      },
    ],
  });
  const row = (titlePrefix: string): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) =>
      b.title.startsWith(titlePrefix),
    );
    if (found === undefined) throw new Error(`row not found: ${titlePrefix}`);
    return found;
  };
  const itemLabels = (): string[] => openMenuItems().map((item) => item.textContent ?? "");

  beforeEach(() => {
    askAboutSession.mockClear();
    // Dormant rows sit under Settled.
    act(() => setSettledOpen(true));
    useStore.setState({
      askAboutSession,
      ompUpdate: { ...originalOmpUpdate, installedVersion: "99.0.0" },
    });
  });
  afterEach(() => {
    useStore.setState({ askAboutSession: originalAsk, ompUpdate: originalOmpUpdate });
  });

  it("offers Ask first on a dormant local row and asks about that session", () => {
    useStore.setState({ state: withFirst({ live: "dormant" }) });
    renderSidebar();
    openContextMenu(row("Owned session"));
    expect(itemLabels()).toEqual(["Ask about this session", "Migrate…", "Snooze›"]);
    act(() => openMenuItems()[0]!.click());
    expect(askAboutSession).toHaveBeenCalledWith("tab-1");
    expect(openMenuItems()).toEqual([]);
  });

  it("offers Settle, Ask, Pin, and Snooze but not Migrate on an idle live local row", () => {
    renderSidebar();
    openContextMenu(row("Owned session"));
    expect(itemLabels()).toEqual(["Settle", "Ask about this session", "Pin", "Snooze›"]);
  });

  it("opens no menu on a missing row with no saved transcript", () => {
    useStore.setState({ state: withFirst({ sessionId: null, live: "missing" }) });
    renderSidebar();
    const missingRow = [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) =>
      b.textContent?.includes("Owned session"),
    )!;
    const event = openContextMenu(missingRow);
    expect(event.defaultPrevented).toBe(false);
    expect(openMenuItems()).toEqual([]);
  });

  it("offers Ask and Snooze, never Migrate, on a dormant chat row", () => {
    const chat: SessionSummary = {
      ...state.projects[0]!.sessions[0]!,
      tabId: "chat-c1",
      chat: true,
      title: "Brainstorm names",
      cachedTitle: "Brainstorm names",
    };
    useStore.setState({ state: { ...state, chats: [{ ...chat, live: "dormant", settledAtMs: 1_000 }] } });
    renderSidebar();
    openContextMenu(row("Brainstorm names"));
    expect(itemLabels()).toEqual(["Ask about this session", "Snooze›"]);
    act(() => openMenuItems()[0]!.click());
    expect(askAboutSession).toHaveBeenCalledWith("chat-c1");
  });

  it("offers Settle, Ask, Migrate, Pin, and Snooze on an unsettled dormant row in the main list (issue #1137)", () => {
    useStore.setState({ state: withFirst({ live: "dormant", settledAtMs: null }) });
    renderSidebar();
    openContextMenu(row("Owned session"));
    expect(itemLabels()).toEqual(["Settle", "Ask about this session", "Migrate…", "Pin", "Snooze›"]);
  });
});

describe("Sidebar session list", () => {
  const SETTLED_KEY = "omp-ui.sidebarSettledOpen";
  /** tab-1 stays live; tab-2 is dormant, so it lands under Settled. */
  const mixedState = backendState({
    projects: [
      {
        ...state.projects[0]!,
        sessions: [state.projects[0]!.sessions[0]!, { ...state.projects[0]!.sessions[1]!, live: "dormant", settledAtMs: 1_000 }],
      },
    ],
    chats: [
      {
        ...state.projects[0]!.sessions[0]!,
        tabId: "chat-c1",
        chat: true,
        title: "Brainstorm names",
        cachedTitle: "Brainstorm names",
      },
    ],
  });
  const remotePath = "/projects/remote";
  const withRemote = (patch: Partial<RemoteInstanceSummary>) =>
    backendState({
      projects: state.projects,
      remoteInstances: [
        remoteInstance({
          id: "inst-a",
          nickname: "box-a",
          projects: [
            {
              project: { ...state.projects[0]!.project, path: remotePath, name: "Remote Project" },
              sessions: [
                {
                  ...state.projects[0]!.sessions[0]!,
                  tabId: "remote-tab-1",
                  projectCwd: remotePath,
                  title: "Remote session",
                  cachedTitle: "Remote session",
                  live: "dormant",
                  settledAtMs: 1_000,
                },
              ],
            },
          ],
          ...patch,
        }),
      ],
    });

  const rowButton = (title: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) => b.title === title);
  const settledToggle = (): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) =>
      b.textContent?.startsWith("Settled"),
    );
  const setFilter = (value: string): void => {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="filter sessions"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  afterEach(() => {
    useStore.setState({ projectQuickOpen: null, projectPickerOpen: false, settingsPage: null });
  });

  it("renders only live rows above Settled, each naming its project or chat", () => {
    useStore.setState({ state: mixedState });
    renderSidebar();
    expect(rowButton("Owned session")?.textContent).toContain("Project One");
    expect(rowButton("Brainstorm names")?.textContent).toContain("chat");
    expect(rowButton("Second owned session")).toBeUndefined();
  });

  it("shows the model on a main-list tile but not on a slim Settled row (issue #938)", () => {
    const sessions = mixedState.projects[0]!.sessions.map((s) => ({ ...s, model: "p/claude-x" }));
    useStore.setState({
      state: { ...mixedState, projects: [{ ...mixedState.projects[0]!, sessions }] },
    });
    act(() => setSettledOpen(true));
    renderSidebar();
    expect(rowButton("Owned session")?.textContent).toContain("claude-x");
    const settled = rowButton("Second owned session");
    expect(settled).toBeDefined();
    expect(settled!.textContent).not.toContain("claude-x");
  });

  it("collapses Settled by default with its count, and the toggle survives a fresh render", () => {
    useStore.setState({ state: mixedState });
    renderSidebar();
    const toggle = settledToggle()!;
    expect(toggle.textContent).toBe("Settled (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");

    act(() => toggle.click());
    expect(rowButton("Second owned session")).not.toBeUndefined();
    expect(window.localStorage.getItem(SETTLED_KEY)).toBe("1");

    act(() => root!.unmount());
    root = null;
    renderSidebar();
    expect(settledToggle()!.getAttribute("aria-expanded")).toBe("true");
    expect(rowButton("Second owned session")).not.toBeUndefined();
  });

  it("opens Settled for a query matching only a settled row without changing the stored choice", () => {
    useStore.setState({ state: mixedState });
    renderSidebar();
    setFilter("Second");
    expect(rowButton("Second owned session")).not.toBeUndefined();
    expect(rowButton("Owned session")).toBeUndefined();
    const toggle = settledToggle()!;
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(toggle.disabled).toBe(true);
    expect(window.localStorage.getItem(SETTLED_KEY)).toBeNull();

    setFilter("");
    expect(settledToggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(rowButton("Second owned session")).toBeUndefined();
  });

  it("reads one quiet line when nothing is live; the header opens the quick-open", () => {
    useStore.setState({
      state: backendState({
        projects: [
          {
            ...state.projects[0]!,
            sessions: state.projects[0]!.sessions.map((s) => ({ ...s, live: "dormant" as const, settledAtMs: 1_000 })),
          },
        ],
      }),
    });
    renderSidebar();
    // The empty block is one line (round-3 judge, Hierarchy 2): no duplicated
    // New session button competing with the header's.
    expect(document.body.textContent).toContain("No sessions running");
    expect(
      [...document.body.querySelectorAll<HTMLButtonElement>("button")].some((b) => b.textContent === "New session"),
    ).toBe(false);
    // Settled stays collapsed until the user opens it, even with nothing live.
    expect(settledToggle()!.getAttribute("aria-expanded")).toBe("false");
    expect(rowButton("Second owned session")).toBeUndefined();

    act(() => button("new session — pick a project").click());
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
  });

  it("dims an unreachable remote row and opens no menu on it", () => {
    useStore.setState({
      state: withRemote({ status: "unreachable", error: "connection lost" }),
      ompUpdate: { ...useStore.getState().ompUpdate, installedVersion: "99.0.0" },
    });
    act(() => setSettledOpen(true));
    renderSidebar();
    const remote = rowButton("Remote session")!;
    expect(remote.closest(".opacity-60")).not.toBeNull();
    expect(remote.textContent).toContain("· box-a");
    const event = openContextMenu(remote);
    expect(event.defaultPrevented).toBe(false);
    expect(openMenuItems()).toEqual([]);
  });

  it("renders no aside while the desktop sidebar is collapsed", () => {
    useStore.setState({ sidebarCollapsed: true });
    renderSidebar();
    expect(document.body.querySelector("aside")).toBeNull();
  });

  it("a private record's row carries the lock badge; an ordinary one does not (issue #852)", () => {
    const privateState = structuredClone(state);
    privateState.projects[0]!.sessions[0]!.private = true;
    useStore.setState({ state: privateState });
    renderSidebar();
    const badge = document.body.querySelector('[aria-label="private — this session writes no memories or lessons"]');
    expect(badge).not.toBeNull();
    expect(badge!.getAttribute("title")).toBe("private — this session writes no memories or lessons");
    act(() => root!.unmount());
    root = null;
    useStore.setState({ state });
    renderSidebar();
    expect(document.body.querySelector('[aria-label="private — this session writes no memories or lessons"]')).toBeNull();
  });
});

describe("Sidebar plan handoffs (issue #238)", () => {
  const handoffPath = "/projects/handoff";

  interface HandoffPatch {
    planImplementationSource?: {
      sourceTabId: string;
      planTitle: string;
      planFilePath: string;
    } | null;
  }

  /** Newest-first fixture rows, matching the backend broadcast order. */
  const handoffSession = (tabId: string, title: string, patch: HandoffPatch = {}) => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--handoff--sid-${tabId}`,
    projectCwd: handoffPath,
    launchedAt: "2026-08-03T00:00:00.000Z",
    mode: "rpc-ui" as const,
    worktree: null,
    planImplementationSource: null, experiment: null, fleet: null,
    agentMode: "build" as const,
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 snoozed: false,
 snoozedUntilMs: null,
 reminderAtMs: null,
 pinnedAtMs: null,
 settledAtMs: null,
 heldPrompt: null,
 scheduledPrompt: null,
 routine: null,
 pullRequests: [],
 autoSettleOnMerge: null,
 private: false,
 chat: false,
 askSource: null,
    cachedTitle: title,
    cachedModified: "2026-08-03T00:00:00.000Z",
    title,
    status: "complete" as const,
    live: "live" as const,
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  });

  const handoffProject = {
    path: handoffPath,
    name: "Handoff",
    addedAt: "2026-08-03T00:00:00.000Z",
    lastModel: null,
    lastThinkingLevel: null,
    lastAdvisor: null,
    lastAdvisorModel: null,
    defaultModel: null,
    defaultAdvisorModel: null,
    browserClock: false,
    councilRoster: null,
    knowledgeHome: null,
    repositoryKey: null,
    icon: null,
  };

  // The implementation names a planning session that still resolves; the
  // orphan's source tab is gone.
  const handoffState = backendState({
    projects: [
      {
        project: handoffProject,
        sessions: [
          handoffSession("tab-impl", "Implement dark mode", {
            planImplementationSource: {
              sourceTabId: "tab-plan",
              planTitle: "Ship dark mode",
              planFilePath: "local://plans/ship-dark-mode.md",
            },
          }),
          handoffSession("tab-plan", "Plan dark mode"),
          handoffSession("tab-orphan", "Orphan build", {
            planImplementationSource: {
              sourceTabId: "tab-gone",
              planTitle: "Lost plan",
              planFilePath: "local://plans/lost.md",
            },
          }),
          handoffSession("tab-plain", "Plain session"),
        ],
      },
    ],
  });

  function row(title: string): HTMLButtonElement {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes(title),
    );
    if (found === undefined) throw new Error(`session row not found: ${title}`);
    return found;
  }
  // The innermost match wins: the chips ride a wrapper span whose textContent
  // equals the single chip's label, and document order puts it first.
  const chip = (target: HTMLElement, text: string): HTMLElement | undefined =>
    [...target.querySelectorAll<HTMLElement>("span")].filter((el) => el.textContent === text).at(-1);

  it("labels implementation, plan source, and orphan rows without exposing the plan path", () => {
    useStore.setState({ state: handoffState });
    renderSidebar();

    const child = row("Implement dark mode");
    const implChip = chip(child, "impl");
    expect(implChip).toBeDefined();
    expect(implChip!.title).toBe("Implements “Ship dark mode” from Plan dark mode");
    expect(child.textContent).not.toContain("source unavailable");
    expect(child.title).toBe(
      "Implement dark mode — Implements “Ship dark mode” from Plan dark mode",
    );

    const source = row("Plan dark mode");
    expect(source.textContent).toContain("plan source");
    expect(chip(source, "impl")).toBeUndefined();

    const orphan = row("Orphan build");
    expect(chip(orphan, "impl")).toBeDefined();
    expect(orphan.textContent).toContain("source unavailable");
    expect(orphan.title).toBe("Orphan build — Implements “Lost plan” — source unavailable");

    const plain = row("Plain session");
    expect(chip(plain, "impl")).toBeUndefined();
    expect(plain.textContent).not.toContain("plan source");
    expect(plain.textContent).not.toContain("source unavailable");
    // The saved local:// artifact path is metadata, never UI.
    expect(document.body.innerHTML).not.toContain("local://");
  });

  it("opens the planning session from the child affordance while the row opens the child", () => {
    useStore.setState({ state: handoffState });
    renderSidebar();

    // Only the linked child gets the affordance — an orphan has nowhere to go.
    const planButtons = document.body.querySelectorAll<HTMLButtonElement>(
      'button[aria-label="open planning session"]',
    );
    expect(planButtons).toHaveLength(1);

    act(() => planButtons[0]!.click());
    expect(openSession).toHaveBeenCalledWith("tab-plan");

    openSession.mockClear();
    act(() => row("Implement dark mode").click());
    expect(openSession).toHaveBeenCalledWith("tab-impl");
  });
});

describe("Sidebar remote instances (issue #416)", () => {
  const remotePath = "/projects/remote";
  const remoteGroup = {
    project: { ...state.projects[0]!.project, path: remotePath, name: "Remote Project" },
    sessions: state.projects[0]!.sessions.map((s) => ({
      ...s,
      tabId: `remote-${s.tabId}`,
      projectCwd: remotePath,
      title: `Remote ${s.title}`,
    })),
  };

  /** The first remote row: the SessionRow button carrying its state dot and meta line. */
  function remoteRow(): HTMLButtonElement {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find(
      (b) => b.title === "Remote Owned session",
    );
    if (found === undefined) throw new Error("remote row not found");
    return found;
  }

  // Issue #434: this is the reported symptom stated as an assertion — the
  // client never mounted the tab, so no rpc[tabId] edge exists; only the
  // host's published turn level can mark the row working.
  it("marks a remote native row working from the host's turn level alone", () => {
    // The row lives in Working, collapsed by default since #1037: open it.
    act(() => setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true));
    const running = {
      ...remoteGroup,
      sessions: remoteGroup.sessions.map((s, i) =>
        i === 0 ? { ...s, turnRunning: true } : s,
      ),
    };
    useStore.setState({
      state: backendState({
        projects: state.projects,
        remoteInstances: [
          remoteInstance({ id: "inst-a", nickname: "box-a", projects: [running] }),
        ],
      }),
    });
    renderSidebar();
    const section = remoteRow();
    expect(section.textContent).toContain("working");
    // #1037: the state's hover text now rides the status band inside the row
    // container; the row button sits in its draggable inner block (#1226).
    expect(section.closest(".group\\/row")!.querySelector('[title="Agent is working"]')).not.toBeNull();
  });

  // Issue #436: same symptom for the answer latch — the client never mounted
  // the tab, so no local dialog component exists; only the host's published
  // awaiting level can mark the row answer-needed.
  it("marks a remote native row answer-needed from the host's awaiting level alone", () => {
    const awaiting = {
      ...remoteGroup,
      sessions: remoteGroup.sessions.map((s, i) =>
        i === 0 ? { ...s, awaitingHumanAnswer: true } : s,
      ),
    };
    useStore.setState({
      state: backendState({
        projects: state.projects,
        remoteInstances: [
          remoteInstance({ id: "inst-a", nickname: "box-a", projects: [awaiting] }),
        ],
      }),
    });
    renderSidebar();
    const section = remoteRow();
    expect(section.textContent).toContain("answer needed");
    // #1037: same band move as the working-row case above.
    expect(section.closest(".group\\/row")!.querySelector('[title="Agent is waiting for your answer"]')).not.toBeNull();
  });
});

// issue #807: live voice output plays from every running session, so the
// row carries a speaker glyph while its snapshot runs. #811 extends the
// glyph to the closed-call states: armed (dim, resumes on view) and
// pending results waiting (signal accent).
describe("Sidebar live voice speaker glyph (issue #807, #811)", () => {
  const live = (patch: Partial<LiveSnapshot>): LiveSnapshot => ({
    phase: "listening",
    levels: null,
    turns: [],
    ended: false,
    error: null,
    connectionId: null,
    ...patch,
  });

  const glyph = (): Element | null => document.body.querySelector('[role="img"]');

  it("the row of a live-voice session carries the speaker glyph", () => {
    useStore.setState({ rpc: { "tab-1": rpcTabState({ live: live({ phase: "speaking" }) }) } });
    renderSidebar();
    const mark = glyph();
    expect(mark).not.toBeNull();
    expect(mark?.getAttribute("aria-label")).toBe("Live voice: speaking");
  });

  it("an ended live session shows no glyph", () => {
    useStore.setState({
      rpc: { "tab-1": rpcTabState({ live: live({ phase: "speaking", ended: true }) }) },
    });
    renderSidebar();
    expect(glyph()).toBeNull();
  });

  it("a PTY row never carries the glyph", () => {
    useStore.setState({
      state: {
        ...state,
        projects: [
          {
            ...state.projects[0]!,
            sessions: state.projects[0]!.sessions.map((s) =>
              s.tabId === "tab-1" ? { ...s, mode: "pty" as const } : s,
            ),
          },
          ...state.projects.slice(1),
        ],
      },
      // Forced rpc entry: the row must gate on mode, not on rpc presence.
      rpc: { "tab-1": rpcTabState({ live: live({ phase: "speaking" }) }) },
    });
    renderSidebar();
    expect(glyph()).toBeNull();
  });

  // #811: while the call is closed the badge mirror decides the glyph.
  it("an armed parked row shows the dim ready glyph", () => {
    useStore.setState({
      rpc: { "tab-1": rpcTabState({ live: live({ phase: "listening", ended: true }) }) },
      liveVoice: { "tab-1": { armed: true, parked: true, pending: false, talking: false } },
    });
    renderSidebar();
    const mark = glyph();
    expect(mark?.getAttribute("aria-label")).toBe("live voice: ready — resume by viewing");
    expect(mark?.getAttribute("class")).toContain("text-ink-faint");
  });

  it("a parked row with results waiting shows the accent glyph", () => {
    useStore.setState({
      rpc: { "tab-1": rpcTabState({ live: live({ phase: "listening", ended: true }) }) },
      liveVoice: { "tab-1": { armed: true, parked: true, pending: true, talking: false } },
    });
    renderSidebar();
    const mark = glyph();
    expect(mark?.getAttribute("aria-label")).toBe("live voice: results waiting");
    expect(mark?.getAttribute("class")).toContain("text-signal");
  });

  it("an open call's phase glyph outranks the badge", () => {
    useStore.setState({
      rpc: { "tab-1": rpcTabState({ live: live({ phase: "speaking" }) }) },
      liveVoice: { "tab-1": { armed: true, parked: false, pending: true, talking: false } },
    });
    renderSidebar();
    expect(glyph()?.getAttribute("aria-label")).toBe("Live voice: speaking");
  });
});

// issue #838: omp composes title cards (`${icon} ${code}: ${title}`) into the
// title string itself; the row splits the shape at render time and keeps the
// raw string as the row's tooltip.
describe("Sidebar title cards (issue #838)", () => {
  const rowButton = (title: string): HTMLButtonElement => {
    const found = [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find(
      (candidate) => candidate.title === title,
    );
    if (found === undefined) throw new Error(`row not found: ${title}`);
    return found;
  };

  const titleLine = (button: HTMLButtonElement): HTMLElement =>
    button.querySelector<HTMLElement>("[data-session-tile-title]")!;

  it("a card title renders the icon, the code chip, and the bare title", () => {
    useStore.setState({
      state: {
        ...state,
        projects: [
          {
            ...state.projects[0]!,
            sessions: state.projects[0]!.sessions.map((s) =>
              s.tabId === "tab-1" ? { ...s, cachedTitle: "📝 PLAN: Ship dark mode", title: "📝 PLAN: Ship dark mode" } : s,
            ),
          },
          ...state.projects.slice(1),
        ],
      },
    });
    renderSidebar();
    const button = rowButton("📝 PLAN: Ship dark mode");
    // The emoji stays out of the visible line (issue #1042 — colour emoji
    // clash with the stroke icon set); the tooltip keeps the raw card.
    expect(button.getAttribute("title")).toBe("📝 PLAN: Ship dark mode");
    const line = titleLine(button);
    expect(line.textContent).not.toContain("📝");
    const chip = [...line.querySelectorAll("span")].find((el) => el.textContent === "PLAN");
    expect(chip?.className).toContain("font-mono");
    expect(line.lastElementChild?.textContent).toBe("Ship dark mode");
  });

  it("a plain title renders exactly as before — bare text, no chip", () => {
    renderSidebar();
    const line = titleLine(rowButton("Owned session"));
    expect(line.firstChild).toBeInstanceOf(Text);
    expect(line.querySelector("span")).toBeNull();
  });
});

describe("Sidebar Working and Snoozed sections (issue #935)", () => {
  const project = state.projects[0]!.project;
  const baseSession = state.projects[0]!.sessions[0]!;
  const sess = (tabId: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
    ...baseSession,
    tabId,
    title: tabId,
    cachedTitle: tabId,
    settledAtMs: (patch.live ?? "live") === "live" ? null : 1_000,
    ...patch,
  });
  const stateWith = (sessions: SessionSummary[], patch: Partial<BackendState> = {}): BackendState =>
    backendState({ ...patch, projects: [{ project, sessions }] });
  // Snapshot/job literals mirror lib/async-jobs.test.ts.
  const runningSnapshot: AsyncJobsSnapshot = {
    version: ASYNC_JOBS_SNAPSHOT_VERSION,
    processKey: "p",
    revision: 1,
    available: true,
    unavailable: null,
    canInspect: true,
    canCancel: true,
    canCancelNested: false,
    running: [
      {
        id: "bg_1",
        type: "bash",
        status: "running",
        label: "l",
        command: null,
        cwd: null,
        startTime: 0,
        endTime: null,
        agentId: null,
        ownerId: null,
        pids: [],
        exitCode: null,
        outputTail: "",
        outputTruncated: false,
        widget: null,
        completionPercent: null,
        stage: null,
        intent: null,
        caption: null,
        outputFile: null,
      },
    ],
    recent: [],
    rootId: null,
    agents: [],
    result: null,
  };

  const SNOOZED_KEY = "omp-ui.sidebarSnoozedOpen";
  const rowButton = (title: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) => b.title === title);
  const sectionToggle = (prefix: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find((b) =>
      b.textContent?.startsWith(prefix),
    );
  const setFilter = (value: string): void => {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="filter sessions"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };
  const menuItemLabels = (): string[] => openMenuItems().map((b) => b.textContent ?? "");
  const filterCount = (): string | null => {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="filter sessions"]');
    return input?.parentElement?.querySelector(".tabular-nums")?.textContent ?? null;
  };

  beforeEach(() => {
    backendMock.setSessionSnoozed.mockClear();
  });

  it("renders Working (n), opens on demand, and moves an in-turn live row into it", () => {
    // #1037: Working starts collapsed now — a test that wants its rows
    // visible must open the section itself.
    act(() => setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true));
    useStore.setState({ state: stateWith([sess("busy", { turnRunning: true })]) });
    renderSidebar();
    const toggle = sectionToggle("Working")!;
    expect(toggle.textContent).toBe("Working (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rowButton("busy")).toBeDefined();
    // The main list is empty: a live row exists, so no empty line.
    expect(document.body.textContent).not.toContain("No sessions running");
  });

  it("keeps Working (0) visible and docked directly above Settled, below Snoozed", () => {
    useStore.setState({
      state: stateWith([sess("parked", { snoozed: true }), sess("old", { live: "dormant" })]),
    });
    renderSidebar();
    const headings = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].map(
      (b) => b.textContent,
    );
    expect(headings).toEqual(["Snoozed (1)", "Working (0)", "Settled (1)"]);
  });

  it("Snooze submenu is always available without a setting, parks a row, and a snoozed row offers Unsnooze + Snooze again (#1323)", () => {
    useStore.setState({
      state: stateWith([
        sess("parked"),
        sess("done", { snoozed: true }),
        sess("gone", { live: "missing" }),
      ]),
    });
    renderSidebar();
    openContextMenu(rowButton("parked")!);
    const trigger = openMenuItems().find((b) => b.textContent?.startsWith("Snooze"));
    expect(trigger).toBeDefined();
    act(() => trigger!.click());
    const indef = openMenuItems().find((b) => b.textContent === "Indefinitely");
    expect(indef).toBeDefined();
    act(() => indef!.click());
    expect(backendMock.setSessionSnoozed).toHaveBeenCalledWith("parked", true);

    expect(sectionToggle("Snoozed")!.textContent).toBe("Snoozed (1)");
    act(() => sectionToggle("Snoozed")!.click());
    openContextMenu(rowButton("done")!);
    expect(menuItemLabels()).toContain("Unsnooze");
    expect(menuItemLabels().some((l) => l.startsWith("Snooze again"))).toBe(true);
    act(() => {
      openMenuItems().find((b) => b.textContent === "Unsnooze")!.click();
    });
    expect(backendMock.setSessionSnoozed).toHaveBeenCalledWith("done", false);

    // Missing rows do not offer new Snooze (missing rows show their missing title attribute).
    act(() => sectionToggle("Settled")!.click());
    const missingRow = [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) =>
      b.textContent?.includes("gone"),
    )!;
    openContextMenu(missingRow);
    expect(menuItemLabels().some((l) => l.startsWith("Snooze"))).toBe(false);
  });

  it("timed snooze submenu sends preset deadlines and opens upgraded SnoozeUntilDialog (#979, #1323)", () => {
    useStore.setState({
      state: stateWith([sess("parked"), sess("done", { snoozed: true, snoozedUntilMs: Date.now() + 3_600_000 })]),
    });
    renderSidebar();
    const before = Date.now();
    openContextMenu(rowButton("parked")!);
    act(() => {
      openMenuItems().find((b) => b.textContent?.startsWith("Snooze"))!.click();
    });
    const labels = menuItemLabels();
    expect(labels.some((l) => l.startsWith("In 1 hour"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Tomorrow morning"))).toBe(true);
    expect(labels.some((l) => l.startsWith("In 2 days"))).toBe(true);
    expect(labels.some((l) => l.startsWith("Next week"))).toBe(true);
    expect(labels).toContain("Indefinitely");
    expect(labels).toContain("Custom…");
    act(() => {
      openMenuItems().find((b) => b.textContent?.startsWith("In 1 hour"))!.click();
    });
    const [tabId, snoozed, untilMs] = backendMock.setSessionSnoozed.mock.calls.at(-1) as unknown as [string, boolean, number];
    expect([tabId, snoozed]).toEqual(["parked", true]);
    expect(untilMs - before).toBeGreaterThanOrEqual(3_600_000);
    expect(untilMs - before).toBeLessThan(3_600_000 + 5_000);

    // Custom… opens the upgraded dialog with day chips and synced inputs.
    openContextMenu(rowButton("parked")!);
    act(() => {
      openMenuItems().find((b) => b.textContent?.startsWith("Snooze"))!.click();
    });
    act(() => {
      openMenuItems().find((b) => b.textContent === "Custom…")!.click();
    });
    const daysInput = document.body.querySelector<HTMLInputElement>('input[aria-label="Days from now"]')!;
    expect(daysInput.value).toBe("2");
    const chip5d = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "5d")!;
    act(() => chip5d.click());
    expect(daysInput.value).toBe("5");
    const snoozeConfirm = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((b) => b.textContent === "Snooze")!;
    act(() => snoozeConfirm.click());
    const customCall = backendMock.setSessionSnoozed.mock.calls.at(-1) as unknown as [string, boolean, number];
    expect(customCall[0]).toBe("parked");
    expect(customCall[1]).toBe(true);
    expect(customCall[2]).toBeGreaterThan(Date.now() + 4 * 86_400_000);

    act(() => sectionToggle("Snoozed")!.click());
    expect(document.body.textContent).toMatch(/snoozed until \w+ \d\d:\d\d/);
  });

  it("persists the Snoozed collapse choice to its own localStorage key", () => {
    useStore.setState({
      state: stateWith([sess("done", { snoozed: true })]),
    });
    renderSidebar();
    const toggle = sectionToggle("Snoozed")!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem(SNOOZED_KEY)).toBe("1");
    act(() => toggle.click());
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(window.localStorage.getItem(SNOOZED_KEY)).toBe("0");
  });

  it("expands every section while filtering and sums all four lists in the count badge", () => {
    // #1037: Working is collapsed by default; open it first so the collapse
    // click below flips a known state. Snoozed is collapsed by default too.
    act(() => setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true));
    useStore.setState({
      state: stateWith([
        sess("idle"),
        sess("busy", { turnRunning: true }),
        sess("parked", { snoozed: true }),
        sess("old", { live: "dormant" }),
      ]),
    });
    renderSidebar();
    act(() => sectionToggle("Working")!.click());
    expect(sectionToggle("Working")!.getAttribute("aria-expanded")).toBe("false");
    expect(sectionToggle("Snoozed")!.getAttribute("aria-expanded")).toBe("false");

    setFilter("project");

    for (const prefix of ["Working", "Snoozed", "Settled"]) {
      const toggle = sectionToggle(prefix)!;
      expect(toggle.getAttribute("aria-expanded")).toBe("true");
      expect(toggle.disabled).toBe(true);
    }
    expect(rowButton("idle")).toBeDefined();
    expect(rowButton("busy")).toBeDefined();
    expect(rowButton("parked")).toBeDefined();
    expect(rowButton("old")).toBeDefined();
    expect(filterCount()).toBe("4");
  });

  it("shows the no-live empty state when no row is live", () => {
    useStore.setState({ state: stateWith([sess("old", { live: "dormant" })]) });
    renderSidebar();
    expect(document.body.textContent).toContain("No sessions running");
  });

  it("shows the no-matches empty state when a filter matches nothing", () => {
    useStore.setState({ state: stateWith([sess("idle")]) });
    renderSidebar();
    setFilter("zzzz-nothing");
    expect(document.body.textContent).toContain("Nothing matches");
  });

  it("Pin sends the pin, a pinned in-turn row heads the list under Pinned (n) with a glyph, and offers Unpin (issue #981)", () => {
    backendMock.setSessionPinned.mockClear();
    useStore.setState({ state: stateWith([sess("loose"), sess("watched", { turnRunning: true, pinnedAtMs: 1_000 })]) });
    renderSidebar();
    openContextMenu(rowButton("loose")!);
    act(() => {
      openMenuItems().find((b) => b.textContent === "Pin")!.click();
    });
    expect(backendMock.setSessionPinned).toHaveBeenCalledWith("loose", true);

    const group = document.body.querySelector<HTMLElement>('[role="group"][aria-label="Pinned (1)"]')!;
    expect(group.contains(rowButton("watched")!)).toBe(true);
    expect(group.querySelector('[role="img"][aria-label="Pinned"]')).not.toBeNull();
    expect(sectionToggle("Working")!.textContent).toBe("Working (0)");
    openContextMenu(rowButton("watched")!);
    act(() => {
      openMenuItems().find((b) => b.textContent === "Unpin")!.click();
    });
    expect(backendMock.setSessionPinned).toHaveBeenCalledWith("watched", false);
  });

  // issue #1026: a local rpc-ui row whose async-jobs bridge snapshot reports a
  // running background job belongs in Working even while its turn is idle,
  // matching the row chip.
  it("moves a live row with a running background job into Working (issue #1026)", () => {

    // #1037: Working starts collapsed; open it to see the row land inside.
    act(() => setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true));
    useStore.setState({
      state: stateWith([sess("bgwork", { turnRunning: false })]),
      rpc: { bgwork: rpcTabState({ asyncJobs: runningSnapshot }) },
    });
    renderSidebar();
    expect(sectionToggle("Working")!.textContent).toBe("Working (1)");
    expect(rowButton("bgwork")).toBeDefined();
    // The row left the main list, and it is live, so no empty state shows.
    expect(document.body.textContent).not.toContain("No sessions running");

    act(() => {
      useStore.setState({
        rpc: { bgwork: rpcTabState({ asyncJobs: { ...runningSnapshot, running: [] } }) },
      });
    });
    expect(sectionToggle("Working")!.textContent).toBe("Working (0)");
    // Back in the main/active list.
    expect(rowButton("bgwork")).toBeDefined();
    expect(document.body.textContent).not.toContain("No sessions running");
  });

  // issue #1153: a remote row the user has opened holds its own async-jobs
  // snapshot; with a running job and an idle turn its chip reads working, so
  // it belongs in Working too, not only local rows (#1026).
  it("moves a mounted remote row with a running background job into Working (issue #1153)", () => {
    act(() => setSidebarSectionOpen("omp-ui.sidebarWorkingOpen", true));
    useStore.setState({
      state: backendState({
        projects: [],
        remoteInstances: [
          remoteInstance({
            id: "inst-a",
            nickname: "box-a",
            projects: [{ project, sessions: [sess("remote-bg", { turnRunning: false })] }],
          }),
        ],
      }),
      rpc: { "remote-bg": rpcTabState({ asyncJobs: runningSnapshot }) },
    });
    renderSidebar();
    expect(sectionToggle("Working")!.textContent).toBe("Working (1)");
    expect(rowButton("remote-bg")).toBeDefined();

    act(() => {
      useStore.setState({
        rpc: { "remote-bg": rpcTabState({ asyncJobs: { ...runningSnapshot, running: [] } }) },
      });
    });
    expect(sectionToggle("Working")!.textContent).toBe("Working (0)");
    expect(rowButton("remote-bg")).toBeDefined();
  });
});

describe("Sidebar multi-select (issue #988)", () => {
  const project = state.projects[0]!.project;
  const baseSession = state.projects[0]!.sessions[0]!;
  // launchedAt descending = display order a, b, c, d in the main list.
  const sess = (tabId: string, minute: number, patch: Partial<SessionSummary> = {}): SessionSummary => ({
    ...baseSession,
    tabId,
    title: tabId,
    cachedTitle: tabId,
    launchedAt: `2026-08-03T00:${String(59 - minute).padStart(2, "0")}:00.000Z`,
    settledAtMs: (patch.live ?? "live") === "live" ? null : 1_000,
    ...patch,
  });
  const rowButton = (title: string): HTMLButtonElement =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) => b.title === title)!;
  const click = (title: string, init: MouseEventInit = {}): void => {
    act(() => {
      rowButton(title).dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, ...init }));
    });
  };
  const selected = (): string[] =>
    [...document.body.querySelectorAll<HTMLButtonElement>('button[data-multi-selected="true"]')].map((b) => b.title);
  const bar = (): HTMLElement | null => document.body.querySelector<HTMLElement>('footer[role="toolbar"]');
  const barButton = (prefix: string): HTMLButtonElement =>
    [...(bar()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.startsWith(prefix))!;

  beforeEach(() => {
    useStore.setState({
      state: backendState({
        projects: [
          {
            project,
            sessions: [
              sess("a", 0),
              sess("b", 1),
              sess("c", 2),
              sess("d", 3),
              sess("old", 4, { live: "dormant" }),
            ],
          },
        ],
      }),
    });
  });

  it("Mod+click toggles rows without opening them; two rows swap the footer for the selection bar", () => {
    renderSidebar();
    click("a", { ctrlKey: true });
    expect(selected()).toEqual(["a"]);
    // One row is a selection but not yet a bulk: the footer stays.
    expect(bar()).toBeNull();
    click("c", { metaKey: true });
    expect(selected()).toEqual(["a", "c"]);
    expect(bar()!.textContent).toContain("2 selected");
    click("a", { ctrlKey: true });
    expect(selected()).toEqual(["c"]);
    expect(bar()).toBeNull();
    expect(openSession).not.toHaveBeenCalled();

    click("b");
    expect(openSession).toHaveBeenCalledWith("b");
  });

  it("Shift+click selects the range from the anchor within its section only", () => {
    setSettledOpen(true);
    renderSidebar();
    click("b", { ctrlKey: true });
    click("d", { shiftKey: true });
    expect(selected()).toEqual(["b", "c", "d"]);
    // A Shift+click in another section has no anchor there: it toggles alone.
    click("old", { shiftKey: true });
    expect(selected()).toEqual(["b", "c", "d", "old"]);
  });

  it("Escape clears the selection", () => {
    renderSidebar();
    click("a", { ctrlKey: true });
    click("b", { ctrlKey: true });
    act(() => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    expect(selected()).toEqual([]);
    expect(bar()).toBeNull();
  });

  it("counts per action what the selection supports and Settle settles every live row", async () => {
    setSettledOpen(true);
    renderSidebar();
    click("a", { ctrlKey: true });
    click("b", { ctrlKey: true });
    click("old", { ctrlKey: true });
    // Settle and Retitle need a process; Delete takes every selected row.
    expect(barButton("Settle").textContent).toBe("Settle (2)");
    expect(barButton("Delete").textContent).toBe("Delete… (3)");
    expect(barButton("Retitle").disabled).toBe(true);
    expect(barButton("Stop")).toBeUndefined();
    await act(async () => {
      barButton("Settle").click();
    });
    expect(backendMock.settleSession).toHaveBeenCalledWith("a");
    expect(backendMock.settleSession).toHaveBeenCalledWith("b");
    // Acting clears the selection.
    expect(selected()).toEqual([]);
  });
});

// Issue #1037: unseen replies surface as attention-stack cards above the
// list — even while the row itself hides in a collapsed section or behind
// the search filter. The stack ignores the query on purpose.
describe("Sidebar attention stack (issue #1037)", () => {
  const heading = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[role="group"][aria-label^="Needs attention"]');
  const cards = (): HTMLButtonElement[] => [...(heading()?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
  const rowButton = (title: string): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button[title]")].find((b) => b.title === title);
  const setFilter = (value: string): void => {
    const input = document.body.querySelector<HTMLInputElement>('input[aria-label="filter sessions"]')!;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    act(() => {
      setter.call(input, value);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  };

  beforeEach(() => {
    // The global harness reset does not know about the unread slice.
    useStore.setState({ unread: {} });
  });

  it("heads the list with Needs attention (n), newest mark first, snippet or fallback", () => {
    // tab-2 answers from the host-published latch alone; tab-1 reads ready
    // only through its own tab status.
    useStore.setState({
      state: backendState({
        projects: [
          {
            ...state.projects[0]!,
            sessions: [
              state.projects[0]!.sessions[0]!,
              { ...state.projects[0]!.sessions[1]!, awaitingHumanAnswer: true },
            ],
          },
        ],
      }),
      rpc: { "tab-1": rpcTabState({ status: "ready" }) },
    });
    // Backdate the first mark so card order (newest first) is deterministic.
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now - 60_000);
    useStore.getState().markUnread("tab-1", null);
    clock.mockRestore();
    useStore.getState().markUnread("tab-2", "Which DB?");
    renderSidebar();
    expect(heading()?.getAttribute("aria-label")).toBe("Needs attention (2)");
    const list = cards();
    expect(list).toHaveLength(2);
    expect(list[0]!.textContent).toContain("Second owned session");
    expect(list[0]!.textContent).toContain("answer needed");
    expect(list[0]!.textContent).toContain("Which DB?");
    // The card leads with its project line (#1159).
    expect(list[0]!.querySelector("[data-session-project]")?.textContent).toContain(state.projects[0]!.project.name);
    expect(list[1]!.textContent).toContain("Owned session");
    // A null snippet (e.g. after a restart) falls back to the stock line.
    expect(list[1]!.textContent).toContain("The agent posted a new reply.");
  });

  it("a card click opens the session, and clearing the mark retires the card", async () => {
    useStore.setState({ rpc: { "tab-2": rpcTabState({ status: "ready" }) } });
    useStore.getState().markUnread("tab-2", "Which DB?");
    renderSidebar();
    const card = cards()[0]!;
    await act(async () => card.click());
    expect(openSession).toHaveBeenCalledWith("tab-2");
    // The mocked openSession never runs the action's own clearUnread; drive it.
    act(() => useStore.getState().clearUnread("tab-2"));
    expect(cards()).toHaveLength(0);
    expect(heading()).toBeNull();
  });

  it("surfaces a dormant unsettled reminder in Needs attention, opens on click, and supports right-click re-snooze (#1323)", () => {
    const reminded = {
      ...state.projects[0]!.sessions[0]!,
      tabId: "reminded",
      title: "reminded",
      cachedTitle: "reminded",
      live: "dormant" as const,
      settledAtMs: null,
      snoozed: false,
      reminderAtMs: Date.now() - 5_000,
    };
    useStore.setState({
      state: backendState({
        projects: [{ ...state.projects[0]!, sessions: [reminded] }],
      }),
    });
    renderSidebar();
    // Reminder card is the session's only representation — no duplicate main-list row.
    expect(rowButton("reminded")).toBeUndefined();
    const cardButtons = cards().filter((b) => b.getAttribute("aria-label") !== "Dismiss reminder");
    expect(cardButtons).toHaveLength(1);
    expect(cardButtons[0]!.textContent).toContain("reminded");
    expect(cardButtons[0]!.textContent).toContain("reminder");
    expect(cardButtons[0]!.textContent).toContain("Snooze ended — click to resume");
    expect(cards().some((b) => b.getAttribute("aria-label") === "Dismiss reminder")).toBe(true);

    // Right-clicking the reminder card opens the row menu with Snooze and Settle.
    openContextMenu(cardButtons[0]!);
    expect(openMenuItems().some((b) => b.textContent?.startsWith("Snooze"))).toBe(true);
    expect(openMenuItems().some((b) => b.textContent === "Settle")).toBe(true);
  });

  it("a flagged session reads once: no duplicate main-list row while its card shows (#1038)", () => {
    useStore.setState({ rpc: { "tab-2": rpcTabState({ status: "ready" }) } });
    useStore.getState().markUnread("tab-2", null);
    renderSidebar();
    expect(cards()[0]!.textContent).toContain("Second owned session");
    expect(rowButton("Second owned session")).toBeUndefined();
    // The other (unflagged) session keeps its row next to the fence.
    expect(rowButton("Owned session")).toBeDefined();
    // Clearing the mark returns the row and retires the card.
    act(() => useStore.getState().clearUnread("tab-2"));
    expect(cards()).toHaveLength(0);
    expect(rowButton("Second owned session")).toBeDefined();
  });

  it("fences the digest off from the main list below (#1039)", () => {
    useStore.setState({ rpc: { "tab-1": rpcTabState({ status: "ready" }) } });
    act(() => useStore.getState().markUnread("tab-1", null));
    renderSidebar();
    const g = heading();
    expect(g?.className).toContain("border-line");
  });

  it("keeps showing cards while the search filter hides every row", () => {
    act(() => useStore.getState().markUnread("tab-1", null));
    useStore.setState({ rpc: { "tab-1": rpcTabState({ status: "ready" }) } });
    renderSidebar();
    setFilter("zzz-nothing");
    expect(rowButton("Owned session")).toBeUndefined();
    expect(cards()[0]!.textContent).toContain("Owned session");
  });

  it("renders nothing when no session is flagged", () => {
    renderSidebar();
    expect(heading()).toBeNull();
  });
});

describe("Sidebar dispatch tethers (#1226)", () => {
  const parentTab = "tab-1";
  const otherPath = "/projects/two";
  const project = state.projects[0]!.project;
  const base = state.projects[0]!.sessions[0]!;
  const child = (tabId: string, title: string, minute: number, patch: Partial<SessionSummary> = {}): SessionSummary => ({
    ...base,
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--two--${tabId}`,
    projectCwd: otherPath,
    launchedAt: `2026-08-03T02:${String(minute).padStart(2, "0")}:00.000Z`,
    cachedTitle: title,
    title,
    fleet: {
      dispatchId: `d-${tabId}`,
      batchId: null,
      dispatchedAt: `2026-08-03T02:${String(minute).padStart(2, "0")}:00.000Z`,
      requestedBy: { instanceId: "self", label: "this computer", kind: "agent", sourceTabId: parentTab },
    },
    ...patch,
  });
  const withChildren = (children: SessionSummary[], parentPatch: Partial<SessionSummary> = {}): BackendState =>
    backendState({
      projects: [
        { project, sessions: [{ ...base, ...parentPatch }, state.projects[0]!.sessions[1]!] },
        { project: { ...project, path: otherPath, name: "Project Two" }, sessions: children },
      ],
    });
  const tether = (): HTMLElement | null =>
    document.body.querySelector<HTMLElement>('[role="group"][aria-label^="Sessions dispatched by"]');
  const lines = (): HTMLElement[] => [...(tether()?.querySelectorAll<HTMLElement>("[data-dispatch-line]") ?? [])];
  const tetherButton = (text: string): HTMLButtonElement | undefined =>
    [...(tether()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find((b) => b.textContent?.includes(text));
  const rowOf = (title: string): HTMLElement =>
    [...document.body.querySelectorAll<HTMLElement>("[data-session-tile-title]")]
      .find((el) => el.textContent === title)!
      .closest<HTMLElement>(".group\\/row")!;

  afterEach(() => {
    act(() => {
      resetDispatchTetherState();
      setDispatchHover(null);
    });
  });

  it("lists unsettled children under the parent tile with counts; a line opens its session", async () => {
    useStore.setState({
      state: withChildren([child("c-1", "Child one", 1), child("c-2", "Child two", 2, { awaitingHumanAnswer: true })]),
      rpc: { "c-1": rpcTabState({ status: "running" }) },
    });
    renderSidebar();
    const header = tether()!.querySelector("button[aria-expanded]")!;
    expect(header.textContent).toContain(`${2} dispatched`);
    expect(header.textContent).toContain(`${1} waiting on you`);
    expect(header.textContent).toContain(`${1} working`);
    expect(lines().map((l) => l.getAttribute("data-dispatch-line"))).toEqual(["c-1", "c-2"]);
    // The tether hangs off the parent's tile, not the child's.
    expect(rowOf("Owned session").contains(tether())).toBe(true);
    await act(async () => lines()[0]!.click());
    expect(openSession).toHaveBeenCalledWith("c-1");
  });

  it("shows four lines and a +N more that expands", () => {
    useStore.setState({ state: withChildren([1, 2, 3, 4, 5].map((n) => child(`c-${n}`, `Child ${n}`, n))) });
    renderSidebar();
    expect(lines()).toHaveLength(4);
    const more = tetherButton(`+${1} more`)!;
    act(() => more.click());
    expect(lines()).toHaveLength(5);
  });

  it("folds settled children behind +N settled", () => {
    useStore.setState({
      state: withChildren([child("c-1", "Child one", 1), child("c-2", "Child done", 2, { live: "dormant", settledAtMs: 1 })]),
    });
    renderSidebar();
    expect(lines().map((l) => l.getAttribute("data-dispatch-line"))).toEqual(["c-1"]);
    act(() => tetherButton(`+${1} settled`)!.click());
    expect(lines().map((l) => l.getAttribute("data-dispatch-line"))).toEqual(["c-1", "c-2"]);
    expect(tetherButton("hide settled")).toBeDefined();
  });

  it("collapses the lines from the header", () => {
    useStore.setState({ state: withChildren([child("c-1", "Child one", 1)]) });
    renderSidebar();
    const header = tether()!.querySelector<HTMLButtonElement>("button[aria-expanded]")!;
    act(() => header.click());
    expect(header.getAttribute("aria-expanded")).toBe("false");
    expect(lines()).toHaveLength(0);
  });

  it("a missing, unmounted child line does not open", async () => {
    useStore.setState({ state: withChildren([child("c-1", "Child gone", 1, { live: "missing" })]) });
    renderSidebar();
    act(() => tetherButton(`+${1} settled`)!.click());
    const line = lines()[0]!;
    expect(line.tagName).toBe("SPAN");
    await act(async () => line.click());
    expect(openSession).not.toHaveBeenCalled();
  });

  it("keeps tether lines outside the parent's draggable, context-menu container", () => {
    useStore.setState({ state: withChildren([child("c-1", "Child one", 1)]) });
    renderSidebar();
    const line = lines()[0]!;
    expect(line.closest("[draggable]")).toBeNull();
    const event = openContextMenu(line);
    expect(event.defaultPrevented).toBe(false);
    expect(openMenuItems()).toHaveLength(0);
  });

  it("marks the child row with ↳ and its hover button opens the parent and closes the surface", async () => {
    const closeCompactSurface = vi.fn();
    useStore.setState({ state: withChildren([child("c-1", "Child one", 1)]), closeCompactSurface });
    renderSidebar();
    const row = rowOf("Child one");
    const marker = row.querySelector<HTMLElement>("[data-dispatched-by]")!;
    expect(marker.getAttribute("aria-label")).toBe(`Dispatched by “${"Owned session"}”`);
    const open = row.querySelector<HTMLButtonElement>(`button[aria-label="${"open dispatching session"}"]`)!;
    await act(async () => open.click());
    expect(openSession).toHaveBeenCalledWith(parentTab);
    expect(closeCompactSurface).toHaveBeenCalled();
  });

  it("a flagged parent's attention card carries its tether; a flagged child's card carries the marker", () => {
    useStore.setState({
      state: withChildren([child("c-1", "Child one", 1)]),
      rpc: { [parentTab]: rpcTabState({ status: "ready" }), "c-1": rpcTabState({ status: "ready" }) },
      unread: {},
    });
    act(() => {
      useStore.getState().markUnread(parentTab, null);
      useStore.getState().markUnread("c-1", null);
    });
    renderSidebar();
    const stack = document.body.querySelector<HTMLElement>('[role="group"][aria-label^="Needs attention"]')!;
    expect(stack.querySelector('[role="group"][aria-label^="Sessions dispatched by"]')).not.toBeNull();
    expect(stack.querySelector("button [data-dispatched-by]")).not.toBeNull();
    // Never nested inside a card's button.
    expect(stack.querySelector("button [data-dispatch-line]")).toBeNull();
  });

  it("a Settled (slim) parent shows no tether", () => {
    useStore.setState({ state: withChildren([child("c-1", "Child one", 1)], { live: "dormant", settledAtMs: 1 }) });
    act(() => setSettledOpen(true));
    renderSidebar();
    expect(tether()).toBeNull();
  });

  it("cross-highlights: a tether line rings the child row; the ↳ marker rings the parent and leaving re-lights the child line", () => {
    useStore.setState({ state: withChildren([child("c-1", "Child one", 1)]) });
    renderSidebar();
    const hover = (el: Element, type: "mouseover" | "mouseout"): void =>
      act(() => {
        el.dispatchEvent(new MouseEvent(type, { bubbles: true, relatedTarget: document.body }));
      });
    hover(lines()[0]!, "mouseover");
    expect(rowOf("Child one").className).toContain("ring-line-strong");
    hover(lines()[0]!, "mouseout");
    expect(rowOf("Child one").className).not.toContain("ring-line-strong");

    const marker = rowOf("Child one").querySelector("[data-dispatched-by]")!;
    hover(marker, "mouseover");
    expect(rowOf("Owned session").className).toContain("ring-line-strong");
    hover(marker, "mouseout");
    expect(rowOf("Owned session").className).not.toContain("ring-line-strong");
    // The pointer is still on the child row, so its own tether line lights.
    expect(lines()[0]!.className).toContain("bg-hover");
  });
});

describe("Sidebar Routine runs and the Routines button (ADR-0100, issue #1261)", () => {
  const routine = { id: "r".repeat(22), name: "Morning overview", approvalEntries: {}, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 };
  const withRun = (patch: Partial<SessionSummary>, gate: boolean): BackendState => {
    const group = state.projects[0]!;
    const run: SessionSummary = { ...group.sessions[0]!, tabId: "tab-run", title: "Morning overview · 2026-11-22 08:00", routine, ...patch };
    return { ...state, routinesEnabled: gate, projects: [{ ...group, sessions: [...group.sessions, run] }] };
  };

  it("keeps a live routine run out of the coding sidebar rows", () => {
    useStore.setState({ state: withRun({ turnRunning: true }, true) });
    renderSidebar();
    expect(document.body.textContent).not.toContain("Morning overview · 2026-11-22 08:00");
  });

  it("renders no Routines button while the gate is off", () => {
    useStore.setState({ state: withRun({ awaitingHumanAnswer: true }, false) });
    renderSidebar();
    expect(document.body.querySelector('button[aria-label="Routines"]')).toBeNull();
  });

  it("shows the Routines button with the waiting count and the waiting run as a stack card", () => {
    const openRoutines = vi.fn();
    useStore.setState({ state: withRun({ awaitingHumanAnswer: true }, true), openRoutines });
    renderSidebar();
    const routinesButton = button("Routines");
    expect(routinesButton.querySelector("[data-routines-waiting]")?.textContent).toBe("1");
    const stack = document.body.querySelector('[role="group"]');
    expect(stack?.textContent).toContain("Morning overview · 2026-11-22 08:00");
    act(() => routinesButton.click());
    expect(openRoutines).toHaveBeenCalled();
  });

  it("hides remote routine runs from rows and surfaces remote approval-waiting runs in Needs attention (#1304)", () => {
    const remoteGroup = {
      project: { ...state.projects[0]!.project, path: "/projects/remote", name: "omp-ui" },
      sessions: [
        {
          ...state.projects[0]!.sessions[0]!,
          tabId: "remote-run-working",
          projectCwd: "/projects/remote",
          title: "Remote working run",
          routine,
          turnRunning: true,
        },
        {
          ...state.projects[0]!.sessions[0]!,
          tabId: "remote-run-waiting",
          projectCwd: "/projects/remote",
          title: "Remote waiting run",
          routine,
          awaitingHumanAnswer: true,
        },
      ],
    };
    useStore.setState({
      state: backendState({
        routinesEnabled: true,
        projects: state.projects,
        remoteInstances: [
          remoteInstance({ id: "inst-fw", nickname: "FW-Desktop", status: "joined", projects: [remoteGroup] }),
        ],
      }),
    });
    renderSidebar();
    // Working remote routine run does not appear in rows.
    expect(document.body.textContent).not.toContain("Remote working run");
    // Routines button badge counts waiting runs across both local and joined remote hosts (#1306).
    expect(button("Routines").querySelector("[data-routines-waiting]")?.textContent).toBe("1");
    // Remote waiting routine run surfaces in Needs attention with machine label and approval copy.
    const stack = document.body.querySelector('[role="group"]');
    expect(stack?.textContent).toContain("Remote waiting run");
    expect(stack?.textContent).toContain("on FW-Desktop");
    expect(stack?.textContent).toContain("answer needed");
    expect(stack?.textContent).toContain("Approval required");
  });

  it("shows the Routines button when local Routines is off but a joined remote has routinesEnabled (#1306)", () => {
    useStore.setState({
      state: backendState({
        routinesEnabled: false,
        projects: state.projects,
        remoteInstances: [
          remoteInstance({ id: "inst-studio", nickname: "studio", status: "joined", routinesEnabled: true }),
        ],
      }),
    });
    renderSidebar();
    expect(document.body.querySelector('button[aria-label="Routines"]')).not.toBeNull();
  });
});

describe("Sidebar Artifacts pending-review badge (#1307)", () => {
  it("shows a copper pending-review badge on the Artifacts footer button when pending reviews exist and hides it at zero", () => {
    useStore.setState({
      state: backendState({ artifactLibraryEnabled: true, projects: state.projects }),
      artifactPendingReviewCount: 2,
    });
    renderSidebar();
    const artifactsBtn = document.body.querySelector<HTMLButtonElement>('button[aria-label="Artifacts"]')!;
    expect(artifactsBtn).not.toBeNull();
    expect(artifactsBtn.querySelector("[data-artifacts-pending-review]")?.textContent).toBe("2");

    act(() => {
      useStore.setState({ artifactPendingReviewCount: 0 });
    });
    expect(artifactsBtn.querySelector("[data-artifacts-pending-review]")).toBeNull();
  });
});

describe("Sidebar footer (Variant A — Equal Flex Tiles, #1316)", () => {
  it("renders icon-only flex-1 buttons with no live session count cluster", () => {
    useStore.setState({
      state: backendState({
        artifactLibraryEnabled: true,
        routinesEnabled: true,
        projects: state.projects,
        remoteInstances: [
          remoteInstance({ id: "inst-studio", nickname: "studio", status: "joined" }),
        ],
      }),
    });
    renderSidebar();

    const footer = document.body.querySelector("footer");
    expect(footer).not.toBeNull();
    expect(footer!.querySelector('[title^="Live sessions:"]')).toBeNull();
    expect(footer!.textContent).not.toContain("ready");
    expect(footer!.textContent).not.toContain("working");

    const buttons = [...footer!.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.map((b) => b.getAttribute("aria-label"))).toEqual([
      "Settings",
      "Artifacts",
      "Routines",
      "Fleet",
    ]);
    for (const btn of buttons) {
      expect(btn.getAttribute("title")).toBe(btn.getAttribute("aria-label"));
      expect(btn.textContent).toBe("");
      expect(btn.querySelector("svg")).not.toBeNull();
      expect(btn.className.split(/\s+/)).toContain("flex-1");
    }
  });
});

describe("Sidebar store subscription stability (#1286)", () => {
  it("does not re-render Sidebar when an unrelated rpc field or token delta updates", () => {
    const onRender = vi.fn();
    const tabId = state.projects[0]!.sessions[0]!.tabId;
    useStore.setState({
      state,
      rpc: { [tabId]: rpcTabState({ status: "running" }) },
      unread: {},
    });
    const host = document.createElement("div");
    document.body.appendChild(host);
    const root = createRoot(host);
    try {
      act(() => {
        root.render(
          <Profiler id="sidebar" onRender={onRender}>
            <Sidebar />
          </Profiler>,
        );
      });
      const initialCommits = onRender.mock.calls.length;
      expect(initialCommits).toBeGreaterThan(0);

      // Mutate an unrelated rpc field (simulating non-level rpc update):
      act(() => {
        useStore.setState((st) => ({
          rpc: {
            ...st.rpc,
            [tabId]: { ...st.rpc[tabId]!, busy: true },
          },
        }));
      });
      expect(onRender.mock.calls.length).toBe(initialCommits);

      // Dispatch a pure text_delta frame:
      act(() => {
        useStore.getState().handleRpcFrame(tabId, {
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "chunk" },
        });
      });
      expect(onRender.mock.calls.length).toBe(initialCommits);
    } finally {
      act(() => root.unmount());
      host.remove();
    }
  });
});
