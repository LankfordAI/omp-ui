// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, OmpUpdateState, RemoteInstanceSummary, SessionSummary } from "@omp-ui/core/types";
import { backendState, remoteInstance, rpcTabState } from "../test/fixtures";
import { setSettledOpen } from "../lib/sidebar-settled";
import { setSidebarSectionOpen } from "../lib/sidebar-section-open";
import { SIDEBAR_DEFAULT_WIDTH } from "../lib/panel-layout";
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
  setSnoozedSectionEnabled: vi.fn(async () => {}),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
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
  refreshRemoteInstanceState: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { Sidebar } = await import("./Sidebar");
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
        reviewRoster: null,
        knowledgeHome: null,
        repositoryKey: null,
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
 pinnedAtMs: null,
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
 pinnedAtMs: null,
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
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) });
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();
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
        sessions: [{ ...state.projects[0]!.sessions[0]!, ...patch }, state.projects[0]!.sessions[1]!],
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
    expect(itemLabels()).toEqual(["Ask about this session", "Migrate…"]);
    act(() => openMenuItems()[0]!.click());
    expect(askAboutSession).toHaveBeenCalledWith("tab-1");
    expect(openMenuItems()).toEqual([]);
  });

  it("offers Settle, Ask, and Pin but not Migrate on an idle live local row", () => {
    renderSidebar();
    openContextMenu(row("Owned session"));
    expect(itemLabels()).toEqual(["Settle", "Ask about this session", "Pin"]);
  });

  it("opens no menu on a row with no saved transcript", () => {
    useStore.setState({ state: withFirst({ sessionId: null, live: "dormant" }) });
    renderSidebar();
    const event = openContextMenu(row("Owned session"));
    expect(event.defaultPrevented).toBe(false);
    expect(openMenuItems()).toEqual([]);
  });

  it("offers Ask, never Migrate, on a dormant chat row", () => {
    const chat: SessionSummary = {
      ...state.projects[0]!.sessions[0]!,
      tabId: "chat-c1",
      chat: true,
      title: "Brainstorm names",
      cachedTitle: "Brainstorm names",
    };
    useStore.setState({ state: { ...state, chats: [{ ...chat, live: "dormant" }] } });
    renderSidebar();
    openContextMenu(row("Brainstorm names"));
    expect(itemLabels()).toEqual(["Ask about this session"]);
    act(() => openMenuItems()[0]!.click());
    expect(askAboutSession).toHaveBeenCalledWith("chat-c1");
  });
});

describe("Sidebar session list", () => {
  const SETTLED_KEY = "omp-ui.sidebarSettledOpen";
  /** tab-1 stays live; tab-2 is dormant, so it lands under Settled. */
  const mixedState = backendState({
    projects: [
      {
        ...state.projects[0]!,
        sessions: [state.projects[0]!.sessions[0]!, { ...state.projects[0]!.sessions[1]!, live: "dormant" }],
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

  it("opens the quick-open from the empty state and the header", () => {
    useStore.setState({
      state: backendState({
        projects: [
          {
            ...state.projects[0]!,
            sessions: state.projects[0]!.sessions.map((s) => ({ ...s, live: "dormant" as const })),
          },
        ],
      }),
    });
    renderSidebar();
    expect(document.body.textContent).toContain("No running sessions");
    const emptyAction = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) => b.textContent === "New session",
    )!;
    act(() => emptyAction.click());
    expect(useStore.getState().projectQuickOpen).not.toBeNull();

    act(() => useStore.getState().closeProjectQuickOpen());
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

  it("opens Remote instances from the footer's unreachable chip", () => {
    useStore.setState({ state: withRemote({ status: "unreachable", error: "connection lost" }) });
    renderSidebar();
    const chip = [...document.body.querySelectorAll<HTMLButtonElement>("footer button")].find(
      (b) => b.textContent === "1 unreachable",
    )!;
    act(() => chip.click());
    expect(useStore.getState().settingsPage).toBe("remote-instances");
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
 pinnedAtMs: null,
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
    reviewRoster: null,
    knowledgeHome: null,
    repositoryKey: null,
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
  const chip = (target: HTMLElement, text: string): HTMLElement | undefined =>
    [...target.querySelectorAll<HTMLElement>("span")].find((el) => el.textContent === text);

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
    expect(section.querySelector('[title="Agent is working"]')).not.toBeNull();
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
    expect(section.querySelector('[title="Agent is waiting for your answer"]')).not.toBeNull();
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
    const line = titleLine(button);
    expect(line.querySelector('[aria-hidden="true"]')?.textContent).toBe("📝");
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
    ...patch,
  });
  const stateWith = (sessions: SessionSummary[], patch: Partial<BackendState> = {}): BackendState =>
    backendState({ ...patch, projects: [{ project, sessions }] });

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
    backendMock.setSnoozedSectionEnabled.mockClear();
  });

  it("renders Working (n), open by default, and moves an in-turn live row into it", () => {
    useStore.setState({ state: stateWith([sess("busy", { turnRunning: true })]) });
    renderSidebar();
    const toggle = sectionToggle("Working")!;
    expect(toggle.textContent).toBe("Working (1)");
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(rowButton("busy")).toBeDefined();
    // The main list is empty: a live row exists, so no "No running sessions".
    expect(document.body.textContent).not.toContain("No running sessions");
  });

  it("keeps Working (0) visible and docked directly above Settled, below Snoozed", () => {
    useStore.setState({
      state: stateWith([sess("parked", { snoozed: true }), sess("old", { live: "dormant" })], {
        snoozedSectionEnabled: true,
      }),
    });
    renderSidebar();
    const headings = [...document.body.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].map(
      (b) => b.textContent,
    );
    expect(headings).toEqual(["Snoozed (1)", "Working (0)", "Settled (1)"]);
  });

  it("with the setting off, shows no Snoozed section or Snooze item and keeps a snoozed-flagged row in the main list", () => {
    useStore.setState({ state: stateWith([sess("parked", { snoozed: true })]) });
    renderSidebar();
    expect(sectionToggle("Snoozed")).toBeUndefined();
    expect(rowButton("parked")).toBeDefined();
    openContextMenu(rowButton("parked")!);
    const labels = menuItemLabels();
    expect(labels).not.toContain("Snooze");
    expect(labels).not.toContain("Unsnooze");
  });

  it("with the setting on, Snooze parks a row and a snoozed row offers Unsnooze", () => {
    useStore.setState({
      state: stateWith([sess("parked"), sess("done", { snoozed: true })], { snoozedSectionEnabled: true }),
    });
    renderSidebar();
    openContextMenu(rowButton("parked")!);
    expect(menuItemLabels()).toContain("Snooze");
    act(() => {
      openMenuItems().find((b) => b.textContent === "Snooze")!.click();
    });
    expect(backendMock.setSessionSnoozed).toHaveBeenCalledWith("parked", true);

    expect(sectionToggle("Snoozed")!.textContent).toBe("Snoozed (1)");
    act(() => sectionToggle("Snoozed")!.click());
    openContextMenu(rowButton("done")!);
    expect(menuItemLabels()).toContain("Unsnooze");
    act(() => {
      openMenuItems().find((b) => b.textContent === "Unsnooze")!.click();
    });
    expect(backendMock.setSessionSnoozed).toHaveBeenCalledWith("done", false);
  });

  it("timed snooze sends its deadline, and a snoozed row offers no timed items (issue #979)", () => {
    useStore.setState({
      state: stateWith([sess("parked"), sess("done", { snoozed: true, snoozedUntilMs: Date.now() + 3_600_000 })], {
        snoozedSectionEnabled: true,
      }),
    });
    renderSidebar();
    const before = Date.now();
    openContextMenu(rowButton("parked")!);
    expect(menuItemLabels()).toEqual(
      expect.arrayContaining(["Snooze", "Snooze 1 hour", "Snooze until tomorrow morning", "Snooze until next week", "Snooze until…"]),
    );
    act(() => {
      openMenuItems().find((b) => b.textContent === "Snooze 1 hour")!.click();
    });
    const [tabId, snoozed, untilMs] = backendMock.setSessionSnoozed.mock.calls.at(-1) as unknown as [string, boolean, number];
    expect([tabId, snoozed]).toEqual(["parked", true]);
    expect(untilMs - before).toBeGreaterThanOrEqual(3_600_000);
    expect(untilMs - before).toBeLessThan(3_600_000 + 5_000);

    act(() => sectionToggle("Snoozed")!.click());
    expect(document.body.textContent).toMatch(/snoozed until \w+ \d\d:\d\d/);
    openContextMenu(rowButton("done")!);
    expect(menuItemLabels().filter((l) => l.startsWith("Snooze") || l === "Unsnooze")).toEqual(["Unsnooze"]);
  });

  it("persists the Snoozed collapse choice to its own localStorage key", () => {
    useStore.setState({
      state: stateWith([sess("done", { snoozed: true })], { snoozedSectionEnabled: true }),
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
    useStore.setState({
      state: stateWith(
        [
          sess("idle"),
          sess("busy", { turnRunning: true }),
          sess("parked", { snoozed: true }),
          sess("old", { live: "dormant" }),
        ],
        { snoozedSectionEnabled: true },
      ),
    });
    renderSidebar();
    // Collapse Working (open by default); Snoozed is collapsed by default.
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
    expect(document.body.textContent).toContain("No running sessions");
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
});
