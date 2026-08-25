// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  MergeBackStatus,
  OmpSettingsSnapshot,
  OmpUpdateState,
  SessionSummary,
} from "@omp-ui/core/types";
import type { DeleteConfirmation, RpcTabState } from "../store";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

const emptyOmpSettings: OmpSettingsSnapshot = {
  entries: [],
  agentDir: null,
  projectConfigPath: null,
  error: null,
};

const backendMock = {
  getState: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  moveProject: vi.fn(async () => {}),
  setDefaultMode: vi.fn(),
  setSkipDeleteConfirmation: vi.fn(),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  switchMode: vi.fn(),
  deleteSession: vi.fn(),
  forkSession: vi.fn(),
  setSessionAdvisor: vi.fn(),
  getAdvisorDefaults: vi.fn(),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  setSessionModel: vi.fn(),
  generateTitle: vi.fn(),
  readPlanFile: vi.fn(),
  getBranchDiff: vi.fn(),
  getMergeBackStatus: vi.fn(),
  mergeWorktreeBranch: vi.fn(),
  ptyPasteImage: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  rpcSend: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  toggleFavorite: vi.fn(),
  getOmpUpdateState: vi.fn(async () => idleOmpUpdate),
  checkOmpUpdate: vi.fn(),
  downloadOmpUpdate: vi.fn(),
  dismissOmpUpdate: vi.fn(),
  onOmpUpdateState: vi.fn(),
  getAppUpdateState: vi.fn(),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  openAppUpdateReleaseNotes: vi.fn(),
  showAppUpdateDownload: vi.fn(),
  restartForAppUpdate: vi.fn(),
  setAppUpdateInstallOnQuit: vi.fn(),
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
  setThemeId: vi.fn(async () => {}),
  setAppUpdateCheckOnLaunch: vi.fn(async () => {}),
  setOmpUpdateCheckOnLaunch: vi.fn(async () => {}),
  clearDismissedAppUpdate: vi.fn(async () => {}),
  clearDismissedOmpUpdate: vi.fn(async () => {}),
  setWindowChrome: vi.fn(async () => {}),
  readOmpSettings: vi.fn(async () => emptyOmpSettings),
  writeOmpSetting: vi.fn(async () => {}),
};
Object.assign(window, { ompBackend: backendMock });
// Dynamic imports are required because store.ts captures the mocked preload bridge at module load.

const { useStore } = await import("../store");
const { DeleteSessionDialog } = await import("./DeleteSessionDialog");

let root: Root | null = null;

afterEach(() => {
  if (root !== null) {
    act(() => root!.unmount());
    root = null;
  }
  document.body.replaceChildren();
});

/** A minimal registry state holding one project and the session under test. */
const stateWith = (
  session: SessionSummary,
  skipDeleteConfirmation: boolean,
): BackendState => ({
  projects: [
    {
      project: {
        path: "/repo",
        name: "repo",
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
  defaultMode: "rpc-ui",
  defaultAgentMode: "build",
  defaultCompactionMethod: null,
  planFormat: "md",
  hibernateIdleMinutes: 30,
  streamStallAbortSeconds: 180,
  advisorAutoReply: false,
  stallAutoContinue: true,
  desktopNotifications: true,
  defaultAdvisor: false,
  modelFavorites: [],
  skipDeleteConfirmation,
  themeId: "default",
  appUpdateCheckOnLaunch: true,
  ompUpdateCheckOnLaunch: true,
  dismissedAppUpdateVersion: null,
  dismissedOmpUpdateVersion: null,
});

const summary = (overrides: Partial<SessionSummary> = {}): SessionSummary => ({
  tabId: "tab-1",
  sessionId: null,
  lineageDir: "lineage-1",
  projectCwd: "/repo",
  launchedAt: "2026-01-01T00:00:00.000Z",
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
  title: "Production repair",
  status: null,
  live: "live",
  pendingPlan: null,
  planSettle: null,
  streamStalled: false,
  ...overrides,
});
/** The merge-feasibility snapshot the merge cases start from: the branch base, checked out in the project. */
const mergeableStatus: MergeBackStatus = {
  destination: "main",
  reason: null,
  destinationCheckedOut: true,
  branchExists: true,
  mergeInProgress: false,
  alreadyMerged: false,
  ahead: 3,
};

/** The worktree session the merge cases delete: a branch cut from "main". */
const worktreeSession = { path: "/worktrees/repo--1234/omp-ui-deadbeef", branch: "omp-ui/deadbeef", base: "main" };

const worktreeConfirmation: DeleteConfirmation = {
  tabId: "tab-1",
  title: "Worktree repair",
  running: false,
  hasFiles: true,
  worktreeBranch: "omp-ui/deadbeef",
  worktreeBase: "main",
};

function renderDialog(confirmation: DeleteConfirmation): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  act(() => root!.render(<DeleteSessionDialog confirmation={confirmation} />));
}

function unmountDialog(): void {
  act(() => root!.unmount());
  root = null;
  document.body.replaceChildren();
}

const buttonByText = (text: string): HTMLButtonElement => {
  const found = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
    (candidate) => candidate.textContent === text,
  );
  expect(found).toBeDefined();
  return found!;
};

/** Flushes the dialog's status-fetch microtask after mount. */
const flush = async (): Promise<void> => {
  await act(async () => {});
};

describe("DeleteSessionDialog", () => {
  it("shows every destructive effect and submits the checked opt-out", () => {
    const confirmDeleteSession = vi.fn(async () => {});
    const cancelDeleteSession = vi.fn();
    useStore.setState({ confirmDeleteSession, cancelDeleteSession });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <DeleteSessionDialog
          confirmation={{
            tabId: "tab-1",
            title: "Production repair",
            running: true,
            hasFiles: true,
            worktreeBranch: null,
            worktreeBase: null,
          }}
        />,
      ),
    );

    const dialogs = document.body.querySelectorAll<HTMLElement>('[role="alertdialog"]');
    expect(dialogs).toHaveLength(1);
    const dialog = dialogs[0];
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    const labelledBy = dialog.getAttribute("aria-labelledby");
    expect(labelledBy).not.toBeNull();
    expect(document.getElementById(labelledBy!)?.textContent).toContain("Production repair");
    expect(dialog.textContent).toContain("Production repair");
    expect(dialog.textContent).toContain("running agent will be stopped");
    expect(dialog.textContent).toContain("transcript and artifacts will be erased");
    expect(dialog.textContent).not.toContain("worktree checkout will be removed");

    const checkbox = document.body.querySelector<HTMLInputElement>('input[type="checkbox"]');
    expect(checkbox).not.toBeNull();
    act(() => checkbox!.click());
    expect(checkbox!.checked).toBe(true);

    const deleteButton = [...document.body.querySelectorAll<HTMLButtonElement>("button")].find(
      (candidate) => candidate.textContent === "Delete session",
    );
    expect(deleteButton).toBeDefined();
    act(() => deleteButton!.click());
    expect(confirmDeleteSession).toHaveBeenCalledWith(true);
  });

  it("names the worktree checkout when the session has one", () => {
    useStore.setState({
      confirmDeleteSession: vi.fn(async () => {}),
      cancelDeleteSession: vi.fn(),
    });

    const host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
    act(() =>
      root!.render(
        <DeleteSessionDialog
          confirmation={{
            tabId: "tab-1",
            title: "Worktree repair",
            running: false,
            hasFiles: true,
            worktreeBranch: "omp-ui/deadbeef",
            worktreeBase: null,
          }}
        />,
      ),
    );

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(
      "Its worktree checkout will be removed — uncommitted changes there are lost. Commits survive on omp-ui/deadbeef.",
    );
  });

  it("stages a confirmation for a worktree session even with the skip flag set", async () => {
    backendMock.deleteSession.mockReset();
    useStore.setState({
      deleteConfirmation: null,
      state: stateWith(
        summary({
          worktree: { path: "/worktrees/repo--1234/omp-ui-deadbeef", branch: "omp-ui/deadbeef", base: null },
        }),
        true,
      ),
    });

    await act(async () => {
      await useStore.getState().deleteSession("tab-1");
    });

    expect(useStore.getState().deleteConfirmation).toMatchObject({
      tabId: "tab-1",
      worktreeBranch: "omp-ui/deadbeef",
    });
    expect(backendMock.deleteSession).not.toHaveBeenCalled();
  });

  it("erases immediately when the skip flag is set and the session has no worktree", async () => {
    backendMock.deleteSession.mockReset();
    useStore.setState({
      deleteConfirmation: null,
      state: stateWith(summary({ worktree: null }), true),
    });

    await act(async () => {
      await useStore.getState().deleteSession("tab-1");
    });

    expect(useStore.getState().deleteConfirmation).toBeNull();
    expect(backendMock.deleteSession).toHaveBeenCalledWith("tab-1");
  });
  it("offers the merge row only for a worktree session with a recorded base", async () => {
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    useStore.setState({
      confirmDeleteSession: vi.fn(async () => {}),
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    renderDialog(worktreeConfirmation);
    await flush();
    expect(document.body.textContent).toContain("merge omp-ui/deadbeef into main first");
    unmountDialog();

    // No recorded base: nothing to merge into.
    renderDialog({ ...worktreeConfirmation, worktreeBase: null });
    await flush();
    expect(document.body.textContent).not.toContain("merge omp-ui/deadbeef into");
    unmountDialog();

    // No worktree branch: nothing to merge.
    renderDialog({ ...worktreeConfirmation, worktreeBranch: null });
    await flush();
    expect(document.body.textContent).not.toContain("merge omp-ui/deadbeef into");
    unmountDialog();

    // No record for the tab: no project to merge into.
    useStore.setState({ state: stateWith(summary({ tabId: "other" }), false) });
    renderDialog(worktreeConfirmation);
    await flush();
    expect(document.body.textContent).not.toContain("merge omp-ui/deadbeef into");
    unmountDialog();
  });

  it("disables the merge row in each unmergeable state", async () => {
    useStore.setState({
      confirmDeleteSession: vi.fn(async () => {}),
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    const cases: Array<{ status: MergeBackStatus; title: string }> = [
      // Branch missing: disabled with the branch-gone tooltip.
      { status: { ...mergeableStatus, branchExists: false }, title: "the worktree branch no longer exists — nothing to merge" },
      {
        status: {
          ...mergeableStatus,
          destination: null,
          reason: "base-gone",
          destinationCheckedOut: false,
        },
        title: "the recorded base no longer resolves",
      },
      {
        status: { ...mergeableStatus, destinationCheckedOut: false },
        title: "check out main in the project first",
      },
      {
        status: { ...mergeableStatus, mergeInProgress: true },
        title: "a merge is already in progress in the project",
      },
      { status: { ...mergeableStatus, alreadyMerged: true }, title: "already in main" },
    ];
    for (const { status, title } of cases) {
      backendMock.getMergeBackStatus.mockReset().mockResolvedValue(status);
      renderDialog(worktreeConfirmation);
      await flush();
      const checkbox = document.body.querySelector<HTMLInputElement>("input[type='checkbox']");
      expect(checkbox).not.toBeNull();
      expect(checkbox!.disabled).toBe(true);
      expect((checkbox!.closest("label") as HTMLLabelElement).title).toBe(title);
      unmountDialog();
    }
  });

  it("disables the merge row while a session is mid-turn in the project", async () => {
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    const state = stateWith(summary({ worktree: { ...worktreeSession } }), false);
    state.projects[0].sessions.push(summary({ tabId: "tab-2", title: "Busy" }));
    useStore.setState({
      confirmDeleteSession: vi.fn(async () => {}),
      cancelDeleteSession: vi.fn(),
      tabs: [
        { tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false },
        { tabId: "tab-2", mode: "rpc-ui", projectCwd: "/repo", hidden: false },
      ],
      rpc: { "tab-2": { status: "running" } as unknown as RpcTabState },
      state,
    });

    renderDialog(worktreeConfirmation);
    await flush();
    const checkbox = document.body.querySelector<HTMLInputElement>("input[type='checkbox']");
    expect(checkbox).not.toBeNull();
    expect(checkbox!.disabled).toBe(true);
    expect((checkbox!.closest("label") as HTMLLabelElement).title).toBe(
      "a session is mid-turn in the project",
    );
    unmountDialog();
  });

  it("merges first and deletes when the fast-forward succeeds", async () => {
    const confirmDeleteSession = vi.fn(async () => {});
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    backendMock.mergeWorktreeBranch
      .mockReset()
      .mockResolvedValue({ kind: "ff", destination: "main", commits: 3, files: [] });
    useStore.setState({
      confirmDeleteSession,
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    renderDialog(worktreeConfirmation);
    await flush();
    const mergeCheckbox = document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    expect(mergeCheckbox.checked).toBe(false);
    act(() => mergeCheckbox.click());
    await act(async () => {
      buttonByText("merge & delete").click();
    });

    expect(backendMock.mergeWorktreeBranch).toHaveBeenCalledWith("/repo", "omp-ui/deadbeef", "main");
    expect(confirmDeleteSession).toHaveBeenCalledTimes(1);
    expect(confirmDeleteSession).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open on conflicts and deletes after unchecking", async () => {
    const confirmDeleteSession = vi.fn(async () => {});
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    backendMock.mergeWorktreeBranch
      .mockReset()
      .mockResolvedValue({ kind: "conflicts", destination: "main", commits: 0, files: ["src/a.ts", "src/b.ts"] });
    useStore.setState({
      confirmDeleteSession,
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    renderDialog(worktreeConfirmation);
    await flush();
    const mergeCheckbox = document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    act(() => mergeCheckbox.click());
    await act(async () => {
      buttonByText("merge & delete").click();
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain(
      "the merge stopped on 2 file(s) — resolve them in /repo, then delete without merging",
    );
    expect(confirmDeleteSession).not.toHaveBeenCalled();

    // Uncheck and delete plainly.
    act(() => mergeCheckbox.click());
    await act(async () => {
      buttonByText("Delete session").click();
    });
    expect(confirmDeleteSession).toHaveBeenCalledTimes(1);
    expect(confirmDeleteSession).toHaveBeenCalledWith(false);
  });

  it("keeps the dialog open with git's message when the merge is refused", async () => {
    const confirmDeleteSession = vi.fn(async () => {});
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    backendMock.mergeWorktreeBranch
      .mockReset()
      .mockRejectedValue(new Error("fatal: refusing to merge unrelated histories"));
    useStore.setState({
      confirmDeleteSession,
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    renderDialog(worktreeConfirmation);
    await flush();
    const mergeCheckbox = document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    act(() => mergeCheckbox.click());
    await act(async () => {
      buttonByText("merge & delete").click();
    });

    const dialog = document.body.querySelector<HTMLElement>('[role="alertdialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain("fatal: refusing to merge unrelated histories");
    expect(confirmDeleteSession).not.toHaveBeenCalled();
  });

  it("blocks merge & delete when the merge stops being possible after the checkbox is on", async () => {
    const confirmDeleteSession = vi.fn(async () => {});
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    backendMock.mergeWorktreeBranch.mockReset();
    useStore.setState({
      confirmDeleteSession,
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    renderDialog(worktreeConfirmation);
    await flush();
    const mergeCheckbox = document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    act(() => mergeCheckbox.click());
    expect(mergeCheckbox.checked).toBe(true);

    // A session in the project checkout starts a turn while the dialog is open.
    const state = stateWith(summary({ worktree: { ...worktreeSession } }), false);
    state.projects[0].sessions.push(summary({ tabId: "tab-2", title: "Busy" }));
    act(() => {
      useStore.setState({
        tabs: [
          { tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false },
          { tabId: "tab-2", mode: "rpc-ui", projectCwd: "/repo", hidden: false },
        ],
        rpc: { "tab-2": { status: "running" } as unknown as RpcTabState },
        state,
      });
    });

    // The checked-but-stale merge may not silently turn into a plain delete:
    // the primary button disables with the reason instead of falling through.
    const deleteButton = buttonByText("merge & delete");
    expect(deleteButton.disabled).toBe(true);
    expect(deleteButton.title).toBe("a session is mid-turn in the project");
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(confirmDeleteSession).not.toHaveBeenCalled();
    unmountDialog();
  });

  it("deletes plainly when the merge row is left unchecked", async () => {
    const confirmDeleteSession = vi.fn(async () => {});
    backendMock.getMergeBackStatus.mockReset().mockResolvedValue(mergeableStatus);
    backendMock.mergeWorktreeBranch.mockReset();
    useStore.setState({
      confirmDeleteSession,
      cancelDeleteSession: vi.fn(),
      tabs: [{ tabId: "tab-1", mode: "rpc-ui", projectCwd: "/repo", hidden: false }],
      rpc: {},
      state: stateWith(summary({ worktree: { ...worktreeSession } }), false),
    });

    renderDialog(worktreeConfirmation);
    await flush();
    const mergeCheckbox = document.body.querySelectorAll<HTMLInputElement>("input[type='checkbox']")[0];
    expect(mergeCheckbox.checked).toBe(false);
    expect(mergeCheckbox.disabled).toBe(false);

    await act(async () => {
      buttonByText("Delete session").click();
    });
    expect(backendMock.mergeWorktreeBranch).not.toHaveBeenCalled();
    expect(confirmDeleteSession).toHaveBeenCalledTimes(1);
    expect(confirmDeleteSession).toHaveBeenCalledWith(false);
  });

});
