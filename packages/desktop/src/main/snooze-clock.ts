import type { OwnedSessionRecord } from "@omp-ui/core";

/**
 * Longest single wait. Node timers run on the monotonic clock, which stops
 * while the machine sleeps, so a long timer would overshoot a wall-clock
 * deadline by the sleep's length. Re-reading the wall clock at least once a
 * minute bounds that overshoot (and keeps under setTimeout's 2^31 ms ceiling).
 */
const MAX_WAIT_MS = 60_000;

export interface SnoozeClockDeps {
  /** The live registry's records, re-read on every sync. */
  sessions: () => readonly OwnedSessionRecord[];
  /** The registry's partial write (ADR-0068): never a new Registry method. */
  updateSession: (tabId: string, patch: Pick<OwnedSessionRecord, "snoozed" | "snoozedUntilMs">) => unknown;
  /** Fans the returned rows out to every renderer and joined client. */
  broadcast: () => void;
}

/**
 * Timed snooze (issue #979): the owning host's main process keeps one timer
 * for the earliest `snoozedUntilMs` among its snoozed records. At a deadline,
 * or on a sync after the deadline passed while the app was closed or the
 * machine slept, it clears the flag and broadcasts, so the row returns to the
 * list the ADR-0068 partition gives it. The process is never touched. No
 * timer runs while no record holds a deadline.
 */
export class SnoozeClock {
  private timer: NodeJS.Timeout | undefined;
  private disposed = false;

  constructor(private readonly deps: SnoozeClockDeps) {}

  /** Wakes every elapsed snooze, then re-arms for the next deadline. Call after any snooze write. */
  sync(): void {
    if (this.disposed) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    const now = Date.now();
    let next: number | null = null;
    const due: string[] = [];
    for (const s of this.deps.sessions()) {
      if (!s.snoozed || s.snoozedUntilMs === null) continue;
      if (s.snoozedUntilMs <= now) due.push(s.tabId);
      else if (next === null || s.snoozedUntilMs < next) next = s.snoozedUntilMs;
    }
    for (const tabId of due) this.deps.updateSession(tabId, { snoozed: false, snoozedUntilMs: null });
    if (next !== null) {
      this.timer = setTimeout(() => this.sync(), Math.min(next - now, MAX_WAIT_MS));
    }
    if (due.length > 0) this.deps.broadcast();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }
}
