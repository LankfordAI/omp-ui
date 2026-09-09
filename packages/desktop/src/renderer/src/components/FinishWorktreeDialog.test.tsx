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
  PushResult,
  SessionSummary,
  WorktreeReleaseResult,
  WorktreeSyncResult,
} from "@omp-ui/core/types";
import { backendState, rpcTabState, tabInfo } from "../test/fixtures";
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB = "tab-1";
const BRANCH = "p/deadbeef";

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
  // The repo has an origin: the done row's publish target and PR host.
  defaultRemote: "origin",
};

/**
 * The clean default snapshot: main in the project checkout, 2 commits to land,
 * and a destination 2 ahead of its own upstream — the finished state the done
 * row offers to push (issue #414).
 */
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
  destinationUpstream: "origin/main",
  destinationAhead: 2,
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
  checkoutSwitch: { kind: "none" },
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
  pushBranch: vi.fn(async (): Promise<PushResult> => ({
    kind: "pushed",
    remote: "origin",
    upstreamRef: "origin/main",
    commits: 2,
  })),
  pullRequestUrl: vi.fn(async (): Promise<string | null> => "https://example.run/pr/new"),
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

function seed(branch: string = BRANCH): void {
  useStore.setState({
    state: stateWith(
      branch === BRANCH
        ? summary
        : { ...summary, worktree: { path: "/wt/x", branch, base: "main" } },
    ),
    branches: { "/p": listing },
    branchActivity: { "/p": { refreshing: false, pulling: false, pushing: false } },
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
async function openDialog(branch: string = BRANCH): Promise<void> {
  seed(branch);
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
  backendMock.pushBranch.mockResolvedValue({
    kind: "pushed",
    remote: "origin",
    upstreamRef: "origin/main",
    commits: 2,
  });
  backendMock.pullRequestUrl.mockResolvedValue("https://example.run/pr/new");
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

  it("merges into a chosen new branch, releases it, and stops on the done row", async () => {
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
      checkoutOnReturn: "release/next",
    });
    // A merge that moved commits no longer closes the dialog: the work is
    // landed locally, and sharing it is the done row's call (issue #414).
    expect(useStore.getState().finishWorktreeTab).toBe(TAB);
    expect(document.body.textContent).toContain("merged 2 commits into release/next");
  });

  it("prefills the destination new branch's name from the model (issue #428)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/x");
    await openDialog();

    // The dialog asks the model once on open, so the reveal never waits on it.
    expect(backendMock.suggestBranchName).toHaveBeenCalledWith("/p", "Finish me");
    await selectInto(destinationSelect(), "__new__");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(newBranchNameInput().value).toBe("feat/x");

    act(() => primaryButton().click());
    await act(async () => {
      await flushMicrotasks();
    });
    // The prefilled name is the field's real value: run cuts it and merges in.
    expect(backendMock.createBranch).toHaveBeenCalledWith("/p", "feat/x", "main");
    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith("/p", BRANCH, "feat/x");
  });

  it("lands a late suggestion in an untouched revealed destination name (issue #428)", async () => {
    let resolveSuggest!: (value: string | null) => void;
    backendMock.suggestBranchName.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    await openDialog();
    await selectInto(destinationSelect(), "__new__");
    await act(async () => {
      await flushMicrotasks();
    });
    expect(newBranchNameInput().value).toBe("");

    await act(async () => {
      resolveSuggest("feat/x");
      await flushMicrotasks();
    });
    expect(newBranchNameInput().value).toBe("feat/x");
  });

  it("never displaces a typed destination name with a late suggestion (issue #428)", async () => {
    let resolveSuggest!: (value: string | null) => void;
    backendMock.suggestBranchName.mockReturnValue(
      new Promise<string | null>((resolve) => {
        resolveSuggest = resolve;
      }),
    );
    await openDialog();
    await selectInto(destinationSelect(), "__new__");
    await act(async () => {
      await flushMicrotasks();
    });
    await typeInto(newBranchNameInput(), "release/next");

    await act(async () => {
      resolveSuggest("feat/x");
      await flushMicrotasks();
    });
    expect(newBranchNameInput().value).toBe("release/next");
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
      checkoutOnReturn: null,
    });
    // Keeping merges nothing, so there is nothing to share: the finish closes
    // exactly as it did before the done phase (issue #414).
    expect(useStore.getState().finishWorktreeTab).toBeNull();
    expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
    expect(backendMock.renameWorktreeBranch.mock.invocationCallOrder[0]!).toBeLessThan(
      backendMock.releaseWorktree.mock.invocationCallOrder[0]!,
    );
  });

  it("pre-fills the rename field from the model for this project's mint (issue #438)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/x");
    // BRANCH is `p/deadbeef`: a mint under the fixture project's own prefix.
    await openDialog();

    await clickInput(outcomeRadios()[1]!); // keep the branch
    expect(renameInput().value).toBe("feat/x");
  });

  it("leaves a hand-typed branch name alone when the suggestion lands (issue #438)", async () => {
    backendMock.suggestBranchName.mockResolvedValue("feat/x");
    await openDialog("feature/mine");

    await clickInput(outcomeRadios()[1]!); // keep the branch
    expect(renameInput().value).toBe("feature/mine");
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

  // The done phase (issue #414): a merged finish stops with the work landed
  // locally, and sharing it stays one explicit row.
  describe("done phase", () => {
    /** Finish with the dialog's own defaults: merge & return into `main`. */
    const finishMerged = async (): Promise<void> => {
      await openDialog();
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });
    };

    /** The done phase's footer holds one button: the dialog's own dismissal. */
    const doneButton = (): HTMLButtonElement => {
      const buttons = [...document.body.querySelectorAll<HTMLButtonElement>("footer button")];
      expect(buttons.length).toBe(1);
      return buttons[0]!;
    };

    const pushRow = (): HTMLButtonElement | undefined =>
      buttonByText("push main — 2 commits to origin/main");

    it("lands without closing, and offers the destination's push", async () => {
      await finishMerged();

      expect(useStore.getState().finishWorktreeTab).toBe(TAB);
      expect(document.body.textContent).toContain("merged 2 commits into main");
      expect(pushRow()).toBeDefined();
      // The row is inert: the finish already ran, so the footer offers only
      // dismissal, never a second merge.
      expect(doneButton().textContent).toBe("done");
    });

    it("closes an already-merged return with no done row to push from", async () => {
      backendMock.getMergeBackStatus.mockResolvedValue(statusFixture({ alreadyMerged: true }));
      await openDialog();

      act(() => primaryButton().click()); // return
      await act(async () => {
        await flushMicrotasks();
      });

      // No merge ran, so nothing landed and nothing is owed to a remote.
      expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
      expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB, {
        keepBranch: false,
        mergedInto: "main",
        checkoutOnReturn: null,
      });
      expect(useStore.getState().finishWorktreeTab).toBeNull();
    });

    it("counts the push row from the state the merge left, not the state it started from", async () => {
      // The status the dialog rendered while choosing the destination said
      // main held nothing beyond origin/main. The merge then landed two
      // commits on it, so the done row must read the AFTER state (issue #414).
      backendMock.getMergeBackStatus
        .mockResolvedValueOnce(statusFixture({ destinationAhead: 0 }))
        .mockResolvedValueOnce(statusFixture({ destinationAhead: 2 }));
      await openDialog();

      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(document.body.textContent).toContain("merged 2 commits into main");
      expect(buttonByText("push main — 2 commits to origin/main")).toBeDefined();
    });

    it("survives its own release: main nulls the worktree mid-finish", async () => {
      // session-manager's demote() writes `worktree: null` to the registry and
      // broadcasts before releaseWorktree resolves, so the record the dialog
      // renders from loses its worktree while the done phase is being entered.
      // The row must outlive that, or a merged finish closes on the user.
      backendMock.releaseWorktree.mockImplementationOnce(async () => {
        useStore.setState({ state: stateWith({ ...summary, worktree: null }) });
        return releaseResult;
      });
      await openDialog();
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(useStore.getState().finishWorktreeTab).toBe(TAB);
      expect(document.body.textContent).toContain("merged 2 commits into main");
      expect(document.body.textContent).toContain("Finish p/deadbeef?");
      expect(buttonByText("push main — 2 commits to origin/main")).toBeDefined();
    });

    it("pushes the landed destination and settles with the upstream it reached", async () => {
      await finishMerged();

      act(() => pushRow()!.click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "main");
      expect(document.body.textContent).toContain("pushed 2 commits to origin/main");
      // The destination is the repo's own default branch: a pull request would
      // compare main against itself.
      expect(buttonByText("open pull request")).toBeUndefined();
    });

    it("opens the host's pull request for a pushed destination that is not the default branch", async () => {
      const opened = vi.spyOn(window, "open").mockReturnValue(null);
      backendMock.getMergeBackStatus.mockResolvedValue(
        statusFixture({ destination: "feature/x", destinationUpstream: "origin/feature/x" }),
      );
      await openDialog();
      await selectInto(destinationSelect(), "feature/x");
      await act(async () => {
        await flushMicrotasks();
      });

      act(() => primaryButton().click()); // merge & return into feature/x
      await act(async () => {
        await flushMicrotasks();
      });
      expect(document.body.textContent).toContain("merged 2 commits into feature/x");

      // The settled line names the ref core actually pushed to, so the mock
      // has to answer as the real channel would for this destination.
      backendMock.pushBranch.mockResolvedValueOnce({
        kind: "pushed",
        remote: "origin",
        upstreamRef: "origin/feature/x",
        commits: 2,
      });
      act(() => buttonByText("push feature/x — 2 commits to origin/feature/x")!.click());
      await act(async () => {
        await flushMicrotasks();
      });
      expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "feature/x");
      expect(document.body.textContent).toContain("pushed 2 commits to origin/feature/x");

      act(() => buttonByText("open pull request")!.click());
      await act(async () => {
        await flushMicrotasks();
      });
      expect(backendMock.pullRequestUrl).toHaveBeenCalledWith("/p", "main", "feature/x");
      expect(opened).toHaveBeenCalledWith(
        "https://example.run/pr/new",
        "_blank",
        "noopener,noreferrer",
      );
      opened.mockRestore();
    });

    it("says so in place when the remote has no pull-request page", async () => {
      const opened = vi.spyOn(window, "open").mockReturnValue(null);
      backendMock.getMergeBackStatus.mockResolvedValue(
        statusFixture({ destination: "feature/x", destinationUpstream: "origin/feature/x" }),
      );
      backendMock.pullRequestUrl.mockResolvedValue(null);
      await openDialog();
      await selectInto(destinationSelect(), "feature/x");
      await act(async () => {
        await flushMicrotasks();
      });
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });
      act(() => buttonByText("push feature/x — 2 commits to origin/feature/x")!.click());
      await act(async () => {
        await flushMicrotasks();
      });

      act(() => buttonByText("open pull request")!.click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(document.body.textContent).toContain(
        "cannot build a pull-request URL for this remote",
      );
      expect(opened).not.toHaveBeenCalled();
      opened.mockRestore();
    });

    it("publishes a destination whose branch has no upstream", async () => {
      backendMock.getMergeBackStatus.mockResolvedValue(
        statusFixture({ destinationUpstream: null, destinationAhead: null }),
      );
      backendMock.pushBranch.mockResolvedValue({
        kind: "published",
        remote: "origin",
        upstreamRef: "origin/main",
        commits: 2,
      });
      await finishMerged();

      const publish = buttonByText("publish main to origin");
      expect(publish).toBeDefined();
      act(() => publish!.click());
      await act(async () => {
        await flushMicrotasks();
      });

      // Publishing is the same `git push`, first-time and with `-u`.
      expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "main");
      expect(document.body.textContent).toContain("published main to origin");
    });

    it("offers nothing to share once the remote already has the destination", async () => {
      backendMock.getMergeBackStatus.mockResolvedValue(statusFixture({ destinationAhead: 0 }));
      await finishMerged();

      expect(document.body.textContent).toContain("merged 2 commits into main");
      expect(pushRow()).toBeUndefined();
      expect(buttonByText("publish main to origin")).toBeUndefined();
    });

    it("names the ref a refusal came against, with git's answer, and pushes nothing else", async () => {
      backendMock.pushBranch.mockResolvedValue({
        kind: "rejected",
        remote: "origin",
        detail: "! [rejected] main -> main (fetch first)",
      });
      await finishMerged();

      act(() => pushRow()!.click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(backendMock.pushBranch).toHaveBeenCalledTimes(1);
      expect(document.body.textContent).toContain(
        "origin/main has commits this branch lacks — pull first, then push",
      );
      expect(document.body.textContent).toContain("! [rejected] main -> main (fetch first)");
      expect(buttonByText("open pull request")).toBeUndefined();
    });

    it("pushes nothing when the done row is dismissed", async () => {
      await finishMerged();
      expect(pushRow()).toBeDefined();

      act(() => doneButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(useStore.getState().finishWorktreeTab).toBeNull();
      expect(document.body.querySelector('[role="alertdialog"]')).toBeNull();
      expect(backendMock.pushBranch).not.toHaveBeenCalled();
    });

    it("confirms before sharing a branch a mid-turn session holds, then honours the answer", async () => {
      await openDialog();
      useStore.setState({ rpc: { [TAB]: rpcTabState({ status: "running" }) } });
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      act(() => pushRow()!.click());
      expect(document.body.textContent).toContain(
        "session “Finish me” is mid-turn — the branch is shared as it stands",
      );
      expect(backendMock.pushBranch).not.toHaveBeenCalled();

      // Cancel leaves the branch unshared and the row back where it was.
      act(() => buttonByText("cancel")!.click());
      expect(backendMock.pushBranch).not.toHaveBeenCalled();
      expect(pushRow()).toBeDefined();

      // The confirm is a gate, not a dead end: the same row pushes on the
      // second answer.
      act(() => pushRow()!.click());
      act(() => buttonByText("push anyway")!.click());
      await act(async () => {
        await flushMicrotasks();
      });
      expect(backendMock.pushBranch).toHaveBeenCalledWith("/p", "main");
    });
  });

  describe("the return lands on the destination (issue #431)", () => {
    const notices = (): Array<{ text: string; level?: string }> => {
      const items = useStore.getState().rpc[TAB]?.items ?? [];
      return items.filter((item) => item.kind === "notice");
    };

    /** The finish run for the destination the caller chooses, to "project"
     *  (the checkout holds it) or "none" (a scratch merge moved it nowhere). */
    const finishInto = async (destination: string): Promise<void> => {
      await openDialog();
      await selectInto(destinationSelect(), destination);
      await act(async () => {
        await flushMicrotasks();
      });
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });
    };

    it("asks for no switch when the project checkout holds the destination", async () => {
      await finishInto("feature/x");

      // The merge ran in the project checkout, so HEAD is already there: the
      // default path must stay a path with no `git checkout` in it.
      expect(backendMock.releaseWorktree).toHaveBeenLastCalledWith(TAB, {
        keepBranch: false,
        mergedInto: "feature/x",
        checkoutOnReturn: null,
      });
    });

    it("asks for the switch when that same destination is held nowhere", async () => {
      backendMock.getMergeBackStatus.mockResolvedValue(
        statusFixture({ destination: "feature/x", destinationCheckout: "none" }),
      );
      await finishInto("feature/x");

      // A scratch merge leaves the project checkout on the branch it started
      // on, which is exactly the reported defect: the return has to move it.
      expect(backendMock.releaseWorktree).toHaveBeenLastCalledWith(TAB, {
        keepBranch: false,
        mergedInto: "feature/x",
        checkoutOnReturn: "feature/x",
      });
    });

    it("names the branch the session returned on", async () => {
      backendMock.releaseWorktree.mockResolvedValueOnce({
        ...releaseResult,
        checkoutSwitch: { kind: "switched", branch: "release/next" },
      });
      await openDialog();
      // A notice only lands on a tab with transcript state (openDialog seeds
      // rpc empty), so attach it before the run.
      useStore.setState({ rpc: { [TAB]: rpcTabState() } });
      await selectInto(destinationSelect(), "__new__");
      await act(async () => {
        await flushMicrotasks();
      });
      await typeInto(newBranchNameInput(), "release/next");
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(notices()[0]!.text).toContain(
        "merged p/deadbeef (2 commits) into release/next — this session now runs in /p on release/next",
      );
    });

    it("says the switch was refused when git would not move the checkout", async () => {
      backendMock.releaseWorktree.mockResolvedValueOnce({
        ...releaseResult,
        checkoutSwitch: {
          kind: "failed",
          branch: "release/next",
          error: "error: Your local changes to the following files would be overwritten by checkout",
        },
      });
      await openDialog();
      useStore.setState({ rpc: { [TAB]: rpcTabState() } });
      await selectInto(destinationSelect(), "__new__");
      await act(async () => {
        await flushMicrotasks();
      });
      await typeInto(newBranchNameInput(), "release/next");
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      const refusal = notices()[0]!;
      expect(refusal.text).toContain(
        "The switch to release/next was refused: error: Your local changes",
      );
      // The release completed; only the landing failed, so it is not info.
      expect(refusal.level).toBe("warn");
    });

    it("warns before the click and withholds the switch for a mid-turn sibling", async () => {
      await openDialog();
      const withBusy = stateWith(summary);
      withBusy.projects[0]!.sessions.push({
        ...summary,
        tabId: "tab-other",
        title: "Busy",
        worktree: null,
      });
      useStore.setState({
        state: withBusy,
        tabs: [tabInfo({ tabId: "tab-other", projectCwd: "/p", hidden: false })],
        rpc: { [TAB]: rpcTabState(), "tab-other": rpcTabState({ status: "running" }) },
      });
      await act(async () => {
        await flushMicrotasks();
      });
      await selectInto(destinationSelect(), "__new__");
      await act(async () => {
        await flushMicrotasks();
      });
      await typeInto(newBranchNameInput(), "release/next");

      expect(document.body.textContent).toContain(
        "session “Busy” is mid-turn in the project — returning would move its checkout to release/next, so the checkout is left alone",
      );

      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      // The finish still runs; only the switch is withheld — and it says so.
      expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB, {
        keepBranch: false,
        mergedInto: "release/next",
        checkoutOnReturn: null,
      });
      const skipped = notices().find((item) => item.text.includes("was left on its own branch"));
      expect(skipped).toBeDefined();
      expect(skipped!.text).toContain(
        "the project checkout was left on its own branch — session “Busy” is mid-turn there; the work is in release/next",
      );
      expect(skipped!.level).toBe("warn");
    });

    it("never switches onto the session's own branch when keeping it", async () => {
      await openDialog();
      await clickInput(outcomeRadios()[1]!); // keep the branch
      // The hint stays the plain keep-and-return promise: nothing lands anywhere.
      expect(document.body.textContent).toContain(
        "the checkout is removed; the branch p/deadbeef stays",
      );
      act(() => primaryButton().click());
      await act(async () => {
        await flushMicrotasks();
      });

      expect(backendMock.releaseWorktree).toHaveBeenLastCalledWith(TAB, {
        keepBranch: true,
        mergedInto: null,
        checkoutOnReturn: null,
      });
    });
  });
});
