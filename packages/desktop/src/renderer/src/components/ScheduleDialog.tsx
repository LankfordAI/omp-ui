import { useState } from "react";
import {
  SCHEDULED_PROMPT_TEXT_MAX,
  cronPreset,
  isValidCron,
  nextRunAfter,
  presetCron,
  type PromptSchedule,
} from "@omp-ui/core/scheduled-prompt";
import { localeTag, useT, type MessageKey } from "../lib/i18n";
import { formatSnoozeUntil, fromDateTimeLocal, toDateTimeLocal } from "../lib/snooze-until";
import { findRecord, useStore } from "../store";
import { FIELD } from "./settings/rows";
import { Button, ChoiceCapsule, ConfirmDialog } from "./ui";

type Repeat = "once" | "daily" | "weekdays" | "weekly" | "cron";

const REPEAT_LABEL = {
  once: "dialog.schedule.once",
  daily: "dialog.schedule.daily",
  weekdays: "dialog.schedule.weekdays",
  weekly: "dialog.schedule.weekly",
  cron: "dialog.schedule.cron",
} as const satisfies Record<Repeat, MessageKey>;

/** Sunday-first, the cron day numbering. */
const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

/**
 * The Schedule dialog (issue #987): attaches a prompt to a native session,
 * once at a time or on a recurring schedule, read in this client's time
 * zone. The owning host keeps and fires it; reopening edits it.
 */
export function ScheduleDialog({ tabId }: { tabId: string }) {
  const t = useT();
  const existing = useStore((s) => findRecord(s.state, tabId)?.scheduledPrompt ?? null);
  const close = useStore((s) => s.closeScheduleDialog);
  const setScheduledPrompt = useStore((s) => s.setScheduledPrompt);
  const clearScheduledPrompt = useStore((s) => s.clearScheduledPrompt);
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const seeded = existing?.schedule.kind === "cron" ? cronPreset(existing.schedule.expr) : null;
  const [text, setText] = useState(existing?.text ?? "");
  const [repeat, setRepeat] = useState<Repeat>(
    existing === null ? "daily" : existing.schedule.kind === "once" ? "once" : (seeded?.kind ?? "cron"),
  );
  const [time, setTime] = useState(seeded !== null ? `${pad(seeded.hour)}:${pad(seeded.minute)}` : "09:00");
  const [weekday, setWeekday] = useState(seeded?.kind === "weekly" ? seeded.weekday : 1);
  const [at, setAt] = useState(() =>
    toDateTimeLocal(existing?.schedule.kind === "once" ? existing.schedule.atMs : Date.now() + 3_600_000),
  );
  const [expr, setExpr] = useState(existing?.schedule.kind === "cron" ? existing.schedule.expr : "0 9 * * 1-5");

  const schedule = ((): PromptSchedule | null => {
    if (repeat === "once") {
      const atMs = fromDateTimeLocal(at);
      return atMs === null ? null : { kind: "once", atMs };
    }
    if (repeat === "cron") return isValidCron(expr) ? { kind: "cron", expr: expr.trim() } : null;
    const m = /^(\d{2}):(\d{2})$/.exec(time);
    if (m === null) return null;
    const hour = Number(m[1]);
    const minute = Number(m[2]);
    return {
      kind: "cron",
      expr: presetCron(repeat === "weekly" ? { kind: "weekly", hour, minute, weekday } : { kind: repeat, hour, minute }),
    };
  })();
  const now = Date.now();
  const nextRun = schedule === null ? null : nextRunAfter(schedule, timeZone, now);
  const trimmed = text.trim();
  const error =
    trimmed === ""
      ? t("dialog.schedule.emptyPrompt")
      : text.length > SCHEDULED_PROMPT_TEXT_MAX
        ? t("dialog.schedule.tooLong", { max: SCHEDULED_PROMPT_TEXT_MAX })
        : schedule === null
          ? t(repeat === "cron" ? "dialog.schedule.badCron" : "dialog.schedule.badTime")
          : nextRun === null
            ? t("dialog.schedule.never")
            : null;

  const save = async (): Promise<void> => {
    if (schedule === null || error !== null) return;
    if (await setScheduledPrompt(tabId, { text, schedule, timeZone })) close();
  };
  const weekdayName = (day: number): string =>
    // 2026-11-01 is a Sunday.
    new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(new Date(2026, 10, 1 + day));

  return (
    <ConfirmDialog
      kicker={t("dialog.schedule.kicker")}
      title={t(existing === null ? "dialog.schedule.title" : "dialog.schedule.editTitle")}
      tone="iris"
      onClose={close}
      width="w-[30rem]"
      actions={
        <>
          {existing !== null && (
            <Button
              variant="ghost"
              tone="rose"
              className="mr-auto"
              onClick={() => {
                void clearScheduledPrompt(tabId);
                close();
              }}
            >
              {t("dialog.schedule.remove")}
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            {t("common.dialog.cancel")}
          </Button>
          <Button variant="solid" tone="iris" disabled={error !== null} onClick={() => void save()}>
            {t("dialog.schedule.save")}
          </Button>
        </>
      }
    >
      <div data-schedule-dialog className="flex flex-col gap-3 text-xs text-ink-mid">
        <label className="flex flex-col gap-1.5">
          {t("dialog.schedule.prompt")}
          <textarea
            autoFocus
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={t("dialog.schedule.promptPlaceholder")}
            className={`${FIELD} resize-y`}
          />
        </label>
        <ChoiceCapsule
          label={t("dialog.schedule.repeat")}
          value={repeat}
          onChange={setRepeat}
          tone="iris"
          options={(Object.keys(REPEAT_LABEL) as Repeat[]).map((value) => ({ value, label: t(REPEAT_LABEL[value]) }))}
        />
        {repeat === "once" && (
          <label className="flex flex-col gap-1.5">
            {t("dialog.schedule.at")}
            <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} className={FIELD} />
          </label>
        )}
        {(repeat === "daily" || repeat === "weekdays" || repeat === "weekly") && (
          <div className="flex gap-2">
            {repeat === "weekly" && (
              <label className="flex flex-1 flex-col gap-1.5">
                {t("dialog.schedule.weekday")}
                <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} className={FIELD}>
                  {WEEKDAYS.map((day) => (
                    <option key={day} value={day}>
                      {weekdayName(day)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex flex-1 flex-col gap-1.5">
              {t("dialog.schedule.time")}
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className={FIELD} />
            </label>
          </div>
        )}
        {repeat === "cron" && (
          <label className="flex flex-col gap-1.5">
            {t("dialog.schedule.cronLabel")}
            <input
              value={expr}
              onChange={(event) => setExpr(event.target.value)}
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
        )}
        <p className="text-[11px] text-ink-dim">
          {error ?? t("dialog.schedule.next", { when: formatSnoozeUntil(nextRun!, new Date(now), localeTag()), zone: timeZone })}
        </p>
        <p className="text-[11px] text-ink-faint">{t("dialog.schedule.hint")}</p>
      </div>
    </ConfirmDialog>
  );
}
