import {
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_EXECUTE,
  PLAN_STATUS_KEY,
  type AgentMode,
  type PendingPlan,
  type PlanSettle,
  type Registry,
  type RpcFrame,
} from "@omp-ui/core";
import type { Attention } from "./desktop-notifier";
import type { FrameObserver } from "./frame-observer";

/** One session's plan-review gate state, as observed from its frames. */
export interface PlanGate {
  pending: PendingPlan | null;
  settle: PlanSettle | null;
}

export interface PlanGateTrackerDeps {
  registry: Registry;
  broadcast: () => Promise<void>;
  attention?: Attention;
  /** Suspends hibernation across the post-verdict quiet window (issue #246). */
  suspendForVerdict: (tabId: string) => void;
}

/**
 * The live plan-review gates, keyed by tabId (issue #215). In-memory: they
 * die with the process, so a gate can never outlive its agent.
 */
export class PlanGateTracker implements FrameObserver {
  private readonly gates = new Map<string, PlanGate>();

  constructor(private readonly deps: PlanGateTrackerDeps) {}

  /** Read by MainBackend.summarize; undefined when the tab never proposed. */
  gate(tabId: string): PlanGate | undefined {
    return this.gates.get(tabId);
  }

  /** True while a plan proposal on this tab awaits a verdict. */
  pending(tabId: string): boolean {
    return this.gates.get(tabId)?.pending != null;
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    // the gate is set before the renderer fan-out can read it (issue #215).
    this.seePlanFrame(tabId, frame);
    // the extension's mode is persisted here so a respawn restores it (issue #263).
    this.observePlanStatus(tabId, frame);
  }

  onSend(tabId: string, cmd: RpcFrame): void {
    this.notePlanVerdict(tabId, cmd);
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  private clear(tabId: string): void {
    if (this.gates.delete(tabId)) void this.deps.broadcast();
  }

  /** Records a proposal as its frame passes through the session. */
  private seePlanFrame(tabId: string, frame: RpcFrame): void {
    if (typeof frame !== "object" || frame === null) return;
    if (frame.type !== "extension_ui_request") return;
    const review = parsePlanReviewTitle(typeof frame.title === "string" ? frame.title : undefined);
    if (review === null) return;
    const frameId = typeof frame.id === "string" ? frame.id : "";
    this.gates.set(tabId, {
      pending: {
        title: review.title,
        planFilePath: review.planFilePath,
        planAbsPath: review.planAbsPath,
        frameId,
        proposedAt: new Date().toISOString(),
      },
      settle: null, // a fresh gate replaces the last cycle's verdict
    });
    this.deps.attention?.planProposed(tabId, review.title);
    void this.deps.broadcast();
  }

  /**
   * Persists the agent mode the plan extension publishes so a respawn
   * restores it (issue #263).
   */
  private observePlanStatus(tabId: string, frame: RpcFrame): void {
    if (typeof frame !== "object" || frame === null) return;
    if (frame.type !== "extension_ui_request" || frame.method !== "setStatus") return;
    if (frame.statusKey !== PLAN_STATUS_KEY) return;
    const status = parsePlanStatus(typeof frame.statusText === "string" ? frame.statusText : undefined);
    if (status === null) return; // malformed payload, never trusted over the record
    const next: AgentMode = status.enabled ? "plan" : "build";
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (record === undefined || record.agentMode === next) return; // no write, no broadcast
    this.deps.registry.updateSession(tabId, { agentMode: next });
    void this.deps.broadcast();
  }

  /** Settles the gate when its select answer comes back from any renderer. */
  private notePlanVerdict(tabId: string, cmd: RpcFrame): void {
    if (cmd.type !== "extension_ui_response") return;
    const id = typeof cmd.id === "string" ? cmd.id : null;
    const gate = this.gates.get(tabId);
    if (id === null || !gate || gate.pending === null || gate.pending.frameId !== id) return;
    this.gates.set(tabId, {
      pending: null,
      settle: { frameId: id, verdict: cmd.value === PLAN_EXECUTE ? "executed" : "refined" },
    });
    this.deps.attention?.planSettled(tabId);
    // Between the verdict and the implementation prompt the process is
    // quiet; suspend hibernation until the next agent_end or the lapse (issue #246).
    this.deps.suspendForVerdict(tabId);
    void this.deps.broadcast();
  }
}
