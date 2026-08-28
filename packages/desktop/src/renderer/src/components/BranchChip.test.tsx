// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  BranchList,
  MergeBackResult,
  MergeBackStatus,
  WorktreeReleaseResult,
} from "@omp-ui/core/types";
import { backendState as makeBackendState, rpcTabState } from "../test/fixtures";
import type { RpcTabState } from "../store";
import type { WorkspaceSelection } from "./WorktreeBranchFields";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const fixture: BranchList = {
  repoRoot: "/p",
  current: "main",
  branches: ["main", "feature/x"],
  defaultBranch: "main",
  upstreamRef: null,
  upstreamRemote: null,
  hasUpstream: false,
  ahead: 0,
  behind: 0,
  upstreamFetchedAt: null,
  upstreamRefreshError: null,
};

const mergeStatus = (patch: Partial<MergeBackStatus> = {}): MergeBackStatus => ({
  destination: "main",
  reason: null,
  destinationCheckedOut: true,
  branchExists: true,
  mergeInProgress: false,
  alreadyMerged: false,
  ahead: 3,
  ...patch,
});

const MERGE_BACK = {
  branch: "omp-ui/deadbeef",
  base: "main",
  projectRootCwd: "/p",
  tabId: "tab-0",
};

const mergeFixture: BranchList = {
  ...fixture,
  current: "omp-ui/deadbeef",
  branches: ["main", "feature/x", "omp-ui/deadbeef"],
};
const releaseResult: WorktreeReleaseResult = {
  worktreePath: "/wt/deadbeef",
  branch: "omp-ui/deadbeef",
  projectCwd: "/p",
  checkoutKept: null,
  branchOutcome: "removed",
};

const backendMock = {
  listBranches: vi.fn(async () => fixture),
  checkoutBranch: vi.fn(async () => {}),
  pullBranch: vi.fn(async () => {}),
  getMergeBackStatus: vi.fn<(projectCwd: string, branch: string, base: string | null) => Promise<MergeBackStatus>>(),
  mergeWorktreeBranch: vi.fn<(projectCwd: string, branch: string, destination: string) => Promise<MergeBackResult>>(),
  deleteSessionPreview: vi.fn<(tabId: string) => Promise<{ descendants: Array<{ tabId: string; title: string; running: boolean }> }>>(
    async () => ({ descendants: [] }),
  ),
  deleteSession: vi.fn<(tabId: string, cascade: boolean) => Promise<void>>(async () => {}),
  releaseWorktree: vi.fn<(tabId: string) => Promise<WorktreeReleaseResult>>(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { BranchChip } = await import("./BranchChip");
/**
 * A release relaunches the tab, so the store stages its notice until the fresh
 * process boots (issue #334). These tests assert the chip's own contract — the
 * text it raises — with a spy, and restore the real action between tests.
 */
const realAppendNotice = useStore.getState().appendNotice;

const WORKTREE = { path: "/wt/deadbeef", branch: "omp-ui/deadbeef", base: "main" };

/** One session summary on the merge-back project, worktree included. */
function sessionSummary(tabId: string, title: string): BackendState["projects"][number]["sessions"][number] {
  return {
    tabId,
    sessionId: null,
    lineageDir: `omp-ui--p--00000000-0000-4000-8000-00000000000${tabId.at(-1)}`,
    projectCwd: "/p",
    launchedAt: "t",
    mode: "rpc-ui",
    worktree: WORKTREE,
    planImplementationSource: null,
    agentMode: "build",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title,
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

/**
 * The merge-back tab's worktree record on the registry state (issue #323):
 * the return confirms read the checkout path from it. `sharer` adds a second
 * record in the same checkout, which the confirm must warn about (issue #334).
 */
function seedWorktreeRecord({ sharer = false }: { sharer?: boolean } = {}): void {
  useStore.setState({
    state: makeBackendState({
      projects: [
        {
          project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
          sessions: sharer
            ? [sessionSummary("tab-0", "Worktree"), sessionSummary("tab-9", "Descendant")]
            : [sessionSummary("tab-0", "Worktree")],
        },
      ],
    }),
  });
}

let root: Root | null = null;
let changes: WorkspaceSelection[] = [];
let workspaceDisabledFlag = false;
let workspaceOffered = true;
let createWorktreeHandler: (() => Promise<boolean>) | null = null;

/** One running session on the project — the busy-confirm trigger. */
function seedBusy(): void {
  useStore.setState({
    branches: { "/p": fixture },
    tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
    rpc: { "tab-1": { status: "running" } as unknown as RpcTabState },
    state: makeBackendState({
      projects: [
        {
          project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
          sessions: [
            {
              tabId: "tab-1",
              sessionId: null,
              lineageDir: "omp-ui--p--11111111-2222-3333-4444-555555555555",
              projectCwd: "/p",
              launchedAt: "t",
              mode: "rpc-ui",
worktree: null,
              planImplementationSource: null,
              agentMode: "build",
              compactionMethod: null,
              model: null,
              thinkingLevel: null,
              advisor: false,
              advisorModel: null,
              cachedTitle: null,
              cachedModified: null,
              title: "Busy",
              status: null,
              live: "live",
              pendingPlan: null,
              planSettle: null,
              streamStalled: false,
            },
          ],
        },
      ],
    }),
  });
}

function render(cwd = "/p"): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<BranchChip projectCwd={cwd} />));
}

/**
 * A worktree-session chip: the chip's cwd is the worktree checkout, and the
 * merge-back offer points at the project root behind it.
 */
function renderMergeChip(cwd = "/wt/deadbeef", mergeBack = MERGE_BACK): void {
  useStore.setState({ branches: { [cwd]: mergeFixture } });
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<BranchChip projectCwd={cwd} mergeBack={mergeBack} />));
}
/**
 * Controlled harness: the composer owns the selection, the test watches it.
 * `workspaceOffered` lets a test drop the workspace props while keeping the
 * same BranchChip instance — the stale-sub-mode effect, not a remount, must
 * do the work.
 */
function WorkspaceChipHarness({ cwd }: { cwd: string }) {
  const [value, setValue] = useState<WorkspaceSelection>({ mode: "checkout" });
  // Functional updates chain against the latest selection, exactly as
  // React's setState does — one event can emit several (the base pick
  // sets both the ref and the touched latch).
  const latest = useRef(value);
  return (
    <BranchChip
      projectCwd={cwd}
      workspace={workspaceOffered ? value : undefined}
      onWorkspaceChange={
        workspaceOffered
          ? (next) => {
              const applied = typeof next === "function" ? next(latest.current) : next;
              latest.current = applied;
              setValue(applied);
              changes.push(applied);
            }
          : undefined
      }
      workspaceDisabled={workspaceDisabledFlag}
      onCreateWorktree={createWorktreeHandler ?? undefined}
    />
  );
}

function renderWorkspaceChip(cwd = "/p"): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<WorkspaceChipHarness cwd={cwd} />));
}

const chip = (): HTMLButtonElement => {
  const button = document.body.querySelector<HTMLButtonElement>("button[aria-expanded]");
  expect(button).not.toBeNull();
  return button!;
};

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};
const branchInfo = (patch: Partial<BranchList> = {}): BranchList => ({ ...fixture, ...patch });

function seedBranch(patch: Partial<BranchList>): BranchList {
  const info = branchInfo(patch);
  backendMock.listBranches.mockResolvedValue(info);
  useStore.setState({ branches: { "/p": info }, branchActivity: {} });
  return info;
}

const pullButton = (): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
    candidate.textContent?.toLowerCase().startsWith("pull"),
  );

const worktreeRow = (): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === "worktree…",
  );

const checkoutRow = (): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === "Current checkout",
  );

async function typeInto(input: HTMLInputElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectInto(select: HTMLSelectElement, value: string): Promise<void> {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(select, value);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/**
 * Drains the multi-hop merge -> close -> erase chain: each awaited mock
 * resolution schedules another microtask round, and act only flushes while
 * it waits, so a few zero-delay ticks are the reliable drain.
 */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

/** The open branch popover (aria-busy also carries the in-flight state). */
const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>("[aria-busy]");

/** The merge-back row (pending, merging, or mergeable) — the chip's only menuitem. */
const mergeRow = (): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.startsWith("merg"),
  );

const menuitemByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => el.textContent === text,
  );

/** The already-merged return row (issue #334). */
const returnRow = (): HTMLButtonElement | undefined => menuitemByText("return to main");

const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="alertdialog"]');

const dialogButton = (text: string): HTMLButtonElement | undefined =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (el) => el.textContent === text,
  );

const notices = (): Array<{ text: string; level?: string }> =>
  (useStore.getState().rpc[MERGE_BACK.tabId]?.items ?? [])
    .filter((item) => item.kind === "notice")
    .map((item) => ({ text: item.text, level: item.level }));

async function openMergePopover(): Promise<void> {
  await act(async () => chip().click());
  await flushMicrotasks();
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

beforeEach(() => {
  vi.clearAllMocks();
  changes = [];
  workspaceDisabledFlag = false;
  createWorktreeHandler = null;
  workspaceOffered = true;
  backendMock.listBranches.mockResolvedValue(fixture);
  backendMock.pullBranch.mockResolvedValue(undefined);
  backendMock.getMergeBackStatus.mockReset();
  backendMock.getMergeBackStatus.mockResolvedValue(mergeStatus());
  backendMock.mergeWorktreeBranch.mockReset();
  backendMock.mergeWorktreeBranch.mockRejectedValue(new Error("unexpected merge"));
  backendMock.deleteSessionPreview.mockReset();
  backendMock.deleteSessionPreview.mockResolvedValue({ descendants: [] });
  backendMock.deleteSession.mockReset();
  backendMock.deleteSession.mockResolvedValue(undefined);
  backendMock.releaseWorktree.mockReset();
  backendMock.releaseWorktree.mockResolvedValue(releaseResult);
  useStore.setState({
    branches: { "/p": fixture },
    branchActivity: {},
    branchDiffRevision: {},
    tabs: [],
    rpc: {},
    state: null,
    appendNotice: realAppendNotice,
  });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("BranchChip", () => {
  it("renders the current branch, and nothing at all off-git (issue #35)", () => {
    useStore.setState({ branches: { "/p": fixture } });
    render();
    expect(chip().textContent).toContain("main");

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    useStore.setState({
      branches: {
        "/p": {
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
        },
      },
    });
    render();
    expect(document.body.querySelector("button")).toBeNull();
  });

  it("confirms a plain checkout while a session is mid-turn", async () => {
    seedBusy();
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("feature/x").click());

    expect(document.body.textContent).toContain("is mid-turn");
    expect(backendMock.checkoutBranch).not.toHaveBeenCalled();

    await act(async () => buttonByText("switch anyway").click());
    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "feature/x", undefined);
  });

  it("creates a branch without the busy confirm", async () => {
    seedBusy();
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("new branch…").click());
    expect(document.body.textContent).not.toContain("is mid-turn");

    const input = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="new branch name"]',
    );
    expect(input).not.toBeNull();
    await typeInto(input!, "topic");
    await act(async () => {
      input!.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
      );
    });

    expect(backendMock.checkoutBranch).toHaveBeenCalledWith("/p", "topic", { create: true });
  });

  it("closes on an outside pointerdown, and not on one inside the popover (issue #114)", async () => {
    render();
    await act(async () => chip().click());
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();

    const inside = document.body.querySelector<HTMLInputElement>(
      'input[aria-label="filter branches"]',
    )!;
    act(() => inside.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();

    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();
    expect(chip().getAttribute("aria-expanded")).toBe("false");
  });

  it("Escape steps out of the create form first, then closes and refocuses the trigger", async () => {
    render();
    await act(async () => chip().click());
    await act(async () => buttonByText("new branch…").click());
    expect(document.body.querySelector('input[aria-label="new branch name"]')).not.toBeNull();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('input[aria-label="new branch name"]')).toBeNull();
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();
    expect(document.activeElement).toBe(chip());
  });

  it("shows a neutral behind indicator and singular or plural Pull action", async () => {
    seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 1,
    });
    render();

    const indicator = chip().querySelector<HTMLElement>("[aria-hidden].tabular-nums");
    expect(indicator?.textContent).toContain("↓ 1");
    expect(indicator?.classList.contains("text-ink-dim")).toBe(true);
    expect(indicator?.classList.contains("text-copper")).toBe(false);
    expect(chip().textContent).toContain("1 commit behind origin/main");

    await act(async () => chip().click());
    expect(buttonByText("pull 1 commit").disabled).toBe(false);

    act(() => {
      const info = seedBranch({
        upstreamRef: "origin/main",
        upstreamRemote: "origin",
        hasUpstream: true,
        behind: 3,
      });
      useStore.setState({ branches: { "/p": info } });
    });
    expect(chip().querySelector<HTMLElement>("[aria-hidden].tabular-nums")?.textContent).toContain(
      "↓ 3",
    );
    expect(chip().textContent).toContain("3 commits behind origin/main");
    expect(buttonByText("pull 3 commits").disabled).toBe(false);
  });

  it("retains the last indicator and reports loading accessibly during an upstream refresh", async () => {
    const info = seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 2,
    });
    let resolveRefresh!: (value: BranchList) => void;
    backendMock.listBranches.mockReturnValueOnce(
      new Promise<BranchList>((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    render();

    await act(async () => chip().click());

    const popover = document.body.querySelector<HTMLElement>("[aria-busy]");
    expect(popover?.getAttribute("aria-busy")).toBe("true");
    expect(popover?.textContent).toContain("refreshing upstream…");
    expect(chip().querySelector<HTMLElement>("[aria-hidden].tabular-nums")?.textContent).toContain(
      "↓ 2",
    );

    await act(async () => resolveRefresh(info));
    expect(popover?.getAttribute("aria-busy")).toBe("false");
  });

  it("shows an upstream fetch error inline without discarding the branch snapshot", async () => {
    seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 2,
      upstreamRefreshError: "could not fetch origin: offline",
    });
    render();

    await act(async () => chip().click());

    expect(document.body.textContent).toContain("could not fetch origin: offline");
    expect(chip().textContent).toContain("main");
    expect(chip().textContent).toContain("↓ 2");
  });

  it.each([
    [
      "detached HEAD",
      { current: null, upstreamRef: null, hasUpstream: false },
      "detached HEAD — check out a branch to track an upstream",
    ],
    [
      "no configured upstream",
      { current: "main", upstreamRef: null, hasUpstream: false },
      "no upstream configured for this branch",
    ],
    [
      "configured but missing upstream",
      { current: "main", upstreamRef: "origin/main", hasUpstream: false },
      "upstream origin/main is unavailable",
    ],
    [
      "diverged upstream",
      { current: "main", upstreamRef: "origin/main", hasUpstream: true, ahead: 2, behind: 3 },
      "2 ahead, 3 behind origin/main — merge or rebase manually",
    ],
  ] as const)("guides a branch with %s", async (_label, patch, guidance) => {
    seedBranch(patch);
    render();

    await act(async () => chip().click());

    expect(document.body.textContent).toContain(guidance);
    expect(pullButton()?.disabled ?? true).toBe(true);
  });

  it("explains an ahead-only branch without offering Pull", async () => {
    seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      ahead: 2,
      behind: 0,
    });
    render();

    await act(async () => chip().click());

    expect(document.body.textContent).toContain("2 commits ahead of origin/main");
    expect(pullButton()).toBeUndefined();
  });

  it("debounces paired focus and visibility refreshes for 250ms", async () => {
    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      render();
      backendMock.listBranches.mockClear();

      act(() => {
        window.dispatchEvent(new Event("focus"));
        document.dispatchEvent(new Event("visibilitychange"));
        vi.advanceTimersByTime(249);
      });
      expect(backendMock.listBranches).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(1);
        await Promise.resolve();
      });
      expect(backendMock.listBranches).toHaveBeenCalledTimes(1);
      expect(backendMock.listBranches).toHaveBeenCalledWith("/p", { fetchUpstream: true });
    } finally {
      visibility.mockRestore();
      vi.useRealTimers();
    }
  });

  it("asks for Pull anyway before changing a running rpc-ui session's tree", async () => {
    const info = branchInfo({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 1,
    });
    seedBusy();
    backendMock.listBranches.mockResolvedValue(info);
    useStore.setState({ branches: { "/p": info } });
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("pull 1 commit").click());

    expect(document.body.textContent).toContain(
      "is mid-turn — pulling changes the project working tree",
    );
    expect(backendMock.pullBranch).not.toHaveBeenCalled();

    await act(async () => buttonByText("pull anyway").click());
    expect(backendMock.pullBranch).toHaveBeenCalledWith("/p");
  });

  it("keeps one disabled Pulling… action and the popover busy while a pull is in flight", async () => {
    const info = seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 2,
    });
    let resolvePull!: () => void;
    backendMock.pullBranch.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        resolvePull = resolve;
      }),
    );
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("pull 2 commits").click());

    const inFlight = buttonByText("Pulling…");
    expect(inFlight.disabled).toBe(true);
    expect(document.body.querySelector("[aria-busy]")?.getAttribute("aria-busy")).toBe("true");
    expect(backendMock.pullBranch).toHaveBeenCalledTimes(1);
    inFlight.click();
    expect(backendMock.pullBranch).toHaveBeenCalledTimes(1);

    act(() => {
      useStore.setState({ branches: { "/p": { ...info, behind: 0 } } });
    });
    expect(buttonByText("Pulling…")).toBe(inFlight);

    await act(async () => resolvePull());
  });

  it("shows a pull failure and retains the open popover for retry", async () => {
    seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 1,
    });
    backendMock.pullBranch.mockRejectedValueOnce(new Error("fast-forward pull failed"));
    render();

    await act(async () => chip().click());
    await act(async () => buttonByText("pull 1 commit").click());

    expect(backendMock.pullBranch).toHaveBeenCalledWith("/p");
    expect(document.body.textContent).toContain("fast-forward pull failed");
    expect(chip().getAttribute("aria-expanded")).toBe("true");
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();
  });
});

describe("BranchChip worktree section (issue #227)", () => {
  it("the worktree row appears only with the workspace prop", async () => {
    render();
    await act(async () => chip().click());
    expect(worktreeRow()).toBeUndefined();

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    renderWorkspaceChip();
    await act(async () => chip().click());
    expect(worktreeRow()).toBeDefined();
    expect(checkoutRow()).toBeUndefined();
  });

  it("picking worktree mints once; re-picking keeps the name", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());

    const input = document.body.querySelector<HTMLInputElement>("#composer-worktree-branch");
    expect(input).not.toBeNull();
    expect(input!.value).toMatch(/^omp-ui\/[0-9a-f]{8}$/);
    await flushMicrotasks();
    expect(
      document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!.value,
    ).toBe("main");

    const reports = changes.length;
    await act(async () => buttonByText("back").click());
    await act(async () => chip().click());
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());

    expect(
      document.body.querySelector<HTMLInputElement>("#composer-worktree-branch")!.value,
    ).toBe(input!.value);
    expect(changes.length).toBe(reports);
  });

  it("a hand-picked base survives a popover round-trip and refresh (the D2 regression)", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();

    await selectInto(
      document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!,
      "feature/x",
    );

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();

    await act(async () => chip().click());
    await flushMicrotasks();
    await act(async () => worktreeRow()!.click());

    expect(
      document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!.value,
    ).toBe("feature/x");
  });

  it("branch edits and base picks report through onWorkspaceChange", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();

    await typeInto(
      document.body.querySelector<HTMLInputElement>("#composer-worktree-branch")!,
      "feature/mine",
    );
    expect(changes.at(-1)).toEqual({
      mode: "worktree",
      branch: "feature/mine",
      baseRef: "main",
      baseTouched: false,
    });

    await selectInto(
      document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!,
      "feature/x",
    );
    expect(changes.at(-1)).toEqual({
      mode: "worktree",
      branch: "feature/mine",
      baseRef: "feature/x",
      baseTouched: true,
    });
  });

  it("the trigger shows the minted branch and a worktree marker while selected", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    const minted =
      document.body.querySelector<HTMLInputElement>("#composer-worktree-branch")!.value;
    await act(async () => chip().click());

    expect(chip().textContent).toContain(minted);
    expect(chip().textContent).toContain("worktree");
    expect(chip().title.startsWith("worktree —")).toBe(true);
  });

  it("escaping peels worktree to list, keeping the selection", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();
    const reports = changes.length;

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();
    expect(changes.length).toBe(reports);
  });

  it("Current checkout reverts the selection and closes", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await act(async () => buttonByText("back").click());
    await act(async () => checkoutRow()!.click());

    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();
    expect(chip().getAttribute("aria-expanded")).toBe("false");
    expect(changes.at(-1)).toEqual({ mode: "checkout" });
  });

  it("the worktree row is disabled while workspaceDisabled", async () => {
    workspaceDisabledFlag = true;
    renderWorkspaceChip();
    await act(async () => chip().click());

    const row = worktreeRow()!;
    expect(row.disabled).toBe(true);
    expect(row.title).toBe("the session must be ready before it can run in a worktree");
  });

  it("a removed workspace prop drops a stale worktree sub-mode", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    expect(document.body.querySelector("#composer-worktree-branch")).not.toBeNull();

    // Same BranchChip instance, workspace props removed: the stale-sub-mode
    // effect must peel the sub-mode back to the list (a remount would pass
    // from the state reset alone).
    workspaceOffered = false;
    act(() => root!.render(<WorkspaceChipHarness cwd="/p" />));

    expect(document.body.querySelector("#composer-worktree-branch")).toBeNull();
    expect(document.body.querySelector('input[aria-label="filter branches"]')).not.toBeNull();
    expect(worktreeRow()).toBeUndefined();
    expect(chip().textContent).toContain("main");
    expect(chip().textContent).not.toContain("worktree");

    // The mode truly fell back to the list: one Escape now closes the
    // popover (a stale worktree mode would swallow this Escape as a peel and
    // leave the popover open).
    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));
    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();
  });

  it("create is offered only with the onCreateWorktree prop", async () => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
    const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("button")];
    expect(buttons.some((b) => b.textContent === "create")).toBe(false);

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    createWorktreeHandler = async () => true;
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
    expect(buttonByText("create").disabled).toBe(false);
    createWorktreeHandler = null;
  });

  it("create success fires the conversion once and closes the popover", async () => {
    const calls: number[] = [];
    createWorktreeHandler = async () => { calls.push(1); return true; };
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
    await act(async () => buttonByText("create").click());
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(document.body.querySelector('input[aria-label="filter branches"]')).toBeNull();
    createWorktreeHandler = null;
  });

  it("a create failure keeps the popover open for a fix-and-retry", async () => {
    createWorktreeHandler = async () => false;
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
    await act(async () => buttonByText("create").click());
    await flushMicrotasks();
    expect(document.body.querySelector("#composer-worktree-branch")).not.toBeNull();
    createWorktreeHandler = null;
  });

  it("create is disabled with an empty branch name", async () => {
    createWorktreeHandler = async () => true;
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
    await typeInto(document.body.querySelector<HTMLInputElement>("#composer-worktree-branch")!, "");
    expect(buttonByText("create").disabled).toBe(true);
    createWorktreeHandler = null;
  });
});

describe("BranchChip merge-back (issue #322)", () => {
  it("offers no merge row without the prop, and never reads the status", async () => {
    render();
    await act(async () => chip().click());
    await flushMicrotasks();

    expect(backendMock.getMergeBackStatus).not.toHaveBeenCalled();
    expect(mergeRow()).toBeUndefined();
  });

  it("offers the merge row with the commit count, and reads the status on open", async () => {
    renderMergeChip();
    await openMergePopover();

    expect(backendMock.getMergeBackStatus).toHaveBeenCalledWith("/p", "omp-ui/deadbeef", "main");
    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(false);
    expect(row!.textContent).toBe("merge into main · 3 commits");
    expect(menu()!.textContent).toContain(
      "a successful merge returns this session to main — the checkout and the branch are " +
        "removed, the session and its transcript are kept",
    );
  });

  it("uses the singular commit wording for one commit", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(mergeStatus({ ahead: 1 }));
    renderMergeChip();
    await openMergePopover();

    expect(mergeRow()!.textContent).toBe("merge into main · 1 commit");
  });

  it("shows a disabled pending row while the status read is in flight", async () => {
    const pending = deferred<MergeBackStatus>();
    backendMock.getMergeBackStatus.mockReturnValueOnce(pending.promise);
    renderMergeChip();
    await openMergePopover();

    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
    expect(row!.textContent).toBe("merge into main");
    void pending;
  });

  it("shortens a 40-hex commit base in the pending row", async () => {
    const pending = deferred<MergeBackStatus>();
    backendMock.getMergeBackStatus.mockReturnValueOnce(pending.promise);
    renderMergeChip("/wt/deadbeef", { ...MERGE_BACK, base: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" });
    await openMergePopover();

    expect(mergeRow()!.textContent).toBe("merge into a1b2c3d4");
    void pending;
  });

  it("surfaces a rejected status read in the rose slot", async () => {
    backendMock.getMergeBackStatus.mockRejectedValue(new Error("status failed"));
    renderMergeChip();
    await openMergePopover();

    expect(menu()!.textContent).toContain("status failed");
    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
  });

  it("confirms in the rose modal, merges, and returns the session to the base branch", async () => {
    seedWorktreeRecord();
    const appendNotice = vi.fn();
    useStore.setState({ appendNotice });
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": rpcTabState() },
    });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "merged",
      destination: "main",
      commits: 3,
      files: [],
    });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());

    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Irreversible action");
    expect(d!.textContent).toContain(
      "Merge omp-ui/deadbeef into main and return this session to it?",
    );
    expect(d!.textContent).toContain(
      "Writes a merge commit in the project checkout recording the 3 committed change(s) on " +
        "omp-ui/deadbeef — their subjects and any issues they close. Uncommitted changes in the " +
        "worktree are not included.",
    );
    expect(d!.textContent).toContain(
      "This session then returns to main in /p: its agent restarts there with its transcript " +
        "intact. The checkout /wt/deadbeef is removed — uncommitted changes there are lost — and " +
        "the branch omp-ui/deadbeef is deleted.",
    );
    expect(d!.textContent).toContain(
      "A conflicted merge stops both the merge and the return: the project checkout is left " +
        "with files to resolve, and this session stays on omp-ui/deadbeef.",
    );
    // Nothing is cascade-deleted any more: no descendant preview is read.
    expect(backendMock.deleteSessionPreview).not.toHaveBeenCalled();

    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith("/p", "omp-ui/deadbeef", "main");
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith("tab-0");
    // The session survives: its tab and rpc slot stay, nothing is deleted.
    expect(backendMock.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.some((t) => t.tabId === "tab-0")).toBe(true);
    expect(useStore.getState().rpc["tab-0"]).toBeDefined();
    // The relaunch stages the notice, so assert the text the chip raised.
    expect(appendNotice).toHaveBeenCalledWith(
      "tab-0",
      "merged omp-ui/deadbeef (3 commits) into the project checkout — this session now runs " +
        "in /p. The checkout and branch omp-ui/deadbeef are gone.",
      "info",
    );
    expect(dialog()).toBeNull();
  });

  it("warns in the confirm when another session shares the checkout", async () => {
    seedWorktreeRecord({ sharer: true });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());

    expect(dialog()!.textContent).toContain(
      "1 other session(s) still run in this checkout, so it and the branch are kept until they " +
        "leave.",
    );
  });

  it("cancelling the modal makes no merge or release call and keeps the popover", async () => {
    seedWorktreeRecord();
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    expect(dialog()).not.toBeNull();

    await act(async () => dialogButton("cancel")!.click());

    expect(dialog()).toBeNull();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(mergeRow()).toBeDefined();
    expect(menu()).not.toBeNull();
  });

  it("survives a pointerdown on the modal — the popover's own surface is not outside", async () => {
    seedWorktreeRecord();
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    const d = dialog();
    expect(d).not.toBeNull();

    act(() => d!.dispatchEvent(new Event("pointerdown", { bubbles: true })));

    expect(dialog()).not.toBeNull();
    expect(menu()).not.toBeNull();
  });

  it("Escape with the modal open closes only the modal; the next Escape closes the menu", async () => {
    seedWorktreeRecord();
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    const d = dialog();
    expect(d).not.toBeNull();

    act(() => d!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));

    expect(dialog()).toBeNull();
    expect(menu()).not.toBeNull();

    act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })));

    expect(menu()).toBeNull();
  });

  it("surfaces a rejected merge in the rose slot and re-fetches the status", async () => {
    seedWorktreeRecord();
    backendMock.mergeWorktreeBranch.mockRejectedValueOnce(new Error("fatal: cannot merge"));
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(menu()!.textContent).toContain("fatal: cannot merge");
    expect(dialog()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(mergeRow()).toBeDefined();
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
  });

  it("shows a conflicted merge's file list with the console escape hatch, and keeps the worktree", async () => {
    seedWorktreeRecord();
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": rpcTabState() },
    });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "conflicts",
      destination: "main",
      commits: 3,
      files: ["src/a.ts", "src/b.ts"],
    });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    const popover = menu()!;
    expect(popover.textContent).toContain("merge stopped — 2 file(s) conflict");
    expect(popover.textContent).toContain("src/a.ts");
    expect(popover.textContent).toContain("src/b.ts");
    expect(popover.textContent).toContain(
      "resolve in /p, then git merge --continue — or git merge --abort",
    );
    expect(mergeRow()).toBeUndefined();
    expect(notices()).toEqual([
      {
        text:
          "merge of omp-ui/deadbeef into main stopped — 2 file(s) conflict: src/a.ts, src/b.ts. " +
          "Resolve in /p (git merge --continue) or abort (git merge --abort).",
        level: "warn",
      },
    ]);
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
    // A conflict stops the release too: the session stays in its checkout.
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.some((t) => t.tabId === "tab-0")).toBe(true);

    await act(async () => buttonByText("open console")!.click());
    expect(useStore.getState().consoleOpen[MERGE_BACK.tabId]).toBe(true);
  });

  it("lists up to five conflicted files in the notice and counts the rest", async () => {
    seedWorktreeRecord();
    useStore.setState({ rpc: { [MERGE_BACK.tabId]: rpcTabState() } });
    const files = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "conflicts",
      destination: "main",
      commits: 3,
      files,
    });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(notices()).toEqual([
      {
        text:
          "merge of omp-ui/deadbeef into main stopped — 7 file(s) conflict: f1, f2, f3, f4, f5, " +
          "and 2 more. Resolve in /p (git merge --continue) or abort (git merge --abort).",
        level: "warn",
      },
    ]);
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
  });

  it("notes an unchecked-out destination, with no row and no merge call", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      mergeStatus({ destinationCheckedOut: false }),
    );
    renderMergeChip();
    await openMergePopover();

    expect(menu()!.textContent).toContain("check out main in the project to merge back");
    expect(mergeRow()).toBeUndefined();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
  });

  it("offers an actionable return row for an already-merged branch", async () => {
    seedWorktreeRecord();
    const appendNotice = vi.fn();
    useStore.setState({ appendNotice });
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": rpcTabState() },
    });
    backendMock.getMergeBackStatus.mockResolvedValue(
      mergeStatus({ alreadyMerged: true, ahead: 0 }),
    );
    renderMergeChip();
    await openMergePopover();

    expect(mergeRow()).toBeUndefined();
    expect(returnRow()).toBeDefined();

    await act(async () => returnRow()!.click());
    await settle();

    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Irreversible action");
    expect(d!.textContent).toContain("Return this session to main?");
    expect(d!.textContent).toContain("The branch omp-ui/deadbeef is already in main.");
    expect(d!.textContent).toContain(
      "This session returns to main in /p: its agent restarts there with its transcript intact. " +
        "The checkout /wt/deadbeef is removed — uncommitted changes there are lost — and the " +
        "branch omp-ui/deadbeef is deleted.",
    );

    await act(async () => dialogButton("return to main")!.click());
    await settle();

    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith("tab-0");
    expect(backendMock.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.some((t) => t.tabId === "tab-0")).toBe(true);
    expect(appendNotice).toHaveBeenCalledWith(
      "tab-0",
      "omp-ui/deadbeef was already in the project checkout — this session now runs in /p. " +
        "The checkout and branch omp-ui/deadbeef are gone.",
      "info",
    );
  });

  it("notes an in-progress merge in the project with the console escape hatch", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(mergeStatus({ mergeInProgress: true }));
    renderMergeChip();
    await openMergePopover();

    const popover = menu()!;
    expect(popover.textContent).toContain(
      "a merge is already in progress in the project — finish it there: git merge --continue or " +
        "git merge --abort",
    );
    expect(buttonByText("open console")).toBeDefined();
    expect(mergeRow()).toBeUndefined();
  });

  it("notes a branch that no longer exists", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(mergeStatus({ branchExists: false }));
    renderMergeChip();
    await openMergePopover();

    expect(menu()!.textContent).toContain(
      "branch omp-ui/deadbeef no longer exists — nothing to merge",
    );
    expect(mergeRow()).toBeUndefined();
  });

  it("notes a base that no longer resolves, shortened for a 40-hex base", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      mergeStatus({ destination: null, reason: "base-gone" }),
    );
    renderMergeChip();
    await openMergePopover();
    expect(menu()!.textContent).toContain("base main no longer resolves — merge manually");
    expect(mergeRow()).toBeUndefined();

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    backendMock.getMergeBackStatus.mockResolvedValue(
      mergeStatus({ destination: null, reason: "base-gone" }),
    );
    renderMergeChip("/wt/deadbeef", {
      ...MERGE_BACK,
      base: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0",
    });
    await openMergePopover();
    expect(menu()!.textContent).toContain("base a1b2c3d4 no longer resolves — merge manually");
  });

  it("notes a base with no matching local branch", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      mergeStatus({ destination: null, reason: "no-branch-match" }),
    );
    renderMergeChip();
    await openMergePopover();

    expect(menu()!.textContent).toContain("no local branch matches base main — merge manually");
    expect(mergeRow()).toBeUndefined();
  });

  it("keeps the worktree and warns when the release rejects", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    seedWorktreeRecord();
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": rpcTabState() },
    });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "merged",
      destination: "main",
      commits: 3,
      files: [],
    });
    backendMock.releaseWorktree.mockRejectedValueOnce(new Error("session tab-0 did not exit"));
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(alertSpy).toHaveBeenCalledWith("session tab-0 did not exit");
    expect(dialog()).toBeNull();
    expect(useStore.getState().tabs.some((t) => t.tabId === "tab-0")).toBe(true);
    // The failed return resets: the merge row is back and the status re-read.
    expect(mergeRow()).toBeDefined();
    expect(mergeRow()!.disabled).toBe(false);
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
    expect(notices()).toEqual([]);
    alertSpy.mockRestore();
  });

  it("warns in the notice when the checkout was kept for a sharer", async () => {
    seedWorktreeRecord({ sharer: true });
    const appendNotice = vi.fn();
    useStore.setState({ appendNotice });
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": rpcTabState() },
    });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "merged",
      destination: "main",
      commits: 3,
      files: [],
    });
    backendMock.releaseWorktree.mockResolvedValueOnce({
      ...releaseResult,
      checkoutKept: "shared",
      branchOutcome: "not-attempted",
    });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(appendNotice).toHaveBeenCalledWith(
      "tab-0",
      "merged omp-ui/deadbeef (3 commits) into the project checkout — this session now runs " +
        "in /p. The checkout /wt/deadbeef and branch omp-ui/deadbeef are kept: another session " +
        "still runs there.",
      "warn",
    );
  });

  it("confirms inline while a session is mid-turn in the project, and merges on merge & return anyway", async () => {
    seedBusy();
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "merged",
      destination: "main",
      commits: 3,
      files: [],
    });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());

    expect(dialog()).toBeNull();
    const popover = menu()!;
    expect(popover.textContent).toContain(
      "session “Busy” is mid-turn in the project — merging moves main under it. The merge also " +
        "returns this session to main: the checkout and branch are removed, the session is kept.",
    );

    await act(async () => buttonByText("merge & return anyway")!.click());
    await settle();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith("/p", "omp-ui/deadbeef", "main");
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith("tab-0");
  });

  it("cancel leaves the busy confirm and makes no call", async () => {
    seedBusy();
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    expect(buttonByText("merge & return anyway")).toBeDefined();

    await act(async () => buttonByText("cancel").click());

    expect(menu()!.textContent).not.toContain("is mid-turn in the project");
    expect(dialog()).toBeNull();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(mergeRow()).toBeDefined();
  });

  it("skips the busy confirm for the session's own turn in the worktree checkout", async () => {
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": { status: "running" } as unknown as RpcTabState },
      state: makeBackendState({
        projects: [
          {
            project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
            sessions: [
              {
                tabId: "tab-0",
                sessionId: null,
                lineageDir: "omp-ui--p--00000000-0000-4000-8000-000000000000",
                projectCwd: "/p",
                launchedAt: "t",
                mode: "rpc-ui",
                worktree: { path: "/wt/deadbeef", branch: "omp-ui/deadbeef", base: "main" },
                planImplementationSource: null,
                agentMode: "build",
                compactionMethod: null,
                model: null,
                thinkingLevel: null,
                advisor: false,
                advisorModel: null,
                cachedTitle: null,
                cachedModified: null,
                title: "Self",
                status: null,
                live: "live",
                pendingPlan: null,
                planSettle: null,
                streamStalled: false,
              },
            ],
          },
        ],
      }),
    });
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());

    // The merge touches only the project checkout; this session's own turn
    // in the worktree never blocks it.
    expect(menu()!.textContent).not.toContain("is mid-turn in the project");
    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain(
      "Merge omp-ui/deadbeef into main and return this session to it?",
    );
  });

  it("keeps the row as merging…, then returning… while the merge and return run", async () => {
    seedWorktreeRecord();
    useStore.setState({
      tabs: [{ tabId: "tab-0", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
      rpc: { "tab-0": rpcTabState() },
    });
    const pending = deferred<MergeBackResult>();
    const release = deferred<WorktreeReleaseResult>();
    backendMock.mergeWorktreeBranch.mockReturnValueOnce(pending.promise);
    backendMock.releaseWorktree.mockReturnValueOnce(release.promise);
    renderMergeChip();
    await openMergePopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await flushMicrotasks();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledTimes(1);
    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
    expect(row!.textContent).toBe("merging…");
    expect(dialogButton("merging…")).toBeDefined();

    await act(async () => {
      pending.resolve({ kind: "merged", destination: "main", commits: 3, files: [] });
    });
    await flushMicrotasks();

    expect(dialog()).toBeNull();
    expect(menuitemByText("returning…")).toBeDefined();

    await act(async () => {
      release.resolve(releaseResult);
    });
    await settle();

    expect(backendMock.releaseWorktree).toHaveBeenCalledWith("tab-0");
  });
});
