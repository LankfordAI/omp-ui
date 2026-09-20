import {
  AUTORESEARCH_STATUS_KEY,
  parseAutoresearchSnapshot,
  type AutoresearchSnapshot,
  type RpcFrame,
} from "@omp-ui/core";
import { BridgeSnapshotTracker } from "./bridge-snapshot-tracker";
import type { FrameObserver } from "./frame-observer";

export interface AutoresearchStatusTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
}

/** Read-only projection of the generated autoresearch bridge's latest snapshot. */
export class AutoresearchStatusTracker implements FrameObserver {
  private readonly snapshots: BridgeSnapshotTracker<AutoresearchSnapshot>;

  constructor(deps: AutoresearchStatusTrackerDeps) {
    this.snapshots = new BridgeSnapshotTracker({
      statusKey: AUTORESEARCH_STATUS_KEY,
      parse: parseAutoresearchSnapshot,
      broadcast: deps.broadcast,
    });
  }

  snapshot(tabId: string): AutoresearchSnapshot | undefined {
    return this.snapshots.snapshot(tabId);
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
