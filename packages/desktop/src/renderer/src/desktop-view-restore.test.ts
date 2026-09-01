// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateState, BackendState, OmpUpdateState, RemoteState } from "@omp-ui/core/types";
import { DESKTOP_VIEW_STORAGE_KEY, type DesktopViewStateV1 } from "./lib/desktop-view-state";
import { backendState as makeBackendState, rpcTabState, tabInfo } from "./test/fixtures";

// --- Bridge mock: store.ts reads window.ompBackend at module load -----------

const idleAppUpdate: AppUpdateState = {
  status: "idle",
  currentVersion: null,
  latestVersion: null,
  releaseUrl: null,
  releaseName: null,
  format: "unknown",
  progress: null,
  downloadedPath: null,
  installOnQuit: false,
  error: null,
};

const idleOmpUpdate: OmpUpdateState = {
  status: "idle",
  installPath: null,
  installedVersion: null,
  latestVersion: null,
  progress: null,
  error: null,
};

const idleRemoteState: RemoteState = {
  status: "stopped",
  enabled: false,
  bind: "localhost",
  port: 4677,
  token: "t",
  hasPassword: false,
  urls: [],
  tokenUrls: [],
  webBundleMissing: false,
  error: null,
};

/** Mutable per-test: tests flip `currentVersion` to re-gate the restore. */
let appUpdate: AppUpdateState = { ...idleAppUpdate, currentVersion: "1.1.0" };

const mockBackend = {
  getState: vi.fn(async () => backendState),
  rpcSend: vi.fn(),
  tabViewed: vi.fn(),
  reportStallCap: vi.fn(),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onSessionHibernated: vi.fn(),
  onFocusSession: vi.fn(),
  onShellData: vi.fn(),
  onShellExit: vi.fn(),
  shellSpawn: vi.fn(),
  shellKill: vi.fn(),
  shellWrite: vi.fn(),
  shellResize: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  moveProject: vi.fn(async () => {}),
  moveSession: vi.fn(async () => {}),
  setSessionAdvisor: vi.fn(),
  setSessionModel: vi.fn(async () => {}),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  generateTitle: vi.fn(async (): Promise<string | null> => null),
  readPlanFile: vi.fn(async (): Promise<string | null> => "# Plan\n\nstep one\n"),
  listBranches: vi.fn(),
  checkoutBranch: vi.fn(),
  ptyPasteImage: vi.fn(),
  setDefaultMode: vi.fn(),
  setSkipDeleteConfirmation: vi.fn(async () => {}),
  setDesktopNotifications: vi.fn(async () => {}),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  hibernatePlanSource: vi.fn(async () => true),
  switchMode: vi.fn(),
  deleteSession: vi.fn(async (tabId: string) => ({ deleted: [tabId], failed: [] })),
  deleteSessionPreview: vi.fn(async () => ({ descendants: [] })),
  forkSession: vi.fn(),
  toggleFavorite: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  getOmpUpdateState: vi.fn(async () => idleOmpUpdate),
  checkOmpUpdate: vi.fn(),
  downloadOmpUpdate: vi.fn(),
  dismissOmpUpdate: vi.fn(),
  onOmpUpdateState: vi.fn(),
  getAppUpdateState: vi.fn(async () => appUpdate),
  checkAppUpdate: vi.fn(),
  downloadAppUpdate: vi.fn(),
  openAppUpdateReleaseNotes: vi.fn(),
  showAppUpdateDownload: vi.fn(),
  restartForAppUpdate: vi.fn(),
  setAppUpdateInstallOnQuit: vi.fn(),
  dismissAppUpdate: vi.fn(),
  onAppUpdateState: vi.fn(),
  setThemeId: vi.fn(async () => {}),
  setFontFamilyId: vi.fn(async () => {}),
  setLocaleId: vi.fn(async () => {}),
  setAppUpdateCheckOnLaunch: vi.fn(async () => {}),
  setOmpUpdateCheckOnLaunch: vi.fn(async () => {}),
  clearDismissedAppUpdate: vi.fn(async () => {}),
  clearDismissedOmpUpdate: vi.fn(async () => {}),
  setWindowChrome: vi.fn(async () => {}),
  readOmpSettings: vi.fn(async () => ({ entries: [], agentDir: null, projectConfigPath: null, error: null })),
  writeOmpSetting: vi.fn(async () => {}),
  getRemoteState: vi.fn(async () => idleRemoteState),
  setRemoteEnabled: vi.fn(async () => {}),
  setRemoteBind: vi.fn(async () => {}),
  setRemotePort: vi.fn(async () => {}),
  regenerateRemoteToken: vi.fn(async () => {}),
  setRemotePassword: vi.fn(async () => {}),
  clearRemotePassword: vi.fn(async () => {}),
  onRemoteState: vi.fn(),
};
Object.assign(window, { ompBackend: mockBackend });

/** `init` latches a module-level flag, so every test needs a fresh store. */
const freshStore = async (): Promise<typeof import("./store")> => {
  vi.resetModules();
  return import("./store");
};

const session = (
  tabId: string,
  projectCwd: string,
  mode: "pty" | "rpc-ui",
  live: "dormant" | "missing",
  advisor: boolean,
) => ({
  tabId,
  sessionId: `sid-${tabId}`,
  lineageDir: `omp-ui--${tabId}`,
  projectCwd,
  launchedAt: "2026-08-03T00:00:00.000Z",
  mode,
  worktree: null,
  planImplementationSource: null,
  agentMode: "build" as const,
  compactionMethod: null,
  model: null,
  thinkingLevel: null,
  advisor,
  advisorModel: null,
  cachedTitle: null,
  cachedModified: "2026-08-03T00:00:00.000Z",
  title: tabId,
  status: null,
  live,
  pendingPlan: null,
  planSettle: null,
    streamStalled: false,
});

const backendState: BackendState = makeBackendState({
  projects: [
    {
      project: { path: "/p/a", name: "a", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      sessions: [session("pty-1", "/p/a", "pty", "dormant", false)],
    },
    {
      project: { path: "/p/b", name: "b", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      // rpc-1 resumable, missing-1 is gone on disk, deleted-1 has NO record.
      sessions: [
        session("rpc-1", "/p/b", "rpc-ui", "dormant", true),
        session("missing-1", "/p/b", "rpc-ui", "missing", false),
      ],
    },
  ],
});

/** The snapshot a previous (1.0.0) run persisted, ordered pty → rpc → gone. */
const SEED_SNAPSHOT: DesktopViewStateV1 = {
  schemaVersion: 1,
  appVersion: "1.0.0",
  tabIds: ["pty-1", "rpc-1", "missing-1", "deleted-1"],
  activeTabId: "rpc-1",
  focusedTabByProject: { "/p/a": "pty-1", "/p/b": "rpc-1", "/p/x": "deleted-1", "/p/y": "gone-1" },
  sidebarWidth: 416,
  inspectorWidth: 256,
};
const SEED_JSON = JSON.stringify(SEED_SNAPSHOT);
const seedSnapshot = (): void =>
  window.localStorage.setItem(DESKTOP_VIEW_STORAGE_KEY, SEED_JSON);
const readSnapshot = (): DesktopViewStateV1 =>
  JSON.parse(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)!) as DesktopViewStateV1;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.alert = vi.fn();
  appUpdate = { ...idleAppUpdate, currentVersion: "1.1.0" };
  mockBackend.spawnSession.mockImplementation(
    async (req: { resumeTabId: string }) => ({ tabId: req.resumeTabId }),
  );
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("desktop view restore across an AppImage update relaunch (issue #99)", () => {
  it("resumes surviving tabs in saved order and settles focus to them", async () => {
    seedSnapshot();
    const store = await freshStore();
    const snapshots: Array<{
      state: BackendState | null;
      appUpdate: AppUpdateState;
      ompUpdate: OmpUpdateState;
      remote: RemoteState;
    }> = [];
    mockBackend.spawnSession.mockImplementation(async (req: { resumeTabId: string }) => {
      const current = store.useStore.getState();
      snapshots.push({
        state: current.state,
        appUpdate: current.appUpdate,
        ompUpdate: current.ompUpdate,
        remote: current.remote,
      });
      return { tabId: req.resumeTabId };
    });

    await store.useStore.getState().init();

    expect(mockBackend.spawnSession).toHaveBeenCalledTimes(2);
    expect(mockBackend.spawnSession.mock.calls[0]![0]).toEqual({
      origin: "resume",
      resumeTabId: "pty-1",
      cols: 80,
      rows: 24,
    });
    expect(mockBackend.spawnSession.mock.calls[1]![0]).toEqual({
      origin: "resume",
      resumeTabId: "rpc-1",
      cols: 80,
      rows: 24,
    });
    // Missing-on-disk and absent records never spawn.
    const seen = mockBackend.spawnSession.mock.calls.map((c) => c[0]!.resumeTabId);
    expect(seen).not.toContain("missing-1");
    expect(seen).not.toContain("deleted-1");

    const st = store.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["pty-1", "rpc-1"]);
    expect(st.activeTabId).toBe("rpc-1");
    expect(st.focusedTabByProject).toEqual({ "/p/a": "pty-1", "/p/b": "rpc-1" });
    expect(st.sidebarWidth).toBe(416);
    expect(st.inspectorWidth).toBe(256);
    expect(st.restoringTabs).toBe(false);
    expect(snapshots).toHaveLength(2);
    for (const snapshot of snapshots) {
      expect(snapshot).toEqual({
        state: backendState,
        appUpdate,
        ompUpdate: idleOmpUpdate,
        remote: idleRemoteState,
      });
    }

    // The mandatory first persist now describes the restored view.
    const saved = readSnapshot();
    expect(saved.appVersion).toBe("1.1.0");
    expect(saved.tabIds).toEqual(["pty-1", "rpc-1"]);
  });

  it("continues the sequence past one rejected spawn and falls back focus", async () => {
    seedSnapshot();
    // First (pty-1) resolves, second (rpc-1) rejects — the restore loop must
    // continue past the failure instead of aborting. mockRejectedValueOnce
    // alone would poison the FIRST call, so pin call order explicitly.
    mockBackend.spawnSession
      .mockResolvedValueOnce({ tabId: "pty-1" })
      .mockRejectedValueOnce(new Error("boom"));
    const store = await freshStore();

    await store.useStore.getState().init();

    // Both surviving records were attempted; the rejection did not abort.
    expect(mockBackend.spawnSession).toHaveBeenCalledTimes(2);
    const st = store.useStore.getState();
    expect(st.tabs.map((t) => t.tabId)).toEqual(["pty-1"]);
    // Saved active (rpc-1) failed → settle on the last restored.
    expect(st.activeTabId).toBe("pty-1");
    expect(st.focusedTabByProject).toEqual({ "/p/a": "pty-1" });
    expect(st.restoringTabs).toBe(false);
  });

  it("same-version relaunch keeps Welcome and a later bump cannot resurrect old ids", async () => {
    seedSnapshot();
    appUpdate = { ...idleAppUpdate, currentVersion: "1.0.0" };
    const first = await freshStore();
    await first.useStore.getState().init();

    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(first.useStore.getState().restoringTabs).toBe(false);
    expect(first.useStore.getState().sidebarWidth).toBe(416);
    expect(first.useStore.getState().inspectorWidth).toBe(256);
    expect(first.useStore.getState().tabs).toEqual([]);
    // The stale snapshot was replaced by the current (empty) view.
    expect(readSnapshot()).toMatchObject({ appVersion: "1.0.0", tabIds: [] });

    // A later changed-version boot reads the EMPTY snapshot: the original
    // tab ids were cleared, so a version bump cannot resurrect them.
    appUpdate = { ...idleAppUpdate, currentVersion: "1.1.0" };
    const second = await freshStore();
    await second.useStore.getState().init();
    const seen = mockBackend.spawnSession.mock.calls.map((c) => c[0]!.resumeTabId);
    expect(seen).toEqual([]);
    expect(seen).not.toContain("pty-1");
    expect(seen).not.toContain("rpc-1");
  });

  it("a transient null current version neither restores nor overwrites", async () => {
    seedSnapshot();
    appUpdate = { ...idleAppUpdate, currentVersion: null };
    const store = await freshStore();

    await store.useStore.getState().init();

    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(store.useStore.getState().sidebarWidth).toBe(416);
    expect(store.useStore.getState().inspectorWidth).toBe(256);
    // The seed string is byte-for-byte untouched.
    expect(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)).toBe(SEED_JSON);
  });

  it("an rpc-only update writes nothing while focus and hide do", async () => {
    const store = await freshStore();
    const spy = vi.spyOn(Storage.prototype, "setItem");

    await store.useStore.getState().init();
    // init also persists the viewed-tab reporter's one-time clientId
    // (issue #266); every later write is a view snapshot.
    expect(spy).toHaveBeenCalledTimes(2);

    store.useStore.setState({ rpc: { someTab: rpcTabState() } });
    expect(spy).toHaveBeenCalledTimes(2); // rpc traffic never persists

    store.useStore.getState().setSidebarWidth(400);
    expect(spy).toHaveBeenCalledTimes(3);
    store.useStore.getState().setInspectorWidth(260);
    expect(spy).toHaveBeenCalledTimes(4);

    store.useStore.setState({ tabs: [tabInfo({ tabId: "t1", mode: "rpc-ui", projectCwd: "/p/a", hidden: false })], rpc: {} });
    expect(spy).toHaveBeenCalledTimes(5);

    store.useStore.getState().focusTab("t1");
    expect(spy).toHaveBeenCalledTimes(6);

    store.useStore.getState().hideTab("t1");
    expect(spy).toHaveBeenCalledTimes(7);
  });

  it("onStateChanged prunes focus entries whose tab or project is gone", async () => {
    seedSnapshot();
    const store = await freshStore();
    await store.useStore.getState().init();
    expect(store.useStore.getState().focusedTabByProject).toEqual({
      "/p/a": "pty-1",
      "/p/b": "rpc-1",
    });

    const onChange = mockBackend.onStateChanged.mock.calls[0]?.[0] as (state: BackendState) => void;
    // A reconciled state that drops project /p/b (and its sessions) wholesale.
    onChange({ ...backendState, projects: [backendState.projects[0]!] });

    const st = store.useStore.getState();
    expect(st.focusedTabByProject).not.toHaveProperty("/p/b");
    expect(st.focusedTabByProject["/p/a"]).toBe("pty-1");
  });
});