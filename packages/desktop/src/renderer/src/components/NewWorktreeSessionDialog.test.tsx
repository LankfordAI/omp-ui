// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BranchList, SpawnRequest } from "@omp-ui/core/types";

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
  defaultRemote: "origin",
};

// Only the channels the dialog's store path touches: the base list it
// refreshes on open, and the spawn its submit goes through.
const backendMock = {
  listBranches: vi.fn(async () => fixture),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  spawnSession: vi.fn<(request: SpawnRequest) => Promise<{ tabId: string }>>(async () => ({
    tabId: "wt-1",
  })),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { NewWorktreeSessionDialog } = await import("./NewWorktreeSessionDialog");

let root: Root | null = null;

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function seed(branches: Record<string, BranchList>): void {
  useStore.setState({
    branches,
    branchActivity: {},
    advisorDefaults: { "/p": { enabled: false, model: null } },
    tabs: [],
    activeTabId: null,
    focusedTabByProject: {},
    rpc: {},
    state: null,
    worktreeDialogProject: "/p",
  });
}

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<NewWorktreeSessionDialog projectCwd="/p" instanceId={null} />));
}

const branchInput = (): HTMLInputElement => {
  const input = document.body.querySelector<HTMLInputElement>("#worktree-branch");
  expect(input).not.toBeNull();
  return input!;
};

const baseSelect = (): HTMLSelectElement => {
  const select = document.body.querySelector<HTMLSelectElement>("#worktree-base");
  expect(select).not.toBeNull();
  return select!;
};

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
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

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.listBranches.mockResolvedValue(fixture);
  backendMock.spawnSession.mockResolvedValue({ tabId: "wt-1" });
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("NewWorktreeSessionDialog", () => {
  it("submits the edited branch and picked base, then closes the dialog", async () => {
    seed({ "/p": fixture });
    render();
    // The mount effect refreshes the branch list and defaults the base to
    // the checkout's current branch.
    await act(async () => {
      await flushMicrotasks();
    });

    const input = branchInput();
    expect(input.value).toMatch(/^omp-ui\/(?:main\/)?[0-9a-f]{8}$/);
    expect(baseSelect().value).toBe("main");

    await typeInto(input, "feature/mine");
    await selectInto(baseSelect(), "feature/x");

    act(() => buttonByText("Create session")!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    expect(backendMock.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "feature/mine", baseRef: "feature/x", baseBranch: null } },
    });
    expect(useStore.getState().worktreeDialogProject).toBeNull();
  });

  it("submits a null baseRef when the checkout detaches while the dialog is open", async () => {
    seed({ "/p": fixture });
    render();
    await act(async () => {
      await flushMicrotasks();
    });
    expect(baseSelect().value).toBe("main");

    // The listing refreshes while the dialog is open and the checkout has
    // since detached: the select collapses to the "current HEAD" option (plus
    // the trailing *new branch…*, which creates the base at HEAD, #405), and
    // the submitted base must follow HEAD.
    const detached: BranchList = { ...fixture, current: null };
    await act(async () => {
      useStore.setState({ branches: { "/p": detached } });
      await flushMicrotasks();
    });
    expect(baseSelect().value).toBe("");
    expect([...baseSelect().options].map((option) => option.textContent)).toEqual([
      "current HEAD",
      "new branch…",
    ]);

    await typeInto(branchInput(), "omp-ui/detached");
    act(() => buttonByText("Create session")!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    expect(backendMock.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "pty",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      worktree: { mint: { branch: "omp-ui/detached", baseRef: null, baseBranch: null } },
    });
  });

  it("submits a new base branch with the recomposed mint (issue #405)", async () => {
    seed({ "/p": fixture });
    render();
    await act(async () => {
      await flushMicrotasks();
    });
    const base = baseSelect();
    act(() => {
      base.value = "__new__";
      base.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await typeInto(
      document.body.querySelector<HTMLInputElement>("#worktree-new-base")!,
      "TECH-123",
    );

    act(() => buttonByText("Create session")!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    expect(backendMock.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: {
          mint: {
            branch: expect.stringMatching(/^omp-ui\/TECH-123\/[0-9a-f]{8}$/),
            baseRef: "main",
            baseBranch: "TECH-123",
          },
        },
      }),
    );
  });

  it("checks out an existing local branch when the source segment switches", async () => {
    // With only the checked-out branch, the segment offers nothing: disabled
    // with the hint, and the mint form stays the only path.
    const solo: BranchList = { ...fixture, branches: ["main"] };
    backendMock.listBranches.mockResolvedValue(solo);
    seed({ "/p": solo });
    render();
    await act(async () => {
      await flushMicrotasks();
    });

    const existingSegment = buttonByText("existing branch");
    expect(existingSegment).toBeDefined();
    expect(existingSegment!.disabled).toBe(true);
    expect(existingSegment!.title).toBe("no other local branch to check out");
    expect(document.body.querySelector("#worktree-branch")).not.toBeNull();

    // Another branch shows up in the listing: the segment lights up, its
    // select offers every branch but the checked-out one, and submitting
    // spawns a checkout of the picked branch (issue #390).
    await act(async () => {
      backendMock.listBranches.mockResolvedValue(fixture);
      useStore.setState({ branches: { "/p": fixture } });
      await flushMicrotasks();
    });
    expect(existingSegment!.disabled).toBe(false);
    act(() => existingSegment!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    const select = document.body.querySelector<HTMLSelectElement>("#worktree-existing");
    expect(select).not.toBeNull();
    expect([...select!.options].map((option) => option.textContent)).toEqual(["feature/x"]);
    await selectInto(select!, "feature/x");

    act(() => buttonByText("Create session")!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    expect(backendMock.spawnSession.mock.calls.at(-1)![0]).toMatchObject({
      projectCwd: "/p",
      worktree: { checkout: { branch: "feature/x" } },
    });
    expect(useStore.getState().worktreeDialogProject).toBeNull();
  });

  it("disables Create with a hint when the project isn't a git repo", async () => {
    // Load-bearing: the spread's "origin" must go null — no repo, no remote.
    const notGit: BranchList = { ...fixture, repoRoot: null, current: null, branches: [], defaultRemote: null };
    backendMock.listBranches.mockResolvedValue(notGit);
    seed({ "/p": notGit });
    render();
    await act(async () => {
      await flushMicrotasks();
    });

    expect(document.body.textContent).toContain(
      "This project isn't inside a git repo, so there's nothing to worktree.",
    );
    expect(document.body.querySelector("#worktree-branch")).toBeNull();
    const create = buttonByText("Create session");
    expect(create).toBeDefined();
    expect(create!.disabled).toBe(true);
  });
});
