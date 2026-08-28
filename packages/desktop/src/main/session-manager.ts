import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CH,
  parseSpawnRequest,
  addWorktree,
  base64Bytes,
  bracketedImagePaste,
  deleteSessionFiles,
  forkSessionFile,
  mintLineageDirName,
  mintWorktreePath,
  linkProjectOmpDir,
  isWithin,
  mcpRuntimeStatusMessage,
  planMessage,
  planHandoffDescendants,
  reclaimCheckouts as reclaimWorktreeCheckouts,
  settledWithin,
  type ProviderKeys,
  type Registry,
  resolveSessionLocation,
  RpcClient,
  spawnOmp,
  writeImageToScratch,
  MAX_IMAGE_BYTES,
  type ConsoleProgram,
  type DeleteSessionPreview,
  type DeleteSessionResult,
  type ImageAttachment,
  type OwnedSessionRecord,
  type RpcFrame,
  type ResumeSpawnRequest,
  type SessionMode,
  type SessionWorktree,
  type SpawnRequest,
  type WorktreeReleaseResult,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";
import {
  createPtyLiveEntry,
  createRpcLiveEntry,
  type LiveEntry,
  wirePtyData,
  wireRpc,
} from "./live-entry";
import { HibernationTracker } from "./hibernation-tracker";
import { PlanGateTracker, type PlanGate } from "./plan-gate-tracker";
import { prepareResumeRecord, writeRpcExtensions, writeRpcOverlays, writeSessionOverlays } from "./spawn-config";
import { StallWatchdog } from "./stall-watchdog";
import { TurnCounter } from "./turns";
import { ViewTracker } from "./view-tracker";
import { WatcherHub } from "./watcher-hub";
import { ShellHost } from "./shell-host";

const GRACEFUL_EXIT_MS = 3_000;
const SIGKILL_EXIT_MS = 2_000;

const NOOP_DETACH_PTY_DATA = (): void => {};

function unreachableLiveEntry(entry: never): never {
  throw new Error(`unreachable live entry kind: ${String(entry)}`);
}

export interface SessionManagerDependencies {
  registry: Registry;
  providerKeys: ProviderKeys;
  getOmpPath: () => string | null;
  getSessionsRoot: () => string;
  getArchiveRoot: () => string;
  getWorktreesRoot: () => string;
  send: (channel: string, ...args: unknown[]) => void;
  broadcast: () => Promise<void>;
  attention?: Attention;
}

type OpKind = "spawn" | "delete" | "hibernate" | "relaunch";

export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  private readonly turns = new TurnCounter();
  private readonly shellHost: ShellHost;
  private readonly watcherHub: WatcherHub;
  private readonly ops = new Map<string, { kind: OpKind; chain: Promise<void> }>();
  private readonly viewTracker: ViewTracker;
  private readonly planGates: PlanGateTracker;
  private readonly frameObservers: FrameObserver[] = [];
  private readonly hibernation: HibernationTracker;
  private readonly stallWatchdog: StallWatchdog;

  constructor(private readonly deps: SessionManagerDependencies) {
    this.shellHost = new ShellHost({ getOmpPath: deps.getOmpPath, send: deps.send });
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

  killAll(): void {
    for (const entry of this.live.values()) this.killLive(entry);
    this.live.clear();
    this.shellHost.killAll();
    this.watcherHub.disposeAll();
    this.hibernation.disposeAll();
    this.stallWatchdog.disposeAll();
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
      this.deps.attention?.sessionExit(tabId);
    }
    if (!entry.suppressExit) this.deps.send(CH.onPtyExit, tabId, exitCode);
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

  async spawnFromWire(raw: unknown): Promise<{ tabId: string }> {
    return this.spawn(parseSpawnRequest(raw));
  }

  async spawn(req: SpawnRequest): Promise<{ tabId: string }> {
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
    if (req.origin === "new" && !this.deps.providerKeys.hasModelProvider(req.projectCwd)) {
      throw new Error(
        "No model provider is configured. Add an API key under Settings → Providers before starting a session.",
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
        let worktree: SessionWorktree | null = null;
        if (req.worktree !== null) {
          if ("reuse" in req.worktree) {
            worktree = { ...req.worktree.reuse };
          } else {
            const { branch, baseRef } = req.worktree.mint;
            const worktreePath = mintWorktreePath(
              this.deps.getWorktreesRoot(), req.projectCwd, branch);
            const base = await addWorktree(req.projectCwd, worktreePath, branch, baseRef);
            mintedWorktree = { path: worktreePath, branch, base };
            worktree = mintedWorktree;
          }
        }
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
        if (Object.keys(patch).length > 0) {
          record = this.deps.registry.updateSession(record.tabId, patch) ?? record;
        }
      }
      const planMode =
        req.planMode ??
        (fresh
          ? this.deps.registry.getSetting("defaultAgentMode") === "plan"
          : record.agentMode === "plan");
      return mode === "rpc-ui"
        ? await this.spawnRpc(record, planMode, ompPath)
        : await this.spawnPty(record, req, ompPath);
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
        if (fresh) {
          if (this.deps.registry.sessions.some((session) => session.tabId === tabId)) {
            try {
              this.deps.registry.removeSession(tabId);
            } catch (error) {
              fail("remove spawned session record", error);
            }
          }
          if (mintedWorktree && !this.deps.registry.sessions.some((session) => session.tabId === tabId)) {
            const [cleanup] = await this.reclaimCheckouts([{ projectCwd, worktree: mintedWorktree }]);
            if (!cleanup || cleanup.checkoutKept !== null || (cleanup.branchOutcome !== "removed" && cleanup.branchOutcome !== "already-gone")) {
              const outcome = cleanup ? `checkout ${cleanup.checkoutKept ?? "removed"}; branch ${cleanup.branchOutcome}` : "no cleanup outcome";
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
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: writeSessionOverlays(record, absLineageDir),
    });
    const entry = createPtyLiveEntry(record, ptyHandle);
    this.live.set(record.tabId, entry);
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
  ): Promise<{ tabId: string }> {
    const absLineageDir = path.join(this.deps.getSessionsRoot(), record.lineageDir);
    const entry = createRpcLiveEntry(record);
    const { paths: extensions, mcpStatusLoaded } = writeRpcExtensions(absLineageDir);
    const initialCommands: Array<{ type: "prompt"; id: string; message: string }> = [];
    if (mcpStatusLoaded) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-mcp-${randomUUID()}`,
        message: mcpRuntimeStatusMessage(),
      });
    }
    initialCommands.push({
      type: "prompt",
      id: `omp-ui-initial-mode-${randomUUID()}`,
      message: planMessage(planMode, this.deps.registry.getSetting("planFormat")),
    });
    const configOverlays = await writeRpcOverlays(record, absLineageDir, ompPath);
    if (record.worktree !== null) {
      await linkProjectOmpDir(record.projectCwd, record.worktree.path);
    }
    const rpc = new RpcClient({
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
    wireRpc(entry, rpc);
    this.live.set(record.tabId, entry);
    this.watcherHub.start(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
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
        cleanup = await this.reclaimWorktree(record.projectCwd, wt);
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
      };
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

  planGate(tabId: string): PlanGate | undefined {
    return this.planGates.gate(tabId);
  }

  setViewedTab(clientId: string, tabId: string | null): void {
    this.viewTracker.setViewedTab(clientId, tabId);
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

  private awaitingHumanAnswer(tabId: string): boolean {
    if (this.planGates.pending(tabId)) return true;
    return this.hibernation.hasOpenRequests(tabId);
  }

  hibernatePlanSource(sourceTabId: string, implementationTabId: string): Promise<boolean> {
    return this.enqueueOp(sourceTabId, "hibernate", () =>
      this.hibernation.attemptHandoff(sourceTabId, implementationTabId),
    );
  }

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

  killShell(tabId: string): void {
    this.shellHost.kill(tabId);
  }

  terminate(tabId: string): void {
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) return;
    void this.escalateOnTerminate(tabId, entry);
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
    await this.reclaimCheckouts(checkouts);
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
        };
      }),
    };
  }

  private reclaimCheckouts(
    checkouts: ReadonlyArray<{ projectCwd: string; worktree: SessionWorktree }>,
  ) {
    return reclaimWorktreeCheckouts(checkouts, {
      worktreesRoot: this.deps.getWorktreesRoot(),
      survivingSessions: this.deps.registry.sessions,
    });
  }

  private async reclaimWorktree(
    projectCwd: string,
    worktree: SessionWorktree,
  ): Promise<Pick<WorktreeReleaseResult, "checkoutKept" | "branchOutcome">> {
    const [result] = await this.reclaimCheckouts([{ projectCwd, worktree }]);
    return result
      ? { checkoutKept: result.checkoutKept, branchOutcome: result.branchOutcome }
      : { checkoutKept: "failed", branchOutcome: "not-attempted" };
  }

  private async deleteInner(tabId: string): Promise<void> {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const entry = this.live.get(tabId);
    if (entry) await this.killAndReap(tabId, entry);
    this.stallWatchdog.dispose(tabId);
    this.hibernation.dispose(tabId);
    this.watcherHub.stop(tabId);
    this.killShell(tabId);
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
