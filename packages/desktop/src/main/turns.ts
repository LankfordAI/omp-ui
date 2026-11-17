/**
 * Per-tab running-turn latch shared by hibernation, the stall watchdog and
 * the sidebar's published state (issue #297, issue #434). OMP 18 can expose
 * repeated agent_start frames while coalescing pending ends into one public
 * agent_end. That end is the authoritative session-idle signal, not a
 * decrement in nesting depth.
 *
 * A run spans loop pauses (issue #1192): a non-terminal `agent_end` keeps the
 * latch set — only the terminal end releases it. {@link pause} records that
 * the current pause can only be woken by background work (a job result, a
 * child agent's message, a queued peer message), which is the level the
 * sidebar publishes as `turnAwaitingAsyncWork` (issue #1204).
 */
export class TurnTracker {
  private readonly runningTabs = new Set<string>();
  /** Paused runs whose only possible resume is background work (issue #1204). */
  private readonly awaitingTabs = new Set<string>();

  constructor(
    /** Fires once per real edge, never for repeated frames inside one edge. */
    private readonly onTransition?: (tabId: string, running: boolean) => void,
  ) {}

  start(tabId: string): void {
    // A wake's agent_start ends the pause level even when the run latch was
    // already set: omp re-announces agent_start when a paused run resumes.
    const wasAwaiting = this.awaitingTabs.delete(tabId);
    if (this.runningTabs.has(tabId)) {
      if (wasAwaiting) this.onTransition?.(tabId, true);
      return;
    }
    this.runningTabs.add(tabId);
    this.onTransition?.(tabId, true);
  }

  /**
   * A non-terminal `agent_end`: the run continues, so the latch stays set.
   * `awaitingAsyncWork` marks a pause whose only possible resume is outside
   * work; a pause that queued input can also wake clears the level.
   */
  pause(tabId: string, awaitingAsyncWork: boolean): void {
    if (!this.runningTabs.has(tabId)) return;
    const was = this.awaitingTabs.delete(tabId);
    if (awaitingAsyncWork) this.awaitingTabs.add(tabId);
    if (was !== awaitingAsyncWork) this.onTransition?.(tabId, true);
  }

  end(tabId: string): void {
    this.awaitingTabs.delete(tabId);
    if (!this.runningTabs.delete(tabId)) return;
    this.onTransition?.(tabId, false);
  }

  isRunning(tabId: string): boolean {
    return this.runningTabs.has(tabId);
  }

  /** True while the tab's open run is paused on background work (issue #1204). */
  isAwaitingAsyncWork(tabId: string): boolean {
    return this.runningTabs.has(tabId) && this.awaitingTabs.has(tabId);
  }

  /** Drops the tab's state when its live process leaves; silent — callers exit a process and already broadcast. */
  clear(tabId: string): void {
    this.runningTabs.delete(tabId);
    this.awaitingTabs.delete(tabId);
  }
}
