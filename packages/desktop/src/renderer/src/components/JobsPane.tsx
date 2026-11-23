import { useEffect, useState, type ReactNode } from "react";
import { buildAsyncJobRows, type AsyncJob, type AsyncJobRow } from "@omp-ui/core/async-jobs";
import { AGENT_TONE } from "../lib/agent-tone";
import { asyncNoticeKey, orphanNoticeKeys, type AsyncNoticeSource } from "../lib/async-notices";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/duration";
import { startVisibleInterval } from "../lib/visible-interval";
import { useStore } from "../store";
import { Section } from "./RailSection";
import { Button, Chip, Dot, Empty, IconButton, IconRefresh } from "./ui";
import { CompletionRing, JobWidgetBlocks, JobWidgetGlance } from "./JobWidget";

/** Re-renders once a second while any job runs, so elapsed times move. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const stop = startVisibleInterval(() => setNow(Date.now()), 1000);
    return stop;
  }, [active]);
  return now;
}

/** Stable empty identity so the selector never re-renders on an absent feed. */
const NO_NOTICES: Record<string, AsyncNoticeSource> = {};

/**
 * The session's omp background jobs (issue #835): running first, then the
 * finished ones omp still retains. Rows expand to command, cwd, pids and the
 * output tail; kill rides the bridge and works mid-turn. Running rows also
 * draw omp's live job widget, a subagent's completion estimate, and its stage
 * (#954). omp 19's matching-output notices ride the row they belong to, or an
 * "other background output" section when no row does (#1235).
 */
export function JobsPane({ tabId }: { tabId: string }) {
  const snapshot = useStore((s) => s.rpc[tabId]?.asyncJobs ?? null);
  // omp 19 matching-output notices (#1235), folded in per delivered message.
  const notices = useStore((s) => s.rpc[tabId]?.asyncNotices ?? NO_NOTICES);
  const pending = useStore((s) => s.rpc[tabId]?.asyncJobsKill ?? null);
  const error = useStore((s) => s.rpc[tabId]?.asyncJobsKillError ?? null);
  const subagents = useStore((s) => s.rpc[tabId]?.subagents);
  const buffers = useStore((s) => s.rpc[tabId]?.subagentItems);
  const selected = useStore((s) => s.rpc[tabId]?.selectedSubagent ?? null);
  const refreshAsyncJobs = useStore((s) => s.refreshAsyncJobs);
  const killAsyncJob = useStore((s) => s.killAsyncJob);
  const openSubagent = useStore((s) => s.openSubagent);
  const closeSubagent = useStore((s) => s.closeSubagent);
  // Second ticks while a job runs or a notice source still reports (#1235).
  const now = useNow((snapshot?.running.length ?? 0) > 0 || Object.values(notices).some((n) => n.running));

  const refresh = (
    <IconButton label="refresh background jobs" onClick={() => void refreshAsyncJobs(tabId)}>
      <IconRefresh />
    </IconButton>
  );
  // #1235: every notice whose job has no row (services — they never enter the
  // job manager — and jobs omp already evicted from the snapshot) groups into
  // one trailing section; a reported line is never silently dropped. The early
  // returns below render it too, since before the first snapshot every source
  // is unlisted.
  const listed = new Set([...(snapshot?.running ?? []), ...(snapshot?.recent ?? [])].map((job) => job.id));
  const orphans = orphanNoticeKeys(notices, listed);
  const otherOutput =
    orphans.length === 0 ? null : (
      <Section title={`other background output · ${orphans.length}`}>
        <ul className="space-y-1">
          {orphans.map((source) => (
            <NoticeRow key={`${source.type}:${source.id}`} source={source} now={now} />
          ))}
        </ul>
      </Section>
    );
  if (snapshot === null) {
    return (
      <>
        <Section title="Jobs" action={refresh}>
          <Empty
            title="Waiting for omp"
            hint="The job list appears once this session's bridge reports."
            action={<Button size="xs" onClick={() => void refreshAsyncJobs(tabId)}>refresh</Button>}
          />
        </Section>
        {otherOutput}
      </>
    );
  }
  if (!snapshot.available) {
    return (
      <>
        <Section title="Jobs" action={refresh}>
          <Empty title="Background jobs unavailable" hint={snapshot.unavailable ?? ""} />
        </Section>
        {otherOutput}
      </>
    );
  }
  // Task jobs open the subagent view when the drill-down knows their agent.
  const known = new Set([...(subagents ?? []).map((agent) => agent.id), ...Object.keys(buffers ?? {})]);
  // omp's own /jobs tree layout (#868): each section nests its subagent jobs
  // under the task that spawned them; an older bridge's empty roster renders
  // today's flat order inside each section.
  const runningRows = buildAsyncJobRows(snapshot.running, [], snapshot.agents, snapshot.rootId);
  const recentRows = buildAsyncJobRows(snapshot.recent, [], snapshot.agents, snapshot.rootId);
  const renderRow = ({ job, depth }: AsyncJobRow) => {
    const agentId = job.agentId;
    // #1077: a subagent-owned row only kills through the bridge's owner-scoped
    // route. Match the bridge's rule exactly — no rootId (the flat snapshot
    // path, or a pre-v5 payload) means every listed job is the root's own.
    const nested =
      snapshot.rootId !== null && job.ownerId !== null && job.ownerId !== snapshot.rootId;
    return (
      <JobRow
        key={job.id}
        job={job}
        depth={depth}
        now={now}
        notice={notices[asyncNoticeKey({ id: job.id, type: "bash" })] ?? null}
        canInspect={snapshot.canInspect}
        canCancel={snapshot.canCancel && (!nested || snapshot.canCancelNested)}
        busy={pending !== null}
        agent={
          agentId !== null && known.has(agentId)
            ? {
                selected: selected === agentId,
                toggle: () => (selected === agentId ? closeSubagent(tabId) : openSubagent(tabId, agentId)),
              }
            : null
        }
        onKill={() => void killAsyncJob(tabId, { id: job.id, startTime: job.startTime })}
      />
    );
  };
  return (
    <>
      <Section
        title={`running · ${snapshot.running.length}`}
        action={
          <>
            {snapshot.canCancel && snapshot.running.length > 0 && (
              <Button
                size="xs"
                tone="rose"
                disabled={pending !== null}
                title="cancel every running background job"
                onClick={() => void killAsyncJob(tabId, null)}
              >
                kill all
              </Button>
            )}
            {refresh}
          </>
        }
      >
        {snapshot.running.length === 0 ? (
          <Empty title="No background jobs running" hint="Async bash commands and background subagents appear here while they run." />
        ) : (
          <ul className="space-y-1">{runningRows.map(renderRow)}</ul>
        )}
        {!snapshot.canCancel && snapshot.running.length > 0 && (
          <p className="mt-1 text-xs text-ink-faint">This omp build cannot cancel background jobs — update omp to 18.4.9 or later.</p>
        )}
        {error !== null && (
          <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-2 py-1 text-xs text-rose">
            {error}
          </p>
        )}
      </Section>
      {snapshot.recent.length > 0 && (
        <Section title={`finished · ${snapshot.recent.length}`}>
          <ul className="space-y-1">{recentRows.map(renderRow)}</ul>
        </Section>
      )}
      {otherOutput}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="chrome-label text-ink-faint">{label}</dt>
      <dd className="whitespace-pre-wrap break-all font-mono text-xs text-ink-mid">{children}</dd>
    </div>
  );
}

function JobRow({
  job,
  depth,
  now,
  notice,
  canInspect,
  canCancel,
  busy,
  agent,
  onKill,
}: {
  job: AsyncJob;
  depth: number;
  now: number;
  /** omp 19 matching-output notices for this job, newest tail (#1235). */
  notice: AsyncNoticeSource | null;
  canInspect: boolean;
  canCancel: boolean;
  busy: boolean;
  agent: { selected: boolean; toggle: () => void } | null;
  onKill: () => void;
}) {
  const [open, setOpen] = useState(false);
  const running = job.status === "running";
  // omp's live fields belong to a running job only (the bridge never sends
  // them for finished ones; the gate keeps a stale view from lingering).
  const widget = running ? job.widget : null;
  const stage = running ? (job.stage ?? widget?.stage ?? null) : null;
  const completion = running ? job.completionPercent : null;
  return (
    <li className="animate-slide-in" style={depth > 0 ? { paddingLeft: depth * 12 } : undefined}>
      <div className={cn("w-full rounded-md border border-line bg-raised px-2 py-1.5", !running && "opacity-70")}>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `hide details for job ${job.id}` : `show details for job ${job.id}`}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <Dot tone={AGENT_TONE[job.status] ?? "neutral"} pulse={running} title={job.status} />
            <span className="shrink-0 font-mono text-xs text-ink">{job.id}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-ink-dim" title={job.label}>{job.intent ?? job.label}</span>
          </button>
          <Chip mono>{job.type}</Chip>
          {agent !== null && (
            <Button
              size="xs"
              selected={agent.selected}
              aria-label={`open agent ${job.agentId ?? job.id}`}
              onClick={agent.toggle}
            >
              open
            </Button>
          )}
          {running && canCancel && (
            <Button size="xs" tone="rose" disabled={busy} title={`cancel background job ${job.id}`} onClick={onKill}>
              kill
            </Button>
          )}
        </div>
        {job.caption !== null && (
          <p data-job-caption className="mt-0.5 truncate pl-3 text-xs text-ink-faint" title={job.caption}>
            {job.caption}
          </p>
        )}
        <div className="mt-0.5 flex items-baseline gap-1.5 pl-3 font-mono text-xs text-ink-faint">
          <span>{job.status}</span>
          {job.exitCode !== null && <span>{`exit ${job.exitCode}`}</span>}
          <span>{formatDuration((job.endTime ?? now) - job.startTime)}</span>
          {completion !== null && <CompletionRing percent={completion} />}
        </div>
        {stage !== null && (
          <p data-job-stage className="mt-0.5 truncate pl-3 text-xs text-ink-mid" title={stage}>
            {stage}
          </p>
        )}
        {notice !== null && <NoticeOutput source={notice} expanded={open} />}
        {widget !== null && <JobWidgetGlance widget={widget} />}
        {open && widget !== null && <JobWidgetBlocks widget={widget} />}
        {open && !canInspect && <p className="mt-1 pl-3 text-xs text-ink-faint">This omp build reports no job details — update omp to 18.4.9 or later.</p>}
        {open && canInspect && (
          <dl className="mt-1 space-y-1 pl-3">
            {job.command !== null && <Field label="command">{job.command}</Field>}
            {job.cwd !== null && <Field label="directory">{job.cwd}</Field>}
            {job.pids.length > 0 && <Field label="pids">{job.pids.join(" ")}</Field>}
            {/* A tailed redirect target must never read as the job's own stream:
                the path label carries the provenance (issue #1154). */}
            <Field label={job.outputFile !== null ? `output · ${job.outputFile}` : "output"}>
              {job.outputTail === "" && !job.outputTruncated ? (
                <span className="text-ink-faint">no output yet</span>
              ) : (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-1.5 text-xs">
                  {job.outputTruncated ? `${"… earlier output trimmed"}\n` : ""}
                  {job.outputTail}
                </pre>
              )}
            </Field>
          </dl>
        )}
      </div>
    </li>
  );
}

/**
 * The reported-line block (#1235): collapsed to the newest matched line and
 * its counters so a running row stays scannable; expanded, every retained line
 * with omp's own `omitted` count and the rolled-off "N earlier" count. A
 * stopped source (omp's burst allowance spent) says so — silence after that is
 * expected, not lost output.
 */
function NoticeOutput({ source, expanded }: { source: AsyncNoticeSource; expanded: boolean }) {
  const last = source.lines.at(-1);
  return (
    <div data-notify-block className="mt-1 space-y-1 pl-3">
      {!expanded && last !== undefined && (
        <p className="truncate font-mono text-xs text-ink-mid" title={last}>
          {last}
        </p>
      )}
      {expanded && (
        <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-1.5 font-mono text-xs">
          {source.droppedLines > 0 ? `${`… ${source.droppedLines} earlier reported lines trimmed`}\n` : ""}
          {source.lines.join("\n")}
        </pre>
      )}
      <p className="flex flex-wrap items-baseline gap-x-2 font-mono text-xs text-ink-faint">
        <span title={source.pattern}>/{source.pattern}/</span>
        {source.omitted > 0 && (
          <span>{`+${source.omitted} omp left out`}</span>
        )}
        {!expanded && source.lines.length > 1 && (
          <span>{`${source.lines.length} reported lines`}</span>
        )}
        {source.stopped && <span className="text-copper">notices stopped</span>}
      </p>
    </div>
  );
}

/**
 * One notice source with no job row — a daemon-supervised service (they never
 * enter the job manager, ADR-0054) or a job omp already evicted from the
 * snapshot (#1235: a report never renders as nothing). Read-only: the pane's
 * kill verbs belong to listed jobs only.
 */
function NoticeRow({ source, now }: { source: AsyncNoticeSource; now: number }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="animate-slide-in">
      <div className="w-full rounded-md border border-line bg-raised px-2 py-1.5">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={open ? `hide details for job ${source.id}` : `show details for job ${source.id}`}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <Dot
              tone={source.running ? "copper" : "neutral"}
              pulse={source.running}
              title={source.running ? "reported recently" : `last report ${formatDuration(now - source.lastAt)} ago`}
            />
            <span className="shrink-0 font-mono text-xs text-ink">{source.id}</span>
          </button>
          <Chip mono>{source.type}</Chip>
        </div>
        <NoticeOutput source={source} expanded={open} />
      </div>
    </li>
  );
}
