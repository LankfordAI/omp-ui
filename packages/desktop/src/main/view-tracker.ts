/** How fresh a tab:viewed report must be to protect its tab (issue #266). */
const VIEWED_STALE_MS = 15 * 60 * 1_000;
/** Reports older than this are swept on the next write. */
const VIEWED_SWEEP_MS = 60 * 60 * 1_000;

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

  /** Renderer reports the tab it currently has in view, or null (issue #266). */
  setViewedTab(clientId: string, tabId: string | null): void {
    const now = Date.now();
    for (const [id, report] of this.reports) {
      if (now - report.at > VIEWED_SWEEP_MS) this.reports.delete(id);
    }
    this.reports.set(clientId, { tabId, at: now });
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
