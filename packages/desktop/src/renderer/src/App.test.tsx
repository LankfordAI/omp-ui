// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "./lib/rpc-types";
import { backendState } from "./test/fixtures";
import type { RpcTabState, UiStore } from "./store";
import type { LifecycleSlice } from "./store/slices/lifecycle";
import type { BackendState, SessionSummary } from "@omp-ui/core/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// The real ProjectQuickOpen mounts in the issue #915 tests below; its palette
// rows scroll on keyboard navigation and jsdom has no layout.
HTMLElement.prototype.scrollIntoView = vi.fn();

// The mock renders an aside so the shell tests can assert the sidebar mount
// (always present on desktop, zero tabs included — issue #919) through DOM
// presence.
vi.mock("./components/Sidebar", () => ({ Sidebar: () => <aside data-sidebar-mock /> }));
vi.mock("./components/RpcTab", () => ({ RpcTab: ({ tabId }: { tabId: string }) => <div data-rpc-tab={tabId} /> }));
vi.mock("./components/TerminalTab", () => ({ TerminalTab: ({ tabId }: { tabId: string }) => <div data-terminal-tab={tabId} /> }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null, openPalette: vi.fn() }));
vi.mock("./components/AppUpdateCard", () => ({ AppUpdateCard: () => null }));
vi.mock("./components/OmpUpdateCard", () => ({ OmpUpdateCard: () => null }));
vi.mock("./components/DeleteSessionDialog", () => ({ DeleteSessionDialog: () => null }));
vi.mock("./components/ProjectPicker", () => ({ ProjectPicker: () => null }));
vi.mock("./components/CapabilitiesViewer", () => ({ CapabilitiesViewer: () => null }));
vi.mock("./components/Settings", () => ({ Settings: () => null }));

// Dynamic imports are the module-loading boundary under test: ./backend and
// ./store capture window.ompBackend at evaluation, so the window stub above
// must land before they load.
const { useStore } = await import("./store");
const { backend } = await import("./backend");
const { default: App } = await import("./App");

let compact = true;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
let root: Root | null = null;

function runtime(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready", items: [], transcriptRevision: 0, todos: [], model: null, availableModels: [], commands: [],
    activeTurnKeywords: [],
    session: emptySessionRuntime(), stats: null, subagents: [], subagentItems: {}, selectedSubagent: null,
    subagentMarkers: new Map(), stallCount: 0, extensionStatus: {},
    extensionQueue: [], busy: false, initialPrompt: null,
    hasRenamed: true, titleAttempt: null, plan: null, planReview: null, planText: null, planHtml: null, planDeferred: false,
    planReadiness: null, experimentProposal: null, approvalPrompt: null,
    planSourceKey: null, planVoice: { ready: false, busy: false, error: null },
    advisorStats: null, mcpStatus: null, advisorReply: true,
    capabilities: null, capabilitiesLoad: "idle", goal: null, vibe: null, sideQuestions: null, sideCommands: null, live: null, autoresearch: null, limits: null,
    asyncJobs: null, asyncJobsKill: null, asyncJobsKillError: null, sessionSpend: null,
    subagentControlBusy: {}, subagentControlError: null,
    browserPane: { open: false, fullscreen: false, agentOpened: false, ensure: "idle", unavailableReason: null, state: null, frame: null },
    ...patch,
  };
}

function seed(): void {
  useStore.setState({
    init: vi.fn(async () => {}),
    state: null,
    tabs: [
      { tabId: "rpc", mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null },
      { tabId: "pty", mode: "pty", projectCwd: "/p", hidden: false, instanceId: null },
    ],
    activeTabId: "rpc",
    restoringTabs: false,
    rpc: { rpc: runtime({
      todos: [{ phase: "work", tasks: [{ content: "open", status: "pending" }] }],
      subagents: [{ id: "agent-1", name: "worker", status: "working" }],
      planReview: { request: { title: "Plan", planFilePath: "local://plan.md", planAbsPath: "/plan.md" }, frame: { id: "p" } },
    }) },
    compactSurface: null,
    sidebarCollapsed: false,
    lab: null,
    experimentDialog: null,
    // The quick-open tests open the overlay; reset so a stale open never
    // satisfies the next test's `not.toBeNull()` by leakage.
    projectQuickOpen: null,
  });
}

function renderApp(): void {
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<App />));
}

// One registered project, no sessions: the shell's "projects exist but none
// are open" fixture (issues #915/#916).
const projectState = (): BackendState =>
  backendState({
    projects: [
      {
        project: {
          path: "/p",
          name: "p",
          addedAt: "t",
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
          icon: null,
        },
        sessions: [],
      },
    ],
  });

beforeEach(() => {
  compact = true;
  mediaListeners.clear();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: vi.fn(() => ({
    get matches() { return compact; },
    addEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.add(listener),
    removeEventListener: (_: string, listener: (event: MediaQueryListEvent) => void) => mediaListeners.delete(listener),
  })) });
  seed();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("compact App shell", () => {
  it("starts closed, swaps one surface, closes on tab and desktop transitions", () => {
    renderApp();
    expect(useStore.getState().compactSurface).toBeNull();
    const sessions = document.body.querySelector<HTMLButtonElement>('button .sr-only')?.parentElement as HTMLButtonElement;
    act(() => sessions.click());
    expect(useStore.getState().compactSurface).toBe("sessions");
    const inspector = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("inspector"))!;
    act(() => inspector.click());
    expect(useStore.getState().compactSurface).toBe("inspector");
    act(() => useStore.setState({ activeTabId: "pty" }));
    expect(useStore.getState().compactSurface).toBeNull();
    act(() => { useStore.getState().showCompactSurface("sessions"); compact = false; mediaListeners.forEach((listener) => listener({ matches: false } as MediaQueryListEvent)); });
    expect(useStore.getState().compactSurface).toBeNull();
  });

  it("carries the active browser pane into compact mode and restores it on tab return", () => {
    compact = false;
    useStore.setState({ rpc: { rpc: runtime({
      browserPane: { open: true, fullscreen: false, agentOpened: false, ensure: "available", unavailableReason: null, state: null, frame: null },
    }) } });
    renderApp();
    act(() => {
      compact = true;
      mediaListeners.forEach((listener) => listener({ matches: true } as MediaQueryListEvent));
    });
    expect(useStore.getState().compactSurface).toBe("browser-pane");
    act(() => useStore.setState({ activeTabId: "pty" }));
    expect(useStore.getState().compactSurface).toBeNull();
    act(() => useStore.setState({ activeTabId: "rpc" }));
    expect(useStore.getState().compactSurface).toBe("browser-pane");
  });

  it("shows aggregate inspector badges and keeps every tab mounted", () => {
    renderApp();
    expect(document.body.textContent).toContain("3");
    expect(document.body.querySelector('[data-rpc-tab="rpc"]')).not.toBeNull();
    expect(document.body.querySelector('[data-terminal-tab="pty"]')).not.toBeNull();
    expect(document.body.querySelector('[data-terminal-tab="pty"]')?.parentElement?.style.display).toBe("none");
  });

  it("is the window's drag surface with every control carved out (issue #121)", () => {
    renderApp();
    const nav = document.body.querySelector("nav")!;
    expect(nav.className).toContain("[app-region:drag]");

    // A drag region swallows every pointer event, so each control must sit
    // inside a no-drag box under the nav (SessionHud's #108 contract).
    const carvedOut = (el: HTMLElement): boolean => {
      for (let n: HTMLElement | null = el; n; n = n.parentElement) {
        if (n.classList.contains("[app-region:no-drag]")) return true;
        if (n === nav) return false;
      }
      return false;
    };
    const controls = [...nav.querySelectorAll<HTMLElement>("button")];
    expect(controls.length).toBe(3);
    for (const control of controls) expect(carvedOut(control)).toBe(true);

    // The title must not be the flex-1 box: a no-drag flex-1 would leave no
    // grabbable row at all (#108).
    const title = controls[1]!;
    expect(title.className).not.toContain("flex-1");
    expect(title.parentElement!.className).toContain("flex-1");
    expect(title.parentElement!.classList.contains("[app-region:no-drag]")).toBe(false);
  });

  it("reserves no native caption strip outside the Electron shell", () => {
    // jsdom's UA carries no `Electron/`, so this covers the remote web client:
    // a phone must not lose 132px to buttons that do not exist.
    renderApp();
    const nav = document.body.querySelector<HTMLElement>("nav")!;
    expect(nav.style.paddingLeft).toBe("");
    expect([...nav.children].some((c) => (c as HTMLElement).style.width !== "")).toBe(false);
  });
});

describe("desktop merged title bar (issues #59/#60)", () => {
  beforeEach(() => {
    compact = false;
  });

  it("packs sidebar chrome and the session HUD into one flat strip", () => {
    renderApp();
    const header = document.body.querySelector("header")!;
    expect(header.querySelector('button[aria-label="collapse sidebar"]')).not.toBeNull();
    // New session and Add project live in the sidebar header now (issue #919):
    // an expanded sidebar leaves the strip with neither.
    expect(header.querySelector('button[aria-label="add project"]')).toBeNull();
    expect(header.querySelector('button[aria-label="new session — pick a project"]')).toBeNull();
    // the rpc-ui HUD rides the same strip: its title menu
    expect(header.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
    // no noise texture — the overlay can only paint a flat colour (#59); the
    // fill is the void plane token (opaque at glass Off, ADR-0026)
    expect(header.className).not.toContain("ambient");
    expect(header.className).toContain("chrome-void");
  });

  it("reserves no native caption strip outside the Electron shell (issue #122)", () => {
    // The remote web client is served this same bundle in an ordinary browser
    // tab, where jsdom's UA (like the browser's) carries no `Electron/`: the
    // strip must run the full window width rather than park 132px of dead
    // space where native window controls would be, squeezing the HUD.
    renderApp();
    const header = document.body.querySelector<HTMLElement>("header")!;
    expect(header.style.paddingLeft).toBe("");
    expect([...header.children].some((c) => (c as HTMLElement).style.width !== "")).toBe(false);
  });

  it("shows no HUD controls for a terminal tab and toggles the sidebar from the strip", () => {
    renderApp();
    act(() => useStore.setState({ activeTabId: "pty" }));
    const header = document.body.querySelector("header")!;
    expect(header.querySelector('[aria-haspopup="menu"]')).toBeNull();
    expect(header.querySelector('button[aria-label="collapse sidebar"]')).not.toBeNull();
    act(() => (header.querySelector('button[aria-label="collapse sidebar"]') as HTMLButtonElement).click());
    expect(useStore.getState().sidebarCollapsed).toBe(true);
  });

  it("keeps the sidebar toggle with zero tabs", () => {
    useStore.setState({ tabs: [], activeTabId: null, state: projectState() });
    renderApp();
    const header = document.body.querySelector("header")!;
    expect(header.querySelector('button[aria-label="collapse sidebar"]')).not.toBeNull();
  });
});

describe("update restore surface (issue #99)", () => {
  it("shows Restoring sessions in place of Welcome, then swaps to Welcome", () => {
    useStore.setState({ tabs: [], activeTabId: null, restoringTabs: true });
    renderApp();

    expect(document.body.textContent).toContain("Restoring sessions");
    expect(document.body.textContent).not.toContain("Add project");

    act(() => useStore.setState({ restoringTabs: false }));
    expect(document.body.textContent).toContain("Add project");
  });
});

describe("new-session entry points (issues #915/#919)", () => {
  const pressModShiftN = (): void => {
    document.body.focus();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "n", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
  };

  const pressModShiftO = (): void => {
    document.body.focus();
    act(() => {
      document.body.dispatchEvent(
        new KeyboardEvent("keydown", { key: "O", ctrlKey: true, shiftKey: true, bubbles: true }),
      );
    });
  };

  // Minimal record so isChatTab classifies the focused tab as a chat.
  const chatSummary = (): SessionSummary => ({
    tabId: "chat",
    sessionId: null,
    lineageDir: "omp-ui--p--chat",
    projectCwd: "/p",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet: null,
    launchedAt: "t",
    mode: "rpc-ui",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    autoTitled: false,
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    heldPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    private: false,
    chat: true,
    askSource: null,
    cachedTitle: null,
    cachedModified: null,
    agentMode: "build",
    title: "Brainstorm",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  });

  it("opens the project quick-open with zero tabs instead of erroring", async () => {
    useStore.setState({
      tabs: [],
      activeTabId: null,
      errorNotices: [],
      state: projectState(),
    });
    const spawnSession = vi.fn();
    (backend as unknown as Record<string, unknown>).spawnSession = spawnSession;
    renderApp();
    pressModShiftN();
    await act(async () => {});

    expect(spawnSession).not.toHaveBeenCalled();
    // The issue #789 noCurrentSession notice is gone: the overlay replaced the
    // error path, so nothing lands in the notices wall.
    expect(useStore.getState().errorNotices).toEqual([]);
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
  });

  it("shows the title-bar New session only while the sidebar is collapsed", () => {
    compact = false;
    useStore.setState({ tabs: [], activeTabId: null, state: projectState() });
    renderApp();
    const header = document.body.querySelector("header")!;
    const newSession = (): HTMLButtonElement | null =>
      header.querySelector<HTMLButtonElement>('button[aria-label="new session — pick a project"]');
    // Expanded: the sidebar header carries the one New session button.
    expect(newSession()).toBeNull();

    act(() => useStore.setState({ sidebarCollapsed: true }));
    // Collapsed: it sits right after the toggle and opens the overlay.
    const toggle = header.querySelector<HTMLButtonElement>('button[aria-label="expand sidebar"]')!;
    expect(toggle.nextElementSibling).toBe(newSession());
    act(() => newSession()!.click());
    expect(useStore.getState().projectQuickOpen).not.toBeNull();

    act(() => useStore.setState({ sidebarCollapsed: false, projectQuickOpen: null }));
    expect(newSession()).toBeNull();
  });

  it("opens the overlay for a focused project tab instead of spawning", async () => {
    const spawnSession = vi.fn();
    (backend as unknown as Record<string, unknown>).spawnSession = spawnSession;
    renderApp();
    pressModShiftN();
    await act(async () => {});

    expect(spawnSession).not.toHaveBeenCalled();
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
  });

  it("opens the quick-open on a chat tab instead of spawning a chat inline", async () => {
    // The quick-open orders No project first for a focused chat, so a bare
    // Enter there still starts another chat; the key itself never spawns.
    const chat: SessionSummary = { ...chatSummary(), tabId: "chat" };
    const newChat = vi.fn(async () => "fresh-chat");
    useStore.setState({
      state: backendState({ chats: [chat] }),
      tabs: [
        { tabId: "rpc", mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null },
        { tabId: "pty", mode: "pty", projectCwd: "/p", hidden: false, instanceId: null },
        { tabId: "chat", mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null },
      ],
      activeTabId: "chat",
      newChat,
    });
    const spawnSession = vi.fn();
    (backend as unknown as Record<string, unknown>).spawnSession = spawnSession;
    renderApp();
    pressModShiftN();
    await act(async () => {});

    expect(newChat).not.toHaveBeenCalled();
    expect(spawnSession).not.toHaveBeenCalled();
    expect(useStore.getState().projectQuickOpen).not.toBeNull();
  });

  it("mod+shift+o starts a chat from a project tab without the quick-open (issue #962)", async () => {
    const newChat = vi.fn(async () => "fresh-chat");
    useStore.setState({ newChat });
    renderApp();
    pressModShiftO();
    await act(async () => {});

    expect(newChat).toHaveBeenCalledExactlyOnceWith();
    expect(useStore.getState().projectQuickOpen).toBeNull();
  });

  it("mod+o opens the New session dialog seeded with the focused tab, mid-draft (issue #964)", () => {
    useStore.setState({
      tabs: [{ tabId: "remote", mode: "rpc-ui", projectCwd: "/srv/p", hidden: false, instanceId: "inst-1" }],
      activeTabId: "remote",
      newSessionDialog: null,
    });
    renderApp();
    // A composer draft holds focus: a mod combo still reaches the window map.
    const draft = document.createElement("textarea");
    document.body.append(draft);
    draft.focus();
    act(() => {
      draft.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true }));
    });

    expect(useStore.getState().newSessionDialog).toMatchObject({ projectCwd: "/srv/p", instanceId: "inst-1", where: "here" });
    expect(useStore.getState().projectQuickOpen).toBeNull();
    draft.remove();
  });
});

describe("always-mounted sidebar (issue #919)", () => {
  beforeEach(() => {
    compact = false;
  });

  it("mounts the sidebar beside Welcome with zero tabs", () => {
    useStore.setState({ tabs: [], activeTabId: null, state: projectState() });
    renderApp();
    expect(document.body.querySelector("aside")).not.toBeNull();
    // Welcome still fills the empty canvas.
    expect(document.body.textContent).toContain("Add project");
    expect(document.body.textContent).toContain("No sessions open");
  });

  it("keeps the sidebar mounted when every tab is hidden", () => {
    useStore.setState({
      state: projectState(),
      tabs: [
        { tabId: "rpc", mode: "rpc-ui", projectCwd: "/p", hidden: true, instanceId: null },
        { tabId: "pty", mode: "pty", projectCwd: "/p", hidden: true, instanceId: null },
      ],
    });
    renderApp();
    expect(document.body.querySelector("aside")).not.toBeNull();
  });
});

// issue #926: a settle (process exit, hibernation) hides its tab in one
// commit, so the canvas falls back to Welcome instead of parking the user
// on the exit card; the card only resurfaces via openSession.
describe("settled sessions leave the canvas (issue #926)", () => {
  beforeEach(() => {
    compact = false;
  });

  it("renders Welcome with no exit card when the last visible tab settles", () => {
    useStore.setState({
      state: projectState(),
      tabs: [{ tabId: "rpc", mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null }],
      activeTabId: "rpc",
    });
    renderApp();

    // The real settle boundary: init wires main's onPtyExit and
    // onSessionHibernated straight onto this store action, so calling it is
    // the same commit the dead gates fire.
    act(() => (useStore.getState() as UiStore & LifecycleSlice).teardownProcess("rpc", 0));

    expect(useStore.getState().tabs.find((t) => t.tabId === "rpc")?.hidden).toBe(true);
    expect(useStore.getState().activeTabId).toBeNull();
    // Welcome fills the canvas (the zero-tab contract, #919)…
    expect(document.body.textContent).toContain("Add project");
    expect(document.body.textContent).toContain("No sessions open");
    // …and the exit card never reaches it.
    expect(document.body.textContent).not.toContain("Agent exited");
  });
});
