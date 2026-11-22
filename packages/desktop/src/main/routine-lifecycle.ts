import {
  APPROVAL_DENY,
  ROUTINE_APPROVAL_TIMEOUT_MS,
  ROUTINE_RUN_SETTLE_GRACE_MS,
  ROUTINE_RUN_WALL_CLOCK_MS,
  isNonTerminalAgentEnd,
  isObject,
  isUsageLimitError,
  normalizeControlFrame,
  parseApprovalPrompt,
  parseExtensionDialogCancel,
  type RoutineRunHistory,
  type RoutineRunReasonCode,
  type RoutineRunRow,
  type RoutineRunTrigger,
  type RpcFrame,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

/** Longest single wait for any per-run timer, so OS sleep/wake never drifts a deadline past a minute. */
export const ROUTINE_LIFECYCLE_MAX_WAIT_MS = 60_000;

type RowPatch = Partial<Pick<RoutineRunRow, "outcome" | "reasonCode">>;

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
  /** The ordinary Settle path; never joins renderer undo. */
  settleSession: (tabId: string) => Promise<boolean>;
  /** The normal reply rail (`SessionManager.rpcSend`). */
  rpcSend: (tabId: string, cmd: RpcFrame) => void;
  /** Publishes `routines:state`. */
  publish: () => void;
  now?: () => number;
}

interface RunState {
  runRowId: string | null;
  trigger: RoutineRunTrigger;
  /** Absolute 30-min deadline from fire; null for a resumed (human-continued) run or after terminal end. */
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
}

/**
 * The one main-process owner of every per-run Routine timer (ADR-0100, §7.2):
 * the 60 s self-Settle grace after a terminal `agent_end`, the 24 h Approval
 * card auto-Deny, and the 30-minute wall clock from fire. Each wait is stepped
 * at ≤ 60 s. Also records the run's outcome (cost cap, usage limit, error,
 * normal end) on its history row. Gate-off parks every timer without reaping.
 */
export class RoutineLifecycleManager implements FrameObserver {
  private readonly runs = new Map<string, RunState>();
  private readonly now: () => number;

  constructor(private readonly deps: RoutineLifecycleDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Binds a freshly dispatched run: its history row and the wall clock from fire. */
  trackStart(tabId: string, runRowId: string, trigger: RoutineRunTrigger, firedAtMs: number): void {
    const state = this.state(tabId);
    state.runRowId = runRowId;
    state.trigger = trigger;
    state.wallDeadline = state.finalized ? null : firedAtMs + ROUTINE_RUN_WALL_CLOCK_MS;
    if (Object.keys(state.pending).length > 0) {
      this.deps.history.update(runRowId, state.pending);
      state.pending = {};
      this.deps.publish();
    }
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
      if (parseApprovalPrompt(frame.title, frame.options) === null) return;
      state.approvals.set(control.id, this.now() + ROUTINE_APPROVAL_TIMEOUT_MS);
      state.settleDeadline = null;
      if (!state.finalized) this.writeRow(state, { outcome: "waiting-approval" });
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
    if (!state.finalized) this.finalize(state, { outcome: "failed", reasonCode: state.failure ?? "error" });
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

  private finalize(state: RunState, patch: RowPatch): void {
    state.finalized = true;
    this.writeRow(state, patch);
  }

  private closeApproval(tabId: string, state: RunState, frameId: string): void {
    if (!state.approvals.delete(frameId)) return;
    if (state.approvals.size === 0 && !state.finalized) this.writeRow(state, { outcome: "running" });
    this.schedule(tabId, state);
  }

  private onTerminalEnd(tabId: string, state: RunState): void {
    state.wallDeadline = null;
    if (!state.finalized) {
      this.finalize(
        state,
        state.failure !== null
          ? { outcome: "failed", reasonCode: state.failure }
          : {
              outcome: state.trigger === "late" ? "late" : "on-time",
              reasonCode: state.autoDenied ? "approval-timeout" : null,
            },
      );
    }
    state.settleDeadline = this.deps.awaitingHumanAnswer(tabId) ? null : this.now() + ROUTINE_RUN_SETTLE_GRACE_MS;
    this.schedule(tabId, state);
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
      this.finalize(state, { outcome: "failed", reasonCode: "wall-clock" });
      void this.deps.settleSession(tabId).catch((err: unknown) => console.warn(`[routines] ${tabId}: wall-clock settle failed:`, err));
      return;
    }

    for (const [frameId, deadline] of [...state.approvals]) {
      if (deadline > now) continue;
      state.approvals.delete(frameId);
      // Answer only a card still open: a human or omp may have settled it meanwhile.
      if (!this.deps.openDialogIds(tabId).includes(frameId)) continue;
      state.autoDenied = true;
      this.deps.rpcSend(tabId, { type: "extension_ui_response", id: frameId, value: APPROVAL_DENY });
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
