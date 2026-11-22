import { ROUTINE_RUN_RETENTION_MS, type OwnedSessionRecord, type RoutineRunHistory } from "@omp-ui/core";

export interface RoutineRetentionDeps {
  history: RoutineRunHistory;
  /** The Experimental gate; pruning pauses while it is off. */
  isEnabled: () => boolean;
  sessions: () => readonly OwnedSessionRecord[];
  isLive: (tabId: string) => boolean;
  awaitingHumanAnswer: (tabId: string) => boolean;
  /** `SessionManager.deleteSession`: lineage, record, and checkout go; an unmerged branch stays (`kept-unmerged`). */
  deleteSession: (tabId: string, cascade: false) => Promise<unknown>;
  publish: () => void;
  now?: () => number;
}

/**
 * 30-day Routine run retention (ADR-0100 §7.3, #1255): run at boot, after every
 * fire, and on gate re-enable. Deletes dormant, gate-free routine runs whose
 * last activity (`cachedModified ?? launchedAt`) is older than 30 days — a
 * human reply advances `cachedModified` and so exempts the run — marks their
 * history rows `pruned`, and drops history rows fired more than 30 days ago.
 */
export class RoutineRetention {
  private readonly now: () => number;
  private running: Promise<number> | null = null;

  constructor(private readonly deps: RoutineRetentionDeps) {
    this.now = deps.now ?? Date.now;
  }

  /** Prunes once; concurrent callers share the in-flight pass. Resolves with the deleted session count. */
  prune(): Promise<number> {
    if (!this.deps.isEnabled()) return Promise.resolve(0);
    this.running ??= this.pass().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async pass(): Promise<number> {
    const cutoffMs = this.now() - ROUTINE_RUN_RETENTION_MS;
    const doomed = this.deps.sessions().filter((s) => {
      if (s.routine === null) return false;
      if (this.deps.isLive(s.tabId) || this.deps.awaitingHumanAnswer(s.tabId)) return false;
      const activity = Date.parse(s.cachedModified ?? s.launchedAt);
      return Number.isFinite(activity) && activity < cutoffMs;
    });
    let deleted = 0;
    for (const record of doomed) {
      try {
        await this.deps.deleteSession(record.tabId, false);
        this.deps.history.markPruned(record.tabId);
        deleted += 1;
      } catch (err) {
        console.warn(`[routines] retention could not delete ${record.tabId}:`, err);
      }
    }
    const dropped = this.deps.history.pruneOlderThan(cutoffMs);
    if (deleted > 0 || dropped > 0) this.deps.publish();
    return deleted;
  }
}
