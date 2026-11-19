import type { AsyncNotifyReport } from "@omp-ui/core/async-notify";

/**
 * The Jobs pane's live background-output feed (issue #1235): omp 19 delivers
 * matched `notify` lines as `async-notify` custom messages; every message
 * feeds this per-tab map so a job row can show the lines it was asked to
 * report while it runs, without re-rendering the transcript.
 *
 * Display state only — omp owns the process and its notice stream. Reports are
 * keyed `${type}:${id}` (upstream keeps job ids and service names in separate
 * namespaces), lines are bounded per source, and a source whose rows outlive
 * its eviction from the job snapshot stays readable until the tab resets.
 */

/** Reported lines retained per source; older lines roll off with a counter. */
export const ASYNC_NOTICE_LINE_CAP = 200;
/** Sources retained per tab; the least recently fed one rolls off first. */
export const ASYNC_NOTICE_SOURCE_CAP = 32;

export interface AsyncNoticeSource {
  /** The job's id or the service's name, as `proc://` takes it. */
  id: string;
  type: "bash" | "service";
  /** Source of its `notify` regex, from the newest report. */
  pattern: string;
  /** Reported lines, oldest first, at most ASYNC_NOTICE_LINE_CAP. */
  lines: string[];
  /** Reported lines dropped from the head by the cap (the "N earlier" count). */
  droppedLines: number;
  /** Lines omp itself left out of its notices, summed across deliveries. */
  omitted: number;
  /** Running as of the newest report — not the snapshot's fresher verdict. */
  running: boolean;
  /** omp stopped noticing this source (burst allowance spent). */
  stopped: boolean;
  /** Epoch ms of the newest feeding message. */
  lastAt: number;
}

/** Keyed feed on `RpcTabState.asyncNotices`; empty until the first notice. */
export type AsyncNoticeFeed = Readonly<Record<string, AsyncNoticeSource>>;

export const asyncNoticeKey = (report: Pick<AsyncNotifyReport, "id" | "type">): string =>
  `${report.type}:${report.id}`;

/**
 * Fold one async-notify message's reports into the feed. Pure and idempotent
 * per delivery ORDER only — callers feed each delivered message exactly once
 * (message_end live, history order on backfill), so start/end double frames
 * must settle before reaching here.
 */
export function feedAsyncNotices(
  current: AsyncNoticeFeed,
  reports: readonly AsyncNotifyReport[],
  now: number,
): AsyncNoticeFeed {
  let next: Record<string, AsyncNoticeSource> | null = null;
  for (const report of reports) {
    const key = asyncNoticeKey(report);
    const known = next?.[key] ?? current[key];
    const lines = [...(known?.lines ?? []), ...report.lines];
    const kept = lines.length > ASYNC_NOTICE_LINE_CAP ? lines.slice(lines.length - ASYNC_NOTICE_LINE_CAP) : lines;
    const source: AsyncNoticeSource = {
      id: report.id,
      type: report.type,
      pattern: report.pattern,
      lines: kept,
      droppedLines: (known?.droppedLines ?? 0) + (lines.length - kept.length),
      omitted: (known?.omitted ?? 0) + report.omitted,
      running: report.running,
      stopped: known?.stopped === true || report.stopped,
      lastAt: now,
    };
    next ??= { ...current };
    next[key] = source;
  }
  if (next === null) return current;
  const keys = Object.keys(next);
  if (keys.length > ASYNC_NOTICE_SOURCE_CAP) {
    for (const key of keys
      .sort((a, b) => next![a]!.lastAt - next![b]!.lastAt)
      .slice(0, keys.length - ASYNC_NOTICE_SOURCE_CAP)) {
      delete next[key];
    }
  }
  return next;
}

/** Feed keys for sources with no row in the jobs snapshot (issue #1235: never a silent drop). */
export function orphanNoticeKeys(
  feed: AsyncNoticeFeed,
  listedJobIds: ReadonlySet<string>,
): AsyncNoticeSource[] {
  return Object.values(feed)
    .filter((source) => !(source.type === "bash" && listedJobIds.has(source.id)))
    .sort((a, b) => a.lastAt - b.lastAt);
}
