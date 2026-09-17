import type { ExperimentProgress, ExperimentRecord } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";

const W = 120;
const H = 32;
const PAD = 2;

/**
 * The metric's shape over the current segment (issue #559): one polyline
 * through every unflagged metric-bearing run, kept runs as filled points,
 * discarded ones hollow, the best point ringed. Decorative — the card's
 * text carries the numbers — so it is `aria-hidden` and draws in
 * `currentColor`, taking whatever ink the parent sets.
 */
export function MetricSparkline({
  series,
  direction,
  className,
}: {
  series: ExperimentProgress["metricSeries"];
  direction: ExperimentRecord["direction"];
  className?: string;
}) {
  if (series.length === 0) return null;
  let min = Infinity;
  let max = -Infinity;
  let bestIndex = 0;
  for (let i = 0; i < series.length; i += 1) {
    const value = series[i]!.metric;
    if (value < min) min = value;
    if (value > max) max = value;
    const best = series[bestIndex]!.metric;
    if (direction === "higher" ? value > best : value < best) bestIndex = i;
  }
  const span = max - min;
  const stepX = series.length === 1 ? 0 : (W - PAD * 2) / (series.length - 1);
  const points = series.map((point, i) => ({
    x: series.length === 1 ? W / 2 : PAD + i * stepX,
    // A flat series sits on the midline rather than dividing by zero.
    y: span === 0 ? H / 2 : H - PAD - ((point.metric - min) / span) * (H - PAD * 2),
    kept: point.kept,
  }));

  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      aria-hidden
      className={cn("h-8 w-[7.5rem] shrink-0", className)}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.2}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {points.length > 1 && (
        <polyline points={points.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} />
      )}
      {points.map((p, i) => (
        <circle
          key={series[i]!.runId}
          cx={p.x}
          cy={p.y}
          r={1.8}
          fill={p.kept ? "currentColor" : "none"}
        />
      ))}
      <circle cx={points[bestIndex]!.x} cy={points[bestIndex]!.y} r={3.6} strokeWidth={1} />
    </svg>
  );
}
