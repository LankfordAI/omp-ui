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
  modelStreamCheckpointLabel,
  isWithin,
  parseModelRole,
  parsePlanReviewTitle,
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
  watchLineageDir,
  writeAdvisorOverlay,
  writeAdvisorStatsExtension,
  writeMcpStatusExtension,
  writeDefaultModelOverlay,
  writeImageToScratch,
  writePlanExtension,
  PLAN_EXECUTE,
  MAX_IMAGE_BYTES,
  type ConsoleProgram,
  type ImageAttachment,
  type OwnedSessionRecord,
  type PlanImplementationSource,
  type PendingPlan,
  type PlanSettle,
  type PtyHandle,
  type SessionMode,
  type SessionWorktree,
  type SpawnRequest,
} from "@omp-ui/core";

interface LiveEntry {
  kind: SessionMode;
  pty?: PtyHandle;
  rpc?: RpcClient;
  record: OwnedSessionRecord;
  /** Suppresses this process's pty:exit — set for a mode-switch kill and for a delete. */
  suppressExit?: boolean;
  /** Detaches the pty:data listener — a killed process must not write into its successor. */
  detachPtyData?: () => void;
  /** Resolves once the child's exit has been observed. */
  readonly exited: Promise<void>;
  /** Resolver for `exited`, called from the exit handler. */
  readonly markExited: () => void;
  // --- hibernation bookkeeping (issue #246) ---
  /** True once the first frame has arrived; the idle clock arms only then. */
  hibernateArmed: boolean;
  /** agent_start minus agent_end; >0 means a turn is running. */
  turnsRunning: number;
  /** Set by notePlanVerdict; cleared by the next agent_end or (lazily) once
   * lapsed — a check is scheduled at the lapse so quiet sessions lapse too
   * (issue #247). */
  settleSuspendedUntil: number | null;
  /** In-flight pre-kill probe; matched against the response frame's id. */
  probeId: string | null;
  probeResolve: ((state: { parked: number; streaming: boolean } | null) => void) | null;
  // --- stream-stall watchdog bookkeeping (issue #248, reworked in #253) ---
  /** Start of the currently eligible model-stream silence interval. */
  stallSilenceSince: number | null;
  /** Open local tool executions; the silence clock is suspended while > 0. */
  openToolCount: number;
  /** Label of the last model-stream checkpoint, for the abort notice. */
  stallCheckpointLabel: string | null;
  /** Turns this live process has had aborted as stalled; appears in the notice. */
  stallAbortCount: number;
}

function liveEntry(
  fields: Omit<
    LiveEntry,
    | "exited"
    | "markExited"
    | "hibernateArmed"
    | "turnsRunning"
    | "settleSuspendedUntil"
    | "probeId"
    | "probeResolve"
    | "stallSilenceSince"
    | "openToolCount"
    | "stallCheckpointLabel"
    | "stallAbortCount"
  >,
): LiveEntry {
  // Executor form (not Promise.withResolvers): the node tsconfig lib is
  // ES2022, same convention as advisor-stats-live.test.ts.
  let markExited = (): void => {};
  const exited = new Promise<void>((resolve) => {
    markExited = () => resolve();
  });
  return {
    ...fields,
    exited,
    markExited,
    hibernateArmed: false,
    turnsRunning: 0,
    settleSuspendedUntil: null,
    probeId: null,
    probeResolve: null,
    stallSilenceSince: null,
    openToolCount: 0,
    stallCheckpointLabel: null,
    stallAbortCount: 0,
  };
}

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
/** Stream-stall watchdog sweep cadence (issue #248). */
const STALL_WATCH_TICK_MS = 15_000;
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
/**
 * Min interval between sidebar broadcasts caused purely by session-file mtime
 * churn (issue #187). A mid-turn transcript rewrites its .jsonl constantly;
 * each rewrite used to trigger a full buildState + broadcast, so the renderer
 * re-rendered the whole shell at turn rate on top of the transcript stream.
 */
const WATCHER_BROADCAST_MS = 1_000;

export interface SessionManagerDependencies {
  registry: Registry;
  providerKeys: ProviderKeys;
  getOmpPath: () => string | null;
  getSessionsRoot: () => string;
  getArchiveRoot: () => string;
  getWorktreesRoot: () => string;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
}

/** One session's plan-review gate state, as observed from its frames. */
interface PlanGate {
  pending: PendingPlan | null;
  settle: PlanSettle | null;
}

/** The sole owner of live session children and their supporting process state. */
export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  /** Console-drawer shells keyed by tabId (issue #42) — outside `live` on purpose. */
  private readonly shells = new Map<string, { handle: PtyHandle; detachData: () => void }>();
  private readonly watchers = new Map<string, () => void>();
  /**
   * In-flight resume spawns, keyed by tab — registered before the first await
   * (double-click race). The value settles when the spawn does, so a delete
   * arriving mid-spawn can wait for the process to exist and then kill it.
   */
  private readonly spawning = new Map<string, Promise<void>>();
  /**
   * Live plan-review gates, keyed by tabId (issue #215). In-memory: they die
   * with the process, so a gate can never outlive its agent.
   */
  private readonly planGates = new Map<string, PlanGate>();
  /** Idle-kill timers, keyed by tabId (issue #246). */
  private readonly hibernateTimers = new Map<string, NodeJS.Timeout>();
  /**
   * In-flight hibernation reaps, keyed by tabId (same race pattern as
   * `spawning`): a resume issued mid-reap waits for the entry to leave
   * `live` instead of deduping against the dying process.
   */
  private readonly hibernating = new Map<string, Promise<void>>();
  /** Unanswered extension_ui_request ids per tab (plan reviews included). */
  private readonly openExtensionRequests = new Map<string, Set<string>>();
  /** Turn-stall watchdog sweep; one interval for all live tabs (issue #248). */
  private stallWatchInterval: NodeJS.Timeout | undefined;
  /** Throttle state for mtime-only watcher broadcasts (issue #187). */
  private watcherBroadcastAt = 0;
  private watcherBroadcastTimer: NodeJS.Timeout | undefined;

  constructor(private readonly deps: SessionManagerDependencies) {}

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
    for (const record of this.deps.registry.sessions) this.startWatcher(record);
    await this.deps.broadcast();
  }

  stopProjectWatchers(projectCwd: string): void {
    for (const record of this.deps.registry.sessions) {
      if (record.projectCwd === projectCwd) this.stopWatcher(record.tabId);
    }
  }

  /** Kills every owned child and closes every lineage watcher. */
  killAll(): void {
    for (const entry of this.live.values()) this.killLive(entry);
    this.live.clear();
    for (const tabId of [...this.shells.keys()]) this.killShell(tabId);
    // Lineage watchers hold inotify fds; quit is the one path that must not
    // leave them to the OS — a cancelled quit keeps the app alive without them.
    for (const dispose of this.watchers.values()) dispose();
    this.watchers.clear();
    if (this.watcherBroadcastTimer !== undefined) {
      clearTimeout(this.watcherBroadcastTimer);
      this.watcherBroadcastTimer = undefined;
    }
    for (const timer of this.hibernateTimers.values()) clearTimeout(timer);
    this.hibernateTimers.clear();
    this.openExtensionRequests.clear();
    if (this.stallWatchInterval !== undefined) {
      clearInterval(this.stallWatchInterval);
      this.stallWatchInterval = undefined;
    }
    this.streamStalledTabs.clear();
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
   * Terminate's child gets the same SIGTERM→grace→SIGKILL treatment delete and
   * relaunch get through killAndReap — a wedged omp that ignores SIGTERM must
   * not hold its pipes/pty (and its MCP grandchildren) forever (issue #182,
   * the #64 residual). Unlike killAndReap this never suppresses the exit and
   * never throws: the renderer still learns the session ended via the normal
   * onExit → broadcast.
   */
  private async escalateOnTerminate(tabId: string, entry: LiveEntry): Promise<void> {
    if (await settledWithin(entry.exited, GRACEFUL_EXIT_MS)) return;
    entry.pty?.kill("SIGKILL");
    entry.rpc?.kill("SIGKILL");
    if (await settledWithin(entry.exited, SIGKILL_EXIT_MS)) return;
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
          await addWorktree(
            req.projectCwd, worktreePath, req.worktree.branch, req.worktree.baseRef);
          worktree = { path: worktreePath, branch: req.worktree.branch };
        }
        const project = this.deps.registry.projects.find((p) => p.path === req.projectCwd);
        record = this.deps.registry.addSession({
          tabId: randomUUID(),
          sessionId: null,
          lineageDir: mintLineageDirName(req.projectCwd),
          projectCwd: req.projectCwd,
          worktree,
          planImplementationSource,
          launchedAt: new Date().toISOString(),
          mode: req.mode,
          model: project?.lastModel ?? null,
          thinkingLevel: project?.lastThinkingLevel ?? null,
          advisor: req.advisor,
          advisorModel: req.advisorModel ?? null,
          cachedTitle: null,
          cachedModified: null,
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
        (req.resumeTabId === undefined && this.deps.registry.defaultAgentMode === "plan");
      return req.mode === "rpc-ui"
        ? this.spawnRpc(record, startInPlanMode, ompPath)
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
    ptyHandle.onExit(({ exitCode }) => {
      entry.markExited();
      // Identity-checked: a mode-switch respawn may already have replaced
      // this entry — deleting then would orphan the new live session.
      if (this.live.get(record.tabId) === entry) {
        this.live.delete(record.tabId);
        this.clearHibernateState(record.tabId);
      }
      if (!entry.suppressExit) this.deps.send(CH.onPtyExit, record.tabId, exitCode);
      void this.deps.broadcast();
    });
    this.startWatcher(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
  }

  private spawnRpc(
    record: OwnedSessionRecord,
    startInPlanMode: boolean,
    ompPath: string,
  ): { tabId: string } {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    // Exactly like PTY (ADR-0003) — and the dir must exist for the watcher.
    fs.mkdirSync(absLineageDir, { recursive: true });
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
    if (startInPlanMode) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-mode-${randomUUID()}`,
        message: planMessage(true, this.deps.registry.planFormat),
      });
    }
    entry.rpc = new RpcClient({
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      advisor: record.advisor,
      configOverlays: this.configOverlays(record, absLineageDir),
      extensions,
      initialCommands,
      onFrame: (frame) => {
        // Hibernation observation precedes the fan-out: the idle clock sees
        // every frame, probe responses included (issue #246).
        this.observeHibernation(record.tabId, frame);
        // Recording precedes fan-out: the gate must be set before the first
        // broadcast can read it (issue #215).
        this.seePlanFrame(record.tabId, frame);
        // Stall watchdog (issue #248): arm the sweep on the first turn and
        // timestamp model-stream activity.
        if (
          typeof frame === "object" &&
          frame !== null &&
          (frame as Record<string, unknown>).type === "agent_start"
        ) {
          this.ensureStallWatch();
        }
        this.observeStallActivity(entry, frame);
        this.deps.send(CH.onRpcFrame, record.tabId, frame);
      },
      onExit: (code) => {
        this.clearPlanGate(record.tabId);
        entry.markExited();
        if (this.live.get(record.tabId) === entry) {
          this.live.delete(record.tabId);
          this.clearHibernateState(record.tabId);
        }
        if (!entry.suppressExit) this.deps.send(CH.onPtyExit, record.tabId, code ?? -1);
        void this.deps.broadcast();
      },
      onError: (msg) =>
        this.deps.send(CH.onRpcFrame, record.tabId, { type: "omp_ui_error", message: msg }),
    });
    this.live.set(record.tabId, entry);
    // A fresh process owes no stall badge: the wedge died with the old one.
    this.streamStalledTabs.delete(record.tabId);
    this.startWatcher(record);
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
    const model = record.model ?? null;
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
    startInPlanMode: boolean,
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
      startInPlanMode,
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
    await addWorktree(record.projectCwd, worktreePath, branch, baseRef);
    this.deps.registry.updateSession(tabId, { worktree: { path: worktreePath, branch } });
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
    await Promise.resolve();
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
    return this.planGates.get(tabId);
  }

  /** Records a proposal as soon as its frame passes through the session. */
  private seePlanFrame(tabId: string, frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    if (f.type !== "extension_ui_request") return;
    const review = parsePlanReviewTitle(typeof f.title === "string" ? f.title : undefined);
    if (review === null) return;
    const frameId = typeof f.id === "string" ? f.id : "";
    this.planGates.set(tabId, {
      pending: {
        title: review.title,
        planFilePath: review.planFilePath,
        planAbsPath: review.planAbsPath,
        frameId,
        proposedAt: new Date().toISOString(),
      },
      settle: null, // a fresh gate replaces the last cycle's verdict
    });
    void this.deps.broadcast();
  }

  /** Settles the gate when its select answer comes back from any renderer. */
  private notePlanVerdict(tabId: string, cmd: object): void {
    const c = cmd as Record<string, unknown>;
    if (c.type !== "extension_ui_response") return;
    const id = typeof c.id === "string" ? c.id : null;
    const gate = this.planGates.get(tabId);
    if (id === null || !gate || gate.pending === null || gate.pending.frameId !== id) return;
    this.planGates.set(tabId, {
      pending: null,
      settle: { frameId: id, verdict: c.value === PLAN_EXECUTE ? "executed" : "refined" },
    });
    // Between the verdict and the implementation prompt the process is
    // momentarily quiet; suspend hibernation until the next agent_end (or
    // the window lapses) (issue #246).
    const entry = this.live.get(tabId);
    if (entry !== undefined) {
      entry.settleSuspendedUntil = Date.now() + SETTLE_WINDOW_MS;
      // A rejected plan leaves the session silent — no frame would re-arm
      // the check, so schedule one at the window's lapse (issue #247). Any
      // real frame re-arms over it and resets the clock.
      this.scheduleHibernateCheck(tabId, SETTLE_WINDOW_MS);
    }
    void this.deps.broadcast();
  }

  /** Drops the gate on every path where the live process ends. */
  clearPlanGate(tabId: string): void {
    if (this.planGates.delete(tabId)) void this.deps.broadcast();
  }

  // --- Hibernation: idle rpc-ui sessions are killed and left dormant, then
  // --- woken through the ordinary resume path (issue #246). ---

  /** Clears hibernation bookkeeping on every path where a tab leaves `live`. */
  private clearHibernateState(tabId: string): void {
    clearTimeout(this.hibernateTimers.get(tabId));
    this.hibernateTimers.delete(tabId);
    this.openExtensionRequests.delete(tabId);
    this.streamStalledTabs.delete(tabId);
  }

  // --- Stream-stall watchdog: abort a turn whose model stream has gone
  // --- silently dead (issue #248). Display-only detection (#228) assumed
  // --- omp's idle watchdog recovers stalls; OpenRouter's SSE keep-alives
  // --- defeat it, so main carries the backstop. ---

  /** Tabs whose current live process had a turn aborted as stalled; sidebar
   * badge state. Lasts until the next turn starts (issue #255), a respawn,
   * or exit. */
  private readonly streamStalledTabs = new Set<string>();

  /** Whether the stall watchdog has aborted a turn on this live process. */
  isStreamStalled(tabId: string): boolean {
    return this.streamStalledTabs.has(tabId);
  }

  /**
   * Tracks whether a model request is in flight on the live entry, and the
   * start of the currently eligible silence interval. Called from the rpc
   * onFrame path after hibernation observation; model-stream classification
   * is shared with the renderer's stall indicator (core/stream-activity) so
   * both watchdogs judge "stream activity" identically. Local tool
   * execution suspends the clock outright (issue #253): omp owns tool
   * deadlines, and a build or hub wait is legitimately quiet on the
   * provider stream for as long as it runs.
   */
  private observeStallActivity(entry: LiveEntry, frame: unknown): void {
    if (typeof frame !== "object" || frame === null) return;
    const type = (frame as Record<string, unknown>).type;
    switch (type) {
      // No tool execution survives a turn boundary. An abort's teardown can
      // skip end frames for refused tools; a leaked count would suppress
      // the watchdog for the whole next turn.
      case "agent_start":
      case "agent_end":
        entry.openToolCount = 0;
        return;
      case "tool_execution_start":
        entry.openToolCount++;
        return;
      case "tool_execution_update":
        // A lost start frame must not leave the clock running against a
        // live tool; an update proves one is open.
        if (entry.openToolCount === 0) entry.openToolCount = 1;
        return;
      case "tool_execution_end":
        // Ghost ends (no matching start) exist; the transcript reducer
        // tolerates them too. Never let one underflow or rebase.
        if (entry.openToolCount === 0) return;
        entry.openToolCount--;
        if (entry.openToolCount === 0) {
          // The next model request starts here: give it a full window,
          // exactly like the "human answer received" rebase in rpcSend.
          entry.stallSilenceSince = Date.now();
          entry.stallCheckpointLabel = "tool execution finished";
        }
        return;
      // omp is legitimately quiet during compaction and retry backoff.
      // Rebase — never suspend: a wedged compaction/retried stream is a
      // real stall and must still trip the watchdog one window later.
      case "auto_compaction_start":
        entry.stallSilenceSince = Date.now();
        entry.stallCheckpointLabel = "compaction started";
        return;
      case "auto_compaction_end":
        entry.stallSilenceSince = Date.now();
        entry.stallCheckpointLabel = "compaction finished";
        return;
      case "auto_retry_start":
        entry.stallSilenceSince = Date.now();
        entry.stallCheckpointLabel = "retry scheduled";
        return;
      case "auto_retry_end":
        entry.stallSilenceSince = Date.now();
        entry.stallCheckpointLabel = "retry settled";
        return;
    }
    const label = modelStreamCheckpointLabel(frame);
    if (label !== null) {
      entry.stallSilenceSince = Date.now();
      entry.stallCheckpointLabel = label;
    }
  }

  /**
   * One ticking sweep for every live rpc tab. Arms lazily on the first turn
   * and unrefs: housekeeping must never hold the process open. Every sweep
   * re-reads the setting, so a Settings change applies at the next tick.
   */
  private ensureStallWatch(): void {
    if (this.stallWatchInterval !== undefined) return;
    this.stallWatchInterval = setInterval(() => this.checkStreamStalls(), STALL_WATCH_TICK_MS);
    if (typeof this.stallWatchInterval.unref === "function") this.stallWatchInterval.unref();
  }

  /**
   * Aborts turns whose model stream has been silent past the configured
   * window. Guards: only a running turn with no pending human answer can
   * stall, and open tool executions suspend the check outright.
   */
  private checkStreamStalls(): void {
    const thresholdSeconds = this.deps.registry.streamStallAbortSeconds;
    if (thresholdSeconds <= 0) return;
    for (const [tabId, entry] of this.live) {
      if (entry.kind !== "rpc-ui") continue;
      if (entry.turnsRunning === 0) continue;
      if (this.awaitingHumanAnswer(tabId)) continue;
      // A running local tool is legitimately quiet on the provider stream —
      // a build, a test suite, a hub wait. While one is open the model owes
      // nothing, however long it runs (issue #253).
      if (entry.openToolCount > 0) continue;
      const silenceSince = entry.stallSilenceSince;
      if (silenceSince === null) continue;
      const now = Date.now();
      const quietMs = now - silenceSince;
      if (quietMs < thresholdSeconds * 1_000) continue;
      this.abortStalledTurn(tabId, entry, quietMs, thresholdSeconds);
    }
  }

  /**
   * Sends the abort and surfaces the notice. The turn's agent_end (or the
   * child's refusal) settles the transcript's own status; the watchdog does
   * not touch hibernation state — agent_end already clears turnsRunning.
   */
  private abortStalledTurn(
    tabId: string,
    entry: LiveEntry,
    quietMs: number,
    thresholdSeconds: number,
  ): void {
    const rpc = entry.rpc;
    if (rpc === undefined) return;
    // First fire wins: the notice quotes the silence observed at abort time.
    // Resetting the clock now is also what stops a refused abort from
    // re-firing every tick.
    entry.stallSilenceSince = null;
    entry.stallAbortCount += 1;
    this.streamStalledTabs.add(tabId);
    rpc.send({ type: "abort" });
    const minutes = Math.floor(thresholdSeconds / 60);
    const since = entry.stallCheckpointLabel ?? "unknown";
    this.deps.send(CH.onRpcFrame, tabId, {
      type: "omp_ui_notice",
      level: "warn",
      source: "omp-ui",
      // Machine-readable: the renderer feeds this abort into stall
      // auto-continue (issue #254) — the turn end it produces reads
      // "aborted", which isStreamStallEnd can never classify.
      reason: "stall-abort",
      message:
        `omp-ui aborted a stalled turn #${entry.stallAbortCount} — no model-stream activity ` +
        `for ${Math.round(quietMs / 1_000)}s (last: ${since}; window ${minutes}m). ` +
        `omp's provider watchdog never fired — OpenRouter's stream keep-alives can defeat it. ` +
        `Stall auto-continue resumes the turn if enabled; any prompt also continues it. ` +
        `Tune or disable under Settings → General → stall watchdog.`,
    });
    void this.deps.broadcast();
  }

  /**
   * Every rpc frame updates hibernation state in one place and re-arms the
   * idle clock. The setting is re-read on every arm, so a Settings change
   * takes effect at the next activity — no separate re-arm path.
   */
  private observeHibernation(tabId: string, frame: unknown): void {
    const entry = this.live.get(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    if (typeof frame !== "object" || frame === null) return;
    const f = frame as Record<string, unknown>;
    // The probe's own response: settle it and do NOT reset the idle clock —
    // probe traffic is our own, and resetting would postpone every hibernation
    // attempt by its own probe.
    if (f.type === "response" && entry.probeId !== null && f.id === entry.probeId) {
      entry.probeId = null;
      const resolve = entry.probeResolve;
      entry.probeResolve = null;
      if (resolve === null) return;
      if (f.success === false) {
        resolve(null);
        return;
      }
      // Command responses nest their payload under `data` (same tolerant
      // unwrap as the renderer's respData).
      const data =
        f.data !== null && typeof f.data === "object"
          ? (f.data as Record<string, unknown>)
          : f;
      const parked =
        typeof data.queuedMessageCount === "number" &&
        Number.isFinite(data.queuedMessageCount)
          ? data.queuedMessageCount
          : 0;
      resolve({ parked, streaming: data.isStreaming === true });
      return;
    }
    switch (f.type) {
      case "agent_start":
        entry.turnsRunning++;
        // The stalled badge is a call-to-action ("prompt to continue"); a
        // new turn is that continuation, whoever sent it (issue #255).
        if (this.streamStalledTabs.delete(tabId)) void this.deps.broadcast();
        break;
      case "agent_end":
        entry.turnsRunning = Math.max(0, entry.turnsRunning - 1);
        if (entry.settleSuspendedUntil !== null) entry.settleSuspendedUntil = null;
        break;
      case "extension_ui_request":
        // Only user-answer dialogs block hibernation; the other methods are
        // fire-and-forget state frames the renderer never replies to.
        if (typeof f.id === "string" && BLOCKING_DIALOG_METHODS[String(f.method)] === true) {
          let open = this.openExtensionRequests.get(tabId);
          if (open === undefined) {
            open = new Set<string>();
            this.openExtensionRequests.set(tabId, open);
          }
          open.add(f.id);
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
    if (this.planGates.get(tabId)?.pending != null) return true;
    return (this.openExtensionRequests.get(tabId)?.size ?? 0) > 0;
  }

  /** True when a kill cannot lose work or an in-flight exchange. */
  private hibernable(entry: LiveEntry, tabId: string): boolean {
    if (entry.kind !== "rpc-ui") return false;
    if (!entry.hibernateArmed) return false; // still booting
    if (entry.turnsRunning > 0) return false; // mid-turn
    if (this.awaitingHumanAnswer(tabId)) return false; // plan/dialog awaiting an answer
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
    this.scheduleHibernateCheck(tabId, this.deps.registry.hibernateIdleMinutes * 60_000);
  }

  /**
   * One pending check per tab; a 0 setting means no check at all. Unref'd:
   * a housekeeping timer must never hold the process open (quit clears them
   * anyway via killAll), and tests that verdict/arm without fake timers must
   * not leak a 30-minute real timer into the worker teardown.
   */
  private scheduleHibernateCheck(tabId: string, delayMs: number): void {
    clearTimeout(this.hibernateTimers.get(tabId));
    if (this.deps.registry.hibernateIdleMinutes <= 0) return;
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
   * Idle window elapsed: re-check every guard, probe, then kill and reap.
   * Every no-kill exit re-arms (issue #247): guards lapse on their own
   * clocks, and a quiet session has no frames to re-arm the check.
   */
  private async tryHibernate(tabId: string): Promise<void> {
    this.hibernateTimers.delete(tabId);
    // The setting may have flipped to off since the timer armed.
    if (this.deps.registry.hibernateIdleMinutes <= 0) return;
    const entry = this.live.get(tabId);
    if (!entry || entry.kind !== "rpc-ui") return;
    if (!this.hibernable(entry, tabId)) {
      this.armHibernateTimer(tabId); // guard in force: re-examine next window
      return;
    }
    const state = await this.probeState(entry);
    // The tab may have died or been replaced while the probe was out, and
    // the setting may have flipped off — kill only what the current config
    // wants, and never hibernate a stale entry (its exit path already ran).
    if (this.deps.registry.hibernateIdleMinutes <= 0) return;
    if (this.live.get(tabId) !== entry) return; // its own paths arm fresh
    if (state === null || state.parked > 0 || state.streaming) {
      // Probe hiccup or not really idle: never kill on uncertainty (#246),
      // but do not drop the clock either (#247).
      this.armHibernateTimer(tabId);
      return;
    }
    // Re-check after the probe round-trip: a prompt that landed while we
    // probed starts a turn the probe's snapshot cannot see.
    if (!this.hibernable(entry, tabId)) {
      this.armHibernateTimer(tabId);
      return;
    }
    const reap = this.hibernate(tabId, entry);
    this.hibernating.set(tabId, reap);
    try {
      await reap;
    } finally {
      this.hibernating.delete(tabId);
    }
  }

  /**
   * SIGTERM → grace → SIGKILL. Emits `session:hibernated` only after the reap
   * succeeds, so a renderer that sees it never races a live process. If the
   * child outlives SIGKILL the outcome goes back to the normal exit path.
   */
  private async hibernate(tabId: string, entry: LiveEntry): Promise<void> {
    entry.suppressExit = true;
    this.killLive(entry);
    if (await settledWithin(entry.exited, GRACEFUL_EXIT_MS)) {
      this.deps.send(CH.onSessionHibernated, tabId);
      void this.deps.broadcast();
      return;
    }
    entry.pty?.kill("SIGKILL");
    entry.rpc?.kill("SIGKILL");
    if (await settledWithin(entry.exited, SIGKILL_EXIT_MS)) {
      this.deps.send(CH.onSessionHibernated, tabId);
      void this.deps.broadcast();
      return;
    }
    entry.suppressExit = false;
    console.warn(`[sessions] ${tabId}: hibernation kill ignored by child; leaving it live`);
  }

  rpcSend(tabId: string, cmd: object): void {
    const wasAwaitingHuman = this.awaitingHumanAnswer(tabId);
    this.notePlanVerdict(tabId, cmd);
    const c = cmd as Record<string, unknown>;
    if (c.type === "extension_ui_response" && typeof c.id === "string") {
      this.openExtensionRequests.get(tabId)?.delete(c.id);
    }
    const entry = this.live.get(tabId);
    if (
      wasAwaitingHuman &&
      !this.awaitingHumanAnswer(tabId) &&
      entry?.kind === "rpc-ui" &&
      entry.turnsRunning > 0
    ) {
      entry.stallSilenceSince = Date.now();
      entry.stallCheckpointLabel = "human answer received";
    }
    entry?.rpc?.send(cmd);
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
    this.killLive(entry);
    void this.escalateOnTerminate(tabId, entry);
    // The record stays; the broadcast fires on process exit.
  }

  /** Erases a session's record and files after its child is fully reaped. */
  async deleteSession(tabId: string): Promise<void> {
    const inFlight = this.spawning.get(tabId);
    if (inFlight) await inFlight;
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stopWatcher(tabId);
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
      this.startWatcher(record);
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
      worktree: source.worktree ?? null,
      launchedAt: new Date().toISOString(),
      mode: source.mode,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
      advisor: source.advisor,
      advisorModel: source.advisorModel,
      cachedTitle: source.cachedTitle,
      cachedModified: new Date().toISOString(),
    });
    await this.deps.broadcast();
    return { tabId: fork.tabId };
  }

  /** Stops a live child and waits for it to be reaped, escalating once. */
  private async killAndReap(tabId: string, entry: LiveEntry): Promise<void> {
    entry.suppressExit = true;
    this.killLive(entry);
    if (await settledWithin(entry.exited, GRACEFUL_EXIT_MS)) return;
    entry.pty?.kill("SIGKILL");
    entry.rpc?.kill("SIGKILL");
    if (await settledWithin(entry.exited, SIGKILL_EXIT_MS)) return;
    // Un-suppress: the process outlived us, so the tab is still live and the
    // renderer must keep showing it that way.
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

  private startWatcher(record: OwnedSessionRecord): void {
    this.stopWatcher(record.tabId);
    const absDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    if (!fs.existsSync(absDir)) return;
    this.watchers.set(
      record.tabId,
      watchLineageDir(absDir, (event) => {
        if (event.kind === "vanished") {
          this.stopWatcher(record.tabId);
          void this.deps.broadcast();
          return;
        }
        void this.onSessionFile(record.tabId, event.filePath);
      }),
    );
  }

  private stopWatcher(tabId: string): void {
    this.watchers.get(tabId)?.();
    this.watchers.delete(tabId);
  }

  /**
   * Identity changes (first materialization, /new, /branch, a fresh title)
   * broadcast immediately; mtime-only churn is sidebar noise at turn rate and
   * gets a trailing throttle (issue #187).
   */
  private broadcastWatcherPatch(immediate: boolean): void {
    if (this.watcherBroadcastTimer !== undefined) {
      clearTimeout(this.watcherBroadcastTimer);
      this.watcherBroadcastTimer = undefined;
    }
    const wait = this.watcherBroadcastAt + WATCHER_BROADCAST_MS - Date.now();
    if (immediate || wait <= 0) {
      this.watcherBroadcastAt = Date.now();
      void this.deps.broadcast();
      return;
    }
    this.watcherBroadcastTimer = setTimeout(() => {
      this.watcherBroadcastTimer = undefined;
      this.watcherBroadcastAt = Date.now();
      void this.deps.broadcast();
    }, wait);
    this.watcherBroadcastTimer.unref?.();
  }

  /** First materialization, /new, /branch, title-slot rewrites → adopt + broadcast. */
  private async onSessionFile(tabId: string, filePath: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    try {
      const h = await hydrateSessionFile(filePath);
      const patch: Partial<Omit<OwnedSessionRecord, "tabId">> = {};
      if (h.id && h.id !== record.sessionId) patch.sessionId = h.id;
      const title = h.title?.trim() ? h.title : null;
      if (title !== record.cachedTitle) patch.cachedTitle = title;
      const modified = h.mtime.toISOString();
      if (modified !== record.cachedModified) patch.cachedModified = modified;
      if (Object.keys(patch).length > 0) {
        this.deps.registry.updateSession(tabId, patch);
        this.broadcastWatcherPatch(
          patch.sessionId !== undefined || patch.cachedTitle !== undefined,
        );
      }
    } catch {
      // Mid-write or vanished — the next event (or state rebuild) retries.
    }
  }
}
