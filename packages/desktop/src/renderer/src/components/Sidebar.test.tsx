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
  planFormat: "html",
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
    planFormat: "html",
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
