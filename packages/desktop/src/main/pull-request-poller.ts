import {
  listBranchPullRequests,
  type AutoSettledSession,
  type OwnedSessionRecord,
  type PullRequestLink,
  type PullRequestLookup,
} from "@omp-ui/core";

/** Poll cadence while an omp-ui window has focus. */
export const PR_POLL_FOCUSED_MS = 60_000;
/** Poll cadence while no window has focus (issue #985: back off). */
export const PR_POLL_BLURRED_MS = 5 * 60_000;
/** A repository gh cannot answer (gh missing, logged out, not GitHub) waits
 *  this long; a transient failure (a GitHub 5xx, a timeout) retries on the next poll. */
export const PR_POLL_FAILED_MS = 15 * 60_000;
/** Focus polls at once only when the last poll is at least this old. */
const PR_POLL_FOCUS_STALE_MS = 30_000;

export interface PullRequestPollerDeps {
  /** The live registry's records, re-read on every poll. */
  sessions: () => readonly OwnedSessionRecord[];
  /** The registry's partial write. */
  updateSession: (tabId: string, patch: Pick<OwnedSessionRecord, "pullRequests">) => unknown;
  /** The app-wide default; a record's autoSettleOnMerge overrides it. */
  autoSettleDefault: () => boolean;
  isLive: (tabId: string) => boolean;
  isTurnRunning: (tabId: string) => boolean;
  /** The Settle reap (`SessionManager.settleSession`): true = settled. */
  settle: (tabId: string) => Promise<boolean>;
  /** Fans the changed rows out to every renderer and joined client. */
  broadcast: () => void;
  /** Tells renderers which sessions a merge settled, so they can offer Undo. */
  announceSettled: (sessions: AutoSettledSession[]) => void;
  isFocused: () => boolean;
  lookup?: (cwd: string, branches: readonly string[]) => Promise<PullRequestLookup>;
  now?: () => number;
}

/** True when the record has linked PRs and every one of them is merged. */
export function allMerged(links: readonly PullRequestLink[]): boolean {
  return links.length > 0 && links.every((link) => link.state === "merged");
}

function sameLinks(a: readonly PullRequestLink[], b: readonly PullRequestLink[]): boolean {
  return a.length === b.length && a.every((link, i) => {
    const other = b[i]!;
    return link.number === other.number && link.url === other.url && link.state === other.state && link.checks === other.checks;
  });
}

/**
 * Links pull requests to worktree sessions and settles a session once its
 * PRs merge (issue #985). One `gh` call per repository per poll answers every
 * worktree branch in it; a repository whose lookup fails backs off. The
 * settle fires on the transition only — a session whose links were already
 * all merged when it was resumed is never settled again — and waits out a
 * running turn instead of reaping it.
 */
export class PullRequestPoller {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | null = null;
  private started = false;
  private disposed = false;
  private lastPollAt = 0;
  /** projectCwd → epoch ms before which a failed repository is skipped. */
  private readonly failedUntil = new Map<string, number>();
  /** Sessions whose PRs merged, waiting for their turn to end before settling. */
  private readonly pendingSettle = new Set<string>();
  private readonly now: () => number;
  private readonly lookup: (cwd: string, branches: readonly string[]) => Promise<PullRequestLookup>;

  constructor(private readonly deps: PullRequestPollerDeps) {
    this.now = deps.now ?? Date.now;
    this.lookup = deps.lookup ?? ((cwd, branches) => listBranchPullRequests(cwd, branches));
  }

  /** Starts polling: one poll now, then on the focus-dependent cadence. */
  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    void this.poll();
  }

  /** A window gained focus: poll now if the last answer is stale, and return to the fast cadence. */
  onFocus(): void {
    if (!this.started || this.disposed) return;
    if (this.now() - this.lastPollAt >= PR_POLL_FOCUS_STALE_MS) void this.poll();
    else this.arm();
  }

  /** One poll; a poll already in flight is joined, never doubled. */
  poll(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    this.running ??= this.runPoll().finally(() => {
      this.running = null;
      this.arm();
    });
    return this.running;
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    if (this.disposed || !this.started) return;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.poll(), this.deps.isFocused() ? PR_POLL_FOCUSED_MS : PR_POLL_BLURRED_MS);
    this.timer.unref?.();
  }

  private async runPoll(): Promise<void> {
    this.lastPollAt = this.now();
    const byRepo = new Map<string, Set<string>>();
    for (const s of this.deps.sessions()) {
      if (s.worktree === null || s.chat) continue;
      let branches = byRepo.get(s.projectCwd);
      if (branches === undefined) byRepo.set(s.projectCwd, (branches = new Set()));
      branches.add(s.worktree.branch);
    }
    let changed = false;
    await Promise.all(
      [...byRepo].map(async ([cwd, branches]) => {
        if ((this.failedUntil.get(cwd) ?? 0) > this.now()) return;
        let answer: PullRequestLookup;
        try {
          answer = await this.lookup(cwd, [...branches]);
        } catch (err) {
          answer = { ok: false, reason: "failed", detail: err instanceof Error ? err.message : String(err) };
        }
        if (!answer.ok) {
          if (answer.reason !== "failed") this.failedUntil.set(cwd, this.now() + PR_POLL_FAILED_MS);
          console.warn(`[pull-requests] ${cwd}: ${answer.reason}${answer.detail ? ` (${answer.detail})` : ""}`);
          return;
        }
        this.failedUntil.delete(cwd);
        // Re-read: a record may have been deleted or released while gh ran.
        for (const s of this.deps.sessions()) {
          if (s.projectCwd !== cwd || s.worktree === null || !branches.has(s.worktree.branch)) continue;
          const next = answer.byBranch.get(s.worktree.branch) ?? [];
          if (sameLinks(s.pullRequests, next)) continue;
          // A branch whose PR vanished (deleted head, transferred repo) keeps
          // its last links rather than reading as "no PR": an empty answer
          // never erases history the forge once reported.
          if (next.length === 0) continue;
          // Only the observed transition settles: links that were already
          // known and not all merged, now all merged. A first sighting of an
          // already-merged PR (an upgrade, a branch checked out after its
          // merge) and a session resumed after its merge are left alone.
          if (allMerged(next) && s.pullRequests.length > 0 && !allMerged(s.pullRequests)) this.pendingSettle.add(s.tabId);
          this.deps.updateSession(s.tabId, { pullRequests: next });
          changed = true;
        }
      }),
    );
    if (changed) this.deps.broadcast();
    await this.settlePending();
  }

  private async settlePending(): Promise<void> {
    const settled: AutoSettledSession[] = [];
    for (const tabId of [...this.pendingSettle]) {
      const record = this.deps.sessions().find((s) => s.tabId === tabId);
      // Gone, reopened (a new open PR), or opted out: nothing to settle.
      if (record === undefined || !allMerged(record.pullRequests) || !(record.autoSettleOnMerge ?? this.deps.autoSettleDefault())) {
        this.pendingSettle.delete(tabId);
        continue;
      }
      const live = this.deps.isLive(tabId);
      // A dormant unsnoozed row is already settled.
      if (!live && !record.snoozed) {
        this.pendingSettle.delete(tabId);
        continue;
      }
      // Never reap a turn: the agent may have merged the PR itself and still be reporting.
      if (live && this.deps.isTurnRunning(tabId)) continue;
      this.pendingSettle.delete(tabId);
      const entry: AutoSettledSession = {
        tabId,
        title: record.cachedTitle?.trim() || "New session",
        wasLive: live,
        snoozed: record.snoozed,
        snoozedUntilMs: record.snoozed ? record.snoozedUntilMs : null,
      };
      try {
        if (await this.deps.settle(tabId)) settled.push(entry);
      } catch (err) {
        console.warn(`[pull-requests] ${tabId}: merge settle failed:`, err);
      }
    }
    if (settled.length > 0) this.deps.announceSettled(settled);
  }
}
