import { cronPreset, type ScheduledPrompt, type ScheduledPromptNotice } from "@omp-ui/core/scheduled-prompt";
import { localeTag, useT, type MessageKey } from "../lib/i18n";
import { formatSnoozeUntil } from "../lib/snooze-until";
import { findRecord, useStore } from "../store";
import { Button, Chip } from "./ui";

type Translate = (key: MessageKey, vars?: Record<string, string | number>) => string;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/** "daily at 09:00", "weekdays at 18:00", "every Mon at 09:30", "cron 0 9 * * *", "once Tue 14:05". */
function describeSchedule(scheduled: ScheduledPrompt, t: Translate, now: Date): string {
  const text = describeTimes(scheduled, t, now);
  // A schedule set from a client in another zone reads its wall times there.
  return scheduled.schedule.kind === "cron" && scheduled.timeZone !== Intl.DateTimeFormat().resolvedOptions().timeZone
    ? `${text} (${scheduled.timeZone})`
    : text;
}

function describeTimes(scheduled: ScheduledPrompt, t: Translate, now: Date): string {
  const schedule = scheduled.schedule;
  if (schedule.kind === "once") return t("transcript.scheduled.once", { when: formatSnoozeUntil(schedule.atMs, now, localeTag()) });
  const preset = cronPreset(schedule.expr);
  if (preset === null) return t("transcript.scheduled.cron", { expr: schedule.expr });
  const time = `${pad(preset.hour)}:${pad(preset.minute)}`;
  if (preset.kind === "daily") return t("transcript.scheduled.daily", { time });
  if (preset.kind === "weekdays") return t("transcript.scheduled.weekdays", { time });
  // 2026-11-01 is a Sunday.
  const day = new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(new Date(2026, 10, 1 + preset.weekday));
  return t("transcript.scheduled.weekly", { day, time });
}

function noticeText(notice: ScheduledPromptNotice, t: Translate, now: Date): string {
  const when = formatSnoozeUntil(notice.dueAtMs, now, localeTag());
  if (notice.kind === "skipped") return t("transcript.scheduled.skipped", { when });
  if (notice.kind === "late")
    return notice.missed > 0
      ? t("transcript.scheduled.lateMissed", { when, count: notice.missed })
      : t("transcript.scheduled.late", { when });
  return t("transcript.scheduled.failed", { when, error: notice.error ?? "" });
}

/**
 * The session's scheduled prompt (issue #987) at the transcript's tail: what
 * runs, when it runs next, and what the owning host skipped or ran late. It
 * reads the session record, so every client of the session sees the same card.
 */
export function ScheduledPromptCard({ tabId }: { tabId: string }) {
  const t = useT();
  const scheduled = useStore((s) => findRecord(s.state, tabId)?.scheduledPrompt ?? null);
  const openScheduleDialog = useStore((s) => s.openScheduleDialog);
  const clearScheduledPrompt = useStore((s) => s.clearScheduledPrompt);
  const runScheduledPromptNow = useStore((s) => s.runScheduledPromptNow);
  if (scheduled == null) return null;
  const now = new Date();
  const next =
    scheduled.nextRunAtMs === null
      ? t("transcript.scheduled.noNext")
      : t("transcript.scheduled.next", { when: formatSnoozeUntil(scheduled.nextRunAtMs, now, localeTag()) });
  return (
    <div data-scheduled-prompt className="animate-rise rounded-md border border-iris-dim/60 bg-raised px-2.5 py-1.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
        <Chip tone="iris">{t("transcript.scheduled.label")}</Chip>
        <span className="min-w-0 flex-1 truncate text-ink-mid">
          {describeSchedule(scheduled, t, now)} · {next}
        </span>
        <Button size="xs" variant="ghost" onClick={() => openScheduleDialog(tabId)}>
          {t("transcript.scheduled.edit")}
        </Button>
        <Button size="xs" variant="ghost" onClick={() => void clearScheduledPrompt(tabId)}>
          {t("transcript.scheduled.remove")}
        </Button>
        <Button size="xs" tone="iris" onClick={() => void runScheduledPromptNow(tabId)}>
          {t("transcript.scheduled.runNow")}
        </Button>
      </div>
      <p className="mt-1 line-clamp-2 whitespace-pre-wrap text-[12px] text-ink">{scheduled.text}</p>
      {scheduled.notices.map((notice) => (
        <p
          key={`${notice.kind}-${notice.atMs}`}
          data-scheduled-notice={notice.kind}
          className={notice.kind === "failed" ? "mt-0.5 text-[11px] text-rose" : "mt-0.5 text-[11px] text-ink-dim"}
        >
          {noticeText(notice, t, now)}
        </p>
      ))}
    </div>
  );
}
