import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CH,
  addWorktree,
  base64Bytes,
  bracketedImagePaste,
  deleteSessionFiles,
  forkSessionFile,
  hydrateSessionFile,
  mintLineageDirName,
  mintWorktreePath,
  isObject,
  isWithin,
  parseModelRole,
  mcpRuntimeStatusMessage,
  planMessage,
  type ProviderKeys,
  type Registry,
  removeWorktree,
  resolveSessionLocation,
  RpcClient,
  spawnOmp,
  spawnOmpTui,
  spawnShell,
  unarchiveSession,
  readOmpCompactionMethods,
  writeAdvisorOverlay,
  writeAdvisorStatsExtension,
  writeMcpStatusExtension,
  writeDefaultModelOverlay,
  writeImageToScratch,
  writeCompactionMethodOverlay,
  writePlanExtension,
  MAX_IMAGE_BYTES,
  type ConsoleProgram,
  type ImageAttachment,
  type OwnedSessionRecord,
  type PlanImplementationSource,
  type PtyHandle,
  type RpcFrame,
  type SessionMode,
  type SessionWorktree,
  type SpawnRequest,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";
import { liveEntry, type LiveEntry } from "./live-entry";
import { PlanGateTracker, type PlanGate } from "./plan-gate-tracker";
import { StallWatchdog } from "./stall-watchdog";
import { TurnCounter } from "./turns";
import { ViewTracker } from "./view-tracker";
import { WatcherHub } from "./watcher-hub";

/** True when `p` settles inside `ms`. Bounded wait, no dangling timer. */
function settledWithin(p: Promise<void>, ms: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    p.then(() => true),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** How long omp gets to exit on its own before the delete escalates. */
const GRACEFUL_EXIT_MS = 3_000;
const SIGKILL_EXIT_MS = 2_000;
/** Pre-kill get_state probe bound; a wedged child is left to the stall UX, not killed. */
const HIBERNATE_PROBE_TIMEOUT_MS = 5_000;
/** Post-verdict quiet window: the implementation prompt may still land (issue #246). */
const SETTLE_WINDOW_MS = 30 * 60 * 1_000;
/**
 * Renderer-routed dialogs whose unanswered requests suppress hibernation and
 * stream-stall detection. Mirrors DIALOG_METHODS (extension-router.ts): every
 * other method (notify, setStatus, setWidget, ...) is fire-and-forget state
 * the renderer consumes without a reply, so tracking it would suppress both
 * lifecycle guards forever.
 */
const BLOCKING_DIALOG_METHODS: Record<string, true> = {
  select: true,
  confirm: true,
  input: true,
  editor: true,
};

export interface SessionManagerDependencies {
  registry: Registry;
  providerKeys: ProviderKeys;
  getOmpPath: () => string | null;
  getSessionsRoot: () => string;
  getArchiveRoot: () => string;
  getWorktreesRoot: () => string;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
  /** OS-attention hooks for background sessions (issue #271); omitted in tests. */
  attention?: Attention;
}

/**
 * The no-kill verdicts of the shared hibernation attempt. `rearm`: a guard is
 * in force or the probe said "not idle" — re-examine next window (issue #247).
 * The invalidating verdicts let the caller decide its own contract.
 */
type HibernateOutcome =
  | { reaped: boolean }
  | "rearm"
  | "setting-off"
  | "replaced"
  | "gone";

/** The sole owner of live session children and their supporting process state. */
export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  /** Running turns per tab — the cross-concern datum (hibernation + stall). */
  private readonly turns = new TurnCounter();
  /** Console-drawer shells keyed by tabId (issue #42) — outside `live` on purpose. */
  private readonly shells = new Map<string, { handle: PtyHandle; detachData: () => void }>();
  /** Lineage-dir watchers and their throttled sidebar broadcast (issue #187). */
  private readonly watcherHub: WatcherHub;
  /** Fresh tab:viewed reports and their deduped lastViewedAt writes. */
  private readonly viewTracker: ViewTracker;
  /**
   * In-flight resume spawns, keyed by tab — registered before the first await
   * (double-click race). The value settles when the spawn does, so a delete
   * arriving mid-spawn can wait for the process to exist and then kill it.
   */
  private readonly spawning = new Map<string, Promise<void>>();
  /**
   * Live plan-review gates, owned by the tracker (issue #215). In-memory:
   * they die with the process, so a gate can never outlive its agent.
   */
  private readonly planGates: PlanGateTracker;
  /**
   * Frame-dispatch observers, dispatched in array order before the renderer
   * fan-out (issue #297). The order is the contract: each tracker sees
   * every frame and acts on a frame before any later tracker or the broadcast does.
   */
  private readonly frameObservers: FrameObserver[] = [];
  /** Idle-kill timers, keyed by tabId (issue #246). */
  private readonly hibernateTimers = new Map<string, NodeJS.Timeout>();
  /**
   * In-flight hibernation reaps, keyed by tabId (same race pattern as
   * `spawning`): a resume issued mid-reap waits for the entry to leave
   * `live` instead of deduping against the dying process.
   */
  private readonly hibernating = new Map<string, Promise<boolean>>();
  /** Unanswered extension_ui_request ids per tab (plan reviews included). */
  private readonly openExtensionRequests = new Map<string, Set<string>>();
  /** Model-stream stall watchdog (issue #248): the sweep and the per-tab silence records. */
  private readonly stallWatchdog: StallWatchdog;

  constructor(private readonly deps: SessionManagerDependencies) {
    this.watcherHub = new WatcherHub({
      registry: deps.registry,
      getSessionsRoot: () => deps.getSessionsRoot(),
      broadcast: () => deps.broadcast(),
    });
    this.viewTracker = new ViewTracker({
      registry: deps.registry,
      broadcastPatch: (immediate) => this.watcherHub.broadcastPatch(immediate),
    });
    this.planGates = new PlanGateTracker({
      registry: deps.registry,
      broadcast: () => deps.broadcast(),
      attention: deps.attention,
      suspendForVerdict: (tabId) => this.suspendForVerdict(tabId),
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
    this.frameObservers = [this.planGates, this.stallWatchdog];
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

  /** Kills every owned child and closes every lineage watcher. */
  killAll(): void {
    for (const entry of this.live.values()) this.killLive(entry);
    this.live.clear();
    for (const tabId of [...this.shells.keys()]) this.killShell(tabId);
    // Lineage watchers hold inotify fds; quit is the one path that must not
    // leave them to the OS — a cancelled quit keeps the app alive without them.
    this.watcherHub.disposeAll();
    for (const timer of this.hibernateTimers.values()) clearTimeout(timer);
    this.hibernateTimers.clear();
    this.openExtensionRequests.clear();
    this.stallWatchdog.disposeAll();
    // Quit must not block on a hibernation reap: the child is already dying.
    this.hibernating.clear();
  }

  /**
   * Kills a live session's child and detaches its data listener first, so a
   * dying process's final output cannot land in a successor's renderer state.
   */
  private killLive(entry: LiveEntry): void {
    entry.detachPtyData?.();
    entry.detachPtyData = undefined;
    entry.pty?.kill();
    entry.rpc?.kill();
  }

  /**
   * Both spawn paths' child-exit plumbing in one place. When this entry is
   * still the tab's live one it is removed from `live` and the per-concern
   * bookkeeping it owned is cleared; a successor that already replaced it
   * (mode-switch respawn) keeps the tab. The exit is only reported when not
   * suppressed (mode-switch kill, delete), and the sidebar rebuilds either
   * way.
   */
  private handleExit(tabId: string, entry: LiveEntry, exitCode: number): void {
    entry.markExited();
    // Identity-checked: a mode-switch respawn may already have replaced
    // this entry — deleting then would orphan the new live session.
    if (this.live.get(tabId) === entry) {
      this.live.delete(tabId);
      this.turns.clear(tabId);
      for (const obs of this.frameObservers) obs.onExit(tabId);
      this.clearHibernateState(tabId);
      this.deps.attention?.sessionExit(tabId);
    }
    if (!entry.suppressExit) this.deps.send(CH.onPtyExit, tabId, exitCode);
    void this.deps.broadcast();
  }

  /**
   * SIGTERM → grace → SIGKILL against a live entry. Resolves true once the
   * child's exit has been observed; false if it outlived both signals. Owns
   * the escalation timing alone: callers own `suppressExit` and their
   * post-reap policy (warn / hibernated event / throw).
   */
  private async reapWithEscalation(entry: LiveEntry): Promise<boolean> {
    this.killLive(entry);
    if (await settledWithin(entry.exited, GRACEFUL_EXIT_MS)) return true;
    entry.pty?.kill("SIGKILL");
    entry.rpc?.kill("SIGKILL");
    if (await settledWithin(entry.exited, SIGKILL_EXIT_MS)) return true;
    return false;
  }

  /**
   * Terminate shares killAndReap's escalation machine — a wedged omp that
   * ignores SIGTERM must not hold its pipes/pty (and its MCP grandchildren)
   * forever (issue #182, the #64 residual). Unlike killAndReap this never
   * suppresses the exit and never throws: the renderer still learns the
   * session ended via the normal onExit → broadcast.
   */
  private async escalateOnTerminate(tabId: string, entry: LiveEntry): Promise<void> {
    if (await this.reapWithEscalation(entry)) return;
    console.warn(
      `[sessions] ${tabId}: child survived SIGKILL (uninterruptible sleep?) — ` +
        `its fds stay open until it dies`,
    );
  }

  /**
   * A plan handoff is valid only for a fresh native implementation session.
   * Resolve its source before spawn performs any storage or process mutation,
   * then copy the request snapshot so registry ownership begins atomically
   * with the child record.
   */
  private validatePlanImplementationSource(req: SpawnRequest): PlanImplementationSource | null {
    const snapshot = req.planImplementationSource ?? null;
    if (snapshot === null) return null;
    if (req.resumeTabId !== undefined) {
      throw new Error("a plan implementation source cannot be attached when resuming a session");
    }
    if (req.mode !== "rpc-ui") {
      throw new Error("a plan implementation source requires rpc-ui mode");
    }
    if (typeof snapshot.sourceTabId !== "string" || snapshot.sourceTabId === "") {
      throw new Error("plan implementation source sourceTabId must be a non-empty string");
    }
    if (typeof snapshot.planTitle !== "string" || snapshot.planTitle === "") {
      throw new Error("plan implementation source planTitle must be a non-empty string");
    }
    if (typeof snapshot.planFilePath !== "string" || snapshot.planFilePath === "") {
      throw new Error("plan implementation source planFilePath must be a non-empty string");
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
    return { ...snapshot };
  }

  async spawn(req: SpawnRequest): Promise<{ tabId: string }> {
    const planImplementationSource = this.validatePlanImplementationSource(req);
    // Dedupe guard — the renderer should never send this, but a second
    // process for the same session would corrupt the .jsonl. The in-flight
    // set closes the race window before the first await (live.set happens
    // after async prepareResume).
    let spawnSettled = (): void => {};
    if (req.resumeTabId) {
      // A resume issued while a hibernation reap is in flight must wait for
      // the dying entry to leave `live`, or it dedupes and the user clicks
      // twice (issue #246).
      const pendingHibernate = this.hibernating.get(req.resumeTabId);
      if (pendingHibernate !== undefined) await pendingHibernate;
      if (this.live.has(req.resumeTabId) || this.spawning.has(req.resumeTabId)) {
        return { tabId: req.resumeTabId };
      }
      this.spawning.set(
        req.resumeTabId,
        new Promise<void>((resolve) => {
          spawnSettled = () => resolve();
        }),
      );
    }
    try {
      const ompPath = this.requireOmpPath();

      // A new session cannot run without a model credential — omp would crash
      // moments after spawn with no explanation. Resuming an existing session
      // is allowed through (its process may already be keyless but viewable).
      if (!req.resumeTabId && !this.deps.providerKeys.hasModelProvider(req.projectCwd)) {
        throw new Error(
          "No model provider is configured. Add an API key under Settings → Providers before starting a session.",
        );
      }

      let record: OwnedSessionRecord;
      if (req.resumeTabId) {
        const existing = this.deps.registry.sessions.find((s) => s.tabId === req.resumeTabId);
        if (!existing) throw new Error(`unknown session tab ${req.resumeTabId}`);
        record = await this.prepareResume(existing);
      } else {
        let worktree: SessionWorktree | null = null;
        if (req.worktree) {
          const worktreePath = mintWorktreePath(
            this.deps.getWorktreesRoot(), req.projectCwd, req.worktree.branch);
          const base = await addWorktree(
            req.projectCwd, worktreePath, req.worktree.branch, req.worktree.baseRef);
          worktree = { path: worktreePath, branch: req.worktree.branch, base };
        }
        const project = this.deps.registry.projects.find((p) => p.path === req.projectCwd);
        // agentMode starts at the parse-time normalization default; the plan
        // extension overwrites it when its first incarnation report lands.
        record = this.deps.registry.addSession({
          tabId: randomUUID(),
          sessionId: null,
          lineageDir: mintLineageDirName(req.projectCwd),
          projectCwd: req.projectCwd,
          worktree,
          planImplementationSource,
          launchedAt: new Date().toISOString(),
          mode: req.mode,
          agentMode: "build",
          compactionMethod:
            req.mode === "rpc-ui" ? this.deps.registry.getSetting("defaultCompactionMethod") : null,
          model: project?.defaultModel ?? project?.lastModel ?? null,
          thinkingLevel: project?.lastThinkingLevel ?? null,
          advisor: req.advisor,
          advisorModel: req.advisorModel ?? null,
          cachedTitle: null,
          cachedModified: null,
          lastViewedAt: null,
        });
        // The launched values are now the project's last session parameters,
        // even when they originated in omp config rather than an explicit click.
        this.deps.registry.setSessionAdvisor(record.tabId, record.advisor, record.advisorModel);
      }
      const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
      if (record.mode !== req.mode) patch.mode = req.mode;
      // A resume carries the caller's advisor intent; `undefined` means "keep
      // whatever the record already says" so a plain reopen is not a reset.
      if (req.advisorModel !== undefined && req.advisorModel !== record.advisorModel) {
        patch.advisorModel = req.advisorModel;
      }
      if (req.advisor !== record.advisor && req.resumeTabId) patch.advisor = req.advisor;
      if (Object.keys(patch).length > 0) {
        record = this.deps.registry.updateSession(record.tabId, patch) ?? record;
      }

      const startInPlanMode =
        req.startInPlanMode ??
        (req.resumeTabId === undefined
          ? this.deps.registry.getSetting("defaultAgentMode") === "plan"
          : record.agentMode === "plan");
      return req.mode === "rpc-ui"
        ? await this.spawnRpc(record, startInPlanMode, ompPath)
        : await this.spawnPty(record, req, ompPath);
    } finally {
      if (req.resumeTabId) {
        this.spawning.delete(req.resumeTabId);
        spawnSettled();
      }
    }
  }

  private async spawnPty(
    record: OwnedSessionRecord,
    req: SpawnRequest,
    ompPath: string,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    const ptyHandle = spawnOmp({
      id: record.tabId,
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: this.configOverlays(record, absLineageDir),
    });
    const entry = liveEntry({ kind: "pty", pty: ptyHandle, record });
    this.live.set(record.tabId, entry);
    entry.detachPtyData = ptyHandle.onData((data) =>
      this.deps.send(CH.onPtyData, record.tabId, data),
    );
    ptyHandle.onExit(({ exitCode }) => this.handleExit(record.tabId, entry, exitCode));
    this.watcherHub.start(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
  }

  private async spawnRpc(
    record: OwnedSessionRecord,
    startInPlanMode: boolean,
    ompPath: string,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    const entry = liveEntry({ kind: "rpc-ui", record });
    const { paths: extensions, mcpStatusLoaded } = this.rpcExtensions(absLineageDir);
    const initialCommands: Array<{ type: "prompt"; id: string; message: string }> = [];
    if (mcpStatusLoaded) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-mcp-${randomUUID()}`,
        message: mcpRuntimeStatusMessage(),
      });
    }
    // Always published, plan or build — the plan extension is the
    // authoritative session-mode status source on every spawn (issue #142);
    // #242's rewrite briefly made this conditional (issue #256).
    initialCommands.push({
      type: "prompt",
      id: `omp-ui-initial-mode-${randomUUID()}`,
      message: planMessage(startInPlanMode, this.deps.registry.getSetting("planFormat")),
    });
    const configOverlays = await this.rpcConfigOverlays(record, absLineageDir, ompPath);
    entry.rpc = new RpcClient({
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      advisor: record.advisor,
      configOverlays,
      extensions,
      initialCommands,
      onFrame: (frame) => {
        // Hibernation observation precedes the fan-out: the idle clock sees
        // every frame, probe responses included (issue #246).
        this.observeHibernation(record.tabId, frame);
        for (const obs of this.frameObservers) obs.onFrame(record.tabId, frame, entry);
        this.deps.send(CH.onRpcFrame, record.tabId, frame);
      },
      onExit: (code) => this.handleExit(record.tabId, entry, code ?? -1),
      onError: (msg) =>
        this.deps.send(CH.onRpcFrame, record.tabId, { type: "omp_ui_error", message: msg }),
    });
    this.live.set(record.tabId, entry);
    this.watcherHub.start(record);
    void this.deps.broadcast();
    return { tabId: record.tabId };
  }

  /** Rewrites spawn overlays from the session record on every launch. */
  private configOverlays(record: OwnedSessionRecord, absLineageDir: string): string[] {
    const overlays: string[] = [];
    const advisorRole = record.advisorModel === null ? null : parseModelRole(record.advisorModel);
    try {
      const overlay = writeAdvisorOverlay(absLineageDir, advisorRole, record.advisor);
      if (overlay !== null) overlays.push(overlay);
    } catch (err) {
      console.warn("[advisor] could not write the overlay:", err);
    }
    const model = record.model;
    if (model !== null) {
      const selector =
        record.thinkingLevel == null ? model : `${model}:${record.thinkingLevel}`;
      try {
        const overlay = writeDefaultModelOverlay(absLineageDir, parseModelRole(selector));
        if (overlay !== null) overlays.push(overlay);
      } catch (err) {
        console.warn("[model] could not write the default-model overlay:", err);
      }
    }
    return overlays;
  }

  private async rpcConfigOverlays(
    record: OwnedSessionRecord,
    absLineageDir: string,
    ompPath: string,
  ): Promise<string[]> {
    const overlays = this.configOverlays(record, absLineageDir);
    const preferred = record.compactionMethod;
    if (preferred === null) {
      writeCompactionMethodOverlay(absLineageDir, null, []);
      return overlays;
    }
    try {
      const methods = await readOmpCompactionMethods({
        ompPath,
        projectCwd: record.worktree?.path ?? record.projectCwd,
      });
      if (!methods.supported.includes(preferred)) {
        writeCompactionMethodOverlay(absLineageDir, null, []);
        console.warn(
          `[compaction] tab ${record.tabId} captured unavailable method ${preferred}; using omp configuration`,
        );
        return overlays;
      }
      const overlay = writeCompactionMethodOverlay(
        absLineageDir,
        preferred,
        methods.configuredOrder,
      );
      if (overlay !== null) overlays.push(overlay);
    } catch (err) {
      writeCompactionMethodOverlay(absLineageDir, null, []);
      console.warn(
        `[compaction] tab ${record.tabId} could not apply captured method ${preferred}; using omp configuration:`,
        err,
      );
    }
    return overlays;
  }

  /** The generated `-e` bridges an rpc-ui spawn needs. */
  private rpcExtensions(absLineageDir: string): { paths: string[]; mcpStatusLoaded: boolean } {
    const paths: string[] = [];
    try {
      paths.push(writePlanExtension(absLineageDir));
    } catch (err) {
      console.warn("[plan] could not write the plan extension:", err);
    }
    try {
      paths.push(writeAdvisorStatsExtension(absLineageDir));
    } catch (err) {
      console.warn("[advisor] could not write the advisor-stats extension:", err);
    }
    let mcpStatusLoaded = false;
    try {
      paths.push(writeMcpStatusExtension(absLineageDir));
      mcpStatusLoaded = true;
    } catch (err) {
      console.warn("[mcp] could not write the MCP-status extension:", err);
    }
    return { paths, mcpStatusLoaded };
  }

  /** Re-pins a session's advisor, relaunching a live child to apply it. */
  async setSessionAdvisor(
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void> {
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
      // Dormant: the next launch picks the new values up from the record.
      await this.deps.broadcast();
      return;
    }
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode: record.mode,
      advisor,
      advisorModel,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /** Restarts a live session in place so it picks up process-start config. */
  async restart(tabId: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    const entry = this.live.get(tabId);
    if (!record || !entry) throw new Error("session is not live");
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode: record.mode,
      advisor: record.advisor,
      advisorModel: record.advisorModel,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /**
   * Converts an unprompted session to a worktree session (issue #225): mints
   * the checkout, records it on the session, and respawns in place so the
   * first prompt lands in the worktree. Create-before-kill: a failed
   * `git worktree add` leaves the live session untouched and surfaces git's
   * own message. A respawn failure after the record update leaves a
   * resumable worktree session rather than rolling back into the project root.
   */
  async convertToWorktree(tabId: string, branch: string, baseRef: string | null): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) throw new Error(`unknown session tab ${tabId}`);
    if (record.worktree) throw new Error("session already runs in a worktree");
    const worktreePath = mintWorktreePath(
      this.deps.getWorktreesRoot(), record.projectCwd, branch);
    const base = await addWorktree(record.projectCwd, worktreePath, branch, baseRef);
    this.deps.registry.updateSession(tabId, {
      worktree: { path: worktreePath, branch, base },
    });
    const entry = this.live.get(tabId);
    if (!entry) {
      // A dormant restored tab: its next resume picks the worktree up from
      // the record.
      await this.deps.broadcast();
      return;
    }
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode: record.mode,
      advisor: record.advisor,
      advisorModel: record.advisorModel,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /** Delivers a pasted image to a PTY session as a scratch-file path. */
  async ptyPasteImage(tabId: string, image: ImageAttachment): Promise<void> {
    const pty = this.live.get(tabId)?.pty;
    if (!pty) throw new Error("session is not running in terminal mode");
    if (base64Bytes(image.data) > MAX_IMAGE_BYTES) {
      throw new Error(`image is over omp's ${MAX_IMAGE_BYTES / (1024 * 1024)} MB input limit`);
    }
    const file = writeImageToScratch(image);
    pty.write(bracketedImagePaste(file));
    // The scratch file outlives this call on purpose: omp reads it after the
    // paste is delivered, and it also backs the transcript's image blob.
  }

  /**
   * The single omp-path failure both spawn paths speak with: a session spawn
   * and a console-drawer TUI handoff must fail with the same guidance.
   */
  private requireOmpPath(): string {
    const ompPath = this.deps.getOmpPath();
    if (!ompPath) {
      throw new Error(
        "omp binary not found (looked in $OMP_UI_OMP_PATH, PATH, ~/.bun/bin, /usr/local/bin, ~/.local/bin)",
      );
    }
    return ompPath;
  }

  /** Launches the console drawer's program in a session project. */
  launchShell(
    tabId: string,
    cwd: string,
    cols: number,
    rows: number,
    program: ConsoleProgram = "shell",
  ): void {
    this.killShell(tabId);
    // A handoff replaces whatever the drawer was running; the exit guard below
    // keeps the killed program from reporting shell:exit over its successor.
    const handle =
      program === "omp-tui"
        ? spawnOmpTui({ id: tabId, cwd, cols, rows, ompPath: this.requireOmpPath() })
        : spawnShell({ id: tabId, cwd, cols, rows });
    const detachData = handle.onData((data) => this.deps.send(CH.onShellData, tabId, data));
    this.shells.set(tabId, { handle, detachData });
    handle.onExit(({ exitCode }) => {
      const current = this.shells.get(tabId);
      if (!current || current.handle !== handle) return;
      this.shells.delete(tabId);
      current.detachData();
      this.deps.send(CH.onShellExit, tabId, exitCode);
    });
  }

  shellWrite(tabId: string, data: string): void {
    this.shells.get(tabId)?.handle.write(data);
  }

  shellResize(tabId: string, cols: number, rows: number): void {
    this.shells.get(tabId)?.handle.resize(cols, rows);
  }

  ptyWrite(tabId: string, data: string): void {
    this.live.get(tabId)?.pty?.write(data);
  }

  ptyResize(tabId: string, cols: number, rows: number): void {
    this.live.get(tabId)?.pty?.resize(cols, rows);
  }

  /** Read by MainBackend.summarize; undefined when the tab never proposed. */
  planGate(tabId: string): PlanGate | undefined {
    return this.planGates.gate(tabId);
  }

  /**
   * Post-verdict hibernation suspension (issue #246): between the verdict
   * and the implementation prompt the process is momentarily quiet. Stays
   * in the manager until the hibernation tracker owns the settle state
   * (issue #297).
   */
  private suspendForVerdict(tabId: string): void {
    const entry = this.live.get(tabId);
    if (entry !== undefined) {
      entry.settleSuspendedUntil = Date.now() + SETTLE_WINDOW_MS;
      // A rejected plan leaves the session silent — no frame would re-arm
      // the check, so schedule one at the window's lapse (issue #247). Any
      // real frame re-arms over it and resets the clock.
      this.scheduleHibernateCheck(tabId, SETTLE_WINDOW_MS);
    }
  }

  /** Renderer reports the tab it currently has in view, or null (issue #266). */
  setViewedTab(clientId: string, tabId: string | null): void {
    this.viewTracker.setViewedTab(clientId, tabId);
  }

  /** Marks the clientId the desktop renderer reports under (issue #271). */
  noteDesktopClientId(clientId: string): void {
    this.viewTracker.noteDesktopClientId(clientId);
  }

  /** True while the desktop renderer's fresh viewed report names this tab (issue #271). */
  isViewedInDesktop(tabId: string): boolean {
    return this.viewTracker.isViewedInDesktop(tabId);
  }

  // --- Hibernation: idle rpc-ui sessions are killed and left dormant, then
  // --- woken through the ordinary resume path (issue #246). ---

  /** Clears hibernation bookkeeping on every path where a tab leaves `live`. */
  private clearHibernateState(tabId: string): void {
    clearTimeout(this.hibernateTimers.get(tabId));
    this.hibernateTimers.delete(tabId);
    this.openExtensionRequests.delete(tabId);
  }

  /** Whether the stall watchdog has aborted a turn on this live process. */
  isStreamStalled(tabId: string): boolean {
    return this.stallWatchdog.isStreamStalled(tabId);
  }

  /**
   * Every rpc frame updates hibernation state in one place and re-arms the
   * idle clock. The setting is re-read on every arm, so a Settings change
   * takes effect at the next activity — no separate re-arm path.
   */
  private observeHibernation(tabId: string, frame: RpcFrame): void {
    const entry = this.live.get(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    if (typeof frame !== "object" || frame === null) return;
    // The probe's own response: settle it and do NOT reset the idle clock —
    // probe traffic is our own, and resetting would postpone every hibernation
    // attempt by its own probe.
    if (frame.type === "response" && entry.probeId !== null && frame.id === entry.probeId) {
      entry.probeId = null;
      const resolve = entry.probeResolve;
      entry.probeResolve = null;
      if (resolve === null) return;
      if (frame.success === false) {
        resolve(null);
        return;
      }
      // Command responses nest their payload under `data` (same tolerant
      // unwrap as the renderer's respData).
      const data = isObject(frame.data) ? frame.data : frame;
      const parked =
        typeof data.queuedMessageCount === "number" &&
        Number.isFinite(data.queuedMessageCount)
          ? data.queuedMessageCount
          : 0;
      resolve({ parked, streaming: data.isStreaming === true });
      return;
    }
    switch (frame.type) {
      case "agent_start":
        this.turns.start(tabId);
        // A new turn is activity: it answers every pending attention (issue #271).
        this.deps.attention?.turnStarted(tabId);
        break;
      case "agent_end": {
        const running = this.turns.end(tabId);
        if (entry.settleSuspendedUntil !== null) entry.settleSuspendedUntil = null;
        // The idle crossing announces the finished turn (issue #271); a
        // pending plan gate or blocking answer owns the attention instead.
        if (running === 0 && !this.awaitingHumanAnswer(tabId))
          this.deps.attention?.turnEnded(tabId);
        break;
      }
      case "extension_ui_request":
        // Only user-answer dialogs block hibernation; the other methods are
        // fire-and-forget state frames the renderer never replies to.
        if (typeof frame.id === "string" && BLOCKING_DIALOG_METHODS[String(frame.method)] === true) {
          let open = this.openExtensionRequests.get(tabId);
          if (open === undefined) {
            open = new Set<string>();
            this.openExtensionRequests.set(tabId, open);
          }
          open.add(frame.id);
        }
        break;
    }
    // Responses to dialogs are commands (rpcSend), not frames: they clear
    // `openExtensionRequests` there. Any real frame re-arms the clock.
    entry.hibernateArmed = true;
    this.armHibernateTimer(tabId);
  }

  /** True while plan review or a renderer-routed dialog awaits the user. */
  private awaitingHumanAnswer(tabId: string): boolean {
    if (this.planGates.pending(tabId)) return true;
    return (this.openExtensionRequests.get(tabId)?.size ?? 0) > 0;
  }

  /**
   * True while `tabId` is its project's most recently active owned session.
   * The last active session in each project never idle-hibernates (issue #304):
   * recency mirrors the sidebar order — `cachedModified ?? launchedAt`, ties
   * to the earlier registry record. Dormant and terminal sessions count; a
   * dormant newest session already satisfies the guarantee.
   */
  private isLastActiveInProject(tabId: string): boolean {
    const sessions = this.deps.registry.sessions;
    const record = sessions.find((s) => s.tabId === tabId);
    if (!record) return false;
    const recency = (s: OwnedSessionRecord): string => s.cachedModified ?? s.launchedAt;
    const mine = recency(record);
    const myIndex = sessions.indexOf(record);
    return !sessions.some(
      (other, i) =>
        i !== myIndex &&
        other.projectCwd === record.projectCwd &&
        (recency(other) > mine || (recency(other) === mine && i < myIndex)),
    );
  }

  /** True when a kill cannot lose work or an in-flight exchange. */
  private hibernable(
    entry: LiveEntry,
    tabId: string,
    policy: "idle" | "plan-handoff",
  ): boolean {
    if (entry.kind !== "rpc-ui") return false;
    if (!entry.hibernateArmed) return false; // still booting
    if (this.turns.running(tabId) > 0) return false; // mid-turn
    if (this.awaitingHumanAnswer(tabId)) return false; // plan/dialog awaiting an answer
    if (policy === "plan-handoff") return true;
    if (this.viewTracker.isViewed(tabId)) return false; // the tab is being looked at (issue #266)
    if (this.isLastActiveInProject(tabId)) return false; // the project's last active session stays warm (issue #304)
    const until = entry.settleSuspendedUntil;
    if (until !== null) {
      if (Date.now() < until) return false; // post-verdict window
      entry.settleSuspendedUntil = null; // window lapsed
    }
    return true;
  }

  /**
   * Resets the idle clock. Arms regardless of guards (issue #247): the check
   * re-verifies every guard itself, so a guard that lapses while the session
   * is quiet is re-examined one window later. Arming only while hibernable
   * was the silent stick: nothing but a child frame arms, and a quiet
   * session produces none.
   */
  private armHibernateTimer(tabId: string): void {
    this.scheduleHibernateCheck(tabId, this.deps.registry.getSetting("hibernateIdleMinutes") * 60_000);
  }

  /**
   * One pending check per tab; a 0 setting means no check at all. Unref'd:
   * a housekeeping timer must never hold the process open (quit clears them
   * anyway via killAll), and tests that verdict/arm without fake timers must
   * not leak a 30-minute real timer into the worker teardown.
   */
  private scheduleHibernateCheck(tabId: string, delayMs: number): void {
    clearTimeout(this.hibernateTimers.get(tabId));
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return;
    const timer = setTimeout(() => void this.tryHibernate(tabId), delayMs);
    if (typeof timer.unref === "function") timer.unref();
    this.hibernateTimers.set(tabId, timer);
  }

  /**
   * Live check right before the kill: parked work or streaming means "not
   * really idle". Settled by the matching response frame in
   * observeHibernation; null on timeout or failure — never kill on our own
   * uncertainty (a wedged session stays with the renderer's stall UX).
   */
  private probeState(entry: LiveEntry): Promise<{ parked: number; streaming: boolean } | null> {
    const rpc = entry.rpc;
    if (rpc === undefined) return Promise.resolve(null);
    // Executor form (not Promise.withResolvers): the node tsconfig lib is
    // ES2022.
    const id = randomUUID();
    return new Promise((resolve) => {
      entry.probeId = id;
      entry.probeResolve = resolve;
      setTimeout(() => {
        if (entry.probeId !== id) return; // settled in the meantime
        entry.probeId = null;
        entry.probeResolve = null;
        resolve(null);
      }, HIBERNATE_PROBE_TIMEOUT_MS);
      rpc.send({ type: "get_state", id });
    });
  }

  /**
   * The shared guard→probe→recheck→reap sequence. Callers own their entry
   * gates (timer, dedupe) and map the no-kill verdicts to their own policy.
   * The reap is registered in `hibernating` for its full duration so a
   * delete or resume for the same tab can wait it out (issue #246, #296).
   */
  private async attemptHibernate(
    tabId: string,
    entry: LiveEntry,
    policy: "idle" | "plan-handoff",
  ): Promise<HibernateOutcome> {
    if (!this.hibernable(entry, tabId, policy)) return "rearm";
    const state = await this.probeState(entry);
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return "setting-off";
    if (this.live.get(tabId) !== entry) return this.live.has(tabId) ? "replaced" : "gone";
    if (state === null || state.parked > 0 || state.streaming) return "rearm";
    if (!this.hibernable(entry, tabId, policy)) return "rearm";
    const reap = this.hibernate(tabId, entry);
    this.hibernating.set(tabId, reap);
    try {
      return { reaped: await reap };
    } finally {
      this.hibernating.delete(tabId);
    }
  }

  /**
   * Idle window elapsed: run the shared attempt. Re-arm only on the
   * re-examination verdicts (issue #247) — guards lapse on their own clocks,
   * and a quiet session has no frames to re-arm the check.
   */
  private async tryHibernate(tabId: string): Promise<void> {
    this.hibernateTimers.delete(tabId);
    // The setting may have flipped to off since the timer armed.
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return;
    const entry = this.live.get(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    // Guard-in-force and not-idle verdicts re-arm (issue #247): guards lapse
    // on their own clocks, and a quiet session has no frames to re-arm. The
    // invalidating verdicts (setting off, entry stale) do not: the current
    // config or the successor's own paths own the next check.
    if ((await this.attemptHibernate(tabId, entry, "idle")) === "rearm") {
      this.armHibernateTimer(tabId);
    }
  }

  /**
   * Hibernates an idle planning source after a fresh implementation prompt was
   * accepted. The persisted handoff relation is the authorization boundary;
   * viewed-tab and post-verdict guards apply only to ordinary idle hibernation.
   */
  async hibernatePlanSource(
    sourceTabId: string,
    implementationTabId: string,
  ): Promise<boolean> {
    const source = this.deps.registry.sessions.find((record) => record.tabId === sourceTabId);
    if (source === undefined) throw new Error(`unknown plan source tab ${sourceTabId}`);
    const implementation = this.deps.registry.sessions.find(
      (record) => record.tabId === implementationTabId,
    );
    if (implementation === undefined) {
      throw new Error(`unknown plan implementation tab ${implementationTabId}`);
    }
    if (implementation.planImplementationSource?.sourceTabId !== sourceTabId) {
      throw new Error("plan implementation does not belong to the requested source");
    }
    if (source.projectCwd !== implementation.projectCwd) {
      throw new Error("plan source and implementation must belong to the same project");
    }
    if (source.mode !== "rpc-ui" || implementation.mode !== "rpc-ui") {
      throw new Error("plan source and implementation must use rpc-ui mode");
    }

    const entry = this.live.get(sourceTabId);
    if (entry === undefined) return true;
    if (this.deps.registry.getSetting("hibernateIdleMinutes") <= 0) return false;
    const pending = this.hibernating.get(sourceTabId);
    if (pending !== undefined) return pending;
    if (!this.hibernable(entry, sourceTabId, "plan-handoff")) return false;

    // `gone` (the source already exited) reads as hibernated for the handoff;
    // every other no-kill verdict — including a survived SIGKILL — is false.
    const outcome = await this.attemptHibernate(sourceTabId, entry, "plan-handoff");
    if (outcome === "gone") return true;
    return typeof outcome === "object" ? outcome.reaped : false;
  }

  /**
   * SIGTERM → grace → SIGKILL. Emits `session:hibernated` only after the reap
   * succeeds, so a renderer that sees it never races a live process. If the
   * child outlives SIGKILL the outcome goes back to the normal exit path.
   */
  private async hibernate(tabId: string, entry: LiveEntry): Promise<boolean> {
    entry.suppressExit = true;
    if (await this.reapWithEscalation(entry)) {
      this.deps.send(CH.onSessionHibernated, tabId);
      void this.deps.broadcast();
      return this.live.get(tabId) !== entry;
    }
    entry.suppressExit = false;
    console.warn(`[sessions] ${tabId}: hibernation kill ignored by child; leaving it live`);
    return false;
  }

  rpcSend(tabId: string, cmd: RpcFrame): void {
    const wasAwaitingHuman = this.awaitingHumanAnswer(tabId);
    for (const obs of this.frameObservers) obs.onSend?.(tabId, cmd);
    if (cmd.type === "extension_ui_response" && typeof cmd.id === "string") {
      this.openExtensionRequests.get(tabId)?.delete(cmd.id);
    }
    if (wasAwaitingHuman && !this.awaitingHumanAnswer(tabId))
      this.stallWatchdog.humanAnswered(tabId);
    this.live.get(tabId)?.rpc?.send(cmd);
  }

  killShell(tabId: string): void {
    const shell = this.shells.get(tabId);
    if (!shell) return;
    this.shells.delete(tabId);
    // Detach before kill: the dying shell's final output must not land in the
    // replacement's terminal (respawn) or a closed drawer (kill).
    shell.detachData();
    shell.handle.kill();
  }

  /** Unarchives / adopts as needed so spawn can --resume the right session. */
  private async prepareResume(record: OwnedSessionRecord): Promise<OwnedSessionRecord> {
    if (record.worktree && !fs.existsSync(record.worktree.path)) {
      throw new Error(
        "this session's worktree checkout is gone — delete the session from the sidebar",
      );
    }
    const loc = await resolveSessionLocation(
      this.deps.getSessionsRoot(),
      this.deps.getArchiveRoot(),
      record.lineageDir,
      record.sessionId,
    );
    if (loc.where === "missing") {
      // omp writes the transcript lazily, on the first turn. A record that
      // never had a session id is therefore still a fresh start, not a loss.
      if (record.sessionId === null) return record;
      throw new Error("session files are gone — delete it from the sidebar");
    }
    if (loc.where === "archived") {
      let sessionId = record.sessionId;
      if (!sessionId) {
        const m = /_([^_]+)\.jsonl\.gz$/.exec(loc.filePath);
        if (!m) throw new Error(`cannot identify archived session file ${loc.filePath}`);
        sessionId = m[1]!;
      }
      await unarchiveSession(
        this.deps.getSessionsRoot(),
        this.deps.getArchiveRoot(),
        record.lineageDir,
        sessionId,
      );
      if (sessionId !== record.sessionId) {
        record = this.deps.registry.updateSession(record.tabId, { sessionId }) ?? record;
      }
      return record;
    }
    // Active: adopt the file's header id when it differs (stale or null id).
    try {
      const h = await hydrateSessionFile(loc.filePath);
      if (h.id && h.id !== record.sessionId) {
        record =
          this.deps.registry.updateSession(record.tabId, {
            sessionId: h.id,
            cachedTitle: h.title ?? record.cachedTitle,
            cachedModified: h.mtime.toISOString(),
          }) ?? record;
      }
    } catch {
      // Head unreadable — spawn proceeds without --resume.
    }
    return record;
  }

  terminate(tabId: string): void {
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) return;
    void this.escalateOnTerminate(tabId, entry);
    // The record stays; the broadcast fires on process exit.
  }

  /** Erases a session's record and files after its child is fully reaped. */
  async deleteSession(tabId: string): Promise<void> {
    const inFlight = this.spawning.get(tabId);
    if (inFlight) await inFlight;
    // A mid-flight hibernation reap owns the same entry: wait it out so the
    // reap's `session:hibernated` (if any) lands while the record and files
    // still exist, then proceed with an entry already gone from `live`
    // (mirrors spawn's pending-hibernate wait; issue #296).
    const pendingHibernate = this.hibernating.get(tabId);
    if (pendingHibernate !== undefined) await pendingHibernate;
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stallWatchdog.dispose(tabId);
    this.watcherHub.stop(tabId);
    this.killShell(tabId);
    // Files first: a failed delete must leave the record so the row stays
    // visible and retryable, rather than orphaning the transcript on disk.
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
    if (record.worktree) {
      const wt = record.worktree;
      const shared = this.deps.registry.sessions.some(
        (s) => s.tabId !== tabId && s.worktree?.path === wt.path,
      );
      // Only the canonical minted path, inside the worktrees root:
      // worktree.path comes from the registry, and a corrupt value must
      // not steer the recursive fallback inside removeWorktree (branch
      // ".." mints to the root itself — isWithin rejects that).
      const worktreesRoot = this.deps.getWorktreesRoot();
      const canonical =
        wt.path === mintWorktreePath(worktreesRoot, record.projectCwd, wt.branch) &&
        isWithin(worktreesRoot, wt.path);
      if (!canonical) {
        console.warn(
          `[sessions] worktree path ${wt.path} does not match its minted location — leaving it for manual removal`,
        );
      } else if (!shared) {
        try { await removeWorktree(record.projectCwd, wt.path); }
        catch (err) { console.warn(`[sessions] worktree cleanup failed for ${wt.path}:`, err); }
      }
    }
    this.deps.registry.removeSession(tabId);
    await this.deps.broadcast();
  }

  /** Branches a session by copying its transcript into a fresh lineage. */
  async forkSession(tabId: string): Promise<{ tabId: string }> {
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
      launchedAt: new Date().toISOString(),
      mode: source.mode,
      agentMode: source.agentMode,
      compactionMethod: source.compactionMethod,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      advisor: source.advisor,
      advisorModel: source.advisorModel,
      cachedTitle: source.cachedTitle,
      cachedModified: new Date().toISOString(),
      // The forked transcript is the source's: its away window starts where
      // the source's viewing left off (issue #273).
      lastViewedAt: source.lastViewedAt,
    });
    await this.deps.broadcast();
    return { tabId: fork.tabId };
  }

  /** Stops a live child and waits for it to be reaped, escalating once. */
  private async killAndReap(tabId: string, entry: LiveEntry): Promise<void> {
    entry.suppressExit = true;
    if (await this.reapWithEscalation(entry)) return;
    entry.suppressExit = false;
    throw new Error(`session ${tabId} did not exit — its files were left alone`);
  }

  async switchMode(tabId: string, mode: SessionMode): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record || record.mode === mode) return;
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) {
      this.deps.registry.updateSession(tabId, { mode });
      await this.deps.broadcast();
      return;
    }
    await this.relaunch(entry, {
      projectCwd: record.projectCwd,
      mode,
      advisor: record.advisor,
      cols: 80,
      rows: 24,
      resumeTabId: tabId,
    });
  }

  /** Reaps a live session and then spawns it again with `--resume`. */
  private async relaunch(entry: LiveEntry, req: SpawnRequest): Promise<void> {
    const tabId = req.resumeTabId!;
    await this.killAndReap(tabId, entry);
    this.live.delete(tabId);
    try {
      await this.spawn(req);
    } catch (err) {
      // -1 is the same code spawnRpc's own exit path uses for "no status".
      this.deps.send(CH.onPtyExit, tabId, -1);
      await this.deps.broadcast();
      throw err;
    }
  }
}
