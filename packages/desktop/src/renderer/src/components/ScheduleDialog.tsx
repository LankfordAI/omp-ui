import { useState } from "react";
import {
  SCHEDULED_PROMPT_TEXT_MAX,
  cronPreset,
  isValidCron,
  nextRunAfter,
  presetCron,
  type PromptSchedule,
} from "@omp-ui/core/scheduled-prompt";
import { formatSnoozeUntil, fromDateTimeLocal, toDateTimeLocal } from "../lib/snooze-until";
import { findRecord, useStore } from "../store";
import { FIELD } from "./settings/rows";
import { Button, ChoiceCapsule, ConfirmDialog } from "./ui";

type Repeat = "once" | "daily" | "weekdays" | "weekly" | "cron";

const REPEAT_LABEL = {
  once: "Once",
  daily: "Daily",
  weekdays: "Weekdays",
  weekly: "Weekly",
  cron: "Cron",
} as const satisfies Record<Repeat, string>;

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
      ? "Write the prompt to send."
      : text.length > SCHEDULED_PROMPT_TEXT_MAX
        ? `The prompt is over ${SCHEDULED_PROMPT_TEXT_MAX} characters.`
        : schedule === null
          ? repeat === "cron" ? "Not a five-field cron expression." : "Pick a valid time."
          : nextRun === null
            ? "This schedule never runs after now."
            : null;

  const save = async (): Promise<void> => {
    if (schedule === null || error !== null) return;
    if (await setScheduledPrompt(tabId, { text, schedule, timeZone })) close();
  };
  const weekdayName = (day: number): string =>
    // 2026-11-01 is a Sunday.
    new Intl.DateTimeFormat("en", { weekday: "short" }).format(new Date(2026, 10, 1 + day));

  return (
    <ConfirmDialog
      kicker="Scheduled prompt"
      title={existing === null ? "Schedule a prompt" : "Edit the scheduled prompt"}
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
              Remove schedule
            </Button>
          )}
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
          <Button variant="solid" tone="iris" disabled={error !== null} onClick={() => void save()}>
            Schedule
          </Button>
        </>
      }
    >
      <div data-schedule-dialog className="flex flex-col gap-3 text-xs text-ink-mid">
        <label className="flex flex-col gap-1.5">
          Prompt
          <textarea
            autoFocus
            rows={4}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder="e.g. Audit dependencies and open issues for anything outdated"
            className={`${FIELD} resize-y`}
          />
        </label>
        <ChoiceCapsule
          label="Repeat"
          value={repeat}
          onChange={setRepeat}
          tone="iris"
          options={(Object.keys(REPEAT_LABEL) as Repeat[]).map((value) => ({ value, label: REPEAT_LABEL[value] }))}
        />
        {repeat === "once" && (
          <label className="flex flex-col gap-1.5">
            At
            <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} className={FIELD} />
          </label>
        )}
        {(repeat === "daily" || repeat === "weekdays" || repeat === "weekly") && (
          <div className="flex gap-2">
            {repeat === "weekly" && (
              <label className="flex flex-1 flex-col gap-1.5">
                Day
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
              Time
              <input type="time" value={time} onChange={(event) => setTime(event.target.value)} className={FIELD} />
            </label>
          </div>
        )}
        {repeat === "cron" && (
          <label className="flex flex-col gap-1.5">
            Cron expression (minute hour day month weekday)
            <input
              value={expr}
              onChange={(event) => setExpr(event.target.value)}
              spellCheck={false}
              className={`${FIELD} font-mono`}
            />
          </label>
        )}
        <p className="text-xs text-ink-dim">
          {error ?? `Next run ${formatSnoozeUntil(nextRun!, new Date(now))} (${timeZone})`}
        </p>
        <p className="text-xs text-ink-faint">Runs in Build mode. A run still in progress skips that time; times missed while omp-ui is closed run once at the next start.</p>
      </div>
    </ConfirmDialog>
  );
}
