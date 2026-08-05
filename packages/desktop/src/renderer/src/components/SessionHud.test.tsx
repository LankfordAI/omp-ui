// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BackendState } from "@omp-ui/core/types";
import { emptySessionRuntime } from "../lib/rpc-types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
Object.assign(window, { ompBackend: {} });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { SessionHud } = await import("./SessionHud");

const TAB = "tab-mobile";
const compactSession = vi.fn(async () => {});
const exportHtml = vi.fn(async () => {});
const branchSession = vi.fn(async () => {});
const toggleConsole = vi.fn();
let root: Root | null = null;

const state = {
  defaultMode: "rpc-ui", modelFavorites: [], skipDeleteConfirmation: false, themeId: "graphite",
  appUpdateCheckOnLaunch: true, ompUpdateCheckOnLaunch: true,
  dismissedAppUpdateVersion: null, dismissedOmpUpdateVersion: null,
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastAdvisorModel: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t",
    mode: "rpc-ui", advisor: false, advisorModel: null, cachedTitle: "Mobile session",
    cachedModified: "t", title: "Mobile session", status: "complete", live: "live",
  }] }],
} as BackendState;

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.clearAllMocks();
  useStore.setState({
    state,
    rpc: { [TAB]: { status: "ready", items: [], todos: [], model: null, availableModels: [], commands: [],
      session: { ...emptySessionRuntime(), contextUsage: { tokens: 20, contextWindow: 100, percent: 20 } },
      stats: null, subagents: [], extensionStatus: { advisor: "available" }, pendingCommands: new Map(), extensionQueue: [], busy: false,
      initialPrompt: null, hasRenamed: true, plan: { enabled: true, planFilePath: "/plan.md", planAbsPath: "/plan.md", approved: false }, planReview: null,
      planText: null, planDeferred: false, plans: [], advisorStats: null },
    },
    compactSurface: null,
    compactSession, exportHtml, branchSession, toggleConsole,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("compact Session HUD", () => {
  it("keeps the console control directly in the HUD and toggles this tab", () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const consoleToggles = document.body.querySelectorAll<HTMLButtonElement>('button[aria-label="toggle console (mod+j)"]');
    expect(consoleToggles).toHaveLength(1);
    const consoleToggle = consoleToggles[0]!;
    expect(consoleToggle.closest("header")).not.toBeNull();
    expect(useStore.getState().compactSurface).toBeNull();
    act(() => consoleToggle.click());
    expect(toggleConsole).toHaveBeenCalledWith(TAB);
  });

  it("keeps displaced actions reachable and passes the same tab id", () => {
    const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
    act(() => root!.render(<SessionHud tabId={TAB} />));
    const actions = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.includes("session actions"))!;
    act(() => actions.click());
    for (const label of ["plan", "compact", "auto-compact", "export", "MCP", "branch", "new", "refresh", "steering", "follow-up", "interrupt", "auto-retry", "abort retry"]) {
      expect(document.body.textContent).toContain(label);
    }
    const compact = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "compact")!;
    const exportButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "export")!;
    const branch = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "branch")!;
    act(() => { compact.click(); exportButton.click(); branch.click(); });
    expect(compactSession).toHaveBeenCalledWith(TAB);
    expect(exportHtml).toHaveBeenCalledWith(TAB);
    expect(branchSession).toHaveBeenCalledWith(TAB);
  });
});
