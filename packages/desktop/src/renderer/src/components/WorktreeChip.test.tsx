// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  BranchList,
  MergeBackResult,
  MergeBackStatus,
  SessionWorktree,
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
  getProjectOpenAvailability: vi.fn<() => Promise<{ vsCode: boolean }>>(),
  openProject: vi.fn<(path: string, target: "vscode" | "files") => Promise<void>>(),
  // The store's merge action refreshes the branch list after a completed merge.
  listBranches: vi.fn<() => Promise<BranchList>>(),
  getMergeBackStatus: vi.fn<(projectCwd: string, branch: string, base: string | null) => Promise<MergeBackStatus>>(),
  mergeWorktreeBranch: vi.fn<(projectCwd: string, branch: string, destination: string) => Promise<MergeBackResult>>(),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required: ../store → ./backend reads window.ompBackend
// at module load, so the mock above must land first.
const { useStore } = await import("../store");
const { shortBase, WorktreeChip } = await import("./WorktreeChip");

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

const ffResult: MergeBackResult = { kind: "ff", destination: "main", commits: 3, files: [] };

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
              lastViewedAt: null,
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
  backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: false });
  backendMock.openProject.mockReset();
  backendMock.openProject.mockResolvedValue(undefined);
  backendMock.listBranches.mockReset();
  backendMock.listBranches.mockResolvedValue(branchFixture);
  backendMock.getMergeBackStatus.mockReset();
  backendMock.getMergeBackStatus.mockResolvedValue(status());
  backendMock.mergeWorktreeBranch.mockReset();
  backendMock.mergeWorktreeBranch.mockRejectedValue(new Error("unexpected merge"));
  seedStore();
});

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

describe("shortBase", () => {
  it("shortens a 40-hex commit to 8 chars and leaves refs verbatim", () => {
    expect(shortBase("a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0")).toBe("a1b2c3d4");
    expect(shortBase("main")).toBe("main");
    // Uppercase hex is not git's normalized output — treated as a ref name.
    expect(shortBase("A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0")).toBe(
      "A1B2C3D4E5F6A7B8C9D0A1B2C3D4E5F6A7B8C9D0",
    );
    // 39 or 41 hex chars is not a full SHA either.
    expect(shortBase("a".repeat(39))).toBe("a".repeat(39));
  });
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
    backendMock.getProjectOpenAvailability.mockResolvedValue({ vsCode: true });
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

  it("confirms through the copper modal and reports a fast-forward merge", async () => {
    seedStore({ rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce(ffResult);
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());

    const d = dialog();
    expect(d).not.toBeNull();
    expect(d!.textContent).toContain("Merge omp/feature into main?");
    expect(d!.textContent).toContain(
      "Fast-forwards when history allows, otherwise creates a merge commit in the project " +
        "checkout. Merges the 3 committed change(s) on omp/feature; uncommitted changes in the " +
        "worktree are not included. A conflict stops the merge and leaves the project checkout " +
        "with files to resolve.",
    );

    await act(async () => dialogButton("merge into main")!.click());
    await flushMicrotasks();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith(PROJECT_CWD, "omp/feature", "main");
    expect(dialog()).toBeNull();
    expect(menu()!.textContent).toContain("merged into main (fast-forward, 3 commits)");
    expect(notices()).toEqual([
      { text: "merged omp/feature into main — fast-forward, 3 commits", level: "info" },
    ]);
    // The status is re-read after every merge attempt.
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
  });

  it("reports a real merge commit with the commit count", async () => {
    seedStore({ rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "merged",
      destination: "main",
      commits: 5,
      files: [],
    });
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge into main")!.click());
    await flushMicrotasks();

    expect(menu()!.textContent).toContain("merged into main (5 commits, merge commit)");
    expect(notices()).toEqual([
      { text: "merged omp/feature into main — 5 commits, merge commit", level: "info" },
    ]);
  });

  it("cancelling the modal makes no merge call", async () => {
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    expect(dialog()).not.toBeNull();

    await act(async () => dialogButton("cancel")!.click());

    expect(dialog()).toBeNull();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
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
    await act(async () => dialogButton("merge into main")!.click());
    await flushMicrotasks();

    const alert = document.body.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toBe("fatal: cannot merge");
    expect(dialog()).toBeNull();
    expect(menu()).not.toBeNull();
    expect(mergeRow()).toBeDefined();
    expect(backendMock.getMergeBackStatus).toHaveBeenCalledTimes(2);
  });

  it("shows a conflicted merge's file list with the console escape hatch", async () => {
    seedStore({ rpc: { [TAB_ID]: rpcTabState() } });
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce({
      kind: "conflicts",
      destination: "main",
      commits: 3,
      files: ["src/a.ts", "src/b.ts"],
    });
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge into main")!.click());
    await flushMicrotasks();

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
    await act(async () => dialogButton("merge into main")!.click());
    await flushMicrotasks();

    expect(notices()).toEqual([
      {
        text:
          "merge of omp/feature into main stopped — 7 file(s) conflict: f1, f2, f3, f4, f5, " +
          "and 2 more. Resolve in /project (git merge --continue) or abort (git merge --abort).",
        level: "warn",
      },
    ]);
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

  it("notes an already-merged branch quietly, with the delete guidance", async () => {
    backendMock.getMergeBackStatus.mockResolvedValue(status({ alreadyMerged: true, ahead: 0 }));
    render();
    await openPopover();

    const popover = menu()!;
    expect(popover.textContent).toContain(
      "already in main — delete the session to reclaim the checkout (the branch survives)",
    );
    expect(mergeRow()).toBeUndefined();
  });

  it("confirms inline while a session is mid-turn in the project, and merges on merge anyway", async () => {
    seedBusy();
    backendMock.mergeWorktreeBranch.mockResolvedValueOnce(ffResult);
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());

    expect(dialog()).toBeNull();
    const popover = menu()!;
    expect(popover.textContent).toContain(
      "session “Busy Session” is mid-turn in the project — merging moves main under it",
    );

    await act(async () => buttonByText("merge anyway")!.click());
    await flushMicrotasks();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith(PROJECT_CWD, "omp/feature", "main");
    expect(popover.textContent).toContain("merged into main (fast-forward, 3 commits)");
  });

  it("cancel leaves the busy confirm and makes no call", async () => {
    seedBusy();
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    expect(buttonByText("merge anyway")).toBeDefined();

    await act(async () => buttonByText("cancel")!.click());

    expect(buttonByText("merge anyway")).toBeUndefined();
    expect(dialog()).toBeNull();
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(mergeRow()).toBeDefined();
  });

  it("keeps the row as merging… while the merge is in flight, then reports the result", async () => {
    const pending = deferred<MergeBackResult>();
    backendMock.mergeWorktreeBranch.mockReturnValueOnce(pending.promise);
    render();
    await openPopover();
    await act(async () => mergeRow()!.click());
    await act(async () => dialogButton("merge into main")!.click());
    await flushMicrotasks();

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledTimes(1);
    const row = mergeRow();
    expect(row).toBeDefined();
    expect(row!.disabled).toBe(true);
    expect(row!.textContent).toBe("merging…");
    expect(dialogButton("merging…")).toBeDefined();

    await act(async () => {
      pending.resolve(ffResult);
    });
    await flushMicrotasks();

    expect(menu()!.textContent).toContain("merged into main (fast-forward, 3 commits)");
  });
});
