/**
 * Per-tab running-turn latch shared by hibernation, the stall watchdog and
 * the sidebar's published state (issue #297, issue #434). OMP 18 can expose
 * repeated agent_start frames while coalescing pending ends into one public
 * agent_end. That end is the authoritative session-idle signal, not a
 * decrement in nesting depth.
 */
export class TurnTracker {
  private readonly runningTabs = new Set<string>();

  constructor(
    /** Fires once per real edge, never for repeated frames inside one edge. */
    private readonly onTransition?: (tabId: string, running: boolean) => void,
  ) {}

  start(tabId: string): void {
    if (this.runningTabs.has(tabId)) return;
    this.runningTabs.add(tabId);
    this.onTransition?.(tabId, true);
  }

  end(tabId: string): void {
    if (!this.runningTabs.delete(tabId)) return;
    this.onTransition?.(tabId, false);
  }

  isRunning(tabId: string): boolean {
    return this.runningTabs.has(tabId);
  }

  /** Drops the tab's state when its live process leaves; silent — callers exit a process and already broadcast. */
  clear(tabId: string): void {
    this.runningTabs.delete(tabId);
  }
}
