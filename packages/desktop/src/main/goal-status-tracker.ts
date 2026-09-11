import {
  GOAL_STATUS_KEY,
  normalizeControlFrame,
  parseGoalSnapshot,
  type GoalSnapshot,
  type RpcFrame,
} from "@omp-ui/core";
import type { FrameObserver } from "./frame-observer";

export interface GoalStatusTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
}

/** Which bridge instance owns a tab, and the instances it has outlived. */
interface GoalOwner {
  current: string;
  retired: Set<string>;
}

/**
 * The goal snapshots main keeps for display and hibernation (issue #381).
 *
 * The generated goal bridge inside each owned OMP process is the only owner of
 * goal state and of the autonomous continuation loop; this is a read-only
 * projection of what that bridge publishes. Nothing here mutates a goal, and
 * nothing is persisted: like the plan gate, a snapshot dies with the process.
 *
 * Acceptance is by bridge identity first and revision second. A frame from a
 * retired generation is a late publish from a killed spawn whose counter means
 * nothing next to the successor's, so identity drops it; within one generation
 * only an increasing revision may change what every client sees. A malformed
 * payload is dropped rather than read as "no goal", leaving the last good
 * snapshot standing.
 */
export class GoalStatusTracker implements FrameObserver {
  private readonly latest = new Map<string, GoalSnapshot>();
  private readonly owners = new Map<string, GoalOwner>();
  /**
   * Whether goal work may still be live for the tab. Kept apart from the
   * snapshot because losing the status is not evidence that the goal ended: once
   * goal work is known, only a valid snapshot that says otherwise — or the
   * process exiting — may clear it.
   */
  private readonly goalWorkLive = new Map<string, boolean>();

  constructor(private readonly deps: GoalStatusTrackerDeps) {}

  /** Latest accepted snapshot; undefined until this tab's bridge publishes. */
  snapshot(tabId: string): GoalSnapshot | undefined {
    return this.latest.get(tabId);
  }

  /**
   * True while an active goal or a scheduled/running continuation could be
   * working in the child. Hibernation must not silence it: hidden tabs and
   * disconnected renderers keep the child's loop running, and only an explicit
   * stop/quit/restart may end it (restoration then pauses the goal).
   */
  preventsHibernation(tabId: string): boolean {
    return this.goalWorkLive.get(tabId) === true;
  }

  onFrame(tabId: string, frame: RpcFrame): void {
    const control = normalizeControlFrame(frame);
    if (control === null || control.kind !== "ext_request") return;
    if (control.method !== "setStatus") return;
    const wire = control.frame;
    if (wire.statusKey !== GOAL_STATUS_KEY) return;
    const snapshot = parseGoalSnapshot(
      typeof wire.statusText === "string" ? wire.statusText : undefined,
    );
    // A malformed publish never replaces a good one and never means "no goal".
    if (snapshot === null) return;
    if (!this.adopts(tabId, snapshot.processKey)) return;
    const retained = this.latest.get(tabId);
    if (retained !== undefined && retained.processKey === snapshot.processKey &&
      snapshot.revision <= retained.revision) {
      return;
    }
    this.latest.set(tabId, snapshot);
    this.goalWorkLive.set(
      tabId,
      snapshot.available ? liveWork(snapshot) : (this.goalWorkLive.get(tabId) ?? false),
    );
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
    // Every map is cleared on its own statement: `a || b || c` would
    // short-circuit on the first entry and leave the hibernation veto behind.
    let had = this.latest.delete(tabId);
    had = this.owners.delete(tabId) || had;
    had = this.goalWorkLive.delete(tabId) || had;
    if (had) void this.deps.broadcast();
  }
}

/** What the published snapshot says about autonomous work being in progress. */
function liveWork(snapshot: GoalSnapshot): boolean {
  if (snapshot.continuation === "scheduled" || snapshot.continuation === "running") return true;
  return snapshot.goal?.status === "active";
}
