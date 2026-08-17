// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OmpUpdateState } from "@omp-ui/core/types";
import { backendState } from "../test/fixtures";

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
  progress: null,
  error: null,
};

// store.ts captures the preload bridge at module load, so install the mock
// before dynamically importing either the store or Sidebar.
const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  getProjectOpenAvailability: vi.fn<() => Promise<{ vsCode: boolean }>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files") => Promise<void>>(),
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
const state = backendState({
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
          pendingPlan: null,
          planSettle: null,
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
          pendingPlan: null,
          planSettle: null,
        },
      ],
    },
  ],
});

// issue #115: the DnD suite needs three reorderable projects; the same session
// fixture is cloned per project so every row carries a real (but tiny) list.
const dragAlpha = "/projects/alpha";
const dragBeta = "/projects/beta";
const dragGamma = "/projects/gamma";
const threeProjectState = backendState({
  projects: [dragAlpha, dragBeta, dragGamma].map((p, i) => ({
    project: {
      ...state.projects[0]!.project,
      path: p,
      name: ["Alpha", "Beta", "Gamma"][i],
    },
    sessions: state.projects[0]!.sessions.map((s) => ({ ...s, projectCwd: p })),
  })),
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
interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

async function resolveAvailability(
  request: Deferred<{ vsCode: boolean }>,
  vsCode: boolean,
): Promise<void> {
  await act(async () => {
    request.resolve({ vsCode });
    await request.promise;
  });
}

function chooseOpen(name: string): HTMLButtonElement {
  return button(`Choose how to open ${name}`);
}

function openMenuItems(): HTMLButtonElement[] {
  return [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

beforeEach(() => {
  backendMock.getProjectOpenAvailability.mockReset();
  backendMock.getProjectOpenAvailability.mockReturnValue(new Promise(() => {}));
  backendMock.openProject.mockReset();
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
    focusedTabByProject: {},
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
    const handle = document.body.querySelector<HTMLElement>('[role="separator"][aria-label="resize project sidebar"]')!;
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
    expect(useStore.getState().sidebarWidth).toBe(272);
    act(() => useStore.getState().setSidebarWidth(400));
    act(() => useStore.getState().toggleSidebarCollapsed());
    expect(aside.className).toContain("w-14");
    expect(useStore.getState().sidebarWidth).toBe(400);
    act(() => useStore.getState().toggleSidebarCollapsed());
    expect(aside.style.width).toBe("400px");
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

    // Terminal creation moved behind the ⋯ project actions sheet (issue #205).
    act(() => useStore.getState().showCompactSurface("sessions"));
    act(() => button("actions for Project One").click());
    const sheet = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Project One"]');
    expect(sheet).not.toBeNull();
    expect(sheet!.textContent).toContain(projectPath);
    const terminal = [...sheet!.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent?.trim() === "New terminal session")!;
    act(() => terminal.click());
    expect(newSession).toHaveBeenCalledWith(projectPath, "pty");
    expect(document.body.querySelector('[role="dialog"][aria-label="Project One"]')).toBeNull();
    expect(useStore.getState().compactSurface).toBeNull();
  });
});

describe("Sidebar project open control (issue #169)", () => {
  function projectSection(name: string): HTMLElement {
    const found = [...document.body.querySelectorAll<HTMLElement>("section")].find((section) =>
      section.textContent?.includes(name),
    );
    if (found === undefined) throw new Error(`project section not found: ${name}`);
    return found;
  }

  function press(target: HTMLElement, key: string): KeyboardEvent {
    const event = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    act(() => target.dispatchEvent(event));
    return event;
  }

  async function activateNativeButtonWithKey(
    target: HTMLButtonElement,
    key: "Enter" | " ",
  ): Promise<void> {
    const down = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    const up = new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true });
    await act(async () => {
      target.dispatchEvent(down);
      target.dispatchEvent(up);
      // jsdom does not synthesize the browser's native keyboard click for a
      // button. Reproduce that final native step only when the key was not
      // canceled, preserving the contract the component relies on.
      if (!down.defaultPrevented && !up.defaultPrevented) target.click();
    });
    expect(down.defaultPrevented).toBe(false);
    expect(up.defaultPrevented).toBe(false);
  }

  function isolatedDragStart(target: HTMLElement): {
    event: Event;
    setData: (...args: unknown[]) => void;
  } {
    const event = new Event("dragstart", { bubbles: true, cancelable: true });
    const setData = vi.fn();
    Object.defineProperty(event, "dataTransfer", {
      configurable: true,
      value: { setData, effectAllowed: "" },
    });
    act(() => target.dispatchEvent(event));
    return { event, setData };
  }

  it("keeps both split segments neutral and disabled while availability is unresolved", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    renderSidebar();

    const primary = button("Open Project One");
    const trigger = chooseOpen("Project One");
    expect(primary).not.toBe(trigger);
    expect(primary.type).toBe("button");
    expect(trigger.type).toBe("button");
    expect(primary.tabIndex).toBe(0);
    expect(trigger.tabIndex).toBe(0);
    expect(primary.textContent?.trim()).toBe("Open");
    expect(primary.textContent).not.toContain("VS Code");
    expect(primary.textContent).not.toContain("Files");
    expect(primary.disabled).toBe(true);
    expect(trigger.disabled).toBe(true);
    await resolveAvailability(availability, false);
    expect(primary.disabled).toBe(false);
    expect(trigger.disabled).toBe(false);
    primary.focus();
    expect(document.activeElement).toBe(primary);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
  });

  it("reports a local unwrapped failure, refreshes VS Code, clears pending for retry, and dismisses", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    const failedOpen = deferred<void>();
    backendMock.getProjectOpenAvailability
      .mockReturnValueOnce(availability.promise)
      .mockResolvedValueOnce({ vsCode: true });
    backendMock.openProject
      .mockReturnValueOnce(failedOpen.promise)
      .mockResolvedValueOnce(undefined);
    useStore.setState({ state: threeProjectState });
    renderSidebar();
    await resolveAvailability(availability, true);

    const betaPrimary = button("Open Beta in VS Code");
    const betaTrigger = chooseOpen("Beta");
    act(() => betaPrimary.click());
    expect(betaPrimary.disabled).toBe(true);
    expect(betaTrigger.disabled).toBe(true);
    expect(button("Open Alpha in VS Code").disabled).toBe(false);

    await act(async () => {
      failedOpen.reject(
        new Error("Error invoking remote method 'open-project': Error: VS Code executable vanished"),
      );
      await failedOpen.promise.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    });

    const betaAlert = projectSection("Beta").querySelector<HTMLElement>('[role="alert"]');
    expect(betaAlert?.textContent).toContain("VS Code executable vanished");
    expect(betaAlert?.textContent).not.toContain("Error invoking remote method");
    expect(projectSection("Alpha").querySelector('[role="alert"]')).toBeNull();
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledTimes(2);
    expect(betaPrimary.disabled).toBe(false);
    expect(betaTrigger.disabled).toBe(false);

    act(() => button("dismiss open error for Beta").click());
    expect(projectSection("Beta").querySelector('[role="alert"]')).toBeNull();

    await act(async () => betaPrimary.click());
    expect(backendMock.openProject.mock.calls).toEqual([
      [dragBeta, "vscode"],
      [dragBeta, "vscode"],
    ]);
    expect(betaPrimary.disabled).toBe(false);
    expect(betaTrigger.disabled).toBe(false);
  });

  it("supports wrapped arrow navigation, native Enter and Space activation, and focus restoration", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockResolvedValue(undefined);
    renderSidebar();
    await resolveAvailability(availability, true);

    const trigger = chooseOpen("Project One");
    trigger.focus();
    act(() => trigger.click());
    let items = openMenuItems();
    expect(document.activeElement).toBe(items[0]);

    expect(press(items[0]!, "ArrowUp").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[1]);
    expect(press(items[1]!, "ArrowDown").defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);

    press(items[0]!, "Escape");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    items = openMenuItems();
    expect(document.activeElement).toBe(items[0]);
    await activateNativeButtonWithKey(items[0]!, "Enter");
    expect(backendMock.openProject).toHaveBeenLastCalledWith(projectPath, "vscode");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);

    act(() => trigger.click());
    items = openMenuItems();
    press(items[0]!, "ArrowDown");
    expect(document.activeElement).toBe(items[1]);
    await activateNativeButtonWithKey(items[1]!, " ");
    expect(backendMock.openProject).toHaveBeenLastCalledWith(projectPath, "files");
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it("dismisses an outside pointerdown without launching", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockResolvedValue(undefined);
    renderSidebar();
    await resolveAvailability(availability, true);

    act(() => chooseOpen("Project One").click());
    expect(openMenuItems()).toHaveLength(2);
    act(() =>
      document.body.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })),
    );
    expect(document.body.querySelector('[role="menu"]')).toBeNull();
    expect(backendMock.openProject).not.toHaveBeenCalled();
  });

  it("layers the actions sheet over the sessions sheet and isolates Escape (issue #205)", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();

    // The compact header carries no ProjectOpenControl — one ⋯ trigger only.
    expect(document.body.querySelector('button[aria-label="Choose how to open Project One"]')).toBeNull();
    const trigger = button("actions for Project One");
    trigger.focus();
    act(() => trigger.click());

    const actions = document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Project One"]');
    expect(actions).not.toBeNull();
    expect(actions!.textContent).toContain(projectPath);
    const rows = [...actions!.querySelectorAll<HTMLButtonElement>("button")]
      .map((row) => row.textContent?.trim())
      .filter((text): text is string => text !== undefined && text !== "");
    expect(rows).toEqual(["New session", "New terminal session", "MCP servers…", "Remove project…"]);

    const sessionsSheet = document.body.querySelector<HTMLElement>(
      '[role="dialog"][aria-label="projects and sessions"]',
    );
    expect(sessionsSheet).not.toBeNull();
    // useOverlay acts on the top of the overlay stack only: Escape closes the
    // actions sheet, never the sessions sheet beneath it.
    act(() =>
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })),
    );
    expect(document.body.querySelector('[role="dialog"][aria-label="Project One"]')).toBeNull();
    expect(document.body.querySelector('[role="dialog"][aria-label="projects and sessions"]')).toBe(
      sessionsSheet,
    );
    expect(useStore.getState().compactSurface).toBe("sessions");
    expect(document.activeElement).toBe(trigger);
  });

  it("isolates pointer, click, and dragstart from both segments and a portaled menu item", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockResolvedValue(undefined);
    backendMock.moveProject.mockClear();
    backendMock.removeProject.mockClear();
    useStore.setState({ state: threeProjectState });
    renderSidebar();
    await resolveAvailability(availability, true);

    const section = projectSection("Alpha");
    const disclosure = section.querySelector<HTMLButtonElement>(`button[title="${dragAlpha}"]`);
    if (disclosure === null) throw new Error("Alpha disclosure not found");
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    const primary = button("Open Alpha in VS Code");
    const trigger = chooseOpen("Alpha");

    act(() => primary.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
    const primaryDrag = isolatedDragStart(primary);
    expect(primaryDrag.event.defaultPrevented).toBe(true);
    expect(primaryDrag.setData).not.toHaveBeenCalled();
    await act(async () => primary.click());

    act(() => trigger.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
    const triggerDrag = isolatedDragStart(trigger);
    expect(triggerDrag.event.defaultPrevented).toBe(true);
    expect(triggerDrag.setData).not.toHaveBeenCalled();
    act(() => trigger.click());

    const item = openMenuItems()[0]!;
    act(() => item.dispatchEvent(new Event("pointerdown", { bubbles: true, cancelable: true })));
    const itemDrag = isolatedDragStart(item);
    expect(itemDrag.event.defaultPrevented).toBe(true);
    expect(itemDrag.setData).not.toHaveBeenCalled();
    await act(async () => item.click());

    expect(backendMock.openProject.mock.calls).toEqual([
      [dragAlpha, "vscode"],
      [dragAlpha, "vscode"],
    ]);
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    expect(backendMock.moveProject).not.toHaveBeenCalled();
    expect(newSession).not.toHaveBeenCalled();
    expect(backendMock.removeProject).not.toHaveBeenCalled();
  });

  it("discovers once, prefers VS Code, targets the registered path, and orders the menu", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockResolvedValue(undefined);
    renderSidebar();
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledOnce();
    await resolveAvailability(availability, true);

    const primary = button("Open Project One in VS Code");
    expect(primary.textContent?.trim()).toBe("Open");
    await act(async () => primary.click());
    expect(backendMock.openProject).toHaveBeenCalledWith(projectPath, "vscode");
    await act(async () => chooseOpen("Project One").click());
    expect(openMenuItems().map((item) => item.getAttribute("aria-label"))).toEqual([
      "Open Project One in VS Code",
      "Open Project One in Files",
    ]);
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledOnce();
  });

  it("falls back to Files and remains available for a project with zero sessions", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockResolvedValue(undefined);
    useStore.setState({
      state: { ...state, projects: [{ ...state.projects[0]!, sessions: [] }] },
    });
    renderSidebar();
    await resolveAvailability(availability, false);
    expect(document.body.textContent).toContain("no sessions yet");
    await act(async () => button("Open Project One in Files").click());
    expect(backendMock.openProject).toHaveBeenCalledWith(projectPath, "files");
    await act(async () => chooseOpen("Project One").click());
    expect(openMenuItems().map((item) => item.getAttribute("aria-label"))).toEqual([
      "Open Project One in Files",
    ]);
  });

  it("keeps every project control bound to its header rather than the focused tab", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockResolvedValue(undefined);
    useStore.setState({
      state: threeProjectState,
      activeTabId: "tab-1",
      focusedTabByProject: { [dragAlpha]: "tab-1" },
    });
    renderSidebar();
    await resolveAvailability(availability, true);
    await act(async () => button("Open Gamma in VS Code").click());
    expect(backendMock.openProject).toHaveBeenCalledWith(dragGamma, "vscode");
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledOnce();
  });

  it("prevents duplicates per project without blocking another project's request", async () => {
    const availability = deferred<{ vsCode: boolean }>();
    const alphaOpen = deferred<void>();
    const betaOpen = deferred<void>();
    backendMock.getProjectOpenAvailability.mockReturnValueOnce(availability.promise);
    backendMock.openProject.mockReturnValueOnce(alphaOpen.promise).mockReturnValueOnce(betaOpen.promise);
    useStore.setState({ state: threeProjectState });
    renderSidebar();
    await resolveAvailability(availability, true);
    const alpha = button("Open Alpha in VS Code");
    const beta = button("Open Beta in VS Code");
    act(() => alpha.click());
    expect(alpha.disabled).toBe(true);
    act(() => alpha.click());
    act(() => beta.click());
    expect(beta.disabled).toBe(true);
    expect(backendMock.openProject.mock.calls).toEqual([
      [dragAlpha, "vscode"],
      [dragBeta, "vscode"],
    ]);
    await act(async () => {
      alphaOpen.resolve();
      betaOpen.resolve();
      await Promise.all([alphaOpen.promise, betaOpen.promise]);
    });
    expect(alpha.disabled).toBe(false);
    expect(beta.disabled).toBe(false);
  });
});

describe("Compact project actions sheet (issue #205)", () => {
  function enableCompact(): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: true,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  }

  function actionsSheet(): HTMLElement | null {
    return document.body.querySelector<HTMLElement>('[role="dialog"][aria-label="Project One"]');
  }

  function sheetRow(label: string): HTMLButtonElement {
    const sheet = actionsSheet();
    if (sheet === null) throw new Error("actions sheet not open");
    const row = [...sheet.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.trim() === label,
    );
    if (row === undefined) throw new Error(`sheet row not found: ${label}`);
    return row;
  }

  it("defers remove to confirm and follows the state broadcast", async () => {
    backendMock.removeProject.mockReset();
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    enableCompact();
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();

    act(() => button("actions for Project One").click());
    await act(async () => sheetRow("Remove project…").click());
    expect(backendMock.removeProject).not.toHaveBeenCalled();
    expect(actionsSheet()).not.toBeNull();

    confirmSpy.mockReturnValue(true);
    await act(async () => sheetRow("Remove project…").click());
    expect(backendMock.removeProject).toHaveBeenCalledWith(projectPath);
    // The broadcast drops the project; the sheet's live lookup misses and it
    // closes itself rather than describing a project that no longer exists.
    act(() => useStore.setState({ state: { ...state, projects: [] } }));
    expect(actionsSheet()).toBeNull();
  });

  it("shows chips beside the name and no path row in the compact header", () => {
    enableCompact();
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();

    const section = [...document.body.querySelectorAll<HTMLElement>("section")].find(
      (candidate) => candidate.textContent?.includes("Project One"),
    );
    if (section === undefined) throw new Error("project section not found");
    // The path sub-line disappears on compact; the full path lives one ⋯ tap
    // away in the sheet instead.
    expect(section.textContent).not.toContain(projectPath);
    expect(section.querySelector('[title="2 sessions"]')).not.toBeNull();

    act(() => button("actions for Project One").click());
    expect(actionsSheet()!.textContent).toContain(projectPath);
  });

  it("opens the project-scoped MCP manager from the sheet", async () => {
    enableCompact();
    useStore.setState({ compactSurface: "sessions" });
    renderSidebar();

    act(() => button("actions for Project One").click());
    await act(async () => sheetRow("MCP servers…").click());
    expect(actionsSheet()).toBeNull();
    expect(useStore.getState().mcpManager).toEqual({ projectCwd: projectPath });
  });
});

describe("project name display", () => {
  function projectSection(name: string): HTMLElement {
    const found = [...document.body.querySelectorAll<HTMLElement>("section")].find((section) =>
      section.textContent?.includes(name),
    );
    if (found === undefined) throw new Error(`project section not found: ${name}`);
    return found;
  }

  const nameState = (path: string, name: string, lives: Array<"live" | "dormant">) =>
    backendState({
      projects: [
        {
          project: {
            path,
            name,
            addedAt: "2026-08-03T00:00:00.000Z",
            lastModel: null,
            lastAdvisorModel: null,
          },
          sessions: lives.map((live, i) => ({
            tabId: `tab-${i + 1}`,
            sessionId: `session-${i + 1}`,
            lineageDir: `omp-ui--name--session-${i + 1}`,
            projectCwd: path,
            launchedAt: "2026-08-03T00:00:00.000Z",
            mode: "rpc-ui" as const,
            advisor: false,
            advisorModel: null,
            cachedTitle: `Session ${i + 1}`,
            cachedModified: "2026-08-03T00:00:00.000Z",
            title: `Session ${i + 1}`,
            status: "complete" as const,
            live,
            pendingPlan: null,
            planSettle: null,
          })),
        },
      ],
    });

  it("splits long project names for middle ellipsis with an sr-only full copy", () => {
    const name = "terraform-aws-vpc-module";
    useStore.setState({ state: nameState("/projects/terraform-aws-vpc-module", name, ["live"]) });
    renderSidebar();

    const section = projectSection(name);
    const srOnly = [...section.querySelectorAll<HTMLElement>(".sr-only")].filter(
      (span) => span.textContent === name,
    );
    expect(srOnly).toHaveLength(1);

    const wrapper = srOnly[0]!.parentElement;
    if (wrapper === null) throw new Error("sr-only copy has no parent");
    const hidden = wrapper.querySelectorAll<HTMLElement>('[aria-hidden="true"]');
    expect(hidden).toHaveLength(2);
    expect(hidden[0]!.textContent! + hidden[1]!.textContent!).toBe(name);
    expect(hidden[0]!.classList.contains("truncate")).toBe(true);
    expect(hidden[0]!.textContent).toBe("terraform-aw");
    expect(hidden[1]!.classList.contains("shrink-0")).toBe(true);
    expect(hidden[1]!.textContent).toBe("s-vpc-module");
    expect(section.textContent).not.toContain("…");
  });

  it("splits on code-point boundaries when the name contains astral characters", () => {
    const name = "proj-🚀-x";
    useStore.setState({ state: nameState("/projects/proj-rocket-x", name, ["live"]) });
    renderSidebar();

    const section = projectSection(name);
    const srOnly = [...section.querySelectorAll<HTMLElement>(".sr-only")].find(
      (span) => span.textContent === name,
    );
    if (srOnly === undefined) throw new Error("sr-only name copy not found");
    const wrapper = srOnly.parentElement;
    if (wrapper === null) throw new Error("sr-only copy has no parent");
    const hidden = wrapper.querySelectorAll<HTMLElement>('[aria-hidden="true"]');
    expect(hidden).toHaveLength(2);
    expect(hidden[0]!.textContent! + hidden[1]!.textContent!).toBe(name);
    expect(hidden[0]!.textContent).toBe("proj");
    expect(hidden[1]!.textContent).toBe("-🚀-x");
  });

  it("renders the count and live chips on the path row, not the name row", () => {
    const path = "/projects/chips";
    const name = "Chips";
    useStore.setState({ state: nameState(path, name, ["live", "dormant"]) });
    renderSidebar();

    const section = projectSection(name);
    const countChip = section.querySelector<HTMLElement>('[title="2 sessions"]');
    if (countChip === null) throw new Error("count chip not found");
    const liveChip = section.querySelector<HTMLElement>('[title="1 live"]');
    if (liveChip === null) throw new Error("live chip not found");

    const chipRow = countChip.parentElement;
    if (chipRow === null) throw new Error("count chip has no parent row");
    expect(chipRow.textContent).toContain(path);
    expect(liveChip.parentElement).toBe(chipRow);

    const srOnly = [...section.querySelectorAll<HTMLElement>(".sr-only")].find(
      (span) => span.textContent === name,
    );
    if (srOnly === undefined) throw new Error("sr-only name copy not found");
    const nameRow = srOnly.parentElement;
    if (nameRow === null) throw new Error("sr-only name copy has no parent");
    expect(nameRow.querySelector('[title$="sessions"]')).toBeNull();
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
    pendingPlan: null,
    planSettle: null,
  });
  const project = (path: string, name: string) => ({
    project: { path, name, addedAt: "t", lastModel: null, lastAdvisorModel: null },
    sessions: Array.from({ length: 9 }, (_, i) =>
      session(`${path === projA ? "a" : "b"}-session-${i + 1}`, path, `Project ${name} session ${i + 1}`),
    ),
  });
  const manySessionState = backendState({
    projects: [project(projA, "A"), project(projB, "B")],
  });

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
  const orderedState = (paths: string[]) =>
    backendState({
      projects: paths.map((p) =>
        threeProjectState.projects.find((group) => group.project.path === p)!,
      ),
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
