import type {
  AsyncJob,
  AsyncJobsSnapshot,
  AsyncJobWidget,
  AsyncJobWidgetBlock,
  AsyncJobWidgetHeadline,
  AsyncJobWidgetTone,
} from "@omp-ui/core/async-jobs";
import type { SubagentInfo } from "./rpc-types";
import type { Tone } from "./tone";

/**
 * Running jobs the HUD counts — omp's own status-line rule
 * (StatusLine.runningBackgroundJobCount in omp/18.8.9): a `task` job whose
 * agent is already on the subagent roster is counted by the Agents pane, not
 * here. Unavailable or absent snapshots count zero.
 */
export function runningJobCount(
  snapshot: AsyncJobsSnapshot | null,
  subagents: readonly SubagentInfo[],
): number {
  if (snapshot === null || !snapshot.available) return 0;
  const roster = new Set(subagents.map((agent) => agent.id));
  return snapshot.running.filter(
    (job) => job.type !== "task" || job.agentId === null || !roster.has(job.agentId),
  ).length;
}

/**
 * True while the bridge reports at least one running background job on the
 * live process (issue #851): background bash and backgrounded task agents
 * both ride omp's async job manager, which outlives the turn that started
 * them. An unavailable or absent snapshot reports false — "cannot see the
 * jobs" is not "a job is running", and the label then falls back to the
 * turn level alone.
 */
export function backgroundWorkInFlight(
  snapshot: AsyncJobsSnapshot | null,
): boolean {
  return snapshot !== null && snapshot.available && snapshot.running.length > 0;
}

/** omp's widget tones onto omp-ui's semantic accents (ADR-0004): success is
 *  the reserved signal hue, live work and warnings are copper, errors rose,
 *  the user's own voice iris; informational and muted stay neutral. */
export const JOB_WIDGET_TONE: Record<AsyncJobWidgetTone, Tone> = {
  neutral: "neutral",
  accent: "copper",
  info: "neutral",
  success: "signal",
  warning: "copper",
  error: "rose",
  pending: "copper",
  muted: "neutral",
  user: "iris",
};

/** Spark points a glance draws: omp's own HUD pill keeps the last 16. */
export const JOB_WIDGET_GLANCE_POINTS = 16;

/** A predicate that narrows a widget block to one kind. */
export function isJobWidgetBlock<K extends AsyncJobWidgetBlock["kind"]>(kind: K) {
  return (block: AsyncJobWidgetBlock): block is Extract<AsyncJobWidgetBlock, { kind: K }> => block.kind === kind;
}

/** omp's glance figure (its E5): the headline, else the first spark's last
 *  value, else the first meter's text; null when the widget has none. */
export function jobWidgetFigure(widget: AsyncJobWidget): AsyncJobWidgetHeadline | null {
  if (widget.headline !== null) return widget.headline;
  for (const block of widget.blocks) {
    if (block.kind === "spark" && block.last.trim() !== "") return { text: block.last, label: block.label || null, trend: null };
    if (block.kind === "meter" && block.text.trim() !== "") return { text: block.text, label: block.label || null, trend: null };
  }
  return null;
}

/** The running job whose live widget moved last (omp's pill rule); null when
 *  no running job carries one or the snapshot is absent or unavailable. Returns
 *  the snapshot's own object, so a store selector stays referentially stable. */
export function freshestWidgetJob(snapshot: AsyncJobsSnapshot | null): AsyncJob | null {
  if (snapshot === null || !snapshot.available) return null;
  let best: AsyncJob | null = null;
  for (const job of snapshot.running) {
    if (job.widget === null) continue;
    if (best === null || best.widget === null || job.widget.updatedAt > best.widget.updatedAt) best = job;
  }
  return best;
}
