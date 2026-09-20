import type { ExperimentRecord, SessionExperiment } from "@omp-ui/core/types";
import { cn } from "../../lib/cn";
import { useT, type MessageKey } from "../../lib/i18n";
import { relativeTime } from "../../lib/format";
import { Chip, type Tone } from "../ui";
import { deltaLabel, type ExperimentState } from "./experiment-state";
import { MetricSparkline } from "./MetricSparkline";

const STATE_LABEL: Record<ExperimentState, MessageKey> = {
  running: "lab.state.running",
  "awaiting-log": "lab.state.awaitingLog",
  on: "lab.state.on",
  off: "lab.state.off",
  dormant: "lab.state.dormant",
  closed: "lab.state.closed",
};

// Signal is reserved for liveness (ADR-0004): only a mode-on session earns it;
// a run waiting on its log is attention, not liveness.
const STATE_TONE: Record<ExperimentState, Tone> = {
  running: "signal",
  "awaiting-log": "copper",
  on: "signal",
  off: "neutral",
  dormant: "neutral",
  closed: "neutral",
};

export function StateChip({ state }: { state: ExperimentState }) {
  const t = useT();
  return <Chip tone={STATE_TONE[state]}>{t(STATE_LABEL[state])}</Chip>;
}

const CARD_CLASS =
  "flex w-full flex-col gap-2 rounded-lg border border-line bg-raised p-3 text-left text-ink transition-colors duration-150";

/**
 * One experiment in the Lab overview (issue #559): its name and goal, the
 * metric's shape and its best-vs-baseline delta, the run count against the
 * cap, the branch, and the derived state. The whole card opens the detail.
 */
export function ExperimentCard({
  record,
  state,
  onOpen,
  dbPath,
}: {
  record: ExperimentRecord;
  state: ExperimentState;
  onOpen: () => void;
  /** Where the row was read from; rides the footer tooltip only. */
  dbPath?: string;
}) {
  const t = useT();
  const { progress } = record;
  const delta =
    progress.baseline !== null && progress.best !== null
      ? deltaLabel(progress.baseline.metric, progress.best.metric)
      : null;
  const runs =
    record.maxIterations === null
      ? t("lab.card.run", { n: progress.segmentRuns })
      : t("lab.card.runOf", { n: progress.segmentRuns, cap: record.maxIterations });
  return (
    <button
      type="button"
      onClick={onOpen}
      className={cn(CARD_CLASS, "hover:border-line-strong focus-visible:border-line-strong focus-visible:outline-none")}
    >
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-sm font-semibold">{record.name}</span>
          {record.goal !== null && record.goal !== "" && (
            <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink-mid">{record.goal}</span>
          )}
        </span>
        <StateChip state={state} />
      </div>
      <div className="flex items-center gap-3">
        <span className="text-ink-mid">
          <MetricSparkline series={progress.metricSeries} direction={record.direction} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <Chip mono truncate title={`${record.primaryMetric} · ${record.direction}`}>
            {record.primaryMetric} · {record.direction}
          </Chip>
          <span className="flex items-center gap-2 font-mono text-[11px] tabular-nums text-ink-mid">
            {delta !== null && <span>{t("lab.card.best", { delta })}</span>}
            <span>{runs}</span>
          </span>
        </span>
      </div>
      <span
        className="flex items-center gap-2 font-mono text-[10px] text-ink-faint"
        title={dbPath}
      >
        {record.branch !== null && <span className="min-w-0 flex-1 truncate">{record.branch}</span>}
        {progress.lastActivityAt !== null && (
          <span className="ml-auto shrink-0">{relativeTime(new Date(progress.lastActivityAt).toISOString())}</span>
        )}
      </span>
    </button>
  );
}

/**
 * A session launched from the New experiment dialog whose `init_experiment`
 * has not run yet — Phase 1 of the kickoff is still writing the harness, so
 * omp's DB has no row to read. Provenance only: no sparkline, no runs.
 */
export function PendingExperimentCard({
  experiment,
  title,
}: {
  experiment: SessionExperiment;
  title: string;
}) {
  const t = useT();
  return (
    <div className={CARD_CLASS}>
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-sm font-semibold">{title}</span>
          <span className="mt-0.5 line-clamp-2 block text-xs leading-relaxed text-ink-mid">{experiment.goal}</span>
        </span>
        <Chip tone="copper">{t("lab.overview.settingUp")}</Chip>
      </div>
      <div className="flex items-center gap-2">
        <Chip mono truncate title={`${experiment.metric} · ${experiment.direction}`}>
          {experiment.metric} · {experiment.direction}
        </Chip>
        {experiment.launchedBranch !== null && (
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-ink-faint">{experiment.launchedBranch}</span>
        )}
      </div>
    </div>
  );
}
