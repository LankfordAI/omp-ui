// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList } from "@omp-ui/core/types";
import { backendState, rpcTabState } from "../test/fixtures";
import { emptySessionRuntime } from "../lib/rpc-types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const OFF_REPO: BranchList = {
  repoRoot: null,
  current: null,
  branches: [],
  defaultBranch: null,
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
};

const backendMock = {
  listBranches: vi.fn(async (): Promise<BranchList> => OFF_REPO),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic import is required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { ComposerSheet } = await import("./ComposerSheet");

const TAB = "tab-sheet";
const state = backendState({
  projects: [{ project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null }, sessions: [{
    tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t", mode: "rpc-ui",
    worktree: null, planImplementationSource: null, agentMode: "build", compactionMethod: null, model: null, thinkingLevel: null, lastViewedAt: null, advisor: false, advisorModel: null, cachedTitle: "Sheet", cachedModified: "t", title: "Sheet", status: "complete", live: "live", pendingPlan: null, planSettle: null, streamStalled: false,
  }] }],
});

const setThinkingLevel = vi.fn(async () => {});
const sendPrompt = vi.fn(async () => true);
const abortAgent = vi.fn(async () => {});
let onSubmitRoute: (route: string) => void;
let onClose: () => void;
let root: Root | null = null;

function seed(status: "ready" | "running"): void {
  useStore.setState({
    advisorDefaults: {},
    state,
    branches: { "/p": OFF_REPO },
    rpc: { [TAB]: rpcTabState({
      status,
      model: {
        id: "model-x",
        name: "Model X",
        provider: "test",
        input: ["text"],
        contextWindow: 1000,
        thinking: { efforts: ["low", "medium", "high"] },
      },
      session: { ...emptySessionRuntime(), thinkingLevel: "medium", queuedMessageCount: 2 },
      hasRenamed: true,
    }) },
    compactSurface: "composer-options",
    sendPrompt,
    abortAgent,
    setThinkingLevel,
  });
}

function render(open = true): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <ComposerSheet
        open={open}
        onClose={onClose}
        tabId={TAB}
        projectCwd="/p"
        unavailable={false}
        canSend={true}
        onSubmit={(route) => onSubmitRoute(route)}
      />,
    ),
  );
}

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  vi.clearAllMocks();
  onSubmitRoute = vi.fn();
  onClose = vi.fn();
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

describe("ComposerSheet", () => {
  it("stays unmounted while closed", () => {
    seed("ready");
    render(false);
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("opens with the model, the effort grid, and the session section", () => {
    seed("ready");
    render(true);
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog).not.toBeNull();
    expect(dialog.textContent).toContain("model & effort");
    expect(dialog.textContent).toContain("model-x");
    for (const effort of ["low", "medium", "high"]) {
      expect(dialog.textContent).toContain(effort);
    }
    expect(dialog.textContent).toContain("session");
    expect(dialog.textContent).toContain("branch");
    // Idle, so the parked items are labeled parked, not queued.
    expect(dialog.textContent).toContain("parked: 2");
  });

  it("clicking an effort fires the set_thinking_level path through the store", async () => {
    seed("ready");
    render(true);
    const effort = buttonByText("high");
    await act(async () => effort.click());
    expect(setThinkingLevel).toHaveBeenCalledWith(TAB, "high");
  });

  it("hides the while-running section while idle", () => {
    seed("ready");
    render(true);
    expect(document.body.textContent).not.toContain("while running");
    expect(
      [...document.querySelectorAll<HTMLButtonElement>("button")].some(
        (button) => button.textContent === "Queue",
      ),
    ).toBe(false);
  });

  it("offers Queue and Interrupt-and-send while running, routing to their verbs", async () => {
    seed("running");
    render(true);
    expect(document.body.textContent).toContain("while running");
    const queue = buttonByText("Queue");
    const interrupt = buttonByText("Interrupt-and-send");
    await act(async () => queue.click());
    expect(onSubmitRoute).toHaveBeenCalledWith("follow_up");
    await act(async () => interrupt.click());
    expect(onSubmitRoute).toHaveBeenCalledWith("interrupt");
  });

  it("the sheet close control calls onClose", () => {
    seed("ready");
    render(true);
    const close = document.querySelector<HTMLButtonElement>('button[aria-label="close prompt options"]')!;
    expect(close).not.toBeNull();
    act(() => close.click());
    expect(onClose).toHaveBeenCalledOnce();
  });
});
