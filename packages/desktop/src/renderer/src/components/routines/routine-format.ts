import {
  cronPreset,
  isValidCron,
  normalizeCronExpr,
  presetCron,
  type PromptSchedule,
} from "@omp-ui/core/scheduled-prompt";
import type { RoutineRunOutcome, RoutineRunReasonCode, RoutineRunRow } from "@omp-ui/core/routine";
import { localeTag, t, type MessageKey } from "../../lib/i18n";
import { formatSnoozeUntil } from "../../lib/snooze-until";
import type { Tone } from "../ui";

export type Repeat = "daily" | "weekdays" | "weekly" | "cron";

/** The editor's schedule fields; presets compile to the same cron the Schedule dialog writes. */
export interface ScheduleDraft {
  repeat: Repeat;
  time: string;
  weekday: number;
  expr: string;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function scheduleDraftOf(expr: string): ScheduleDraft {
  const preset = cronPreset(expr);
  if (preset === null) return { repeat: "cron", time: "09:00", weekday: 1, expr };
  return {
    repeat: preset.kind,
    time: `${pad(preset.hour)}:${pad(preset.minute)}`,
    weekday: preset.kind === "weekly" ? preset.weekday : 1,
    expr,
  };
}

/** The draft's schedule, or null while it is not a valid cron/@macro or 24-hour time. */
export function buildSchedule(draft: ScheduleDraft): PromptSchedule | null {
  if (draft.repeat === "cron") {
    const expr = normalizeCronExpr(draft.expr);
    return isValidCron(expr) ? { kind: "cron", expr } : null;
  }
  const m = /^(\d{2}):(\d{2})$/.exec(draft.time);
  if (m === null) return null;
  const hour = Number(m[1]);
  const minute = Number(m[2]);
  if (hour > 23 || minute > 59) return null;
  return {
    kind: "cron",
    expr: presetCron(
      draft.repeat === "weekly" ? { kind: "weekly", hour, minute, weekday: draft.weekday } : { kind: draft.repeat, hour, minute },
    ),
  };
}

export function weekdayName(day: number): string {
  // 2026-11-01 is a Sunday: day 0 lands on it.
  return new Intl.DateTimeFormat(localeTag(), { weekday: "short" }).format(new Date(2026, 10, 1 + day));
}

/** The list row's schedule summary: preset words when the cron spells one, else the expression. */
export function describeSchedule(schedule: PromptSchedule): string {
  if (schedule.kind !== "cron") return "";
  const preset = cronPreset(schedule.expr);
  if (preset === null) return t("routines.schedule.cron", { expr: schedule.expr });
  const time = `${pad(preset.hour)}:${pad(preset.minute)}`;
  if (preset.kind === "daily") return t("routines.schedule.daily", { time });
  if (preset.kind === "weekdays") return t("routines.schedule.weekdays", { time });
  return t("routines.schedule.weekly", { day: weekdayName(preset.weekday), time });
}

export function formatWhen(ms: number): string {
  return formatSnoozeUntil(ms, new Date(), localeTag());
}

export const OUTCOME_LABEL: Record<RoutineRunOutcome, MessageKey> = {
  running: "routines.outcome.running",
  "waiting-approval": "routines.outcome.waitingApproval",
  "on-time": "routines.outcome.onTime",
  late: "routines.outcome.late",
  skipped: "routines.outcome.skipped",
  failed: "routines.outcome.failed",
};

export const OUTCOME_TONE: Record<RoutineRunOutcome, Tone> = {
  running: "iris",
  "waiting-approval": "copper",
  "on-time": "signal",
  late: "copper",
  skipped: "neutral",
  failed: "rose",
};

export const REASON_LABEL: Record<RoutineRunReasonCode, MessageKey> = {
  overlap: "routines.reason.overlap",
  "host-lane-busy": "routines.reason.hostLaneBusy",
  "cost-cap": "routines.reason.costCap",
  "wall-clock": "routines.reason.wallClock",
  "usage-limit": "routines.reason.usageLimit",
  "approval-timeout": "routines.reason.approvalTimeout",
  "dispatch-failed": "routines.reason.dispatchFailed",
  "project-missing": "routines.reason.projectMissing",
  interrupted: "routines.reason.interrupted",
  error: "routines.reason.error",
};

/** A routine's runs, newest fire first. */
export function runsOf(runs: readonly RoutineRunRow[], routineId: string): RoutineRunRow[] {
  return runs.filter((r) => r.routineId === routineId).sort((a, b) => b.firedAtMs - a.firedAtMs);
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2).replace(/\.00$/, "")}`;
}
