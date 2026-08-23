// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  BackendState,
  OmpSettingsSnapshot,
  OmpUpdateState,
  SessionSummary,
} from "@omp-ui/core/types";

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
        lastAdvisorModel: null,
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
});
