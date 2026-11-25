import { randomBytes } from "node:crypto";
import {
  assertRoutineModeArtifactCompatible,
  compileRoutineToolPolicy,
  nextRunAfter,
  resolveRoutineTimeoutMinutes,
  resolveRoutineWallClockMs,
  routineAllowsAgentNotification,
  routinePatchFromAgentUpdate,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type OwnedSessionRecord,
  type RoutineAgentUpdateArgs,
  type RoutineArtifactBinding,
  type RoutineCatalogSnapshot,
  type RoutineDryRunRequest,
  type RoutineDryRunResult,
  type RoutineInput,
  type RoutinePatch,
  type RoutineRecord,
  type RoutineRunHistory,
  type RoutineRunOutcome,
  type RoutinesDiagnostics,
  type RoutinesState,
  type RoutineStore,
  type RoutineTestScriptRequest,
  type RoutineTestScriptResult,
  type RoutineToolPolicy,
  type SessionRoutine,
} from "@omp-ui/core";
import type { RoutineNotificationPayload } from "./desktop-notifier";
import type { RoutineCatalogService } from "./routine-catalog";
import type { RoutineLifecycleManager } from "./routine-lifecycle";
import { RoutineRetention } from "./routine-retention";
import { ROUTINES_DISABLED_ERROR, RoutineScheduler } from "./routine-scheduler";
import { cancelAllRoutineScripts, runRoutineScript, runRoutineScriptForTest } from "./routine-scripts";

export interface RoutineServiceDeps {
  store: RoutineStore;
  history: RoutineRunHistory;
  catalog: Pick<RoutineCatalogService, "list">;
  /** The per-run timer owner registered in SessionManager's frame observers. */
  lifecycle: Pick<
    RoutineLifecycleManager,
    "trackStart" | "parkAll" | "resumeAll" | "waitingApprovalCount" | "postRunning"
  >;
  /** The `routinesEnabled` registry setting. */
  isEnabled: () => boolean;
  defaultWarnCostUsd: () => number;
  defaultMaxCostUsd: () => number;
  /** True for a registered local project path (never a chat dir). */
  hasProject: (projectCwd: string) => boolean;
  sessions: () => readonly OwnedSessionRecord[];
  /** Clears a routine marker on a surviving session record. */
  clearSessionRoutine: (tabId: string) => void;
  /** Marks a dormant session record settled (boot hygiene for pre-quit routine runs, #1305). */
  markSessionSettled?: (tabId: string, settledAtMs: number) => void;
  isLive: (tabId: string) => boolean;
  isTurnRunning: (tabId: string) => boolean;
  awaitingHumanAnswer: (tabId: string) => boolean;
  deleteSession: (tabId: string, cascade: false) => Promise<unknown>;
  dispatch: (
    req: FleetDispatchRequest,
    who: { kind: "routine"; routine: SessionRoutine },
    opts: { deadlineMs: number },
  ) => Promise<FleetDispatchResult>;
  /** This host's machine name for the pane header (`"{title} on {machine}"`). */
  machineLabel: () => string;
  /** Pushes `routines:state` to every client of this host. */
  send: (state: RoutinesState) => void;
  /** Rebuilds `state:changed` after session records change. */
  broadcast: () => void;
  /** Posts a per-routine OS notification (#1294). */
  notifyRoutine?: (payload: RoutineNotificationPayload) => void;
  /** Fire-time scheduled-refresh preflight (ADR-0101); omitted = never blocked. */
  artifactRefreshBlocked?: (binding: RoutineArtifactBinding) => string | null;
  now?: () => number;
}

const OUTCOMES: readonly RoutineRunOutcome[] = ["running", "waiting-approval", "on-time", "late", "skipped", "failed"];

/**
 * Routines, host side (ADR-0100, §7): owns the store, run history, catalog,
 * scheduler, lifecycle timers, and retention behind the host-local
 * `routines:*` channels. Every mutation and run refuses while the
 * Experimental gate is off; turning the gate off parks timers without reaping.
 */
export class RoutineService {
  readonly scheduler: RoutineScheduler;
  readonly retention: RoutineRetention;
  private readonly now: () => number;

  constructor(private readonly deps: RoutineServiceDeps) {
    this.now = deps.now ?? Date.now;
    const publish = (): void => this.publish();
    this.retention = new RoutineRetention({
      history: deps.history,
      isEnabled: deps.isEnabled,
      sessions: deps.sessions,
      isLive: deps.isLive,
      awaitingHumanAnswer: deps.awaitingHumanAnswer,
      deleteSession: deps.deleteSession,
      publish: () => {
        publish();
        deps.broadcast();
      },
      now: this.now,
    });
    this.scheduler = new RoutineScheduler({
      store: deps.store,
      history: deps.history,
      isEnabled: deps.isEnabled,
      defaultWarnCostUsd: deps.defaultWarnCostUsd,
      defaultMaxCostUsd: deps.defaultMaxCostUsd,
      hasProject: deps.hasProject,
      sessions: deps.sessions,
      isLive: deps.isLive,
      isTurnRunning: deps.isTurnRunning,
      awaitingHumanAnswer: deps.awaitingHumanAnswer,
      listCatalog: (cwd, opts) => deps.catalog.list(cwd, opts),
      artifactRefreshBlocked: deps.artifactRefreshBlocked ?? (() => null),
      dispatch: deps.dispatch,
      runScript: (command, cwd, env) => runRoutineScript(command, cwd, env),
      postRunning: (tabId) => deps.lifecycle.postRunning(tabId),
      onRunStarted: (tabId, routine, runRowId, trigger, firedAtMs) => {
        // Fire-time pin: the scheduler hands over its fire-time snapshot directly, so a
        // mid-run edit or delete can neither change nor skip an in-flight post hook or timeout.
        deps.lifecycle.trackStart(tabId, runRowId, trigger, firedAtMs, {
          scripts: routine.scripts,
          routineId: routine.id,
          routineName: routine.name,
          projectCwd: routine.destination.projectCwd,
          workspace: routine.destination.workspace,
          wallClockMs: resolveRoutineWallClockMs(routine.timeoutMinutes),
          notifications: routine.notifications,
        });
      },
      onPostFire: async () => {
        await this.retention.prune();
      },
      notifyRoutine: deps.notifyRoutine,
      publish,
      now: this.now,
    });
  }

  state(): RoutinesState {
    return {
      enabled: this.deps.isEnabled(),
      machineLabel: this.deps.machineLabel(),
      routines: this.deps.store.list(),
      runs: this.deps.history.list(),
      activeRunTabId: this.scheduler.activeRunTabId(),
      defaultWarnCostUsd: this.deps.defaultWarnCostUsd(),
      defaultMaxCostUsd: this.deps.defaultMaxCostUsd(),
    };
  }

  publish(): void {
    this.deps.send(this.state());
  }

  /** Boot: stamp dormant unsettled routine runs, run one missed fire if due, and prune retention. */
  boot(): void {
    if (this.deps.markSessionSettled !== undefined) {
      let changed = false;
      for (const s of this.deps.sessions()) {
        if (s.routine === null || this.deps.isLive(s.tabId) || s.settledAtMs !== null) continue;
        const parsed = Date.parse(s.cachedModified ?? s.launchedAt);
        this.deps.markSessionSettled(s.tabId, Number.isFinite(parsed) ? parsed : this.now());
        changed = true;
      }
      if (changed) this.deps.broadcast();
    }
    this.scheduler.sync();
    void this.retention.prune().catch((err: unknown) => console.warn("[routines] boot retention failed:", err));
  }

  /** The gate moved (the setting is already written): park or resume timers, never reap. */
  onEnabledChanged(enabled: boolean): void {
    if (enabled) {
      this.deps.lifecycle.resumeAll();
      this.scheduler.sync();
      void this.retention.prune().catch((err: unknown) => console.warn("[routines] retention failed:", err));
    } else {
      this.scheduler.stopTimer();
      this.deps.lifecycle.parkAll();
      // A 60 s hook must not outlive the gate or hold a project as cwd (#1283).
      cancelAllRoutineScripts();
    }
    this.publish();
  }

  async create(input: RoutineInput): Promise<RoutineRecord> {
    this.assertEnabled();
    this.assertProject(input.destination.projectCwd);
    assertRoutineModeArtifactCompatible(input.mode, input.artifact);
    const nowMs = this.now();
    const record: RoutineRecord = {
      id: randomBytes(16).toString("base64url"),
      ...input,
      toolPolicy: await this.reviewed(input.toolPolicy, input.destination.projectCwd, nowMs),
      createdAt: new Date(nowMs).toISOString(),
      nextRunAtMs: nextRunAfter(input.schedule, input.timeZone, nowMs),
      lastRunAtMs: null,
      lastRunTabId: null,
      notices: [],
    };
    this.deps.store.add(record);
    this.scheduler.sync();
    this.publish();
    return record;
  }

  async update(id: string, patch: RoutinePatch): Promise<RoutineRecord> {
    this.assertEnabled();
    const current = this.deps.store.get(id);
    if (current === null) throw new Error(`unknown routine ${id}`);
    const next = { ...current, ...patch };
    if (patch.destination !== undefined) this.assertProject(patch.destination.projectCwd);
    assertRoutineModeArtifactCompatible(next.mode, next.artifact);
    const nowMs = this.now();
    const changes: Partial<RoutineRecord> = { ...patch };
    if (patch.toolPolicy !== undefined) {
      changes.toolPolicy = await this.reviewed(patch.toolPolicy, next.destination.projectCwd, nowMs);
    }
    // A new schedule, zone, or re-enable starts from now: never a late fire for time spent paused.
    const reArm =
      patch.schedule !== undefined || patch.timeZone !== undefined || (patch.enabled === true && !current.enabled);
    if (reArm) changes.nextRunAtMs = nextRunAfter(next.schedule, next.timeZone, nowMs);
    const updated = this.deps.store.update(id, changes);
    this.scheduler.sync();
    this.publish();
    return updated;
  }

  /**
   * The `omp-ui_routines_update` entry point (ADR-0100 amendment 2): read,
   * merge over the stored record, and patch inside one call so a concurrent
   * human edit can't slip between the read and the write and leave
   * `wasEnabled` describing stale state. The builder forces `enabled: false`,
   * so every agent edit disarms scheduled firing until a human re-arms.
   */
  async updateFromAgent(
    args: RoutineAgentUpdateArgs,
    nowIso: string,
  ): Promise<{ record: RoutineRecord; wasEnabled: boolean }> {
    const current = this.deps.store.get(args.id);
    if (current === null) throw new Error(`unknown routine ${args.id}`);
    const record = await this.update(args.id, routinePatchFromAgentUpdate(current, args, nowIso));
    return { record, wasEnabled: current.enabled };
  }

  /**
   * Removes the routine and its run history without reaping any live run, and
   * clears the marker on every surviving session so none becomes an invisible
   * orphan (#1255 clause 9). Answers how many sessions were released.
   */
  remove(id: string): { releasedSessions: number } {
    this.assertEnabled();
    if (!this.deps.store.remove(id)) throw new Error(`unknown routine ${id}`);
    this.deps.history.removeForRoutine(id);
    let releasedSessions = 0;
    for (const session of [...this.deps.sessions()]) {
      if (session.routine?.id !== id) continue;
      this.deps.clearSessionRoutine(session.tabId);
      releasedSessions += 1;
    }
    this.scheduler.sync();
    this.publish();
    if (releasedSessions > 0) this.deps.broadcast();
    return { releasedSessions };
  }

  runNow(id: string): Promise<{ tabId: string; runId: string }> {
    return this.scheduler.runNow(id);
  }

  /** The exact fire-time compiler over the live catalog; writes nothing and starts no session. */
  async dryRun(req: RoutineDryRunRequest): Promise<RoutineDryRunResult> {
    this.assertEnabled();
    let routineId: string | null = null;
    let input: RoutineInput;
    if (req.kind === "saved") {
      const saved = this.deps.store.get(req.id);
      if (saved === null) throw new Error(`unknown routine ${req.id}`);
      routineId = saved.id;
      input = saved;
    } else {
      input = req.input;
    }
    this.assertProject(input.destination.projectCwd);
    const catalog = await this.deps.catalog.list(input.destination.projectCwd, {
      fallbackReviewedKeys: input.toolPolicy.reviewedCatalog,
    });
    return {
      routineId,
      nextFireAtMs: input.enabled ? nextRunAfter(input.schedule, input.timeZone, this.now()) : null,
      compiled: compileRoutineToolPolicy(input.toolPolicy, catalog, {
        allowAgentNotify: routineAllowsAgentNotification(input.notifications),
        allowArtifactCapture: input.artifact !== null,
      }),
      warnCostUsd: input.spend.warnUsd ?? this.deps.defaultWarnCostUsd(),
      maxCostUsd: input.spend.maxUsd ?? this.deps.defaultMaxCostUsd(),
      staleServers: catalog.staleServers,
      enumerationError: catalog.enumerationError,
      scripts: input.scripts,
      timeoutMinutes: resolveRoutineTimeoutMinutes(input.timeoutMinutes),
      notifications: input.notifications,
    };
  }

  toolCatalog(projectCwd: string): Promise<RoutineCatalogSnapshot> {
    this.assertEnabled();
    this.assertProject(projectCwd);
    return this.deps.catalog.list(projectCwd);
  }

  /** Counts and flags only — never names, instructions, tool keys, or rows (§14). */
  diagnostics(): RoutinesDiagnostics {
    const routines = this.deps.store.list();
    const recentOutcomeCounts = Object.fromEntries(OUTCOMES.map((o) => [o, 0])) as Record<RoutineRunOutcome, number>;
    for (const row of this.deps.history.list()) recentOutcomeCounts[row.outcome] += 1;
    return {
      enabled: this.deps.isEnabled(),
      warnCostUsd: this.deps.defaultWarnCostUsd(),
      maxCostUsd: this.deps.defaultMaxCostUsd(),
      routineCount: routines.length,
      enabledCount: routines.filter((r) => r.enabled).length,
      activeRunTabId: this.scheduler.activeRunTabId(),
      waitingApprovalCount: this.deps.lifecycle.waitingApprovalCount(),
      recentOutcomeCounts,
    };
  }

  dispose(): void {
    this.scheduler.dispose();
    this.deps.lifecycle.parkAll();
    // sessions.killAll() never reaches hook children (#1283).
    cancelAllRoutineScripts();
  }

  /** Disposes timers and hooks, then drains any in-flight dispatches before killAll(). */
  async disposeAsync(): Promise<void> {
    this.dispose();
    await this.scheduler.drain();
  }

  /**
   * Attended "Test script" editor action (#1283): runs one command on demand
   * and returns capped tails. Writes nothing — no store, row, or notice — and
   * takes no scheduler lane; concurrent tests each get their own child.
   */
  async testScript(input: RoutineTestScriptRequest): Promise<RoutineTestScriptResult> {
    this.assertEnabled();
    this.assertProject(input.projectCwd);
    const result = await runRoutineScriptForTest(input.command, input.projectCwd, {
      OMP_UI_ROUTINE_TRIGGER: "test",
      OMP_UI_ROUTINE_PROJECT_CWD: input.projectCwd,
    });
    return {
      kind: result.kind,
      timedOut: result.kind === "failed" ? result.timedOut : false,
      exitCode: result.kind === "failed" ? result.exitCode : result.kind === "ok" ? 0 : null,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  private assertEnabled(): void {
    if (!this.deps.isEnabled()) throw new Error(ROUTINES_DISABLED_ERROR);
  }

  private assertProject(projectCwd: string): void {
    if (!this.deps.hasProject(projectCwd)) throw new Error("Destination project is not a registered project on this machine");
  }

  /** Stamps the review: the catalog the user saw at save time is the drift baseline. */
  private async reviewed(policy: RoutineToolPolicy, projectCwd: string, nowMs: number): Promise<RoutineToolPolicy> {
    const catalog = await this.deps.catalog.list(projectCwd, { fallbackReviewedKeys: policy.reviewedCatalog });
    return {
      ...policy,
      lastReviewedAt: new Date(nowMs).toISOString(),
      reviewedCatalog: catalog.tools.map((t) => t.key).sort(),
    };
  }
}
