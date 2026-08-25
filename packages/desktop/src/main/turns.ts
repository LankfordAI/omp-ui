/**
 * Per-tab running-turn count: agent_start minus agent_end (issue #297). The
 * one genuine cross-concern datum — hibernation refuses mid-turn kills and
 * the stall watchdog only watches a running turn.
 */
export class TurnCounter {
  private readonly counts = new Map<string, number>();

  /** Increments the tab's count and returns the new value. */
  start(tabId: string): number {
    const next = (this.counts.get(tabId) ?? 0) + 1;
    this.counts.set(tabId, next);
    return next;
  }

  /** Decrements (never below zero) and returns the new value. */
  end(tabId: string): number {
    const next = Math.max(0, (this.counts.get(tabId) ?? 0) - 1);
    this.counts.set(tabId, next);
    return next;
  }

  /** The tab's current running count; 0 when unknown. */
  running(tabId: string): number {
    return this.counts.get(tabId) ?? 0;
  }

  /** Drops the tab's count when its live process leaves. */
  clear(tabId: string): void {
    this.counts.delete(tabId);
  }
}
