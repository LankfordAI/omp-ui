import { randomUUID } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import {
  CH,
  browseDirectories,
  checkoutBranch,
  createBranch,
  formatModelRole,
  generateBranchNameWithOmp,
  generateTitleWithOmp,
  getArchiveRoot,
  getScopedCapabilities,
  getOmpAgentDir,
  getSessionsRoot,
  hydrateSessionFile,
  readOmpAdvisorDefaults,
  readOmpModelRole,
  readOmpSettings,
  readOmpCompactionMethods,
  readWebSearchProviders,
  readBranchDiff,
  readInstalledOmpVersion,
  listBranches,
  mergeWorktreeBranch,
  readMemoryOverview,
  readMergeBackStatus,
  resolveMergeDestination,
  pullBranch,
  pushBranch,
  pullRequestUrl,
  reclaimCheckouts,
  isWithin,
  sweepOrphanWorktrees,
  listProjectFiles,
  resolveFileMentions,
  retitleSessionWithOmp,
  resolveMcpServers,
  resolveProjectPath,
  setMcpServerEnabled,
  setScopedCapability,
  ProviderOAuth,
  ProviderKeys,
  Registry,
  RemoteInstanceStore,
  resolveOmpBinary,
  resolveSessionLocation,
  writeOmpSetting,
  collectDiagnosticsBundle,
  previewDiagnosticsBundle,
  type AgentMode,
  TITLE_MODEL_ROLES,
  type AdvisorDefaults,
  type AppUpdateRestartResult,
  type AppUpdateState,
  type BackendState,
  type ClientRole,
  type ChannelTable,
  type BranchListOptions,
  type ConsoleProgram,
  type GlassChrome,
  type ImageAttachment,
  type McpSetEnabledRequest,
  type ScopedCapabilityMutation,
  type LiveState,
  type OmpSettingValue,
  type OwnedSessionRecord,
  type ProviderKeysSnapshot,
  type DesktopClientFacts,
  type HostDiagnosticsFacts,
  type DiagnosticsExportRequest,
  type DiagnosticsExportResult,
  type DiagnosticsOptions,
  type KeyCipher,
  type RegistrySettings,
  type RemoteBind,
  type RemoteInstanceInput,
  type RemoteInstancePatch,
  type RpcFrame,
  type SessionMode,
  type SpawnGateState,
  type SpawnRequest,
  type TranscriptWidth,
  type WorktreeReleaseOptions,
  type SessionSummary,
  type PlanReviewVerdict,
  type PlanFormat,
  type ProjectGroup,
  type ProjectOpenAvailability,
  type ProjectOpenTarget,
  controlOnlyChannels,
  idleHostUpdateState,
  type BreadcrumbSink,
  type HostPairing,
  type HostStatus,
  type HostUpdateState,
} from "@omp-ui/core";
import {
  hashRemotePassword,
  HOST_PROTOCOL,
  HOST_PROTOCOL_RANGE,
  mintRemoteToken,
  validateRemotePassword,
  type ConnectionContext,
  type EventScope,
  type HostSurface,
  type ScopedSink,
} from "@omp-ui/server";
import { OmpUpdater } from "./update/omp-update";
import { RemoteServerManager } from "./remote/remote-server";
import { RemoteInstanceManager } from "./remote/remote-instance-manager";
import { routeByTab } from "./remote/remote-route";
import { SessionManager } from "./session/session-manager";
import { ChromeVerifierPage } from "./verifier/chrome-verifier-page";
import { PlanVerifier, type VerifierHealth } from "./verifier/plan-verifier";
import { resolveVerifierPayload } from "./verifier/payload";
import { startVerifierOrigin, type VerifierOrigin } from "./verifier/static-origin";
import { readConfinedPlanFile } from "./verifier/plan-file";
import { AttentionTracker } from "./session/trackers/attention-tracker";
import { NO_GATE, type SpawnGate } from "./session/spawn-gate";
import type { AuthorityToken } from "./authority/authority";
import type { ChildrenLedger } from "./authority/children-ledger";

export type { DesktopClientFacts };

/** The desktop window's own connection id: its sink takes connection-scoped events under it. */
export const IPC_CONNECTION_ID = "ipc";

/** Channels only a control-plane connection may reach (issue #442): declared with `gate: "control"`. */
const CONTROL_ONLY_CHANNELS = controlOnlyChannels();

/** `table` without `keys` when `condition` is false; `table` itself when it holds. */
export function omitUnless(
  condition: boolean,
  table: ChannelTable,
  keys: readonly string[],
): ChannelTable {
  if (condition || keys.length === 0) return table;
  const request: Record<string, unknown> = { ...table.request };
  const notify: Record<string, unknown> = { ...table.notify };
  for (const key of keys) {
    delete request[key];
    delete notify[key];
  }
  return { request, notify } as unknown as ChannelTable;
}

/** Where the host keeps its stores; every path is absolute and decided by the constructor's caller. */
export interface HostPaths {
  /** The data root the authority token names; the default diagnostics destination sits under it. */
  dataRoot: string;
  registryFile: string;
  providerKeysFile: string;
  remoteInstancesFile: string;
  worktreesRoot: string;
  oauthScratchDir: string;
  logDir: string;
  /** Directory holding the built browser bundle for remote clients; "" serves the transport only. */
  webRoot: string;
}

/** The desktop client's own artifact updater, as the client-effect channels drive it. */
export interface ClientAppUpdate {
  readonly state: AppUpdateState;
  checkNow(manual: boolean): Promise<AppUpdateState>;
  download(): Promise<void>;
  openReleaseNotes(): Promise<void>;
  showDownload(): Promise<void>;
  restart(confirmed: boolean): AppUpdateRestartResult;
  setInstallOnQuit(on: boolean): void;
  dismiss(version: string, remember: boolean): void;
}

/**
 * Release P forwarding for the client-effect channels still declared in
 * BACKEND_CHANNELS: effects only the desktop client can perform on its own
 * machine. A host constructed without them answers every such channel with
 * "not available on this host".
 */
export interface ClientEffects {
  openPath(absPath: string): Promise<void>;
  showPathInFolder(absPath: string): void;
  openProject(projectPath: string, target: ProjectOpenTarget): Promise<void>;
  getProjectOpenAvailability(): ProjectOpenAvailability | Promise<ProjectOpenAvailability>;
  setWindowChrome(background: string, symbol: string): void;
  chooseDiagnosticsPath(basename: string): Promise<string | null>;
  appUpdate: ClientAppUpdate;
}

export interface HostApplicationDeps {
  paths: HostPaths;
  /** This build's version as reported to joiners, `host:status`, and the state projection. */
  hostVersion: string;
  /** Encrypts provider keys and joined-instance credentials at rest. */
  cipher: KeyCipher;
  /** Proof that this process owns `paths.dataRoot` (issue #442 §10.1). */
  authority: AuthorityToken;
  /**
   * What a corrupt registry does at construction (issue #442 §10.1). The
   * persistent host passes `"stop"` so it never discards a user's registry;
   * Electron main keeps the quarantine it always had. Default `"quarantine"`.
   */
  recoveryPolicy?: "quarantine" | "stop";
  /**
   * The children ledger the authority reconciled before this host loaded
   * (#450): every spawn lands in it before the child is reported live, every
   * reap removes it. Absent for Electron main and focused tests.
   */
  ledger?: ChildrenLedger;
  /**
   * The headless plan verifier's payload and page (issue #442 §8). Null in
   * tests: the verifier is constructed degraded and never launches.
   */
  verifier: { resourcesDir: string; packaged: boolean; runtimeDir: string; pageDir: string } | null;
  breadcrumbs: BreadcrumbSink;
  /** Dev/test model pins forced on every spawn this instance makes. */
  spawnGate?: SpawnGate;
  /** Process owner override for focused tests. */
  sessions?: SessionManager;
  /** The attached desktop client's facts for diagnostics; absent or null when none is attached. */
  clientFacts?: () => DesktopClientFacts | null;
  clientEffects?: ClientEffects | null;
}

const NOT_ON_THIS_HOST = "not available on this host";

/**
 * The authoritative application (issue #442 §9): owns the registry, the
 * stores, and every live child through SessionManager, and is the one
 * HostSurface every transport dispatches into. It knows no Electron: the
 * desktop client's effects and facts arrive injected, and its window is one
 * event sink among the remote ones.
 */
export class HostApplication implements HostSurface {
  /** Serializes each complete state build and delivery so an older snapshot can never overtake a newer one. */
  private broadcastChain: Promise<void> = Promise.resolve();
  private readonly registry: Registry;
  private ompPath = resolveOmpBinary();
  readonly sessions: SessionManager;
  /** The one plan verification service (§4): owned here, injected downward. */
  private readonly planVerifier: PlanVerifier;
  /** Latest verifier health; the `verifier` breadcrumb mirrors every change. */
  private verifierHealth: VerifierHealth = {
    pin: null,
    sha256: null,
    state: "degraded",
    reason: "not constructed",
    atMs: 0,
  };
  /** The loopback origin serving the verifier page; started on the first launch, closed in shutdown. */
  private verifierOrigin: Promise<VerifierOrigin> | null = null;
  /** The host-authored per-tab attention level (issue #442); read by summaries and test seams. */
  readonly attention: AttentionTracker;
  /** The authority witness this host was constructed under; the registry and the resume seam opened with it. */
  readonly authority: AuthorityToken;
  private readonly ompUpdater: OmpUpdater;
  private readonly remote: RemoteServerManager;
  /** Joined remote instances (issue #416): their sockets, credentials, and merged registries. */
  private readonly remoteInstances: RemoteInstanceManager;
  /** Every connection with a live table, by id — the recipients of each state:changed. */
  private readonly connections = new Map<string, ConnectionContext>();
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
  /** The parsed dev/test gate; one value feeds every spawn and the state projection. */
  private readonly spawnGate: SpawnGate;
  /** Precomputed wire projection of `spawnGate`; identical on every broadcast. */
  private readonly spawnGateState: SpawnGateState;
  private readonly paths: HostPaths;
  private readonly breadcrumbs: BreadcrumbSink;
  /** This build's version as reported to joiners and the state projection alike. */
  private readonly hostVersion: string;
  private readonly clientFacts: () => DesktopClientFacts | null;
  private readonly clientEffects: ClientEffects | null;
  /** One in-flight export at a time (issue #413). */
  private exportInFlight = false;
  /** Last delivered omp-update status, for one-per-transition breadcrumbs. */
  private lastOmpUpdateStatus: string | null = null;

  constructor(deps: HostApplicationDeps) {
    this.paths = deps.paths;
    this.breadcrumbs = deps.breadcrumbs;
    this.hostVersion = deps.hostVersion;
    this.authority = deps.authority;
    this.clientFacts = deps.clientFacts ?? (() => null);
    this.clientEffects = deps.clientEffects ?? null;
    this.registry = Registry.load(deps.paths.registryFile, deps.authority, deps.recoveryPolicy ?? "quarantine");
    // Applied in the constructor, not at boot: spawn() must never be reachable
    // with a keyless environment, and the login-shell capture (boot, async) only
    // ever adds to what is already installed here.
    this.providerKeys = new ProviderKeys(deps.paths.providerKeysFile, deps.cipher);
    this.providerKeys.applyToProcessEnv();
    // Retained once: the SessionManager pins and the state projection must
    // describe the same startup value, never two environment reads.
    this.spawnGate = deps.spawnGate ?? NO_GATE;
    this.spawnGateState = {
      model: this.spawnGate.model === null ? null : formatModelRole(this.spawnGate.model),
      advisorModel:
        this.spawnGate.advisorModel === null ? null : formatModelRole(this.spawnGate.advisorModel),
    };
    this.providerOAuth = new ProviderOAuth({
      getOmpPath: () => this.ompPath,
      scratchDir: deps.paths.oauthScratchDir,
      send: (state) => this.send(CH.onProviderOAuthState, state),
    });
    this.attention = new AttentionTracker({
      send: (channel, ...args) => this.send(channel, ...args),
      isPty: (tabId) => this.sessions.isPtyTab(tabId),
    });
    this.planVerifier = this.createPlanVerifier(deps.verifier);
    if (deps.sessions !== undefined) {
      this.sessions = deps.sessions;
    } else {
      this.sessions = new SessionManager({
        registry: this.registry,
        authority: deps.authority,
        ledger: deps.ledger,
        providerKeys: this.providerKeys,
        hasOAuthProvider: () => this.providerOAuth.hasModelAccount(),
        getOmpPath: () => this.ompPath,
        getSessionsRoot: () => this.sessionsRoot,
        getArchiveRoot: () => this.archiveRoot,
        getWorktreesRoot: () => this.paths.worktreesRoot,
        send: (channel, ...args) => this.send(channel, ...args),
        broadcast: () => this.broadcast(),
        attention: this.attention,
        breadcrumb: this.breadcrumbs,
        spawnGate: this.spawnGate,
        planVerify: (html, themeId, signal) => this.planVerifier.verify(html, themeId, signal),
      });
      this.sessions.registerFrameObserver(this.attention);
    }
    this.ompUpdater = new OmpUpdater({
      getDismissed: () => this.registry.getSetting("dismissedOmpUpdateVersion"),
      setDismissed: (v) => this.registry.setSetting("dismissedOmpUpdateVersion", v),
      onApplied: () => this.refreshOmpPath(),
      send: (ch, s) => {
        // One breadcrumb per status transition, not per heartbeat (issue #413).
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
      surface: this,
      webRoot: deps.paths.webRoot,
      hostVersion: this.hostVersion,
      getSettings: () => ({
        enabled: this.registry.getSetting("remoteEnabled"),
        bind: this.registry.getSetting("remoteBind"),
        port: this.registry.getSetting("remotePort"),
        token: this.registry.getSetting("remoteToken"),
        passwordHash: this.registry.getSetting("remotePasswordHash"),
        passwordSalt: this.registry.getSetting("remotePasswordSalt"),
      }),
      setToken: (token) => this.registry.setSetting("remoteToken", token),
      send: (state) => this.send(CH.onRemoteState, state),
    });
    // A stable identity so a joiner can recognise this app as itself (issue #416).
    if (this.registry.getSetting("instanceId") === "") this.registry.setSetting("instanceId", randomUUID());
    this.remoteInstances = new RemoteInstanceManager({
      store: new RemoteInstanceStore(deps.paths.remoteInstancesFile, deps.cipher),
      localInstanceId: () => this.registry.getSetting("instanceId"),
      localVersion: this.hostVersion,
      send: (ch, args) => this.send(ch, ...args),
      broadcast: () => this.broadcast(),
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
    void sweepOrphanWorktrees(this.paths.worktreesRoot, referencedWorktrees)
      .then((removed) => {
        if (removed.length > 0) {
          console.log(`[host] swept ${removed.length} orphan worktree checkout(s)`);
        }
      })
      .catch((err) => console.warn("[host] worktree sweep failed:", err));
  }

  /**
   * The one plan verifier (§4). Its payload is the pinned Chrome for Testing
   * shipped in resources — never a system browser — and a missing or
   * mismatched payload degrades the verifier (every verify answers
   * VERIFIER_UNAVAILABLE) rather than falling back. Health lands on the
   * `verifier` breadcrumb at construction and on every change.
   */
  private createPlanVerifier(
    verifier: HostApplicationDeps["verifier"],
  ): PlanVerifier {
    const record = (h: VerifierHealth): void => {
      this.verifierHealth = h;
      this.breadcrumbs.record("verifier", {
        detail: `${h.state}${h.pin === null ? "" : ` pin=${h.pin}`}${h.reason === null ? "" : ` ${h.reason}`}`,
      });
    };
    if (verifier === null) {
      const degraded = { available: false as const, reason: "no verifier configured" };
      record({ pin: null, sha256: null, state: "degraded", reason: degraded.reason, atMs: Date.now() });
      return new PlanVerifier({
        page: () => {
          throw new Error("no verifier page configured");
        },
        degraded,
      });
    }
    const payload = resolveVerifierPayload({
      resourcesDir: verifier.resourcesDir,
      packaged: verifier.packaged,
    });
    if ("available" in payload) {
      record({ pin: null, sha256: null, state: "degraded", reason: payload.reason, atMs: Date.now() });
      return new PlanVerifier({
        page: () => {
          throw new Error(payload.reason);
        },
        degraded: payload,
      });
    }
    record({ pin: payload.version, sha256: payload.sha256, state: "ready", reason: null, atMs: Date.now() });
    return new PlanVerifier({
      page: async () => {
        this.verifierOrigin ??= startVerifierOrigin(verifier.pageDir).catch((err: unknown) => {
          this.verifierOrigin = null;
          throw err;
        });
        const origin = await this.verifierOrigin;
        return new ChromeVerifierPage({
          executablePath: payload.executablePath,
          userDataDir: path.join(verifier.runtimeDir, "verifier-profile"),
          origin: origin.origin,
          prefix: origin.prefix,
          onHealth: (h) => record({ ...h, pin: payload.version, sha256: payload.sha256 }),
        });
      },
      health: () => this.verifierHealth,
    });
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

  private readonly sinks = new Set<ScopedSink>();

  /** Registers an event mirror (the remote server, the desktop window). Returns its unsubscribe. */
  addSink(sink: ScopedSink): () => void {
    this.sinks.add(sink);
    return () => this.sinks.delete(sink);
  }

  /** The socket is gone: forget its table, drop its viewed report, and let joined instances drop theirs. */
  connectionClosed(id: string): void {
    this.connections.delete(id);
    this.sessions.connectionClosed(id);
    this.remoteInstances.connectionClosed(id);
  }

  /** To every connection. */
  private send(channel: string, ...args: unknown[]): void {
    this.emit({ kind: "broadcast" }, channel, args);
  }

  /** To one connection; the sinks decide whether they carry that id. */
  private sendTo(id: string, channel: string, ...args: unknown[]): void {
    this.emit({ kind: "connection", id }, channel, args);
  }

  /** To every connection of one role. */
  private sendRole(role: ClientRole, channel: string, ...args: unknown[]): void {
    this.emit({ kind: "role", role }, channel, args);
  }

  private emit(scope: EventScope, channel: string, args: unknown[]): void {
    for (const sink of this.sinks) sink(scope, channel, args);
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
      facts: {
        appVersion: this.hostVersion,
        ompVersion: this.ompPath ? await readInstalledOmpVersion(this.ompPath) : null,
        ompPath: this.ompPath,
        nodeVersion: process.version,
        platform: process.platform,
        arch: process.arch,
        osRelease: os.release(),
        totalMemBytes: os.totalmem(),
        freeMemBytes: os.freemem(),
        cpuModels: os.cpus().map((cpu) => cpu.model),
        sessionsRoot: this.sessionsRoot,
        archiveRoot: this.archiveRoot,
        agentDir: getOmpAgentDir(),
        registryFile: this.paths.registryFile,
        logDir: this.paths.logDir,
        host: this.hostFacts(),
        desktopClient: this.clientFacts(),
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
   * Every channel's implementation for one connection, transport-agnostic: Electron IPC binds a
   * table below and the remote WebSocket server dispatches one per socket (issue #37). The table
   * is built with the connection's context so `state:get` can stamp `self`, and the connection
   * is remembered until connectionClosed so each state:changed reaches it addressed.
   */
  handlers(ctx: ConnectionContext): ChannelTable {
    this.connections.set(ctx.id, ctx);
    const table = {
      request: {
        [CH.getState]: () => this.buildState(ctx),
        [CH.addProject]: async (raw: string) => {
          const resolved = await resolveProjectPath(raw);
          const record = this.registry.addProject(resolved);
          await this.broadcast();
          return record;
        },
        [CH.browseDirectories]: (partialPath: string) => browseDirectories(partialPath),
        [CH.removeProject]: async (projectPath: string) => {
          if (this.sessions.hasLiveInProject(projectPath)) {
            throw new Error("project has live sessions — terminate them first");
          }
          this.sessions.stopProjectWatchers(projectPath);
          const sessions = this.registry.sessions;
          const checkouts = sessions.flatMap((session) =>
            session.projectCwd === projectPath && session.worktree !== null
              ? [{ projectCwd: projectPath, worktree: session.worktree }]
              : [],
          );
          await reclaimCheckouts(checkouts, {
            worktreesRoot: this.paths.worktreesRoot,
            survivingSessions: sessions.filter((session) => session.projectCwd !== projectPath),
            warn: (message, error) =>
              error === undefined
                ? console.warn(`[host] ${message}`)
                : console.warn(`[host] ${message}`, error),
          });
          this.registry.removeProject(projectPath);
          await this.broadcast();
        },
        // Reordering never touches process state, so unlike remove there is no
        // live-session guard; a null `beforePath` appends (issue #115).
        [CH.moveProject]: async (projectPath: string, beforePath: string | null) => {
          this.registry.moveProject(projectPath, beforePath ?? null);
          await this.broadcast();
        },
        // Reordering never touches process state, so like moveProject there
        // is no live-session guard (#274).
        [CH.moveSession]: async (tabId: string, beforeTabId: string | null) => {
          this.registry.moveSession(tabId, beforeTabId ?? null);
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
        [CH.setDefaultMode]: async (mode: SessionMode) => {
          this.registry.setSetting("defaultMode", mode);
          await this.broadcast();
        },
        [CH.setDefaultAgentMode]: async (mode: AgentMode) => {
          this.registry.setSetting("defaultAgentMode", mode);
          await this.broadcast();
        },
        [CH.listCompactionMethods]: async () =>
          (await readOmpCompactionMethods({ ompPath: this.ompPath, projectCwd: null })).supported,
        [CH.setDefaultCompactionMethod]: async (method: string | null) => {
          if (method !== null) {
            const { supported } = await readOmpCompactionMethods({
              ompPath: this.ompPath,
              projectCwd: null,
            });
            if (!supported.includes(method)) throw new Error(`Unsupported compaction method: ${method}`);
          }
          this.registry.setSetting("defaultCompactionMethod", method);
          await this.broadcast();
        },
        [CH.setPlanFormat]: async (format: PlanFormat) => {
          this.registry.setSetting("planFormat", format);
          await this.broadcast();
        },
        [CH.setHibernateIdleMinutes]: async (minutes: number) => {
          this.registry.setSetting("hibernateIdleMinutes", minutes);
          await this.broadcast();
        },
        [CH.setStreamStallAbortSeconds]: async (seconds: number) => {
          this.registry.setSetting("streamStallAbortSeconds", seconds);
          await this.broadcast();
        },
        [CH.setAdvisorAutoReply]: async (on: boolean) => {
          this.registry.setSetting("advisorAutoReply", on);
          await this.broadcast();
        },
        [CH.setStallAutoContinue]: async (on: boolean) => {
          this.registry.setSetting("stallAutoContinue", on);
          await this.broadcast();
        },
        [CH.setDesktopNotifications]: async (on: boolean) => {
          this.registry.setSetting("desktopNotifications", on);
          await this.broadcast();
        },
        [CH.setDefaultAdvisor]: async (on: boolean) => {
          this.registry.setSetting("defaultAdvisor", on);
          await this.broadcast();
        },
        [CH.setSkipDeleteConfirmation]: async (skip: boolean) => {
          this.registry.setSetting("skipDeleteConfirmation", skip);
          await this.broadcast();
        },
        [CH.setThemeId]: async (id: string) => {
          this.registry.setSetting("themeId", id);
          await this.broadcast();
        },
        [CH.setFontFamilyId]: async (id: string) => {
          this.registry.setSetting("fontFamilyId", id);
          await this.broadcast();
        },
        [CH.setTranscriptWidth]: async (width: TranscriptWidth) => {
          this.registry.setSetting("transcriptWidth", width);
          await this.broadcast();
        },
        [CH.setGlassChrome]: async (level: GlassChrome) => {
          this.registry.setSetting("glassChrome", level);
          await this.broadcast();
        },
        [CH.setLocaleId]: async (id: string) => {
          this.registry.setSetting("localeId", id);
          await this.broadcast();
        },
        [CH.setAppUpdateCheckOnLaunch]: async (on: boolean) => {
          this.registry.setSetting("appUpdateCheckOnLaunch", on);
          await this.broadcast();
        },
        [CH.setOmpUpdateCheckOnLaunch]: async (on: boolean) => {
          this.registry.setSetting("ompUpdateCheckOnLaunch", on);
          await this.broadcast();
        },
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
          this.registry.setSessionModel(tabId, model, thinkingLevel);
          void this.broadcast();
        },
        [CH.spawnSession]: (req: SpawnRequest) => this.sessions.spawn(req),
        [CH.terminateSession]: (tabId: string) => this.sessions.terminate(tabId),
        [CH.hibernatePlanSource]: (sourceTabId: string, implementationTabId: string) =>
          this.sessions.hibernatePlanSource(sourceTabId, implementationTabId),
        [CH.switchMode]: (tabId: string, mode: SessionMode) =>
          this.sessions.switchMode(tabId, mode),
        [CH.deleteSessionPreview]: (tabId: string) =>
          this.sessions.deleteSessionPreview(tabId),
        [CH.deleteSession]: (tabId: string, cascade: boolean) =>
          this.sessions.deleteSession(tabId, cascade),
        [CH.forkSession]: (tabId: string) => this.sessions.forkSession(tabId),
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
        [CH.getAdvisorDefaults]: (projectCwd: string): AdvisorDefaults =>
          this.advisorDefaults(projectCwd),
        [CH.generateTitle]: (projectCwd: string, prompt: string, titleHint?: string | null) =>
          this.generateTitle(projectCwd, prompt, titleHint ?? null),
        [CH.retitleSession]: (
          projectCwd: string,
          previousTitle: string,
          transcript: string,
        ) => this.retitleSession(projectCwd, previousTitle, transcript),
        [CH.readPlanFile]: (tabId: string, absPath: string) => this.readPlanFile(tabId, absPath),
        [CH.answerPlanReview]: (
          tabId: string,
          frameId: string,
          verdict: PlanReviewVerdict,
          sourceHash: string | null,
        ) => this.sessions.answerPlanReview(tabId, frameId, verdict, sourceHash),
        // Client effects (P only): forwarded to the attached desktop client, refused without one.
        [CH.getProjectOpenAvailability]: () => this.effects().getProjectOpenAvailability(),
        [CH.openProject]: (projectPath: string, target: ProjectOpenTarget) =>
          this.effects().openProject(projectPath, target),
        [CH.openPath]: (absPath: string) => this.effects().openPath(absPath),
        [CH.showPathInFolder]: (absPath: string) => {
          this.effects().showPathInFolder(absPath);
        },
        [CH.getBranchDiff]: (projectCwd: string, base?: string | null) =>
          readBranchDiff(projectCwd, base ?? null),
        // Stateless core calls: branch operations touch no registry/BackendState field,
        // so these handlers never broadcast().
        [CH.listBranches]: (projectCwd: string, opts?: BranchListOptions) =>
          listBranches(projectCwd, opts),
        [CH.checkoutBranch]: (projectCwd: string, name: string, opts?: { create?: boolean }) =>
          checkoutBranch(projectCwd, name, opts),
        [CH.pullBranch]: (projectCwd: string) => pullBranch(projectCwd),
        // Push answers git state through a structured PushResult rather than a
        // rejection (issue #414); like pull it touches no BackendState field,
        // so this handler never broadcasts.
        [CH.pushBranch]: (projectCwd: string, branch: string, remote?: string | null) =>
          pushBranch(projectCwd, branch, remote),
        // Builds a URL only. Main never opens it: the renderer hands the result
        // to window.open, where setWindowOpenHandler's web-scheme guard decides.
        [CH.pullRequestUrl]: (projectCwd: string, base: string, head: string) =>
          pullRequestUrl(projectCwd, base, head),
        [CH.createBranch]: (projectCwd: string, name: string, startPoint: string) =>
          createBranch(projectCwd, name, startPoint),
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
            worktreePath !== null && !isWithin(this.paths.worktreesRoot, worktreePath)
              ? null
              : worktreePath,
          ),
        [CH.mergeWorktreeBranch]: (projectCwd: string, branch: string, destination: string) =>
          mergeWorktreeBranch(projectCwd, branch, destination, {
            scratchRoot: path.join(this.paths.worktreesRoot, ".merge"),
          }),
        // The memory overview handler is a stateless core call like
        // getBranchDiff: it touches no registry/BackendState field and never
        // calls broadcast().
        [CH.memoryOverview]: (projectCwd: string) => readMemoryOverview(projectCwd),
        [CH.suggestBranchName]: (projectCwd: string, planContext: string) =>
          this.suggestBranchName(projectCwd, planContext),
        [CH.readOmpSettings]: (projectCwd: string | null) =>
          readOmpSettings({ ompPath: this.ompPath, projectCwd }),
        [CH.writeOmpSetting]: (key: string, value: OmpSettingValue) =>
          writeOmpSetting({ ompPath: this.ompPath, key, value }),
        // The provider list is omp-version-scoped, not app state: one probe per
        // Providers mount, no cache, no broadcast (ADR-0027).
        [CH.readWebSearchProviders]: () => readWebSearchProviders({ ompPath: this.ompPath }),
        // Each write answers with the refreshed snapshot in the same round trip,
        // so the page never has to guess what the store now holds.
        [CH.readProviderKeys]: (projectCwd: string | null) => this.providerSnapshot(projectCwd),
        [CH.setProviderKey]: (envName: string, value: string) => {
          this.providerKeys.setKey(envName, value);
          return this.providerSnapshot(null);
        },
        [CH.clearProviderKey]: (envName: string) => {
          this.providerKeys.clearKey(envName);
          return this.providerSnapshot(null);
        },
        // Subscription (OAuth) sign-ins (issue #368): the flow state is pushed to
        // every renderer via onProviderOAuthState; the page reads the rows itself.
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
        [CH.signOutProviderOAuth]: (id: string) => this.providerOAuth.signOut(id),
        [CH.setWindowChrome]: (background: string, symbol: string) => {
          this.effects().setWindowChrome(background, symbol);
        },
        [CH.getMcpServers]: (projectCwd: string | null) => resolveMcpServers(projectCwd),
        [CH.setMcpServerEnabled]: (req: McpSetEnabledRequest) => setMcpServerEnabled(req),
        // Capability catalogs (issue #383): stateless core reads like
        // getMcpServers — one ompSettings spawn chain, no session involved.
        [CH.getScopedCapabilities]: (scopeCwd: string | null) =>
          getScopedCapabilities(scopeCwd, this.ompPath),
        [CH.setScopedCapability]: (req: ScopedCapabilityMutation) =>
          setScopedCapability(req, this.ompPath),
        [CH.restartSession]: (tabId: string) => this.sessions.restart(tabId),
        [CH.getSessionCapabilities]: (tabId: string) =>
          this.sessions.getSessionCapabilities(tabId),
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
        // The client's own artifact updater (P only): the desktop constructs and injects it.
        [CH.getAppUpdateState]: () => this.effects().appUpdate.state,
        [CH.checkAppUpdate]: () => this.effects().appUpdate.checkNow(true),
        [CH.downloadAppUpdate]: () => this.effects().appUpdate.download(),
        [CH.openAppUpdateReleaseNotes]: () => this.effects().appUpdate.openReleaseNotes(),
        [CH.showAppUpdateDownload]: () => this.effects().appUpdate.showDownload(),
        [CH.restartForAppUpdate]: (confirmed = false) => this.effects().appUpdate.restart(confirmed),
        [CH.setAppUpdateInstallOnQuit]: (on: boolean) => this.effects().appUpdate.setInstallOnQuit(on),
        [CH.dismissAppUpdate]: (version: string, remember: boolean) =>
          this.effects().appUpdate.dismiss(version, remember),
        [CH.getRemoteState]: () => this.remote.state,
        [CH.setRemoteEnabled]: async (on: boolean) => {
          this.registry.setSetting("remoteEnabled", on);
          this.breadcrumbs.record("remote-enable", { detail: on ? "on" : "off" });
          await this.remote.apply();
        },
        [CH.setRemoteBind]: async (bind: RemoteBind) => {
          this.registry.setSetting("remoteBind", bind);
          await this.remote.apply();
        },
        [CH.setRemotePort]: async (port: number) => {
          if (!Number.isInteger(port) || port < 1024 || port > 65535) {
            throw new Error("port must be a whole number between 1024 and 65535");
          }
          this.registry.setSetting("remotePort", port);
          await this.remote.apply();
        },
        [CH.regenerateRemoteToken]: async () => {
          this.registry.setSetting("remoteToken", mintRemoteToken());
          // State only — the token itself never reaches the ring (issue #37).
          this.breadcrumbs.record("remote-token-regenerate");
          await this.remote.rotateCredential();
        },
        [CH.setRemotePassword]: async (password: string) => {
          const problem = validateRemotePassword(password);
          if (problem !== null) throw new Error(problem);
          const { salt, hash } = hashRemotePassword(password);
          this.registry.setSettings({ remotePasswordHash: hash, remotePasswordSalt: salt });
          // apply(), not restart(): the new hash/salt already makes sameTarget false.
          await this.remote.apply();
        },
        [CH.clearRemotePassword]: async () => {
          this.registry.setSettings({ remotePasswordHash: "", remotePasswordSalt: "" });
          await this.remote.apply();
        },
        // Remote instances (issue #416): identity for joiners; the manager owns the rest.
        [CH.getInstanceIdentity]: () => ({
          instanceId: this.registry.getSetting("instanceId"),
          version: this.hostVersion,
          protocolVersion: HOST_PROTOCOL,
          protocolRange: HOST_PROTOCOL_RANGE,
        }),
        // Control plane (issue #442 §10.4): omitted from every table whose grant lacks control —
        // in P, that is every connection there is.
        [CH.getHostStatus]: () => this.hostStatus(),
        [CH.stopHost]: () => {
          void this.shutdown();
        },
        [CH.getHostPairing]: (): HostPairing => ({
          urls: this.remote.state.urls,
          tokenUrls: this.remote.state.tokenUrls,
          hasPassword: this.remote.state.hasPassword,
        }),
        // Host self-update (§7): P ships no host updater, so the state is idle and every action refuses.
        [CH.getHostUpdateState]: () => this.hostUpdateState(),
        [CH.checkHostUpdate]: () => this.hostUpdateState(),
        [CH.deferHostUpdate]: () => this.hostUpdateState(),
        [CH.downloadHostUpdate]: () => {
          throw new Error("no host updater in this build");
        },
        [CH.applyHostUpdate]: () => {
          throw new Error("no host updater in this build");
        },
        [CH.rollbackHostUpdate]: () => {
          throw new Error("no host updater in this build");
        },
        [CH.addRemoteInstance]: (input: RemoteInstanceInput) => this.remoteInstances.add(input),
        [CH.updateRemoteInstance]: (id: string, patch: RemoteInstancePatch) =>
          this.remoteInstances.update(id, patch),
        [CH.removeRemoteInstance]: (id: string) => this.remoteInstances.remove(id),
        [CH.reconnectRemoteInstance]: (id: string) => this.remoteInstances.reconnect(id),
        [CH.remoteInstanceRequest]: (instanceId: string, channel: string, args: unknown[]) =>
          this.remoteInstances.request(instanceId, channel, args),
        [CH.previewDiagnosticsBundle]: async () =>
          previewDiagnosticsBundle(
            await this.diagnosticsOptions({ includeTranscripts: false, destinationPath: null }),
          ),
        [CH.exportDiagnosticsBundle]: (req: DiagnosticsExportRequest) => this.exportDiagnostics(req),
        [CH.chooseDiagnosticsPath]: (basename: string) => this.effects().chooseDiagnosticsPath(basename),
      },
      notify: {
        [CH.ptyWrite]: (tabId: string, data: string) => this.sessions.ptyWrite(tabId, data),
        [CH.ptyResize]: (tabId: string, cols: number, rows: number) =>
          this.sessions.ptyResize(tabId, cols, rows),
        [CH.shellKill]: (tabId: string) => this.sessions.killShell(tabId),
        [CH.shellWrite]: (tabId: string, data: string) => this.sessions.shellWrite(tabId, data),
        [CH.shellResize]: (tabId: string, cols: number, rows: number) =>
          this.sessions.shellResize(tabId, cols, rows),
        [CH.rpcSend]: (tabId: string, cmd: RpcFrame) => this.sessions.rpcSend(tabId, cmd),
        // The connection id is the report's identity: the transport supplies it (issue #442).
        [CH.tabViewed]: (tabId: string | null) => this.sessions.setViewedTab(ctx.id, tabId),
        [CH.remoteInstanceNotify]: (instanceId: string, channel: string, args: unknown[]) =>
          this.remoteInstances.notify(instanceId, channel, args),
      },
    } satisfies ChannelTable;
    // Tab-scoped channels reach the instance that owns the tab; a local tab stays local. Control-
    // plane channels exist only for a connection whose grant carries control.
    return omitUnless(
      ctx.control,
      routeByTab(table, (id) => this.remoteInstances.ownerOf(id), this.remoteInstances, ctx.id),
      CONTROL_ONLY_CHANNELS,
    );
  }

  /** The attached desktop client's effects; a host with no client refuses the channel outright. */
  private effects(): ClientEffects {
    if (this.clientEffects === null) throw new Error(NOT_ON_THIS_HOST);
    return this.clientEffects;
  }

  /** A registry setting the desktop reads for its own client-side concerns (updater dismissal, notifier gates). */
  getSetting<K extends keyof RegistrySettings>(key: K): RegistrySettings[K] {
    return this.registry.getSetting(key);
  }

  setSetting<K extends keyof RegistrySettings>(key: K, value: RegistrySettings[K]): void {
    this.registry.setSetting(key, value);
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
    return this.sessions.hydrateAll();
  }

  private providerSnapshot(projectCwd: string | null): ProviderKeysSnapshot {
    return {
      providers: this.providerKeys.statuses(projectCwd),
      encryptionAvailable: this.providerKeys.encryptionAvailable,
      backend: this.providerKeys.backend,
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

  /** Brings the embedded remote server in line with persisted settings. Called once at launch. */
  startRemote(): Promise<void> {
    return this.remote.apply();
  }

  /** Dials every joined remote instance. Called once at launch, after startRemote(). */
  startRemoteInstances(): void {
    this.remoteInstances.start();
  }

  /**
   * Stops everything this host owns. The synchronous part runs first — every
   * live child is killed and every joined instance dropped before the first
   * await — because Electron's before-quit does not wait for the returned
   * promise; the verifier origin and the remote listener close behind it. In
   * P the process exits right after, so the children are killed; the host
   * that outlives its client hibernates them instead (Release C).
   */
  async shutdown(): Promise<void> {
    this.providerOAuth.dispose();
    this.planVerifier.dispose();
    this.sessions.killAll();
    this.remoteInstances.stop();
    const origin = this.verifierOrigin;
    this.verifierOrigin = null;
    await Promise.all([
      origin?.then(
        (o) => o.close(),
        () => undefined,
      ),
      this.remote.stop(),
    ]);
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

  /**
   * Titles a prompt with omp's own small model. Null on every failure path —
   * no omp binary, a model the config names but the machine cannot reach, a
   * timeout, or a greeting the model declines to title. The renderer falls
   * back to its derived title, so this must never throw across IPC.
   */
  private async generateTitle(
    projectCwd: string,
    prompt: string,
    titleHint: string | null = null,
  ): Promise<string | null> {
    if (!this.ompPath) return null;
    // The config's own role chain, so the title comes from whichever small
    // model the user already configured for omp's own titling.
    const role = readOmpModelRole(projectCwd, TITLE_MODEL_ROLES);
    try {
      return await generateTitleWithOmp({
        ompPath: this.ompPath,
        projectCwd,
        model: role === null ? null : formatModelRole(role),
        // A hint is the record's authoritative title source (plan-seeded
        // implementation sessions): it replaces the prompt as the payload.
        prompt: titleHint ?? prompt,
      });
    } catch (err) {
      console.warn("[title] model titling failed:", err);
      return null;
    }
  }

  /**
   * Re-titles a live session from a transcript digest. Null on every failure
   * path — the row keeps its current title, so this must never throw across
   * IPC. Same best-effort contract and model-role chain as titling.
   */
  private async retitleSession(
    projectCwd: string,
    previousTitle: string,
    transcript: string,
  ): Promise<string | null> {
    if (!this.ompPath) return null;
    const role = readOmpModelRole(projectCwd, TITLE_MODEL_ROLES);
    try {
      return await retitleSessionWithOmp({
        ompPath: this.ompPath,
        projectCwd,
        model: role === null ? null : formatModelRole(role),
        prompt: "",
        previousTitle,
        transcript,
      });
    } catch (err) {
      console.warn("[title] session re-titling failed:", err);
      return null;
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

  private async buildState(ctx: ConnectionContext): Promise<BackendState> {
    return { ...(await this.buildSharedState()), self: { role: ctx.role, local: ctx.local } };
  }

  /** Everything in BackendState but `self`: built once per refresh, stamped per connection. */
  private async buildSharedState(): Promise<Omit<BackendState, "self">> {
    // Group records by project in one pass; the old per-project filter was
    // O(projects × sessions).
    const byProject = new Map<string, OwnedSessionRecord[]>();
    for (const record of this.registry.sessions) {
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
    // The registry arrays are the sidebar orders (issues #115, #274): projects
    // append via `addProject` and reorder via `moveProject`; sessions insert
    // at their project's top via `addSession` and reorder via `moveSession`.
    // Nothing re-sorts here — otherwise a drag would be silently undone.
    return {
      projects: groups,
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
      modelFavorites: this.registry.getFavorites(),
      skipDeleteConfirmation: this.registry.getSetting("skipDeleteConfirmation"),
      themeId: this.registry.getSetting("themeId"),
      fontFamilyId: this.registry.getSetting("fontFamilyId"),
      transcriptWidth: this.registry.getSetting("transcriptWidth"),
      glassChrome: this.registry.getSetting("glassChrome"),
      localeId: this.registry.getSetting("localeId"),
      appUpdateCheckOnLaunch: this.registry.getSetting("appUpdateCheckOnLaunch"),
      ompUpdateCheckOnLaunch: this.registry.getSetting("ompUpdateCheckOnLaunch"),
      dismissedAppUpdateVersion: this.registry.getSetting("dismissedAppUpdateVersion"),
      dismissedOmpUpdateVersion: this.registry.getSetting("dismissedOmpUpdateVersion"),
      // Instance metadata, not registry state: identical on every read and
      // broadcast, for the desktop window and remote clients alike.
      spawnGate: this.spawnGateState,
      remoteInstances: this.remoteInstances.summaries(),
      hostVersion: this.hostVersion,
      hostProtocol: HOST_PROTOCOL,
      protocolRange: HOST_PROTOCOL_RANGE,
      hostUpdate: this.hostUpdateState(),
    };
  }

  /** The idle state of a build with no host updater (issue #442 §7). */
  private hostUpdateState(): HostUpdateState {
    return idleHostUpdateState(this.hostVersion);
  }

  /** The host's identity and health as both `host:status` and the diagnostics bundle report them. */
  private hostFacts(): HostDiagnosticsFacts {
    const health = this.planVerifier.health();
    return {
      dataRoot: this.authority.dataRoot,
      hostVersion: this.hostVersion,
      hostProtocol: HOST_PROTOCOL,
      verifier: { state: health.state, reason: health.reason, pin: health.pin },
      credentialBackend: this.providerKeys.backend,
    };
  }

  /** The control plane's `host:status` answer; in P the Electron process is the host itself. */
  private hostStatus(): HostStatus {
    return {
      schemaVersion: 1,
      ...this.hostFacts(),
      protocolRange: HOST_PROTOCOL_RANGE,
      pid: process.pid,
      startedAtMs: Math.round(Date.now() - process.uptime() * 1000),
      incarnation: this.authority.incarnation,
      liveSessions: this.sessions.liveCount,
      connections: this.connections.size,
      hostUpdate: this.hostUpdateState(),
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
    // Ephemeral like the plan gate: the bridge inside the live child owns goal
    // state, so a session with no live process reports none instead of a
    // remembered one (issue #381).
    const goal = this.sessions.goalSnapshot(record.tabId);
    return {
      ...record,
      title: title?.trim() || "New session",
      status,
      live,
      pendingPlan: gate?.pending ?? null,
      planSettle: gate?.settle ?? null,
      streamStalled,
      turnRunning,
      awaitingHumanAnswer,
      attention: this.attention.level(record.tabId),
      ...(goal === undefined ? {} : { goal }),
    };
  }

  /**
   * Fans state to every connection, each addressed and stamped with its own `self`; the window
   * sink self-guards, so remote clients survive a closed window.
   */
  private broadcast(): Promise<void> {
    const task = this.broadcastChain.then(async () => {
      const shared = await this.buildSharedState();
      for (const ctx of this.connections.values()) {
        this.sendTo(ctx.id, CH.onStateChanged, {
          ...shared,
          self: { role: ctx.role, local: ctx.local },
        });
      }
    });
    // Keep the queue usable after a failed build without changing the Promise
    // returned to this caller: `task` still carries its own rejection.
    this.broadcastChain = task.catch(() => {});
    return task;
  }
}
