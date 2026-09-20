import { useEffect, useState, type ReactNode } from "react";
import type { ExperimentRecord, ExperimentRun, RunLogResult, SessionSummary } from "@omp-ui/core/types";
import { backendFor, displayMessage } from "../../backend";
import { cn } from "../../lib/cn";
import { formatDuration } from "../../lib/duration";
import { experimentSession } from "../../lib/experiment-link";
import { useT, type MessageKey } from "../../lib/i18n";
import { projectKey } from "../../lib/project-key";
import { findInstance, useStore } from "../../store";
import type { LabView } from "../../store/types";
import { Markdown } from "../Markdown";
import { Button, Chevron, Chip, Label, type Tone } from "../ui";
import { StateChip } from "./ExperimentCard";
import { deltaLabel, experimentState } from "./experiment-state";

type Target = NonNullable<LabView["experiment"]>;

const EMPTY_SESSIONS: readonly SessionSummary[] = [];

/** omp's run verdicts, plus the two non-verdict states a `status IS NULL` row can be in. */
type RunVerdict = NonNullable<ExperimentRun["status"]> | "pending" | "abandoned";

const RUN_LABEL: Record<RunVerdict, MessageKey> = {
  keep: "lab.run.keep",
  discard: "lab.run.discard",
  crash: "lab.run.crash",
  checks_failed: "lab.run.checksFailed",
  pending: "lab.run.pending",
  abandoned: "lab.run.abandoned",
};

const RUN_TONE: Record<RunVerdict, Tone> = {
  keep: "signal",
  discard: "neutral",
  crash: "rose",
  checks_failed: "copper",
  pending: "copper",
  abandoned: "neutral",
};

function Field({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      <Label>{label}</Label>
      <div className="min-w-0 text-xs text-ink-mid">{children}</div>
    </div>
  );
}

function PathList({ label, paths }: { label: string; paths: readonly string[] }) {
  if (paths.length === 0) return null;
  return (
    <Field label={label}>
      <ul className="flex flex-col gap-px font-mono text-[11px]">
        {paths.map((path) => (
          <li key={path} className="truncate" title={path}>
            {path}
          </li>
        ))}
      </ul>
    </Field>
  );
}

type LogLoad =
  | { load: "loading" }
  | { load: "ready"; text: string; truncated: boolean }
  | { load: "error"; error: string };

/**
 * One experiment in full (issue #559): what the agent was asked for, the
 * session controls, and every run the current DB row has — read-only over
 * omp's autoresearch DB; the only writes go through the linked session as
 * omp's own slash command or a prompt.
 */
export function ExperimentDetail({ target }: { target: Target }) {
  const t = useT();
  const key = projectKey(target.instanceId, target.projectCwd);
  const detailKey = `${target.tabId ?? ""}:${target.experimentId}`;
  const cache = useStore((s) => s.experiments[key]);
  const sessions =
    useStore((s) =>
      (target.instanceId === null ? s.state?.projects : findInstance(s.state, target.instanceId)?.projects)?.find(
        (g) => g.project.path === target.projectCwd,
      )?.sessions,
    ) ?? EMPTY_SESSIONS;
  const loadExperimentDetail = useStore((s) => s.loadExperimentDetail);
  const openSession = useStore((s) => s.openSession);
  const stopExperiment = useStore((s) => s.stopExperiment);
  const startNewSegment = useStore((s) => s.startNewSegment);
  const openFinishWorktree = useStore((s) => s.openFinishWorktree);
  const setInspectorOpen = useStore((s) => s.setInspectorOpen);

  const detail = cache?.detail[detailKey];
  const overviewRecord =
    cache?.result?.checkouts
      .find((c) => c.tabId === target.tabId)
      ?.result.experiments.find((e) => e.id === target.experimentId) ?? null;
  const record: ExperimentRecord | null = detail?.value?.record ?? overviewRecord;
  const linked = record === null ? null : experimentSession(target.tabId, record, sessions);
  const snapshot = useStore((s) => (linked === null ? undefined : s.rpc[linked.tabId]?.autoresearch)) ?? null;

  const revision = cache?.revision ?? 0;
  useEffect(() => {
    void loadExperimentDetail(target);
    // The overview re-read bumps `revision`; the detail follows it so a run
    // omp logged between turns shows without a click.
  }, [target.projectCwd, target.instanceId, target.tabId, target.experimentId, revision, loadExperimentDetail]);

  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [logs, setLogs] = useState<Record<number, LogLoad>>({});

  const viewLog = (runId: number): void => {
    setLogs((prev) => ({ ...prev, [runId]: { load: "loading" } }));
    backendFor(target.instanceId)
      .autoresearchRunLog(target.projectCwd, target.tabId, target.experimentId, runId)
      .then(
        (result: RunLogResult) =>
          setLogs((prev) => ({
            ...prev,
            [runId]:
              result.kind === "error"
                ? { load: "error", error: result.error }
                : { load: "ready", text: result.text, truncated: result.truncated },
          })),
        (err: unknown) => setLogs((prev) => ({ ...prev, [runId]: { load: "error", error: displayMessage(err) } })),
      );
  };
  const hideLog = (runId: number): void =>
    setLogs((prev) => {
      const next = { ...prev };
      delete next[runId];
      return next;
    });

  if (record === null) {
    const error = detail?.value?.error ?? cache?.error ?? null;
    return (
      <div className="px-4 py-6 text-center text-xs text-ink-faint">
        {detail === undefined || detail.load === "loading" ? t("lab.detail.loading") : error ?? t("lab.detail.notFound")}
      </div>
    );
  }

  const live = linked?.live === "live";
  const native = linked?.mode === "rpc-ui";
  const modeOn = snapshot?.mode === "on";
  const worktree = linked?.worktree !== null && linked?.worktree !== undefined;
  const state = experimentState(record, linked, snapshot);
  const { progress } = record;
  const baseline = progress.baseline;
  const runs = detail?.value?.runs ?? [];
  const runError = detail?.value?.error ?? null;

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-5 px-4 py-4">
      <header className="flex flex-col gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-display text-lg font-semibold">{record.name}</h2>
            {record.goal !== null && record.goal !== "" && (
              <p className="mt-1 text-sm leading-relaxed text-ink-mid">{record.goal}</p>
            )}
          </div>
          <StateChip state={state} />
        </div>
        <div className="flex flex-wrap items-center gap-2 font-mono text-[11px] text-ink-mid">
          <Chip mono title={record.metricUnit === "" ? undefined : record.metricUnit}>
            {record.primaryMetric} · {record.direction}
          </Chip>
          <Chip mono>{t("lab.detail.segment", { n: record.currentSegment })}</Chip>
          {record.maxIterations !== null && (
            <Chip mono>{t("lab.card.runOf", { n: progress.segmentRuns, cap: record.maxIterations })}</Chip>
          )}
          {record.branch !== null && <span className="truncate">{record.branch}</span>}
          {record.baselineCommit !== null && (
            <span title={record.baselineCommit}>
              {t("lab.detail.baseline")} {record.baselineCommit.slice(0, 8)}
            </span>
          )}
        </div>
        {(record.preferredCommand !== null ||
          record.scopePaths.length > 0 ||
          record.offLimits.length > 0 ||
          record.constraints.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {record.preferredCommand !== null && (
              <Field label={t("lab.detail.command")}>
                <code className="block truncate font-mono text-[11px]" title={record.preferredCommand}>
                  {record.preferredCommand}
                </code>
              </Field>
            )}
            <PathList label={t("lab.detail.scope")} paths={record.scopePaths} />
            <PathList label={t("lab.detail.offLimits")} paths={record.offLimits} />
            <PathList label={t("lab.detail.constraints")} paths={record.constraints} />
          </div>
        )}
      </header>

      {linked !== null && (
        <div className="flex flex-wrap items-center gap-2">
          <Button tone="iris" variant="solid" onClick={() => void openSession(linked.tabId)}>
            {live ? t("lab.detail.openSession") : t("lab.detail.resume")}
          </Button>
          {live && native && modeOn && (
            <Button onClick={() => void stopExperiment(linked.tabId)}>{t("lab.detail.stop")}</Button>
          )}
          {live && native && modeOn && progress.pendingRunId === null && (
            <Button onClick={() => void startNewSegment(linked.tabId)}>{t("lab.detail.newSegment")}</Button>
          )}
          {worktree && (
            <Button onClick={() => openFinishWorktree(linked.tabId)}>{t("lab.detail.land")}</Button>
          )}
          {worktree && live && (
            <Button
              onClick={() => {
                void openSession(linked.tabId);
                setInspectorOpen(true);
              }}
            >
              {t("lab.detail.branchDiff")}
            </Button>
          )}
        </div>
      )}

      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <Label>{t("lab.detail.runs")}</Label>
          {detail?.load === "loading" && <span className="text-[10px] text-ink-faint">{t("lab.detail.loading")}</span>}
        </div>
        {runError !== null && <p className="text-xs text-rose">{runError}</p>}
        {runs.length === 0 && runError === null && detail?.load !== "loading" && (
          <p className="text-xs text-ink-faint">{t("lab.detail.noRuns")}</p>
        )}
        {runs.length > 0 && (
          <div className="overflow-x-auto rounded-lg border border-line bg-raised">
            <table className="w-full border-collapse text-xs">
              <thead>
                <tr className="border-b border-line text-left">
                  <th className="w-8 px-2 py-1.5" />
                  <th className="px-2 py-1.5"><Label>{t("lab.detail.colRun")}</Label></th>
                  <th className="px-2 py-1.5"><Label>{t("lab.detail.colStatus")}</Label></th>
                  <th className="px-2 py-1.5 text-right"><Label>{t("lab.detail.colMetric")}</Label></th>
                  <th className="px-2 py-1.5 text-right"><Label>{t("lab.detail.colDuration")}</Label></th>
                  <th className="px-2 py-1.5"><Label>{t("lab.detail.colCommit")}</Label></th>
                  <th className="px-2 py-1.5"><Label>{t("lab.detail.colDescription")}</Label></th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => {
                  const open = expanded.has(run.id);
                  const verdict: RunVerdict = run.status ?? (run.abandoned ? "abandoned" : "pending");
                  const log = logs[run.id];
                  return (
                    <RunRows
                      key={run.id}
                      run={run}
                      verdict={verdict}
                      open={open}
                      baseline={baseline}
                      direction={record.direction}
                      unit={record.metricUnit}
                      log={log}
                      onToggle={() =>
                        setExpanded((prev) => {
                          const next = new Set(prev);
                          if (next.has(run.id)) next.delete(run.id);
                          else next.add(run.id);
                          return next;
                        })
                      }
                      onViewLog={() => viewLog(run.id)}
                      onHideLog={() => hideLog(run.id)}
                    />
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {record.notes !== "" && (
        <section className="flex flex-col gap-2">
          <Label>{t("lab.detail.notes")}</Label>
          <Markdown text={record.notes} className="text-[13px]" />
        </section>
      )}
    </div>
  );
}

function RunRows({
  run,
  verdict,
  open,
  baseline,
  direction,
  unit,
  log,
  onToggle,
  onViewLog,
  onHideLog,
}: {
  run: ExperimentRun;
  verdict: RunVerdict;
  open: boolean;
  baseline: ExperimentRecord["progress"]["baseline"];
  direction: ExperimentRecord["direction"];
  unit: string;
  log: LogLoad | undefined;
  onToggle: () => void;
  onViewLog: () => void;
  onHideLog: () => void;
}) {
  const t = useT();
  const isBaseline = baseline !== null && baseline.runId === run.id;
  // Improvement is whatever the direction says; a worse run reads rose-less
  // (neutral), because a discarded run is the loop working, not a failure.
  const improved =
    run.metric !== null &&
    baseline !== null &&
    !isBaseline &&
    (direction === "higher" ? run.metric > baseline.metric : run.metric < baseline.metric);
  const details: Array<[label: string, value: ReactNode]> = [];
  if (run.modifiedPaths.length > 0) details.push([t("lab.detail.modifiedPaths"), <PathCell key="m" paths={run.modifiedPaths} />]);
  if (run.scopeDeviations.length > 0) details.push([t("lab.detail.scopeDeviations"), <PathCell key="s" paths={run.scopeDeviations} />]);
  if (run.justification !== null && run.justification !== "") details.push([t("lab.detail.justification"), run.justification]);
  return (
    <>
      <tr className={cn("border-b border-line-soft align-top", open && "bg-sunken")}>
        <td className="px-2 py-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? t("lab.detail.collapse", { n: run.id }) : t("lab.detail.expand", { n: run.id })}
            onClick={onToggle}
            className="grid size-5 place-items-center rounded text-ink-dim transition-colors hover:bg-hover hover:text-ink"
          >
            <Chevron open={open} className="size-2.5" />
          </button>
        </td>
        <td className="px-2 py-1.5 font-mono tabular-nums text-ink-mid">
          {run.id}
          {isBaseline && <span className="ml-1 text-[10px] text-ink-faint">{t("lab.detail.baseline")}</span>}
        </td>
        <td className="px-2 py-1.5">
          <span className="flex flex-wrap items-center gap-1">
            <Chip tone={RUN_TONE[verdict]}>{t(RUN_LABEL[verdict])}</Chip>
            {run.timedOut && <Chip tone="copper">{t("lab.run.timedOut")}</Chip>}
            {run.flagged && (
              <Chip tone="rose" title={run.flaggedReason ?? undefined}>
                {t("lab.detail.flagged")}
              </Chip>
            )}
          </span>
        </td>
        <td className={cn("px-2 py-1.5 text-right font-mono tabular-nums", improved ? "text-signal" : "text-ink")}>
          {run.metric === null ? (
            <span className="text-ink-faint">—</span>
          ) : (
            <>
              {run.metric}
              {unit !== "" && <span className="ml-0.5 text-ink-faint">{unit}</span>}
              {baseline !== null && !isBaseline && (
                <span className="ml-1.5 text-[10px] text-ink-mid">{deltaLabel(baseline.metric, run.metric)}</span>
              )}
            </>
          )}
        </td>
        <td className="px-2 py-1.5 text-right font-mono tabular-nums text-ink-mid">
          {run.durationMs === null ? <span className="text-ink-faint">—</span> : formatDuration(run.durationMs)}
        </td>
        <td className="px-2 py-1.5 font-mono text-ink-mid" title={run.commitHash ?? undefined}>
          {run.commitHash === null ? <span className="text-ink-faint">—</span> : run.commitHash.slice(0, 8)}
        </td>
        <td className="max-w-[24rem] px-2 py-1.5 text-ink">
          <span className={cn("block", !open && "truncate")} title={open ? undefined : run.description ?? undefined}>
            {run.description ?? <span className="text-ink-faint">—</span>}
          </span>
        </td>
      </tr>
      {open && (
        <tr className="border-b border-line-soft bg-sunken">
          <td />
          <td colSpan={6} className="px-2 pb-3 pt-1">
            <div className="flex flex-col gap-3">
              <Field label={t("lab.detail.command")}>
                <code className="block break-all font-mono text-[11px]">{run.command}</code>
              </Field>
              {details.map(([label, value]) => (
                <Field key={label} label={label}>
                  {value}
                </Field>
              ))}
              {run.hasLog && (
                <div className="flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    {log === undefined ? (
                      <Button size="xs" onClick={onViewLog}>{t("lab.detail.viewLog")}</Button>
                    ) : (
                      <Button size="xs" onClick={onHideLog}>{t("lab.detail.hideLog")}</Button>
                    )}
                    {log?.load === "loading" && <span className="text-[10px] text-ink-faint">{t("lab.detail.logLoading")}</span>}
                    {log?.load === "ready" && log.truncated && (
                      <span className="text-[10px] text-ink-faint">{t("lab.detail.logTruncated")}</span>
                    )}
                  </div>
                  {log?.load === "error" && <p className="text-xs text-rose">{log.error}</p>}
                  {log?.load === "ready" && (
                    <pre className="max-h-96 overflow-auto rounded-md border border-line bg-void p-2 font-mono text-[11px] leading-relaxed text-ink-mid" data-selectable>
                      {log.text}
                    </pre>
                  )}
                </div>
              )}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

function PathCell({ paths }: { paths: readonly string[] }) {
  return (
    <ul className="flex flex-col gap-px font-mono text-[11px]">
      {paths.map((path) => (
        <li key={path} className="break-all">
          {path}
        </li>
      ))}
    </ul>
  );
}
