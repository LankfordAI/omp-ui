import {
  AUTORESEARCH_STATUS_KEY,
  normalizeControlFrame,
  parseAutoresearchSnapshot,
  type AutoresearchSnapshot,
  type RpcFrame,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

export interface AutoresearchStatusTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
}

/** Which bridge instance owns a tab, and the instances it has outlived. */
interface BridgeOwner {
  current: string;
  retired: Set<string>;
}

/**
 * The autoresearch snapshots main keeps for the Session HUD chip and the Lab
 * (issue #559).
 *
 * omp's own autoresearch extension owns the mode, the goal, and the loop; the
 * generated bridge inside each owned OMP process publishes a reduced snapshot
 * of that state and this is a read-only projection of it. Nothing here mutates
 * an experiment, and nothing is persisted: a snapshot dies with the process,
 * while run history lives in omp's SQLite DB (autoresearch-store.ts).
 *
 * Acceptance mirrors GoalStatusTracker: bridge identity first, revision
 * second. A frame from a retired generation is a late publish from a killed
 * spawn whose counter means nothing next to the successor's, so identity drops
 * it; within one generation only an increasing revision may change what every
 * client sees. A malformed payload is dropped rather than read as "off",
 * leaving the last good snapshot standing.
 */
export class AutoresearchStatusTracker implements FrameObserver {
  private readonly latest = new Map<string, AutoresearchSnapshot>();
  private readonly owners = new Map<string, BridgeOwner>();

  constructor(private readonly deps: AutoresearchStatusTrackerDeps) {}

  /** Latest accepted snapshot; undefined until this tab's bridge publishes. */
  snapshot(tabId: string): AutoresearchSnapshot | undefined {
    return this.latest.get(tabId);
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request") return;
    if (control.method !== "setStatus") return;
    const wire = control.frame;
    if (wire.statusKey !== AUTORESEARCH_STATUS_KEY) return;
    const snapshot = parseAutoresearchSnapshot(
      typeof wire.statusText === "string" ? wire.statusText : undefined,
    );
    // A malformed publish never replaces a good one and never means "off".
    if (snapshot === null) return;
    if (!this.adopts(tabId, snapshot.processKey)) return;
    const retained = this.latest.get(tabId);
    if (retained !== undefined && retained.processKey === snapshot.processKey &&
      snapshot.revision <= retained.revision) {
      return;
    }
    this.latest.set(tabId, snapshot);
    void this.deps.broadcast();
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  /**
   * Whether a frame's bridge instance owns the tab, recording the change. The
   * first frame sets the owner; a different instance takes over once and retires
   * the previous one, so a late publish from the dead generation can never
   * overwrite the replacement's state.
   */
  private adopts(tabId: string, processKey: string): boolean {
    const owner = this.owners.get(tabId);
    if (owner === undefined) {
      this.owners.set(tabId, { current: processKey, retired: new Set<string>() });
      return true;
    }
    if (owner.current === processKey) return true;
    if (owner.retired.has(processKey)) return false;
    owner.retired.add(owner.current);
    owner.current = processKey;
    return true;
  }

  private clear(tabId: string): void {
    let had = this.latest.delete(tabId);
    had = this.owners.delete(tabId) || had;
    if (had) void this.deps.broadcast();
  }
}
