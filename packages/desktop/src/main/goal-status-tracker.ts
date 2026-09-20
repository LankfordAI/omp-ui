import {
  GOAL_STATUS_KEY,
  parseGoalSnapshot,
  type GoalSnapshot,
  type RpcFrame,
} from "@omp-ui/core";
import { BridgeSnapshotTracker } from "./bridge-snapshot-tracker";
import type { FrameObserver } from "./frame-observer";

export interface GoalStatusTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
}

/** Read-only goal projection plus the conservative live-work hibernation veto. */
export class GoalStatusTracker implements FrameObserver {
  private readonly goalWorkLive = new Map<string, boolean>();
  private readonly snapshots: BridgeSnapshotTracker<GoalSnapshot>;

  constructor(deps: GoalStatusTrackerDeps) {
    this.snapshots = new BridgeSnapshotTracker({
      statusKey: GOAL_STATUS_KEY,
      parse: parseGoalSnapshot,
      broadcast: deps.broadcast,
      onAccept: (tabId, snapshot) => {
        this.goalWorkLive.set(
          tabId,
          snapshot.available
            ? snapshot.continuation === "scheduled" ||
                snapshot.continuation === "running" ||
                snapshot.goal?.status === "active"
            : (this.goalWorkLive.get(tabId) ?? false),
        );
      },
      onClear: (tabId) => this.goalWorkLive.delete(tabId),
    });
  }

  snapshot(tabId: string): GoalSnapshot | undefined {
    return this.snapshots.snapshot(tabId);
  }

  preventsHibernation(tabId: string): boolean {
    return this.goalWorkLive.get(tabId) === true;
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    this.snapshots.onFrame(tabId, frame);
  }

  onExit(tabId: string): void {
    this.snapshots.onExit(tabId);
  }

  dispose(tabId: string): void {
    this.snapshots.dispose(tabId);
  }
}
