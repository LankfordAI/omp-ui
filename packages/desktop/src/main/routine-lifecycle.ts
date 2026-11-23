import {
  APPROVAL_DENY,
  DEFAULT_ROUTINE_NOTIFICATIONS,
  ROUTINE_APPROVAL_TIMEOUT_MS,
  ROUTINE_REASON_LABEL,
  ROUTINE_RUN_SETTLE_GRACE_MS,
  isNonTerminalAgentEnd,
  isObject,
  isUsageLimitError,
  normalizeControlFrame,
  parseApprovalPrompt,
  parseExtensionDialogCancel,
  routineAllowsAgentNotification,
  type RoutineNotifications,
  type RoutineRunHistory,
  type RoutineRunReasonCode,
  type RoutineRunRow,
  type RoutineRunTrigger,
  type RoutineScripts,
  type RoutineWorkspace,
  type RpcFrame,
} from "@omp-ui/core";
import type { RoutineNotificationPayload } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";
import type { RoutineScriptEnv, RoutineScriptResult } from "./routine-scripts";

/** Longest single wait for any per-run timer, so OS sleep/wake never drifts a deadline past a minute. */
export const ROUTINE_LIFECYCLE_MAX_WAIT_MS = 60_000;

type RowPatch = Partial<Pick<RoutineRunRow, "outcome" | "reasonCode" | "postScript">>;

/** Fire-time pin handed by the scheduler at bind (#1283): mid-run edits and
 *  deletes can neither change nor skip an in-flight post hook. */
export interface RoutineRunPin {
  scripts: RoutineScripts;
  routineId: string;
  routineName: string;
  projectCwd: string;
  workspace: RoutineWorkspace;
  /** Resolved fire-time wall-clock budget in ms; null = unlimited (#1290). */
  wallClockMs: number | null;
  /** Fire-time notification preferences (#1294). */
  notifications: RoutineNotifications;
}

export interface RoutineLifecycleDeps {
  history: RoutineRunHistory;
  /** The Experimental gate; while off every timer is parked. */
  isEnabled: () => boolean;
  /** True when the tab's registry record carries a routine marker. */
  isRoutineTab: (tabId: string) => boolean;
  /** `turns.isRunning(tabId) || awaitingHumanAnswer(tabId)`. */
  inRun: (tabId: string) => boolean;
  awaitingHumanAnswer: (tabId: string) => boolean;
  /** Ids of the tab's open blocking dialogs (`DialogGateTracker.openFrames`). */
  openDialogIds: (tabId: string) => string[];
  /** The ordinary Settle path; resolves false when the child did not stop. */
  settleSession: (tabId: string) => Promise<boolean>;
  /** The normal reply rail (`SessionManager.rpcSend`). */
  rpcSend: (tabId: string, cmd: RpcFrame) => void;
  /** Runs one post-run hook; the runner resolves (never rejects) with a fixed result (#1283). */
  runScript: (command: string, cwd: string, env: RoutineScriptEnv) => Promise<RoutineScriptResult>;
  /** The run's actual working directory (`worktree?.path ?? projectCwd`), read once at bind. */
  runDirectory: (tabId: string) => string | null;
  /** Publishes `routines:state`. */
  publish: () => void;
  /** Posts a per-routine OS notification (#1294). */
  notifyRoutine?: (payload: RoutineNotificationPayload) => void;
  /** Clears a routine tab's notification (e.g. when an Approval card closes). */
  clearRoutineNotification?: (tabId: string) => void;
  now?: () => number;
}

interface RunState {
  runRowId: string | null;
  trigger: RoutineRunTrigger;
  /** Pinned wall-clock deadline from fire; null when unlimited, resumed (human-continued), or after terminal end. */
  wallDeadline: number | null;
  settleDeadline: number | null;
  /** Open Approval card frame id → 24 h auto-Deny deadline. */
  approvals: Map<string, number>;
  failure: RoutineRunReasonCode | null;
  autoDenied: boolean;
  finalized: boolean;
  /** Row writes that arrived before the scheduler bound the run row. */
  pending: RowPatch;
  timer: NodeJS.Timeout | undefined;
  /** Post-run hook pin (#1283), set by trackStart from the fire-time record. */
  postCommand: string;
  routineId: string;
  routineName: string;
  notifications: RoutineNotifications;
  bound: boolean;
  agentNotified: boolean;
  pendingApprovalTool: string | null;
  completionNotified: boolean;
  projectCwd: string;
  workspace: RoutineWorkspace;
  /** Pinned at bind; never re-read — releaseWorktree clears record.worktree before reclaiming. */
  runDir: string | null;
  /** This run's single hook shot has been taken (set synchronously at first finalization). */
  postClaimed: boolean;
  /** Outcome/reason recorded by finalize(); every post call reads these, never a caller argument. */
  finalOutcome: "on-time" | "late" | "failed" | null;
  finalReason: RoutineRunReasonCode | null;
}

/**
 * The one main-process owner of every per-run Routine timer (ADR-0100, §7.2):
 * the 60 s self-Settle grace after a terminal `agent_end`, the 24 h Approval
 * card auto-Deny, and the pinned wall clock from fire (if limited). Each wait is stepped
 * at ≤ 60 s. Also records the run's outcome (cost cap, usage limit, error,
 * normal end) on its history row. Gate-off parks every timer without reaping.
 */
export class RoutineLifecycleManager implements FrameObserver {
  private readonly runs = new Map<string, RunState>();
  /** Tabs whose post hook is live even though the run state may already be gone (§7.4 latch). */
  readonly postRunningTabs = new Set<string>();
  private readonly now: () => number;

  constructor(private readonly deps: RoutineLifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** True while that tab's post-run hook is still executing (#1283). */
  postRunning(tabId: string): boolean {
    return this.postRunningTabs.has(tabId);
  }

  /** Records that the run posted a notification via omp-ui_notify (#1294). */
  markAgentNotified(tabId: string): void {
    if (!this.runs.has(tabId) && !this.deps.isRoutineTab(tabId)) return;
    this.state(tabId).agentNotified = true;
  }

  /** Binds a freshly dispatched run: its history row and the wall clock from fire. */
  trackStart(
    tabId: string,
    runRowId: string,
    trigger: RoutineRunTrigger,
    firedAtMs: number,
    pinned: RoutineRunPin,
  ): void {
    const state = this.state(tabId);
    state.runRowId = runRowId;
    state.trigger = trigger;
    state.wallDeadline =
      state.finalized || pinned.wallClockMs === null ? null : firedAtMs + pinned.wallClockMs;
    // Fire-time pin (#1283): the run cannot have been released yet (release
    // needs a human Finish or 30-day retention), so this one read is correct.
    state.postCommand = pinned.scripts.post;
    state.routineId = pinned.routineId;
    state.routineName = pinned.routineName;
    state.notifications = { ...pinned.notifications };
    state.bound = true;
    state.projectCwd = pinned.projectCwd;
    state.workspace = pinned.workspace;
    if (state.runDir === null) state.runDir = this.deps.runDirectory(tabId);
    if (Object.keys(state.pending).length > 0) {
      this.deps.history.update(runRowId, state.pending);
      state.pending = {};
      this.deps.publish();
    }
    if (state.finalized) {
      this.emitTerminalNotification(tabId, state);
    } else if (state.approvals.size > 0 && state.pendingApprovalTool !== null) {
      const toolName = state.pendingApprovalTool;
      state.pendingApprovalTool = null;
      if (state.notifications.onApproval) {
        this.emitApprovalNotification(tabId, state, toolName);
      }
    }
    // Pre-bind race: a terminal agent_end or exit may have finalized the run
    // before binding (outcome buffered in pending). That run still gets exactly
    // one hook — deferred — and settleDeadline stays untouched, since today's
    // synchronous arm already ran on the early frame.
    if (state.finalized && this.claimPost(state)) void this.runPostScript(tabId, state);
    this.schedule(tabId, state);
  }

  /** Tabs currently holding at least one open Approval card. */
  waitingApprovalCount(): number {
    let n = 0;
    for (const state of this.runs.values()) if (state.approvals.size > 0) n += 1;
    return n;
  }

  /** Gate off: clears every timer without settling or killing anything (#1255 clause 9). */
  parkAll(): void {
    for (const state of this.runs.values()) {
      clearTimeout(state.timer);
      state.timer = undefined;
    }
  }

  /** Gate back on: re-arms every run from its absolute deadlines. */
  resumeAll(): void {
    for (const [tabId, state] of this.runs) this.schedule(tabId, state);
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    if (!this.runs.has(tabId) && !this.deps.isRoutineTab(tabId)) return;
    const state = this.state(tabId);

    const cancelled = parseExtensionDialogCancel(frame);
    if (cancelled !== null) {
      this.closeApproval(tabId, state, cancelled);
      return;
    }

    const control = normalizeControlFrame(frame);
    if (control?.kind === "ext_request" && control.method === "select" && typeof control.id === "string") {
      const prompt = parseApprovalPrompt(frame.title, frame.options);
      if (prompt === null) return;
      state.approvals.set(control.id, this.now() + ROUTINE_APPROVAL_TIMEOUT_MS);
      state.settleDeadline = null;
      if (!state.finalized) {
        this.writeRow(state, { outcome: "waiting-approval" });
        if (state.bound) {
          if (state.notifications.onApproval) {
            this.emitApprovalNotification(tabId, state, prompt.toolName);
          }
        } else {
          state.pendingApprovalTool = prompt.toolName;
        }
      }
      this.schedule(tabId, state);
      return;
    }

    switch (frame.type) {
      case "agent_start":
        state.settleDeadline = null;
        this.schedule(tabId, state);
        return;
      case "notice":
        if (frame.source === "cost-gate" && frame.level === "error") state.failure = "cost-cap";
        return;
      case "prompt_result": {
        const error = isObject(frame.error) ? frame.error : null;
        if (error?.code === "cost_cap") state.failure = "cost-cap";
        return;
      }
      case "message_end": {
        const message = isObject(frame.message) ? frame.message : null;
        if (message?.role !== "assistant" || message.stopReason !== "error") return;
        if (isUsageLimitError(message.stopReason, message.errorId)) state.failure = "usage-limit";
        else state.failure ??= "error";
        return;
      }
      case "agent_end":
        if (isNonTerminalAgentEnd(frame)) return;
        this.onTerminalEnd(tabId, state);
        return;
      default:
        return;
    }
  }

  onSend(tabId: string, cmd: RpcFrame): void {
    const state = this.runs.get(tabId);
    if (state === undefined) return;
    const control = normalizeControlFrame(cmd);
    if (control?.kind === "ext_response" && typeof control.id === "string") this.closeApproval(tabId, state, control.id);
  }

  onExit(tabId: string): void {
    const state = this.runs.get(tabId);
    if (state === undefined) return;
    clearTimeout(state.timer);
    // A run that died before its terminal end (pre-turn failure, quit) still gets a fixed outcome.
    if (!state.finalized) this.finalize(tabId, state, { outcome: "failed", reasonCode: state.failure ?? "error" });
    // The row write only needs state.runRowId and the latch lives in
    // postRunningTabs, so removing the map entry cannot hide a live hook (#1283).
    if (this.claimPost(state)) void this.runPostScript(tabId, state);
    this.runs.delete(tabId);
  }

  dispose(tabId: string): void {
    clearTimeout(this.runs.get(tabId)?.timer);
    this.runs.delete(tabId);
  }

  disposeAll(): void {
    this.parkAll();
    this.runs.clear();
  }

  private state(tabId: string): RunState {
    let state = this.runs.get(tabId);
    if (state === undefined) {
      state = {
        runRowId: null,
        trigger: "clock",
        wallDeadline: null,
        settleDeadline: null,
        approvals: new Map(),
        failure: null,
        autoDenied: false,
        finalized: false,
        pending: {},
        timer: undefined,
        postCommand: "",
        routineId: "",
        routineName: "",
        notifications: { ...DEFAULT_ROUTINE_NOTIFICATIONS },
        bound: false,
        agentNotified: false,
        pendingApprovalTool: null,
        completionNotified: false,
        projectCwd: "",
        workspace: "worktree",
        runDir: null,
        postClaimed: false,
        finalOutcome: null,
        finalReason: null,
      };
      this.runs.set(tabId, state);
    }
    return state;
  }

  private writeRow(state: RunState, patch: RowPatch): void {
    if (state.runRowId === null) {
      state.pending = { ...state.pending, ...patch };
      return;
    }
    this.deps.history.update(state.runRowId, patch);
    this.deps.publish();
  }

  private finalize(tabId: string, state: RunState, patch: RowPatch): void {
    state.finalized = true;
    if (patch.outcome !== undefined && patch.outcome !== "running" && patch.outcome !== "waiting-approval") {
      state.finalOutcome = patch.outcome === "late" ? "late" : patch.outcome === "on-time" ? "on-time" : "failed";
      state.finalReason = patch.reasonCode ?? null;
    }
    this.writeRow(state, patch);
    if (state.bound) this.emitTerminalNotification(tabId, state);
  }

  private emitApprovalNotification(tabId: string, state: RunState, toolName: string): void {
    this.deps.notifyRoutine?.({
      routineId: state.routineId,
      tabId,
      title: state.routineName,
      body: toolName.trim() !== "" ? `Approval needed: ${toolName}` : "Approval needed",
    });
  }

  private emitTerminalNotification(tabId: string, state: RunState): void {
    if (state.completionNotified || state.finalOutcome === null) return;
    state.completionNotified = true;
    if (state.finalOutcome === "failed") {
      if (!state.notifications.onFail) return;
      this.deps.notifyRoutine?.({
        routineId: state.routineId,
        tabId,
        title: state.routineName,
        body: `Failed — ${ROUTINE_REASON_LABEL[state.finalReason ?? "error"]}`,
      });
      return;
    }
    if (!state.notifications.onComplete) return;
    if (routineAllowsAgentNotification(state.notifications) && state.agentNotified) return;
    this.deps.notifyRoutine?.({
      routineId: state.routineId,
      tabId,
      title: state.routineName,
      body: state.autoDenied ? "Completed (an approval request timed out)" : "Completed",
    });
  }

  /** First finalizer wins the hook; every later path returns false (#1283). */
  private claimPost(state: RunState): boolean {
    if (state.postCommand.trim() === "" || state.postClaimed) return false;
    state.postClaimed = true; // synchronous, before any await
    return true;
  }

  /** Caller owns the claim. Never throws; always releases the latch below. */
  private async runPostScript(tabId: string, state: RunState): Promise<void> {
    if (state.runDir === null || !this.deps.isEnabled()) {
      this.writeRow(state, { postScript: "interrupted" }); // tab gone / gate off / dir lost
      this.deps.publish();
      return;
    }
    this.postRunningTabs.add(tabId);
    try {
      const result = await this.deps.runScript(state.postCommand, state.runDir, {
        OMP_UI_ROUTINE_ID: state.routineId,
        OMP_UI_ROUTINE_TRIGGER: state.trigger,
        OMP_UI_ROUTINE_PROJECT_CWD: state.projectCwd,
        OMP_UI_ROUTINE_WORKSPACE: state.workspace,
        OMP_UI_ROUTINE_OUTCOME: state.finalOutcome ?? "failed", // stored by finalize()
        OMP_UI_ROUTINE_REASON_CODE: state.finalReason ?? "",
        OMP_UI_ROUTINE_TAB_ID: tabId,
        OMP_UI_ROUTINE_RUN_CWD: state.runDir,
      });
      this.writeRow(state, {
        postScript:
          result.kind === "ok" ? "ok"
            : result.kind === "skip" ? "failed" // skip code is pre-only
            : result.timedOut ? "timeout" : "failed",
      });
    } catch (err) {
      console.warn(`[routines] ${tabId}: post hook errored:`, err);
      this.writeRow(state, { postScript: "failed" }); // latch still released below
    } finally {
      this.postRunningTabs.delete(tabId);
      this.deps.publish();
    }
  }

  /** First finalizer: finalize → claim → hook → arm Settle, with a fence after the await. */
  private async finishRun(tabId: string, state: RunState, patch: RowPatch): Promise<void> {
    const first = !state.finalized;
    if (first) this.finalize(tabId, state, patch); // finalize() also stores finalOutcome/finalReason
    if (first && this.claimPost(state)) await this.runPostScript(tabId, state);
    // Fence: `agent_start`, a card, an exit, or disposeAll() may have happened during the hook.
    if (this.runs.get(tabId) !== state) return;
    state.settleDeadline =
      this.deps.awaitingHumanAnswer(tabId) || this.deps.inRun(tabId) ? null : this.now() + ROUTINE_RUN_SETTLE_GRACE_MS;
    this.schedule(tabId, state);
  }

  /**
   * Wall-clock expiry: claim first (a synchronous statement, so it lands before
   * the reap's own `onExit()` could steal the hook and report reason_code=error),
   * then reap, then hook. No settle re-arm: it is already reaped (#1283).
   */
  private async reapThenPost(tabId: string, state: RunState): Promise<void> {
    const owns = this.claimPost(state); // before any await: beats onExit()
    const reaped = await this.deps.settleSession(tabId).catch(() => false);
    if (!owns) return; // terminal end already owns it
    if (!reaped) {
      // Child still live: never run shell alongside an un-reaped agent.
      this.writeRow(state, { postScript: "interrupted" });
      this.deps.publish();
      return;
    }
    await this.runPostScript(tabId, state);
  }

  private closeApproval(tabId: string, state: RunState, frameId: string): void {
    if (!state.approvals.delete(frameId)) return;
    if (state.approvals.size === 0 && !state.finalized) {
      state.pendingApprovalTool = null;
      this.writeRow(state, { outcome: "running" });
      this.deps.clearRoutineNotification?.(tabId);
    }
    this.schedule(tabId, state);
  }

  private onTerminalEnd(tabId: string, state: RunState): void {
    state.wallDeadline = null;
    // The first-terminal guard lives inside finishRun now; a continuation turn
    // (state.finalized already true) only re-arms the settle deadline, and the
    // outcome written at first finalization is never rewritten (#1283).
    void this.finishRun(
      tabId,
      state,
      state.failure !== null
        ? { outcome: "failed", reasonCode: state.failure }
        : {
            outcome: state.trigger === "late" ? "late" : "on-time",
            reasonCode: state.autoDenied ? "approval-timeout" : null,
          },
    );
  }

  private schedule(tabId: string, state: RunState): void {
    clearTimeout(state.timer);
    state.timer = undefined;
    if (!this.deps.isEnabled()) return;
    let earliest = Math.min(state.wallDeadline ?? Infinity, state.settleDeadline ?? Infinity);
    for (const deadline of state.approvals.values()) earliest = Math.min(earliest, deadline);
    if (earliest === Infinity) return;
    const wait = Math.max(0, Math.min(earliest - this.now(), ROUTINE_LIFECYCLE_MAX_WAIT_MS));
    state.timer = setTimeout(() => this.tick(tabId), wait);
  }

  private tick(tabId: string): void {
    const state = this.runs.get(tabId);
    if (state === undefined || !this.deps.isEnabled()) return;
    state.timer = undefined;
    const now = this.now();

    if (state.wallDeadline !== null && state.wallDeadline <= now) {
      state.wallDeadline = null;
      state.settleDeadline = null;
      state.approvals.clear();
      this.finalize(tabId, state, { outcome: "failed", reasonCode: "wall-clock" });
      void this.reapThenPost(tabId, state);
      return;
    }

    let expiredApproval = false;
    for (const [frameId, deadline] of [...state.approvals]) {
      if (deadline > now) continue;
      state.approvals.delete(frameId);
      expiredApproval = true;
      // Answer only a card still open: a human or omp may have settled it meanwhile.
      if (!this.deps.openDialogIds(tabId).includes(frameId)) continue;
      state.autoDenied = true;
      this.deps.rpcSend(tabId, { type: "extension_ui_response", id: frameId, value: APPROVAL_DENY });
    }
    if (expiredApproval && state.approvals.size === 0 && !state.finalized) {
      state.pendingApprovalTool = null;
      this.deps.clearRoutineNotification?.(tabId);
    }

    if (state.settleDeadline !== null && state.settleDeadline <= now) {
      state.settleDeadline = null;
      if (!this.deps.inRun(tabId)) {
        void this.deps.settleSession(tabId).catch((err: unknown) => console.warn(`[routines] ${tabId}: self-settle failed:`, err));
      }
    }

    this.schedule(tabId, state);
  }
}
