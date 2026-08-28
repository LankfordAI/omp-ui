// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  BranchList,
  MergeBackResult,
  MergeBackStatus,
  SessionWorktree,
  WorktreeReleaseResult,
} from "@omp-ui/core/types";
import { backendState as makeBackendState, rpcTabState, tabInfo } from "../test/fixtures";
import type { RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const TAB_ID = "tab-worktree";
const PROJECT_CWD = "/project";

const branchFixture: BranchList = {
  repoRoot: "/project",
  current: "main",
  branches: ["main", "omp/feature"],
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
  getProjectOpenAvailability: vi.fn<() => Promise<{ vsCode: boolean; terminal: boolean }>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files" | "terminal") => Promise<void>>(),
  // The store's merge action refreshes the branch list after a completed merge.
  listBranches: vi.fn<() => Promise<BranchList>>(),
  getMergeBackStatus: vi.fn<(projectCwd: string, branch: string, base: string | null) => Promise<MergeBackStatus>>(),
  mergeWorktreeBranch: vi.fn<(projectCwd: string, branch: string, destination: string) => Promise<MergeBackResult>>(),
  deleteSessionPreview: vi.fn<(tabId: string) => Promise<{ descendants: Array<{ tabId: string; title: string; running: boolean }> }>>(
    async () => ({ descendants: [] }),
  ),
  deleteSession: vi.fn<(tabId: string, cascade: boolean) => Promise<void>>(async () => {}),
  releaseWorktree: vi.fn<(tabId: string) => Promise<WorktreeReleaseResult>>(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: ../store → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { WorktreeChip } = await import("./WorktreeChip");

const worktree: SessionWorktree = {
  path: "/worktrees/alpha/omp-feature",
  branch: "omp/feature",
  base: "main",
};

const status = (patch: Partial<MergeBackStatus> = {}): MergeBackStatus => ({
  destination: "main",
  reason: null,
  destinationCheckedOut: true,
  branchExists: true,
  mergeInProgress: false,
  alreadyMerged: false,
  ahead: 3,
  ...patch,
});

const mergedResult: MergeBackResult = {
  kind: "merged",
  destination: "main",
  commits: 3,
  files: [],
};

const releaseResult: WorktreeReleaseResult = {
  worktreePath: worktree.path,
  branch: worktree.branch,
  projectCwd: PROJECT_CWD,
  checkoutKept: null,
  branchOutcome: "removed",
};

let root: Root | null = null;

function seedStore(
  patch: {
    tabs?: ReturnType<typeof tabInfo>[];
    state?: ReturnType<typeof makeBackendState> | null;
    rpc?: Record<string, RpcTabState>;
    consoleOpen?: Record<string, boolean>;
  } = {},
): void {
  useStore.setState({
    tabs: [],
    state: null,
    rpc: {},
    consoleOpen: {},
    ...patch,
  });
}

/** One running session in the project checkout — the busy-confirm trigger. */
function seedBusy(): void {
  seedStore({
    tabs: [tabInfo({ tabId: "tab-busy" })],
    rpc: { "tab-busy": rpcTabState({ status: "running" }) },
    state: makeBackendState({
      projects: [
        {
          project: { path: PROJECT_CWD, name: "project", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
          sessions: [
            {
              tabId: "tab-busy",
              sessionId: null,
              lineageDir: "omp-ui--project--11111111-2222-3333-4444-555555555555",
              projectCwd: PROJECT_CWD,
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
              title: "Busy Session",
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

/**
 * A second session record in this chip's checkout — a fork or a plan handoff
 * that reused it. Its presence is what the release keeps the checkout for.
 */
function stateWithSharer(): BackendState {
  return makeBackendState({
    projects: [
      {
        project: {
          path: PROJECT_CWD,
          name: "project",
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
            tabId: "tab-sharer",
            sessionId: null,
            lineageDir: "omp-ui--project--22222222-2222-3333-4444-555555555555",
            projectCwd: PROJECT_CWD,
            launchedAt: "t",
            mode: "rpc-ui",
            worktree,
            planImplementationSource: null,
            agentMode: "build",
            compactionMethod: null,
            model: null,
            thinkingLevel: null,
            advisor: false,
            advisorModel: null,
            cachedTitle: null,
            cachedModified: null,
            title: "Descendant",
            status: null,
            live: "live",
            pendingPlan: null,
            planSettle: null,
            streamStalled: false,
          },
        ],
      },
    ],
  });
}

function render(patch: Partial<SessionWorktree> = {}): void {
  if (root !== null) {
    act(() => root!.unmount());
    document.body.replaceChildren();
  }
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() =>
    root!.render(
      <WorktreeChip
        worktree={{ ...worktree, ...patch }}
        tabId={TAB_ID}
        projectCwd={PROJECT_CWD}
      />,
    ),
  );
}

const trigger = (): HTMLButtonElement => {
  const found = document.body.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]');
  expect(found).not.toBeNull();
  return found!;
};

const menu = (): HTMLElement | null => document.body.querySelector<HTMLElement>('[role="menu"]');

const menuItem = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find(
    (el) => el.textContent === text,
  );

/** The merge row (pending, merging, or mergeable) — never the open targets. */
const mergeRow = (): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')].find((el) =>
    el.textContent?.startsWith("merg"),
  );

const dialog = (): HTMLElement | null =>
  document.body.querySelector<HTMLElement>('[role="alertdialog"]');

const dialogButton = (text: string): HTMLButtonElement | undefined =>
  [...(dialog()?.querySelectorAll<HTMLButtonElement>("button") ?? [])].find(
    (el) => el.textContent === text,
  );

const buttonByText = (text: string): HTMLButtonElement | undefined =>
  [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (el) => el.textContent === text,
  );

const consoleOpenState = (): boolean | undefined => useStore.getState().consoleOpen[TAB_ID];

const notices = (): Array<{ text: string; level?: string }> =>
  (useStore.getState().rpc[TAB_ID]?.items ?? [])
    .filter((item) => item.kind === "notice")
    .map((item) => ({ text: item.text, level: item.level }));

async function openPopover(): Promise<void> {
  await act(async () => trigger().click());
  await flushMicrotasks();
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
  backendMock.getProjectOpenAvailability.mockReset();
  backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: false, terminal: false });
  backendMock.openProject.mockReset();
  backendMock.openProject.mockResolvedValue(undefined);
  backendMock.listBranches.mockReset();
  backendMock.listBranches.mockResolvedValue(branchFixture);
  backendMock.getMergeBackStatus.mockReset();
  backendMock.getMergeBackStatus.mockResolvedValue(status());
  backendMock.mergeWorktreeBranch.mockReset();
  backendMock.mergeWorktreeBranch.mockRejectedValue(new Error("unexpected merge"));
  backendMock.deleteSessionPreview.mockReset();
  backendMock.deleteSessionPreview.mockResolvedValue({ descendants: [] });
  backendMock.deleteSession.mockReset();
  backendMock.deleteSession.mockResolvedValue(undefined);
  backendMock.releaseWorktree.mockReset();
  backendMock.releaseWorktree.mockResolvedValue(releaseResult);
  seedStore();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("WorktreeChip (issue #260)", () => {
  it("renders the chip trigger with the checkout path as tooltip", () => {
    render();
    const button = trigger();
    expect(button.textContent).toContain("⎇ omp/feature");
    expect(button.title).toBe(worktree.path);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(menu()).toBeNull();
  });

  it("opens a popover listing branch and path with copy buttons", async () => {
    render();
    await openPopover();

    const popover = menu();
    expect(popover).not.toBeNull();
    expect(trigger().getAttribute("aria-expanded")).toBe("true");
    expect(popover!.textContent).toContain("omp/feature");
    expect(popover!.textContent).toContain(worktree.path);
    const copies = [...popover!.querySelectorAll<HTMLButtonElement>("button")].filter(
      (el) => el.textContent === "copy",
    );
    expect(copies).toHaveLength(2);
  });

  it("offers Open in VS Code only when availability resolves true, and opens with it", async () => {
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: true, terminal: false });
    render();
    await openPopover();

    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledTimes(1);
    const vscode = menuItem("Open in VS Code");
    expect(vscode).toBeDefined();
    await act(async () => vscode!.click());
    expect(backendMock.openProject).toHaveBeenCalledWith(worktree.path, "vscode");

    // Availability is asked once per mount — reopening does not re-probe.
    act(() => trigger().click());
    await openPopover();
    expect(backendMock.getProjectOpenAvailability).toHaveBeenCalledTimes(1);
  });

  it("hides Open in VS Code when availability resolves false or rejects", async () => {
    render();
    await openPopover();
    expect(menuItem("Open in VS Code")).toBeUndefined();
    act(() => trigger().click());

    backendMock.getProjectOpenAvailability.mockRejectedValue(new Error("no channel"));
    render();
    await openPopover();
    expect(menuItem("Open in VS Code")).toBeUndefined();
  });

  it("always offers Open in Files and hands it the checkout path", async () => {
    render();
    await openPopover();

    const files = menuItem("Open in Files");
    expect(files).toBeDefined();
    await act(async () => files!.click());
    expect(backendMock.openProject).toHaveBeenCalledWith(worktree.path, "files");
  });

  it("surfaces a rejected open as an alert and keeps the popover up", async () => {
    backendMock.openProject.mockRejectedValue(new Error("xdg-open failed"));
    render();
    await openPopover();

    await act(async () => menuItem("Open in Files")!.click());
    expect(menu()).not.toBeNull();
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("xdg-open failed");
  });

  it("closes on Escape and restores focus to the trigger", async () => {
    render();
    await openPopover();
    expect(menu()).not.toBeNull();

    act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
      ),
    );
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(trigger());
  });

  it("closes on an outside pointerdown", async () => {
    render();
    await openPopover();
    expect(menu()).not.toBeNull();

    act(() => document.body.dispatchEvent(new Event("pointerdown", { bubbles: true })));
    expect(menu()).toBeNull();
  });

  it("renders the cut-from line verbatim for a ref base", async () => {
    render();
    await openPopover();
    expect(menu()!.textContent).toContain("cut from main");
  });

  it("shortens a 40-hex commit base in the cut-from line", async () => {
    render({ base: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" });
    await openPopover();
    expect(menu()!.textContent).toContain("cut from a1b2c3d4");
    expect(menu()!.textContent).not.toContain("cut from a1b2c3d4e");
  });

  it("omits the cut-from line for a null base (pre-field record)", async () => {
    render({ base: null });
    await openPopover();
    expect(menu()!.textContent).not.toContain("cut from");
  });
});

describe("WorktreeChip merge-back (issue #272)", () => {
  it("offers the merge row with the commit count when mergeable, and reads the status on open", async () => {
    render();
    await openPopover();

    expect(backendMock.getMergeBackStatus).toHaveBeenCalledWith(
      PROJECT_CWD,
      worktree.branch,
      worktree.base,
    );
    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(false);
    expect(row!.textContent).toBe("merge into main · 3 commits");
  });

  it("uses the singular commit wording for one commit", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(status({ ahead: 1 }));
    render();
    await openPopover();

    expect(mergeRow()!.textContent).toBe("merge into main · 1 commit");
  });

  it("notes that a successful merge returns the session to the base branch", async () => {
    render();
    await openPopover();

    expect(menu()!.textContent).toContain(
      "a successful merge returns this session to main — the checkout and the branch are " +
        "removed, the session and its transcript are kept",
    );
  });

  it("shows a disabled pending row while the status read is in flight", async () => {
    const pending = deferred<MergeBackStatus>();
    backendMock.getMergeBackStatus.mockReturnValueOnce(pending.promise);
    render();
    await openPopover();

    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
    expect(row!.textContent).toBe("merge into main");
    void pending;
  });

  it("shortens a 40-hex commit base in the pending row", async () => {
    const pending = deferred<MergeBackStatus>();
    backendMock.getMergeBackStatus.mockReturnValueOnce(pending.promise);
    render({ base: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" });
    await openPopover();

    expect(mergeRow()!.textContent).toBe("merge into a1b2c3d4");
    void pending;
  });

  it("skips the status read entirely for a null base (pre-field record)", async () => {
    render({ base: null });
    await openPopover();

    expect(backendMock.getMergeBackStatus).not.toHaveBeenCalled();
    expect(mergeRow()).toBeUndefined();
    expect(buttonByText("open console")).toBeUndefined();
  });

  it("surfaces a rejected status read in the error slot", async () => {
    backendMock.getMergeBackStatus.mockRejectedValue(new Error("status failed"));
    render();
    await openPopover();
    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("status failed");
    // Status stays null — the row remains, disabled, beside the error slot.
    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
  });

  it("confirms in the rose modal, merges, and returns the session to the base branch", async () => {
    seedStore({ tabs: [tabInfo({ tabId: TAB_ID })], rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce(mergedResult);
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());

    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Irreversible action");
    expect(d!.textContent).toContain(
      "Merge omp/feature into main and return this session to it?",
    );
    expect(d!.textContent).toContain(
      "Writes a merge commit in the project checkout recording the 3 committed change(s) on " +
        "omp/feature — their subjects and any issues they close. Uncommitted changes in the " +
        "worktree are not included.",
    );
    expect(d!.textContent).toContain(
      "This session then returns to main in /project: its agent restarts there with its " +
        "transcript intact. The checkout /worktrees/alpha/omp-feature is removed — uncommitted " +
        "changes there are lost — and the branch omp/feature is deleted.",
    );
    expect(d!.textContent).toContain(
      "A conflicted merge stops both the merge and the return: the project checkout is left " +
        "with files to resolve, and this session stays on omp/feature.",
    );
    // Nothing is cascade-deleted any more: no descendant preview is read.
    expect(backendMock.deleteSessionPreview).not.toHaveBeenCalled();

    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith(PROJECT_CWD, "omp/feature", "main");
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB_ID);
    // The session survives: its tab and rpc slot stay, nothing is deleted.
    expect(backendMock.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.some((t) => t.tabId === TAB_ID)).toBe(true);
    expect(useStore.getState().rpc[TAB_ID]).toBeDefined();
    expect(notices()).toEqual([
      {
        text:
          "merged omp/feature (3 commits) into the project checkout — this session now runs in " +
          "/project. The checkout and branch omp/feature are gone.",
        level: "info",
      },
    ]);
    expect(dialog()).toBeNull();
  });

  it("warns in the confirm when another session shares the checkout", async () => {
    seedStore({
      tabs: [tabInfo({ tabId: TAB_ID })],
      rpc: { [TAB_ID]: rpcTabState() },
      state: stateWithSharer(),
    });
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());

    expect(dialog()!.textContent).toContain(
      "1 other session(s) still run in this checkout, so it and the branch are kept until they " +
        "leave.",
    );
  });

  it("cancelling the modal makes no merge or release call", async () => {
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    expect(dialog()).not.toBeNull();

    await act(async () => dialogButton("cancel")!.click());

    expect(dialog()).toBeNull();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(mergeRow()).toBeDefined();
  });

  it("survives a pointerdown on the modal — the popover's own surface is not outside", async () => {
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    const d = dialog();
    expect(d).not.toBeNull();

    act(() => d!.dispatchEvent(new Event("pointerdown", { bubbles: true })));

    expect(dialog()).not.toBeNull();
    expect(menu()).not.toBeNull();
  });

  it("surfaces a rejected merge in the rose slot and re-fetches the status", async () => {
    backendMock.mergeWorktreeBranch.mockRejectedValueOnce(new Error("fatal: cannot merge"));
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("fatal: cannot merge");
    expect(dialog()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(mergeRow()).toBeDefined();
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
  });

  it("shows a conflicted merge's file list with the console escape hatch, and keeps the worktree", async () => {
    seedStore({ tabs: [tabInfo({ tabId: TAB_ID })], rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "conflicts",
      destination: "main",
      commits: 3,
      files: ["src/a.ts", "src/b.ts"],
    });
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    const popover = menu()!;
    expect(popover.textContent).toContain("merge stopped — 2 file(s) conflict");
    expect(popover.textContent).toContain("src/a.ts");
    expect(popover.textContent).toContain("src/b.ts");
    expect(popover.textContent).toContain(
      "resolve in /project, then git merge --continue — or git merge --abort",
    );
    expect(mergeRow()).toBeUndefined();
    expect(notices()).toEqual([
      {
        text:
          "merge of omp/feature into main stopped — 2 file(s) conflict: src/a.ts, src/b.ts. " +
          "Resolve in /project (git merge --continue) or abort (git merge --abort).",
        level: "warn",
      },
    ]);
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
    // A conflict stops the release too: the session stays in its checkout.
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.some((t) => t.tabId === TAB_ID)).toBe(true);

    await act(async () => buttonByText("open console")!.click());
    expect(consoleOpenState()).toBe(true);
  });

  it("lists up to five conflicted files in the notice and counts the rest", async () => {
    seedStore({ rpc: { [TAB_ID]: rpcTabState() } });
    const files = ["f1", "f2", "f3", "f4", "f5", "f6", "f7"];
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "conflicts",
      destination: "main",
      commits: 3,
      files,
    });
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(notices()).toEqual([
      {
        text:
          "merge of omp/feature into main stopped — 7 file(s) conflict: f1, f2, f3, f4, f5, " +
          "and 2 more. Resolve in /project (git merge --continue) or abort (git merge --abort).",
        level: "warn",
      },
    ]);
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
  });

  it("open console only opens — it never closes an open drawer", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(status({ mergeInProgress: true }));
    seedStore({ consoleOpen: { [TAB_ID]: true } });
    render();
    await openPopover();

    await act(async () => buttonByText("open console")!.click());
    expect(consoleOpenState()).toBe(true);
  });

  it("notes an in-progress merge in the project with the console escape hatch", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(status({ mergeInProgress: true }));
    render();
    await openPopover();

    const popover = menu()!;
    expect(popover.textContent).toContain(
      "a merge is already in progress in the project — finish it there: git merge --continue or " +
        "git merge --abort",
    );
    expect(buttonByText("open console")).toBeDefined();
    expect(mergeRow()).toBeUndefined();
  });

  it("notes a branch that no longer exists", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(status({ branchExists: false }));
    render();
    await openPopover();

    expect(menu()!.textContent).toContain(
      "branch omp/feature no longer exists — nothing to merge",
    );
    expect(mergeRow()).toBeUndefined();
  });

  it("notes a base that no longer resolves", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      status({ destination: null, reason: "base-gone" }),
    );
    render();
    await openPopover();
    expect(menu()!.textContent).toContain("base main no longer resolves — merge manually");

    act(() => trigger().click());
    backendMock.getMergeBackStatus.mockResolvedValue(
      status({ destination: null, reason: "base-gone" }),
    );
    render({ base: "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0" });
    await openPopover();
    expect(menu()!.textContent).toContain("base a1b2c3d4 no longer resolves — merge manually");
  });

  it("notes a base with no matching local branch", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      status({ destination: null, reason: "no-branch-match" }),
    );
    render();
    await openPopover();

    expect(menu()!.textContent).toContain(
      "no local branch matches base main — merge manually",
    );
  });

  it("notes a project that is no longer a readable git repo", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(
      status({ destination: null, reason: "no-repo" }),
    );
    render();
    await openPopover();

    expect(menu()!.textContent).toContain(
      "the project is not a readable git repo — merge manually",
    );
  });

  it("notes an unchecked-out destination", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(status({ destinationCheckedOut: false }));
    render();
    await openPopover();

    expect(menu()!.textContent).toContain("check out main in the project to merge back");
    expect(mergeRow()).toBeUndefined();
  });

  it("offers an actionable return row for an already-merged branch", async () => {
    seedStore({ tabs: [tabInfo({ tabId: TAB_ID })], rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.getMergeBackStatus.mockResolvedValue(status({ alreadyMerged: true, ahead: 0 }));
    render();
    await openPopover();

    expect(mergeRow()).toBeUndefined();
    expect(menuItem("return to main")).toBeDefined();

    await act(async () => menuItem("return to main")!.click());
    await settle();

    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Irreversible action");
    expect(d!.textContent).toContain("Return this session to main?");
    expect(d!.textContent).toContain("The branch omp/feature is already in main.");
    expect(d!.textContent).toContain(
      "This session returns to main in /project: its agent restarts there with its transcript " +
        "intact. The checkout /worktrees/alpha/omp-feature is removed — uncommitted changes " +
        "there are lost — and the branch omp/feature is deleted.",
    );

    await act(async () => dialogButton("return to main")!.click());
    await settle();

    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB_ID);
    expect(backendMock.deleteSession).not.toHaveBeenCalled();
    expect(useStore.getState().tabs.some((t) => t.tabId === TAB_ID)).toBe(true);
    expect(notices()).toEqual([
      {
        text:
          "omp/feature was already in the project checkout — this session now runs in /project. " +
          "The checkout and branch omp/feature are gone.",
        level: "info",
      },
    ]);
  });

  it("keeps the worktree and warns when the release rejects", async () => {
    const alertSpy = vi.spyOn(window, "alert").mockImplementation(() => {});
    seedStore({ tabs: [tabInfo({ tabId: TAB_ID })], rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce(mergedResult);
    backendMock.releaseWorktree.mockRejectedValueOnce(new Error("session tab did not exit"));
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(alertSpy).toHaveBeenCalledWith("session tab did not exit");
    expect(dialog()).toBeNull();
    expect(useStore.getState().tabs.some((t) => t.tabId === TAB_ID)).toBe(true);
    // The failed return resets: the merge row is back and the status re-read.
    expect(mergeRow()).toBeDefined();
    expect(mergeRow()!.disabled).toBe(false);
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
    expect(notices()).toEqual([]);
    alertSpy.mockRestore();
  });

  it("warns in the notice when the checkout was kept for a sharer", async () => {
    seedStore({ tabs: [tabInfo({ tabId: TAB_ID })], rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce(mergedResult);
    backendMock.releaseWorktree.mockResolvedValueOnce({
      ...releaseResult,
      checkoutKept: "shared",
      branchOutcome: "not-attempted",
    });
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge & return")!.click());
    await settle();

    expect(notices()).toEqual([
      {
        text:
          "merged omp/feature (3 commits) into the project checkout — this session now runs in " +
          "/project. The checkout /worktrees/alpha/omp-feature and branch omp/feature are kept: " +
          "another session still runs there.",
        level: "warn",
      },
    ]);
  });

  it("confirms inline while a session is mid-turn in the project, and merges on merge & return anyway", async () => {
    seedBusy();
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce(mergedResult);
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());

    expect(dialog()).toBeNull();
    const popover = menu()!;
    expect(popover.textContent).toContain(
      "session “Busy Session” is mid-turn in the project — merging moves main under it. The merge " +
        "also returns this session to main: the checkout and branch are removed, the session is kept.",
    );

    await act(async () => buttonByText("merge & return anyway")!.click());
    await settle();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith(PROJECT_CWD, "omp/feature", "main");
    expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB_ID);
  });

  it("cancel leaves the busy confirm and makes no call", async () => {
    seedBusy();
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    expect(buttonByText("merge & return anyway")).toBeDefined();

    await act(async () => buttonByText("cancel")!.click());

    expect(buttonByText("merge & return anyway")).toBeUndefined();
    expect(dialog()).toBeNull();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(backendMock.releaseWorktree).not.toHaveBeenCalled();
    expect(mergeRow()).toBeDefined();
  });

  it("keeps the row as merging…, then returning… while the merge and return run", async () => {
    const pending = deferred<MergeBackResult>();
    const release = deferred<WorktreeReleaseResult>();
    backendMock.mergeWorktreeBranch.mockReturnValueOnce(pending.promise);
    backendMock.releaseWorktree.mockReturnValueOnce(release.promise);
    seedStore({ tabs: [tabInfo({ tabId: TAB_ID })], rpc: { [TAB_ID]: rpcTabState() } });
    render();
    await openPopover();
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
      pending.resolve(mergedResult);
    });
    await flushMicrotasks();

    expect(dialog()).toBeNull();
    expect(menuItem("returning…")).toBeDefined();

    await act(async () => {
      release.resolve(releaseResult);
    });
    await settle();

    expect(backendMock.releaseWorktree).toHaveBeenCalledWith(TAB_ID);
  });

});
