import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { app, dialog, ipcMain, MessageChannelMain, screen, shell, type BrowserWindow, type MessagePortMain } from "electron";
import {
  CH,
  browseDirectories,
  checkoutBranch,
  discoverAgentNames,
  execOmpConfigRunner,
  createBranch,
  dispatchNotify,
  dispatchRequest,
  formatModelRole,
  generateBranchNameWithOmp,
  getArchiveRoot,
  getScopedCapabilities,
  getWatchdogRoster,
  importReviewRosters,
  resolveReviewRoster,
  setWatchdogRoster,
  getOmpAgentDir,
  getSessionsRoot,
  hydrateSessionFile,
  readOmpAdvisorDefaults,
  readOmpModelRole,
  readOmpSettings,
  checkPythonSetup,
  readOmpCompactionMethods,
  readWebSearchProviders,
  readJudgeModels,
  readModelCatalog,
  readBranchDiff,
  readInstalledOmpVersion,
  ompPinActive,
  compareVersions,
  MIN_SUPPORTED_OMP,
  listBranches,
  mergeWorktreeBranch,
  readMemoryOverview,
  readStatsOverview,
  readModelsFileModelProviders,
  resolveModelHold,
  readModelSelectorError,
  readMergeBackStatus,
  resolveMergeDestination,
  pullBranch,
  pushBranch,
  pullRequestUrl,
  reclaimCheckouts,
  detectPackageFormat,
  isWithin,
  sweepOrphanWorktrees,
  sweepOrphanChatDirs,
  isInChatsRoot,
  listProjectFiles,
  resolveFileMentions,
  resolveMcpServers,
  resolveProjectPath,
  setMcpServerEnabled,
  setScopedCapability,
  ProviderOAuth,
  ProviderKeys,
  Registry,
  RemoteInstanceStore,
  resolveOmpBinary,
  anonymizeSession,
  adoptIntoLineage,
  authExport,
  authImport,
  markSessionMoved,
  packSessionFile,
  shredFile,
  unpackSessionArchive,
  unarchiveSession,
  resolveSessionLocation,
  isSafeAgentName,
  isSafeSelector,
  parseUnpackedAgentNames,
  readProjectConfigMap,
  readProjectConfigValue,
  setProjectConfigMapEntry,
  setProjectConfigValue,
  seedMemoryDefaults,
  writeOmpSetting,
  resetOmpSetting,
  collectDiagnosticsBundle,
  previewDiagnosticsBundle,
  detectVaults,
  findObsidianList,
  knowledgeVaultDiagnostics,
  FLEET_LABEL_MAX,
  LOCAL_MACHINE_KEY,
  git,
  renderSessionSummary,
  resolveRepositoryKey,
  sampleHostResources,
  detectHostOs,
  detectPackageManagers,
  type FleetDispatchRequest,
  type FleetExecRequest,
  type FleetDetachedExecRequest,
  type FleetExecPollRequest,
  type FleetProviderKeysRequest,
  type FleetGrantRaiseRequest,
  type FleetProjectManageRequest,
  type FleetRequester,
  type FleetRung,
  type FleetSendRequest,
  type FleetHostReport,
  type FleetUpdateRequest,
  type FleetUpdateMemberRequest,
  type FleetUpdatePollRequest,
  type FleetHostOs,
  type FleetPackageManager,
  type HostResources,
  type BrowserPaneInputEvent,
  type BrowserPaneNavigate,
  TITLE_MODEL_ROLES,
  type AdvisorDefaults,
  type BackendState,
  type ChannelTable,
  type BranchListOptions,
  type CollabAccess,
  type ConsoleProgram,
  type DocumentAttachment,
  type ImageAttachment,
  type KnowledgeHome,
  type McpSetEnabledRequest,
  type ScopedCapabilityMutation,
  type ReviewWriteRequest,
  type WatchdogWriteRequest,
  type LiveState,
  type OmpSettingValue,
  type OwnedSessionRecord,
  type ProviderKeysSnapshot,
  type DiagnosticsExportRequest,
  type DiagnosticsExportResult,
  type AnonymizeSessionResult,
  type AuthCarryResult,
  type IngestFinishResult,
  type PackStartResult,
  type DiagnosticsOptions,
  type RemoteInstanceInput,
  type RemoteInstancePatch,
  type RpcFrame,
  isApprovalMode,
  type ApprovalMode,
  type ServiceTier,
  type SessionMode,
  type SpawnGateState,
  type SpawnRequest,
  type WorktreeReleaseOptions,
  type SessionSummary,
  type PlanReviewVerdict,
  type ProjectGroup,
  type ProjectRecord,
  type ProjectOpenTarget,
  type ProjectScalarResult,
  type ProjectSpendCapsResult,
  type SpendCapKey,
  type ProjectSubagentModelsResult,
  type SubagentModelMap,
  type RootGuard,
  type VaultDetection,
} from "@omp-ui/core";
import { mintRemoteToken } from "@omp-ui/server";
import { HeadWatcherHub } from "./git-head-watchers";
import { OmpUpdater } from "./omp-update";
import { AppUpdater, isAutoUpdateFormat } from "./app-update";
import { RemoteServerManager } from "./remote-server";
import { RemoteInstanceManager } from "./remote-instance-manager";
import { routeByTab } from "./remote-route";
import { SessionManager } from "./session-manager";
import { FleetDispatcher } from "./fleet-dispatcher";
import { FleetServer } from "./fleet-server";
import { FleetWakeCoordinator } from "./fleet-wake";
import { probeSshPort } from "./ssh-probe";
import { PlanVerifier } from "./plan-verifier";
import { ClockStamper } from "./clock-stamper";
import { readConfinedPlanFile } from "./plan-file";
import { DesktopNotifier } from "./desktop-notifier";
import { appendMainLog } from "./main-log";
import { electronKeyCipher } from "./key-cipher";
import { ProjectOpener } from "./project-open";
import { openExternalSafe } from "./open-external";
import { openExternal, openPath } from "./system-open";
import { NO_GATE, type SpawnGate } from "./spawn-gate";
import { windowStatePath } from "./window-state";
import { NO_BREADCRUMBS, type BreadcrumbSink } from "./breadcrumbs";
import { readExperimentDetail, readProjectExperiments, readRunLog } from "./experiments";
import { registerSettingsHandlers } from "./settings-handlers";
import { registerSttHandlers } from "./stt-handlers";
import { registerAudioHandlers } from "./audio-handlers";
import { applyAudioDevice, execPactlRunner } from "./audio-devices";
import { registerLiveAudioHandlers } from "./live-audio";
import { registerLiveTranscriptHandlers } from "./live-transcript";
import { registerRemoteHandlers } from "./remote-handlers";
import { registerVaultHandlers } from "./vault-handlers";
import { DESKTOP_PANE_PORT, DESKTOP_PANE_PORT_REQUEST, type DesktopMediaMessage } from "../browser-pane-desktop-protocol";
import { createDesktopPaneStream } from "./browser-pane-desktop-stream";
import { TransferState } from "./transfer-state";

/** A Fleet result's summary read races this window, the same bound as the status tool's summary race. */
const FLEET_CHILD_SUMMARY_TIMEOUT_MS = 5_000;

/** Owns application state and delegates every live child to SessionManager. */
export class MainBackend {
  /** Serializes each complete state build and delivery so an older snapshot can never overtake a newer one. */
  private broadcastChain: Promise<void> = Promise.resolve();
  /** Long-poll fleet status waiters (issue #958): each resolves after the next completed broadcast. */
  readonly #broadcastWaiters = new Set<() => void>();
  private readonly registry: Registry;
  private ompPath = resolveOmpBinary();
  readonly sessions: SessionManager;
  /** The one plan verification service (§4): owned here, injected downward. */
  private readonly planVerifier: PlanVerifier;
  /** Stamps the browser clock onto agent screenshots (see CONTEXT.md "Browser clock"). */
  private readonly clockStamper: ClockStamper;
  /** OS notifications for background sessions (issue #271). */
  private readonly notifier: DesktopNotifier;
  private readonly appUpdater: AppUpdater;
  private readonly ompUpdater: OmpUpdater;
  private readonly remote: RemoteServerManager;
  /** Joined remote instances (issue #416): their sockets, credentials, and merged registries. */
  private readonly remoteInstances: RemoteInstanceManager;
  /** Fleet dispatch, dispatching side (issue #899, ADR-0061). */
  private readonly fleet: FleetDispatcher;
  /** Fleet exec ladder, node side (issue #901, ADR-0062): this machine's ceiling. */
  private readonly fleetServer: FleetServer;
  /** Fleet result wake-up (issue #957, ADR-0069): the dispatching session's watch → stage → deliver ledger. */
  private readonly fleetWake: FleetWakeCoordinator;
  /** fleet:hostReport caches: one shared resource sample per 5 s, repository
   *  keys per path for 60 s, head commits per path for 15 s. */
  private fleetResources: { at: number; value: Promise<HostResources> } | null = null;
  /** The member's OS, probed once per process; package managers cached 60 s (issue #905). */
  private fleetOs: Promise<FleetHostOs> | null = null;
  private fleetPackageManagers: { at: number; value: Promise<FleetPackageManager[]> } | null = null;
  /** The managed omp binary's version (fleet remote version update): one
   *  child spawn per 60 s, not one per report. */
  private fleetOmpVersion: { at: number; value: Promise<string | null> } | null = null;
  private readonly fleetRepositoryKeys = new Map<string, { at: number; value: Promise<string | null> }>();
  private readonly fleetHeadCommits = new Map<string, { at: number; value: Promise<string | null> }>();
  /**
   * Project git probes still in flight (repository key, HEAD commit) and the
   * fire-and-forget tails that write their result to the registry. Each `git`
   * child holds its project folder as cwd until it exits, so killAll's promise
   * waits for them as it does for the gitdir probes (#503, #909).
   */
  private readonly projectProbes = new Set<Promise<unknown>>();
  /** `os.hostname()` cut to FLEET_LABEL_MAX code points: the requester and host-report label. */
  private readonly fleetLabel = [...os.hostname()].slice(0, FLEET_LABEL_MAX).join("") || "omp-ui";
  /** The member's login user for the fleet ssh line (issue #904); os.userInfo throws when the uid has no passwd entry. */
  private readonly fleetUser: string | null = (() => {
    try {
      return os.userInfo().username || null;
    } catch {
      return null;
    }
  })();
  /** Per-project gitdir watchers (#498): churn answers with branch:changed. */
  private readonly headWatchers: HeadWatcherHub;
  private readonly projectOpener = new ProjectOpener();
  /** #888 bundle staging: pack archives in, ingest bundles out; shredded on
   * abort, finish, or the idle sweep. */
  private readonly transfers = new TransferState();
  /**
   * Provider credentials for every omp launch. Constructed before any spawn
   * path can run and applied immediately, so even the first session sees the
   * stored keys; the login-shell capture is awaited separately at boot.
   */
  private readonly providerKeys: ProviderKeys;
  /**
   * Subscription (OAuth) sign-ins (issue #368): app-global, one flow at a
   * time, driving omp's rpc `login` in a bare session-less child.
   */
  private readonly providerOAuth: ProviderOAuth;
  /** Where worktree checkouts live; defaults beside the registry. */
  private readonly worktreesRoot: string;
  /** Where chat scratch dirs live (ADR-0059); defaults beside the registry. */
  private readonly chatsRoot: string;
  /** The parsed dev/test gate; one value feeds every spawn and the state projection. */
  private readonly spawnGate: SpawnGate;
  /** Precomputed wire projection of `spawnGate`; identical on every broadcast. */
  private readonly spawnGateState: SpawnGateState;
  /** Absolute registry.json path; the default bundle destination sits beside it. */
  private readonly registryFile: string;
  /** Main-process log directory; shared with index.ts when it passes one. */
  private readonly logDir: string;
  private readonly breadcrumbs: BreadcrumbSink;
  /** This build's version as reported to joiners and the app updater alike. */
  private readonly appVersion: string;
  /** One in-flight export at a time (issue #413). */
  private exportInFlight = false;
  /** Last delivered update statuses, for one-per-transition breadcrumbs. */
  private lastAppUpdateStatus: string | null = null;
  private lastOmpUpdateStatus: string | null = null;
  /** The app window's real page devicePixelRatio; screen.scaleFactor lies on Wayland fractional scaling (#557). */
  private panePageDpr = 1;
  private paneDprProbeTimer: NodeJS.Timeout | undefined;
  private readonly desktopPaneStream = createDesktopPaneStream();
  private desktopPanePort: MessagePortMain | null = null;
  private desktopPaneSubscribe: ChannelTable["notify"][typeof CH.browserPaneSubscribe] | null = null;
  private readonly desktopPaneSubscriptions = new Map<string, Map<string, "media" | "jpeg">>();
  private desktopPaneStopped = false;

  constructor(
    private readonly win: BrowserWindow,
    registryFile: string,
    opts: {
      setAppUpdateQuitAuthorized?: (on: boolean) => void;
      appUpdateEnabled?: boolean;
      appVersion?: string;
      appUpdateEnv?: NodeJS.ProcessEnv;
      /** Directory holding the built browser bundle for remote clients (out/web). */
      webRoot?: string;
      /** Where provider credentials are stored; defaults beside the registry. */
      providerKeysFile?: string;
      /** Where joined-instance credentials are stored; defaults beside the registry. */
      remoteInstancesFile?: string;
      /** Where worktree checkouts live; defaults beside the registry. */
      worktreesRoot?: string;
      /** Where chat scratch dirs live; defaults beside the registry. */
      chatsRoot?: string;
      /** Dev/test model pins forced on every spawn this instance makes. */
      spawnGate?: SpawnGate;
      /** Process owner override for focused main-process tests. */
      sessions?: SessionManager;
      /** Main-process log dir (index.ts already computes it); defaults beside the registry. */
      logDir?: string;
      /** Lifecycle breadcrumb sink; defaults to the silent NO_BREADCRUMBS. */
      breadcrumbs?: BreadcrumbSink;
    } = {},
  ) {
    this.registryFile = registryFile;
    this.logDir = opts.logDir ?? path.join(path.dirname(registryFile), "logs");
    this.breadcrumbs = opts.breadcrumbs ?? NO_BREADCRUMBS;
    this.appVersion = opts.appVersion ?? app.getVersion();
    this.registry = Registry.load(registryFile);
    // Applied in the constructor, not at boot: spawn() must never be reachable
    // with a keyless environment, and the login-shell capture (boot, async) only
    // ever adds to what is already installed here.
    this.providerKeys = new ProviderKeys(
      opts.providerKeysFile ?? path.join(path.dirname(registryFile), "provider-keys.json"),
      electronKeyCipher(),
    );
    this.providerKeys.applyToProcessEnv();
    // Retained once: the SessionManager pins and the state projection must
    // describe the same startup value, never two environment reads.
    this.spawnGate = opts.spawnGate ?? NO_GATE;
    this.spawnGateState = {
      model: this.spawnGate.model === null ? null : formatModelRole(this.spawnGate.model),
      advisorModel:
        this.spawnGate.advisorModel === null ? null : formatModelRole(this.spawnGate.advisorModel),
    };
    this.providerOAuth = new ProviderOAuth({
      getOmpPath: () => this.ompPath,
      scratchDir: path.join(path.dirname(registryFile), "oauth-login"),
      send: (state) => this.send(CH.onProviderOAuthState, state),
      onOpenUrl: openExternalSafe,
    });
    this.worktreesRoot =
      opts.worktreesRoot ?? path.join(path.dirname(registryFile), "worktrees");
    this.chatsRoot = opts.chatsRoot ?? path.join(path.dirname(registryFile), "chats");
    // OS notifications for background sessions (issue #271). The icon path
    // mirrors index.ts's BrowserWindow icon: one main bundle, so __dirname is
    // out/main in dev and packaged alike.
    const iconPath = path.join(__dirname, "../../build/icon.png");
    this.notifier = new DesktopNotifier({
      win,
      isEnabled: () => this.registry.getSetting("desktopNotifications"),
      localeId: () => this.registry.getSetting("localeId"),
      isViewedByDesktop: (tabId) => this.sessions.isViewedInDesktop(tabId),
      titleOf: (tabId) => {
        const record = this.registry.sessions.find((s) => s.tabId === tabId);
        return record?.cachedTitle?.trim() || "New session";
      },
      icon: () => (fs.existsSync(iconPath) ? iconPath : null),
      send: (channel, ...args) => this.send(channel, ...args),
    });
    this.planVerifier = new PlanVerifier();
    this.clockStamper = new ClockStamper();
    this.sessions =
      opts.sessions ??
      new SessionManager({
        registry: this.registry,
        registryFile,
        providerKeys: this.providerKeys,
        hasOAuthProvider: () => this.providerOAuth.hasModelAccount(),
        hasConfiguredModelsFileProvider: () => readModelsFileModelProviders().length > 0,
        resolveModelHold: (model) => resolveModelHold(model),
        readModelSelectorError: async (selector, cwd) =>
          this.ompPath === null ? null : readModelSelectorError({ ompPath: this.ompPath, cwd, selector }),
        readModelCatalog: () => readModelCatalog({ ompPath: this.ompPath }),
        getOmpPath: () => this.ompPath,
        getSessionsRoot: () => this.sessionsRoot,
        getArchiveRoot: () => this.archiveRoot,
        getWorktreesRoot: () => this.worktreesRoot,
        getChatsRoot: () => this.chatsRoot,
        send: (channel, ...args) => this.send(channel, ...args),
        broadcast: () => this.broadcast(),
        attention: this.notifier,
        breadcrumb: this.breadcrumbs,
        spawnGate: this.spawnGate,
        appVersion: this.appVersion,
        mainLog: (line) => appendMainLog(this.logDir, "main.log", line),
        planVerify: (html, themeId, signal) => this.planVerifier.verify(html, themeId, signal),
        // The host notify tool posts through the same notifier, bypassing the
        // attention pipeline's delay and suppression (#688).
        hostNotify: (tabId, title, message) => this.notifier.notifyNow(tabId, title, message),
        // Lazy: the dispatcher is constructed after remoteInstances, below.
        fleet: () => this.fleet,
        // Lazy for the same reason: the wake coordinator follows the fleet server.
        fleetWake: () => this.fleetWake,
        browserPane: {
          // Cache the app window's real page dpr; screen.scaleFactor lies on Wayland
          // fractional scaling (reports 1 while the page renders at 1.5) (#557).
          // Dividing by the zoom factor keeps transcript Ctrl+/- zoom out of the pane.
          targetScaleFactor: () => {
            if (this.win.isDestroyed()) return 1;
            try {
              const zoom = this.win.webContents.getZoomFactor();
              return zoom > 0 ? this.panePageDpr / zoom : this.panePageDpr;
            } catch {
              return this.panePageDpr;
            }
          },
          stampImage: (req) => this.clockStamper.stamp(req),
          onDesktopMedia: (tabId, message) => this.forwardDesktopMedia(tabId, message),
        },
      });
    // Probe the window's true page dpr when the shell loads (and reloads) and
    // whenever the display geometry could have changed (#557). Every hook is
    // guarded: the unit-test fake windows carry only the sink surface.
    if (typeof win.webContents.on === "function") {
      win.webContents.on("did-finish-load", () => this.probePanePageDpr());
      win.webContents.on("did-start-navigation", (details) => {
        if (details.isMainFrame && !details.isSameDocument) this.resetDesktopPaneStream();
      });
      win.webContents.on("render-process-gone", () => this.resetDesktopPaneStream());
      win.webContents.on("destroyed", () => this.resetDesktopPaneStream());
    }
    // try/catch: the unit-test electron mocks are partial and throw on any
    // `screen` property access; a missing hook only costs a re-probe.
    try {
      screen.on("display-metrics-changed", () => this.probePanePageDpr());
    } catch {
      /* screen unavailable (mocked or pre-ready) */
    }
    if (typeof win.on === "function")
      win.on("moved", () => {
        // Cross-display drag: debounce so a drag is one probe, not one per pixel.
        clearTimeout(this.paneDprProbeTimer);
        this.paneDprProbeTimer = setTimeout(() => this.probePanePageDpr(), 300);
      });
    // The desktop window is one event mirror among several — the remote server adds its own.
    // Guarded here rather than in send(): on/after quit the webContents is gone.
    this.addSink((channel, args) => this.sendToRenderers(channel, args));
    this.appUpdater = new AppUpdater({
      win,
      enabled: opts.appUpdateEnabled ?? app.isPackaged,
      currentVersion: this.appVersion,
      env: opts.appUpdateEnv,
      downloadsDir: app.getPath("downloads"),
      getDismissed: () => this.registry.getSetting("dismissedAppUpdateVersion"),
      setDismissed: (v) => this.registry.setSetting("dismissedAppUpdateVersion", v),
      hasLiveSessions: () => this.sessions.liveCount > 0,
      getTrain: () => this.registry.getSetting("appUpdateTrain"),
      setQuitAuthorized: opts.setAppUpdateQuitAuthorized ?? (() => {}),
      send: (ch, s) => {
        // One breadcrumb per status transition, not per heartbeat (issue #413).
        if (this.lastAppUpdateStatus !== s.status) {
          this.lastAppUpdateStatus = s.status;
          this.breadcrumbs.record("update-stage", { detail: `app:${s.status}` });
        }
        this.send(ch, s);
      },
      channel: CH.onAppUpdateState,
    });
    this.ompUpdater = new OmpUpdater({
      getDismissed: () => this.registry.getSetting("dismissedOmpUpdateVersion"),
      setDismissed: (v) => this.registry.setSetting("dismissedOmpUpdateVersion", v),
      onApplied: () => this.refreshOmpPath(),
      autoUpgrade: () => this.registry.getSetting("ompAutoUpgrade"),
      send: (ch, s) => {
        if (this.lastOmpUpdateStatus !== s.status) {
          this.lastOmpUpdateStatus = s.status;
          this.breadcrumbs.record("update-stage", { detail: `omp:${s.status}` });
        }
        this.send(ch, s);
      },
      channel: CH.onOmpUpdateState,
    });
    // Mint at construction so the settings page always has a token to reveal, even before the
    // server is first enabled.
    if (this.registry.getSetting("remoteToken") === "") this.registry.setSetting("remoteToken", mintRemoteToken());
    this.remote = new RemoteServerManager({
      host: { handlers: () => this.handlers(), addSink: (s) => this.addSink(s) },
      webRoot: opts.webRoot ?? "",
      getSettings: () => ({
        enabled: this.registry.getSetting("remoteEnabled"),
        bind: this.registry.getSetting("remoteBind"),
        port: this.registry.getSetting("remotePort"),
        token: this.registry.getSetting("remoteToken"),
        passwordHash: this.registry.getSetting("remotePasswordHash"),
        passwordSalt: this.registry.getSetting("remotePasswordSalt"),
      }),
      setToken: (token) => this.registry.setSetting("remoteToken", token),
      send: (state) => {
        // The remote port joins the browser pane's denied loopback ports (#531).
        this.sessions.setRemoteAccessPort(state.status === "listening" ? state.port : null);
        this.send(CH.onRemoteState, state);
      },
    });
    // A stable identity so a joiner can recognise this app as itself (issue #416).
    if (this.registry.getSetting("instanceId") === "") this.registry.setSetting("instanceId", randomUUID());
    // A registry that already carries a life — projects or sessions — is not a
    // first install; seed the Getting started checklist as seen so the upgrade
    // never pops it (issue #623).
    if (
      !this.registry.getSetting("gettingStartedSeen") &&
      (this.registry.projects.length > 0 || this.registry.sessions.length > 0)
    ) {
      this.registry.setSetting("gettingStartedSeen", true);
    }
    this.remoteInstances = new RemoteInstanceManager({
      store: new RemoteInstanceStore(
        opts.remoteInstancesFile ?? path.join(path.dirname(registryFile), "remote-instances.json"),
        electronKeyCipher(),
      ),
      localInstanceId: () => this.registry.getSetting("instanceId"),
      localVersion: this.appVersion,
      send: (ch, args) => this.send(ch, ...args),
      sendToRenderers: (ch, args) => this.sendToRenderers(ch, args),
      broadcast: () => this.broadcast(),
    });
    this.fleet = new FleetDispatcher({
      localReport: () => this.fleetHostReport(),
      spawnLocal: (req) => this.sessions.spawn(req),
      remotes: () => this.remoteInstances.summaries(),
      request: (id, channel, args) => this.remoteInstances.request(id, channel, args),
      preferences: () => this.registry.getSetting("fleetPlacement"),
      requesterBase: () => ({ instanceId: this.registry.getSetting("instanceId"), label: this.fleetLabel }),
      knownDispatchIds: () => {
        const ids = new Set<string>();
        for (const s of this.registry.sessions) if (s.fleet !== null) ids.add(s.fleet.dispatchId);
        for (const remote of this.remoteInstances.summaries()) {
          for (const group of remote.projects) {
            for (const s of group.sessions) if (s.fleet != null) ids.add(s.fleet.dispatchId);
          }
        }
        return ids;
      },
      fleetSessions: async () => {
        const local = (await this.buildState()).projects.flatMap((g) =>
          g.sessions.map((summary) => ({ machineKey: LOCAL_MACHINE_KEY, nickname: null, summary })),
        );
        const remote = this.remoteInstances.summaries().flatMap((r) =>
          r.projects.flatMap((g) => g.sessions.map((summary) => ({ machineKey: r.id, nickname: r.nickname, summary }))),
        );
        return [...local, ...remote];
      },
      localSummary: (tabId) => this.fleetSessionSummary(tabId),
      broadcast: () => this.broadcast(),
      probeSsh: (host) => probeSshPort(host),
      providerKeyValue: (envName) => this.providerKeys.rolloutValue(envName),
      watchAgentDispatch: (sourceTabId, dispatches) => this.fleetWake.watch(sourceTabId, dispatches),
      nextBroadcast: (timeoutMs) => {
        const { promise, resolve } = Promise.withResolvers<void>();
        const done = (): void => {
          clearTimeout(timer);
          this.#broadcastWaiters.delete(done);
          resolve();
        };
        const timer = setTimeout(done, timeoutMs);
        this.#broadcastWaiters.add(done);
        return promise;
      },
      sendLocal: (req) => this.fleetServer.send(req),
    });
    // The node half of the fleet ladder (issue #901): the owner answers for
    // its own machine, so it shares the registry and log dir with everything else.
    this.fleetServer = new FleetServer({
      registry: this.registry,
      logDir: this.logDir,
      broadcast: () => void this.broadcast(),
      addProject: async (dir) => {
        await this.addProjectPath(dir);
      },
      installProviderKey: (envName, value) => this.providerKeys.setKey(envName, value),
      // Fleet remote version update: the member self-updates through this
      // machine's own updaters — Fleet never reimplements staging or applies.
      ompInstallPath: () => this.ompPath,
      onOmpApplied: () => this.refreshOmpPath(),
      appUpdateState: () => this.appUpdater.state,
      stageAppUpdate: () => this.appUpdater.stageForRemoteRequest(),
      armAppUpdateOnQuit: () => {
        if (this.appUpdater.state.status !== "downloaded" || !isAutoUpdateFormat(this.appUpdater.state.format)) return false;
        this.appUpdater.setInstallOnQuit(true);
        return true;
      },
      liveSessions: () => this.sessions.liveCount,
      pinned: () => ompPinActive(),
      deliverSend: (req) => this.sessions.fleetSend(req),
    });
    this.fleetWake = new FleetWakeCoordinator({
      dir: path.join(path.dirname(registryFile), "fleet-wake"),
      instanceId: () => this.registry.getSetting("instanceId"),
      hasSession: (tabId) => this.registry.sessions.some((s) => s.tabId === tabId),
      summaryText: (machineKey, tabId) => this.fleetChildSummary(machineKey, tabId),
      flush: (tabId) => this.sessions.flushFleetWakes(tabId),
      log: (line) => appendMainLog(this.logDir, "main.log", line),
    });
    // Every registered project gets one gitdir watch (#498): a terminal
    // checkout, a commit, a branch made or deleted outside this app moves the
    // chip without a click or a focus change.
    this.headWatchers = new HeadWatcherHub({
      onChanged: (projectCwd) => this.send(CH.onBranchChanged, projectCwd, null),
    });
    // Startup hygiene (issue #262): a crash between `git worktree add` and
    // the registry write, or a lost registry, strands checkouts under the
    // worktrees root. The referenced snapshot is taken from the fully loaded
    // registry; any later spawn writes its record before creating observable
    // state, so a just-spawned checkout can never be swept. Fire-and-forget —
    // sweeping is hygiene, never load-bearing.
    const referencedWorktrees = new Set(
      this.registry.sessions
        .filter((s) => s.worktree)
        .map((s) => path.resolve(s.worktree!.path)),
    );
    // The audio device choices are persisted intent per role (issue #857):
    // another app may have moved the OS default since the last run, so every
    // start re-asserts each stored device. Best-effort — an unplugged or
    // gone device logs and leaves the OS default; never a dialog, never a
    // failed launch.
    for (const role of ["input", "output"] as const) {
      const stored = this.registry.getSetting(
        role === "input" ? "audioInputDevice" : "audioOutputDevice",
      );
      if (stored === null) continue;
      void applyAudioDevice(execPactlRunner(), stored, role).catch((err: unknown) => {
        console.warn(`[backend] audio ${role} device re-apply failed:`, err);
      });
    }
    void sweepOrphanWorktrees(this.worktreesRoot, referencedWorktrees)
      .then((removed) => {
        if (removed.length > 0) {
          console.log(`[backend] swept ${removed.length} orphan worktree checkout(s)`);
        }
      })
      .catch((err) => console.warn("[backend] worktree sweep failed:", err));
    void sweepOrphanChatDirs(this.chatsRoot, (abs) =>
      this.registry.sessions.some((s) => s.chat && path.resolve(s.projectCwd) === abs),
    )
      .then((removed) => {
        if (removed.length > 0) console.log(`[backend] swept ${removed.length} orphan chat dir(s)`);
      })
      .catch((err) => console.warn("[backend] chat sweep failed:", err));
  }

  /** Read the window's real page devicePixelRatio; screen.scaleFactor lies under Wayland fractional scaling (#557). */
  private probePanePageDpr(): void {
    if (this.win.isDestroyed()) return;
    void this.win.webContents
      .executeJavaScript("window.devicePixelRatio", true)
      .then((v) => {
        if (typeof v === "number" && Number.isFinite(v) && v > 0) this.panePageDpr = v;
      })
      .catch(() => {});
  }

  get liveCount(): number {
    return this.sessions.liveCount;
  }


  /**
   * Re-resolves the omp binary after an install/update so the fresh managed
   * copy (which ranks above PATH) is picked up without an app restart.
   */
  refreshOmpPath(): void {
    this.ompPath = resolveOmpBinary();
  }

  // Resolved lazily at every use — the XDG branch is existence-gated and can
  // flip while the app runs.
  private get sessionsRoot(): string {
    return getSessionsRoot();
  }

  private get archiveRoot(): string {
    return getArchiveRoot(this.sessionsRoot);
  }

  /** The roots a vault may never be or sit inside (#758); userData is the registry's folder, as in SessionManager's guard. */
  private vaultRootGuard(): RootGuard {
    return {
      home: os.homedir(),
      userData: path.dirname(this.registryFile),
      agentDir: getOmpAgentDir(),
      sessionsRoot: this.sessionsRoot,
      archiveRoot: this.archiveRoot,
    };
  }

  /** Whether the OS has an obsidian:// handler; false when Electron cannot say. */
  private obsidianUriHandler(): boolean {
    try {
      return app.getApplicationNameForProtocol("obsidian://") !== "";
    } catch {
      return false;
    }
  }

  private detectVaults(): Promise<VaultDetection> {
    return detectVaults(this.registry.getSetting("vaultRegistry"), {
      env: process.env,
      platform: process.platform,
      home: os.homedir(),
      guard: this.vaultRootGuard(),
      uriHandler: this.obsidianUriHandler(),
    });
  }

  private readonly sinks = new Set<(channel: string, args: unknown[]) => void>();

  /** Registers an extra event mirror (the remote server). Returns its unsubscribe. */
  addSink(sink: (channel: string, args: unknown[]) => void): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  private send(channel: string, ...args: unknown[]): void {
    for (const sink of this.sinks) sink(channel, args);
  }

  /**
   * Delivers an event to this app's Electron window(s) only — never into
   * `sinks`, so an event converted here can not re-enter a socket relay and
   * loop across a mutual join (#498).
   */
  private sendToRenderers(channel: string, args: unknown[]): void {
    if (channel === CH.onBrowserPaneFrame) {
      const [tabId, frame] = args;
      if (typeof tabId === "string" && frame instanceof Uint8Array) this.desktopPaneStream.offer(tabId, frame);
      return;
    }
    if (this.win.isDestroyed()) return;
    const wc = this.win.webContents;
    // A crashed renderer is not "destroyed" — sending into it throws
    // "Render frame was disposed …" once per frame until the app is killed
    // (issue #183).
    if (wc.isDestroyed() || wc.isCrashed()) return;
    try {
      wc.send(channel, ...args);
    } catch (err) {
      this.noteSinkFailure(err);
    }
  }

  private sinkFailureLastLog = 0;

  /** Rate-limited warn for window-sink failures — a dead renderer must not spam. */
  private noteSinkFailure(err: unknown): void {
    const now = Date.now();
    if (now - this.sinkFailureLastLog < 60_000) return;
    this.sinkFailureLastLog = now;
    console.warn(
      `[backend] window sink send failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }


  /** Assembles the collector's view of this app from state the class already owns. */
  private async diagnosticsOptions(
    req: DiagnosticsExportRequest,
  ): Promise<DiagnosticsOptions> {
    const sessions = this.registry.sessions;
    return {
      ...req,
      settings: this.registry.settingsSnapshot(),
      projects: this.registry.projects,
      sessions,
      liveTabIds: sessions.filter((s) => this.sessions.isLive(s.tabId)).map((s) => s.tabId),
      breadcrumbs: this.breadcrumbs.entries(),
      browserPanes: this.sessions.browserPaneDiagnostics(),
      knowledgeVault: knowledgeVaultDiagnostics(
        this.registry.getSetting("vaultRegistry"),
        await this.detectVaults(),
        this.sessions.vaultCallCounts(),
      ),
      facts: {
        appVersion: app.getVersion(),
        ompVersion: this.ompPath ? await readInstalledOmpVersion(this.ompPath) : null,
        ompPath: this.ompPath,
        electronVersion: process.versions.electron ?? null,
        nodeVersion: process.version,
        chromeVersion: process.versions.chrome ?? null,
        packaged: app.isPackaged,
        packageFormat: detectPackageFormat(),
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        cpuModels: os.cpus().map((cpu) => cpu.model),
        sessionsRoot: this.sessionsRoot,
        archiveRoot: this.archiveRoot,
        agentDir: getOmpAgentDir(),
        registryFile: this.registryFile,
        logDir: this.logDir,
        windowStateFile: windowStatePath(app.getPath("userData")),
      },
    };
  }

  /** One in-flight export at a time; the renderer's busy state has the same guard as a backstop. */
  private async exportDiagnostics(req: DiagnosticsExportRequest): Promise<DiagnosticsExportResult> {
    if (this.exportInFlight) throw new Error("diagnostic export already in progress");
    this.exportInFlight = true;
    try {
      return await collectDiagnosticsBundle(await this.diagnosticsOptions(req));
    } finally {
      this.exportInFlight = false;
    }
  }
  /**
   * Every channel's implementation, transport-agnostic: Electron IPC binds these below and the
   * remote WebSocket server dispatches the same table (issue #37).
   */
  handlers(): ChannelTable {
    const table = {
      request: {
        [CH.getState]: () => this.buildState(),
        [CH.addProject]: async (raw: string) => this.addProjectPath(await resolveProjectPath(raw)),
        [CH.browseDirectories]: (partialPath: string) => browseDirectories(partialPath),
        [CH.removeProject]: async (projectPath: string) => {
          if (this.sessions.hasLiveInProject(projectPath)) {
            throw new Error("project has live sessions — terminate them first");
          }
          this.sessions.stopProjectWatchers(projectPath);
          this.headWatchers.stop(projectPath);
          const sessions = this.registry.sessions;
          const checkouts = sessions.flatMap((session) =>
            session.projectCwd === projectPath && session.worktree !== null
              ? [{ projectCwd: projectPath, worktree: session.worktree }]
              : [],
          );
          await reclaimCheckouts(checkouts, {
            worktreesRoot: this.worktreesRoot,
            survivingSessions: sessions.filter((session) => session.projectCwd !== projectPath),
            warn: (message, error) =>
              error === undefined
                ? console.warn(`[backend] ${message}`)
                : console.warn(`[backend] ${message}`, error),
          });
          this.registry.removeProject(projectPath);
          await this.broadcast();
        },
        [CH.setProjectDefaultModel]: async (projectPath: string, model: string | null) => {
          this.registry.setProjectDefaultModel(projectPath, model?.trim() || null);
          await this.broadcast();
        },
        [CH.setProjectDefaultAdvisorModel]: async (projectPath: string, model: string | null) => {
          this.registry.setProjectDefaultAdvisorModel(projectPath, model?.trim() || null);
          await this.broadcast();
        },
        [CH.setProjectBrowserClock]: async (projectPath: string, on: boolean) => {
          this.registry.setProjectBrowserClock(projectPath, on);
          await this.broadcast();
        },
        [CH.setProjectKnowledgeHome]: async (projectPath: string, home: KnowledgeHome | null) => {
          if (this.registry.setProjectKnowledgeHome(projectPath, home)) await this.broadcast();
        },
        [CH.getProjectSubagentModels]: (projectCwd: string): ProjectSubagentModelsResult => {
          const layer = readProjectConfigMap(projectCwd, ["task", "agentModelOverrides"]);
          return { map: layer.shape === "map" ? layer.value : {}, layer };
        },
        [CH.setProjectSubagentModel]: async (projectCwd: string, agent: string, value: string | null) => {
          // The writer quotes on emit, but a name/selector outside the grammar
          // could never match omp's resolution — refuse before touching the file.
          if (!isSafeAgentName(agent)) throw new Error(`refusing unsafe agent name: ${agent}`);
          if (value !== null && !isSafeSelector(value)) {
            throw new Error(`refusing unsafe model selector: ${value}`);
          }
          await setProjectConfigMapEntry(projectCwd, ["task", "agentModelOverrides"], agent, value);
        },
        [CH.getProjectMaxConcurrency]: (projectCwd: string): ProjectScalarResult => {
          const layer = readProjectConfigValue(projectCwd, ["task", "maxConcurrency"]);
          return { value: layer.shape === "value" ? layer.value : undefined, layer };
        },
        [CH.setProjectMaxConcurrency]: async (projectCwd: string, value: number | null) => {
          // The writer emits numbers bare, but a cap omp could never honor —
          // zero, a fraction, NaN — would hang or starve every spawn. Refuse
          // before touching the file, same stance as the agent-name guard.
          if (value !== null && (!Number.isInteger(value) || value < 1)) {
            throw new Error(`refusing invalid maxConcurrency: ${value}`);
          }
          await setProjectConfigValue(projectCwd, ["task", "maxConcurrency"], value);
        },
        [CH.getProjectSpendCaps]: (projectCwd: string): ProjectSpendCapsResult => {
          const read = (key: SpendCapKey): ProjectScalarResult => {
            const layer = readProjectConfigValue(projectCwd, ["session", key]);
            return { value: layer.shape === "value" ? layer.value : undefined, layer };
          };
          return { warnCost: read("warnCost"), maxCost: read("maxCost") };
        },
        [CH.setProjectSpendCap]: async (projectCwd: string, key: SpendCapKey, value: number | null) => {
          // The project file bypasses omp's own validator ("expected a
          // positive USD amount"), so refuse what omp would reject before
          // touching the file — the maxConcurrency guard's stance.
          if (value !== null && !(Number.isFinite(value) && value > 0)) {
            throw new Error(`refusing invalid session.${key}: ${value}`);
          }
          await setProjectConfigValue(projectCwd, ["session", key], value);
        },
        [CH.getProjectApprovalMode]: (projectCwd: string): ProjectScalarResult => {
          const layer = readProjectConfigValue(projectCwd, ["tools", "approvalMode"]);
          return { value: layer.shape === "value" ? layer.value : undefined, layer };
        },
        [CH.setProjectApprovalMode]: async (projectCwd: string, value: ApprovalMode | null) => {
          // A free-text value would make omp resolve the tier to yolo (no
          // approvals at all) — refuse before touching the file, same stance
          // as the maxConcurrency guard (issue #681, #950).
          if (value !== null && !isApprovalMode(value)) {
            throw new Error(`refusing invalid approvalMode: ${value}`);
          }
          await setProjectConfigValue(projectCwd, ["tools", "approvalMode"], value);
        },
        ...registerSettingsHandlers({
          registry: this.registry,
          broadcast: () => this.broadcast(),
          supportedCompactionMethods: async () =>
            (await readOmpCompactionMethods({ ompPath: this.ompPath, projectCwd: null }))
              .supported,
          onAppUpdateTrainChanged: () => this.appUpdater.onTrainChanged(),
          onFleetLadderChanged: () => this.fleetServer.enforceDetached(),
        }),
        ...registerVaultHandlers({
          registry: this.registry,
          broadcast: () => this.broadcast(),
          guard: () => this.vaultRootGuard(),
          detect: () => this.detectVaults(),
          obsidianList: () => findObsidianList(process.env, process.platform, os.homedir()),
          // system-open's openExternal: detached xdg-open with stdio ignored on Linux (#750), shell.openExternal elsewhere.
          open: (uri) => openExternal(uri),
        }),
        ...registerSttHandlers({
          registry: this.registry,
          ompPath: this.ompPath,
        }),
        ...registerAudioHandlers({
          registry: this.registry,
          broadcast: () => this.broadcast(),
        }),
        ...registerLiveAudioHandlers({
          registry: this.registry,
          getSessionsRoot: () => this.sessionsRoot,
        }),
        ...registerLiveTranscriptHandlers({
          registry: this.registry,
          getSessionsRoot: () => this.sessionsRoot,
        }),
        // The appUpdateDismiss/ompUpdateDismiss channels only ever set a dismissal;
        // re-arming a dismissed card from Settings needs its own pair.
        [CH.clearDismissedAppUpdate]: async () => {
          this.registry.setSetting("dismissedAppUpdateVersion", null);
          await this.broadcast();
        },
        [CH.clearDismissedOmpUpdate]: async () => {
          this.registry.setSetting("dismissedOmpUpdateVersion", null);
          await this.broadcast();
        },
        [CH.toggleFavorite]: async (key: string) => {
          this.registry.toggleFavorite(key);
          await this.broadcast();
        },
        [CH.setSessionModel]: (tabId: string, model: string | null, thinkingLevel: string | null) => {
          // #932: while held, the renderer's state echoes report omp's fallback
          // model; persisting one would replace the pin the next spawn retries.
          // A real pick lifts the hold before its own write arrives.
          if (this.sessions.modelHold(tabId) !== null) return;
          if (this.registry.setSessionModel(tabId, model, thinkingLevel)) {
            this.sessions.syncModelOverlay(tabId);
          }
          void this.broadcast();
        },
        [CH.setSessionAutoTitled]: (tabId: string, autoTitled: boolean) => {
          this.registry.updateSession(tabId, { autoTitled });
          void this.broadcast();
        },
        [CH.setSessionSnoozed]: (tabId: string, snoozed: boolean) => {
          this.registry.updateSession(tabId, { snoozed });
          void this.broadcast();
        },
        [CH.setSessionSubagentModels]: (tabId: string, map: SubagentModelMap | null) =>
          this.sessions.setSessionSubagentModels(tabId, map),
        [CH.spawnSession]: (req: SpawnRequest) => {
          // Rung-2 gate (issue #901): a fleet-provenanced spawn arriving from
          // another instance needs dispatch access here. Local dispatches call
          // sessions.spawn directly and never pass through this gate.
          const provenance = req.fleet;
          if (provenance !== undefined && provenance.requestedBy.instanceId !== this.registry.getSetting("instanceId")) {
            const gate = this.fleetServer.check(provenance.requestedBy, "dispatch");
            if (!gate.ok) throw new Error(`fleet access refused — ${gate.reason}`);
          }
          return this.sessions.spawn(req);
        },
        [CH.terminateSession]: (tabId: string) => this.sessions.terminate(tabId),
        [CH.hibernatePlanSource]: (sourceTabId: string, implementationTabId: string) =>
          this.sessions.hibernatePlanSource(sourceTabId, implementationTabId),
        [CH.settleSession]: (tabId: string) => this.sessions.settleSession(tabId),
        [CH.switchMode]: (tabId: string, mode: SessionMode) =>
          this.sessions.switchMode(tabId, mode),
        [CH.deleteSessionPreview]: (tabId: string) =>
          this.sessions.deleteSessionPreview(tabId),
        [CH.deleteSession]: (tabId: string, cascade: boolean) =>
          this.sessions.deleteSession(tabId, cascade),
        [CH.forkSession]: (tabId: string) => this.sessions.forkSession(tabId),
        [CH.sessionTranscriptPath]: (tabId: string) => this.sessions.transcriptPath(tabId),
        [CH.convertToWorktree]: (
          tabId: string,
          branch: string,
          baseRef: string | null,
          baseBranch: string | null,
        ) => this.sessions.convertToWorktree(tabId, branch, baseRef, baseBranch),
        [CH.releaseWorktree]: (tabId: string, opts: WorktreeReleaseOptions) =>
          this.sessions.releaseWorktree(tabId, opts),
        [CH.syncWorktree]: (tabId: string, source: string) =>
          this.sessions.syncWorktree(tabId, source),
        [CH.renameWorktreeBranch]: (tabId: string, newName: string) =>
          this.sessions.renameWorktreeBranch(tabId, newName),
        [CH.setSessionAdvisor]: (
          tabId: string,
          advisor: boolean,
          advisorModel: string | null,
        ) => this.sessions.setSessionAdvisor(tabId, advisor, advisorModel),
        [CH.setSessionApprovalMode]: (tabId: string, mode: ApprovalMode | null) =>
          this.sessions.setSessionApprovalMode(tabId, mode),
        [CH.setSessionServiceTier]: (tabId: string, tier: ServiceTier | null) =>
          this.sessions.setSessionServiceTier(tabId, tier),
        [CH.getAdvisorDefaults]: (projectCwd: string): AdvisorDefaults =>
          this.advisorDefaults(projectCwd),
        [CH.readPlanFile]: (tabId: string, absPath: string) => this.readPlanFile(tabId, absPath),
        [CH.answerPlanReview]: (
          tabId: string,
          frameId: string,
          verdict: PlanReviewVerdict,
          sourceHash: string | null,
        ) => this.sessions.answerPlanReview(tabId, frameId, verdict, sourceHash),
        [CH.dismissProposedPlan]: (tabId: string, planFilePath: string) =>
          this.sessions.dismissProposedPlan(tabId, planFilePath),
        [CH.getProjectOpenAvailability]: () => this.projectOpener.availability(),
        [CH.openProject]: (projectPath: string, target: ProjectOpenTarget) =>
          this.projectOpener.open(projectPath, target),
        // Rejecting lets the renderer surface a failure instead of the click
        // dying silently.
        [CH.openPath]: (absPath: string) => openPath(absPath),
        [CH.showPathInFolder]: (absPath: string) => {
          shell.showItemInFolder(absPath);
        },
        [CH.getBranchDiff]: (projectCwd: string, base?: string | null) =>
          readBranchDiff(projectCwd, base ?? null),
        // Branch mutations answer through the branch:changed event (#498),
        // never a BackendState broadcast: no registry/BackendState field
        // changes here. The ws transport dispatches through this same table,
        // so a joined instance's call emits on its owner too.
        [CH.listBranches]: (projectCwd: string, opts?: BranchListOptions) =>
          listBranches(projectCwd, opts),
        [CH.checkoutBranch]: async (projectCwd: string, name: string, opts?: { create?: boolean }) => {
          await checkoutBranch(projectCwd, name, opts);
          this.send(CH.onBranchChanged, projectCwd, null);
        },
        [CH.pullBranch]: async (projectCwd: string) => {
          await pullBranch(projectCwd);
          this.send(CH.onBranchChanged, projectCwd, null);
        },
        // Push answers git state through a structured PushResult rather than a
        // rejection (issue #414); only a result that moved a ref emits.
        [CH.pushBranch]: async (projectCwd: string, branch: string, remote?: string | null) => {
          const result = await pushBranch(projectCwd, branch, remote);
          if (result.kind === "pushed" || result.kind === "published")
            this.send(CH.onBranchChanged, projectCwd, null);
          return result;
        },
        // Builds a URL only. Main never opens it: the renderer hands the result
        // to window.open, where setWindowOpenHandler's web-scheme guard decides.
        [CH.pullRequestUrl]: (projectCwd: string, base: string, head: string) =>
          pullRequestUrl(projectCwd, base, head),
        [CH.createBranch]: async (projectCwd: string, name: string, startPoint: string) => {
          await createBranch(projectCwd, name, startPoint);
          this.send(CH.onBranchChanged, projectCwd, null);
        },
        [CH.resolveMergeDestination]: (projectCwd: string, base: string | null) =>
          resolveMergeDestination(projectCwd, base),
        [CH.getMergeBackStatus]: (
          projectCwd: string,
          branch: string,
          destination: string,
          worktreePath: string | null,
        ) =>
          // The worktreePath is renderer-supplied; only a path inside the
          // app's worktrees root may steer `git status`. Anything else reads
          // as null — the status still resolves, worktreeDirty comes back
          // null (issue #388). Never let a renderer point git at a
          // user-chosen directory.
          readMergeBackStatus(
            projectCwd,
            branch,
            destination,
            worktreePath !== null && !isWithin(this.worktreesRoot, worktreePath)
              ? null
              : worktreePath,
          ),
        [CH.mergeWorktreeBranch]: async (projectCwd: string, branch: string, destination: string) => {
          const result = await mergeWorktreeBranch(projectCwd, branch, destination, {
            scratchRoot: path.join(this.worktreesRoot, ".merge"),
          });
          // A conflict stops mid-merge; already-merged moved nothing.
          if (result.kind === "merged") this.send(CH.onBranchChanged, projectCwd, null);
          return result;
        },
        // The memory overview handler is a stateless core call like
        // getBranchDiff: it touches no registry/BackendState field and never
        // calls broadcast().
        [CH.memoryOverview]: (projectCwd: string) => readMemoryOverview(projectCwd),
        // The stats overview is the same kind of stateless core read (ADR-0037):
        // omp owns the DB, omp-ui only reads it.
        [CH.statsOverview]: (rangeDays: number | null) => readStatsOverview(rangeDays),
        [CH.autoresearchOverview]: (projectCwd: string) =>
          readProjectExperiments(this.registry.sessions, projectCwd),
        [CH.autoresearchExperiment]: (projectCwd: string, tabId: string | null, experimentId: number) =>
          readExperimentDetail(this.registry.sessions, projectCwd, tabId, experimentId),
        [CH.autoresearchRunLog]: (
          projectCwd: string,
          tabId: string | null,
          experimentId: number,
          runId: number,
        ) => readRunLog(this.registry.sessions, projectCwd, tabId, experimentId, runId),
        [CH.suggestBranchName]: (projectCwd: string, planContext: string) =>
          this.suggestBranchName(projectCwd, planContext),
        [CH.readOmpSettings]: (projectCwd: string | null) =>
          readOmpSettings({ ompPath: this.ompPath, projectCwd }),
        [CH.writeOmpSetting]: (key: string, value: OmpSettingValue) =>
          writeOmpSetting({ ompPath: this.ompPath, key, value }),
        [CH.resetOmpSetting]: (key: string) => resetOmpSetting({ ompPath: this.ompPath, key }),
        [CH.checkPython]: () => checkPythonSetup({ ompPath: this.ompPath }),
        /**
         * Roster refresh (ADR-0031): bundled names via `omp agents unpack`
         * into a throwaway dir, plus the user agent dir and every registered
         * project's `.omp/agents`. The unpack dir is removed afterwards; the
         * user and project agent dirs are never written.
         */
        [CH.refreshAgentRoster]: async (): Promise<string[]> => {
          if (this.ompPath === null) throw new Error("omp binary not found");
          const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-agents-"));
          try {
            await execOmpConfigRunner(this.ompPath)(
              ["agents", "unpack", "--dir", tmp, "--json"],
              { cwd: tmp, env: process.env },
            );
            const names = new Set<string>(parseUnpackedAgentNames(tmp));
            // User agents plus every registered root and owned session working
            // tree: omp resolves project agents from the process cwd, which is
            // the dedicated checkout for a worktree session.
            for (const name of discoverAgentNames(null)) names.add(name);
            for (const project of this.registry.projects) {
              for (const name of discoverAgentNames(project.path)) names.add(name);
            }
            for (const session of this.registry.sessions) {
              for (const name of discoverAgentNames(session.worktree?.path ?? session.projectCwd)) {
                names.add(name);
              }
            }
            const roster = [...names].sort();
            this.registry.setSetting("agentRoster", roster);
            await this.broadcast();
            return roster;
          } finally {
            fs.rmSync(tmp, { recursive: true, force: true });
          }
        },
        // The provider list is omp-version-scoped, not app state: one catalog read
        // per Providers mount, no cache, no broadcast (ADR-0027, ADR-0035).
        [CH.readWebSearchProviders]: () => readWebSearchProviders({ ompPath: this.ompPath }),
        // The judge catalog belongs to the installed omp version and the
        // provider keys: one probe per browse, no cache (issue #669).
        [CH.readJudgeModels]: () => readJudgeModels({ ompPath: this.ompPath }),
        // The chat catalog for the resume-recovery picker (issue #774): the
        // tabId argument exists only to ride the tab router — the handler
        // runs on whichever host routing picked, and probes that host's omp.
        [CH.readModelCatalog]: () => readModelCatalog({ ompPath: this.ompPath }),
        // The chat catalog for the model-role browse picker (issue #797):
        // unrouted, since the settings page can be open with no live session.
        [CH.readChatModels]: () => readModelCatalog({ ompPath: this.ompPath }),
        // Each write answers with the refreshed snapshot in the same round trip,
        // so the page never has to guess what the store now holds.
        [CH.readProviderKeys]: (projectCwd: string | null) => this.providerSnapshot(projectCwd),
        [CH.setProviderKey]: (projectCwd: string | null, envName: string, value: string) => {
          this.providerKeys.setKey(envName, value);
          return this.providerSnapshot(projectCwd);
        },
        [CH.clearProviderKey]: (projectCwd: string | null, envName: string) => {
          this.providerKeys.clearKey(envName);
          return this.providerSnapshot(projectCwd);
        },
        // Provider sign-ins (issues #368, #721): the flow state is pushed to
        // every renderer; the page reads the dynamically resolved rows itself.
        [CH.readProviderOAuth]: () => this.providerOAuth.refresh(),
        [CH.getProviderOAuthState]: () => this.providerOAuth.state,
        [CH.startProviderOAuth]: (id: string) => {
          this.providerOAuth.start(id);
        },
        [CH.submitProviderOAuthInput]: (value: string) => {
          this.providerOAuth.submitInput(value);
        },
        [CH.cancelProviderOAuth]: () => {
          this.providerOAuth.cancel();
        },
        [CH.signOutProviderOAuth]: (id: string, credentialId: number) =>
          this.providerOAuth.signOut(id, credentialId),
        [CH.setWindowChrome]: (background: string, symbol: string) => {
          if (this.win.isDestroyed()) return;
          try {
            this.win.setTitleBarOverlay({ color: background, symbolColor: symbol, height: 36 });
          } catch {
            // No overlay on this platform — a theme change must not surface a platform error.
          }
        },
        [CH.getMcpServers]: (projectCwd: string | null) => resolveMcpServers(projectCwd),
        [CH.setMcpServerEnabled]: (req: McpSetEnabledRequest) => setMcpServerEnabled(req),
        // Capability catalogs (issue #383): stateless core reads like
        // getMcpServers — one ompSettings spawn chain, no session involved.
        [CH.getScopedCapabilities]: (scopeCwd: string | null) =>
          getScopedCapabilities(scopeCwd, this.ompPath),
        [CH.setScopedCapability]: (req: ScopedCapabilityMutation) =>
          setScopedCapability(req, this.ompPath),
        [CH.getWatchdogRoster]: (scopeCwd: string | null) => getWatchdogRoster(scopeCwd),
        [CH.setWatchdogRoster]: (req: WatchdogWriteRequest) => setWatchdogRoster(req),
        [CH.getReviewRoster]: (scopeCwd: string | null) => this.reviewRosterView(scopeCwd),
        [CH.setReviewRoster]: async (req: ReviewWriteRequest) => {
          if (req.scope === "user") this.registry.setSetting("reviewRoster", req.document);
          else {
            if (req.scopeCwd === null) throw new Error("project scope needs a project directory");
            // The mutator's false covers "unchanged" too, so the unknown-project
            // refusal is checked against the registry here.
            if (!this.registry.projects.some((project) => project.path === req.scopeCwd)) {
              throw new Error(`unknown project: ${req.scopeCwd}`);
            }
            this.registry.setProjectReviewRoster(req.scopeCwd, req.document);
          }
          await this.broadcast();
          return this.reviewRosterView(req.scopeCwd);
        },
        [CH.restartSession]: (tabId: string, carryoverContext?: string) =>
          this.sessions.restart(tabId, carryoverContext === "" ? undefined : carryoverContext),
        [CH.getSessionCapabilities]: (tabId: string) =>
          this.sessions.getSessionCapabilities(tabId),
        [CH.browserPaneEnsure]: (tabId: string) => this.sessions.browserPaneEnsure(tabId),
        [CH.browserPanePick]: (tabId: string, x: number, y: number) =>
          this.sessions.browserPanePick(tabId, x, y),
        [CH.browserPaneClearData]: (force: boolean) => this.sessions.browserPaneClearData(force),
        [CH.setSessionToolEnabled]: (
          tabId: string,
          processKey: string,
          sessionId: string | null,
          name: string,
          enabled: boolean,
        ) => this.sessions.setSessionToolEnabled(tabId, processKey, sessionId, name, enabled),
        [CH.listProjectFiles]: (projectCwd: string) => listProjectFiles(projectCwd),
        [CH.resolveFileMentions]: (projectCwd: string, message: string) =>
          resolveFileMentions(projectCwd, message),
        [CH.ptyPasteImage]: (tabId: string, image: ImageAttachment) =>
          this.sessions.ptyPasteImage(tabId, image),
        [CH.attachDocument]: (tabId: string, documents: DocumentAttachment[]) =>
          this.sessions.attachDocument(tabId, documents),
        [CH.ptyPasteDocument]: (tabId: string, document: DocumentAttachment) =>
          this.sessions.ptyPasteDocument(tabId, document),
        [CH.shellSpawn]: (
          tabId: string,
          cwd: string,
          cols: number,
          rows: number,
          program?: ConsoleProgram,
        ) => this.sessions.launchShell(tabId, cwd, cols, rows, program),
        [CH.getOmpUpdateState]: () => this.ompUpdater.state,
        [CH.checkOmpUpdate]: () => this.ompUpdater.checkNow(true),
        [CH.downloadOmpUpdate]: () => this.ompUpdater.download(),
        [CH.dismissOmpUpdate]: (version: string, remember: boolean) =>
          this.ompUpdater.dismiss(version, remember),
        [CH.getAppUpdateState]: () => this.appUpdater.state,
        [CH.checkAppUpdate]: () => this.appUpdater.checkNow(true),
        [CH.downloadAppUpdate]: () => this.appUpdater.download(),
        [CH.openAppUpdateReleaseNotes]: () => this.appUpdater.openReleaseNotes(),
        [CH.showAppUpdateDownload]: () => this.appUpdater.showDownload(),
        [CH.restartForAppUpdate]: (confirmed = false) => this.appUpdater.restart(confirmed),
        [CH.setAppUpdateInstallOnQuit]: (on: boolean) => this.appUpdater.setInstallOnQuit(on),
        [CH.dismissAppUpdate]: (version: string, remember: boolean) =>
          this.appUpdater.dismiss(version, remember),
        ...registerRemoteHandlers({
          registry: this.registry,
          getState: () => this.remote.state,
          apply: () => this.remote.apply(),
          restart: () => this.remote.restart(),
          breadcrumbs: this.breadcrumbs,
        }),
        // Remote instances (issue #416): identity for joiners; the manager owns the rest.
        [CH.getInstanceIdentity]: () => ({
          instanceId: this.registry.getSetting("instanceId"),
          version: this.appVersion,
        }),
        [CH.addRemoteInstance]: (input: RemoteInstanceInput) => this.remoteInstances.add(input),
        [CH.updateRemoteInstance]: (id: string, patch: RemoteInstancePatch) =>
          this.remoteInstances.update(id, patch),
        [CH.removeRemoteInstance]: async (id: string) => {
          await this.remoteInstances.remove(id);
          // A forgotten member's placement preference goes with it.
          const placement = this.registry.getSetting("fleetPlacement");
          if (Object.hasOwn(placement, id)) {
            const { [id]: _removed, ...rest } = placement;
            this.registry.setSetting("fleetPlacement", rest);
            await this.broadcast();
          }
        },
        [CH.reconnectRemoteInstance]: (id: string) => this.remoteInstances.reconnect(id),
        [CH.refreshRemoteInstanceState]: (id: string) => this.remoteInstances.refresh(id),
        [CH.remoteInstanceRequest]: (instanceId: string, channel: string, args: unknown[]) =>
          this.remoteInstances.request(instanceId, channel, args),
        // Fleet dispatch (issue #899, ADR-0061): only hostReport and
        // sessionSummary cross the proxy; the rest orchestrate in this main.
        [CH.fleetHostReport]: () => this.fleetHostReport(),
        [CH.fleetSessionSummary]: (tabId: string) => this.fleetSessionSummary(tabId),
        [CH.fleetMachines]: () => this.fleet.machines(),
        [CH.fleetDispatch]: (req: FleetDispatchRequest) => this.fleet.dispatch(req, { kind: "user" }),
        // Fleet exec ladder (issue #901, ADR-0062): these arrive through the
        // proxy as well; every rung decision lands inside FleetServer.
        [CH.fleetExec]: (req: FleetExecRequest) => this.fleetServer.exec(req),
        [CH.fleetProjectManage]: (req: FleetProjectManageRequest) => this.fleetServer.projectManage(req),
        [CH.fleetGrantRung]: (req: FleetRequester) => this.fleetServer.grantRung(req),
        [CH.fleetGrantRaise]: (req: FleetGrantRaiseRequest) => this.fleetServer.grantRaise(req),
        // Detached exec and Provider key rollout (issue #905): the first three
        // cross the proxy to the owner; the rollout orchestrates in this main.
        [CH.fleetExecDetach]: (req: FleetDetachedExecRequest) => this.fleetServer.execDetach(req),
        [CH.fleetExecPoll]: (req: FleetExecPollRequest) => this.fleetServer.execPoll(req),
        // Fleet send (issue #959): proxied to the owner, which authorizes and audits.
        [CH.fleetSend]: (req: FleetSendRequest) => this.fleetServer.send(req),
        [CH.fleetProviderKeys]: (req: FleetProviderKeysRequest) => this.fleetServer.providerKeys(req),
        [CH.fleetRolloutProviderKeys]: (machineKey: string, envNames: string[]) =>
          this.fleet.rolloutProviderKeys(machineKey, envNames),
        // Fleet remote version update: member/poll arrive through the proxy;
        // the local-machine request orchestrates in this main like dispatch.
        [CH.fleetUpdateMember]: (req: FleetUpdateMemberRequest) => this.fleetServer.updateMember(req),
        [CH.fleetUpdatePoll]: (req: FleetUpdatePollRequest) => this.fleetServer.updatePoll(req),
        [CH.fleetUpdateMachine]: (machineKey: string, req: FleetUpdateRequest) =>
          this.fleet.updateMachine(machineKey, req),
        [CH.fleetAudit]: () => this.fleetServer.auditEntries(),
        [CH.fleetGrantSet]: async (dispatcherId: string, rung: FleetRung | null) => {
          this.fleetServer.setGrant(dispatcherId, rung);
          await this.broadcast();
        },
        // The manager-side ceremony (issue #901): proxies the freshly typed
        // secret to the member's own fleet:grantRaise; never reads the stored one.
        [CH.fleetGrantRequest]: (machineKey: string, rung: FleetRung, secret: string) =>
          this.fleet.requestGrant(machineKey, rung, secret),
        [CH.fleetDismissPending]: async (dispatchId: string) => {
          this.fleet.dismissPending(dispatchId);
          await this.broadcast();
        },
        [CH.previewDiagnosticsBundle]: async () =>
          previewDiagnosticsBundle(
            await this.diagnosticsOptions({ includeTranscripts: false, destinationPath: null }),
          ),
        [CH.exportDiagnosticsBundle]: (req: DiagnosticsExportRequest) => this.exportDiagnostics(req),
        [CH.chooseDiagnosticsPath]: async (basename: string) => {
          const result = await dialog.showSaveDialog(this.win, {
            defaultPath: path.basename(basename || "omp-ui-diagnostics.zip"),
            filters: [{ name: "Zip archive", extensions: ["zip"] }],
          });
          return result.canceled || !result.filePath ? null : result.filePath;
        },
        /** Share anonymized (issue #834): the redaction is 100% omp's
         * `anonymize` command — main resolves the session file, gunzips an
         * archived transcript to a temp file (omp rejects .jsonl.gz with exit
         * 2), and writes the copy beside the raw transcripts. No single-flight
         * guard: the command finishes in seconds and reruns just overwrite the
         * output dir. */
        [CH.anonymizeSession]: async (tabId: string): Promise<AnonymizeSessionResult> => {
          const record = this.registry.sessions.find((s) => s.tabId === tabId);
          if (!record) return { ok: false, path: null, message: "session not found" };
          if (!this.ompPath) return { ok: false, path: null, message: "omp binary not resolved" };
          const loc = await resolveSessionLocation(
            this.sessionsRoot,
            this.archiveRoot,
            record.lineageDir,
            record.sessionId,
          );
          if (loc.where === "missing")
            return { ok: false, path: null, message: "session file not found" };
          const outDir = path.join(this.sessionsRoot, record.lineageDir, "anon");
          await fs.promises.mkdir(outDir, { recursive: true });
          let sessionFile = loc.filePath;
          let tmp: string | null = null;
          try {
            if (loc.where === "archived") {
              // omp rejects .jsonl.gz (verified: exit 2 "not a valid session
              // file"); gunzip to a temp file instead of unarchiving the
              // whole lineage.
              tmp = path.join(os.tmpdir(), `omp-ui-anon-${randomUUID()}.jsonl`);
              await pipeline(
                fs.createReadStream(loc.filePath),
                createGunzip(),
                fs.createWriteStream(tmp),
              );
              sessionFile = tmp;
            }
            return await anonymizeSession(this.ompPath, sessionFile, outDir);
          } finally {
            if (tmp !== null) await fs.promises.rm(tmp, { force: true });
          }
        },
        /** Session migration (#888): every pack/ingest leg stages through
         * TransferState (0600, shredded on abort/expiry); the CLI work is
         * entirely omp's `session pack` / `session unpack`. */
        [CH.packStart]: (tabId: string) => this.packStart(tabId),
        [CH.packChunk]: (packId: string, index: number) => this.transfers.readChunk(packId, index),
        [CH.packAbort]: (packId: string) => this.transfers.abortPack(packId),
        [CH.ingestStart]: () => this.transfers.startIngest(),
        [CH.ingestPush]: (transferId: string, chunkBase64: string) =>
          this.transfers.push(transferId, chunkBase64),
        [CH.ingestFinish]: (transferId: string, projectCwd: string) =>
          this.ingestFinish(transferId, projectCwd),
        [CH.markSessionMoved]: (tabId: string, toLabel: string) =>
          this.markSessionMoved(tabId, toLabel),
        [CH.authCarryToInstance]: (instanceId: string) => this.authCarryToInstance(instanceId),
        [CH.authCarryFromInstance]: (instanceId: string) => this.authCarryFromInstance(instanceId),
        [CH.authExportBundle]: () => this.authExportBundle(),
        [CH.authImportBundle]: (bundleBase64: string) => this.authImportBundle(bundleBase64),
        [CH.authSaveBundle]: () => this.authSaveBundle(),
        [CH.authPickBundleFile]: () => this.authPickBundleFile(),
        [CH.authImportFile]: (filePath: string) => this.authImportFile(filePath),
        /** Live Collab hosting is terminal-tab only (issue #686): the tracker
         * drives omp's own registry CLI and the PTY keystroke route. */
        [CH.collabList]: () => this.sessions.collabSnapshots(),
        [CH.collabShare]: (tabId: string, access: CollabAccess) =>
          this.sessions.collabShare(tabId, access),
        [CH.collabStop]: (tabId: string) => this.sessions.collabStop(tabId),
        [CH.collabLink]: (tabId: string, view: boolean) => this.sessions.collabLink(tabId, view),
      },
      notify: {
        [CH.ptyWrite]: (tabId: string, data: string) => this.sessions.ptyWrite(tabId, data),
        [CH.ptyResize]: (tabId: string, cols: number, rows: number) =>
          this.sessions.ptyResize(tabId, cols, rows),
        [CH.shellKill]: (tabId: string) => this.sessions.killShell(tabId),
        [CH.shellWrite]: (tabId: string, data: string) => this.sessions.shellWrite(tabId, data),
        [CH.shellResize]: (tabId: string, cols: number, rows: number) =>
          this.sessions.shellResize(tabId, cols, rows),
        [CH.browserPaneSubscribe]: (tabId: string, clientId: string, on: boolean) =>
          this.sessions.browserPaneSubscribe(tabId, clientId, on),
        [CH.browserPaneResize]: (tabId: string, width: number, height: number) =>
          this.sessions.browserPaneResize(tabId, width, height),
        [CH.browserPaneInput]: (tabId: string, event: BrowserPaneInputEvent) =>
          this.sessions.browserPaneInput(tabId, event),
        [CH.browserPaneNavigate]: (tabId: string, nav: BrowserPaneNavigate) =>
          this.sessions.browserPaneNavigate(tabId, nav),
        [CH.browserPaneSetOpen]: (tabId: string, open: boolean) =>
          this.sessions.browserPaneSetOpen(tabId, open),
        [CH.rpcSend]: (tabId: string, cmd: RpcFrame) => this.sessions.rpcSend(tabId, cmd),
        [CH.tabViewed]: (clientId: string, tabId: string | null) =>
          this.sessions.setViewedTab(clientId, tabId),
        [CH.reportStallCap]: (tabId: string, paused: boolean) =>
          this.notifier.stallCap(tabId, paused),
        [CH.remoteInstanceNotify]: (instanceId: string, channel: string, args: unknown[]) =>
          this.remoteInstances.notify(instanceId, channel, args),
      },
    } satisfies ChannelTable;
    // Tab-scoped channels reach the instance that owns the tab; a local tab stays local.
    return routeByTab(table, (id) => this.remoteInstances.ownerOf(id), this.remoteInstances);
  }

  registerIpc(): void {
    const table = this.handlers();
    // Decorate before binding: the IPC transport is the desktop; its viewed reports name the
    // tab the desktop window is showing, the only view state that may suppress or acknowledge
    // an OS notification (issue #271). Remote renderers reach the same handler through the
    // WebSocket transport and never mark the desktop.
    const viewed = table.notify[CH.tabViewed];
    const subscribe = table.notify[CH.browserPaneSubscribe];
    this.desktopPaneSubscribe = subscribe;
    const notify: ChannelTable["notify"] = {
      ...table.notify,
      [CH.browserPaneSubscribe]: (tabId: string, clientId: string, on: boolean) => {
        this.setDesktopPaneSubscription(tabId, clientId, on);
      },
      [CH.tabViewed]: (clientId: string, tabId: string | null) => {
        for (const [id, clients] of this.desktopPaneSubscriptions) {
          if (id !== tabId && clients.has(clientId)) this.setDesktopPaneSubscription(id, clientId, false);
        }
        this.desktopPaneStream.noteViewed(clientId, tabId);
        viewed(clientId, tabId);
        this.sessions.noteDesktopClientId(clientId);
        if (tabId !== null) this.notifier.viewedChanged(tabId);
      },
    };
    const desktopTable: ChannelTable = { request: table.request, notify };
    for (const channel of Object.keys(desktopTable.request)) {
      ipcMain.handle(channel, (_event, ...args: unknown[]) =>
        dispatchRequest(desktopTable, channel, args),
      );
    }
    for (const channel of Object.keys(desktopTable.notify)) {
      ipcMain.on(channel, (_event, ...args: unknown[]) =>
        dispatchNotify(desktopTable, channel, args),
      );
    }
    ipcMain.on(DESKTOP_PANE_PORT_REQUEST, (event) => {
      const wc = this.win.webContents;
      if (this.desktopPaneStopped || this.win.isDestroyed() || wc.isDestroyed() ||
        event.sender !== wc || event.senderFrame !== wc.mainFrame) return;
      this.disconnectDesktopPanePort();
      const { port1, port2 } = new MessageChannelMain();
      this.desktopPanePort = port1;
      let ready = false;
      port1.on("message", (message: { data: unknown }) => {
        if (this.desktopPanePort !== port1) return;
        const data = message.data;
        if (typeof data !== "object" || data === null || !("type" in data)) return;
        if (data.type === "ready" && !ready) {
          ready = true;
          for (const [tabId, clients] of this.desktopPaneSubscriptions) {
            for (const [clientId, path] of clients) {
              if (path === "media") this.sessions.browserPaneSetDesktopViewer(tabId, clientId, true);
            }
          }
          this.desktopPaneStream.ready((delivery) => {
            if (this.desktopPanePort !== port1) return;
            try {
              // Structured clone, not transfer: the pane and remote sinks still own these bytes.
              port1.postMessage(delivery);
            } catch {
              this.disconnectDesktopPanePort();
            }
          });
        } else if (data.type === "ack" && "id" in data && typeof data.id === "number") {
          this.desktopPaneStream.ack(data.id);
        } else if (data.type === "media-lease-request" && "requestId" in data &&
          typeof data.requestId === "number" && Number.isFinite(data.requestId) &&
          "tabId" in data && typeof data.tabId === "string") {
          let localViewer = false;
          if (this.remoteInstances.ownerOf(data.tabId) === null) {
            for (const path of this.desktopPaneSubscriptions.get(data.tabId)?.values() ?? []) {
              if (path === "media") { localViewer = true; break; }
            }
          }
          const lease = localViewer ? this.sessions.browserPaneMediaLease(data.tabId, wc.id) : null;
          try {
            port1.postMessage({ type: "media-lease", requestId: data.requestId, tabId: data.tabId, lease });
          } catch {
            this.disconnectDesktopPanePort();
          }
        }
      });
      port1.on("close", () => {
        if (this.desktopPanePort === port1) this.disconnectDesktopPanePort();
      });
      port1.start();
      try {
        wc.mainFrame.postMessage(DESKTOP_PANE_PORT, null, [port2]);
      } catch {
        port2.close();
        this.disconnectDesktopPanePort();
      }
    });
  }

  private setDesktopPaneSubscription(tabId: string, clientId: string, on: boolean): void {
    let clients = this.desktopPaneSubscriptions.get(tabId);
    const previous = clients?.get(clientId);
    const path = on ? (this.remoteInstances.ownerOf(tabId) === null ? "media" : "jpeg") : previous;
    if (previous !== undefined && (!on || previous !== path)) {
      clients!.delete(clientId);
      if (previous === "media") this.sessions.browserPaneSetDesktopViewer(tabId, clientId, false);
      else {
        this.desktopPaneStream.subscribe(tabId, clientId, false);
        this.desktopPaneSubscribe?.(tabId, clientId, false);
      }
      if (clients!.size === 0) this.desktopPaneSubscriptions.delete(tabId);
    }
    if (!on) return;
    if (clients === undefined || clients.size === 0) {
      clients = new Map();
      this.desktopPaneSubscriptions.set(tabId, clients);
    }
    clients.set(clientId, path!);
    if (path === "media") this.sessions.browserPaneSetDesktopViewer(tabId, clientId, true);
    else {
      // Cached frames can arrive synchronously from the routed handler.
      this.desktopPaneStream.subscribe(tabId, clientId, true);
      this.desktopPaneSubscribe?.(tabId, clientId, true);
    }
  }

  private forwardDesktopMedia(tabId: string, message: Exclude<DesktopMediaMessage, { type: "media-lease" }>): void {
    const clients = this.desktopPaneSubscriptions.get(tabId);
    if (clients === undefined) return;
    let viewed = false;
    for (const path of clients.values()) {
      if (path === "media") { viewed = true; break; }
    }
    if (!viewed) return;
    try {
      this.desktopPanePort?.postMessage(message);
    } catch {
      this.disconnectDesktopPanePort();
    }
  }

  private disconnectDesktopPanePort(): void {
    const port = this.desktopPanePort;
    this.desktopPanePort = null;
    this.desktopPaneStream.disconnect();
    port?.close();
  }

  private resetDesktopPaneStream(): void {
    this.disconnectDesktopPanePort();
    for (const [tabId, clients] of this.desktopPaneSubscriptions) {
      for (const clientId of clients.keys()) this.setDesktopPaneSubscription(tabId, clientId, false);
    }
    this.desktopPaneStream.reset();
  }

  /**
   * Launch-time background check — quiet unless an update is available. Gated
   * inside the method so no caller can bypass the user's launch preference;
   * the palette's manual check goes through checkNow(true) and stays live.
   */
  checkAppUpdateBackground(): void {
    if (!this.registry.getSetting("appUpdateCheckOnLaunch")) return;
    void this.appUpdater.checkNow(false);
  }

  /**
   * Launch-time background check — quiet unless an install/update offer
   * exists. Gated by the same launch preference as its app-update twin.
   */
  checkOmpUpdateBackground(): void {
    if (!this.registry.getSetting("ompUpdateCheckOnLaunch")) return;
    void this.ompUpdater.checkNow(false);
  }

  hydrateAll(): Promise<void> {
    this.headWatchers.startAll(this.registry.projects.map((p) => p.path));
    // Repository keys self-heal at startup (#903), fired like the watchers:
    // registries written before the field existed carry nulls.
    void this.trackProbe(this.backfillRepositoryKeys());
    return this.sessions.hydrateAll();
  }

  /**
   * Resolve `repositoryKey` for every project that still has null (issue #903,
   * ADR-0063) so pre-existing registries learn their fleet repo keys without a
   * re-add. One shared broadcast when any key lands; a failed probe skips just
   * that project and retries next launch — the backfill is never load-bearing.
   */
  private async backfillRepositoryKeys(): Promise<void> {
    let changed = false;
    for (const project of this.registry.projects) {
      if (project.repositoryKey !== null) continue;
      try {
        const key = await this.fleetCached(this.fleetRepositoryKeys, project.path, 60_000, () =>
          resolveRepositoryKey(project.path),
        );
        if (key === null) continue;
        this.registry.setProjectRepositoryKey(project.path, key);
        changed = true;
      } catch {
        // Skip this project; the key stays null.
      }
    }
    if (changed) void this.broadcast();
  }

  private providerSnapshot(projectCwd: string | null): ProviderKeysSnapshot {
    return {
      providers: this.providerKeys.statuses(projectCwd),
      encryptionAvailable: this.providerKeys.encryptionAvailable,
      backend: this.providerKeys.backend,
      configFileProviders: readModelsFileModelProviders(),
    };
  }

  /**
   * Recovers provider credentials the user exported from their shell rc, which a
   * .desktop/AppImage/dock launch never inherits — without this, omp starts with
   * no keys and its model catalog collapses to the providers needing none.
   *
   * Awaited at boot before the window can spawn a session; bounded to a few
   * seconds inside the capture, and a failure just leaves the environment as it
   * was, so a slow or hostile rc file cannot block startup.
   */
  captureShellKeys(): Promise<void> {
    return this.providerKeys.captureLoginShell();
  }

  /**
   * Primes the subscription account cache the fresh-spawn gate consults — the
   * gate reads the cache synchronously, so it is warmed at boot the same way
   * the shell keys are (issue #368).
   */
  refreshProviderOAuth(): Promise<void> {
    return this.providerOAuth.refresh().then(() => undefined);
  }

  /**
   * One-time memory-default seed (issue #570): writes the memory keys omp's own
   * defaults leave behind into omp's global layer, but only keys no config
   * layer already names. Fire-and-forget: a missing omp binary or a failed
   * write leaves the marker unset and retries next boot.
   */
  seedMemoryDefaultsOnce(): Promise<void> {
    if (this.registry.getSetting("memoryDefaultsSeeded")) return Promise.resolve();
    return seedMemoryDefaults(this.ompPath).then(
      (done) => {
        if (done) this.registry.setSetting("memoryDefaultsSeeded", true);
      },
      () => {},
    );
  }

  /**
   * The app-state roster view for one scope (issue #738): the pure resolver
   * over the two documents the registry holds — no files are read.
   */
  private reviewRosterView(scopeCwd: string | null) {
    const project =
      scopeCwd === null ? null : this.registry.projects.find((p) => p.path === scopeCwd) ?? null;
    return resolveReviewRoster(project === null ? null : project.path, {
      global: this.registry.getSetting("reviewRoster"),
      project: project === null ? null : project.reviewRoster,
    });
  }

  /**
   * One-time REVIEW.yml import (issue #738): copies the rosters the old
   * launch-time file merge read into registry state, filling only slots that
   * are still unset. Files on disk are never modified or deleted.
   * Fire-and-forget like the memory seed: a failed pass leaves the marker
   * unset and retries next boot.
   */
  importReviewRostersOnce(): Promise<void> {
    if (this.registry.getSetting("reviewRosterImported")) return Promise.resolve();
    return Promise.resolve()
      .then(() => importReviewRosters(this.registry))
      .then(
        (outcome) => {
          if (outcome.done) this.registry.setSetting("reviewRosterImported", true);
        },
        () => {},
      );
  }

  // ---------------------------------------------------------------------
  // Session migration + auth carry (issue #888)
  // ---------------------------------------------------------------------

  /** Stage a pack of the row's transcript. Refusals are contract values, not
   * throws: the renderer maps them onto the dialog's error line. */
  private async packStart(tabId: string): Promise<PackStartResult> {
    const refusal = (message: string): PackStartResult => ({
      ok: false,
      packId: null,
      sizeBytes: 0,
      missingBlobs: 0,
      message,
    });
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return refusal("session not found");
    if (!this.ompPath) return refusal("omp binary not resolved");
    if (record.sessionId === null) return refusal("no transcript to migrate yet");
    if (this.sessions.isLive(tabId)) {
      return refusal("stop the session before migrating it — omp refuses to pack a transcript another process writes");
    }
    let loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where === "missing") return refusal("session file not found");
    // The resume path lazily unarchives (spawn-config.ts); packing follows
    // the same rule — omp rejects a .jsonl.gz input.
    if (loc.where === "archived") {
      try {
        loc = { where: "active", filePath: await unarchiveSession(this.sessionsRoot, this.archiveRoot, record.lineageDir, record.sessionId) };
      } catch (err) {
        return refusal(err instanceof Error ? err.message : String(err));
      }
    }
    const staging = await this.transfers.startPack();
    try {
      const packed = await packSessionFile(this.ompPath, loc.filePath, staging.file);
      if (!packed.ok) {
        await this.transfers.abortPack(staging.packId);
        return refusal(packed.message);
      }
      const { size } = await fs.promises.stat(staging.file);
      this.transfers.notePackSize(staging.packId, size);
      return { ok: true, packId: staging.packId, sizeBytes: size, missingBlobs: packed.missingBlobs, message: null };
    } catch (err) {
      await this.transfers.abortPack(staging.packId);
      return refusal(err instanceof Error ? err.message : String(err));
    }
  }

  /** Close the staged bundle, unpack it with omp, relocate the placed
   * transcript into a minted ADR-0003 lineage dir, register the row (fork's
   * registration shape, session-manager.ts forkSession), and shred the temp
   * bundle. On any failure after unpack, the renamed transcript, artifacts,
   * and minted dir are removed — an orphan in the default session dir is a
   * bare `omp --resume` double-open hazard. */
  private async ingestFinish(transferId: string, projectCwd: string): Promise<IngestFinishResult> {
    const bundleFile = await this.transfers.finishIngest(transferId).catch((err: unknown) => {
      throw err instanceof Error ? err : new Error(String(err));
    });
    try {
      if (!this.ompPath) return { ok: false, tabId: null, message: "omp binary not resolved" };
      if (!fs.existsSync(projectCwd) || !fs.statSync(projectCwd).isDirectory()) {
        return { ok: false, tabId: null, message: `target directory ${projectCwd} does not exist` };
      }
      const unpacked = await unpackSessionArchive(this.ompPath, bundleFile, projectCwd);
      if (!unpacked.ok) return { ok: false, tabId: null, message: unpacked.message };
      let adopted: { lineageDir: string; sessionId: string };
      try {
        adopted = await adoptIntoLineage(this.sessionsRoot, unpacked.sessionFile, projectCwd);
      } catch (err) {
        return { ok: false, tabId: null, message: err instanceof Error ? err.message : String(err) };
      }
      const dir = path.join(this.sessionsRoot, adopted.lineageDir);
      try {
        // Hydrate for the display-bearing fields; an unreadable transcript
        // still registers (the watcher hub self-heals title/id later).
        let cachedTitle: string | null = null;
        try {
          const h = await hydrateSessionFile(path.join(dir, path.basename(unpacked.sessionFile)));
          cachedTitle = h.title?.trim() ? h.title : null;
        } catch {
          cachedTitle = null;
        }
        const project = this.registry.projects.find((p) => p.path === projectCwd);
        const now = new Date().toISOString();
        const added = this.registry.addSession({
          tabId: randomUUID(),
          sessionId: adopted.sessionId,
          lineageDir: adopted.lineageDir,
          projectCwd,
          // Worktrees are host-local (ADR-0018); a dead checkout path makes
          // prepareResumeRecord throw ("worktree checkout is gone").
          worktree: null,
          planImplementationSource: null,
          experiment: null,
          // A migrated session is not a dispatch, wherever it was dispatched from.
          fleet: null,
          launchedAt: now,
          mode: this.registry.getSetting("defaultMode"),
          agentMode: "build",
          compactionMethod: this.registry.getSetting("defaultCompactionMethod"),
          approvalMode: null,
          serviceTier: null,
          model: project?.defaultModel ?? project?.lastModel ?? null,
          thinkingLevel: this.registry.getSetting("defaultAutoThinking") ? "auto" : null,
          advisor: false,
          advisorModel: null,
          subagentModels: null,
          // The target's lineage dir carries the packed artifacts but no plan
          // review record; nothing can be re-presented from the source host.
          proposedPlans: [],
          cachedTitle,
          cachedModified: now,
          autoTitled: false,
          snoozed: false,
          private: false,
          // A migrated session always lands in a project.
          chat: false,
          askSource: null,
        });
        await this.broadcast();
        return { ok: true, tabId: added.tabId };
      } catch (err) {
        // Registration failed after the rename: sweep the minted dir so no
        // orphan transcript waits in the sessions root.
        await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
        return { ok: false, tabId: null, message: err instanceof Error ? err.message : String(err) };
      }
    } finally {
      await shredFile(bundleFile).catch(() => undefined);
      await fs.promises.rm(path.dirname(bundleFile), { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** `omp session moved <file> --to <label>` on the source row. Archived
   * rows are refused: pack-start already unarchived what was migrated. */
  private async markSessionMoved(tabId: string, label: string): Promise<AuthCarryResult> {
    if (!this.ompPath) return { ok: false, message: "omp binary not resolved" };
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record || record.sessionId === null) return { ok: false, message: "session not found" };
    const loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where !== "active") return { ok: false, message: "no active transcript to mark" };
    const moved = await markSessionMoved(this.ompPath, loc.filePath, label);
    return moved.ok ? { ok: true, message: null } : { ok: false, message: moved.message };
  }

  /** Export this host's credential bundle into a 0600 temp, return it as
   * base64, shred. The bytes are the sole return value and never enter a log
   * line (main's logger never sees handler returns). */
  private async authExportBundle(): Promise<string> {
    if (!this.ompPath) throw new Error("omp binary not resolved");
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-ui-auth-"));
    await fs.promises.chmod(dir, 0o700);
    const file = path.join(dir, "bundle.json");
    try {
      await fs.promises.writeFile(file, "", { mode: 0o600 });
      const exported = await authExport(this.ompPath, file);
      if (!exported.ok) throw new Error(exported.message);
      return (await fs.promises.readFile(file)).toString("base64");
    } finally {
      await shredFile(file).catch(() => undefined);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Write the base64 bundle to a 0600 temp, merge-import it, shred. */
  private async authImportBundle(bundleBase64: string): Promise<AuthCarryResult> {
    if (!this.ompPath) return { ok: false, message: "omp binary not resolved" };
    const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-ui-auth-"));
    await fs.promises.chmod(dir, 0o700);
    const file = path.join(dir, "bundle.json");
    try {
      await fs.promises.writeFile(file, Buffer.from(bundleBase64, "base64"), { mode: 0o600 });
      const imported = await authImport(this.ompPath, file);
      return imported.ok ? { ok: true, message: null } : { ok: false, message: imported.message };
    } finally {
      await shredFile(file).catch(() => undefined);
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  /** Orchestration lives here, in the acting app's main: the bundle travels
   * main↔main over RemoteInstanceManager, never through a renderer. */
  private async authCarryToInstance(instanceId: string): Promise<AuthCarryResult> {
    try {
      const bundleBase64 = await this.authExportBundle();
      await this.remoteInstances.request(instanceId, "auth:import-bundle", [bundleBase64]);
      return { ok: true, message: null };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async authCarryFromInstance(instanceId: string): Promise<AuthCarryResult> {
    try {
      const bundleBase64 = (await this.remoteInstances.request(instanceId, "auth:export-bundle", [])) as string;
      return await this.authImportBundle(bundleBase64);
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Save dialog → export → copy at 0600 to the chosen path → shred temp.
   * Cancel is a no-op reported as "cancelled". */
  private async authSaveBundle(): Promise<AuthCarryResult> {
    const result = await dialog.showSaveDialog(this.win, {
      defaultPath: "omp-credentials.json",
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    if (result.canceled || !result.filePath) return { ok: true, message: "cancelled" };
    try {
      const bundleBase64 = await this.authExportBundle();
      await fs.promises.writeFile(result.filePath, Buffer.from(bundleBase64, "base64"), { mode: 0o600 });
      return { ok: true, message: null };
    } catch (err) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Open dialog for an import source; null = cancelled. */
  private async authPickBundleFile(): Promise<string | null> {
    const result = await dialog.showOpenDialog(this.win, {
      properties: ["openFile"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]!;
  }

  /** Import a user-picked file directly — their file stays as they left it
   * (no temp, no shred). */
  private async authImportFile(filePath: string): Promise<AuthCarryResult> {
    if (!this.ompPath) return { ok: false, message: "omp binary not resolved" };
    const imported = await authImport(this.ompPath, filePath);
    return imported.ok ? { ok: true, message: null } : { ok: false, message: imported.message };
  }

  /** Brings the embedded remote server in line with persisted settings. Called once at launch. */
  startRemote(): Promise<void> {
    return this.remote.apply();
  }

  /** Dials every joined remote instance. Called once at launch, after startRemote(). */
  startRemoteInstances(): void {
    this.remoteInstances.start();
  }

  /**
   * Releases every launch-time resource. The returned promise settles once every project git probe
   * still in flight has finished — the gitdir probes (#503) and the repository-key/HEAD probes with
   * the registry writes that follow them (#909). A spawned `git` holds its cwd locked until it
   * exits, so a teardown that removes that directory cannot return before the child does. Quit
   * ignores the promise — the process is going away either way.
   */
  killAll(): Promise<void> {
    this.desktopPaneStopped = true;
    this.resetDesktopPaneStream();
    this.notifier.dispose();
    this.providerOAuth.dispose();
    this.planVerifier.dispose();
    this.clockStamper.dispose();
    this.transfers.dispose();
    this.sessions.killAll();
    const headsSettled = this.headWatchers.disposeAll();
    this.fleetServer.dispose();
    this.remoteInstances.stop();
    void this.remote.stop();
    return Promise.allSettled([headsSettled, ...this.projectProbes]).then(() => undefined);
  }

  /**
   * Reads a plan artifact for the review pane. The path arrives from the
   * renderer, which got it from the agent's own plan slug, so it is confined
   * to the session's own lineage dir before any read — a crafted `local://`
   * name must not turn this channel into an arbitrary file reader. While an
   * HTML gate is pending the VALIDATED snapshot answers instead of freshly
   * changed bytes (§5.4), and validation and presentation share one reader
   * (§5.2), so the two can never disagree about what was reviewed.
   */
  private async readPlanFile(tabId: string, absPath: string): Promise<string | null> {
    const snapshot = this.sessions.planSnapshotFor(tabId, absPath);
    if (snapshot !== null) return snapshot.text;
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return null;
    const root = path.resolve(this.sessionsRoot, record.lineageDir);
    const read = await readConfinedPlanFile(root, absPath);
    if (!read.ok) {
      if (read.reason === "outside") {
        console.warn("[plan] refusing to read outside the lineage dir:", absPath);
      }
      // The agent may not have written the file yet — absent is not an error
      // for a plain read; the gate path maps it to PLAN_READ_FAILED instead.
      return null;
    }
    return read.text;
  }



  /** omp's own advisor defaults, so the composer can show what it inherits. */
  private advisorDefaults(projectCwd: string): AdvisorDefaults {
    const defaults = readOmpAdvisorDefaults(projectCwd);
    return {
      enabled: defaults.enabled,
      model: defaults.role === null ? null : formatModelRole(defaults.role),
    };
  }

  /** Registers an in-flight project probe for killAll to outwait; returns it unchanged. */
  private trackProbe<T>(probe: Promise<T>): Promise<T> {
    this.projectProbes.add(probe);
    const drop = (): void => {
      this.projectProbes.delete(probe);
    };
    probe.then(drop, drop);
    return probe;
  }

  /** One time-boxed shared promise per key: concurrent reports share one probe. */
  private fleetCached<T>(
    cache: Map<string, { at: number; value: Promise<T> }>,
    key: string,
    ttlMs: number,
    load: () => Promise<T>,
  ): Promise<T> {
    const now = Date.now();
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at < ttlMs) return hit.value;
    const value = this.trackProbe(load());
    cache.set(key, { at: now, value });
    return value;
  }

  /**
   * This host as a fleet member (issue #899): resources, load, and every
   * registered project (never chats) with the repository key placement
   * matches on and the spawn defaults the owner would apply itself.
   */
  private async fleetHostReport(): Promise<FleetHostReport> {
    const now = Date.now();
    if (this.fleetResources === null || now - this.fleetResources.at >= 5_000) {
      const value = sampleHostResources();
      const entry = { at: now, value };
      this.fleetResources = entry;
      // A failed sample is not cached: the next report samples again.
      value.catch(() => {
        if (this.fleetResources === entry) this.fleetResources = null;
      });
    }
    this.fleetOs ??= detectHostOs();
    if (this.fleetPackageManagers === null || now - this.fleetPackageManagers.at >= 60_000) {
      const value = detectPackageManagers();
      const entry = { at: now, value };
      this.fleetPackageManagers = entry;
      // Same as the resource sample: a failed probe is retried next report.
      value.catch(() => {
        if (this.fleetPackageManagers === entry) this.fleetPackageManagers = null;
      });
    }
    if (this.fleetOmpVersion === null || now - this.fleetOmpVersion.at >= 60_000) {
      // No binary means nothing to spawn; never let the version probe reject
      // the whole report.
      const value =
        this.ompPath === null ? Promise.resolve<string | null>(null) : readInstalledOmpVersion(this.ompPath);
      const entry = { at: now, value };
      this.fleetOmpVersion = entry;
      // Same as the package-manager probe: a failed read is retried next report.
      value.catch(() => {
        if (this.fleetOmpVersion === entry) this.fleetOmpVersion = null;
      });
    }
    const records = this.registry.sessions;
    const [resources, hostOs, packageManagers, ompVersion, projects] = await Promise.all([
      this.fleetResources.value,
      this.fleetOs,
      this.fleetPackageManagers.value,
      // A failed probe answers null here; the entry above already scheduled its retry.
      this.fleetOmpVersion.value.catch(() => null),
      Promise.all(
        this.registry.projects.map(async (project) => {
          const [repositoryKey, headCommit] = await Promise.all([
            this.fleetCached(this.fleetRepositoryKeys, project.path, 60_000, () =>
              resolveRepositoryKey(project.path),
            ),
            this.fleetCached(this.fleetHeadCommits, project.path, 15_000, () =>
              git(project.path, ["rev-parse", "HEAD"], { timeoutMs: 5_000 }).then(
                (out) => out.trim() || null,
                () => null,
              ),
            ),
          ]);
          // The renderer's spawn chain (lifecycle.ts resolveSpawnParams):
          // the boolean defaultAdvisor setting always answers, so omp's own
          // default only seeds the model.
          const pinnedModel = project.defaultAdvisorModel ?? project.lastAdvisorModel;
          return {
            path: project.path,
            name: project.name,
            repositoryKey,
            headCommit,
            providerReady: this.sessions.modelProviderReady(project.path),
            advisor: project.lastAdvisor ?? this.registry.getSetting("defaultAdvisor"),
            advisorModel: pinnedModel ?? this.advisorDefaults(project.path).model,
          };
        }),
      ),
    ]);
    return {
      instanceId: this.registry.getSetting("instanceId"),
      label: this.fleetLabel,
      version: this.appVersion,
      platform: process.platform,
      arch: process.arch,
      ...resources,
      liveSessions: records.filter((s) => this.sessions.isLive(s.tabId)).length,
      runningTurns: records.filter((s) => this.sessions.isTurnRunning(s.tabId)).length,
      sampledAt: now,
      projects,
      user: this.fleetUser,
      projectRoots: this.registry.getSetting("fleetProjectRoots"),
      os: hostOs,
      packageManagers,
      // Fleet remote version update (issue #905): the two binaries' facts —
      // the managed omp and this app's own staged/available update.
      ompVersion,
      ompPath: this.ompPath,
      ompPinned: ompPinActive(),
      ompBelowMinimum: ompVersion !== null && compareVersions(ompVersion, MIN_SUPPORTED_OMP) < 0,
      packageFormat: detectPackageFormat(),
      appLatestVersion: this.appUpdater.state.latestVersion,
      appUpdateStaged: this.appUpdater.state.status === "downloaded",
      modelFavorites: this.registry.getFavorites(),
    };
  }

  /**
   * The one registration path (issue #904): the user's project:add and the
   * fleet's rung-3 clone/register both land here, so every registered project
   * gets its head watcher and repository key the same way.
   */
  private async addProjectPath(resolved: string): Promise<ProjectRecord> {
    if (isInChatsRoot(this.chatsRoot, resolved)) {
      throw new Error("omp-ui's chats folder can't be registered as a project");
    }
    const record = this.registry.addProject(resolved);
    void this.headWatchers.start(resolved);
    // Repository key (issue #903, ADR-0063): resolved off the add path —
    // a git probe must never fail or delay the add itself. One extra
    // broadcast when a key actually lands; a non-git folder resolves
    // null and stays silent, and a failed probe leaves the key null for
    // the startup backfill to retry.
    void this.trackProbe((async () => {
      try {
        const key = await this.fleetCached(this.fleetRepositoryKeys, resolved, 60_000, () =>
          resolveRepositoryKey(resolved),
        );
        if (key === null || key === record.repositoryKey) return;
        this.registry.setProjectRepositoryKey(resolved, key);
        void this.broadcast();
      } catch {
        // Swallowed by design: the add already succeeded.
      }
    })());
    await this.broadcast();
    return record;
  }

  /** The owner-rendered summary the fleet status tool reads (issue #899). */
  private fleetSessionSummary(tabId: string): Promise<string> {
    const record = this.registry.sessions.find((s) => s.tabId === tabId);
    if (record === undefined) return Promise.reject(new Error("session not found"));
    return renderSessionSummary(record, this.registry.projects, (dir, sid) =>
      resolveSessionLocation(this.sessionsRoot, this.archiveRoot, dir, sid),
    );
  }

  /** A dispatched session's summary for its Fleet result: local or proxied, raced against 5 s (issue #957). */
  private async fleetChildSummary(machineKey: string, tabId: string): Promise<string> {
    const read =
      machineKey === LOCAL_MACHINE_KEY
        ? this.fleetSessionSummary(tabId)
        : this.remoteInstances.request(machineKey, CH.fleetSessionSummary, [tabId]);
    const timeout = Promise.withResolvers<null>();
    const timer: NodeJS.Timeout = setTimeout(() => timeout.resolve(null), FLEET_CHILD_SUMMARY_TIMEOUT_MS);
    try {
      const text: unknown = await Promise.race([read, timeout.promise]);
      return typeof text === "string" ? text.trim() : "Summary unavailable.";
    } catch {
      return "Summary unavailable.";
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Suggests a branch name for a plan with omp's own small model. Null on
   * every failure path — the renderer pre-fills its slug-derived name, so
   * this must never throw across IPC.
   */
  private async suggestBranchName(
    projectCwd: string,
    planContext: string,
  ): Promise<string | null> {
    if (!this.ompPath) return null;
    const role = readOmpModelRole(projectCwd, TITLE_MODEL_ROLES);
    try {
      return await generateBranchNameWithOmp({
        ompPath: this.ompPath,
        projectCwd,
        model: role === null ? null : formatModelRole(role),
        prompt: planContext,
      });
    } catch (err) {
      console.warn("[branch-name] model naming failed:", err);
      return null;
    }
  }

  private async buildState(): Promise<BackendState> {
    // Group records by project in one pass; the old per-project filter was
    // O(projects × sessions).
    const byProject = new Map<string, OwnedSessionRecord[]>();
    const chatRecords: OwnedSessionRecord[] = [];
    for (const record of this.registry.sessions) {
      if (record.chat) {
        chatRecords.push(record);
        continue;
      }
      const group = byProject.get(record.projectCwd);
      if (group) group.push(record);
      else byProject.set(record.projectCwd, [record]);
    }
    const groups: ProjectGroup[] = [];
    for (const project of this.registry.projects) {
      // Summarizes are independent — each reads its own lineage dir, and the registry
      // writes inside are synchronous — so they run concurrently; one slow disk no
      // longer stalls the rest. Order within a group follows the registry array.
      const sessions = await Promise.all(
        (byProject.get(project.path) ?? []).map((record) => this.summarize(record)),
      );
      groups.push({ project, sessions });
    }
    // Chats never join a project group (ADR-0059); registry order is newest first.
    const chats = await Promise.all(chatRecords.map((record) => this.summarize(record)));
    // Registry order is preserved as-is; the renderer sorts the sidebar by recency.
    return {
      projects: groups,
      chats,
      defaultMode: this.registry.getSetting("defaultMode"),
      planFormat: this.registry.getSetting("planFormat"),
      hibernateIdleMinutes: this.registry.getSetting("hibernateIdleMinutes"),
      streamStallAbortSeconds: this.registry.getSetting("streamStallAbortSeconds"),
      defaultAgentMode: this.registry.getSetting("defaultAgentMode"),
      defaultCompactionMethod: this.registry.getSetting("defaultCompactionMethod"),
      advisorAutoReply: this.registry.getSetting("advisorAutoReply"),
      stallAutoContinue: this.registry.getSetting("stallAutoContinue"),
      desktopNotifications: this.registry.getSetting("desktopNotifications"),
      defaultAdvisor: this.registry.getSetting("defaultAdvisor"),
      defaultAutoThinking: this.registry.getSetting("defaultAutoThinking"),
      subagentModelInheritByDefault: this.registry.getSetting("subagentModelInheritByDefault"),
      agentRoster: this.registry.getSetting("agentRoster"),
      modelFavorites: this.registry.getFavorites(),
      skipDeleteConfirmation: this.registry.getSetting("skipDeleteConfirmation"),
      skipTerminateConfirmation: this.registry.getSetting("skipTerminateConfirmation"),
      gettingStartedSeen: this.registry.getSetting("gettingStartedSeen"),
      themeId: this.registry.getSetting("themeId"),
      fontFamilyId: this.registry.getSetting("fontFamilyId"),
      transcriptWidth: this.registry.getSetting("transcriptWidth"),
      experimentsEnabled: this.registry.getSetting("experimentsEnabled"),
      snoozedSectionEnabled: this.registry.getSetting("snoozedSectionEnabled"),
      voiceInputEnabled: this.registry.getSetting("voiceInputEnabled"),
      sttModel: this.registry.getSetting("sttModel"),
      audioInputDevice: this.registry.getSetting("audioInputDevice"),
      audioOutputDevice: this.registry.getSetting("audioOutputDevice"),
      glassChrome: this.registry.getSetting("glassChrome"),
      localeId: this.registry.getSetting("localeId"),
      appUpdateCheckOnLaunch: this.registry.getSetting("appUpdateCheckOnLaunch"),
      appUpdateTrain: this.registry.getSetting("appUpdateTrain"),
      vaultRegistry: this.registry.getSetting("vaultRegistry"),
      vaultNoteVoice: this.registry.getSetting("vaultNoteVoice"),
      ompUpdateCheckOnLaunch: this.registry.getSetting("ompUpdateCheckOnLaunch"),
      ompAutoUpgrade: this.registry.getSetting("ompAutoUpgrade"),
      dismissedAppUpdateVersion: this.registry.getSetting("dismissedAppUpdateVersion"),
      dismissedOmpUpdateVersion: this.registry.getSetting("dismissedOmpUpdateVersion"),
      // Instance metadata, not registry state: identical on every read and
      // broadcast, for the desktop window and remote clients alike.
      spawnGate: this.spawnGateState,
      remoteInstances: this.remoteInstances.summaries(),
      fleetPlacement: this.registry.getSetting("fleetPlacement"),
      fleetAgentDispatch: this.registry.getSetting("fleetAgentDispatch"),
      fleetExecEnabled: this.registry.getSetting("fleetExecEnabled"),
      fleetExecCeiling: this.registry.getSetting("fleetExecCeiling"),
      fleetGrants: this.registry.getSetting("fleetGrants"),
      fleetProjectRoots: this.registry.getSetting("fleetProjectRoots"),
      fleetPending: this.fleet.pending(),
    };
  }

  private async summarize(record: OwnedSessionRecord): Promise<SessionSummary> {
    const loc = await resolveSessionLocation(
      this.sessionsRoot,
      this.archiveRoot,
      record.lineageDir,
      record.sessionId,
    );
    const live: LiveState = this.sessions.isLive(record.tabId)
      ? "live"
      : loc.where === "active"
        ? "dormant"
        : loc.where === "archived"
          ? "archived"
          : "missing";
    const streamStalled = this.sessions.isStreamStalled(record.tabId);
    const turnRunning = this.sessions.isTurnRunning(record.tabId);
    const awaitingHumanAnswer = this.sessions.pendingAnswer(record.tabId);
    let title = record.cachedTitle;
    let status: SessionSummary["status"] = null;
    if (loc.where === "active") {
      try {
        const h = await hydrateSessionFile(loc.filePath);
        if (h.title?.trim()) title = h.title;
        status = h.status;
        const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
        if (h.id && h.id !== record.sessionId) patch.sessionId = h.id;
        const headTitle = h.title?.trim() ? h.title : null;
        if (headTitle !== record.cachedTitle) patch.cachedTitle = headTitle;
        const modified = h.mtime.toISOString();
        if (modified !== record.cachedModified) patch.cachedModified = modified;
        if (Object.keys(patch).length > 0) {
          record = this.registry.updateSession(record.tabId, patch) ?? record;
        }
      } catch {
        // Vanished mid-hydrate — render from cached fields.
      }
    }
    const gate = this.sessions.planGate(record.tabId);
    // Ephemeral like the plan gate: omp's runtime in the live child owns goal
    // state, so a session with no live process reports none instead of a
    // remembered one (issue #381, ADR-0046).
    const goal = this.sessions.goalState(record.tabId);
    // Ephemeral like the goal state: the bridge inside the live child owns
    // vibe state, so a session with no live process reports none (#683).
    const vibe = this.sessions.vibeSnapshot(record.tabId);
    const autoresearch = this.sessions.autoresearchSnapshot(record.tabId);
    const bridgeAvailability = this.sessions.bridgeAvailability(record.tabId);
    return {
      ...record,
      title: title?.trim() || "New session",
      status,
      live,
      pendingPlan: gate?.pending ?? null,
      planSettle: gate?.settle ?? null,
      ...(bridgeAvailability === undefined ? {} : { bridgeAvailability }),
      streamStalled,
      turnRunning,
      awaitingHumanAnswer,
      // Ephemeral like the plan gate (#555): the live child blocks; a session
      // with no process reports none.
      pendingDialogs: this.sessions.pendingDialogs(record.tabId),
      ...(goal === undefined ? {} : { goal }),
      ...(autoresearch === undefined ? {} : { autoresearch }),
      ...(vibe === undefined ? {} : { vibe }),
      modelHold: this.sessions.modelHold(record.tabId),
    };
  }

  /** Fans state to every sink; the window sink self-guards, so remote clients survive a closed window. */
  private broadcast(): Promise<void> {
    const task = this.broadcastChain.then(async () => {
      const state = await this.buildState();
      this.send(CH.onStateChanged, state);
      this.fleetWake.observe(state);
      this.#releaseBroadcastWaiters();
    });
    // Keep the queue usable after a failed build without changing the Promise
    // returned to this caller: `task` still carries its own rejection.
    this.broadcastChain = task.catch(() => {});
    return task;
  }

  /** Wakes every long-poll fleet status waiter after a completed broadcast (issue #958). */
  #releaseBroadcastWaiters(): void {
    for (const w of [...this.#broadcastWaiters]) w();
  }
}
