import {
  cronPreset,
  isValidCron,
  normalizeCronExpr,
  presetCron,
  type PromptSchedule,
} from "@omp-ui/core/scheduled-prompt";
import {
  ROUTINE_REASON_LABEL,
  type RoutinePostScriptStatus,
  type RoutineRecord,
  type RoutineRunOutcome,
  type RoutineRunReasonCode,
  type RoutineRunRow,
} from "@omp-ui/core/routine";
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
  return new Intl.DateTimeFormat("en", { weekday: "short" }).format(new Date(2026, 10, 1 + day));
}

/** The list row's schedule summary: preset words when the cron spells one, else the expression. */
export function describeSchedule(schedule: PromptSchedule): string {
  if (schedule.kind !== "cron") return "";
  const preset = cronPreset(schedule.expr);
  if (preset === null) return `Cron: ${schedule.expr}`;
  const time = `${pad(preset.hour)}:${pad(preset.minute)}`;
  if (preset.kind === "daily") return `Daily at ${time}`;
  if (preset.kind === "weekdays") return `Weekdays at ${time}`;
  return `${weekdayName(preset.weekday)} at ${time}`;
}

export function formatWhen(ms: number): string {
  return formatSnoozeUntil(ms, new Date());
}

export const OUTCOME_LABEL: Record<RoutineRunOutcome, string> = {
  running: "Running",
  "waiting-approval": "Waiting on approval",
  "on-time": "On time",
  late: "Late",
  skipped: "Skipped",
  failed: "Failed",
};

export const OUTCOME_TONE: Record<RoutineRunOutcome, Tone> = {
  running: "iris",
  "waiting-approval": "copper",
  "on-time": "signal",
  late: "copper",
  skipped: "neutral",
  failed: "rose",
};

export const REASON_LABEL: Readonly<Record<RoutineRunReasonCode, string>> = ROUTINE_REASON_LABEL;

export const POST_SCRIPT_LABEL: Record<RoutinePostScriptStatus, string> = {
  ok: "Post hook ok",
  failed: "Post hook failed",
  timeout: "Post hook timed out",
  interrupted: "Post hook skipped",
};

export const POST_SCRIPT_TONE: Record<RoutinePostScriptStatus, Tone> = {
  ok: "signal",
  failed: "rose",
  timeout: "rose",
  interrupted: "copper",
};

/** A routine's runs, newest fire first. */
export function runsOf(runs: readonly RoutineRunRow[], routineId: string): RoutineRunRow[] {
  return runs.filter((r) => r.routineId === routineId).sort((a, b) => b.firedAtMs - a.firedAtMs);
}

/** The gallery's filter pill; "waiting" means a run of the routine paused on an Approval card. */
export type RoutineFilter = "all" | "enabled" | "paused" | "waiting" | "refresh";
/** The gallery's sort selector: next scheduled fire, name, or newest fire. */
export type RoutineSort = "next" | "name" | "lastrun";

export interface RoutineGalleryQuery {
  query: string;
  filter: RoutineFilter;
  sort: RoutineSort;
}

/** Routines whose latest state matches the gallery query, in the sorted display order. */
export function visibleRoutines(
  routines: readonly RoutineRecord[],
  runs: readonly RoutineRunRow[],
  q: RoutineGalleryQuery,
): RoutineRecord[] {
  const needle = q.query.trim().toLowerCase();
  // Routines with at least one waiting-approval run; the attention strip and
  // the "Waiting approval" pill share this predicate.
  const waitingIds = new Set(
    runs.filter((r) => r.outcome === "waiting-approval").map((r) => r.routineId),
  );
  const lastFired = new Map<string, number>();
  for (const run of runs) {
    const prev = lastFired.get(run.routineId);
    if (prev === undefined || run.firedAtMs > prev) lastFired.set(run.routineId, run.firedAtMs);
  }
  const matched = routines.filter((routine) => {
    if (needle !== "") {
      const haystack = `${routine.name}\n${routine.destination.projectCwd}\n${describeSchedule(routine.schedule)}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    switch (q.filter) {
      case "all":
        return true;
      case "enabled":
        return routine.enabled;
      case "paused":
        return !routine.enabled;
      case "waiting":
        return waitingIds.has(routine.id);
      case "refresh":
        return routine.artifact !== null;
    }
  });
  const byName = (a: RoutineRecord, b: RoutineRecord): number => a.name.localeCompare(b.name);
  if (q.sort === "name") return matched.sort(byName);
  if (q.sort === "lastrun") {
    return matched.sort((a, b) => {
      const fa = lastFired.get(a.id) ?? -1;
      const fb = lastFired.get(b.id) ?? -1;
      if (fa !== fb) return fb - fa;
      return byName(a, b);
    });
  }
  // "next": enabled routines with a scheduled fire first, ascending; everything
  // else (paused, or enabled-but-never-scheduled) last, alphabetically.
  return matched.sort((a, b) => {
    const na = a.enabled && a.nextRunAtMs !== null ? a.nextRunAtMs : null;
    const nb = b.enabled && b.nextRunAtMs !== null ? b.nextRunAtMs : null;
    if (na !== null && nb !== null) return na - nb || byName(a, b);
    if (na !== null) return -1;
    if (nb !== null) return 1;
    return byName(a, b);
  });
}

export function formatUsd(value: number): string {
  return `$${value.toFixed(2).replace(/\.00$/, "")}`;
}

/** Formats a resolved routine timeout in minutes (0 = unlimited). */
export function formatTimeout(minutes: number): string {
  if (minutes === 0) return "Unlimited";
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (m === 0) return `${h} h`;
  return `${h} h ${m} min`;
}
