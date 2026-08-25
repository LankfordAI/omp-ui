// @vitest-environment jsdom
import type { BranchDiff } from "@omp-ui/core/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { emptySessionRuntime } from "../lib/rpc-types";
import type { RpcTabState } from "../store";
import { backendState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
HTMLElement.prototype.setPointerCapture = vi.fn();

function resizePointer(type: string, x: number): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}
const backendMock = {
  rpcSend: vi.fn(),
  getBranchDiff: vi.fn(),
};
Object.assign(window, { ompBackend: backendMock });

// Dynamic imports are required because store.ts captures window.ompBackend at module evaluation.
const { useStore } = await import("../store");
const { InspectorRail } = await import("./InspectorRail");

const TAB = "tab-inspector";
let root: Root | null = null;
const PROJECT = "/projects/alpha";
const OTHER_PROJECT = "/projects/beta";
const state = backendState({
  projects: [
    {
      project: {
        path: PROJECT,
        name: "Alpha",
        addedAt: "t",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
      sessions: [
        {
          tabId: TAB,
          sessionId: "session-inspector",
          lineageDir: "omp-ui--alpha--session-inspector",
          projectCwd: PROJECT,
          launchedAt: "t",
          mode: "rpc-ui",
worktree: null,
          planImplementationSource: null,
          agentMode: "build",
          compactionMethod: null,
          model: null,
          thinkingLevel: null,
          lastViewedAt: null,
          advisor: false,
          advisorModel: null,
          cachedTitle: "Inspect",
          cachedModified: "t",
          title: "Inspect",
          status: "complete",
          live: "live",
          pendingPlan: null,
          planSettle: null,
              streamStalled: false,
        },
      ],
    },
  ],
});
const WORKTREE_PATH = "/worktrees/alpha/omp-feature";
/** Same session, but running in a dedicated worktree cut from main. */
const worktreeState = backendState({
  projects: [
    {
      ...state.projects[0]!,
      sessions: state.projects[0]!.sessions.map((s) => ({
        ...s,
        worktree: { path: WORKTREE_PATH, branch: "omp/feature", base: "main" },
      })),
    },
  ],
});

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

function diffResult(
  branch: string,
  path: string,
  text: string,
  mergeBase: string | null = null,
): BranchDiff {
  return {
    branch,
    repoRoot: PROJECT,
    diff: "",
    untracked: [{ path, text, binary: false }],
    mergeBase,
  };
}

function runtime(patch: Partial<RpcTabState> = {}): RpcTabState {
  return {
    status: "ready",
    items: [],
    todos: [{ phase: "work", tasks: [{ content: "First task", status: "pending" }] }],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [{ id: "agent-1", name: "worker", status: "working" }],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    autoTitleSent: null,
    hasRenamed: true,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    mcpStatus: null,
    advisorReply: true,
    ...patch,
  };
}

function renderRail(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<InspectorRail tabId={TAB} />));
}

function button(label: string): HTMLButtonElement | null {
  return document.body.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
}

/** A feature icon on the strip: aria-label, with any badge count in the title. */
function railTab(label: string): HTMLButtonElement | null {
  return (
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (b) =>
        b.getAttribute("aria-label") === label ||
        b.title === label ||
        b.title.startsWith(`${label} (`),
    ) ?? null
  );
}

beforeEach(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  });
  backendMock.getBranchDiff.mockReset();
  useStore.setState({
    state: null,
    branches: {},
    branchDiffRevision: {},
    rpc: { [TAB]: runtime() },
    compactSurface: null,
    sidebarCollapsed: false,
    sidebarWidth: 272,
    inspectorWidth: 304,
    inspectorOpen: false,
  });
});

afterEach(() => {
  if (root) act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
});

describe("desktop InspectorRail", () => {
  it("stays an icon strip and opens one pane at a time from it (issues #48, #75)", () => {
    renderRail();

    // The strip is the whole rail: feature icons with badges, no expand control.
    expect(button("expand inspector")).toBeNull();
    for (const label of ["todos", "agents", "session", "plans", "diffs"]) {
      expect(button(label)).not.toBeNull();
    }
    expect(button("memory")).toBeNull();
    expect(button("todos")?.title).toBe("todos (1)");
    expect(button("todos")?.textContent).toBe("1");
    expect(button("agents")?.title).toBe("agents (1)");

    // Pressing an icon opens just that pane beside the strip.
    act(() => button("todos")!.click());
    expect(document.body.textContent).toContain("First task");
    expect(button("collapse inspector")).not.toBeNull();
    expect(button("todos")?.getAttribute("aria-pressed")).toBe("true");

    // Pressing a different icon swaps the single open pane.
    act(() => button("agents")!.click());
    expect(document.body.textContent).toContain("worker");
    expect(document.body.textContent).not.toContain("First task");

    // Re-pressing the active icon dismisses the pane back to the strip alone.
    act(() => button("agents")!.click());
    expect(button("collapse inspector")).toBeNull();
    expect(document.body.textContent).not.toContain("worker");
    expect(button("agents")).not.toBeNull();
  });

  it("shares committed width across close, reopen, and tab instances", () => {
    renderRail();
    act(() => button("todos")!.click());
    const pane = button("collapse inspector")!.parentElement!.parentElement as HTMLElement;
    const handle = document.body.querySelector<HTMLElement>('[role="separator"][aria-label="resize inspector"]')!;
    expect(pane.style.width).toBe("304px");

    act(() => {
      handle.dispatchEvent(resizePointer("pointerdown", 100));
      handle.dispatchEvent(resizePointer("pointermove", 50));
    });
    expect(pane.style.width).toBe("354px");
    expect(useStore.getState().inspectorWidth).toBe(304);
    act(() => handle.dispatchEvent(resizePointer("pointerup", 50)));
    expect(useStore.getState().inspectorWidth).toBe(354);

    act(() => button("collapse inspector")!.click());
    expect(useStore.getState().inspectorOpen).toBe(false);
    act(() => button("todos")!.click());
    expect((button("collapse inspector")!.parentElement!.parentElement as HTMLElement).style.width).toBe("354px");

    act(() => root!.render(<InspectorRail tabId="another-tab" />));
    expect((button("collapse inspector")!.parentElement!.parentElement as HTMLElement).style.width).toBe("354px");
    const sharedHandle = document.body.querySelector<HTMLElement>('[role="separator"]')!;
    act(() => sharedHandle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(useStore.getState().inspectorWidth).toBe(304);
  });

  it("unions the live roster with retained buffers and toggles the subagent view (issue #63)", () => {
    useStore.setState({
      rpc: {
        [TAB]: runtime({
          subagents: [{ id: "agent-1", name: "worker", status: "working" }],
          subagentItems: {
            // agent-2 settled out of the live roster; its buffer is retained.
            "agent-2": [{ kind: "marker", id: "i2", label: "mapping done" }],
          },
        }),
      },
    });
    renderRail();
    act(() => railTab("agents")!.click());

    // The roster is live agents UNION retained ones; retained render dimmed.
    expect(document.body.textContent).toContain("worker");
    expect(document.body.textContent).toContain("agent-2");
    expect(button("open agent agent-2")?.className).toContain("opacity-50");
    expect(button("open agent worker")?.className).not.toContain("opacity-50");

    // Clicking a row selects it — the subagent view opens in the main pane.
    act(() => button("open agent worker")!.click());
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBe("agent-1");
    expect(button("close agent worker")?.getAttribute("aria-pressed")).toBe("true");

    // Re-clicking the selected row returns to the main agent.
    act(() => button("close agent worker")!.click());
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBeNull();

    // Settled agents open too — their retained buffer renders in the view.
    act(() => button("open agent agent-2")!.click());
    expect(useStore.getState().rpc[TAB]!.selectedSubagent).toBe("agent-2");
  });
  it("re-reads an open project diff only when that project's revision changes", async () => {
    const initial = deferred<BranchDiff>();
    const refreshed = deferred<BranchDiff>();
    backendMock.getBranchDiff
      .mockReturnValueOnce(initial.promise)
      .mockReturnValueOnce(refreshed.promise);
    useStore.setState({ state });
    renderRail();

    act(() => railTab("diffs")!.click());
    expect(backendMock.getBranchDiff).toHaveBeenNthCalledWith(1, PROJECT, null);

    await act(async () => {
      initial.resolve(diffResult("feature/alpha", "initial.txt", "initial change"));
    });
    expect(document.body.textContent).toContain("initial.txt");

    await act(async () => {
      useStore.setState({ branchDiffRevision: { [PROJECT]: 0, [OTHER_PROJECT]: 1 } });
    });
    expect(backendMock.getBranchDiff).toHaveBeenCalledTimes(1);

    await act(async () => {
      useStore.setState({ branchDiffRevision: { [PROJECT]: 1, [OTHER_PROJECT]: 1 } });
    });
    expect(backendMock.getBranchDiff).toHaveBeenNthCalledWith(2, PROJECT, null);
    expect(backendMock.getBranchDiff).toHaveBeenCalledTimes(2);

    await act(async () => {
      refreshed.resolve(diffResult("feature/alpha", "refreshed.txt", "refreshed change"));
    });
    expect(document.body.textContent).toContain("refreshed.txt");
    expect(document.body.textContent).not.toContain("initial.txt");

    act(() => railTab("diffs")!.click());
    expect(button("collapse inspector")).toBeNull();
    expect(document.body.textContent).not.toContain("refreshed.txt");
  });

  it("keeps a newer project diff when an older request resolves last", async () => {
    const older = deferred<BranchDiff>();
    const newer = deferred<BranchDiff>();
    backendMock.getBranchDiff.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    useStore.setState({ state });
    useStore.setState({ branchDiffRevision: { [PROJECT]: 0 } });
    renderRail();

    if (railTab("diffs")?.getAttribute("aria-pressed") !== "true") {
      act(() => railTab("diffs")!.click());
    }
    await act(async () => {});
    expect(backendMock.getBranchDiff).toHaveBeenNthCalledWith(1, PROJECT, null);
    await act(async () => {
      useStore.setState({ branchDiffRevision: { [PROJECT]: 1 } });
    });
    expect(backendMock.getBranchDiff).toHaveBeenCalledTimes(2);

    await act(async () => {
      newer.resolve(diffResult("feature/newer", "newer.txt", "newer change"));
    });
    expect(document.body.textContent).toContain("newer.txt");

    await act(async () => {
      older.resolve(diffResult("feature/older", "older.txt", "older change"));
    });
    expect(document.body.textContent).toContain("newer.txt");
    expect(document.body.textContent).not.toContain("older.txt");
  });

  it("diffs a worktree session against its base and labels the range (issue #261)", async () => {
    const MERGE_BASE = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";
    backendMock.getBranchDiff.mockResolvedValueOnce(
      diffResult("omp/feature", "change.txt", "worktree change", MERGE_BASE),
    );
    useStore.setState({ state: worktreeState });
    renderRail();

    act(() => railTab("diffs")!.click());
    await act(async () => {});
    // The pane reads the *worktree* checkout, scoped to the recorded base.
    expect(backendMock.getBranchDiff).toHaveBeenCalledWith(WORKTREE_PATH, "main");

    // A resolved merge base renders the range chip beside the branch chip.
    const chip = [...document.body.querySelectorAll<HTMLElement>("span")].find(
      (el) => el.textContent === "since main",
    );
    expect(chip).toBeDefined();
    expect(chip!.title).toBe(MERGE_BASE);
  });


  it("renders compact inspector sheets without a resize separator", () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
    });
    useStore.setState({ compactSurface: "inspector", inspectorOpen: true });
    renderRail();
    expect(document.body.querySelector('[role="dialog"][aria-label="inspector"]')).not.toBeNull();
    expect(document.body.querySelector('[role="separator"]')).toBeNull();
  });
});
