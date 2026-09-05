// Shared test harness for the store tests (issue #295). This module is the
// only one that imports ../store: the window stub below must land before the
// store module evaluates, and the dynamic import below preserves that
// ordering. Every store test file imports the single `h` namespace and
// nothing else from here — no test file may import ../store directly.
import { beforeEach, vi } from "vitest";
import type {
  AppUpdateState,
  BackendState,
  DeleteSessionPreview,
  DeleteSessionResult,
  LiveState,
  OmpSettingsSnapshot,
  OmpUpdateState,
  ProviderOAuthState,
  RemoteState,
  SessionWorktree,
  WorktreeReleaseResult,
} from "@omp-ui/core/types";
import { backendState as makeBackendState } from "./fixtures";

// --- Bridge mock: store.ts reads window.ompBackend at module load -----------

const sent: Array<{ tabId: string; cmd: Record<string, unknown> }> = [];
let backendState: BackendState = makeBackendState();

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

const idleProviderOAuth: ProviderOAuthState = {
  providerId: null,
  phase: "idle",
  url: null,
  instructions: null,
  prompt: null,
  error: null,
};

const emptyOmpSettings: OmpSettingsSnapshot = {
  entries: [],
  agentDir: null,
  projectConfigPath: null,
  error: null,
};

// init() registers the shell-exit listener once per file and the global
// beforeEach wipes mock.calls, so suites running after it read the callback
// from here instead of re-reading the registration.
let shellExitCb: ((tabId: string, code: number) => void) | null = null;

const mockBackend = {
  getState: vi.fn(async () => backendState),
  rpcSend: vi.fn((tabId: string, cmd: Record<string, unknown>) => {
    sent.push({ tabId, cmd });
  }),
  tabViewed: vi.fn(),
  reportStallCap: vi.fn(),
  onRpcFrame: vi.fn(),
  onStateChanged: vi.fn(),
  onPtyData: vi.fn(),
  onPtyExit: vi.fn(),
  onSessionHibernated: vi.fn(),
  onFocusSession: vi.fn(),
  onShellData: vi.fn(),
  onShellExit: vi.fn((cb: (tabId: string, code: number) => void) => {
    shellExitCb = cb;
  }),
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
  readPlanFile: vi.fn(
    async (_tabId: string, absPath: string): Promise<string | null> =>
      absPath.endsWith(".html") ? "<h1>Plan</h1>" : "# Plan\n\nstep one\n",
  ),
  listBranches: vi.fn(),
  checkoutBranch: vi.fn(),
  pullBranch: vi.fn(),
  getMergeBackStatus: vi.fn(),
  mergeWorktreeBranch: vi.fn(),
  ptyPasteImage: vi.fn(),
  setDefaultMode: vi.fn(),
  setPlanFormat: vi.fn(async () => {}),
  setAdvisorAutoReply: vi.fn(async () => {}),
  setStallAutoContinue: vi.fn(async () => {}),
  setDesktopNotifications: vi.fn(async () => {}),
  setDefaultAdvisor: vi.fn(async () => {}),
  setSkipDeleteConfirmation: vi.fn(async () => {}),
  spawnSession: vi.fn(),
  terminateSession: vi.fn(),
  hibernatePlanSource: vi.fn(async () => true),
  restartSession: vi.fn(),
  convertToWorktree: vi.fn(async () => {}),
  releaseWorktree: vi.fn(
    async (): Promise<WorktreeReleaseResult> => ({
      worktreePath: "/wt/deadbeef",
      branch: "omp-ui/deadbeef",
      projectCwd: "/p",
      checkoutKept: null,
      branchOutcome: "removed",
    }),
  ),
  switchMode: vi.fn(),
  deleteSession: vi.fn(async (tabId: string): Promise<DeleteSessionResult> => ({
    deleted: [tabId],
    failed: [],
  })),
  deleteSessionPreview: vi.fn(async (): Promise<DeleteSessionPreview> => ({ descendants: [] })),
  forkSession: vi.fn(),
  toggleFavorite: vi.fn(),
  ptyWrite: vi.fn(),
  ptyResize: vi.fn(),
  getOmpUpdateState: vi.fn(async () => idleOmpUpdate),
  checkOmpUpdate: vi.fn(),
  downloadOmpUpdate: vi.fn(),
  dismissOmpUpdate: vi.fn(),
  onOmpUpdateState: vi.fn(),
  getAppUpdateState: vi.fn(async () => idleAppUpdate),
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
  readOmpSettings: vi.fn(async () => emptyOmpSettings),
  writeOmpSetting: vi.fn(async () => {}),
  getRemoteState: vi.fn(async () => idleRemoteState),
  setRemoteEnabled: vi.fn(async () => {}),
  setRemoteBind: vi.fn(async () => {}),
  setRemotePort: vi.fn(async () => {}),
  regenerateRemoteToken: vi.fn(async () => {}),
  setRemotePassword: vi.fn(async () => {}),
  clearRemotePassword: vi.fn(async () => {}),
  onRemoteState: vi.fn(),
  getProviderOAuthState: vi.fn(async () => idleProviderOAuth),
  onProviderOAuthState: vi.fn(),
  readProviderOAuth: vi.fn(async (): Promise<never[]> => []),
  startProviderOAuth: vi.fn(async () => {}),
  submitProviderOAuthInput: vi.fn(async () => {}),
  cancelProviderOAuth: vi.fn(async () => {}),
  signOutProviderOAuth: vi.fn(async (): Promise<never[]> => []),
};

// The renderer no longer uses native dialogs (issue #373): a surviving
// alert/confirm call is a regression, so these stubs throw instead of
// recording, and nothing auto-accepts on a test's behalf.
const openedUrls: string[] = [];

const windowStub = {
  ompBackend: mockBackend,
  alert: (msg: string): never => {
    throw new Error(`unexpected window.alert: ${msg}`);
  },
  confirm: (msg: string): never => {
    throw new Error(`unexpected window.confirm: ${msg}`);
  },
  // open_url extension requests route through window.open; main's
  // setWindowOpenHandler owns the real policy, the stub just records the ask.
  open: (url?: string | URL): null => {
    openedUrls.push(String(url ?? ""));
    return null;
  },
  get setTimeout() {
    return globalThis.setTimeout;
  },
  get clearTimeout() {
    return globalThis.clearTimeout;
  },
  get setInterval() {
    return globalThis.setInterval;
  },
  get clearInterval() {
    return globalThis.clearInterval;
  },
  // The transcript scheduler (issue #187) coalesces onto rAF in production.
  // Tests commit synchronously by default; batching tests replace this with a
  // capturing stub and run the frame themselves.
  requestAnimationFrame: (cb: FrameRequestCallback): number => {
    cb(0);
    return 0;
  },
  cancelAnimationFrame: (): void => {},
};
Object.assign(globalThis, { window: windowStub });

// Dynamic import is required: ../backend reads window.ompBackend at module
// load, so the stub above must land before the store module evaluates.
const {
  COMPACTION_USAGE_MAX_ATTEMPTS,
  COMPACTION_USAGE_RETRY_MS,
  deriveSidebarSessionState,
  isLateAckCommand,
  QUEUE_SETTLE_REFRESH_MS,
  registerShellWriter,
  RpcCommandTimeoutError,
  STREAM_STALL_THRESHOLD_MS,
  STREAM_STALL_TICK_MS,
  useStore,
} = await import("../store");
const { rpcCommandMachinery } = await import("../store/slices/rpc-command");
const { resetTabRuntimesForTests } = await import("../store/slices/shared");

/** Deterministic event-drain for promise chains (no wall-clock waiting). */
const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const TAB = "tab-test-1";

function stateWithRecord(
  sessionId: string | null,
  live: LiveState = "live",
  worktree: SessionWorktree | null = null,
): BackendState {
  return makeBackendState({
    projects: [
      {
        project: {
          path: "/p",
          name: "p",
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
            tabId: TAB,
            sessionId,
            lineageDir: "omp-ui--p--11111111-2222-3333-4444-555555555555",
            projectCwd: "/p",
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
            title: "New session",
            status: null,
            live,
            pendingPlan: null,
            planSettle: null,
            streamStalled: false,
          },
        ],
      },
    ],
  });
}

function respond(
  tabId: string,
  cmd: Record<string, unknown>,
  data: unknown,
  success = true,
) {
  useStore.getState().handleRpcFrame(tabId, {
    type: "response",
    id: cmd.id,
    command: cmd.type,
    success,
    ...(success ? { data } : { error: String(data) }),
  });
}

/** Runs bootRpcTab while answering every command it emits, in wave order. */
async function driveBoot(
  tabId: string,
  responses: Record<string, { data?: unknown; success?: boolean }> = {},
): Promise<string[]> {
  const boot = useStore.getState().bootRpcTab(tabId);
  const answered: string[] = [];
  // Commands arrive in waves: subscription/get_state, models/messages, then
  // the fire-and-forget advisor-stat arm.
  for (let wave = 0; wave < 4; wave++) {
    await flushMicrotasks();
    for (const { cmd } of sent.splice(0)) {
      answered.push(
        cmd.type === "prompt" ? String(cmd.message) : String(cmd.type),
      );
      const r = responses[String(cmd.type)] ?? {};
      respond(tabId, cmd, r.data ?? {}, r.success ?? true);
    }
  }
  await boot;
  return answered;
}

beforeEach(() => {
  rpcCommandMachinery.resetForTests();
  resetTabRuntimesForTests();
  sent.length = 0;
  openedUrls.length = 0;
  backendState = makeBackendState();
  useStore.setState({
    state: null,
    tabs: [],
    activeTabId: null,
    focusedTabByProject: {},
    restoringTabs: false,
    exited: {},
    rpc: {},
    compactionSettings: {},
    deleteConfirmation: null,
    lifecycleConfirmation: null,
    errorNotices: [],
    appUpdate: idleAppUpdate,
    ompUpdate: idleOmpUpdate,
    remote: idleRemoteState,
    providerOAuth: idleProviderOAuth,
  });
  vi.clearAllMocks();
});

// The single entry point for the store tests. `backendState` and
// `shellExitCb` are accessor pairs: the test files reassign them, and the
// mock closures above read the module bindings, not the object's fields.
export const h = {
  useStore,
  COMPACTION_USAGE_MAX_ATTEMPTS,
  COMPACTION_USAGE_RETRY_MS,
  QUEUE_SETTLE_REFRESH_MS,
  STREAM_STALL_THRESHOLD_MS,
  STREAM_STALL_TICK_MS,
  RpcCommandTimeoutError,
  deriveSidebarSessionState,
  isLateAckCommand,
  registerShellWriter,
  rpcCommandMachinery,
  sent,
  openedUrls,
  mockBackend,
  windowStub,
  emptyOmpSettings,
  get backendState(): BackendState {
    return backendState;
  },
  set backendState(v: BackendState) {
    backendState = v;
  },
  get shellExitCb() {
    return shellExitCb;
  },
  set shellExitCb(cb: ((tabId: string, code: number) => void) | null) {
    shellExitCb = cb;
  },
  idleAppUpdate,
  idleOmpUpdate,
  idleRemoteState,
  idleProviderOAuth,
  TAB,
  stateWithRecord,
  respond,
  driveBoot,
  flushMicrotasks,
  deferred,
  /** The error notices the store recorded, in arrival order (issue #373). */
  errorMessages: () => useStore.getState().errorNotices.map((n) => n.message),
};
