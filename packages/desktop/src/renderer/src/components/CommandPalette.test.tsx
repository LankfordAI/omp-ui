// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SessionSummary } from "@omp-ui/core/types";
import { backendState, remoteInstance, rpcTabState, tabInfo } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { CommandPalette, openPalette } = await import("./CommandPalette");

const originalMatchMedia = window.matchMedia;
let root: Root | null = null;

function renderPalette(compact: boolean): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: compact, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  useStore.setState({ state: null, tabs: [], activeTabId: null, projectPickerOpen: false });
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<CommandPalette />));
  act(() => openPalette());
}

function paletteInput(): HTMLInputElement {
  const found = document.body.querySelector<HTMLInputElement>('[role="dialog"] input');
  expect(found).not.toBeNull();
  return found!;
}

function typeQuery(value: string): void {
  const field = paletteInput();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(field, value);
    field.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function pressPalette(key: string, init: KeyboardEventInit = {}): void {
  act(() => {
    paletteInput().dispatchEvent(
      new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }),
    );
  });
}

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  if (originalMatchMedia === undefined) Reflect.deleteProperty(window, "matchMedia");
  else Object.defineProperty(window, "matchMedia", { configurable: true, value: originalMatchMedia });
});

describe("CommandPalette close controls", () => {
  it("keeps the Escape hint on desktop", () => {
    renderPalette(false);
    expect(document.body.textContent).toContain("Esc");
  });

  it("uses only the visible close control in compact mode", () => {
    renderPalette(true);
    expect(document.body.textContent).not.toContain("Esc");
    expect(document.body.querySelector('button[aria-label="close dialog"]')).not.toBeNull();
  });

  it("keeps empty results safe and closes them through the shared engine", () => {
    renderPalette(false);
    typeQuery("zzzzzzzzzz");
    expect(document.body.textContent).toContain("Nothing matches");

    pressPalette("ArrowDown");
    pressPalette("ArrowUp");
    pressPalette("n", { ctrlKey: true });
    pressPalette("p", { ctrlKey: true });
    pressPalette("Enter");
    expect(document.body.querySelector('[role="dialog"]')).not.toBeNull();

    pressPalette("Escape");
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("picks a filtered action with Enter", () => {
    renderPalette(false);
    typeQuery("Add project");
    pressPalette("Enter");
    expect(useStore.getState().projectPickerOpen).toBe(true);
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens the diagnostic bundle dialog (issue #413)", () => {
    renderPalette(false);
    typeQuery("diagnostic");
    pressPalette("Enter");
    expect(useStore.getState().diagnosticsDialogOpen).toBe(true);
    useStore.setState({ diagnosticsDialogOpen: false });
    expect(document.body.querySelector('[role="dialog"]')).toBeNull();
  });
});

const CWD_RECORD = {
  tabId: "tab-1",
  sessionId: "s1",
  lineageDir: "omp-ui--p--s1",
  projectCwd: "/p",
  launchedAt: "t",
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
 settledAtMs: null,
 heldPrompt: null,
 scheduledPrompt: null,
 pullRequests: [],
 autoSettleOnMerge: null,
 private: false,
 chat: false,
 askSource: null,
  cachedTitle: "T",
  cachedModified: "t",
  title: "T",
  status: "complete" as const,
  live: "live" as const,
  pendingPlan: null,
  planSettle: null,
  streamStalled: false,
};

describe("CommandPalette capabilities actions (issue #383)", () => {
  function renderWithTab(mode: "rpc-ui" | "pty"): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({
      projectPickerOpen: false,
      state: backendState({
        defaultAdvisor: false,
        projects: [
          {
            project: {
              path: "/p",
              name: "P",
              addedAt: "t",
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
            sessions: [{ ...CWD_RECORD, mode: "rpc-ui" }],
          },
        ],
      }),
      tabs: [tabInfo({ tabId: "tab-1", mode })],
      activeTabId: "tab-1",
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CommandPalette />));
    act(() => openPalette());
  }

  function runVisible(needle: string): void {
    typeQuery(needle);
    pressPalette("Enter");
  }

  it("offers the global viewer with no session at all", () => {
    renderPalette(false);
    expect(document.body.textContent).toContain("View capabilities");
    // No live session exists, so the pinned variant cannot be offered.
    expect(document.body.textContent).not.toContain("Capabilities for this session");
    runVisible("View capabilities");
    expect(useStore.getState().capabilitiesViewer).toEqual({ scopeCwd: null, section: "mcp", instanceId: null });
  });

  it("offers the pinned session action for a native tab, global untouched", () => {
    renderWithTab("rpc-ui");
    expect(document.body.textContent).toContain("View capabilities");
    expect(document.body.textContent).toContain("Capabilities for this session");
    runVisible("Capabilities for this session");
    expect(useStore.getState().capabilitiesViewer).toEqual({
      scopeCwd: "/p",
      tabId: "tab-1",
      section: "mcp",
      instanceId: null,
    });
  });

  it("pins nothing for a terminal tab — its TUI shows the roster itself", () => {
    renderWithTab("pty");
    expect(document.body.textContent).toContain("View capabilities");
    expect(document.body.textContent).not.toContain("Capabilities for this session");
  });
});

describe("CommandPalette share action (issue #679)", () => {
  function renderWithTab(mode: "rpc-ui" | "pty"): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({
      projectPickerOpen: false,
      shareConfirmTab: null,
      state: backendState({
        defaultAdvisor: false,
        projects: [
          {
            project: {
              path: "/p",
              name: "P",
              addedAt: "t",
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
            sessions: [{ ...CWD_RECORD, mode: "rpc-ui" }],
          },
        ],
      }),
      tabs: [tabInfo({ tabId: "tab-1", mode })],
      activeTabId: "tab-1",
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CommandPalette />));
    act(() => openPalette());
  }

  it("runs shareSession for a native tab", () => {
    const shareSession = vi.fn(async () => {});
    useStore.setState({ shareSession });
    renderWithTab("rpc-ui");
    expect(document.body.textContent).toContain("Share session");
    typeQuery("Share session");
    pressPalette("Enter");
    expect(shareSession).toHaveBeenCalledWith("tab-1");
  });

  it("offers no share row for a terminal tab — its TUI owns /share", () => {
    renderWithTab("pty");
    expect(document.body.textContent).not.toContain("Share session");
  });
});

describe("CommandPalette ask action (issue #895)", () => {
  const project = {
    project: {
      path: "/p",
      name: "P",
      addedAt: "t",
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
    sessions: [CWD_RECORD],
  };
  function renderWithOwner(instanceId: string | null): void {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({
      projectPickerOpen: false,
      state: backendState(
        instanceId === null
          ? { projects: [project] }
          : { projects: [], remoteInstances: [remoteInstance({ id: instanceId, projects: [project] })] },
      ),
      tabs: [tabInfo({ tabId: "tab-1", mode: "rpc-ui", instanceId })],
      activeTabId: "tab-1",
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CommandPalette />));
    act(() => openPalette());
  }

  it("asks about the active local session", () => {
    const askAboutSession = vi.fn(async () => {});
    useStore.setState({ askAboutSession });
    renderWithOwner(null);
    expect(document.body.textContent).toContain("T — a new chat with its summary pinned");
    typeQuery("Ask about this session");
    pressPalette("Enter");
    expect(askAboutSession).toHaveBeenCalledWith("tab-1");
  });

  it("offers no ask row for a session owned by another instance", () => {
    renderWithOwner("inst-1");
    expect(document.body.textContent).not.toContain("Ask about this session");
  });
});

describe("CommandPalette session ranking (round-10 judge, Clarity 2)", () => {
  const project = (path: string, name: string, sessions: SessionSummary[]) => ({
    project: {
      path,
      name,
      addedAt: "t",
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
    sessions,
  });

  function renderRanked(): string[] {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    const host = document.createElement("div");
    document.body.append(host);
    root = createRoot(host);
    act(() => root!.render(<CommandPalette />));
    act(() => openPalette());
    return [...document.body.querySelectorAll<HTMLElement>("[role='dialog'] button")].map(
      (button) => button.textContent ?? "",
    );
  }

  it("ranks attention, then working, above settled rows of other projects", () => {
    // The judge run's failure: the sidebar showed FIX Beacon reconnect as
    // working while the palette listed it after 14 settled tidepool rows.
    const olderSettled = {
      ...CWD_RECORD,
      tabId: "tab-settled-1",
      launchedAt: "2026-11-01T10:00:00.000Z",
      title: "Beacon reconnect study",
      live: "dormant" as const,
    };
    const newestSettled = {
      ...CWD_RECORD,
      tabId: "tab-settled-2",
      launchedAt: "2026-11-03T10:00:00.000Z",
      title: "Compaction audit",
      live: "dormant" as const,
    };
    const worker = {
      ...CWD_RECORD,
      tabId: "tab-worker",
      sessionId: "s-worker",
      lineageDir: "omp-ui--q--s-worker",
      launchedAt: "2026-11-02T10:00:00.000Z",
      title: "Keyboard shortcuts audit",
      turnRunning: true,
    };
    const marked = {
      ...CWD_RECORD,
      tabId: "tab-marked",
      sessionId: "s-marked",
      lineageDir: "omp-ui--q--s-marked",
      launchedAt: "2026-11-02T09:00:00.000Z",
      title: "Reply waiting",
    };
    useStore.setState({
      projectPickerOpen: false,
      unread: { "tab-marked": { atMs: 1_730_000_000_000, snippet: "done" } },
      // The marked row is an idle native tab: its host-side face is `ready`,
      // which the attention mark promotes to the stack's rank.
      rpc: { "tab-marked": rpcTabState() },
      state: backendState({
        projects: [
          project("/tidepool", "tidepool", [olderSettled, newestSettled]),
          project("/lighthouse", "lighthouse", [worker, marked]),
        ],
      }),
    });
    const titles = renderRanked();
    const indexOf = (title: string): number => titles.findIndex((text) => text.includes(title));
    // Attention first (marked + ready), then working, then settled — even
    // though both live sessions opened before the newest settled row.
    expect(indexOf("Reply waiting")).toBeLessThan(indexOf("Keyboard shortcuts audit"));
    expect(indexOf("Keyboard shortcuts audit")).toBeLessThan(indexOf("Compaction audit"));
    expect(indexOf("Compaction audit")).toBeLessThan(indexOf("Beacon reconnect study"));
    useStore.setState({ unread: {}, rpc: {} });
  });

  it("opens the top-ranked live session with Ctrl+K then Enter", () => {
    const openSession = vi.fn(async () => {});
    const settled = {
      ...CWD_RECORD,
      tabId: "tab-settled",
      launchedAt: "2026-11-03T10:00:00.000Z",
      title: "Settled old work",
      live: "dormant" as const,
    };
    const worker = {
      ...CWD_RECORD,
      tabId: "tab-live",
      sessionId: "s-live",
      lineageDir: "omp-ui--q--s-live",
      launchedAt: "2026-11-02T10:00:00.000Z",
      title: "Live hillclimb",
      turnRunning: true,
    };
    useStore.setState({
      projectPickerOpen: false,
      openSession,
      state: backendState({
        projects: [project("/tidepool", "tidepool", [settled]), project("/omp-ui", "omp-ui", [worker])],
      }),
    });
    renderRanked();
    pressPalette("Enter");
    expect(openSession).toHaveBeenCalledWith("tab-live");
  });
});
