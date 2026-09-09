import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  CH,
  addWorktree,
  addWorktreeForBranch,
  addWorktreeFromNewBase,
  base64Bytes,
  bracketedImagePaste,
  capabilityToolMutationMessage,
  capabilitiesMessage,
  CAPABILITIES_STATUS_KEY,
  checkoutBranch,
  deleteSessionFiles,
  forkSessionFile,
  goalArmMessage,
  mintLineageDirName,
  mintWorktreePath,
  readWorktreeDirty,
  renameWorktreeBranch,
  linkProjectOmpDir,
  isHtmlPlanPath,
  isWithin,
  mcpRuntimeStatusMessage,
  normalizeControlFrame,
  parseCapabilitySnapshot,
  planMessage,
  planHandoffDescendants,
  reclaimCheckouts as reclaimWorktreeCheckouts,
  settledWithin,
  syncWorktree,
  type PlanAnswerResult,
  type PlanRenderResult,
  type PlanReviewVerdict,
  type ProviderKeys,
  type Registry,
  type WorktreeCheckoutDescriptor,
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
  type GoalSnapshot,
  type CapabilityToolMutationRequest,
  type SessionCapabilitiesResult,
  type SetSessionToolEnabledResult,
  type SessionMode,
  type SessionWorktree,
  type SpawnRequest,
  type WorktreeReleaseOptions,
  type WorktreeReleaseResult,
  type WorktreeSyncResult,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { BreadcrumbSink } from "./breadcrumbs";
import type { FrameObserver } from "./frame-observer";
import {
  createPtyLiveEntry,
  createRpcLiveEntry,
  type LiveEntry,
  wirePtyData,
  wireRpc,
} from "./live-entry";
import { HibernationTracker } from "./hibernation-tracker";
import { CapabilityControlTracker } from "./capability-control-tracker";
import { PlanGateTracker, type PlanGate } from "./plan-gate-tracker";
import { PlanPreflightController } from "./plan-preflight";
import { readConfinedPlanFile } from "./plan-file";
import { GoalStatusTracker } from "./goal-status-tracker";
import { prepareResumeRecord, writeRpcExtensions, writeRpcOverlays, writeSessionOverlays } from "./spawn-config";
import { StallWatchdog } from "./stall-watchdog";
import { TurnTracker } from "./turns";
import { ViewTracker } from "./view-tracker";
import { WatcherHub } from "./watcher-hub";
import { ShellHost } from "./shell-host";
import { gateSelector, NO_GATE, type SpawnGate } from "./spawn-gate";

const GRACEFUL_EXIT_MS = 3_000;
const SIGKILL_EXIT_MS = 2_000;

/** How long a tool toggle waits for its correlated completion before `unconfirmed`. */
const TOOL_MUTATION_TTL_MS = 30_000;

const NOOP_DETACH_PTY_DATA = (): void => {};

function unreachableLiveEntry(entry: never): never {
  throw new Error(`unreachable live entry kind: ${String(entry)}`);
}

export interface SessionManagerDependencies {
  registry: Registry;
  providerKeys: ProviderKeys;
  /**
   * A catalogued subscription sign-in with at least one account counts as a
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
}

/** `tool`: a session-local tool enable/disable holding the tab while it waits. */
type OpKind = "spawn" | "delete" | "hibernate" | "relaunch" | "tool";

export class SessionManager {
  private readonly live = new Map<string, LiveEntry>();
  private readonly turns = new TurnTracker();
  private readonly shellHost: ShellHost;
  private readonly watcherHub: WatcherHub;
  private readonly ops = new Map<string, { kind: OpKind; chain: Promise<void> }>();
  private readonly viewTracker: ViewTracker;
  private readonly planGates: PlanGateTracker;
  private readonly planPreflight: PlanPreflightController;
  /** One in-flight execute re-check per tab (§6: atomic settle reservation). */
  private readonly planAnswerReservations = new Set<string>();
  private readonly frameObservers: FrameObserver[] = [];
  private readonly hibernation: HibernationTracker;
  private readonly stallWatchdog: StallWatchdog;
  private readonly toolControl: CapabilityControlTracker;
  private readonly goals: GoalStatusTracker;
  private readonly gate: SpawnGate;

  constructor(private readonly deps: SessionManagerDependencies) {
    this.gate = deps.spawnGate ?? NO_GATE;
    this.shellHost = new ShellHost({
      getOmpPath: deps.getOmpPath,
      send: deps.send,
      getOmpModelArg: () => gateSelector(this.gate),
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
      /** An active goal or a live continuation keeps the child's loop running (issue #381). */
      preventsHibernation: (tabId) => this.goals.preventsHibernation(tabId),
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
    this.frameObservers = [this.hibernation, this.planGates, this.planPreflight, this.stallWatchdog, this.toolControl, this.goals];
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
      this.deps.attention?.sessionExit(tabId);
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
        "No model provider is configured. Add an API key or sign in to a subscription under Settings → Providers before starting a session.",
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
          } else if ("checkout" in req.worktree) {
            // Issue #390: a session on an existing local branch. The branch
            // pre-existed, but the checkout is omp-ui's — rollback reclaims
            // the path and branch cleanup keeps the branch unless provably
            // merged (reclaimCheckouts reports kept-unmerged then).
            const { branch } = req.worktree.checkout;
            const worktreePath = mintWorktreePath(
              this.deps.getWorktreesRoot(), req.projectCwd, branch);
            const base = await addWorktreeForBranch(req.projectCwd, worktreePath, branch);
            mintedWorktree = { path: worktreePath, branch, base };
            worktree = mintedWorktree;
          } else {
            const { branch, baseRef, baseBranch } = req.worktree.mint;
            const worktreePath = mintWorktreePath(
              this.deps.getWorktreesRoot(), req.projectCwd, branch);
            // Issue #405: with a new base branch the checkout is cut from the
            // branch created in this same operation, and the recorded base is
            // that branch — diffs, sync, and merge-back never target the
            // trunk it was cut from. The new ref is rolled back only if the
            // add fails; a later spawn-step failure leaves it (the user
            // explicitly asked for it, as #390 keeps a pre-existing branch).
            const base = baseBranch === null
              ? await addWorktree(req.projectCwd, worktreePath, branch, baseRef)
              : await addWorktreeFromNewBase(
                  req.projectCwd, worktreePath, branch, baseBranch, baseRef);
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
      const result =
        mode === "rpc-ui"
          ? await this.spawnRpc(record, planMode, ompPath)
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
      model: gateSelector(this.gate) ?? undefined,
      cols: req.cols,
      rows: req.rows,
      advisor: record.advisor,
      configOverlays: writeSessionOverlays(record, absLineageDir, this.gate),
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
    const { paths: extensions, mcpStatusLoaded, capabilitiesLoaded, goalLoaded } =
      writeRpcExtensions(absLineageDir);
    entry.capabilitiesBridgeLoaded = capabilitiesLoaded;
    const initialCommands: Array<{ type: "prompt"; id: string; message: string }> = [];
    if (mcpStatusLoaded) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-mcp-${randomUUID()}`,
        message: mcpRuntimeStatusMessage(),
      });
    }
    // The goal bridge arms before the plan command: its restoration is what
    // tells Plan entry whether an unfinished goal owns the mode slot, and a plan
    // that started before it would read an unrestored session and enter anyway.
    if (goalLoaded) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-goal-${randomUUID()}`,
        message: goalArmMessage(),
      });
    }
    initialCommands.push({
      type: "prompt",
      id: `omp-ui-initial-mode-${randomUUID()}`,
      message: planMessage(planMode, this.deps.registry.getSetting("planFormat")),
    });
    if (capabilitiesLoaded) {
      initialCommands.push({
        type: "prompt",
        id: `omp-ui-initial-capabilities-${randomUUID()}`,
        message: capabilitiesMessage(),
      });
    }
    const configOverlays = await writeRpcOverlays(record, absLineageDir, ompPath, this.gate);
    if (record.worktree !== null) {
      await linkProjectOmpDir(record.projectCwd, record.worktree.path);
    }
    const rpc = new RpcClient({
      cwd: record.worktree?.path ?? record.projectCwd,
      lineageDir: absLineageDir,
      ompPath,
      resumeSessionId: record.sessionId ?? undefined,
      model: gateSelector(this.gate) ?? undefined,
      advisor: record.advisor,
      configOverlays,
      extensions,
      initialCommands,
      onFrame: (frame) => {
        const control = normalizeControlFrame(frame);
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
      onError: (msg) =>
        this.deps.send(CH.onRpcFrame, record.tabId, { type: "omp_ui_error", message: msg }),
    });
    wireRpc(entry, rpc);
    this.live.set(record.tabId, entry);
    this.watcherHub.start(record);
    await this.deps.broadcast();
    return { tabId: record.tabId };
  }

  /** The observer fan-out + client broadcast tail of `onFrame` (§5.3). */
  private deliverFrame(tabId: string, frame: RpcFrame, entry: LiveEntry): void {
    for (const obs of this.frameObservers) obs.onFrame(tabId, frame, entry);
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
      const worktreePath = mintWorktreePath(
        this.deps.getWorktreesRoot(), record.projectCwd, branch);
      // Issue #405: the same two entries as the spawn mint arm; with a new
      // base branch the record's base is that branch's name, not its start.
      const base = baseBranch === null
        ? await addWorktree(record.projectCwd, worktreePath, branch, baseRef)
        : await addWorktreeFromNewBase(
            record.projectCwd, worktreePath, branch, baseBranch, baseRef);
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
      if ((await readWorktreeDirty(record.projectCwd, wt.path)) === true) {
        throw new Error(
          "the worktree has uncommitted changes — commit or discard them before returning",
        );
      }
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
        cleanup = await this.reclaimWorktree(record.projectCwd, wt, {
          keepBranch: opts.keepBranch,
          mergedInto: opts.mergedInto,
        });
        // The session's own branch is the one just deleted or kept by the
        // reclaim; switching onto it would be nonsense either way (#431).
        if (switchTarget !== null && switchTarget !== wt.branch) {
          try {
            await checkoutBranch(record.projectCwd, switchTarget);
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

  /**
   * Merges `source` into the session's worktree checkout (issue #387) so
   * conflicts land where the owning session can resolve them. Serialised
   * against release/convert/delete under "relaunch" — no relaunch happens;
   * a merge must not race a respawn of the same tab.
   */
  async syncWorktree(tabId: string, source: string): Promise<WorktreeSyncResult> {
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      if (!record.worktree) throw new Error("session does not run in a worktree");
      return syncWorktree(record.projectCwd, record.worktree.path, source);
    });
  }

  /**
   * Renames the branch a worktree session runs on (issues #386, #389): git
   * updates the checkout's HEAD symref; the record follows; the running omp
   * process is unaffected by a ref rename, so no respawn. Git's stderr on a
   * collision or invalid name propagates verbatim.
   */
  async renameWorktreeBranch(tabId: string, newName: string): Promise<void> {
    const name = newName.trim();
    if (name === "") throw new Error("branch name must not be empty");
    return this.enqueueOp(tabId, "relaunch", async () => {
      const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
      if (!record) throw new Error(`unknown session tab ${tabId}`);
      const wt = record.worktree;
      if (!wt) throw new Error("session does not run in a worktree");
      await renameWorktreeBranch(wt.path, wt.branch, name);
      this.deps.registry.updateSession(tabId, {
        worktree: { ...wt, branch: name },
      });
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

  /** The live session's goal snapshot, as its own bridge published it (issue #381). */
  goalSnapshot(tabId: string): GoalSnapshot | undefined {
    return this.goals.snapshot(tabId);
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
    if (this.planPreflight.isHeld(tabId)) return true;
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
    for (const obs of this.frameObservers) obs.onSend?.(tabId, cmd);
    if (wasAwaitingHuman && !this.awaitingHumanAnswer(tabId)) {
      this.stallWatchdog.humanAnswered(tabId);
    }
    this.planPreflight.clearSnapshot(tabId);
    if (entry.kind === "rpc-ui") entry.rpc?.send(cmd);
  }

  killShell(tabId: string): void {
    this.shellHost.kill(tabId);
  }

  terminate(tabId: string): void {
    this.killShell(tabId);
    const entry = this.live.get(tabId);
    if (!entry) return;
    this.deps.breadcrumb?.record("session-terminate", { tabId });
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
    extra?: Pick<WorktreeCheckoutDescriptor, "keepBranch" | "mergedInto">,
  ): Promise<Pick<WorktreeReleaseResult, "checkoutKept" | "branchOutcome">> {
    const [result] = await this.reclaimCheckouts([{ projectCwd, worktree, ...extra }]);
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
    this.toolControl.dispose(tabId);
    this.planPreflight.dispose(tabId);
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
      this.deps.breadcrumb?.record("session-mode", { tabId, mode });
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
