import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  CH,
  base64Bytes,
  bracketedImagePaste,
  browserPaneSetMessage,
  browserClockText,
  capabilityToolMutationMessage,
  capabilitiesMessage,
  CAPABILITIES_STATUS_KEY,
  deleteSessionFiles,
  eventFilterEchoIsDelta,
  EVENT_FILTER_COMMAND_ID,
  isObject,
  setEventFilterCommand,
  setHostToolsCommand,
  setHostUriSchemesCommand,
  autoresearchArmMessage,
  vibeArmMessage,
  mintLineageDirName,
  settledWithin,
  forkSessionFile,
  findObsidianList,
  getOmpAgentDir,
  linkProjectOmpDir,
  isHtmlPlanPath,
  isWithin,
  knowledgeVaultArmMessage,
  knowledgeVaultGuidance,
  mcpRuntimeStatusMessage,
  MAX_DOCUMENT_BATCH_BYTES,
  resolveDocument,
  resolveKnowledgeHome,
  resolveVaultProjectFolder,
  normalizeControlFrame,
  parseCapabilitySnapshot,
  planMessage,
  planHandoffDescendants,
  projectSlug,
  slugifyProjectName,
  type BrowserPaneClearDataResult,
  type BrowserPaneDiagnostics,
  type BrowserPaneEnsureResult,
  type BrowserPaneInputEvent,
  type BrowserPaneNavigate,
  type BrowserPanePickResult,
  type PlanAnswerResult,
  type PlanRenderResult,
  type PlanReviewVerdict,
  type ProviderKeys,
  type Registry,
  resolveSessionLocation,
  resolveSubagentOverlayEntries,
  RpcClient,
  spawnOmp,
  writeImageToScratch,
  writeSubagentModelOverlay,
  writeReviewOverlay,
  MAX_IMAGE_BYTES,
  type ConsoleProgram,
  type DeleteSessionPreview,
  type DeleteSessionResult,
  type ImageAttachment,
  type DocumentAttachment,
  type OwnedSessionRecord,
  type ObsidianListEntry,
  type RpcFrame,
  type ResumeSpawnRequest,
  type GoalState,
  type VibeSnapshot,
  type AutoresearchSnapshot,
  type CapabilityToolMutationRequest,
  type SessionCapabilitiesResult,
  type SetSessionToolEnabledResult,
  type SessionMode,
  type SubagentModelMap,
  type ApprovalMode,
  type ServiceTier,
  type SessionWorktree,
  type SpawnRequest,
  type WorktreeReleaseOptions,
  type WorktreeReleaseResult,
  type CollabAccess,
  type CollabCliDeps,
  type CollabTabSnapshot,
  type WorktreeSyncResult,
  type VaultAction,
} from "@omp-ui/core";
import { CollabTracker } from "./collab-tracker";
import type { Attention } from "./desktop-notifier";
import { BrowserPaneHost, type BrowserPaneHostDeps } from "./browser-pane-host";
import type { DesktopMediaLease } from "../browser-pane-desktop-protocol";
import type { BreadcrumbSink } from "./breadcrumbs";
import type { FrameObserver } from "./frame-observer";
import {
  createPtyLiveEntry,
  createRpcLiveEntry,
  type LiveEntry,
  wirePtyData,
  wireRpc,
} from "./live-entry";
import { DialogGateTracker } from "./dialog-gate-tracker";
import { HibernationTracker } from "./hibernation-tracker";
import { CapabilityControlTracker } from "./capability-control-tracker";
import { HostBridge } from "./host-bridge";
import { PlanGateTracker, type PlanGate } from "./plan-gate-tracker";
import { PlanPreflightController } from "./plan-preflight";
import { readConfinedPlanFile } from "./plan-file";
import { GoalStatusTracker } from "./goal-status-tracker";
import { VibeStatusTracker } from "./vibe-status-tracker";
import { AutoresearchStatusTracker } from "./autoresearch-status-tracker";
import {
  prepareResumeRecord,
  writeReviewRosterForSpawn,
  writeRpcExtensions,
  writeRpcOverlays,
  writeSessionOverlays,
  type SubagentSpawnConfig,
} from "./spawn-config";
import { StallWatchdog } from "./stall-watchdog";
import { TurnTracker } from "./turns";
import { ViewTracker } from "./view-tracker";
import { WatcherHub } from "./watcher-hub";
import { ShellHost } from "./shell-host";
import { gateSelector, NO_GATE, type SpawnGate } from "./spawn-gate";
import { WorktreeOps } from "./worktree-ops";

const GRACEFUL_EXIT_MS = 3_000;
const SIGKILL_EXIT_MS = 2_000;

/** omp's restore failure (issue #774): only the resume path prints it, so the
 *  exit tail matching this is the whole detection — the group is the dead
 *  selector (`provider/id`). */
const MODEL_RESTORE_RE = /Could not restore model (\S+)/;

/** How long a tool toggle waits for its correlated completion before `unconfirmed`. */
const TOOL_MUTATION_TTL_MS = 30_000;

const NOOP_DETACH_PTY_DATA = (): void => {};

function unreachableLiveEntry(entry: never): never {
  throw new Error(`unreachable live entry kind: ${String(entry)}`);
}

export interface SessionManagerDependencies {
  registry: Registry;
  registryFile: string;
  providerKeys: ProviderKeys;
  /**
   * A catalogued provider sign-in with at least one account counts as a
   * model provider for the fresh-spawn gate (issue #368); the desktop backend
   * wires it to ProviderOAuth.hasModelAccount.
   */
  hasOAuthProvider?: () => boolean;
  getOmpPath: () => string | null;
  getSessionsRoot: () => string;
  getArchiveRoot: () => string;
  getWorktreesRoot: () => string;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
  attention?: Attention;
  /** Lifecycle breadcrumbs (issue #413); absent = no recording. */
  breadcrumb?: BreadcrumbSink;
  /**
   * The main-owned plan verifier service (issue #312 follow-up). Absent (or
   * in unit tests) answers every verification `unavailable` — a proposal is
   * never presented on an inconclusive gate, and never blocked by a missing
   * Electron runtime either: the seam keeps the gate semantics identical.
   */
  planVerify?: (html: string, themeId: string, signal: AbortSignal) => Promise<PlanRenderResult>;
  /**
   * Dev/test model pins this instance forces on every spawn it makes
   * (docs/development.md). Absent or blank means an ungated launch.
   */
  spawnGate?: SpawnGate;
  /** Browser pane seams (#519): the page factory, the bridge listener, the target page scale, and the clock stamper; tests fake them. */
  browserPane?: Pick<
    BrowserPaneHostDeps,
    "createPane" | "createListener" | "targetScaleFactor" | "clearPartition" | "stampImage" | "onDesktopMedia"
  >;
  /** Posts one immediate OS notification for the host notify tool (#688); absent = notifications report as disabled. */
  hostNotify?: (tabId: string, title: string | null, message: string) => string;
  /** Registry probe seams for the collab watcher (#686); tests fake them. */
  collabCli?: CollabCliDeps;
  /** The app version stamped into vault notes; backend passes app.getVersion(). */
  appVersion?: string;
  /** Writes vault diagnostics to the main-process log. Tests may omit the sink. */
  mainLog?: (line: string) => void;
  /** Vault project folder resolver (#787); tests fake the remote lookup. Default: core resolveVaultProjectFolder. */
  vaultFolder?: (displayName: string, projectCwd: string) => Promise<string>;
}

/** `tool`: a session-local tool enable/disable holding the tab while it waits. */
type OpKind = "spawn" | "delete" | "hibernate" | "relaunch" | "tool" | "terminate" | "fork";

export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  private readonly turns = new TurnTracker(() =>
    // A turn boundary is a real sidebar transition, not frame noise: rebuild
    // through the hub's existing throttle so a fan-out burst collapses to
    // one (issue #434). The field initializer only reads this.watcherHub at
    // call time, and the constructor builds it before any frame arrives.
    this.watcherHub.broadcastPatch(false),
  );
  private readonly shellHost: ShellHost;
  readonly browserPanes: BrowserPaneHost;
  private readonly watcherHub: WatcherHub;
  private readonly ops = new Map<string, { kind: OpKind; chain: Promise<void> }>();
  private readonly worktreeOps: WorktreeOps;
  private readonly viewTracker: ViewTracker;
  private readonly planGates: PlanGateTracker;
  private readonly planPreflight: PlanPreflightController;
  /** Resolved vault project folders (#787) keyed by project cwd; recomputed on every rpc launch, bounded by the registry's project list. */
  private readonly vaultFolders = new Map<string, string>();
  /** The main-process answerer for host tool/URI frames (issue #688, ADR-0043). */
  private readonly hostBridge: HostBridge;
  /** One in-flight execute re-check per tab (§6: atomic settle reservation). */
  private readonly planAnswerReservations = new Set<string>();
  private readonly frameObservers: FrameObserver[] = [];
  private readonly hibernation: HibernationTracker;
  private readonly stallWatchdog: StallWatchdog;
  private readonly toolControl: CapabilityControlTracker;
  private readonly goals: GoalStatusTracker;
  private readonly autoresearch: AutoresearchStatusTracker;
  private readonly vibes: VibeStatusTracker;
  /** The open blocking dialogs per tab — the summary's `pendingDialogs` (#555). */
  private readonly dialogGates = new DialogGateTracker();
  /** The omp collab local-registry watcher for terminal tabs (issue #686). */
  private readonly collab: CollabTracker;
  private readonly gate: SpawnGate;
  private obsidianListPending: Promise<ObsidianListEntry[]> | null = null;
  private obsidianListCached: ObsidianListEntry[] | null = null;
  private obsidianListExpiresAt = 0;

  constructor(private readonly deps: SessionManagerDependencies) {
    this.gate = deps.spawnGate ?? NO_GATE;
    this.worktreeOps = new WorktreeOps({
      registry: deps.registry,
      getWorktreesRoot: deps.getWorktreesRoot,
    });
    this.shellHost = new ShellHost({
      getOmpPath: deps.getOmpPath,
      send: deps.send,
      getOmpModelArg: () => gateSelector(this.gate),
    });
    this.browserPanes = new BrowserPaneHost({
      send: deps.send,
      ...deps.browserPane,
      clockEnabled: (tabId) => this.browserClockEnabled(tabId),
      clockText: () => browserClockText(new Date(), deps.registry.getSetting("localeId")),
    });
    this.watcherHub = new WatcherHub({
      registry: deps.registry,
      getSessionsRoot: () => deps.getSessionsRoot(),
      broadcast: () => deps.broadcast(),
    });
    this.viewTracker = new ViewTracker();
    this.hibernation = new HibernationTracker({
      registry: deps.registry,
      send: deps.send,
      broadcast: () => deps.broadcast(),
      attention: deps.attention,
      turns: this.turns,
      getLive: (tabId) => this.live.get(tabId),
      awaitingHumanAnswer: (tabId) => this.awaitingHumanAnswer(tabId),
      isViewed: (tabId) => this.viewTracker.isViewed(tabId),
      hibernate: (tabId, entry) => this.hibernate(tabId, entry),
      runSerialized: (tabId, work) => this.enqueueOp(tabId, "hibernate", work),
      /** An active goal, a live continuation, or a running worker keeps the child's loop alive (#381, #683). */
      preventsHibernation: (tabId) =>
        this.goals.preventsHibernation(tabId) || this.vibes.preventsHibernation(tabId),
    });
    this.planGates = new PlanGateTracker({
      registry: deps.registry,
      broadcast: () => this.deps.broadcast(),
      attention: deps.attention,
      suspendForVerdict: (tabId) => this.hibernation.suspendForVerdict(tabId),
    });
    this.planPreflight = new PlanPreflightController({
      registry: deps.registry,
      getSessionsRoot: deps.getSessionsRoot,
      readPlanFile: (root, absPath) => readConfinedPlanFile(root, absPath),
      verify:
        deps.planVerify ??
        (async () => ({
          status: "unavailable" as const,
          diagnostics: [
            {
              code: "VERIFIER_UNAVAILABLE" as const,
              stage: "service" as const,
              repair: "application" as const,
              severity: "error" as const,
              message: "no plan verifier is wired into this session manager",
            },
          ],
        })),
      getThemeId: () => deps.registry.getSetting("themeId") ?? "",
      sendToLive: (entry, frame) => {
        if (entry.kind === "rpc-ui") entry.rpc?.send(frame);
      },
      deliver: (tabId, frame, entry) => this.deliverFrame(tabId, frame, entry),
      onHoldReleased: (tabId) => {
        // §5.7: a hold that ends internally rebases the stall clock — the
        // latch is cleared BEFORE this check, so the transition cannot be lost.
        if (!this.awaitingHumanAnswer(tabId)) this.stallWatchdog.humanAnswered(tabId);
      },
    });
    this.hostBridge = new HostBridge({
      readPlanFile: (root, absPath) => readConfinedPlanFile(root, absPath),
      planSnapshot: (tabId, absPath) => this.planSnapshotFor(tabId, absPath),
      planRoot: (tabId) => {
        const record = deps.registry.sessions.find((session) => session.tabId === tabId);
        return record === undefined ? null : path.resolve(deps.getSessionsRoot(), record.lineageDir);
      },
      notify: (tabId, title, message) =>
        deps.hostNotify?.(tabId, title, message) ?? "notifications are disabled in Settings",
      capabilitySessionId: (tabId) => {
        const entry = this.live.get(tabId);
        return entry?.kind === "rpc-ui" ? entry.capabilities?.sessionId ?? null : null;
      },
      log: (message) => console.warn(`[host-bridge] ${message}`),
      vault: {
        context: (tabId) => {
          const record = deps.registry.sessions.find((session) => session.tabId === tabId);
          if (record === undefined) return null;
          const project = deps.registry.projects.find((candidate) => candidate.path === record.projectCwd);
          return {
            projectName: project?.name ?? null,
            projectFolder:
              this.vaultFolders.get(record.projectCwd) ??
              (project === undefined ? projectSlug(record.projectCwd) : slugifyProjectName(project.name)),
            pinnedVault: project?.knowledgeHome?.vault ?? null,
            lineage: record.lineageDir.slice(-36),
          };
        },
        registry: () => deps.registry.getSetting("vaultRegistry"),
        guard: () => ({
          home: os.homedir(),
          userData: path.dirname(deps.registryFile),
          agentDir: getOmpAgentDir(),
          sessionsRoot: deps.getSessionsRoot(),
          archiveRoot: deps.getArchiveRoot(),
        }),
        obsidianList: () => this.obsidianList(),
        appVersion: deps.appVersion ?? "unknown",
        now: () => new Date(),
        mainLog: (line) => deps.mainLog?.(line),
      },
      sessions: {
        records: () => deps.registry.sessions,
        projects: () => deps.registry.projects,
        locate: (lineageDir, sessionId) =>
          resolveSessionLocation(deps.getSessionsRoot(), deps.getArchiveRoot(), lineageDir, sessionId),
        now: () => new Date(),
      },
    });
    this.stallWatchdog = new StallWatchdog({
      registry: deps.registry,
      send: deps.send,
      broadcast: () => deps.broadcast(),
      turns: this.turns,
      getLive: (tabId) => this.live.get(tabId),
      liveEntries: () => this.live,
      awaitingHumanAnswer: (tabId) => this.awaitingHumanAnswer(tabId),
    });
    this.toolControl = new CapabilityControlTracker({
      registry: deps.registry,
      getLive: (tabId) => this.live.get(tabId),
    });
    this.goals = new GoalStatusTracker({ broadcast: () => this.deps.broadcast() });
    this.vibes = new VibeStatusTracker({ broadcast: () => this.deps.broadcast() });
    this.autoresearch = new AutoresearchStatusTracker({ broadcast: () => this.deps.broadcast() });
    this.frameObservers = [
      this.hibernation,
      this.planGates,
      this.planPreflight,
      this.stallWatchdog,
      this.toolControl,
      this.goals,
      this.vibes,
      this.autoresearch,
      this.dialogGates,
    ];
    this.collab = new CollabTracker({
      getOmpPath: deps.getOmpPath,
      livePtyEntries: () =>
        [...this.live.entries()].flatMap(([tabId, entry]) =>
          entry.kind === "pty" ? [{ tabId, pid: entry.pty.pid }] : [],
        ),
      writePty: (tabId, data) => this.ptyWrite(tabId, data),
      send: deps.send,
      cli: deps.collabCli,
    });
  }

  private obsidianList(): Promise<ObsidianListEntry[]> {
    if (this.obsidianListPending !== null) return this.obsidianListPending;
    const now = Date.now();
    if (this.obsidianListCached !== null && now < this.obsidianListExpiresAt) {
      return Promise.resolve(this.obsidianListCached);
    }
    this.obsidianListExpiresAt = now + 5_000;
    this.obsidianListCached = null;
    this.obsidianListPending = findObsidianList(process.env, process.platform, os.homedir()).then(
      (found) => {
        this.obsidianListCached = found?.vaults ?? [];
        this.obsidianListPending = null;
        return this.obsidianListCached;
      },
      (err: unknown) => {
        this.obsidianListCached = null;
        this.obsidianListPending = null;
        this.obsidianListExpiresAt = 0;
        throw err;
      },
    );
    return this.obsidianListPending;
  }

  /** The browser clock follows the tab's project (see CONTEXT.md "Browser clock"). */
  private browserClockEnabled(tabId: string): boolean {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (record === undefined) return false;
    return this.deps.registry.projects.find((p) => p.path === record.projectCwd)?.browserClock === true;
  }

  get liveCount(): number {
    return this.live.size;
  }

  isLive(tabId: string): boolean {
    return this.live.has(tabId);
  }

  hasLiveInProject(projectCwd: string): boolean {
    for (const entry of this.live.values()) {
      if (entry.record.projectCwd === projectCwd) return true;
    }
    return false;
  }

  async hydrateAll(): Promise<void> {
    this.watcherHub.startAll(this.deps.registry.sessions);
    await this.deps.broadcast();
  }

  stopProjectWatchers(projectCwd: string): void {
    this.watcherHub.stopForProject(projectCwd);
  }

  killAll(): void {
    // A quit is not a session death: announcing these exits would mark every
    // tab exited in a still-attached renderer and persist an empty desktop
    // view, so the update relaunch would restore nothing (issue #99).
    for (const entry of this.live.values()) {
      entry.suppressExit = true;
      this.killLive(entry);
    }
    this.live.clear();
    this.collab.dispose();
    this.shellHost.killAll();
    this.browserPanes.disposeAll();
    this.watcherHub.disposeAll();
    this.hibernation.disposeAll();
    this.stallWatchdog.disposeAll();
    this.toolControl.disposeAll();
    this.planPreflight.clearAll();
  }

  private killLive(entry: LiveEntry): void {
    switch (entry.kind) {
      case "pty": {
        const detachPtyData = entry.detachPtyData;
        entry.detachPtyData = NOOP_DETACH_PTY_DATA;
        detachPtyData();
        entry.pty.kill();
        return;
      }
      case "rpc-ui":
        entry.rpc?.kill();
        return;
      default:
        unreachableLiveEntry(entry);
    }
  }

  private handleExit(tabId: string, entry: LiveEntry, exitCode: number): void {
    entry.markExited();
    if (this.live.get(tabId) === entry) {
      this.live.delete(tabId);
      this.turns.clear(tabId);
      for (const obs of this.frameObservers) obs.onExit(tabId);
      this.collab.noteLiveChange();
      this.deps.attention?.sessionExit(tabId);
      this.hostBridge.forget(tabId);
    }
    if (!entry.suppressExit) {
      this.deps.send(CH.onPtyExit, tabId, exitCode);
      this.deps.breadcrumb?.record("session-exit", { tabId, detail: `code=${exitCode}` });
    }
    void this.deps.broadcast();
  }

  private async reapWithEscalation(entry: LiveEntry): Promise<boolean> {
    this.killLive(entry);
    if (await settledWithin(entry.exited, GRACEFUL_EXIT_MS)) return true;
    switch (entry.kind) {
      case "pty":
        entry.pty.kill("SIGKILL");
        break;
      case "rpc-ui":
        entry.rpc?.kill("SIGKILL");
        break;
      default:
        unreachableLiveEntry(entry);
    }
    if (await settledWithin(entry.exited, SIGKILL_EXIT_MS)) return true;
    return false;
  }

  private async escalateOnTerminate(tabId: string, entry: LiveEntry): Promise<void> {
    if (await this.reapWithEscalation(entry)) return;
    console.warn(
      `[sessions] ${tabId}: child survived SIGKILL (uninterruptible sleep?) — ` +
        `its fds stay open until it dies`,
    );
  }

  private validateSpawnSemantics(req: SpawnRequest): void {
    if (req.origin === "resume") return;

    const snapshot = req.planImplementationSource ?? null;
    if (snapshot !== null) {
      if (req.mode !== "rpc-ui") {
        throw new Error("a plan implementation source requires rpc-ui mode");
      }
      const source = this.deps.registry.sessions.find(
        (record) => record.tabId === snapshot.sourceTabId,
      );
      if (!source) throw new Error(`unknown plan source tab ${snapshot.sourceTabId}`);
      if (source.projectCwd !== req.projectCwd) {
        throw new Error("a plan implementation source must belong to the same project");
      }
      if (source.mode !== "rpc-ui") {
        throw new Error("a plan implementation source must use rpc-ui mode");
      }
    }

    if ((req.experiment ?? null) !== null && req.mode !== "rpc-ui") {
      throw new Error("an experiment requires rpc-ui mode");
    }

    if (req.worktree !== null && "reuse" in req.worktree) {
      const reuse = req.worktree.reuse;
      if (!isWithin(this.deps.getWorktreesRoot(), reuse.path) || !fs.existsSync(reuse.path)) {
        throw new Error(
          "the planning session's worktree checkout is gone — delete the planning session from the sidebar",
        );
      }
    }
  }

  private pendingOp(tabId: string): { kind: OpKind; chain: Promise<void> } | undefined {
    return this.ops.get(tabId);
  }

  private enqueueOp<T>(tabId: string, kind: OpKind, work: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(tabId)?.chain;
    const run: Promise<T> = prev === undefined ? work() : prev.then(() => work());
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.ops.set(tabId, { kind, chain });
    void chain.then(() => {
      if (this.ops.get(tabId)?.chain === chain) this.ops.delete(tabId);
    });
    return run;
  }


  async spawn(req: SpawnRequest): Promise<{ tabId: string }> {
    // Recorded before validateSpawnSemantics so even a rejected or stalled
    // attempt leaves a trace (issue #789): today only success lands a line,
    // so a hung spawn reads as if nothing was ever tried. Ids only in the
    // detail — never prompt text.
    this.deps.breadcrumb?.record("spawn-attempt", {
      detail:
        req.origin === "new"
          ? `origin=new mode=${req.mode} project=${req.projectCwd}`
          : `origin=resume mode=${req.mode ?? "unset"} tab=${req.resumeTabId}`,
    });
    this.validateSpawnSemantics(req);
    if (req.origin === "new") return this.spawnInner(req);
    const tabId = req.resumeTabId;
    const pending = this.pendingOp(tabId);
    if (pending?.kind === "spawn") return { tabId };
    if (pending === undefined && this.live.has(tabId)) return { tabId };
    return this.enqueueOp(tabId, "spawn", () => this.spawnInner(req));
  }

  private async spawnInner(req: SpawnRequest): Promise<{ tabId: string }> {
    const ompPath = this.requireOmpPath();
    if (
      req.origin === "new" &&
      !this.deps.providerKeys.hasModelProvider(req.projectCwd) &&
      !(this.deps.hasOAuthProvider?.() ?? false)
    ) {
      throw new Error(
        "No model provider is configured. Add an API key or sign in to a provider under Settings → Providers before starting a session.",
      );
    }

    const fresh = req.origin === "new";
    let freshTabId: string | undefined;
    let projectCwd: string | undefined;
    let mintedWorktree: SessionWorktree | null = null;
    let record: OwnedSessionRecord | undefined;
    try {
      if (req.origin === "resume") {
        if (this.live.has(req.resumeTabId)) return { tabId: req.resumeTabId };
        const existing = this.deps.registry.sessions.find((s) => s.tabId === req.resumeTabId);
        if (!existing) throw new Error(`unknown session tab ${req.resumeTabId}`);
        projectCwd = existing.projectCwd;
        record = await prepareResumeRecord(existing, {
          sessionsRoot: this.deps.getSessionsRoot(),
          archiveRoot: this.deps.getArchiveRoot(),
          updateSession: (tabId, patch) => this.deps.registry.updateSession(tabId, patch),
        });
      } else {
        projectCwd = req.projectCwd;
        freshTabId = randomUUID();
        const preparedWorktree = await this.worktreeOps.prepareSpawn(
          req.projectCwd,
          req.worktree,
        );
        const worktree = preparedWorktree.worktree;
        mintedWorktree = preparedWorktree.minted;
        const project = this.deps.registry.projects.find((p) => p.path === req.projectCwd);
        record = this.deps.registry.addSession({
          tabId: freshTabId,
          sessionId: null,
          lineageDir: mintLineageDirName(req.projectCwd),
          projectCwd: req.projectCwd,
          worktree,
          planImplementationSource:
            req.planImplementationSource == null
              ? null
              : { ...req.planImplementationSource },
          experiment: req.experiment == null ? null : { ...req.experiment },
          launchedAt: new Date().toISOString(),
          mode: req.mode,
          agentMode: "build",
          compactionMethod:
            req.mode === "rpc-ui" ? this.deps.registry.getSetting("defaultCompactionMethod") : null,
          approvalMode: null,
          serviceTier: null,
          model: project?.defaultModel ?? project?.lastModel ?? null,
          thinkingLevel:
            project?.lastThinkingLevel ??
            (this.deps.registry.getSetting("defaultAutoThinking") ? "auto" : null),
          advisor: req.advisor,
          advisorModel: req.advisorModel ?? null,
          subagentModels: null,
          proposedPlans: [],
          cachedTitle: null,
          cachedModified: null,
        });
        this.deps.registry.setSessionAdvisor(record.tabId, record.advisor, record.advisorModel);
      }

      const mode = req.origin === "resume" ? (req.mode ?? record.mode) : req.mode;
      if (req.origin === "resume") {
        const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
        if (record.mode !== mode) patch.mode = mode;
        if (req.advisor !== undefined && req.advisor !== record.advisor) {
          patch.advisor = req.advisor;
        }
        if (req.advisorModel !== undefined && req.advisorModel !== record.advisorModel) {
          patch.advisorModel = req.advisorModel;
        }
        // The recovery pick (issue #774): the chip and the next hibernate
        // wake must agree with what relaunched. The transcript gains its
        // model_change from the initial set_model command (spawnRpc), not
        // from --model itself, which never rewrites the file.
        if (req.model !== undefined && req.model !== record.model) patch.model = req.model;
        if (Object.keys(patch).length > 0) {
          record = this.deps.registry.updateSession(record.tabId, patch) ?? record;
        }
      }
      const planMode =
        req.planMode ??
        (fresh
          ? this.deps.registry.getSetting("defaultAgentMode") === "plan"
          : record.agentMode === "plan");
      const result =
        mode === "rpc-ui"
          ? await this.spawnRpc(record, planMode, ompPath, req.origin === "resume" ? req.model : undefined)
          : await this.spawnPty(record, req, ompPath);
      this.deps.breadcrumb?.record(
        req.origin === "new" ? "session-spawn" : "session-resume",
        { tabId: record.tabId, mode },
      );
      return result;
    } catch (cause) {
      const rollbackTabId = record?.tabId ?? freshTabId ?? (req.origin === "resume" ? req.resumeTabId : undefined);
      if (!rollbackTabId || projectCwd === undefined || (!record && !mintedWorktree)) throw cause;
      return this.rollbackSpawn(rollbackTabId, projectCwd, fresh, mintedWorktree, cause);
    }
  }

  private async rollbackSpawn(
    tabId: string,
    projectCwd: string,
    fresh: boolean,
    mintedWorktree: SessionWorktree | null,
    cause: unknown,
  ): Promise<never> {
    const failures: Array<{ step: string; error: unknown }> = [];
    const fail = (step: string, error: unknown): void => { failures.push({ step, error }); };
    const entry = this.live.get(tabId);
    let childStopped = true;
    if (entry) {
      try {
        await this.killAndReap(tabId, entry);
      } catch (error) {
        childStopped = false;
        fail("stop spawned child", error);
      }
    }
    if (childStopped) {
      let watcherStopped = true;
      try {
        this.watcherHub.stop(tabId);
      } catch (error) {
        watcherStopped = false;
        fail("stop lineage watcher", error);
      }
      if (watcherStopped) {
        this.stallWatchdog.dispose(tabId);
        this.hibernation.dispose(tabId);
        this.planPreflight.dispose(tabId);
        if (fresh) {
          const freshRecord = this.deps.registry.sessions.find(
            (session) => session.tabId === tabId,
          );
          if (freshRecord) {
            try {
              this.deps.registry.removeSession(tabId);
            } catch (error) {
              fail("remove spawned session record", error);
            }
            try {
              await deleteSessionFiles(
                this.deps.getSessionsRoot(),
                this.deps.getArchiveRoot(),
                freshRecord.lineageDir,
              );
            } catch (error) {
              fail("remove spawned lineage files", error);
            }
          }
          if (
            mintedWorktree &&
            !this.deps.registry.sessions.some((session) => session.tabId === tabId)
          ) {
            const [cleanup] = await this.worktreeOps.reclaim([
              { projectCwd, worktree: mintedWorktree },
            ]);
            if (
              !cleanup ||
              cleanup.checkoutKept !== null ||
              (cleanup.branchOutcome !== "removed" &&
                cleanup.branchOutcome !== "already-gone")
            ) {
              const outcome = cleanup
                ? `checkout ${cleanup.checkoutKept ?? "removed"}; branch ${cleanup.branchOutcome}`
                : "no cleanup outcome";
              fail("reclaim minted worktree", new Error(outcome));
            }
          }
        } else {
          const existing = this.deps.registry.sessions.find((session) => session.tabId === tabId);
          if (existing) {
            try {
              this.watcherHub.start(existing);
            } catch (error) {
              fail("restore lineage watcher", error);
            }
          }
        }
      }
    }
    if (failures.length === 0) throw cause;
    const originalMessage = cause instanceof Error ? cause.message : String(cause);
    const detail = failures
      .map(({ step, error }) => `${step}: ${error instanceof Error ? error.message : String(error)}`)
      .join("; ");
    throw new AggregateError(
      failures.map(({ error }) => error),
      `spawn failed: ${originalMessage}; cleanup failed: ${detail}`,
      { cause },
    );
  }

  /**
   * The registry inputs the subagent overlay needs (ADR-0031), read
   * synchronously so the spawn path never spawns a helper process. The roster
   * is whatever the last settings-surface refresh captured — spawn never
   * enumerates agents itself.
   */
  private subagentSpawnConfig(): SubagentSpawnConfig {
    return {
      inheritByDefault: this.deps.registry.getSetting("subagentModelInheritByDefault"),
      roster: this.deps.registry.getSetting("agentRoster"),
    };
  }

  /**
   * session:setSubagentModels (ADR-0031). The record write, then an in-place
   * rewrite of the session's subagent overlay: omp re-reads the `--config`
   * layer before every subagent spawn, so the change lands at the next spawn
   * with no respawn — unlike the advisor. A session whose lineage dir does
   * not exist yet (lazy materialization) just keeps the choice in the record
   * for its next launch; spawning would create the dir, so nothing is lost.
   */
  setSessionSubagentModels(tabId: string, map: SubagentModelMap | null): void {
    void this.enqueueOp(tabId, "relaunch", async () => {
      this.deps.registry.setSessionSubagentModels(tabId, map);
      const record = this.deps.registry.sessions.find((session) => session.tabId === tabId);
      if (record === undefined) return;
      const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
      if (fs.existsSync(absLineageDir)) {
        const config = this.subagentSpawnConfig();
        try {
          writeSubagentModelOverlay(
            absLineageDir,
            resolveSubagentOverlayEntries(map, config.inheritByDefault, config.roster),
          );
        } catch (err) {
          console.warn("[subagents] could not rewrite the overlay:", err);
        }
      }
      await this.deps.broadcast();
    });
  }

  private async spawnPty(
    record: OwnedSessionRecord,
    req: SpawnRequest,
    ompPath: string,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    if (record.worktree !== null) {
      await linkProjectOmpDir(record.projectCwd, record.worktree.path);
    }
    const ptyHandle = spawnOmp({
      id: record.tabId,
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      model: gateSelector(this.gate) ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: writeSessionOverlays(record, absLineageDir, this.gate, this.subagentSpawnConfig()),
    });
    const entry = createPtyLiveEntry(record, ptyHandle);
    this.live.set(record.tabId, entry);
    this.collab.noteLiveChange();
    wirePtyData(entry, ptyHandle, (data) =>
      this.deps.send(CH.onPtyData, record.tabId, data),
    );
    ptyHandle.onExit(({ exitCode }) => this.handleExit(record.tabId, entry, exitCode));
    this.watcherHub.start(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
  }

  private async spawnRpc(
    record: OwnedSessionRecord,
    planMode: boolean,
    ompPath: string,
    modelOverride?: string,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    const entry = createRpcLiveEntry(record);
    const { paths: extensions, loaded: bridgeLoaded } = writeRpcExtensions(
      absLineageDir,
      this.deps.registry.getSetting("experimentsEnabled"),
    );
    entry.planBridgeLoaded = bridgeLoaded.plan;
    entry.advisorStatsBridgeLoaded = bridgeLoaded.advisorStats;
    entry.capabilitiesBridgeLoaded = bridgeLoaded.capabilities;
    // The bridge listener outlives the process: a relaunch under the same tab
    // reuses the endpoint, so the agent's remembered URL stays valid (#519).
    const cdpUrl = bridgeLoaded.browserPane ? await this.browserPanes.ensureEndpoint(record.tabId) : null;
    entry.browserPaneArmed = cdpUrl !== null;
    // The registration commands ride at the tail: like every initialCommand
    // they land before the first turn either way, but the host tool/scheme
    // registration must never precede a bridge arm that could turn first.
    const initialCommands: object[] = [];
    const vaults = this.deps.registry.getSetting("vaultRegistry");
    if (bridgeLoaded.mcpStatus) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-mcp-${randomUUID()}`,
        message: mcpRuntimeStatusMessage(),
      });
    }
    // The vibe bridge arms before the plan command: its restore reads omp's
    // native goal state before re-arming a saved vibe mode, and a plan command
    // must never run against an unrestored mode slot.
    if (bridgeLoaded.vibe) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-vibe-${randomUUID()}`,
        message: vibeArmMessage(),
      });
    }
    if (bridgeLoaded.plan) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-mode-${randomUUID()}`,
        message: planMessage(planMode, this.deps.registry.getSetting("planFormat")),
      });
    }
    if (bridgeLoaded.capabilities) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-capabilities-${randomUUID()}`,
        message: capabilitiesMessage(),
      });
    }
    if (cdpUrl !== null) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-browser-pane-${randomUUID()}`,
        message: browserPaneSetMessage(cdpUrl),
      });
    }
    // The vault project folder (#787): resolved once per rpc launch beside the
    // Knowledge-home resolve — every launch (fresh, resume, relaunch) re-enters
    // here, so a changed remote takes effect on the next launch. Independent of
    // bridgeLoaded.knowledgeVault: the vault tools register on registry
    // non-emptiness alone, so a docs-home project can still be handed them.
    if (vaults.vaults.length > 0) {
      const folderProject = this.deps.registry.projects.find(
        (project) => project.path === record.projectCwd,
      );
      const resolveFolder = this.deps.vaultFolder ?? resolveVaultProjectFolder;
      this.vaultFolders.set(
        record.projectCwd,
        await resolveFolder(
          folderProject?.name ?? path.basename(record.projectCwd),
          record.projectCwd,
        ),
      );
    }
    // The Knowledge home's hidden guidance (#766, #768, ADR-0048), sent once per
    // spawn, so a change reaches the next spawn. With no vault registered the
    // message has nothing to say: there is no write part and no day part, so no git runs.
    if (bridgeLoaded.knowledgeVault && vaults.vaults.length > 0) {
      const homeProject = this.deps.registry.projects.find((project) => project.path === record.projectCwd);
      const resolved = await resolveKnowledgeHome(homeProject?.knowledgeHome ?? null, record.projectCwd, vaults);
      const guidance = knowledgeVaultGuidance({
        write:
          resolved.kind === "vault" || resolved.kind === "both"
            ? { vault: resolved.vault, both: resolved.kind === "both" }
            : null,
        // The enclosing guard is "a vault is registered" (#760): every native session gets the day part.
        dayWriteUp: true,
      });
      if (guidance !== null) {
        initialCommands.push({
          type: "prompt",
          id: `omp-ui-initial-knowledge-vault-${randomUUID()}`,
          message: knowledgeVaultArmMessage(guidance),
        });
      }
    }
    if (bridgeLoaded.autoresearch) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-autoresearch-${randomUUID()}`,
        message: autoresearchArmMessage(),
      });
    }
    // The session's fast-mode tier (issue #719): a fresh spawn replays
    // `priority` through the set_fast_mode object-command and an ultrafast
    // selection through the `/fast ultra` slash prompt — the same
    // initialCommands rail the plan-mode and browser-pane arms ride. A
    // same-value re-set against a resume-restored entry is idempotent.
    if (record.serviceTier !== null) {
      initialCommands.push(
        record.serviceTier === "ultrafast"
          ? { type: "prompt", id: `omp-ui-initial-tier-${randomUUID()}`, message: "/fast ultra" }
          : { type: "set_fast_mode", id: `omp-ui-initial-tier-${randomUUID()}`, enabled: true },
      );
    }
    // Delta negotiation (issue #718): the runtime strips the accumulated
    // message snapshot from message_update frames when it honours this.
    // Riding initialCommands puts it before the first turn on fresh spawn
    // and hibernate-resume alike — the ADR-0043 registration guarantee.
    initialCommands.push(
      setEventFilterCommand(),
      setHostUriSchemesCommand(),
      setHostToolsCommand({ vault: vaults.vaults.length > 0 }),
    );
    // The issue #774 recovery pick: `--model` forces the boot but never
    // rewrites the transcript, so the same initialCommands rail restates the
    // model through `set_model` — the entry it appends is what a later
    // hibernate wake restores from. Skipped when the gate pins the process:
    // the gate owns the model there, exactly as it wins in the opts below.
    if (modelOverride !== undefined && gateSelector(this.gate) === null) {
      const slash = modelOverride.indexOf("/");
      if (slash > 0) {
        initialCommands.push({
          type: "set_model",
          id: `omp-ui-initial-model-${randomUUID()}`,
          provider: modelOverride.slice(0, slash),
          modelId: modelOverride.slice(slash + 1),
        });
      }
    }
    const configOverlays = await writeRpcOverlays(record, absLineageDir, ompPath, this.gate, this.subagentSpawnConfig());
    if (record.worktree !== null) {
      await linkProjectOmpDir(record.projectCwd, record.worktree.path);
    }
    // The roster is app state now (issue #738): the project record's document
    // (null = global/default), resolved at snapshot time. Worktrees no longer
    // matter — there is no project file to reach through the link. Every rpc
    // launch (fresh, resume, restart) refreshes it.
    if (bridgeLoaded.review) {
      // The reviewer roster needs the batch task tool and async job delivery
      // even when the user's global config turned either off (ADR-0047);
      // restating omp's rpc defaults is idempotent. Written only while the
      // experiments flag loaded the bridge — flag off leaves no review
      // artifact in the lineage dir.
      configOverlays.push(writeReviewOverlay(absLineageDir));
      const projectRecord = this.deps.registry.projects.find(
        (project) => project.path === record.projectCwd,
      );
      await writeReviewRosterForSpawn(
        absLineageDir,
        this.deps.registry.getSetting("reviewRoster"),
        projectRecord?.reviewRoster ?? null,
      );
    }
    // One-shot watcher (issue #718): when the runtime rejects the delta
    // negotiation — or echoes full mode — the spawn streams full snapshots
    // instead. Silent-by-design fallback, loud once for the logs.
    let eventFilterWarned = false;
    const rpc = new RpcClient({
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      // The dev/test spawn gate keeps winning over the recovery pick, exactly
      // as it wins over the record everywhere else.
      model: gateSelector(this.gate) ?? modelOverride ?? undefined,
      advisor: record.advisor,
      configOverlays,
      extensions,
      initialCommands,
      onInputFrame: (frame) => {
        // Host traffic is answered on the input-order seam BEFORE delivery:
        // the ownership mark must exist before the renderer's stub can answer
        // (see HostBridge#track). A killed spawn must not answer through its
        // successor's pipe — identity first, same fence as every capture.
        if (this.live.get(record.tabId) !== entry) return;
        this.hostBridge.route(record.tabId, frame, (answer) => rpc.send(answer));
      },
      onFrame: (frame) => {
        if (this.live.get(record.tabId) === entry) this.hostBridge.noteFrame(record.tabId, frame);
        const control = normalizeControlFrame(frame);
        if (
          !eventFilterWarned &&
          control?.kind === "response" &&
          control.id === EVENT_FILTER_COMMAND_ID
        ) {
          eventFilterWarned = true;
          const data = isObject(control.data) ? control.data : undefined;
          if (control.success !== true || !eventFilterEchoIsDelta(data)) {
            console.warn(
              `[session-manager] ${record.tabId}: runtime kept messageUpdates in full ` +
                `mode (message_update snapshots stay full-size) — delta unsupported`,
            );
          }
        }
        if (
          control !== null &&
          control.kind === "ext_request" &&
          control.method === "setStatus" &&
          control.frame.statusKey === CAPABILITIES_STATUS_KEY
        ) {
          const snapshot = parseCapabilitySnapshot(
            typeof control.frame.statusText === "string" ? control.frame.statusText : undefined,
          );
          // A malformed roster never masquerades as an empty one: drop it and
          // keep the last good snapshot the bridge published.
          if (snapshot === null) return;
          // A killed spawn must not publish into its successor's tab: identity
          // is decided before any capability state is accepted.
          if (this.live.get(record.tabId) !== entry) return;
          entry.capabilities = snapshot;
          this.toolControl.observe(record.tabId, snapshot, entry);
        }
        // §5: claim an HTML plan select BEFORE observers and the client
        // broadcast — no pendingPlan, plan card, dialog, notification, or
        // awaiting-user badge may exist while validation runs. Identity is
        // checked against THIS entry, never a successor's.
        if (
          entry.kind === "rpc-ui" &&
          this.live.get(record.tabId) === entry &&
          this.planPreflight.claimFrame(record.tabId, frame, entry)
        ) {
          return;
        }
        this.deliverFrame(record.tabId, frame, entry);
      },
      onExit: (code) => this.handleExit(record.tabId, entry, code ?? -1),
      onError: (msg) => {
        // A dead spawn never stamps its successor's tab (the same identity
        // fence every other callback here carries; callbacks only fire off
        // the event loop, after this.live.set below).
        if (this.live.get(record.tabId) !== entry) return;
        // Issue #774: a resume whose saved model is gone dies before its
        // first frame; the selector rides to the renderer so the failure
        // surface can offer the model picker.
        const failed = MODEL_RESTORE_RE.exec(msg);
        this.deps.send(CH.onRpcFrame, record.tabId, {
          type: "omp_ui_error",
          message: msg,
          ...(failed !== null ? { failedModel: failed[1] } : {}),
        });
      },
    });
    wireRpc(entry, rpc);
    this.live.set(record.tabId, entry);
    this.watcherHub.start(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
  }

  /** The observer fan-out + client broadcast tail of `onFrame` (§5.3). */
  private deliverFrame(tabId: string, frame: RpcFrame, entry: LiveEntry): void {
    const before = this.pendingAnswer(tabId);
    const gateBefore = this.planGates.pending(tabId);
    for (const obs of this.frameObservers) obs.onFrame(tabId, frame, entry);
    this.publishAnswerEdge(tabId, before, gateBefore);
    this.deps.send(CH.onRpcFrame, tabId, frame);
  }

  async setSessionAdvisor(
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) return;
      const changed = record.advisor !== advisor || record.advisorModel !== advisorModel;
      this.deps.registry.setSessionAdvisor(tabId, advisor, advisorModel);
      if (!changed) {
        await this.deps.broadcast();
        return;
      }
      const entry = this.live.get(tabId);
      if (!entry) {
        await this.deps.broadcast();
        return;
      }
      await this.relaunch(entry, {
        origin: "resume",
        resumeTabId: tabId,
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
      });
    });
  }

  /**
   * Pins a session's approval mode (issue #681, ADR-0038) and relaunches it
   * with `--resume` when live: omp binds `tools.approvalMode` at process
   * start, and the new spawn re-reads the persisted record (whose overlay
   * `writeSessionOverlays` rewrites), so the resume request carries no key.
   */
  async setSessionApprovalMode(tabId: string, mode: ApprovalMode | null): Promise<void> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) return;
      const changed = record.approvalMode !== mode;
      this.deps.registry.setSessionApprovalMode(tabId, mode);
      if (!changed) {
        await this.deps.broadcast();
        return;
      }
      const entry = this.live.get(tabId);
      if (!entry) {
        await this.deps.broadcast();
        return;
      }
      await this.relaunch(entry, {
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
      });
    });
  }

  /**
   * Pins the tier this session's fast selection names (issue #719). No
   * relaunch either way: an off→tier selection replays through the next
   * spawn's initialCommands; tier→off disables live through set_fast_mode
   * in the renderer; a same-spawn tier→tier change rides the next replay.
   */
  async setSessionServiceTier(tabId: string, tier: ServiceTier | null): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    this.deps.registry.setSessionServiceTier(tabId, tier);
    await this.deps.broadcast();
  }

  /**
   * The capabilities viewer's read path (issue #374). Never rejects: the tab's
   * lifecycle maps onto the discriminated result the renderer renders as-is.
   */
  async getSessionCapabilities(
    tabId: string,
  ): Promise<SessionCapabilitiesResult> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return { status: "missing-session" };
    const entry = this.live.get(tabId);
    if (!entry) return { status: "not-live" };
    if (entry.kind === "pty") return { status: "terminal" };
    if (!entry.capabilitiesBridgeLoaded) return { status: "bridge-unavailable" };
    if (entry.capabilities === null) return { status: "starting" };
    return { status: "available", snapshot: entry.capabilities };
  }

  /**
   * The browser pane's open path (#519): the tab's lifecycle answers the head
   * of the ladder here; the host answers the tail (page creation).
   */
  async browserPaneEnsure(tabId: string): Promise<BrowserPaneEnsureResult> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return { status: "missing-session" };
    const entry = this.live.get(tabId);
    if (!entry) return { status: "not-live" };
    if (entry.kind === "pty") return { status: "terminal" };
    return this.browserPanes.ensure(tabId);
  }

  /**
   * The capabilities viewer's tool toggle (issue #379): one deliberate
   * enable/disable of one registered tool inside one pinned live session. It
   * writes no config, restarts nothing, and prompts the model never — OMP's
   * published snapshot is the only authority on whether it landed.
   *
   * The lifecycle verdicts mirror {@link getSessionCapabilities}, and the
   * identity check is stricter than the read path: `processKey`/`sessionId` are
   * what the viewer saw, so a successor under the same tabId answers `stale`
   * instead of quietly mutating the new process.
   */
  async setSessionToolEnabled(
    tabId: string,
    processKey: string,
    sessionId: string | null,
    name: string,
    enabled: boolean,
  ): Promise<SetSessionToolEnabledResult> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return { status: "missing-session" };
    const entry = this.live.get(tabId);
    if (!entry) return { status: "not-live" };
    if (entry.kind === "pty") return { status: "terminal" };
    if (entry.rpc === null) return { status: "not-live" };
    if (!entry.capabilitiesBridgeLoaded) return { status: "bridge-unavailable" };
    const snapshot = entry.capabilities;
    if (snapshot === null) return { status: "starting" };
    if (snapshot.processKey !== processKey || snapshot.sessionId !== sessionId) {
      return { status: "stale" };
    }
    // Refused outright, never queued: a toggle that fires behind a running
    // turn, an unanswered question, or another operation could land in a state
    // nobody asked about. The same holds for a second concurrent toggle.
    if (this.toolControl.isPending(tabId)) return { status: "busy" };
    if (this.turns.isRunning(tabId)) return { status: "busy" };
    if (this.awaitingHumanAnswer(tabId)) return { status: "busy" };
    if (this.pendingOp(tabId)) return { status: "busy" };

    const request: CapabilityToolMutationRequest = {
      id: randomUUID(),
      processKey: snapshot.processKey,
      sessionId: snapshot.sessionId,
      name,
      enabled,
      expiresAt: Date.now() + TOOL_MUTATION_TTL_MS,
    };
    // The op is registered before the frame leaves and held until the wait
    // settles, so any lifecycle op requested afterwards serializes behind it.
    return this.enqueueOp(
      tabId,
      "tool",
      () =>
        new Promise<SetSessionToolEnabledResult>((resolve) => {
          this.toolControl.track(tabId, request, entry, (result) => {
            // Identity is re-checked on the one success path: OMP's snapshot,
            // not our optimism, is what proves the toggle landed.
            if (result.status === "applied" && this.live.get(tabId) !== entry) {
              resolve({ status: "not-live" });
              return;
            }
            resolve(result);
          });
          this.rpcSend(tabId, {
            type: "prompt",
            id: `omp-ui-capabilities-tool-${randomUUID()}`,
            message: capabilityToolMutationMessage(request),
          });
        }),
    );
  }

  async restart(tabId: string): Promise<void> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      const entry = this.live.get(tabId);
      if (!record || !entry) throw new Error("session is not live");
      await this.relaunch(entry, {
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
      });
    });
  }

  async convertToWorktree(
    tabId: string,
    branch: string,
    baseRef: string | null,
    baseBranch: string | null,
  ): Promise<void> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      if (record.worktree) throw new Error("session already runs in a worktree");
      // Issue #482: same host recomposition as the spawn mint arm — a
      // payload composed before the listing lands gets its base segment
      // and an explicit start point from git's truth here.
      await this.worktreeOps.convert(
        tabId,
        record.projectCwd,
        branch,
        baseRef,
        baseBranch,
      );
      const entry = this.live.get(tabId);
      if (!entry) {
        await this.deps.broadcast();
        return;
      }
      await this.relaunch(entry, {
        origin: "resume",
        resumeTabId: tabId,
        cols: 80,
        rows: 24,
      });
    });
  }

  async releaseWorktree(
    tabId: string,
    opts: WorktreeReleaseOptions,
  ): Promise<WorktreeReleaseResult> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      const wt = record.worktree;
      if (!wt) throw new Error("session does not run in a worktree");
      // Issue #388: a dirty checkout is never force-removed by a return.
      // Merge-only and keep-branch stay available — those paths do not
      // remove the checkout; the dialog's delete offers the loss explicitly.
      await this.worktreeOps.assertClean(record.projectCwd, wt);
      let cleanup: Pick<WorktreeReleaseResult, "checkoutKept" | "branchOutcome"> = {
        checkoutKept: "failed",
        branchOutcome: "not-attempted",
      };
      // The return lands the project checkout on the branch that now holds the
      // work (#431). Since #385 the destination is chosen, not the checkout's
      // own branch, so a finish that merged into a branch checked out nowhere
      // — a new branch included — used to hand the session back on a branch
      // without that work. Reclaim first: git refuses to delete the branch HEAD
      // is on, and a refused switch must never undo a finished release.
      const switchTarget = opts.checkoutOnReturn ?? null;
      let checkoutSwitch: WorktreeReleaseResult["checkoutSwitch"] = { kind: "none" };
      const demote = async (): Promise<void> => {
        this.killShell(tabId);
        this.deps.registry.updateSession(tabId, { worktree: null });
        cleanup = await this.worktreeOps.reclaimOne(record.projectCwd, wt, {
          keepBranch: opts.keepBranch,
          mergedInto: opts.mergedInto,
        });
        // The session's own branch is the one just deleted or kept by the
        // reclaim; switching onto it would be nonsense either way (#431).
        if (switchTarget !== null && switchTarget !== wt.branch) {
          try {
            await this.worktreeOps.checkout(record.projectCwd, switchTarget);
            checkoutSwitch = { kind: "switched", branch: switchTarget };
          } catch (error) {
            checkoutSwitch = {
              kind: "failed",
              branch: switchTarget,
              error: error instanceof Error ? error.message : String(error),
            };
          }
        }
      };
      const entry = this.live.get(tabId);
      if (!entry) {
        await demote();
        await this.deps.broadcast();
      } else {
        await this.relaunch(
          entry,
          {
            origin: "resume",
            resumeTabId: tabId,
            cols: 80,
            rows: 24,
          },
          demote,
        );
      }
      return {
        worktreePath: wt.path,
        branch: wt.branch,
        projectCwd: record.projectCwd,
        ...cleanup,
        checkoutSwitch,
      };
    });
  }

  /** Merges `source` into the owning session's checkout. */
  async syncWorktree(tabId: string, source: string): Promise<WorktreeSyncResult> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      if (!record.worktree) throw new Error("session does not run in a worktree");
      return this.worktreeOps.sync(record.projectCwd, record.worktree.path, source);
    });
  }

  /** Renames the branch under a live worktree without relaunching it. */
  async renameWorktreeBranch(tabId: string, newName: string): Promise<void> {
    const name = newName.trim();
    if (name === "") throw new Error("branch name must not be empty");
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      const wt = record.worktree;
      if (!wt) throw new Error("session does not run in a worktree");
      await this.worktreeOps.rename(tabId, wt, name);
      await this.deps.broadcast();
    });
  }

  async ptyPasteImage(tabId: string, image: ImageAttachment): Promise<void> {
    const entry = this.live.get(tabId);
    if (entry?.kind !== "pty") throw new Error("session is not running in terminal mode");
    const pty = entry.pty;
    if (base64Bytes(image.data) > MAX_IMAGE_BYTES) {
      throw new Error(`image is over omp's ${MAX_IMAGE_BYTES / (1024 * 1024)} MB input limit`);
    }
    const file = writeImageToScratch(image);
    pty.write(bracketedImagePaste(file));
  }

  /**
   * Materializes PDF Document Attachments on THIS machine — for a joined
   * remote tab the request was routed here by routeByTab, so "this machine"
   * is the remote host (ADR-0044). Returns the scratch paths; the composer
   * composes them into the prompt's attached-documents block.
   */
  async attachDocument(tabId: string, documents: DocumentAttachment[]): Promise<string[]> {
    if (!this.deps.registry.sessions.some((s) => s.tabId === tabId)) {
      throw new Error(`unknown session tab ${tabId}`);
    }
    let batchBytes = 0;
    for (const doc of documents) batchBytes += doc.data === undefined ? 0 : base64Bytes(doc.data);
    if (batchBytes > MAX_DOCUMENT_BATCH_BYTES) {
      throw new Error(
        `attached documents are ${(batchBytes / (1024 * 1024)).toFixed(1)} MB — over the 48 MB batch limit`,
      );
    }
    return documents.map((doc) => resolveDocument(doc));
  }

  async ptyPasteDocument(tabId: string, document: DocumentAttachment): Promise<void> {
    const entry = this.live.get(tabId);
    if (entry?.kind !== "pty") throw new Error("session is not running in terminal mode");
    const pty = entry.pty;
    // One document per paste: same one-anchor-per-paste discipline as images.
    const file = resolveDocument(document);
    pty.write(bracketedImagePaste(file));
  }

  private requireOmpPath(): string {
    const ompPath = this.deps.getOmpPath();
    if (!ompPath) {
      throw new Error(
        "omp binary not found (looked in $OMP_UI_OMP_PATH, PATH, ~/.bun/bin, /usr/local/bin, ~/.local/bin)",
      );
    }
    return ompPath;
  }

  launchShell(
    tabId: string,
    cwd: string,
    cols: number,
    rows: number,
    program: ConsoleProgram = "shell",
  ): void {
    this.shellHost.launch(tabId, cwd, cols, rows, program);
  }
  shellWrite(tabId: string, data: string): void {
    this.shellHost.write(tabId, data);
  }
  shellResize(tabId: string, cols: number, rows: number): void {
    this.shellHost.resize(tabId, cols, rows);
  }
  browserPaneSubscribe(tabId: string, clientId: string, on: boolean): void {
    this.browserPanes.subscribe(tabId, clientId, on);
  }
  browserPaneSetDesktopViewer(tabId: string, clientId: string, on: boolean): void {
    this.browserPanes.setDesktopViewer(tabId, clientId, on);
  }
  browserPaneMediaLease(tabId: string, requesterWebContentsId: number): DesktopMediaLease | null {
    return this.browserPanes.mediaLease(tabId, requesterWebContentsId);
  }
  browserPaneResize(tabId: string, width: number, height: number): void {
    this.browserPanes.resize(tabId, width, height);
  }
  browserPaneInput(tabId: string, event: BrowserPaneInputEvent): void {
    this.browserPanes.input(tabId, event);
  }
  browserPaneSetOpen(tabId: string, open: boolean): void {
    this.browserPanes.setOpen(tabId, open);
  }
  browserPaneNavigate(tabId: string, nav: BrowserPaneNavigate): void {
    this.browserPanes.navigate(tabId, nav);
  }
  browserPanePick(tabId: string, x: number, y: number): Promise<BrowserPanePickResult> {
    return this.browserPanes.pick(tabId, x, y);
  }
  browserPaneDiagnostics(): BrowserPaneDiagnostics[] {
    return this.browserPanes.diagnostics();
  }
  vaultCallCounts(): Record<string, Partial<Record<VaultAction, number>>> {
    return this.hostBridge.vaultCallCounts();
  }
  async browserPaneClearData(force: boolean): Promise<BrowserPaneClearDataResult> {
    const openPages = this.browserPanes.livePageCount();
    if (openPages > 0 && !force) return { status: "busy", openPages };
    await this.browserPanes.clearData();
    return { status: "cleared" };
  }
  /** The remote access server's port joins the ports no pane page may reach (#531). */
  setRemoteAccessPort(port: number | null): void {
    this.browserPanes.setRemoteAccessPort(port);
  }
  ptyWrite(tabId: string, data: string): void {
    const entry = this.live.get(tabId);
    if (!entry) return;
    switch (entry.kind) {
      case "pty":
        entry.pty.write(data);
        return;
      case "rpc-ui":
        return;
      default:
        unreachableLiveEntry(entry);
    }
  }
  ptyResize(tabId: string, cols: number, rows: number): void {
    const entry = this.live.get(tabId);
    if (!entry) return;
    switch (entry.kind) {
      case "pty":
        entry.pty.resize(cols, rows);
        return;
      case "rpc-ui":
        return;
      default:
        unreachableLiveEntry(entry);
    }
  }

  /** The live session's goal state; omp's runtime in the live child owns it (ADR-0046). */
  goalState(tabId: string): GoalState | null | undefined {
    return this.goals.state(tabId);
  }

  /** The live session's vibe snapshot, as its own bridge published it (issue #683). */
  vibeSnapshot(tabId: string): VibeSnapshot | undefined {
    return this.vibes.snapshot(tabId);
  }

  /** The live session's autoresearch snapshot, as its own bridge published it (issue #559). */
  autoresearchSnapshot(tabId: string): AutoresearchSnapshot | undefined {
    return this.autoresearch.snapshot(tabId);
  }

  /** Every live terminal tab's Collab host state (issue #686); `null` is off. */
  collabSnapshots(): CollabTabSnapshot[] {
    return this.collab.snapshots();
  }

  collabShare(tabId: string, access: CollabAccess): Promise<void> {
    return this.collab.share(tabId, access);
  }

  collabStop(tabId: string): void {
    this.collab.stop(tabId);
  }

  collabLink(tabId: string, view: boolean): Promise<string> {
    return this.collab.link(tabId, view);
  }
  bridgeAvailability(
    tabId: string,
  ): { plan: boolean; advisorStats: boolean } | undefined {
    const entry = this.live.get(tabId);
    if (entry?.kind !== "rpc-ui") return undefined;
    return {
      plan: entry.planBridgeLoaded,
      advisorStats: entry.advisorStatsBridgeLoaded,
    };
  }


  planGate(tabId: string): PlanGate | undefined {
    return this.planGates.gate(tabId);
  }

  /** Stops tracking an interrupted plan (ADR-0033). */
  dismissProposedPlan(tabId: string, planFilePath: string): void {
    this.planGates.dismiss(tabId, planFilePath);
  }


  setViewedTab(clientId: string, tabId: string | null): void {
    this.viewTracker.setViewedTab(clientId, tabId);
    this.browserPanes.noteViewed(clientId, tabId);
  }

  noteDesktopClientId(clientId: string): void {
    this.viewTracker.noteDesktopClientId(clientId);
  }

  isViewedInDesktop(tabId: string): boolean {
    return this.viewTracker.isViewedInDesktop(tabId);
  }

  isStreamStalled(tabId: string): boolean {
    return this.stallWatchdog.isStreamStalled(tabId);
  }

  /** True while the live process sits between agent_start and agent_end. */
  isTurnRunning(tabId: string): boolean {
    return this.turns.isRunning(tabId);
  }

  /**
   * The human-answer level published on the session summary: true while the
   * tab holds an answer the client could give now — a pending plan gate or an
   * unanswered blocking dialog. This is the guard union MINUS the plan
   * preflight hold: an in-validation proposal may not surface an awaiting
   * badge (§5, plan-preflight.ts), while the guards keep the full union
   * (issue #436).
   */
  pendingAnswer(tabId: string): boolean {
    return this.planGates.pending(tabId) || this.dialogGates.hasOpen(tabId);
  }

  /** The open blocking dialogs, in arrival order, for the summary (#555). */
  pendingDialogs(tabId: string): RpcFrame[] {
    return this.dialogGates.openFrames(tabId);
  }

  private awaitingHumanAnswer(tabId: string): boolean {
    if (this.planGates.pending(tabId)) return true;
    if (this.planPreflight.isHeld(tabId)) return true;
    return this.dialogGates.hasOpen(tabId);
  }

  /**
   * Publish a pendingAnswer transition through the watcher hub's existing
   * throttle (#434's path). A gate-component transition is skipped: the
   * PlanGateTracker's own direct broadcast already rebuilds the full summary,
   * which carries this field too — one transition, one rebuild.
   */
  private publishAnswerEdge(tabId: string, before: boolean, gateBefore: boolean): void {
    const now = this.pendingAnswer(tabId);
    if (now === before) return;
    if (this.planGates.pending(tabId) !== gateBefore) return;
    this.watcherHub.broadcastPatch(false);
  }

  hibernatePlanSource(sourceTabId: string, implementationTabId: string): Promise<boolean> {
    return this.enqueueOp(sourceTabId, "hibernate", () =>
      this.hibernation.attemptHandoff(sourceTabId, implementationTabId),
    );
  }

  private async hibernate(tabId: string, entry: LiveEntry): Promise<boolean> {
    entry.suppressExit = true;
    if (await this.reapWithEscalation(entry)) {
      // The page goes with the process; the last URL is what a resume restores.
      this.browserPanes.dispose(tabId);
      this.deps.send(CH.onSessionHibernated, tabId);
      this.deps.breadcrumb?.record("session-hibernate", { tabId });
      void this.deps.broadcast();
      return this.live.get(tabId) !== entry;
    }
    entry.suppressExit = false;
    console.warn(`[sessions] ${tabId}: hibernation kill ignored by child; leaving it live`);
    return false;
  }

  rpcSend(tabId: string, cmd: RpcFrame): void {
    // §6: a response aimed at a frame main holds, or at a PENDING HTML gate,
    // is consumed here — only the acknowledged answer path may settle those.
    // Markdown gates and all other extension traffic pass through unchanged.
    const control = normalizeControlFrame(cmd);
    // #688: a host result for a request main already owns (answered,
    // cancelled, or watchdog-settled) is consumed here — the renderer's
    // fallback stub must never double-answer omp.
    if (
      (cmd.type === "host_tool_result" || cmd.type === "host_uri_result") &&
      typeof cmd.id === "string" &&
      this.hostBridge.answeredIds(tabId).has(cmd.id)
    ) {
      return;
    }
    if (control !== null && control.kind === "ext_response" && typeof control.id === "string") {
      if (this.planPreflight.holdsFrame(tabId, control.id)) return;
      const gate = this.planGates.gate(tabId);
      if (
        gate?.pending !== null &&
        gate !== undefined &&
        gate.pending.frameId === control.id &&
        isHtmlPlanPath(gate.pending.planFilePath)
      ) {
        return;
      }
    }
    const wasAwaitingHuman = this.awaitingHumanAnswer(tabId);
    const before = this.pendingAnswer(tabId);
    const gateBefore = this.planGates.pending(tabId);
    for (const obs of this.frameObservers) obs.onSend?.(tabId, cmd);
    if (wasAwaitingHuman && !this.awaitingHumanAnswer(tabId))
      this.stallWatchdog.humanAnswered(tabId);
    this.publishAnswerEdge(tabId, before, gateBefore);
    const entry = this.live.get(tabId);
    if (!entry) return;
    switch (entry.kind) {
      case "rpc-ui":
        entry.rpc?.send(cmd);
        return;
      case "pty":
        return;
      default:
        unreachableLiveEntry(entry);
    }
  }

  /**
   * The acknowledged answer for a plan-review gate (§6). The only path that
   * may settle an HTML gate: verifies the live entry, the gate identity, and
   * — for `execute` — that the artifact still hashes to the validated
   * snapshot. The settle reservation is atomic before the read, so two
   * clients cannot both execute.
   */
  async answerPlanReview(
    tabId: string,
    frameId: string,
    verdict: PlanReviewVerdict,
    sourceHash: string | null,
  ): Promise<PlanAnswerResult> {
    const entry = this.live.get(tabId);
    if (entry === undefined || entry.kind !== "rpc-ui") {
      return { status: "rejected", reason: "unavailable" };
    }
    const pending = this.planGates.gate(tabId)?.pending ?? null;
    if (pending === null || pending.frameId !== frameId) {
      return { status: "rejected", reason: "stale" };
    }
    const html = isHtmlPlanPath(pending.planFilePath);
    if (!html || verdict === "refine") {
      // Markdown keeps un-gated semantics; refine needs the gate identity
      // but NOT unchanged disk bytes.
      this.settlePlanGateToChild(tabId, entry, frameId, verdict);
      return { status: "accepted" };
    }
    if (pending.sourceHash === undefined || sourceHash !== pending.sourceHash) {
      return { status: "rejected", reason: "stale" };
    }
    if (this.planAnswerReservations.has(tabId)) {
      return { status: "rejected", reason: "stale" };
    }
    this.planAnswerReservations.add(tabId);
    try {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      const absPath = pending.planAbsPath;
      if (record === undefined || absPath === null) {
        return { status: "rejected", reason: "unavailable" };
      }
      const root = path.resolve(this.deps.getSessionsRoot(), record.lineageDir);
      const read = await readConfinedPlanFile(root, absPath);
      if (!read.ok || read.sourceHash !== pending.sourceHash) {
        // Changed bytes under review: no implementation starts; the agent
        // hears SOURCE_CHANGED, the clients see an invalidated settlement.
        this.planGates.invalidateGate(tabId);
        this.planPreflight.sendSourceChanged(entry, frameId, pending.planFilePath);
        this.planPreflight.clearSnapshot(tabId);
        return { status: "rejected", reason: "source-changed" };
      }
      this.settlePlanGateToChild(tabId, entry, frameId, verdict);
      return { status: "accepted" };
    } finally {
      this.planAnswerReservations.delete(tabId);
    }
  }

  /** While an HTML gate is pending, plan reads answer from the snapshot (§5.4). */
  planSnapshotFor(tabId: string, absPath: string): { text: string; sourceHash: string } | null {
    return this.planPreflight.snapshotFor(tabId, absPath);
  }

  /**
   * The generation-bound private settle path (§5.7): outgoing observer
   * bookkeeping, snapshot clear, then send to exactly the verified entry —
   * never through the generic `rpcSend`.
   */
  private settlePlanGateToChild(
    tabId: string,
    entry: LiveEntry,
    frameId: string,
    value: PlanReviewVerdict,
  ): void {
    const cmd: RpcFrame = { type: "extension_ui_response", id: frameId, value };
    const wasAwaitingHuman = this.awaitingHumanAnswer(tabId);
    const before = this.pendingAnswer(tabId);
    const gateBefore = this.planGates.pending(tabId);
    for (const obs of this.frameObservers) obs.onSend?.(tabId, cmd);
    if (wasAwaitingHuman && !this.awaitingHumanAnswer(tabId)) {
      this.stallWatchdog.humanAnswered(tabId);
    }
    this.publishAnswerEdge(tabId, before, gateBefore);
    this.planPreflight.clearSnapshot(tabId);
    if (entry.kind === "rpc-ui") entry.rpc?.send(cmd);
  }

  killShell(tabId: string): void {
    this.shellHost.kill(tabId);
  }

  terminate(tabId: string): void {
    this.killShell(tabId);
    void this.enqueueOp(tabId, "terminate", async () => {
      const entry = this.live.get(tabId);
      if (!entry) return;
      this.deps.breadcrumb?.record("session-terminate", { tabId });
      await this.escalateOnTerminate(tabId, entry);
    });
  }

  async deleteSession(tabId: string, cascade: boolean): Promise<DeleteSessionResult> {
    const ids = [
      tabId,
      ...(cascade ? planHandoffDescendants(this.deps.registry.sessions, tabId) : []),
    ];
    const checkouts = ids.flatMap((id) => {
      const record = this.deps.registry.sessions.find((session) => session.tabId === id);
      return record?.worktree ? [{ projectCwd: record.projectCwd, worktree: record.worktree }] : [];
    });
    const settled = await Promise.allSettled(
      ids.map((id) => this.enqueueOp(id, "delete", () => this.deleteInner(id))),
    );
    await this.worktreeOps.reclaim(checkouts);
    if (!cascade) {
      const only = settled[0]!;
      if (only.status === "rejected") throw only.reason;
      return { deleted: [tabId], failed: [] };
    }
    const result: DeleteSessionResult = { deleted: [], failed: [] };
    settled.forEach((outcome, index) => {
      const id = ids[index]!;
      if (outcome.status === "fulfilled") result.deleted.push(id);
      else {
        result.failed.push({
          tabId: id,
          message: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason),
        });
      }
    });
    return result;
  }

  deleteSessionPreview(tabId: string): DeleteSessionPreview {
    const descendants = planHandoffDescendants(this.deps.registry.sessions, tabId);
    return {
      descendants: descendants.map((id) => {
        const record = this.deps.registry.sessions.find((s) => s.tabId === id)!;
        return {
          tabId: id,
          title: record.cachedTitle?.trim() || "New session",
          running: this.live.has(id),
          worktree: record.worktree !== null,
        };
      }),
    };
  }


  private async deleteInner(tabId: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stallWatchdog.dispose(tabId);
    this.hibernation.dispose(tabId);
    this.toolControl.dispose(tabId);
    this.planPreflight.dispose(tabId);
    this.watcherHub.stop(tabId);
    this.killShell(tabId);
    this.browserPanes.dispose(tabId, { forgetUrl: true });
    try {
      await deleteSessionFiles(
        this.deps.getSessionsRoot(),
        this.deps.getArchiveRoot(),
        record.lineageDir,
      );
    } catch (err) {
      this.watcherHub.start(record);
      throw err;
    }
    this.deps.registry.removeSession(tabId);
    await this.deps.broadcast();
  }

  async forkSession(tabId: string): Promise<{ tabId: string }> {
    return this.enqueueOp(tabId, "fork", async () => {
    const source = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!source) throw new Error(`unknown session tab ${tabId}`);
    const loc = await resolveSessionLocation(
      this.deps.getSessionsRoot(),
      this.deps.getArchiveRoot(),
      source.lineageDir,
      source.sessionId,
    );
    if (loc.where !== "active") {
      throw new Error(
        loc.where === "archived"
          ? "unarchive the session before branching it"
          : "this session has no transcript to branch yet",
      );
    }
    const lineageDir = mintLineageDirName(source.projectCwd);
    const sessionId = randomUUID();
    await forkSessionFile(loc.filePath, path.join(this.deps.getSessionsRoot(), lineageDir), sessionId);
    const fork = this.deps.registry.addSession({
      tabId: randomUUID(),
      sessionId,
      lineageDir,
      projectCwd: source.projectCwd,
      worktree: source.worktree,
      planImplementationSource: source.planImplementationSource,
      // The fork shares the source's checkout, so the DB row stays linked to
      // the original record; copying the provenance would make both claim it.
      experiment: null,
      launchedAt: new Date().toISOString(),
      mode: source.mode,
      agentMode: source.agentMode,
      compactionMethod: source.compactionMethod,
      approvalMode: source.approvalMode,
      serviceTier: source.serviceTier,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      advisor: source.advisor,
      advisorModel: source.advisorModel,
      subagentModels: source.subagentModels,
      // The fork's session dir starts without the source's local:// artifacts,
      // so none of the source's plans can be re-presented from it.
      proposedPlans: [],
      cachedTitle: source.cachedTitle,
      cachedModified: new Date().toISOString(),
    });
    await this.deps.broadcast();
      return { tabId: fork.tabId };
    });
  }

  private async killAndReap(tabId: string, entry: LiveEntry): Promise<void> {
    entry.suppressExit = true;
    if (await this.reapWithEscalation(entry)) return;
    entry.suppressExit = false;
    throw new Error(`session ${tabId} did not exit — its files were left alone`);
  }

  async switchMode(tabId: string, mode: SessionMode): Promise<void> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record || record.mode === mode) return;
      this.deps.breadcrumb?.record("session-mode", { tabId, mode });
      this.killShell(tabId);
      if (mode === "pty") this.browserPanes.dispose(tabId);
      const entry = this.live.get(tabId);
      if (!entry) {
        this.deps.registry.updateSession(tabId, { mode });
        await this.deps.broadcast();
        return;
      }
      await this.relaunch(entry, {
        origin: "resume",
        resumeTabId: tabId,
        mode,
        cols: 80,
        rows: 24,
      });
    });
  }

  private async relaunch(
    entry: LiveEntry,
    req: ResumeSpawnRequest,
    between?: () => Promise<void>,
  ): Promise<void> {
    const { resumeTabId: tabId } = req;
    await this.killAndReap(tabId, entry);
    this.live.delete(tabId);
    this.collab.noteLiveChange();
    if (between) await between();
    try {
      await this.spawnInner(req);
    } catch (err) {
      this.deps.send(CH.onPtyExit, tabId, -1);
      await this.deps.broadcast();
      throw err;
    }
  }
}
