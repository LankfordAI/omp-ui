// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  BranchList,
  MergeBackResult,
  MergeBackStatus,
  MergeDestination,
  SessionSummary,
  WorktreeReleaseResult,
  WorktreeSyncResult,
} from "@omp-ui/core/types";
import { backendState, rpcTabState } from "../test/fixtures";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "tab-1";
const BRANCH = "omp-ui/deadbeef";

const listing: BranchList = {
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

/** The clean default snapshot: main in the project checkout, 2 commits to land. */
const statusFixture = (overrides: Partial<MergeBackStatus> = {}): MergeBackStatus => ({
  destination: "main",
  destinationExists: true,
  destinationCheckout: "project",
  branchExists: true,
  mergeInProgress: false,
  alreadyMerged: false,
  ahead: 2,
  behind: 1,
  worktreeDirty: false,
  preview: { kind: "clean" },
  ...overrides,
});

const mergedResult: MergeBackResult = {
  kind: "merged",
  destination: "main",
  commits: 2,
  files: [],
  conflictsLeftIn: null,
};

const releaseResult: WorktreeReleaseResult = {
  worktreePath: "/wt/x",
  branch: BRANCH,
  projectCwd: "/p",
  checkoutKept: null,
  branchOutcome: "removed",
};

const backendMock = {
  listBranches: vi.fn(async () => listing),
  resolveMergeDestination: vi.fn(async (): Promise<MergeDestination> => ({
    destination: "main",
    reason: null,
  })),
  getMergeBackStatus: vi.fn(async (): Promise<MergeBackStatus> => statusFixture()),
  createBranch: vi.fn(async () => {}),
  mergeWorktreeBranch: vi.fn(async (): Promise<MergeBackResult> => mergedResult),
  releaseWorktree: vi.fn(async (): Promise<WorktreeReleaseResult> => releaseResult),
  syncWorktree: vi.fn(async (): Promise<WorktreeSyncResult> => ({
    kind: "merged",
    source: "main",
    files: [],
  })),
  renameWorktreeBranch: vi.fn(async () => {}),
  suggestBranchName: vi.fn(async (): Promise<string | null> => null),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: store.ts → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { FinishWorktreeDialog } = await import("./FinishWorktreeDialog");

let root: Root | null = null;

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

const summary: SessionSummary = {
  tabId: TAB,
  sessionId: null,
  lineageDir: "lineage-1",
  projectCwd: "/p",
  launchedAt: "2026-01-01T00:00:00.000Z",
  mode: "pty",
  worktree: { path: "/wt/x", branch: BRANCH, base: "main" },
  planImplementationSource: null,
  agentMode: "build",
  compactionMethod: null,
  model: null,
  thinkingLevel: null,
  advisor: false,
  advisorModel: null,
  cachedTitle: null,
  cachedModified: null,
  title: "Finish me",
  status: null,
  live: "live",
  pendingPlan: null,
  planSettle: null,
  streamStalled: false,
};

const stateWith = (session: SessionSummary): BackendState =>
  backendState({
    projects: [
      {
        project: {
          path: "/p",
          name: "p",
          addedAt: "2026-01-01T00:00:00.000Z",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
        },
        sessions: [session],
      },
    ],
  });

/** Mounts the dialog exactly the way App does: keyed on the open-dialog tab. */
function Harness() {
  const openTab = useStore((s) => s.finishWorktreeTab);
  return openTab === null ? null : <FinishWorktreeDialog key={openTab} tabId={openTab} />;
}

function seed(): void {
  useStore.setState({
    state: stateWith(summary),
    branches: { "/p": listing },
    branchActivity: {},
    tabs: [],
    activeTabId: null,
    focusedTabByProject: {},
    rpc: {},
    consoleOpen: {},
    finishWorktreeTab: TAB,
  });
}

function render(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<Harness />));
}

/** Render, mount, and drain the open-time chain (list → resolve → status). */
async function openDialog(): Promise<void> {
  seed();
  render();
  await act(async () => {
    await flushMicrotasks();
  });
}

const destinationSelect = (): HTMLSelectElement => {
  const el = document.body.querySelector<HTMLSelectElement>('select[id$="-dest"]');
  expect(el).not.toBeNull();
  return el!;
};

const newBranchNameInput = (): HTMLInputElement => {
  const el = document.body.querySelector<HTMLInputElement>('input[placeholder="release/next"]');
  expect(el).not.toBeNull();
  return el!;
};

const renameInput = (): HTMLInputElement => {
  const el = document.body.querySelector<HTMLInputElement>('input[id$="-rename"]');
  expect(el).not.toBeNull();
  return el!;
};

const returnCheckbox = (): HTMLInputElement => {
  const el = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
  expect(el).not.toBeNull();
  return el!;
};

/** The dialog's two outcome radios, in DOM order: merge, then keep. */
const outcomeRadios = (): HTMLInputElement[] => [
  ...document.body.querySelectorAll<HTMLInputElement>('input[type="radio"]'),
];

/** The dialog's solid primary button: the last one in the actions footer. */
const primaryButton = (): HTMLButtonElement => {
  const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("footer button")];
  expect(buttons.length).toBe(2);
  return buttons[1]!;
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

async function clickInput(input: HTMLInputElement): Promise<void> {
  await act(async () => {
    input.click();
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  backendMock.listBranches.mockResolvedValue(listing);
  backendMock.resolveMergeDestination.mockResolvedValue({ destination: "main", reason: null });
  backendMock.getMergeBackStatus.mockResolvedValue(statusFixture());
  backendMock.createBranch.mockResolvedValue(undefined);
  backendMock.mergeWorktreeBranch.mockResolvedValue(mergedResult);
  backendMock.releaseWorktree.mockResolvedValue(releaseResult);
  backendMock.syncWorktree.mockResolvedValue({ kind: "merged", source: "main", files: [] });
  backendMock.renameWorktreeBranch.mockResolvedValue(undefined);
  backendMock.suggestBranchName.mockResolvedValue(null);
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("FinishWorktreeDialog", () => {
  it("defaults the destination to the resolved base and reads status against the worktree checkout", async () => {
    backendMock.resolveMergeDestination.mockResolvedValue({
      destination: "feature/x",
      reason: null,
    });
    await openDialog();

    expect(backendMock.resolveMergeDestination).toHaveBeenCalledWith("/p", "main");
    expect(destinationSelect().value).toBe("feature/x");
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledWith("/p", BRANCH, "feature/x", "/wt/x");
  });

  it("refetches the status for the destination picked in the select", async () => {
    await openDialog();
    expect(destinationSelect().value).toBe("main");

    await selectInto(destinationSelect(), "feature/x");
    await act(async () => {
      await flushMicrotasks();
    });

    expect(backendMock.getMergeBackStatus).toHaveBeenLastCalledWith(
      "/p",
      BRANCH,
      "feature/x",
      "/wt/x",
    );
  });

  it("merges into a chosen new branch and reports it as the release destination", async () => {
    await openDialog();

    // Regression (found over CDP): entering "new branch…" whose default
    // start point equals the selected destination changes the MODE but not
    // the effective destination name; the status fetch must re-key on the
    // mode, or the dialog strands phase=loading ("checking the repo…"
    // forever) and run() refuses to start.
    await selectInto(destinationSelect(), "__new__");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(primaryButton().textContent).not.toContain("checking the repo");
    await typeInto(newBranchNameInput(), "release/next");

    act(() => primaryButton().click());
    await act(async () => {
      await flushMicrotasks();
    });
    expect(backendMock.createBranch).toHaveBeenCalledWith("/p", "release/next", "main");
    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith("/p", BRANCH, "release/next");
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB, {
      keepBranch: false,
      mergedInto: "release/next",
    });
    expect(useStore.getState().finishWorktreeTab).toBeNull();
  });

  it("renames the branch before releasing when keeping under a new name", async () => {
    await openDialog();

    await clickInput(outcomeRadios()[1]!); // keep the branch
    await typeInto(renameInput(), "omp-ui/renamed");

    act(() => primaryButton().click());
    await act(async () => {
      await flushMicrotasks();
    });

    // Rename precedes the release so the record carries the final name, and
    // nothing merges (issue #386).
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.renameWorktreeBranch).toHaveBeenCalledWith(TAB, "omp-ui/renamed");
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB, {
      keepBranch: true,
      mergedInto: null,
    });
    expect(backendMock.renameWorktreeBranch.mock.invocationCallOrder[0]!).toBeLessThan(
      backendMock.releaseWorktree.mock.invocationCallOrder[0]!,
    );
  });

  it("disables returning and offers a plain merge while the checkout is dirty", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(statusFixture({ worktreeDirty: true }));
    await openDialog();

    expect(document.body.textContent).toContain(
      "uncommitted changes in the checkout — commit them, or discard them, before returning",
    );
    expect(returnCheckbox().disabled).toBe(true);
    // Returning would fail in main, so the primary drops it: merge only.
    const primary = primaryButton();
    expect(primary.disabled).toBe(false);
    expect(primary.textContent).toBe("merge");
  });

  it("shows the preview conflicts, and a conflicting sync closes the dialog with a warn notice", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      statusFixture({ preview: { kind: "conflicts", files: ["src/a.ts", "src/b.ts"] } }),
    );
    backendMock.syncWorktree.mockResolvedValue({
      kind: "conflicts",
      source: "main",
      files: ["src/a.ts", "src/b.ts"],
    });
    // A notice only lands on a tab with transcript state; openDialog's seed
    // clears rpc, so attach it after the mount chain (session stays non-running).
    await openDialog();
    useStore.setState({ rpc: { [TAB]: rpcTabState() } });

    expect(document.body.textContent).toContain("src/a.ts");
    const sync = buttonByText("sync main into the worktree");
    expect(sync).toBeDefined();

    act(() => sync!.click());
    await act(async () => {
      await flushMicrotasks();
    });

    // Conflicts move to the worktree: the dialog is done (issue #387).
    expect(backendMock.syncWorktree).toHaveBeenCalledWith(TAB, "main");
    expect(useStore.getState().finishWorktreeTab).toBeNull();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    const items = useStore.getState().rpc[TAB]!.items;
    const notice = items.find((item) => item.kind === "notice");
    expect(notice).toBeDefined();
    expect(notice!.text).toContain("the sync of main stopped on 2 file(s) in /wt/x");
    expect(notice!.level).toBe("warn");
  });

  it("keeps the dialog on a conflict left in the project and releases nothing", async () => {
    backendMock.mergeWorktreeBranch.mockResolvedValue({
      kind: "conflicts",
      destination: "main",
      commits: 0,
      files: ["src/a.ts"],
      conflictsLeftIn: "project",
    });
    await openDialog();

    act(() => primaryButton().click()); // merge & return
    await act(async () => {
      await flushMicrotasks();
    });

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith("/p", BRANCH, "main");
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(useStore.getState().finishWorktreeTab).toBe(TAB);
    expect(document.body.textContent).toContain(
      "the merge stopped on 1 file(s) in the project checkout — nothing was returned",
    );
  });

  describe("primary label matrix", () => {
    const cases: Array<{
      name: string;
      outcome: "merge" | "keep";
      returnSession: boolean;
      alreadyMerged: boolean;
      renameTo: string | null;
      expected: string | null;
    }> = [
      { name: "merge + return", outcome: "merge", returnSession: true, alreadyMerged: false, renameTo: null, expected: "merge & return" },
      { name: "merge + return, already in", outcome: "merge", returnSession: true, alreadyMerged: true, renameTo: null, expected: "return" },
      { name: "merge + stay", outcome: "merge", returnSession: false, alreadyMerged: false, renameTo: null, expected: "merge" },
      { name: "merge + stay, already in", outcome: "merge", returnSession: false, alreadyMerged: true, renameTo: null, expected: null },
      { name: "keep + return + rename", outcome: "keep", returnSession: true, alreadyMerged: false, renameTo: "feature/renamed", expected: "rename & return" },
      { name: "keep + return", outcome: "keep", returnSession: true, alreadyMerged: false, renameTo: null, expected: "return, keep branch" },
      { name: "keep + stay + rename", outcome: "keep", returnSession: false, alreadyMerged: false, renameTo: "feature/renamed", expected: "rename" },
      { name: "keep + stay", outcome: "keep", returnSession: false, alreadyMerged: false, renameTo: null, expected: null },
    ];

    it.each(cases)("$name", async ({ outcome, returnSession, alreadyMerged, renameTo, expected }) => {
      backendMock.getMergeBackStatus.mockResolvedValue(statusFixture({ alreadyMerged }));
      await openDialog();

      if (outcome === "keep") await clickInput(outcomeRadios()[1]!);
      if (!returnSession) await clickInput(returnCheckbox());
      if (renameTo !== null) await typeInto(renameInput(), renameTo);

      const primary = primaryButton();
      if (expected === null) {
        expect(primary.disabled).toBe(true);
      } else {
        expect(primary.disabled).toBe(false);
        expect(primary.textContent).toBe(expected);
      }
    });
  });
});
