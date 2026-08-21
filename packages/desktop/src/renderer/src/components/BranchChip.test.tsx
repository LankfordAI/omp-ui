// @vitest-environment jsdom
import { act, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList } from "@omp-ui/core/types";
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
};

const backendMock = {
  listBranches: vi.fn(async () => fixture),
  checkoutBranch: vi.fn(async () => {}),
  pullBranch: vi.fn(async () => {}),
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

/** One running session on the project — the busy-confirm trigger. */
function seedBusy(): void {
  useStore.setState({
    branches: { "/p": fixture },
    tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/p", hidden: false }],
    rpc: { "tab-1": { status: "running" } as unknown as RpcTabState },
    state: makeBackendState({
      projects: [
        {
          project: { path: "/p", name: "p", addedAt: "t", lastModel: null, lastAdvisorModel: null },
          sessions: [
            {
              tabId: "tab-1",
              sessionId: null,
              lineageDir: "omp-ui--p--11111111-2222-3333-4444-555555555555",
              projectCwd: "/p",
              launchedAt: "t",
              mode: "rpc-ui",
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

beforeEach(() => {
  vi.clearAllMocks();
  changes = [];
  workspaceDisabledFlag = false;
  workspaceOffered = true;
  backendMock.listBranches.mockResolvedValue(fixture);
  backendMock.pullBranch.mockResolvedValue(undefined);
  useStore.setState({
    branches: { "/p": fixture },
    branchActivity: {},
    branchDiffRevision: {},
    tabs: [],
    rpc: {},
    state: null,
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
});
