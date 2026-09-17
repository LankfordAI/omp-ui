import type { AutoresearchSnapshot } from "@omp-ui/core/autoresearch";
import type { ExperimentRecord, SessionSummary } from "@omp-ui/core/types";

/**
 * What the Lab says about one experiment at a glance (issue #559). Derived,
 * never stored: omp's DB row says whether it was closed and whether a run is
 * awaiting its log; the linked owned session says whether anything can run;
 * the bridge snapshot says whether omp is in autoresearch mode at all.
 */
export type ExperimentState = "running" | "awaiting-log" | "on" | "off" | "dormant" | "closed";

/**
 * Precedence, most final first: a closed row is closed whatever the session
 * does; with no session linked nothing can run (`off`); a linked session
 * without a process is `dormant`; a live session outside autoresearch mode is
 * `off`; a started-but-unlogged run is `awaiting-log` even mid-turn, because
 * the log is what omp is waiting on; otherwise the turn decides.
 */
export function experimentState(
  record: ExperimentRecord,
  summary: SessionSummary | null,
  snapshot: AutoresearchSnapshot | null,
): ExperimentState {
  if (record.closedAt !== null) return "closed";
  if (summary === null) return "off";
  if (summary.live !== "live") return "dormant";
  if (snapshot?.mode !== "on") return "off";
  if (record.progress.pendingRunId !== null) return "awaiting-log";
  return summary.turnRunning === true ? "running" : "on";
}

/**
 * `value` relative to `baseline` as a signed percent with one decimal —
 * `+3.2%`, `−3.2%` (a real minus sign), `0.0%`. A zero baseline has no
 * percent; the difference itself is shown instead.
 */
export function deltaLabel(baseline: number, value: number): string {
  const diff = value - baseline;
  const sign = diff < 0 ? "−" : diff > 0 ? "+" : "";
  if (baseline === 0) return `${sign}${Math.abs(diff)}`;
  return `${sign}${Math.abs((diff / Math.abs(baseline)) * 100).toFixed(1)}%`;
}
