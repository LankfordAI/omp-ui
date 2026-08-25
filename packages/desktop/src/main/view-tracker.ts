import type { Registry } from "@omp-ui/core";

/** How fresh a tab:viewed report must be to protect its tab (issue #266). */
const VIEWED_STALE_MS = 15 * 60 * 1_000;
/** Reports older than this are swept on the next write. */
const VIEWED_SWEEP_MS = 60 * 60 * 1_000;
/** At most one lastViewedAt registry write per tab per window (issue #273). */
const VIEWED_DEDUP_MS = 30_000;

export interface ViewTrackerDeps {
  registry: Registry;
  broadcastPatch: (immediate: boolean) => void;
}

/**
 * Fresh tab:viewed reports keyed by renderer clientId (issue #266). A tab
 * named by any fresh report is the one the user is looking at and is never
 * hibernated. Stale entries stop protecting on their own (macOS window
 * close, dead remote socket) — no disconnect hook is needed.
 */
export class ViewTracker {
  private readonly reports = new Map<string, { tabId: string | null; at: number }>();
  /** clientId the desktop renderer reports under; only the IPC transport marks it (issue #271). */
  private desktopClientId: string | null = null;

  constructor(private readonly deps: ViewTrackerDeps) {}

  /** Renderer reports the tab it currently has in view, or null (issue #266). */
  setViewedTab(clientId: string, tabId: string | null): void {
    const now = Date.now();
    for (const [id, report] of this.reports) {
      if (now - report.at > VIEWED_SWEEP_MS) this.reports.delete(id);
    }
    const previous = this.reports.get(clientId)?.tabId ?? null;
    this.reports.set(clientId, { tabId, at: now });
    // The tab just left (if any) has its last-viewed moment now; the tab just
    // entered — or re-heartbeated — is being viewed right now (issue #273).
    if (previous !== null && previous !== tabId) this.noteLastViewed(previous, now);
    this.noteLastViewed(tabId, now);
  }

  /**
   * Persists a viewed report to the record (issue #273). Deduped: a report
   * that leaves the stored value within VIEWED_DEDUP_MS writes nothing. The
   * 5-min heartbeats therefore keep a continuously-viewed tab fresh within
   * ~5 min, a tab switch records the leaving tab exactly, and unreported
   * leaves (window close, dead socket) stay within one heartbeat.
   */
  private noteLastViewed(tabId: string | null, now: number): void {
    if (tabId === null) return;
    const record = this.deps.registry.sessions.find((s) => s.tabId === tabId);
    if (record === undefined) return;
    const stored = record.lastViewedAt;
    const last = stored === null ? null : Date.parse(stored);
    if (last !== null && Number.isFinite(last) && now - last < VIEWED_DEDUP_MS) return;
    this.deps.registry.updateSession(tabId, { lastViewedAt: new Date(now).toISOString() });
    this.deps.broadcastPatch(false);
  }

  /** Marks the clientId the desktop renderer reports under (issue #271). */
  noteDesktopClientId(clientId: string): void {
    this.desktopClientId = clientId;
  }

  /** True while the desktop renderer's fresh viewed report names this tab (issue #271). */
  isViewedInDesktop(tabId: string): boolean {
    const clientId = this.desktopClientId;
    if (clientId === null) return false;
    const report = this.reports.get(clientId);
    return (
      report !== undefined &&
      report.tabId === tabId &&
      Date.now() - report.at <= VIEWED_STALE_MS
    );
  }

  /** True while any fresh tab:viewed report names this tab (issue #266). */
  isViewed(tabId: string): boolean {
    const now = Date.now();
    for (const { tabId: viewed, at } of this.reports.values()) {
      if (viewed === tabId && now - at <= VIEWED_STALE_MS) return true;
    }
    return false;
  }

  /**
   * Deliberate no-op: reports are keyed by clientId and age out on their own
   * staleness clock — nothing cleans them when a tab leaves today.
   */
  dispose(): void {}
}
