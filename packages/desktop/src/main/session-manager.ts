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
  mintLineageDirName,
  mintWorktreePath,
  isWithin,
  linkProjectOmpDir,
  mcpRuntimeStatusMessage,
  planMessage,
  planHandoffDescendants,
  settledWithin,
  type ProviderKeys,
  type Registry,
  removeWorktree,
  removeWorktreeBranch,
  resolveSessionLocation,
  RpcClient,
  spawnOmp,
  spawnOmpTui,
  spawnShell,
  writeImageToScratch,
  MAX_IMAGE_BYTES,
  type ConsoleProgram,
  type DeleteSessionPreview,
  type ImageAttachment,
  type OwnedSessionRecord,
  type PlanImplementationSource,
  type PtyHandle,
  type RpcFrame,
  type SessionMode,
  type SessionWorktree,
  type SpawnRequest,
  type WorktreeReleaseResult,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";
import { liveEntry, type LiveEntry } from "./live-entry";
import { HibernationTracker } from "./hibernation-tracker";
import { PlanGateTracker, type PlanGate } from "./plan-gate-tracker";
import { prepareResumeRecord, writeRpcExtensions, writeRpcOverlays, writeSessionOverlays } from "./spawn-config";
import { StallWatchdog } from "./stall-watchdog";
import { TurnCounter } from "./turns";
import { ViewTracker } from "./view-tracker";
import { WatcherHub } from "./watcher-hub";


/** How long omp gets to exit on its own before the delete escalates. */
const GRACEFUL_EXIT_MS = 3_000;
const SIGKILL_EXIT_MS = 2_000;

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

type OpKind = "spawn" | "delete" | "hibernate" | "relaunch";

/** The sole owner of live session children and their supporting process state. */
export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  /** Running turns per tab — the cross-concern datum (hibernation + stall). */
  private readonly turns = new TurnCounter();
  /** Console-drawer shells keyed by tabId (issue #42) — outside `live` on purpose. */
  private readonly shells = new Map<string, { handle: PtyHandle; detachData: () => void }>();
  /** Lineage-dir watchers and their throttled sidebar broadcast (issue #187). */
  private readonly watcherHub: WatcherHub;
  /** Fresh tab:viewed reports keyed by renderer clientId (issue #266). */
  private readonly viewTracker: ViewTracker;
  /**
   * Per-tab serialized op chain (issue #297): spawn, delete, hibernate, and
   * relaunch for one tab never overlap. Replaces the `spawning`/`hibernating`
   * maps; a newcomer enqueues behind the in-flight op instead of waiting on
   * a promise it cannot reason about.
   */
  private readonly ops = new Map<string, { kind: OpKind; chain: Promise<void> }>();
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
  /** Idle hibernation, owned by the tracker (issue #246). */
  private readonly hibernation: HibernationTracker;
  /** Model-stream stall watchdog (issue #248): the sweep and the per-tab silence records. */
  private readonly stallWatchdog: StallWatchdog;

  constructor(private readonly deps: SessionManagerDependencies) {
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
    });
    this.planGates = new PlanGateTracker({
      registry: deps.registry,
      broadcast: () => deps.broadcast(),
      attention: deps.attention,
      suspendForVerdict: (tabId) => this.hibernation.suspendForVerdict(tabId),
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
    this.frameObservers = [this.hibernation, this.planGates, this.stallWatchdog];
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
    this.hibernation.disposeAll();
    this.stallWatchdog.disposeAll();
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

  /**
   * A worktree reuse (plan handoff, issue #316) is valid only for a fresh
   * session into a checkout that still exists under the worktrees root:
   * the record's field is the source of truth, and a vanished checkout
   * fails loudly the way a worktree-session resume does (ADR-0018).
   */
  private validateWorktreeReuse(req: SpawnRequest): SessionWorktree | null {
    const reuse = req.worktreeReuse;
    if (reuse === undefined) return null;
    if (req.resumeTabId !== undefined) {
      throw new Error("a worktree reuse cannot be attached when resuming a session");
    }
    if (req.worktree !== undefined) {
      throw new Error("worktree and worktreeReuse are mutually exclusive");
    }
    if (typeof reuse.path !== "string" || reuse.path === "") {
      throw new Error("worktree reuse path must be a non-empty string");
    }
    if (typeof reuse.branch !== "string" || reuse.branch === "") {
      throw new Error("worktree reuse branch must be a non-empty string");
    }
    if (reuse.base !== null && typeof reuse.base !== "string") {
      throw new Error("worktree reuse base must be a string or null");
    }
    if (!isWithin(this.deps.getWorktreesRoot(), reuse.path) || !fs.existsSync(reuse.path)) {
      throw new Error(
        "the planning session's worktree checkout is gone — delete the planning session from the sidebar",
      );
    }
    return { ...reuse };
  }

  /** The tab's current op, if any; its kind decides how a newcomer behaves. */
  private pendingOp(tabId: string): { kind: OpKind; chain: Promise<void> } | undefined {
    return this.ops.get(tabId);
  }

  /**
   * Runs `work` after any pending op for the tab settles. The stored chain
   * swallows rejection so a failed op never poisons the next one (mirrors
   * remote-server's #enqueue); the caller keeps the real result or error.
   */
  private enqueueOp<T>(tabId: string, kind: OpKind, work: () => Promise<T>): Promise<T> {
    const prev = this.ops.get(tabId)?.chain;
    const run: Promise<T> = prev === undefined ? work() : prev.then(() => work());
    const chain = run.then(
      () => undefined,
      () => undefined,
    );
    this.ops.set(tabId, { kind, chain });
    // Drop the entry once this chain is no longer the head of the tab's.
    void chain.then(() => {
      if (this.ops.get(tabId)?.chain === chain) this.ops.delete(tabId);
    });
    return run;
  }

  async spawn(req: SpawnRequest): Promise<{ tabId: string }> {
    if (!req.resumeTabId) return this.spawnInner(req);
    const tabId = req.resumeTabId;
    const pending = this.pendingOp(tabId);
    // A resume during an in-flight spawn dedupes: the first click owns the
    // process (double-click race).
    if (pending?.kind === "spawn") return { tabId };
    // A resume during a pending delete/hibernate/relaunch queues behind it:
    // a spawn queued behind a delete learns "unknown session tab" from the
    // registry, not from a half-gone live map.
    if (pending === undefined && this.live.has(tabId)) return { tabId };
    return this.enqueueOp(tabId, "spawn", () => this.spawnInner(req));
  }

  /** The spawn proper: runs behind any pending op for the tab. */
  private async spawnInner(req: SpawnRequest): Promise<{ tabId: string }> {
    const planImplementationSource = this.validatePlanImplementationSource(req);
    const worktreeReuse = this.validateWorktreeReuse(req);
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
      // A resume queued behind a relaunch collapses to a dedupe: the
      // relaunch's own spawn already owns the respawn.
      if (this.live.has(req.resumeTabId)) return { tabId: req.resumeTabId };
      const existing = this.deps.registry.sessions.find((s) => s.tabId === req.resumeTabId);
      if (!existing) throw new Error(`unknown session tab ${req.resumeTabId}`);
      record = await prepareResumeRecord(existing, {
        sessionsRoot: this.deps.getSessionsRoot(),
        archiveRoot: this.deps.getArchiveRoot(),
        updateSession: (tabId, patch) => this.deps.registry.updateSession(tabId, patch),
      });
    } else {
      let worktree: SessionWorktree | null = null;
      if (worktreeReuse !== null) {
        // A plan handoff from a worktree planning session reuses the
        // planning checkout in place (issue #316): the record carries the
        // descriptor verbatim, no mint, no canonical re-derivation.
        worktree = worktreeReuse;
      } else if (req.worktree) {
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
  }

  private async spawnPty(
    record: OwnedSessionRecord,
    req: SpawnRequest,
    ompPath: string,
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    // A worktree session runs in its checkout, so omp resolves project-scope
    // config there; link the project's `.omp/` in so a project MCP toggle
    // reaches this session (issue #325). Every route into a checkout —
    // fresh spawn, convert, plan handoff, resume, relaunch — passes here.
    if (record.worktree !== null) {
      await linkProjectOmpDir(record.projectCwd, record.worktree.path);
    }
    const ptyHandle = spawnOmp({
      id: record.tabId,
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: writeSessionOverlays(record, absLineageDir),
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
    const { paths: extensions, mcpStatusLoaded } = writeRpcExtensions(absLineageDir);
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
    const configOverlays = await writeRpcOverlays(record, absLineageDir, ompPath);
    // See spawnPty: the checkout is where omp resolves project scope (#325).
    if (record.worktree !== null) {
      await linkProjectOmpDir(record.projectCwd, record.worktree.path);
    }
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

  /** Re-pins a session's advisor, relaunching a live child to apply it. */
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
    });
  }

  /** Restarts a live session in place so it picks up process-start config. */
  async restart(tabId: string): Promise<void> {
    return this.enqueueOp(tabId, "relaunch", async () => {
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
    return this.enqueueOp(tabId, "relaunch", async () => {
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
    });
  }

  /**
   * Returns a worktree session to its project checkout (issue #334), the
   * inverse of {@link convertToWorktree}: nulls the record's worktree, reclaims
   * the checkout and the now-merged branch, and respawns in place with
   * `--resume`. The session, its transcript, its lineage and its tab all
   * survive — only where it runs changes, and after a merge-back the project
   * checkout is already on the branch the worktree was cut from.
   *
   * Kill-before-demote: the child is reaped first, because the checkout cannot
   * be removed under it and `git branch -d` refuses a branch checked out
   * elsewhere. A child that will not die leaves the session a worktree session,
   * retryable. Cleanup failures are warnings, never fatal — the session must
   * come back up either way.
   */
  async releaseWorktree(tabId: string): Promise<WorktreeReleaseResult> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      const wt = record.worktree;
      if (!wt) throw new Error("session does not run in a worktree");
      let cleanup: Pick<WorktreeReleaseResult, "checkoutKept" | "branchOutcome"> = {
        checkoutKept: "failed",
        branchOutcome: "not-attempted",
      };
      const demote = async (): Promise<void> => {
        this.killShell(tabId);
        this.deps.registry.updateSession(tabId, { worktree: null });
        cleanup = await this.reclaimWorktree(record.projectCwd, wt, tabId);
      };
      const entry = this.live.get(tabId);
      if (!entry) {
        // A dormant restored tab: nothing holds the checkout, and its next
        // resume lands in the project checkout.
        await demote();
        await this.deps.broadcast();
      } else {
        await this.relaunch(
          entry,
          {
            projectCwd: record.projectCwd,
            mode: record.mode,
            advisor: record.advisor,
            advisorModel: record.advisorModel,
            cols: 80,
            rows: 24,
            resumeTabId: tabId,
          },
          demote,
        );
      }
      return {
        worktreePath: wt.path,
        branch: wt.branch,
        projectCwd: record.projectCwd,
        ...cleanup,
      };
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

  /** Whether the stall watchdog has aborted a turn on this live process. */
  isStreamStalled(tabId: string): boolean {
    return this.stallWatchdog.isStreamStalled(tabId);
  }

  /** True while plan review or a renderer-routed dialog awaits the user. */
  private awaitingHumanAnswer(tabId: string): boolean {
    if (this.planGates.pending(tabId)) return true;
    return this.hibernation.hasOpenRequests(tabId);
  }

  /**
   * Hibernates an idle planning source after a fresh implementation prompt
   * was accepted. The persisted handoff relation is the authorization
   * boundary; viewed-tab and post-verdict guards apply only to ordinary
   * idle hibernation.
   */
  hibernatePlanSource(sourceTabId: string, implementationTabId: string): Promise<boolean> {
    return this.enqueueOp(sourceTabId, "hibernate", () =>
      this.hibernation.attemptHandoff(sourceTabId, implementationTabId),
    );
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

  terminate(tabId: string): void {
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) return;
    void this.escalateOnTerminate(tabId, entry);
    // The record stays; the broadcast fires on process exit.
  }

  /**
   * Erases a session's record and files after its child is fully reaped.
   * With `cascade`, erases every plan-handoff descendant too (issue #309) —
   * each behind its own tab's op queue, so a pending resume of a live
   * descendant is not raced, and a per-session file failure leaves exactly
   * that record retryable.
   */
  async deleteSession(tabId: string, cascade: boolean): Promise<void> {
    const descendants = cascade
      ? planHandoffDescendants(this.deps.registry.sessions, tabId)
      : [];
    await Promise.all(
      [tabId, ...descendants].map((id) =>
        this.enqueueOp(id, "delete", () => this.deleteInner(id)),
      ),
    );
  }

  /**
   * Delete preview (issue #309): the descendants that would be erased with
   * `tabId`. Pure registry read; an unknown `tabId` resolves to no
   * descendants.
   */
  deleteSessionPreview(tabId: string): DeleteSessionPreview {
    const descendants = planHandoffDescendants(this.deps.registry.sessions, tabId);
    return {
      descendants: descendants.map((id) => {
        const record = this.deps.registry.sessions.find((s) => s.tabId === id)!;
        return {
          tabId: id,
          title: record.cachedTitle?.trim() || "New session",
          running: this.live.has(id),
        };
      }),
    };
  }

  /**
   * Removes a session's worktree checkout and deletes its branch, with the two
   * guards both callers need: another record still referencing the same
   * checkout (a fork, or a `worktreeReuse` plan handoff) keeps it, and a
   * non-canonical path is left for manual removal so a corrupt registry value
   * cannot steer the recursive fallback inside removeWorktree (branch ".."
   * mints to the root itself — isWithin rejects that).
   *
   * Never throws: the delete must finish and the release must come back up in
   * the project checkout either way, and the boot-time sweep
   * (sweepOrphanWorktrees) reclaims anything left behind.
   */
  private async reclaimWorktree(
    projectCwd: string,
    wt: SessionWorktree,
    tabId: string,
  ): Promise<Pick<WorktreeReleaseResult, "checkoutKept" | "branchOutcome">> {
    const worktreesRoot = this.deps.getWorktreesRoot();
    const canonical =
      wt.path === mintWorktreePath(worktreesRoot, projectCwd, wt.branch) &&
      isWithin(worktreesRoot, wt.path);
    if (!canonical) {
      console.warn(
        `[sessions] worktree path ${wt.path} does not match its minted location — leaving it for manual removal`,
      );
      return { checkoutKept: "non-canonical", branchOutcome: "not-attempted" };
    }
    const shared = this.deps.registry.sessions.some(
      (s) => s.tabId !== tabId && s.worktree?.path === wt.path,
    );
    if (shared) return { checkoutKept: "shared", branchOutcome: "not-attempted" };
    try {
      await removeWorktree(projectCwd, wt.path);
    } catch (err) {
      console.warn(`[sessions] worktree cleanup failed for ${wt.path}:`, err);
      return { checkoutKept: "failed", branchOutcome: "not-attempted" };
    }
    try {
      const outcome = await removeWorktreeBranch(projectCwd, wt.branch, wt.base);
      if (outcome.kind !== "removed") {
        console.warn(
          `[sessions] worktree branch ${wt.branch} kept (${outcome.kind}${outcome.detail ? `: ${outcome.detail}` : ""})`,
        );
      }
      return { checkoutKept: null, branchOutcome: outcome.kind };
    } catch (err) {
      console.warn(`[sessions] worktree branch cleanup failed for ${wt.branch}:`, err);
      return { checkoutKept: null, branchOutcome: "not-attempted" };
    }
  }

  /** The delete proper: runs behind any pending op for the tab. */
  private async deleteInner(tabId: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stallWatchdog.dispose(tabId);
    this.hibernation.dispose(tabId);
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
      await this.reclaimWorktree(record.projectCwd, record.worktree, tabId);
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
    return this.enqueueOp(tabId, "relaunch", async () => {
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
    });
  }

  /**
   * Reaps a live session and then spawns it again with `--resume`. `between`
   * runs after the child is dead and before the respawn — the only window in
   * which a session's checkout can be removed from under it.
   */
  private async relaunch(
    entry: LiveEntry,
    req: SpawnRequest,
    between?: () => Promise<void>,
  ): Promise<void> {
    const tabId = req.resumeTabId!;
    await this.killAndReap(tabId, entry);
    this.live.delete(tabId);
    if (between) await between();
    try {
      await this.spawnInner(req);
    } catch (err) {
      // -1 is the same code spawnRpc's own exit path uses for "no status".
      this.deps.send(CH.onPtyExit, tabId, -1);
      await this.deps.broadcast();
      throw err;
    }
  }
}
