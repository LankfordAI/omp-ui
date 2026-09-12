// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, PushResult } from "@omp-ui/core/types";
import { backendState as makeBackendState } from "../test/fixtures";
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
  // The chip's publish row reads this (issue #414): the repo's push target.
  defaultRemote: "origin",
};

const backendMock = {
  listBranches: vi.fn(async () => fixture),
  remoteInstanceRequest: vi.fn(async () => fixture),
  checkoutBranch: vi.fn(async () => {}),
  pullBranch: vi.fn(async () => {}),
  // Push answers git state through a structured result, never a rejection.
  pushBranch: vi.fn(
    async (): Promise<PushResult> => ({
      kind: "pushed",
      remote: "origin",
      upstreamRef: "origin/main",
      commits: 2,
    }),
  ),
  pullRequestUrl: vi.fn(
    async (): Promise<string | null> => "https://github.com/o/r/compare/main...feature/x",
  ),
  deleteSessionPreview: vi.fn<(tabId: string) => Promise<{ descendants: Array<{ tabId: string; title: string; running: boolean }> }>>(
    async () => ({ descendants: [] }),
  ),
  deleteSession: vi.fn(async (tabId: string) => ({ deleted: [tabId], failed: [] })),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { BranchChip } = await import("./BranchChip");

let root: Root | null = null;
let changes: WorkspaceSelection[] = [];
let workspaceDisabledFlag = false;
let workspaceOffered = true;
let createWorktreeHandler: (() => Promise<boolean>) | null = null;

/** One running session on the project — the busy-confirm trigger. */
function seedBusy(): void {
  useStore.setState({
    branches: { "/p": fixture },
    tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null }],
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

/** The open branch popover (aria-busy also carries the in-flight state). */
const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>("[aria-busy]");

const menuitemByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => el.textContent === text,
  );

beforeEach(() => {
  vi.clearAllMocks();
  changes = [];
  workspaceDisabledFlag = false;
  createWorktreeHandler = null;
  workspaceOffered = true;
  backendMock.listBranches.mockResolvedValue(fixture);
  backendMock.pullBranch.mockResolvedValue(undefined);
  backendMock.pushBranch.mockReset();
  backendMock.pushBranch.mockResolvedValue({
    kind: "pushed",
    remote: "origin",
    upstreamRef: "origin/main",
    commits: 2,
  });
  backendMock.pullRequestUrl.mockReset();
  backendMock.pullRequestUrl.mockResolvedValue("https://github.com/o/r/compare/main...feature/x");
  vi.spyOn(window, "open").mockImplementation(() => null);
  backendMock.deleteSessionPreview.mockReset();
  backendMock.deleteSessionPreview.mockResolvedValue({ descendants: [] });
  backendMock.deleteSession.mockReset();
  backendMock.deleteSession.mockImplementation(async (tabId) => ({
    deleted: [tabId],
    failed: [],
  }));
  useStore.setState({
    branches: { "/p": fixture },
    branchActivity: {},
    branchDiffRevision: {},
    tabs: [],
    rpc: {},
    state: null,
    finishWorktreeTab: null,
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
          // Off-git: no repo, so no push target either.
          defaultRemote: null,
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

  it("claims no upstream work during a local reload (issue #506)", async () => {
    const info = seedBranch({
      upstreamRef: "origin/main",
      upstreamRemote: "origin",
      hasUpstream: true,
      behind: 0,
      ahead: 2,
    });
    render();
    await act(async () => chip().click());

    // The watcher echo's production shape — e.g. pull's post-refresh reload:
    // refreshing true, fetching false. No upstream claim may show, while the
    // popover stays busy and every action row stays disabled.
    let resolveEcho!: (value: BranchList) => void;
    backendMock.listBranches.mockReturnValueOnce(
      new Promise<BranchList>((resolve) => {
        resolveEcho = resolve;
      }),
    );
    const pull = useStore.getState().pullGitBranch("/p");
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    const popover = menu();
    expect(popover?.getAttribute("aria-busy")).toBe("true");
    expect(popover?.textContent).not.toContain("refreshing upstream…");
    expect(pullButton()?.disabled).toBe(true);
    const pushRow = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent?.toLowerCase().startsWith("push "),
    );
    expect(pushRow?.disabled).toBe(true);

    await act(async () => {
      resolveEcho(info);
      await pull;
    });
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

  it("routes the focus refresh to the owning remote instance (issue #488)", async () => {
    const INSTANCE = "inst-remote";
    // Pre-populated remote key: the mount refresh stays quiet, only focus fires.
    useStore.setState({ branches: { [`${INSTANCE}::/p`]: fixture } });
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<BranchChip projectCwd="/p" instanceId={INSTANCE} />));

    vi.useFakeTimers();
    const visibility = vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    try {
      act(() => {
        window.dispatchEvent(new Event("focus"));
      });
      await act(async () => {
        vi.advanceTimersByTime(250);
        await Promise.resolve();
      });
      expect(backendMock.remoteInstanceRequest).toHaveBeenCalledWith(
        INSTANCE,
        "branch:list",
        ["/p", { fetchUpstream: true }],
      );
      expect(backendMock.listBranches).not.toHaveBeenCalled();
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
    expect(input!.value).toMatch(/^p\/main\/[0-9a-f]{8}$/);
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
      baseBranch: null,
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
      baseBranch: null,
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

  // Issue #405: the Base select can create its branch, and the mint follows
  // the base while the name is untouched.
  const baseSelect = (): HTMLSelectElement =>
    document.body.querySelector<HTMLSelectElement>("#composer-worktree-base")!;
  const branchInput = (): HTMLInputElement =>
    document.body.querySelector<HTMLInputElement>("#composer-worktree-branch")!;
  const openWorktreeFields = async (): Promise<void> => {
    renderWorkspaceChip();
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
  };

  it("*new branch…* reveals the name and cut-from rows and reports baseBranch empty", async () => {
    await openWorktreeFields();
    await selectInto(baseSelect(), "__new__");

    expect(document.body.querySelector("#composer-worktree-new-base")).not.toBeNull();
    expect(document.body.querySelector("#composer-worktree-new-base-from")).not.toBeNull();
    const last = changes.at(-1)!;
    expect(last).toMatchObject({ mode: "worktree", baseRef: "main", baseBranch: "", baseTouched: true });
  });

  it("typing the new base recomposes the mint and keeps the hash", async () => {
    await openWorktreeFields();
    const before = branchInput().value;
    expect(before).toMatch(/^p\/main\/[0-9a-f]{8}$/);

    await selectInto(baseSelect(), "__new__");
    await typeInto(document.body.querySelector<HTMLInputElement>("#composer-worktree-new-base")!, "TECH-123");

    const after = branchInput().value;
    expect(after).toMatch(/^p\/TECH-123\/[0-9a-f]{8}$/);
    expect(after.slice(after.lastIndexOf("/") + 1)).toBe(before.slice(before.lastIndexOf("/") + 1));
  });

  it("switching the base to an existing branch recomposes the mint the same way", async () => {
    await openWorktreeFields();
    const hash = branchInput().value.split("/").at(-1);

    await selectInto(baseSelect(), "feature/x");

    expect(branchInput().value).toBe(`p/feature/x/${hash}`);
    expect(changes.at(-1)).toMatchObject({ baseBranch: null, baseRef: "feature/x" });
  });

  it("a hand-typed branch survives a new-base toggle and typing untouched", async () => {
    await openWorktreeFields();
    await typeInto(branchInput(), "feature/mine");

    await selectInto(baseSelect(), "__new__");
    await typeInto(document.body.querySelector<HTMLInputElement>("#composer-worktree-new-base")!, "TECH-123");

    expect(branchInput().value).toBe("feature/mine");
  });

  it("create stays disabled while the new base name is blank", async () => {
    createWorktreeHandler = async () => true;
    await openWorktreeFields();
    await selectInto(baseSelect(), "__new__");
    expect(buttonByText("create").disabled).toBe(true);

    await typeInto(document.body.querySelector<HTMLInputElement>("#composer-worktree-new-base")!, " ");
    expect(buttonByText("create").disabled).toBe(true);

    await typeInto(document.body.querySelector<HTMLInputElement>("#composer-worktree-new-base")!, "TECH-123");
    expect(buttonByText("create").disabled).toBe(false);
    createWorktreeHandler = null;
  });

  it("offers no create affordance until the branch listing has landed (issue #482)", async () => {
    // Cold store: the mint payload composed here would carry baseRef null,
    // so the surface must not exist until the listing resolves the base.
    // The chip renders nothing at all while `info` is undefined — the
    // strongest form of the gate the create button's disabled term repeats
    // defensively.
    let release: (value: BranchList) => void = () => {};
    backendMock.listBranches.mockReturnValue(
      new Promise<BranchList>((resolve) => {
        release = resolve;
      }),
    );
    useStore.setState({ branches: {}, branchActivity: {} });
    renderWorkspaceChip();
    await act(async () => {
      await Promise.resolve();
    });
    expect(document.body.querySelector("button")).toBeNull();

    act(() => {
      release(fixture);
    });
    await act(async () => {
      await Promise.resolve();
    });
    createWorktreeHandler = async () => true;
    await act(async () => chip().click());
    await act(async () => worktreeRow()!.click());
    await flushMicrotasks();
    expect(buttonByText("create").disabled).toBe(false);
    createWorktreeHandler = null;
  });
});

describe("BranchChip finish worktree row (issues #385–#389)", () => {
  it("shows the row only with finishTabId, sets the dialog tab, and closes the menu", async () => {
    render();
    await act(async () => chip().click());
    expect(menuitemByText("finish worktree…")).toBeUndefined();

    act(() => root!.unmount());
    root = null;
    document.body.replaceChildren();
    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() => root!.render(<BranchChip projectCwd="/p" finishTabId="tab-0" />));
    await act(async () => chip().click());

    const row = menuitemByText("finish worktree…");
    expect(row).toBeDefined();
    await act(async () => row!.click());

    expect(useStore.getState().finishWorktreeTab).toBe("tab-0");
    expect(menu()).toBeNull();
  });
});

describe("BranchChip push, publish, and pull request rows (issue #414)", () => {
  const pushRow = (): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.toLowerCase().startsWith("push "),
    );
  const publishRow = (): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find((candidate) =>
      candidate.textContent?.toLowerCase().startsWith("publish "),
    );
  const prRow = (): HTMLButtonElement | undefined =>
    [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "pull request…",
    );
  const aheadUpstream = {
    upstreamRef: "origin/main",
    upstreamRemote: "origin",
    hasUpstream: true,
    ahead: 2,
    behind: 0,
    defaultRemote: "origin",
  };

  it("offers the push row only for an ahead-only branch, on its own upstream", async () => {
    seedBranch(aheadUpstream);
    render();
    await act(async () => chip().click());

    expect(pushRow()?.textContent).toBe("push 2 commits to origin/main");
    expect(pushRow()?.disabled).toBe(false);
    expect(publishRow()).toBeUndefined();

    // Diverged: git would refuse the push, so the copper note is the answer.
    act(() => useStore.setState({ branches: { "/p": branchInfo({ ...aheadUpstream, behind: 3 }) } }));
    expect(pushRow()).toBeUndefined();

    // Configured-but-missing upstream: the ref the row would name is gone.
    act(() =>
      useStore.setState({
        branches: { "/p": branchInfo({ ...aheadUpstream, hasUpstream: false, behind: 0 }) },
      }),
    );
    expect(pushRow()).toBeUndefined();
  });

  it("pushes the checked-out branch through the store, not the checkout it sits on", async () => {
    seedBranch(aheadUpstream);
    render();
    await act(async () => chip().click());
    await act(async () => pushRow()!.click());

    expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "main");
    expect(menu()).toBeNull();
  });

  it("holds a refused push open with git's words instead of closing", async () => {
    seedBranch(aheadUpstream);
    backendMock.pushBranch.mockResolvedValueOnce({
      kind: "rejected",
      remote: "origin",
      detail: "! [rejected] main -> origin/main (non-fast-forward)",
    });
    render();
    await act(async () => chip().click());
    await act(async () => pushRow()!.click());

    expect(document.body.textContent).toContain("(non-fast-forward)");
    expect(menu()).not.toBeNull();
  });

  it("publishes an upstream-less branch into the default remote only when there is one", async () => {
    seedBranch({ current: "main", upstreamRef: null, hasUpstream: false, defaultRemote: "origin" });
    render();
    await act(async () => chip().click());

    expect(publishRow()?.textContent).toBe("publish main to origin");
    await act(async () => publishRow()!.click());
    expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "main");

    // A repo with no remote at all has nothing to publish into.
    act(() =>
      useStore.setState({
        branches: {
          "/p": branchInfo({ current: "main", upstreamRef: null, hasUpstream: false, defaultRemote: null }),
        },
      }),
    );
    expect(publishRow()).toBeUndefined();
  });

  it("confirms before sharing a branch a session is mid-turn on", async () => {
    seedBranch(aheadUpstream);
    seedBusy();
    render();
    await act(async () => chip().click());
    await act(async () => pushRow()!.click());

    expect(document.body.textContent).toContain("the branch is shared as it stands");
    expect(backendMock.pushBranch).not.toHaveBeenCalled();

    await act(async () => buttonByText("push anyway").click());
    expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "main");
  });

  it("links the branch to the default branch, and hides the link when they are one", async () => {
    seedBranch({ ...aheadUpstream, current: "feature/x", defaultBranch: "main" });
    render();
    await act(async () => chip().click());

    await act(async () => prRow()!.click());
    expect(backendMock.pullRequestUrl).toHaveBeenCalledWith("/p", "main", "feature/x");
    expect(window.open).toHaveBeenCalledWith(
      "https://github.com/o/r/compare/main...feature/x",
      "_blank",
      "noopener,noreferrer",
    );

    // The head *is* the default branch: a compare against itself is not a PR.
    act(() => useStore.setState({ branches: { "/p": branchInfo(aheadUpstream) } }));
    expect(prRow()).toBeUndefined();
  });

  it("explains a remote with no web face instead of opening a half-built URL", async () => {
    seedBranch({ ...aheadUpstream, current: "feature/x", defaultBranch: "main" });
    backendMock.pullRequestUrl.mockResolvedValueOnce(null);
    render();
    await act(async () => chip().click());
    await act(async () => prRow()!.click());

    expect(document.body.textContent).toContain("cannot build a pull-request URL for this remote");
    expect(window.open).not.toHaveBeenCalled();
  });
});
