// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "./lib/rpc-types";
import type { RpcTabState } from "./store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });

vi.mock("./components/Sidebar", () => ({ Sidebar: () => null }));
vi.mock("./components/RpcTab", () => ({ RpcTab: ({ tabId }: { tabId: string }) => <div data-rpc-tab={tabId} /> }));
vi.mock("./components/TerminalTab", () => ({ TerminalTab: ({ tabId }: { tabId: string }) => <div data-terminal-tab={tabId} /> }));
vi.mock("./components/CommandPalette", () => ({ CommandPalette: () => null, openPalette: vi.fn() }));
vi.mock("./components/AppUpdateCard", () => ({ AppUpdateCard: () => null }));
vi.mock("./components/OmpUpdateCard", () => ({ OmpUpdateCard: () => null }));
vi.mock("./components/DeleteSessionDialog", () => ({ DeleteSessionDialog: () => null }));
vi.mock("./components/ProjectPicker", () => ({ ProjectPicker: () => null }));
vi.mock("./components/McpManager", () => ({ McpManager: () => null }));
vi.mock("./components/Settings", () => ({ Settings: () => null }));

const { useStore } = await import("./store");
const { default: App } = await import("./App");

let compact = true;
const mediaListeners = new Set<(event: MediaQueryListEvent) => void>();
let root: Root | null = null;

function runtime(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready", items: [], todos: [], model: null, availableModels: [], commands: [],
    session: emptySessionRuntime(), stats: null, subagents: [], extensionStatus: {},
    pendingCommands: new Map(), extensionQueue: [], busy: false, initialPrompt: null,
    hasRenamed: true, plan: null, planReview: null, planText: null, planHtml: null, planDeferred: false,
    plans: [], advisorStats: null, advisorReply: true, ...patch,
  };
}

function seed(): void {
  useStore.setState({
    init: vi.fn(async () => {}),
    state: null,
    tabs: [
      { tabId: "rpc", mode: "rpc-ui", projectCwd: "/p", hidden: false },
      { tabId: "pty", mode: "pty", projectCwd: "/p", hidden: false },
    ],
    activeTabId: "rpc",
    focusedTabByProject: {},
    restoringTabs: false,
    rpc: { rpc: runtime({
      todos: [{ phase: "work", tasks: [{ content: "open", status: "pending" }] }],
      subagents: [{ id: "agent-1", name: "worker", status: "working" }],
      planReview: { request: { title: "Plan", planFilePath: "local://plan.md", planAbsPath: "/plan.md" }, frame: { id: "p" } },
    }) },
    compactSurface: null,
    sidebarCollapsed: false,
  });
}

function renderApp(): void {
  const host = document.createElement("div");
  host.id = "root";
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<App />));
}

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

  it("shows aggregate inspector badges and keeps every tab mounted", () => {
    renderApp();
    expect(document.body.textContent).toContain("3");
    expect(document.body.querySelector('[data-rpc-tab="rpc"]')).not.toBeNull();
    expect(document.body.querySelector('[data-terminal-tab="pty"]')).not.toBeNull();
    expect(document.body.querySelector('[data-terminal-tab="pty"]')?.parentElement?.style.display).toBe("none");
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
    expect(header.querySelector('button[aria-label="add project"]')).not.toBeNull();
    expect(header.querySelector('button[aria-label="new session in current project"]')).not.toBeNull();
    // the rpc-ui HUD rides the same strip
    expect(header.querySelector('button[aria-label^="branch this session"]')).not.toBeNull();
    // flat bg, no noise texture — the overlay can only paint a flat colour (#59)
    expect(header.className).not.toContain("ambient");
    expect(header.className).toContain("bg-void");
  });

  it("shows no HUD controls for a terminal tab and toggles the sidebar from the strip", () => {
    renderApp();
    act(() => useStore.setState({ activeTabId: "pty" }));
    const header = document.body.querySelector("header")!;
    expect(header.querySelector('button[aria-label="branch this session"]')).toBeNull();
    expect(header.querySelector('button[aria-label="collapse sidebar"]')).not.toBeNull();
    act(() => (header.querySelector('button[aria-label="collapse sidebar"]') as HTMLButtonElement).click());
    expect(useStore.getState().sidebarCollapsed).toBe(true);
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
