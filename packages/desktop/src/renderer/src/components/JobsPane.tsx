import { useEffect, useState, type ReactNode } from "react";
import type { AsyncJob } from "@omp-ui/core/async-jobs";
import { AGENT_TONE } from "../lib/agent-tone";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/duration";
import { startVisibleInterval } from "../lib/visible-interval";
import { useT } from "../lib/i18n";
import { useStore } from "../store";
import { Section } from "./RailSection";
import { Button, Chip, Dot, Empty, IconButton, IconRefresh } from "./ui";

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

/**
 * The session's omp background jobs (issue #835): running first, then the
 * finished ones omp still retains. Rows expand to command, cwd, pids and the
 * output tail; kill rides the bridge and works mid-turn.
 */
export function JobsPane({ tabId }: { tabId: string }) {
  const t = useT();
  const snapshot = useStore((s) => s.rpc[tabId]?.asyncJobs ?? null);
  const pending = useStore((s) => s.rpc[tabId]?.asyncJobsKill ?? null);
  const error = useStore((s) => s.rpc[tabId]?.asyncJobsKillError ?? null);
  const subagents = useStore((s) => s.rpc[tabId]?.subagents);
  const buffers = useStore((s) => s.rpc[tabId]?.subagentItems);
  const selected = useStore((s) => s.rpc[tabId]?.selectedSubagent ?? null);
  const refreshAsyncJobs = useStore((s) => s.refreshAsyncJobs);
  const killAsyncJob = useStore((s) => s.killAsyncJob);
  const openSubagent = useStore((s) => s.openSubagent);
  const closeSubagent = useStore((s) => s.closeSubagent);
  const now = useNow((snapshot?.running.length ?? 0) > 0);

  const refresh = (
    <IconButton label={t("rail.jobs.refreshLabel")} onClick={() => void refreshAsyncJobs(tabId)}>
      <IconRefresh />
    </IconButton>
  );
  if (snapshot === null) {
    return (
      <Section title={t("rail.tabs.jobs")} action={refresh}>
        <Empty
          title={t("rail.jobs.waitingTitle")}
          hint={t("rail.jobs.waitingHint")}
          action={<Button size="xs" onClick={() => void refreshAsyncJobs(tabId)}>{t("rail.jobs.refresh")}</Button>}
        />
      </Section>
    );
  }
  if (!snapshot.available) {
    return (
      <Section title={t("rail.tabs.jobs")} action={refresh}>
        <Empty title={t("rail.jobs.unavailableTitle")} hint={snapshot.unavailable ?? ""} />
      </Section>
    );
  }
  // Task jobs open the subagent view when the drill-down knows their agent.
  const known = new Set([...(subagents ?? []).map((agent) => agent.id), ...Object.keys(buffers ?? {})]);
  const row = (job: AsyncJob) => {
    const agentId = job.agentId;
    return (
      <JobRow
        key={job.id}
        job={job}
        now={now}
        canInspect={snapshot.canInspect}
        canCancel={snapshot.canCancel}
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
        title={t("rail.jobs.runningTitle", { count: snapshot.running.length })}
        action={
          <>
            {snapshot.canCancel && snapshot.running.length > 0 && (
              <Button
                size="xs"
                tone="rose"
                disabled={pending !== null}
                title={t("rail.jobs.killAllTitle")}
                onClick={() => void killAsyncJob(tabId, null)}
              >
                {t("rail.jobs.killAll")}
              </Button>
            )}
            {refresh}
          </>
        }
      >
        {snapshot.running.length === 0 ? (
          <Empty title={t("rail.jobs.emptyTitle")} hint={t("rail.jobs.emptyHint")} />
        ) : (
          <ul className="space-y-1">{snapshot.running.map(row)}</ul>
        )}
        {!snapshot.canCancel && snapshot.running.length > 0 && (
          <p className="mt-1 text-[10px] text-ink-faint">{t("rail.jobs.noCancel")}</p>
        )}
        {error !== null && (
          <p className="mt-1 rounded-md border border-rose-dim/50 bg-rose-wash px-2 py-1 text-[10px] text-rose">
            {error}
          </p>
        )}
      </Section>
      {snapshot.recent.length > 0 && (
        <Section title={t("rail.jobs.recentTitle", { count: snapshot.recent.length })}>
          <ul className="space-y-1">{snapshot.recent.map(row)}</ul>
        </Section>
      )}
    </>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-[10px] uppercase tracking-[0.08em] text-ink-faint">{label}</dt>
      <dd className="whitespace-pre-wrap break-all font-mono text-[11px] text-ink-mid">{children}</dd>
    </div>
  );
}

function JobRow({
  job,
  now,
  canInspect,
  canCancel,
  busy,
  agent,
  onKill,
}: {
  job: AsyncJob;
  now: number;
  canInspect: boolean;
  canCancel: boolean;
  busy: boolean;
  agent: { selected: boolean; toggle: () => void } | null;
  onKill: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const running = job.status === "running";
  return (
    <li className="animate-slide-in">
      <div className={cn("w-full rounded-md border border-line bg-raised px-2 py-1.5", !running && "opacity-70")}>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            aria-expanded={open}
            aria-label={t(open ? "rail.jobs.collapse" : "rail.jobs.expand", { job: job.id })}
            onClick={() => setOpen(!open)}
            className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
          >
            <Dot tone={AGENT_TONE[job.status] ?? "neutral"} pulse={running} title={job.status} />
            <span className="shrink-0 font-mono text-[11px] text-ink">{job.id}</span>
            <span className="min-w-0 flex-1 truncate text-[11px] text-ink-dim" title={job.label}>{job.label}</span>
          </button>
          <Chip mono>{job.type}</Chip>
          {agent !== null && (
            <Button
              size="xs"
              selected={agent.selected}
              aria-label={t("rail.jobs.openAgent", { agent: job.agentId ?? job.id })}
              onClick={agent.toggle}
            >
              {t("rail.jobs.open")}
            </Button>
          )}
          {running && canCancel && (
            <Button size="xs" tone="rose" disabled={busy} title={t("rail.jobs.killTitle", { job: job.id })} onClick={onKill}>
              {t("rail.jobs.kill")}
            </Button>
          )}
        </div>
        <div className="mt-0.5 flex items-baseline gap-1.5 pl-3 font-mono text-[10px] text-ink-faint">
          <span>{job.status}</span>
          {job.exitCode !== null && <span>{t("rail.jobs.exit", { code: job.exitCode })}</span>}
          <span>{formatDuration((job.endTime ?? now) - job.startTime)}</span>
        </div>
        {open && !canInspect && <p className="mt-1 pl-3 text-[10px] text-ink-faint">{t("rail.jobs.noInspect")}</p>}
        {open && canInspect && (
          <dl className="mt-1 space-y-1 pl-3">
            {job.command !== null && <Field label={t("rail.jobs.command")}>{job.command}</Field>}
            {job.cwd !== null && <Field label={t("rail.jobs.cwd")}>{job.cwd}</Field>}
            {job.pids.length > 0 && <Field label={t("rail.jobs.pids")}>{job.pids.join(" ")}</Field>}
            <Field label={t("rail.jobs.output")}>
              {job.outputTail === "" && !job.outputTruncated ? (
                <span className="text-ink-faint">{t("rail.jobs.noOutput")}</span>
              ) : (
                <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-sunken p-1.5 text-[10px]">
                  {job.outputTruncated ? `${t("rail.jobs.outputTruncated")}\n` : ""}
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
