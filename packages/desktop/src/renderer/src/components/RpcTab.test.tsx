// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import { backendState, rpcTabState } from "../test/fixtures";
import type { RpcFailure } from "../store/types";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.scrollIntoView = vi.fn();
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
(globalThis as Record<string, unknown>).ResizeObserver = ResizeObserverStub;

const backendMock = {
  rpcSend: vi.fn(),
  listProjectFiles: vi.fn(async () => ({ files: [], truncated: false })),
  resolveFileMentions: vi.fn(async () => ({ contextText: "", images: [] })),
  listBranches: vi.fn(async () => ({
    repoRoot: null, current: null, branches: [], defaultBranch: null,
    upstreamRef: null, upstreamRemote: null, hasUpstream: false,
    ahead: 0, behind: 0, upstreamFetchedAt: null, upstreamRefreshError: null,
  })),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setSessionAdvisor: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });

// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { RpcTab } = await import("./RpcTab");

const TAB = "tab-rpctab";
let root: Root | null = null;

const state = backendState({
  projects: [{
    project: { path: "/p", name: "P", addedAt: "t", lastModel: null, lastAdvisorModel: null },
    sessions: [{
      tabId: TAB, sessionId: "s", lineageDir: "lineage", projectCwd: "/p", launchedAt: "t",
      mode: "rpc-ui", advisor: false, advisorModel: null, cachedTitle: "T",
      cachedModified: "t", title: "T", status: "complete", live: "live", pendingPlan: null, planSettle: null,
    }],
  }],
});

const MAIN_ITEMS = [
  { kind: "assistant" as const, id: "a1", text: "main transcript", thinking: "", streaming: false },
];
const SUB_ITEMS = [
  { kind: "assistant" as const, id: "s1", text: "sub transcript", thinking: "", streaming: false },
];

function seed(selectedSubagent: string | null): void {
  useStore.setState({
    advisorDefaults: {},
    state,
    exited: {},
    branches: {
      "/p": {
        repoRoot: null, current: null, branches: [], defaultBranch: null,
        upstreamRef: null, upstreamRemote: null, hasUpstream: false,
        ahead: 0, behind: 0, upstreamFetchedAt: null, upstreamRefreshError: null,
      },
    },
    rpc: {
      [TAB]: rpcTabState({
        status: "ready",
        hasRenamed: true,
        model: { id: "model-x", name: "Model X", provider: "test", input: ["text"], contextWindow: 1000 },
        session: { ...emptySessionRuntime(), thinkingLevel: "medium" },
        items: MAIN_ITEMS,
        subagents: [{ id: "agent-1", name: "worker", agent: "task", status: "running" }],
        selectedSubagent,
        subagentItems: { "agent-1": SUB_ITEMS },
      }),
    },
    compactSurface: null,
    sendPrompt: vi.fn(async () => {}),
    abortAndPrompt: vi.fn(async () => {}),
    abortAgent: vi.fn(async () => {}),
  });
}

function seedExited(failure?: RpcFailure): void {
  seed(null);
  useStore.setState((current) => {
    const tab = { ...current.rpc[TAB]! };
    if (failure) tab.failure = failure;
    else delete tab.failure;
    return {
      exited: { [TAB]: -1 },
      rpc: { ...current.rpc, [TAB]: tab },
    };
  });
}

function renderTab(): void {
  const host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() => root!.render(<RpcTab tabId={TAB} active={false} />));
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  document.body.innerHTML = "";
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
});

describe("RpcTab subagent view", () => {
  it("swaps the main column to the read-only subagent view while selected", () => {
    seed("agent-1");
    renderTab();
    expect(document.body.textContent).toContain("sub transcript");
    expect(document.body.textContent).toContain("read-only subagent view");
    expect(document.body.textContent).not.toContain("main transcript");
    // No composer: a subagent cannot be prompted or steered.
    expect(document.body.querySelector("textarea")).toBeNull();
  });

  it("returns to the main transcript and composer on exit", () => {
    seed("agent-1");
    renderTab();
    const back = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="back to main agent"]',
    )!;
    act(() => back.click());
    expect(document.body.textContent).toContain("main transcript");
    expect(document.body.querySelector("textarea")).not.toBeNull();
  });

  it("renders the main transcript when no subagent is selected", () => {
    seed(null);
    renderTab();
    expect(document.body.textContent).toContain("main transcript");
    expect(document.body.textContent).not.toContain("read-only subagent view");
  });
});

describe("RpcTab exit overlay", () => {
  it("surfaces a fatal process failure once with recovery and copy actions", () => {
    const message = "omp did not speak rpc-ui (no ready frame in 10 s); stderr: (empty)";
    seedExited({
      message,
      kind: "process",
      fatal: true,
      sessionStatus: "error",
      recovery: "The live session process stopped. Resume the session to continue.",
    });
    renderTab();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Agent exited");
    expect(text).toContain("exit -1");
    expect(text.match(new RegExp(message.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"))).toHaveLength(1);
    expect(text).toContain("The live session process stopped. Resume the session to continue.");
    expect(text).toContain("Copy");
    expect(text).toContain("resume session");
  });

  it("keeps the compact exit fallback when no process failure was captured", () => {
    seedExited();
    renderTab();

    const text = document.body.textContent ?? "";
    expect(text).toContain("Agent exited");
    expect(text).toContain("exit -1");
    expect(text).toContain("resume session");
    expect(text).not.toContain("The live session process stopped");
    expect(text).not.toContain("Copy");
  });
});
