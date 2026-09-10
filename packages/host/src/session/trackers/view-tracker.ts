/** How fresh a tab:viewed report must be to protect its tab (issue #266). */
const VIEWED_STALE_MS = 15 * 60 * 1_000;
/** Reports older than this are swept on the next write. */
const VIEWED_SWEEP_MS = 60 * 60 * 1_000;

/**
 * Fresh tab:viewed reports keyed by connection id (issue #266, #442). A tab
 * named by any fresh report is the one a user is looking at and is never
 * hibernated. A closed connection drops its report at once; stale entries
 * (a socket that died without a close) stop protecting on their own.
 */
export class ViewTracker {
  private readonly reports = new Map<string, { tabId: string | null; at: number }>();

  /** A connection reports the tab it currently has in view, or null (issue #266). */
  setViewedTab(connId: string, tabId: string | null): void {
    const now = Date.now();
    for (const [id, report] of this.reports) {
      if (now - report.at > VIEWED_SWEEP_MS) this.reports.delete(id);
    }
    this.reports.set(connId, { tabId, at: now });
  }

  /** The connection is gone: its report no longer names anything. */
  connectionClosed(connId: string): void {
    this.reports.delete(connId);
  }

  /** True while any fresh tab:viewed report names this tab (issue #266). */
  isViewed(tabId: string): boolean {
    const now = Date.now();
    for (const { tabId: viewed, at } of this.reports.values()) {
      if (viewed === tabId && now - at <= VIEWED_STALE_MS) return true;
    }
    return false;
  }
}
