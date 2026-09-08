// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backendState, tabInfo } from "../test/fixtures";

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
  planImplementationSource: null,
  agentMode: "build" as const,
  compactionMethod: null,
  model: null,
  thinkingLevel: null,
  advisor: false,
  advisorModel: null,
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
    expect(useStore.getState().capabilitiesViewer).toEqual({ scopeCwd: null, section: "mcp" });
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
    });
  });

  it("pins nothing for a terminal tab — its TUI shows the roster itself", () => {
    renderWithTab("pty");
    expect(document.body.textContent).toContain("View capabilities");
    expect(document.body.textContent).not.toContain("Capabilities for this session");
  });
});
