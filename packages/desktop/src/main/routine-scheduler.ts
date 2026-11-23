import { randomUUID } from "node:crypto";
import {
  LOCAL_MACHINE_KEY,
  ROUTINE_NOTICES_MAX,
  SCHEDULED_PROMPT_LATE_MS,
  compileRoutineToolPolicy,
  countRunsBetween,
  nextRunAfter,
  routineAllowsAgentNotification,
  routinePrompt,
  routineRunTitle,
  type FleetDispatchRequest,
  type FleetDispatchResult,
  type OwnedSessionRecord,
  type RoutineCatalogSnapshot,
  type RoutineRecord,
  type RoutineRunHistory,
  type RoutineRunReasonCode,
  type RoutineRunRow,
  type RoutineRunTrigger,
  type RoutineStore,
  type ScheduledPromptNotice,
  type SessionRoutine,
} from "@omp-ui/core";
import type { ListCatalogOptions } from "./routine-catalog";
import type { RoutineNotificationPayload } from "./desktop-notifier";
import type { RoutineScriptEnv, RoutineScriptResult } from "./routine-scripts";

/** Longest single timer wait: matches ScheduledPromptRunner / SnoozeClock so OS sleep catches up within 60 s. */
export const ROUTINE_SCHEDULER_MAX_WAIT_MS = 60_000;
/** Bounded dispatch deadline matching WebhookService / McpEndpointService. */
export const ROUTINE_DISPATCH_DEADLINE_MS = 45_000;
/** Exact inline refusal string when Run now hits a busy host-wide active-turn lane (§7.1, #1253). */
export const ROUTINE_BUSY_REFUSAL = "Another routine is running — try again in a moment";
/** Exact refusal string when the Routines gate is off (§9). */
export const ROUTINES_DISABLED_ERROR = "Routines is disabled in Settings → Routines";

export interface RoutineSchedulerDeps {
  store: RoutineStore;
  history: RoutineRunHistory;
  isEnabled: () => boolean;
  defaultWarnCostUsd: () => number;
  defaultMaxCostUsd: () => number;
  hasProject: (projectCwd: string) => boolean;
  sessions: () => readonly OwnedSessionRecord[];
  isLive: (tabId: string) => boolean;
  /** True while the tab's model turn is actively running (`turns.isRunning`). */
  isTurnRunning: (tabId: string) => boolean;
  /** True while the tab has an open plan gate, project request, or blocking dialog. */
  awaitingHumanAnswer: (tabId: string) => boolean;
  listCatalog: (projectCwd: string, opts?: ListCatalogOptions) => Promise<RoutineCatalogSnapshot>;
  dispatch: (
    req: FleetDispatchRequest,
    who: { kind: "routine"; routine: SessionRoutine },
    opts: { deadlineMs: number },
  ) => Promise<FleetDispatchResult>;
  /** Called once a routine run starts with a tabId so lifecycle timers can attach. */
  onRunStarted: (
    tabId: string,
    routine: RoutineRecord,
    runRowId: string,
    trigger: RoutineRunTrigger,
    firedAtMs: number,
  ) => void;
  /** Runs one pre-run hook; the runner resolves (never rejects) with a fixed result (#1283). */
  runScript: (
    command: string,
    cwd: string,
    env: RoutineScriptEnv,
  ) => Promise<RoutineScriptResult>;
  /** True while that tab's post-run hook is still executing (#1283); holds per-routine overlap. */
  postRunning: (tabId: string) => boolean;
  /** Called after a fire starts so retention can prune aged runs. */
  onPostFire?: () => Promise<void> | void;
  /** Publishes `routines:state` to every connected client. */
  publish: () => void;
  /** Posts a per-routine OS notification (#1294). */
  notifyRoutine?: (payload: RoutineNotificationPayload) => void;
  now?: () => number;
  uuid?: () => string;
}

function prependNotice(
  existing: readonly ScheduledPromptNotice[],
  notice: ScheduledPromptNotice,
): ScheduledPromptNotice[] {
  return [notice, ...existing].slice(0, ROUTINE_NOTICES_MAX);
}

/**
 * Host-local Routine clock scheduler (ADR-0100, §7.1):
 * - 60 s `MAX_WAIT_MS` timer cap so OS sleep/wake catches up within a minute.
 * - Advance-before-dispatch: persists `nextRunAtMs` synchronously before dispatching.
 * - Late fire fold past 120 s with `countRunsBetween` missed count (never a burst).
 * - Per-routine skip-don't-queue overlap via `inRun = isTurnRunning || awaitingHumanAnswer`.
 * - Host-wide one-active-turn lane via `isTurnRunning` across live routine runs
 *   (card-parked runs release the host lane while keeping their per-routine overlap latch).
 * - `runNow(id)` fires identically without advancing `nextRunAtMs` and refuses inline when busy.
 */
export class RoutineScheduler {
  private readonly now: () => number;
  private readonly uuid: () => string;
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;
  /** Routines currently inside an async dispatch() call before a tabId lands. */
  private readonly inFlightByRoutine = new Set<string>();
  /** Total in-flight dispatches holding the host-wide active-turn lane during spawn. */
  private inFlightHostDispatches = 0;

  constructor(private readonly deps: RoutineSchedulerDeps) {
    this.now = deps.now ?? Date.now;
    this.uuid = deps.uuid ?? randomUUID;
  }

  /** True while `tabId` is live and either turning or waiting on a human gate (Approval card, plan, etc.). */
  inRun(tabId: string): boolean {
    // A post hook keeps running after `settleSession()` (wall-clock) or the
    // child's exit has already made the tab non-live, so this must precede
    // isLive() (#1283).
    if (this.deps.postRunning(tabId)) return true;
    if (!this.deps.isLive(tabId)) return false;
    return this.deps.isTurnRunning(tabId) || this.deps.awaitingHumanAnswer(tabId) || this.rowStillRunning(tabId);
  }

  /**
   * The run's history row still reads "running": dispatched (or resumed after
   * a card) but not yet at its terminal `agent_end`. It covers the gap between
   * the spawn answering and omp's first `agent_start`, when neither the turn
   * latch nor a card is set; without it a second Run now in that gap spawned
   * a duplicate run (S9 smoke).
   */
  private rowStillRunning(tabId: string): boolean {
    return this.deps.history.list().some((row) => row.tabId === tabId && row.outcome === "running");
  }

  /**
   * The tabId of any live routine run currently holding the host-wide lane:
   * turning, or dispatched and not yet past its terminal end. A run parked on
   * an Approval card is excluded: omp raises the card mid-turn, so
   * `turns.isRunning` stays true while it waits, yet it holds no model work
   * and must release the lane (#1253). Its per-routine latch (`inRun`) still holds.
   */
  activeRunTabId(): string | null {
    for (const session of this.deps.sessions()) {
      if (session.routine === null) continue;
      if (!this.deps.isLive(session.tabId)) continue;
      if (this.deps.awaitingHumanAnswer(session.tabId)) continue;
      if (this.deps.isTurnRunning(session.tabId) || this.rowStillRunning(session.tabId)) return session.tabId;
    }
    return null;
  }

  private isHostLaneBusy(): boolean {
    return this.inFlightHostDispatches > 0 || this.activeRunTabId() !== null;
  }

  private isRoutineOpen(routine: RoutineRecord): boolean {
    if (this.inFlightByRoutine.has(routine.id)) return true;
    return routine.lastRunTabId !== null && this.inRun(routine.lastRunTabId);
  }

  /** Evaluates due routines and arms the next bounded timer (<= 60 s). No-op while gate is off. */
  sync(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.deps.isEnabled()) return;

    const nowMs = this.now();
    let earliest: number | null = null;
    const wake = (atMs: number): void => {
      earliest = earliest === null ? atMs : Math.min(earliest, atMs);
    };

    for (const routine of this.deps.store.list()) {
      if (!routine.enabled || routine.nextRunAtMs === null) continue;
      if (routine.nextRunAtMs > nowMs) {
        wake(routine.nextRunAtMs);
        continue;
      }

      const next = this.handleDueRoutine(routine, nowMs);
      if (next !== null) wake(next);
    }

    if (earliest !== null && !this.disposed && this.deps.isEnabled()) {
      const waitMs = Math.max(0, Math.min(earliest - nowMs, ROUTINE_SCHEDULER_MAX_WAIT_MS));
      this.timer = setTimeout(() => this.sync(), waitMs);
    }
  }

  /** Stops the scheduler clock without touching live runs (used on gate-off). */
  stopTimer(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimer();
  }

  /**
   * Manually triggers a routine immediately without modifying `nextRunAtMs`.
   * Refuses inline (zero notices, zero history rows) if the gate is off, the routine's
   * previous run is still open, or the host-wide active-turn lane is busy.
   */
  async runNow(id: string): Promise<{ tabId: string; runId: string }> {
    if (!this.deps.isEnabled()) {
      throw new Error(ROUTINES_DISABLED_ERROR);
    }
    const routine = this.deps.store.get(id);
    if (routine === null) {
      throw new Error(`unknown routine ${id}`);
    }
    if (this.isRoutineOpen(routine)) {
      throw new Error("Previous run is still open");
    }
    if (this.isHostLaneBusy()) {
      throw new Error(ROUTINE_BUSY_REFUSAL);
    }

    const nowMs = this.now();
    return this.dispatchRoutine(routine, "manual", nowMs, null, 0, true);
  }

  private handleDueRoutine(routine: RoutineRecord, nowMs: number): number | null {
    const dueAtMs = routine.nextRunAtMs!;
    const late = nowMs - dueAtMs > SCHEDULED_PROMPT_LATE_MS;
    const missed = late ? countRunsBetween(routine.schedule, routine.timeZone, dueAtMs, nowMs) : 0;
    const next = nextRunAfter(routine.schedule, routine.timeZone, nowMs);
    const trigger: RoutineRunTrigger = late ? "late" : "clock";

    // 1. Per-routine overlap check (skip, never queue)
    if (this.isRoutineOpen(routine)) {
      this.recordSkip(routine, next, nowMs, dueAtMs, trigger, missed, "overlap");
      return next;
    }

    // 2. Host-wide active-turn lane check (skip, never queue)
    if (this.isHostLaneBusy()) {
      this.recordSkip(routine, next, nowMs, dueAtMs, trigger, missed, "host-lane-busy");
      return next;
    }

    // 3. Advance-before-dispatch: atomically persist nextRunAtMs (and late notice if late)
    //    before invoking dispatch so a crash or dispatch failure never double-fires.
    const notices = late
      ? prependNotice(routine.notices, {
          kind: "late",
          atMs: nowMs,
          dueAtMs,
          missed,
          error: null,
        })
      : routine.notices;

    this.deps.store.replaceScheduleState(routine.id, {
      nextRunAtMs: next,
      notices,
    });
    this.deps.publish();

    // 4. Fire asynchronously; failures record notices + failed history rows without throwing.
    void this.dispatchRoutine(routine, trigger, nowMs, dueAtMs, missed, false).catch((err) => {
      console.warn(`[routines] scheduled dispatch ${routine.id} failed unexpectedly:`, err);
    });

    return next;
  }

  private recordSkip(
    routine: RoutineRecord,
    nextRunAtMs: number | null,
    nowMs: number,
    dueAtMs: number,
    trigger: RoutineRunTrigger,
    missed: number,
    reasonCode: "overlap" | "host-lane-busy",
  ): void {
    this.deps.store.replaceScheduleState(routine.id, {
      nextRunAtMs,
      notices: prependNotice(routine.notices, {
        kind: "skipped",
        atMs: nowMs,
        dueAtMs,
        missed,
        error: null,
      }),
    });
    const row: RoutineRunRow = {
      id: this.uuid(),
      routineId: routine.id,
      routineName: routine.name,
      firedAtMs: nowMs,
      scheduledForMs: dueAtMs,
      trigger,
      outcome: "skipped",
      tabId: null,
      reasonCode,
      missed,
      pruned: false,
      staleCatalog: false,
    };
    this.deps.history.record(row);
    this.deps.publish();
  }

  /** Post-advance skip (#1283): writes the row, appends the notice, touches no schedule. */
  private recordPostDispatchSkip(
    routine: RoutineRecord,
    firedAtMs: number,
    scheduledForMs: number | null,
    trigger: RoutineRunTrigger,
    missed: number,
  ): RoutineRunRow {
    // Re-read the current record (never the fire-time snapshot) so a
    // concurrent update or a late notice written during the hook is never
    // lost; tolerate the routine having been deleted meanwhile.
    const current = this.deps.store.get(routine.id);
    if (current !== null) {
      this.deps.store.replaceScheduleState(current.id, {
        notices: prependNotice(current.notices, {
          kind: "skipped",
          atMs: firedAtMs,
          dueAtMs: scheduledForMs ?? firedAtMs,
          missed,
          error: null,
        }),
      });
    }
    const row: RoutineRunRow = {
      id: this.uuid(),
      routineId: routine.id,
      routineName: routine.name,
      firedAtMs,
      scheduledForMs,
      trigger,
      outcome: "skipped",
      tabId: null,
      reasonCode: "pre-script-skip",
      missed,
      pruned: false,
      staleCatalog: false,
    };
    this.deps.history.record(row);
    this.deps.publish();
    return row;
  }

  private async dispatchRoutine(
    routine: RoutineRecord,
    trigger: RoutineRunTrigger,
    firedAtMs: number,
    scheduledForMs: number | null,
    missed: number,
    throwOnFailure: boolean,
  ): Promise<{ tabId: string; runId: string }> {
    this.inFlightByRoutine.add(routine.id);
    this.inFlightHostDispatches += 1;

    let staleCatalog = false;
    try {
      if (!this.deps.hasProject(routine.destination.projectCwd)) {
        return this.handleDispatchFailure(
          routine,
          trigger,
          firedAtMs,
          scheduledForMs,
          missed,
          "project-missing",
          "Destination project unavailable",
          false,
          throwOnFailure,
        );
      }

      // Pre-run hook (#1283): fails closed. Runs in the destination checkout —
      // the worktree does not exist until the spawn below. The inFlight guards
      // held across this await block re-fires without new locking; time counts
      // against the run's wall clock (pre budget is 1/30 of it).
      if (routine.scripts.pre.trim() !== "") {
        let result: RoutineScriptResult;
        try {
          result = await this.deps.runScript(routine.scripts.pre, routine.destination.projectCwd, {
            OMP_UI_ROUTINE_ID: routine.id,
            OMP_UI_ROUTINE_TRIGGER: trigger,
            OMP_UI_ROUTINE_PROJECT_CWD: routine.destination.projectCwd,
            OMP_UI_ROUTINE_WORKSPACE: routine.destination.workspace,
          });
        } catch (err) {
          // A wiring bug, not an exit status: treat as failed, never reject.
          console.warn(`[routines] ${routine.id}: pre hook threw:`, err);
          result = { kind: "failed", timedOut: false, exitCode: null };
        }
        // Re-check admission after the await: "gate off fires nothing"
        // (ADR-0100 §1) outranks an in-flight pre hook; a deleted routine
        // dispatches nothing either.
        if (!this.deps.isEnabled() || this.deps.store.get(routine.id) === null) {
          return { tabId: "", runId: "" };
        }
        if (result.kind === "skip") {
          const row = this.recordPostDispatchSkip(routine, firedAtMs, scheduledForMs, trigger, missed);
          // Same empty-tabId convention as handleDispatchFailure: Run now
          // resolves; the editor shows a neutral "nothing to do" line.
          return { tabId: "", runId: row.id };
        }
        if (result.kind === "failed") {
          return this.handleDispatchFailure(
            routine,
            trigger,
            firedAtMs,
            scheduledForMs,
            missed,
            "pre-script",
            result.timedOut ? "Pre-run script timed out" : "Pre-run script failed",
            false,
            throwOnFailure,
          );
        }
      }

      const catalog = await this.deps.listCatalog(routine.destination.projectCwd, {
        fallbackReviewedKeys: routine.toolPolicy.reviewedCatalog,
      });
      staleCatalog = catalog.staleServers.length > 0 || catalog.enumerationError !== null;

      const allowAgentNotify = routineAllowsAgentNotification(routine.notifications);
      const compiled = compileRoutineToolPolicy(routine.toolPolicy, catalog, { allowAgentNotify });
      const warnCostUsd = routine.spend.warnUsd ?? this.deps.defaultWarnCostUsd();
      const maxCostUsd = routine.spend.maxUsd ?? this.deps.defaultMaxCostUsd();
      const sessionRoutine: SessionRoutine = {
        id: routine.id,
        name: routine.name,
        approvalEntries: compiled.overlayEntries,
        deniedBuiltins: compiled.deniedBuiltins,
        warnCostUsd,
        maxCostUsd,
      };

      const result = await this.deps.dispatch(
        {
          targets: {
            kind: "explicit",
            picks: [
              {
                machineKey: LOCAL_MACHINE_KEY,
                projectCwd: routine.destination.projectCwd,
              },
            ],
          },
          prompt: routinePrompt(routine.instructions, routine.name, { agentNotification: allowAgentNotify }),
          title: routineRunTitle(routine.name, firedAtMs, routine.timeZone),
          workspace: routine.destination.workspace,
          planMode: routine.mode === "plan",
          ...(routine.model === null ? {} : { model: routine.model }),
          ...(routine.thinkingLevel === null ? {} : { thinkingLevel: routine.thinkingLevel }),
        },
        { kind: "routine", routine: sessionRoutine },
        { deadlineMs: ROUTINE_DISPATCH_DEADLINE_MS },
      );

      const outcome = result.outcomes[0];
      if (outcome === undefined || outcome.status !== "started") {
        const reasonCode: RoutineRunReasonCode = !this.deps.hasProject(routine.destination.projectCwd)
          ? "project-missing"
          : "dispatch-failed";
        const message =
          reasonCode === "project-missing"
            ? "Destination project unavailable"
            : "Could not start session";
        return this.handleDispatchFailure(
          routine,
          trigger,
          firedAtMs,
          scheduledForMs,
          missed,
          reasonCode,
          message,
          staleCatalog,
          throwOnFailure,
        );
      }

      const runId = this.uuid();
      const tabId = outcome.tabId;

      // Update lastRunAtMs / lastRunTabId without touching nextRunAtMs (already advanced for clock/late, untouched for manual).
      if (this.deps.store.get(routine.id) !== null) {
        this.deps.store.replaceScheduleState(routine.id, {
          lastRunAtMs: firedAtMs,
          lastRunTabId: tabId,
        });
      }

      const row: RoutineRunRow = {
        id: runId,
        routineId: routine.id,
        routineName: routine.name,
        firedAtMs,
        scheduledForMs,
        trigger,
        outcome: "running",
        tabId,
        reasonCode: null,
        missed,
        pruned: false,
        staleCatalog,
      };
      this.deps.history.record(row);
      if (routine.notifications.onStart) {
        this.deps.notifyRoutine?.({
          routineId: routine.id,
          tabId,
          title: routine.name,
          body:
            trigger === "manual"
              ? "Routine started (manual)"
              : trigger === "late"
                ? "Routine started (late)"
                : "Routine started",
        });
      }
      this.deps.onRunStarted(tabId, routine, runId, trigger, firedAtMs);
      this.deps.publish();
      if (this.deps.onPostFire) {
        void Promise.resolve(this.deps.onPostFire()).catch((err) => {
          console.warn("[routines] post-fire retention failed:", err);
        });
      }
      return { tabId, runId };
    } catch (err) {
      if (throwOnFailure && err instanceof RoutineDispatchFailureError) {
        throw err;
      }
      return this.handleDispatchFailure(
        routine,
        trigger,
        firedAtMs,
        scheduledForMs,
        missed,
        "dispatch-failed",
        "Could not start session",
        staleCatalog,
        throwOnFailure,
      );
    } finally {
      this.inFlightByRoutine.delete(routine.id);
      this.inFlightHostDispatches = Math.max(0, this.inFlightHostDispatches - 1);
    }
  }

  private handleDispatchFailure(
    routine: RoutineRecord,
    trigger: RoutineRunTrigger,
    firedAtMs: number,
    scheduledForMs: number | null,
    missed: number,
    reasonCode: RoutineRunReasonCode,
    fixedMessage: string,
    staleCatalog: boolean,
    throwOnFailure: boolean,
  ): never | { tabId: string; runId: string } {
    const current = this.deps.store.get(routine.id);
    if (current !== null) {
      this.deps.store.replaceScheduleState(routine.id, {
        notices: prependNotice(current.notices, {
          kind: "failed",
          atMs: this.now(),
          dueAtMs: scheduledForMs ?? firedAtMs,
          missed: 0,
          error: fixedMessage,
        }),
      });
    }
    const row: RoutineRunRow = {
      id: this.uuid(),
      routineId: routine.id,
      routineName: routine.name,
      firedAtMs,
      scheduledForMs,
      trigger,
      outcome: "failed",
      tabId: null,
      reasonCode,
      missed,
      pruned: false,
      staleCatalog,
    };
    this.deps.history.record(row);
    this.deps.publish();
    if (routine.notifications.onFail) {
      this.deps.notifyRoutine?.({
        routineId: routine.id,
        tabId: null,
        title: routine.name,
        body: `Failed — ${fixedMessage}`,
      });
    }
    if (throwOnFailure) {
      throw new RoutineDispatchFailureError(fixedMessage);
    }
    return { tabId: "", runId: row.id };
  }
}

class RoutineDispatchFailureError extends Error {}
