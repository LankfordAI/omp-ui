import {
  parseVibeSnapshot,
  vibeWorkLive,
  VIBE_STATUS_KEY,
  type RpcFrame,
  type VibeSnapshot,
} from "@omp-ui/core";
import { BridgeSnapshotTracker } from "./bridge-snapshot-tracker";
import type { FrameObserver } from "./frame-observer";

export interface VibeStatusTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
}

/** Read-only vibe projection plus the worker-live hibernation veto. */
export class VibeStatusTracker implements FrameObserver {
  private readonly live = new Map<string, boolean>();
  private readonly snapshots: BridgeSnapshotTracker<VibeSnapshot>;

  constructor(deps: VibeStatusTrackerDeps) {
    this.snapshots = new BridgeSnapshotTracker({
      statusKey: VIBE_STATUS_KEY,
      parse: parseVibeSnapshot,
      broadcast: deps.broadcast,
      onAccept: (tabId, snapshot) => {
        this.live.set(tabId, snapshot.available && vibeWorkLive(snapshot));
      },
      onClear: (tabId) => this.live.delete(tabId),
    });
  }

  snapshot(tabId: string): VibeSnapshot | undefined {
    return this.snapshots.snapshot(tabId);
  }

  preventsHibernation(tabId: string): boolean {
    return this.live.get(tabId) === true;
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
