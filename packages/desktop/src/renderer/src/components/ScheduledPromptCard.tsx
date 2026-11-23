import { cronPreset, type ScheduledPrompt, type ScheduledPromptNotice } from "@omp-ui/core/scheduled-prompt";
import { formatSnoozeUntil } from "../lib/snooze-until";
import { findRecord, useStore } from "../store";
import { Button, Chip } from "./ui";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "daily at 09:00", "weekdays at 18:00", "every Mon at 09:30", "cron 0 9 * * *", "once Tue 14:05". */
function describeSchedule(scheduled: ScheduledPrompt, now: Date): string {
  const text = describeTimes(scheduled, now);
  // A schedule set from a client in another zone reads its wall times there.
  return scheduled.schedule.kind === "cron" && scheduled.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone
    ? `${text} (${scheduled.timeZone})`
    : text;
}

function describeTimes(scheduled: ScheduledPrompt, now: Date): string {
  const schedule = scheduled.schedule;
  if (schedule.kind === "once") return `once ${formatSnoozeUntil(schedule.atMs, now)}`;
  const preset = cronPreset(schedule.expr);
  if (preset === null) return `cron ${schedule.expr}`;
  const time = `${pad(preset.hour)}:${pad(preset.minute)}`;
  if (preset.kind === "daily") return `daily at ${time}`;
  if (preset.kind === "weekdays") return `weekdays at ${time}`;
  // 2026-11-01 is a Sunday.
  const day = new Intl.DateTimeFormat("en", { weekday: "short" }).format(new Date(2026, 10, 1 + preset.weekday));
  return `every ${day} at ${time}`;
}

function noticeText(notice: ScheduledPromptNotice, now: Date): string {
  const when = formatSnoozeUntil(notice.dueAtMs, now);
  if (notice.kind === "skipped") return `skipped ${when}: a run was still in progress`;
  if (notice.kind === "late")
    return notice.missed > 0
      ? `ran once for ${when} after omp-ui was closed; ${notice.missed} later times that passed meanwhile were not run`
      : `ran late for ${when}: omp-ui was closed or the machine slept`;
  return `${when} did not run: ${notice.error ?? ""}`;
}

/**
 * The session's scheduled prompt (issue #987) at the transcript's tail: what
 * runs, when it runs next, and what the owning host skipped or ran late. It
 * reads the session record, so every client of the session sees the same card.
 */
export function ScheduledPromptCard({ tabId }: { tabId: string }) {
  const scheduled = useStore((s) => findRecord(s.state, tabId)?.scheduledPrompt ?? null);
  const openScheduleDialog = useStore((s) => s.openScheduleDialog);
  const clearScheduledPrompt = useStore((s) => s.clearScheduledPrompt);
  const runScheduledPromptNow = useStore((s) => s.runScheduledPromptNow);
  if (scheduled == null) return null;
  const now = new Date();
  const next =
    scheduled.nextRunAtMs === null
      ? "no further runs"
      : `next ${formatSnoozeUntil(scheduled.nextRunAtMs, now)}`;
  return (
    <div data-scheduled-prompt className="animate-rise rounded-md border border-iris-dim/60 bg-raised px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-xs">
        <Chip tone="iris">Scheduled</Chip>
        <span className="min-w-0 flex-1 truncate text-ink-mid">
          {describeSchedule(scheduled, now)} · {next}
        </span>
        <Button size="xs" variant="ghost" onClick={() => openScheduleDialog(tabId)}>
          edit
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void clearScheduledPrompt(tabId)}>
          remove
        </Button>
        <Button size="xs" tone="iris" onClick={() => void runScheduledPromptNow(tabId)}>
          run now
        </Button>
      </div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-xs text-ink">{scheduled.text}</p>
      {scheduled.notices.map((notice) => (
        <p
          key={`${notice.kind}-${notice.atMs}`}
          data-scheduled-notice={notice.kind}
          className={notice.kind === "failed" ? "mt-0.5 text-xs text-rose" : "mt-0.5 text-xs text-ink-dim"}
        >
          {noticeText(notice, now)}
        </p>
      ))}
    </div>
  );
}
