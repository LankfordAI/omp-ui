import {
  normalizeControlFrame,
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_EXECUTE,
  PLAN_STATUS_KEY,
  settleProposedPlan,
  upsertProposedPlan,
  type AgentMode,
  type PendingPlan,
  type PlanSettle,
  type ProposedPlan,
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

  /** Stops tracking an interrupted plan (ADR-0033). A live gate is answered, never dismissed. */
  dismiss(tabId: string, planFilePath: string): void {
    if (this.gates.get(tabId)?.pending?.planFilePath === planFilePath) return;
    if (this.recordPlans(tabId, (plans) => settleProposedPlan(plans, planFilePath, "dismissed"))) {
      void this.deps.broadcast();
    }
  }

  /**
   * Rewrites the session's persisted proposed plans (ADR-0033). `next` returns
   * its input when nothing changes; that skips the registry write. Runs before
   * the caller's broadcast so the summary reads the new record.
   */
  private recordPlans(tabId: string, next: (plans: ProposedPlan[]) => ProposedPlan[]): boolean {
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (record === undefined) return false;
    const updated = next(record.proposedPlans);
    if (updated === record.proposedPlans) return false;
    this.deps.registry.updateSession(tabId, { proposedPlans: updated });
    return true;
  }

  /**
   * The validated bytes changed under review (§6): the gate closes WITHOUT
   * a user verdict — `invalidated` is neither execute nor refine, so no
   * implementation row and no advisor fold can follow it.
   */
  invalidateGate(tabId: string): void {
    const gate = this.gates.get(tabId);
    if (gate === undefined || gate.pending === null) return;
    const key = gate.pending.planFilePath;
    this.gates.set(tabId, {
      pending: null,
      settle: { frameId: gate.pending.frameId, verdict: "invalidated" },
    });
    this.recordPlans(tabId, (plans) => settleProposedPlan(plans, key, "invalidated"));
    this.deps.attention?.planSettled(tabId);
    void this.deps.broadcast();
  }

  private clear(tabId: string): void {
    if (this.gates.delete(tabId)) void this.deps.broadcast();
  }

  /** Records a proposal as its frame passes through the session. */
  private seePlanFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request") return;
    const wire = control.frame;
    const review = parsePlanReviewTitle(typeof wire.title === "string" ? wire.title : undefined);
    if (review === null) return;
    const frameId = typeof control.id === "string" ? control.id : "";
    this.gates.set(tabId, {
      pending: {
        title: review.title,
        planFilePath: review.planFilePath,
        planAbsPath: review.planAbsPath,
        // An HTML gate that passed preflight carries main's hash (§5.3);
        // the ephemeral record copies it from the delivered request.
        ...(review.sourceHash !== undefined ? { sourceHash: review.sourceHash } : {}),
        frameId,
        proposedAt: new Date().toISOString(),
        ...(review.represented === true ? { represented: true as const } : {}),
      },
      settle: null, // a fresh gate replaces the last cycle's verdict
    });
    this.recordPlans(tabId, (plans) => upsertProposedPlan(plans, review.planFilePath, review.title));
    this.deps.attention?.planProposed(tabId, review.title);
    void this.deps.broadcast();
  }

  /**
   * Persists the agent mode the plan extension publishes so a respawn
   * restores it (issue #263).
   */
  private observePlanStatus(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request") return;
    if (control.method !== "setStatus") return;
    const wire = control.frame;
    if (wire.statusKey !== PLAN_STATUS_KEY) return;
    const status = parsePlanStatus(typeof wire.statusText === "string" ? wire.statusText : undefined);
    if (status === null) return; // malformed payload, never trusted over the record
    const next: AgentMode = status.enabled ? "plan" : "build";
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (record === undefined || record.agentMode === next) return; // no write, no broadcast
    this.deps.registry.updateSession(tabId, { agentMode: next });
    void this.deps.broadcast();
  }

  /** Settles the gate when its select answer comes back from any renderer. */
  private notePlanVerdict(tabId: string, cmd: RpcFrame): void {
    const control = normalizeControlFrame(cmd);
    if (control === null || control.kind !== "ext_response") return;
    const id = typeof control.id === "string" ? control.id : null;
    const gate = this.gates.get(tabId);
    if (id === null || !gate || gate.pending === null || gate.pending.frameId !== id) return;
    const key = gate.pending.planFilePath;
    const verdict = control.value === PLAN_EXECUTE ? "executed" : "refined";
    this.gates.set(tabId, { pending: null, settle: { frameId: id, verdict } });
    this.recordPlans(tabId, (plans) => settleProposedPlan(plans, key, verdict));
    this.deps.attention?.planSettled(tabId);
    // Between the verdict and the implementation prompt the process is
    // quiet; suspend hibernation until the next agent_end or the lapse (issue #246).
    this.deps.suspendForVerdict(tabId);
    void this.deps.broadcast();
  }
}
