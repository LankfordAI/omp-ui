/**
 * Per-tab running-turn latch shared by hibernation and the stall watchdog
 * (issue #297). OMP 18 can expose repeated agent_start frames while coalescing
 * pending ends into one public agent_end. That end is the authoritative
 * session-idle signal, not a decrement in nesting depth.
 */
export class TurnTracker {
  private readonly runningTabs = new Set<string>();

  start(tabId: string): void {
    this.runningTabs.add(tabId);
  }

  end(tabId: string): void {
    this.runningTabs.delete(tabId);
  }

  isRunning(tabId: string): boolean {
    return this.runningTabs.has(tabId);
  }

  /** Drops the tab's state when its live process leaves. */
  clear(tabId: string): void {
    this.runningTabs.delete(tabId);
  }
}
