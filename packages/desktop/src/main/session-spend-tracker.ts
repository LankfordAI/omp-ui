import {
  SESSION_SPEND_POLL_MS,
  SESSION_SPEND_STATUS_KEY,
  parseSessionSpendSnapshot,
  spendTotalsEqual,
  type RpcFrame,
  type SessionSpendSnapshot,
  type SpendTotals,
} from "@omp-ui/core";
import { BridgeSnapshotTracker } from "./bridge-snapshot-tracker";
import type { FrameObserver } from "./frame-observer";

export interface SessionSpendTrackerDeps {
  /** Notifies main's state broadcast so every client's summary stays current. */
  broadcast: () => Promise<void>;
  /** Minimum interval between live spend broadcasts for the same tab; default SESSION_SPEND_POLL_MS (2s). */
  throttleMs?: number;
  /** Clock seam for deterministic throttle tests; defaults to Date.now. */
  now?: () => number;
}

function sameSummarySpend(a: SpendTotals | null, b: SpendTotals | null): boolean {
  if (a === null || b === null) return a === b;
  return spendTotalsEqual(a, b);
}

/**
 * Main-process projection of the generated session-spend bridge's latest
 * snapshot (ADR-0056 / issue #1279). Publishes live spend onto `SessionSummary`
 * so orchestrator sessions can aggregate unopened live children and remote
 * children without mounting them in the renderer.
 *
 * Suppresses redundant broadcasts when totals have not changed (such as a
 * force-republish triggered when a renderer opens a tab) and throttles rapid
 * live updates per tab with leading + trailing delivery.
 */
export class SessionSpendTracker implements FrameObserver {
  private readonly snapshots: BridgeSnapshotTracker<SessionSpendSnapshot>;
  private readonly broadcast: () => Promise<void>;
  private readonly throttleMs: number;
  private readonly now: () => number;
  private readonly lastBroadcasted = new Map<string, SpendTotals | null>();
  private readonly lastBroadcastAt = new Map<string, number>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(deps: SessionSpendTrackerDeps) {
    this.broadcast = deps.broadcast;
    this.throttleMs = deps.throttleMs ?? SESSION_SPEND_POLL_MS;
    this.now = deps.now ?? Date.now;
    this.snapshots = new BridgeSnapshotTracker({
      statusKey: SESSION_SPEND_STATUS_KEY,
      parse: (value) => parseSessionSpendSnapshot(typeof value === "string" ? value : undefined),
      // Broadcasts are gated and throttled below instead of firing on every frame.
      broadcast: () => Promise.resolve(),
      onAccept: (tabId, snapshot) => this.handleAccept(tabId, snapshot),
      onClear: (tabId) => this.handleClear(tabId),
    });
  }

  snapshot(tabId: string): SessionSpendSnapshot | undefined {
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

  disposeAll(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.lastBroadcasted.clear();
    this.lastBroadcastAt.clear();
  }

  private handleAccept(tabId: string, snapshot: SessionSpendSnapshot): void {
    const next: SpendTotals | null = snapshot.available ? snapshot.total : null;
    const prev = this.lastBroadcasted.get(tabId) ?? null;
    if (sameSummarySpend(prev, next)) {
      const pending = this.timers.get(tabId);
      if (pending !== undefined) {
        clearTimeout(pending);
        this.timers.delete(tabId);
      }
      return;
    }
    if (this.timers.has(tabId)) return;
    const now = this.now();
    const lastAt = this.lastBroadcastAt.get(tabId);
    const remaining = lastAt === undefined ? 0 : this.throttleMs - (now - lastAt);
    if (remaining <= 0) {
      this.lastBroadcasted.set(tabId, next);
      this.lastBroadcastAt.set(tabId, now);
      void this.broadcast();
      return;
    }
    const timer = setTimeout(() => {
      this.timers.delete(tabId);
      const current = this.snapshots.snapshot(tabId);
      const currentSummary = current?.available ? current.total : null;
      const last = this.lastBroadcasted.get(tabId) ?? null;
      if (sameSummarySpend(last, currentSummary)) return;
      this.lastBroadcasted.set(tabId, currentSummary);
      this.lastBroadcastAt.set(tabId, this.now());
      void this.broadcast();
    }, remaining);
    timer.unref?.();
    this.timers.set(tabId, timer);
  }

  private handleClear(tabId: string): boolean {
    const timer = this.timers.get(tabId);
    const hadPending = timer !== undefined;
    if (timer !== undefined) {
      clearTimeout(timer);
      this.timers.delete(tabId);
    }
    const prev = this.lastBroadcasted.get(tabId);
    this.lastBroadcasted.delete(tabId);
    this.lastBroadcastAt.delete(tabId);
    if ((prev !== undefined && prev !== null) || hadPending) {
      void this.broadcast();
    }
    return false;
  }
}
