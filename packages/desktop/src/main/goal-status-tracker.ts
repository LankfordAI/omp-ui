import { goalStateFromFrame, goalWorkLive, type GoalState, type RpcFrame } from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

export interface GoalStatusTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
}

/**
 * Mirrors omp's goal state per live tab from goal responses, get_state and
 * goal_updated (ADR-0046), plus the hibernation veto while omp would continue
 * the goal. Absent = this tab's live process has reported nothing yet.
 */
export class GoalStatusTracker implements FrameObserver {
  private readonly states = new Map<string, GoalState | null>();

  constructor(private readonly deps: GoalStatusTrackerDeps) {}

  state(tabId: string): GoalState | null | undefined {
    return this.states.get(tabId);
  }

  preventsHibernation(tabId: string): boolean {
    return goalWorkLive(this.states.get(tabId) ?? null);
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    const next = goalStateFromFrame(frame);
    if (next === undefined) return;
    const prev = this.states.get(tabId);
    if (prev !== undefined && JSON.stringify(prev) === JSON.stringify(next)) return;
    this.states.set(tabId, next);
    void this.deps.broadcast();
  }

  onExit(tabId: string): void {
    if (this.states.delete(tabId)) void this.deps.broadcast();
  }

  dispose(tabId: string): void {
    this.onExit(tabId);
  }
}
