// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppUpdateState, BackendState, OmpUpdateState, RemoteState } from "@omp-ui/core/types";
import { DESKTOP_VIEW_STORAGE_KEY, type DesktopViewStateV1 } from "./lib/desktop-view-state";
import { backendState as makeBackendState, rpcTabState, tabInfo } from "./test/fixtures";
// The whole desktop suite below asserts the Electron path (localStorage + the
// #99 version gate); jsdom's UA reports IS_ELECTRON false, so pin it via the
// getter mock pattern from store.test.ts. The browser describe at the bottom
// flips it per test (issue #890).
const platformMocks = vi.hoisted(() => ({ electron: true }));
vi.mock("./lib/platform", () => ({
  get IS_ELECTRON() {
    return platformMocks.electron;
  },
  IS_MAC: false,
  IS_WINDOWS: false,
}));

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
  belowMinimum: false,
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
  onBranchChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onSessionHibernated: vi.fn(),
  onFocusSession: vi.fn(),
  onShellData: vi.fn(),
  onShellExit: vi.fn(),
  onBrowserPaneFrame: vi.fn(),
  onBrowserPaneState: vi.fn(),
  shellSpawn: vi.fn(),
  shellKill: vi.fn(),
  shellWrite: vi.fn(),
  shellResize: vi.fn(),
  addProject: vi.fn(),
  browseDirectories: vi.fn(),
  removeProject: vi.fn(),
  setSessionAdvisor: vi.fn(),
  setSessionModel: vi.fn(async () => {}),
  getAdvisorDefaults: vi.fn(async () => ({ enabled: false, model: null })),
  setProjectDefaultModel: vi.fn(async () => {}),
  setProjectDefaultAdvisorModel: vi.fn(async () => {}),
  readPlanFile: vi.fn(async (): Promise<string | null> => "# Plan\n\nstep one\n"),
  listBranches: vi.fn(),
  checkoutBranch: vi.fn(),
  ptyPasteImage: vi.fn(),
  setDefaultMode: vi.fn(),
  setSkipDeleteConfirmation: vi.fn(async () => {}),
  setGettingStartedSeen: vi.fn(async () => {}),
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
  setTranscriptWidth: vi.fn(async () => {}),
  setGlassChrome: vi.fn(async () => {}),
  setLocaleId: vi.fn(async () => {}),
  setAppUpdateCheckOnLaunch: vi.fn(async () => {}),
  setAppUpdateTrain: vi.fn(async () => {}),
  setOmpUpdateCheckOnLaunch: vi.fn(async () => {}),
  setVaultNoteVoice: vi.fn(async () => {}),
  clearDismissedAppUpdate: vi.fn(async () => {}),
  clearDismissedOmpUpdate: vi.fn(async () => {}),
  setWindowChrome: vi.fn(async () => {}),
  readOmpSettings: vi.fn(async () => ({ entries: [], agentDir: null, projectConfigPath: null, error: null })),
  writeOmpSetting: vi.fn(async () => {}),
  getProjectMaxConcurrency: vi.fn(async () => ({ value: undefined, layer: { shape: "absent" as const } })),
  setProjectMaxConcurrency: vi.fn(async () => {}),
  getRemoteState: vi.fn(async () => idleRemoteState),
  setRemoteEnabled: vi.fn(async () => {}),
  setRemoteBind: vi.fn(async () => {}),
  setRemotePort: vi.fn(async () => {}),
  regenerateRemoteToken: vi.fn(async () => {}),
  setRemotePassword: vi.fn(async () => {}),
  clearRemotePassword: vi.fn(async () => {}),
  onRemoteState: vi.fn(),
  getProviderOAuthState: vi.fn(async () => ({
    providerId: null,
    phase: "idle",
    url: null,
    instructions: null,
    prompt: null,
    error: null,
  })),
  onProviderOAuthState: vi.fn(),
  onCollabChanged: vi.fn(),
  collabList: vi.fn(async () => []),
  readProviderOAuth: vi.fn(async () => []),
  startProviderOAuth: vi.fn(async () => {}),
  submitProviderOAuthInput: vi.fn(async () => {}),
  cancelProviderOAuth: vi.fn(async () => {}),
  signOutProviderOAuth: vi.fn(async () => ({ rows: [], remainingSource: null })),
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
  planImplementationSource: null, experiment: null, fleet: null,
  agentMode: "build" as const,
  compactionMethod: null,
  approvalMode: null,
  serviceTier: null,
  model: null,
  thinkingLevel: null,
  advisor,
  advisorModel: null, subagentModels: null,
 proposedPlans: [],
 autoTitled: false,
 private: false,
 chat: false,
 askSource: null,
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
      project: { path: "/p/a", name: "a", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, reviewRoster: null, knowledgeHome: null, repositoryKey: null },
      sessions: [session("pty-1", "/p/a", "pty", "dormant", false)],
    },
    {
      project: { path: "/p/b", name: "b", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, reviewRoster: null, knowledgeHome: null, repositoryKey: null },
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
  sidebarWidth: 416,
  inspectorWidth: 256,
  browserPaneWidth: 720,
};
const SEED_JSON = JSON.stringify(SEED_SNAPSHOT);
const seedSnapshot = (): void =>
  window.localStorage.setItem(DESKTOP_VIEW_STORAGE_KEY, SEED_JSON);
const readSnapshot = (): DesktopViewStateV1 =>
  JSON.parse(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)!) as DesktopViewStateV1;

beforeEach(() => {
  vi.clearAllMocks();
  window.localStorage.clear();
  window.sessionStorage.clear();
  platformMocks.electron = true;
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
    expect(st.sidebarWidth).toBe(416);
    expect(st.inspectorWidth).toBe(256);
    expect(st.browserPaneWidth).toBe(720);
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

  it("an update relaunch leaves a tab whose process was gone at quit dormant", async () => {
    const first = await freshStore();
    await first.useStore.getState().init();
    first.useStore.setState({
      tabs: [
        tabInfo({ tabId: "pty-1", mode: "pty", projectCwd: "/p/a" }),
        tabInfo({ tabId: "rpc-1", mode: "rpc-ui", projectCwd: "/p/b" }),
      ],
      rpc: {},
    });
    expect(readSnapshot().tabIds).toEqual(["pty-1", "rpc-1"]);

    // Real path: main's hibernation event runs the store's teardownProcess.
    const hibernated = mockBackend.onSessionHibernated.mock.calls[0]![0] as (tabId: string) => void;
    hibernated("pty-1");
    expect(readSnapshot().tabIds).toEqual(["rpc-1"]);

    appUpdate = { ...idleAppUpdate, currentVersion: "1.2.0" };
    const second = await freshStore();
    await second.useStore.getState().init();

    expect(mockBackend.spawnSession.mock.calls.map((c) => c[0]!.resumeTabId)).toEqual(["rpc-1"]);
    expect(second.useStore.getState().tabs.map((t) => t.tabId)).toEqual(["rpc-1"]);
  });

  it("resuming a dormant tab puts it back in the persisted view", async () => {
    const store = await freshStore();
    await store.useStore.getState().init();
    store.useStore.setState({
      tabs: [tabInfo({ tabId: "pty-1", mode: "pty", projectCwd: "/p/a" })],
      rpc: {},
    });
    const hibernated = mockBackend.onSessionHibernated.mock.calls[0]![0] as (tabId: string) => void;
    hibernated("pty-1");
    expect(readSnapshot().tabIds).toEqual([]);

    await store.useStore.getState().resumeDead("pty-1");

    expect(readSnapshot().tabIds).toEqual(["pty-1"]);
  });
});

/** The same seed written to the per-tab store a browser client reads and writes. */
const seedSession = (): void =>
  window.sessionStorage.setItem(DESKTOP_VIEW_STORAGE_KEY, SEED_JSON);
const readSession = (): DesktopViewStateV1 | null => {
  const raw = window.sessionStorage.getItem(DESKTOP_VIEW_STORAGE_KEY);
  return raw === null ? null : (JSON.parse(raw) as DesktopViewStateV1);
};

describe("browser view restore without the version gate (issue #890)", () => {
  beforeEach(() => {
    platformMocks.electron = false;
  });

  it("a same-version reload restores tabs from sessionStorage", async () => {
    seedSession();
    const store = await freshStore();
    // Same version as the snapshot: the desktop gate would keep Welcome. The
    // browser path must restore anyway.
    appUpdate = { ...idleAppUpdate, currentVersion: "1.0.0" };

    await store.useStore.getState().init();

    const seen = mockBackend.spawnSession.mock.calls.map((c) => c[0]!.resumeTabId);
    expect(seen).toEqual(["pty-1", "rpc-1"]);
    expect(store.useStore.getState().tabs.map((t) => t.tabId)).toEqual(["pty-1", "rpc-1"]);
    expect(store.useStore.getState().activeTabId).toBe("rpc-1");
    // Fresh projection goes to sessionStorage — the per-tab store only.
    expect(readSession()).toMatchObject({ appVersion: "1.0.0", tabIds: ["pty-1", "rpc-1"] });
    expect(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)).toBeNull();
  });

  it("an empty sessionStorage snapshot stays on Welcome", async () => {
    window.sessionStorage.setItem(
      DESKTOP_VIEW_STORAGE_KEY,
      JSON.stringify({ ...SEED_SNAPSHOT, tabIds: [], activeTabId: null }),
    );
    const store = await freshStore();
    await store.useStore.getState().init();
    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(store.useStore.getState().tabs).toEqual([]);
  });

  it("widths come from the localStorage blob while tabs come from sessionStorage", async () => {
    seedSession();
    window.localStorage.setItem(
      DESKTOP_VIEW_STORAGE_KEY,
      JSON.stringify({ ...SEED_SNAPSHOT, sidebarWidth: 300, inspectorWidth: 260, browserPaneWidth: 600 }),
    );
    const store = await freshStore();
    await store.useStore.getState().init();
    const st = store.useStore.getState();
    expect(st.sidebarWidth).toBe(300);
    expect(st.inspectorWidth).toBe(260);
    expect(st.browserPaneWidth).toBe(600);
    // The tab list still comes from the per-tab snapshot, not the width blob.
    expect(st.tabs.map((t) => t.tabId)).toEqual(["pty-1", "rpc-1"]);
    // And a live view write lands in sessionStorage, never clobbering the blob's tabs.
    expect(readSession()).toMatchObject({ tabIds: ["pty-1", "rpc-1"] });
    expect(JSON.parse(window.localStorage.getItem(DESKTOP_VIEW_STORAGE_KEY)!).tabIds).toEqual(
      SEED_SNAPSHOT.tabIds,
    );
  });

  it("skips a record whose live state is missing", async () => {
    seedSession();
    const store = await freshStore();
    await store.useStore.getState().init();
    const seen = mockBackend.spawnSession.mock.calls.map((c) => c[0]!.resumeTabId);
    expect(seen).not.toContain("missing-1");
    expect(seen).not.toContain("deleted-1");
  });

  it("a stale localStorage blob is never read for tabs", async () => {
    // A phone that once ran the desktop-gated path leaves a matching-version
    // blob with tabs; the browser client must ignore it entirely.
    window.localStorage.setItem(DESKTOP_VIEW_STORAGE_KEY, SEED_JSON);
    appUpdate = { ...idleAppUpdate, currentVersion: "1.0.0" };
    const store = await freshStore();
    await store.useStore.getState().init();
    expect(mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(store.useStore.getState().tabs).toEqual([]);
  });
});