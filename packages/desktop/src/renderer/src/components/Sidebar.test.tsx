// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState, OmpUpdateState } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
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
  moveProject: vi.fn(async () => {}),
  setDefaultMode: vi.fn(),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(),
  setSessionModel: vi.fn(),
  generateTitle: vi.fn(),
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
};
Object.assign(window, { ompBackend: backendMock });

const { useStore } = await import("../store");
const { Sidebar } = await import("./Sidebar");
const originalNewSession = useStore.getState().newSession;
const originalOpenSession = useStore.getState().openSession;
const openSession = vi.fn(async () => {});
const newSession = vi.fn(async () => {});

const projectPath = "/projects/one";
const state: BackendState = {
  defaultMode: "rpc-ui",
  defaultAgentMode: "plan",
  planFormat: "html",
  advisorAutoReply: true,
  modelFavorites: [],
  skipDeleteConfirmation: false,
  themeId: "graphite",
  appUpdateCheckOnLaunch: true,
  ompUpdateCheckOnLaunch: true,
  dismissedAppUpdateVersion: null,
  dismissedOmpUpdateVersion: null,
  projects: [
    {
      project: {
        path: projectPath,
        name: "Project One",
        addedAt: "2026-08-03T00:00:00.000Z",
        lastModel: null,
        lastAdvisorModel: null,
      },
      sessions: [
        {
          tabId: "tab-1",
          sessionId: "session-1",
          lineageDir: "omp-ui--one--session-1",
          projectCwd: projectPath,
          launchedAt: "2026-08-03T00:00:00.000Z",
          mode: "rpc-ui",
          advisor: false,
          advisorModel: null,
          cachedTitle: "Owned session",
          cachedModified: "2026-08-03T00:00:00.000Z",
          title: "Owned session",
          status: "complete",
          live: "live",
        },
        {
          tabId: "tab-2",
          sessionId: "session-2",
          lineageDir: "omp-ui--one--session-2",
          projectCwd: projectPath,
          launchedAt: "2026-08-03T01:00:00.000Z",
          mode: "rpc-ui",
          advisor: false,
          advisorModel: null,
          cachedTitle: "Second owned session",
          cachedModified: "2026-08-03T01:00:00.000Z",
          title: "Second owned session",
          status: "complete",
          live: "live",
        },
      ],
    },
  ],
};

// issue #115: the DnD suite needs three reorderable projects; the same session
// fixture is cloned per project so every row carries a real (but tiny) list.
const dragAlpha = "/projects/alpha";
const dragBeta = "/projects/beta";
const dragGamma = "/projects/gamma";
const threeProjectState: BackendState = {
  ...state,
  projects: [dragAlpha, dragBeta, dragGamma].map((p, i) => ({
    project: {
      ...state.projects[0]!.project,
      path: p,
      name: ["Alpha", "Beta", "Gamma"][i],
    },
    sessions: state.projects[0]!.sessions.map((s) => ({ ...s, projectCwd: p })),
  })),
};

let root: Root | null = null;
const originalMatchMedia = window.matchMedia;

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

function collapsedProjectButton(): HTMLButtonElement {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.title.startsWith("Project One —"),
  );
  if (found === undefined) throw new Error("collapsed project trigger not found");
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

function terminalMenuItem(): HTMLButtonElement {
  const items = document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
  expect(items).toHaveLength(1);
  expect(items[0]!.textContent).toBe("New terminal session");
  return items[0]!;
}

beforeEach(() => {
  newSession.mockClear();
  openSession.mockClear();
  useStore.setState({
    state,
    tabs: [],
    activeTabId: null,
    focusedTabByProject: {},
    restoringTabs: false,
    exited: {},
    rpc: {},
    advisorDefaults: {},
    sidebarCollapsed: false,
    compactSurface: null,
    newSession,
    openSession,
  });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
  useStore.setState({
    state: null,
    tabs: [],
    activeTabId: null,
    focusedTabByProject: {},
    restoringTabs: false,
    exited: {},
    rpc: {},
    advisorDefaults: {},
    newSession: originalNewSession,
    openSession: originalOpenSession,
  });
});

describe("Sidebar session creation", () => {
  it("removes sidebar mode chrome and preserves plain creation in both layouts", () => {
    renderSidebar();

    expect(document.body.textContent).not.toContain("new sessions");
    expect(document.body.querySelector('[title="new sessions open in the terminal"]')).toBeNull();
    expect(document.body.querySelector('[title="new sessions open in the native RPC view"]')).toBeNull();
    expect(document.body.querySelector('[title="switch to terminal mode"]')).toBeNull();
    expect(document.body.querySelector('[title="switch to native mode"]')).toBeNull();

    act(() => button("new session").click());
    expect(newSession).toHaveBeenLastCalledWith(projectPath);

    act(() => useStore.getState().toggleSidebarCollapsed());
    act(() => collapsedProjectButton().click());
    expect(newSession).toHaveBeenNthCalledWith(2, projectPath);
  });

  it("opens and selects the terminal action from the expanded project trigger", () => {
    renderSidebar();
    const trigger = button("new session");

    const event = openContextMenu(trigger);

    expect(event.defaultPrevented).toBe(true);
    const item = terminalMenuItem();
    expect(document.activeElement).toBe(item);

    act(() => item.click());
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(newSession).toHaveBeenCalledWith(projectPath, "pty");
  });

  it("opens and selects the same terminal action from the collapsed project trigger", () => {
    renderSidebar();
    act(() => useStore.getState().toggleSidebarCollapsed());
    const trigger = collapsedProjectButton();

    const event = openContextMenu(trigger);

    expect(event.defaultPrevented).toBe(true);
    const item = terminalMenuItem();
    expect(document.activeElement).toBe(item);

    act(() => item.click());
    expect(newSession).toHaveBeenCalledWith(projectPath, "pty");
  });

  it("restores trigger focus on Escape and dismisses outside without spawning", () => {
    renderSidebar();
    const trigger = button("new session");
    trigger.focus();
    openContextMenu(trigger);
    expect(document.activeElement).toBe(terminalMenuItem());

    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    );
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    openContextMenu(trigger);
    terminalMenuItem();
    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(newSession).not.toHaveBeenCalled();
  });

  it("activates the second session and exposes terminal creation on compact touch", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
      matches: true,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })) });
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();
    const second = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.includes("Second owned session"))!;
    act(() => second.click());
    expect(openSession).toHaveBeenCalledWith("tab-2");
    expect(useStore.getState().compactSurface).toBeNull();

    act(() => useStore.getState().showCompactSurface("sessions"));
    const terminal = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "terminal")!;
    act(() => terminal.click());
    expect(newSession).toHaveBeenCalledWith(projectPath, "pty");
    expect(useStore.getState().compactSurface).toBeNull();
  });
});

describe("Sidebar pagination follows a project's own focus (issue #99)", () => {
  /** `projA`/`projB` each have PAGE+1=9 sessions, one per tab id `aN` / `bN`. */
  const projA = "/p/a";
  const projB = "/p/b";
  const session = (tabId: string, projectCwd: string, title: string) => ({
    tabId,
    sessionId: `sid-${tabId}`,
    lineageDir: `omp-ui--${tabId}--sid-${tabId}`,
    projectCwd,
    launchedAt: "2026-08-03T00:00:00.000Z",
    mode: "rpc-ui" as const,
    advisor: false,
    advisorModel: null,
    cachedTitle: title,
    cachedModified: "2026-08-03T00:00:00.000Z",
    title,
    status: "complete" as const,
    live: "live" as const,
  });
  const project = (path: string, name: string) => ({
    project: { path, name, addedAt: "t", lastModel: null, lastAdvisorModel: null },
    sessions: Array.from({ length: 9 }, (_, i) =>
      session(`${path === projA ? "a" : "b"}-session-${i + 1}`, path, `Project ${name} session ${i + 1}`),
    ),
  });
  const manySessionState: BackendState = {
    defaultMode: "rpc-ui",
    defaultAgentMode: "plan",
    planFormat: "html",
    advisorAutoReply: true,
    modelFavorites: [],
    skipDeleteConfirmation: false,
    themeId: "graphite",
    appUpdateCheckOnLaunch: true,
    ompUpdateCheckOnLaunch: true,
    dismissedAppUpdateVersion: null,
    dismissedOmpUpdateVersion: null,
    projects: [project(projA, "A"), project(projB, "B")],
  };

  it("sizes each project's page by its remembered focus while selection stays global", () => {
    useStore.setState({
      state: manySessionState,
      // Global focus is project A's FIRST session; each project's remembered
      // focus is its OWN LAST session. Pagination must follow the per-project
      // memory, so project B shows past its first page — while the selected
      // styling (SessionRow reads the global activeTabId itself) stays on A-1.
      activeTabId: "a-session-1",
      focusedTabByProject: { [projA]: "a-session-9", [projB]: "b-session-9" },
    });
    renderSidebar();

    // Project B's last session is on screen: pagination followed B's focus,
    // not the global active tab (which lives in project A's list).
    const bLast = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Project B session 9"),
    );
    if (bLast === undefined) console.error("DEBUG DOM:", document.body.innerHTML);
    expect(bLast).not.toBeUndefined();
    // Pagination widened past the first PAGE (8) page.
    expect(document.body.textContent).toContain("showing 9 of 9");

    // Selection styling is global: A-1 (the global activeTabId) is marked.
    const aFirst = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.includes("Project A session 1"),
    )!;
    expect(aFirst.getAttribute("aria-current")).toBe("page");
    // B-9 is visible but NOT selected, even though it is project B's focus.
    expect(bLast!.getAttribute("aria-current")).toBeNull();
  });
});

describe("Sidebar project drag-and-drop (issue #115)", () => {
  /** Deterministic geometry: every section spans y 0–100, so clientY 40 = top half. */
  const mockSectionRects = (): void => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      top: 0,
      bottom: 100,
      height: 100,
      left: 0,
      right: 200,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    } as DOMRect);
  };

  const dragEvent = (type: string, clientY: number, dataTransfer: object): MouseEvent => {
    const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientY });
    // jsdom's MouseEvent carries no dataTransfer; the component only ever uses
    // setData/effectAllowed, so a plain fixture object suffices.
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer, configurable: true });
    return event;
  };

  const makeDataTransfer = (): { setData: (...args: unknown[]) => void; effectAllowed: string } => ({
    setData: vi.fn(),
    effectAllowed: "",
  });

  function sectionFor(name: string): HTMLElement {
    const found = [...document.querySelectorAll<HTMLElement>("section")].find((el) =>
      el.textContent?.includes(name),
    );
    if (found === undefined) throw new Error(`section not found: ${name}`);
    return found;
  }

  function headerFor(name: string): HTMLElement {
    const found = sectionFor(name).querySelector<HTMLElement>("[draggable]");
    if (found === null) throw new Error(`draggable header not found: ${name}`);
    return found;
  }

  beforeEach(() => {
    backendMock.moveProject.mockClear();
    useStore.setState({ state: threeProjectState });
    mockSectionRects();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves before a project when dropped on its top half", async () => {
    renderSidebar();
    const dt = makeDataTransfer();
    await act(async () => {
      headerFor("Alpha").dispatchEvent(dragEvent("dragstart", 0, dt));
    });
    await act(async () => {
      sectionFor("Gamma").dispatchEvent(dragEvent("dragover", 40, dt));
    });
    expect(sectionFor("Gamma").getAttribute("data-drop-indicator")).toBe("before");
    await act(async () => {
      sectionFor("Gamma").dispatchEvent(dragEvent("drop", 40, dt));
    });
    expect(backendMock.moveProject).toHaveBeenCalledWith(dragAlpha, dragGamma);
    expect(sectionFor("Gamma").getAttribute("data-drop-indicator")).toBeNull();
  });

  it("appends when dropped on the last project's bottom half", async () => {
    renderSidebar();
    const dt = makeDataTransfer();
    await act(async () => {
      headerFor("Beta").dispatchEvent(dragEvent("dragstart", 0, dt));
    });
    await act(async () => {
      sectionFor("Gamma").dispatchEvent(dragEvent("dragover", 60, dt));
    });
    expect(sectionFor("Gamma").getAttribute("data-drop-indicator")).toBe("after");
    await act(async () => {
      sectionFor("Gamma").dispatchEvent(dragEvent("drop", 60, dt));
    });
    expect(backendMock.moveProject).toHaveBeenCalledWith(dragBeta, null);
  });

  it("is a no-op when dropped back onto its own row", async () => {
    renderSidebar();
    const dt = makeDataTransfer();
    await act(async () => {
      headerFor("Alpha").dispatchEvent(dragEvent("dragstart", 0, dt));
    });
    await act(async () => {
      sectionFor("Alpha").dispatchEvent(dragEvent("dragover", 40, dt));
      sectionFor("Alpha").dispatchEvent(dragEvent("drop", 40, dt));
    });
    expect(backendMock.moveProject).not.toHaveBeenCalled();
    expect(sectionFor("Alpha").getAttribute("data-drop-indicator")).toBeNull();
  });

  it("is a no-op when dropped just above itself, the 'leave it put' gesture", async () => {
    renderSidebar();
    const dt = makeDataTransfer();
    await act(async () => {
      headerFor("Gamma").dispatchEvent(dragEvent("dragstart", 0, dt));
    });
    // Bottom half of Beta means "after Beta", which is *before Gamma* — the
    // dragged project itself. The gesture must not reorder, and must not spend
    // a save and a broadcast saying so.
    await act(async () => {
      sectionFor("Beta").dispatchEvent(dragEvent("dragover", 60, dt));
      sectionFor("Beta").dispatchEvent(dragEvent("drop", 60, dt));
    });
    expect(backendMock.moveProject).not.toHaveBeenCalled();
  });

  it("offers no drag affordance while the filter hides rows", async () => {
    renderSidebar();
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(3);
    const filter = document.querySelector<HTMLInputElement>('input[aria-label="filter sessions"]');
    expect(filter).not.toBeNull();
    // React reads the value off its own descriptor, so a bare `.value =` write
    // is invisible to onChange; the native setter is what a real keystroke does.
    const setValue = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value",
    )!.set!;
    await act(async () => {
      setValue.call(filter!, "Alpha");
      filter!.dispatchEvent(new Event("input", { bubbles: true }));
    });
    // Drops resolve against the visible rows, so a hidden neighbour would make
    // the insertion line promise a position the reorder cannot honour.
    // `draggable` is enumerated, not boolean: React emits draggable="false",
    // so the attribute is still present and only its value says "off".
    expect(document.querySelectorAll('[draggable="true"]')).toHaveLength(0);
  });
});

describe("Sidebar keyboard project reorder (issue #120)", () => {
  /** The broadcast the main process would send after a successful move. */
  const orderedState = (paths: string[]): BackendState => ({
    ...threeProjectState,
    projects: paths.map((p) => threeProjectState.projects.find((g) => g.project.path === p)!),
  });
  const grip = (name: string): HTMLButtonElement => button(`reorder ${name}`);
  const note = (): string => document.body.querySelector('[role="status"]')!.textContent ?? "";
  const press = async (el: HTMLElement, key: string): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new KeyboardEvent("keydown", { key, altKey: true, bubbles: true }));
    });
  };

  beforeEach(() => {
    backendMock.moveProject.mockClear();
    useStore.setState({ state: threeProjectState });
  });

  it("moves a project down, then announces and refocuses once the order lands", async () => {
    renderSidebar();
    await press(grip("Alpha"), "ArrowDown");
    expect(backendMock.moveProject).toHaveBeenCalledWith(dragAlpha, dragGamma);
    // Nothing is announced until the registry's broadcast replaces `state`.
    expect(note()).toBe("");

    await act(async () => {
      useStore.setState({ state: orderedState([dragBeta, dragAlpha, dragGamma]) });
    });
    expect(note()).toBe("Alpha moved to position 2 of 3");
    expect(document.activeElement).toBe(grip("Alpha"));
  });

  it("moves the last project up by inserting it before its predecessor", async () => {
    renderSidebar();
    await press(grip("Gamma"), "ArrowUp");
    expect(backendMock.moveProject).toHaveBeenCalledWith(dragGamma, dragBeta);
  });

  it("appends when the second-to-last project moves down", async () => {
    renderSidebar();
    await press(grip("Beta"), "ArrowDown");
    expect(backendMock.moveProject).toHaveBeenCalledWith(dragBeta, null);
  });

  it("refuses to move past either end and says so instead", async () => {
    renderSidebar();
    await press(grip("Alpha"), "ArrowUp");
    expect(backendMock.moveProject).not.toHaveBeenCalled();
    expect(note()).toBe("Alpha is already first");
    await press(grip("Gamma"), "ArrowDown");
    expect(backendMock.moveProject).not.toHaveBeenCalled();
    expect(note()).toBe("Gamma is already last");
  });

  it("ignores an unmodified arrow key so list navigation is untouched", async () => {
    renderSidebar();
    await act(async () => {
      grip("Alpha").dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    });
    expect(backendMock.moveProject).not.toHaveBeenCalled();
  });

  it("offers no reorder handle when there is only one project", () => {
    useStore.setState({ state: { ...threeProjectState, projects: [threeProjectState.projects[0]!] } });
    renderSidebar();
    expect(document.body.querySelector('button[aria-label^="reorder "]')).toBeNull();
  });
});
