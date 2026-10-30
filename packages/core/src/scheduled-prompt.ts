// The scheduled-prompt contract (issue #987, ADR-0081): a prompt the owning
// host sends into a native session at a wall-clock time, once or on a
// recurring schedule. Pure and import-free, because the renderer imports it
// through the @omp-ui/core/scheduled-prompt subpath for its preview.

/** Command-id prefix of a scheduled fire's `prompt` command. */
export const SCHEDULED_PROMPT_COMMAND_PREFIX = "omp-ui-scheduled-prompt-";

/** Longest prompt text a schedule carries; it rides every state broadcast. */
export const SCHEDULED_PROMPT_TEXT_MAX = 16_000;

/** Notices the record keeps, newest first. */
export const SCHEDULED_PROMPT_NOTICES_MAX = 3;

/** A fire sent this long after its due time is reported as late. */
export const SCHEDULED_PROMPT_LATE_MS = 120_000;

/**
 * When the prompt fires: once at an instant, or on a five-field cron
 * expression read in `timeZone`. The dialog's daily, weekdays and weekly
 * presets are cron expressions too ({@link presetCron}).
 */
export type PromptSchedule = { kind: "once"; atMs: number } | { kind: "cron"; expr: string };

/** Something the owning host did instead of, or besides, an on-time fire. */
export interface ScheduledPromptNotice {
  /**
   * `skipped`: a run was still in progress (or the session could not take a
   * prompt for a whole period). `late`: the fire went out after its due time
   * because omp-ui was closed or the machine slept; earlier missed fires were
   * folded into it. `failed`: omp rejected the prompt, or the session exited
   * before admitting it.
   */
  kind: "skipped" | "late" | "failed";
  /** When the host recorded it. */
  atMs: number;
  /** The occurrence it is about. */
  dueAtMs: number;
  /** `late` only: further occurrences that passed unsent and were not run. */
  missed: number;
  /** `failed` only. */
  error: string | null;
}

/** The schedule as the session record carries it (`OwnedSessionRecord.scheduledPrompt`). */
export interface ScheduledPrompt {
  id: string;
  text: string;
  schedule: PromptSchedule;
  /** IANA zone the schedule's wall-clock times are read in: the zone of the client that set it. */
  timeZone: string;
  createdAtMs: number;
  /** The occurrence the host waits to fire; null once a one-shot ran or failed. */
  nextRunAtMs: number | null;
  /** When omp last admitted a fire. */
  lastRunAtMs: number | null;
  notices: ScheduledPromptNotice[];
}

/** What the Schedule dialog sends. */
export interface ScheduledPromptRequest {
  text: string;
  schedule: PromptSchedule;
  timeZone: string;
}

export function scheduledPromptCommandId(id: string, dueAtMs: number): string {
  return `${SCHEDULED_PROMPT_COMMAND_PREFIX}${id}-${dueAtMs}`;
}

/* ------------------------------------------------------------------ cron */

interface CronFields {
  minutes: number[];
  hours: number[];
  days: Set<number>;
  months: Set<number>;
  weekdays: Set<number>;
  /** Vixie rule: with both day fields restricted, a day matching either fires. */
  dayOr: boolean;
}

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function parseField(field: string, min: number, max: number, names: string[] | null, nameBase: number): number[] | null {
  const out = new Set<number>();
  const value = (token: string): number | null => {
    const lower = token.toLowerCase();
    if (names !== null) {
      const at = names.indexOf(lower);
      if (at !== -1) return at + nameBase;
    }
    return /^\d+$/.test(token) ? Number(token) : null;
  };
  for (const part of field.split(",")) {
    const m = /^(\*|[^/-]+(?:-[^/-]+)?)(?:\/(\d+))?$/.exec(part);
    if (m === null) return null;
    const step = m[2] === undefined ? 1 : Number(m[2]);
    if (step < 1) return null;
    let lo: number;
    let hi: number;
    if (m[1] === "*") {
      lo = min;
      hi = max;
    } else {
      const [a, b] = m[1]!.split("-");
      const from = value(a!);
      const to = b === undefined ? (m[2] === undefined ? from : max) : value(b);
      if (from === null || to === null) return null;
      lo = from;
      hi = to;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let n = lo; n <= hi; n += step) out.add(n);
  }
  return [...out].sort((a, b) => a - b);
}

/** Parses a five-field cron expression (minute hour day-of-month month day-of-week); null when invalid. */
function parseCron(expr: string): CronFields | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const [mi, h, dom, mon, dow] = parts as [string, string, string, string, string];
  const minutes = parseField(mi, 0, 59, null, 0);
  const hours = parseField(h, 0, 23, null, 0);
  const days = parseField(dom, 1, 31, null, 0);
  const months = parseField(mon, 1, 12, MONTH_NAMES, 1);
  // 7 is Sunday too.
  const weekdays = parseField(dow, 0, 7, DAY_NAMES, 0);
  if (minutes === null || hours === null || days === null || months === null || weekdays === null) return null;
  return {
    minutes,
    hours,
    days: new Set(days),
    months: new Set(months),
    weekdays: new Set(weekdays.map((d) => d % 7)),
    dayOr: dom !== "*" && dow !== "*",
  };
}

export function isValidCron(expr: string): boolean {
  return parseCron(expr) !== null;
}

/* -------------------------------------------------------------- time zones */

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (f === undefined) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  if (timeZone === "") return false;
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

interface Wall {
  y: number;
  mo: number;
  d: number;
  h: number;
  mi: number;
}

function wallAt(ms: number, timeZone: string): Wall {
  const parts: Record<string, number> = {};
  for (const p of formatter(timeZone).formatToParts(ms)) if (p.type !== "literal") parts[p.type] = Number(p.value);
  return { y: parts.year!, mo: parts.month!, d: parts.day!, h: parts.hour!, mi: parts.minute! };
}

/** The zone's UTC offset at `ms`, in ms (minute precision). */
function offsetAt(ms: number, timeZone: string): number {
  const w = wallAt(ms, timeZone);
  return Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi) - Math.floor(ms / 60_000) * 60_000;
}

/** The instant a wall-clock minute names in `timeZone`. A time a DST gap skips lands just after the gap. */
function wallToMs(w: Wall, timeZone: string): number {
  const guess = Date.UTC(w.y, w.mo - 1, w.d, w.h, w.mi);
  const first = guess - offsetAt(guess, timeZone);
  const second = guess - offsetAt(first, timeZone);
  if (second === first) return first;
  const hit = wallAt(second, timeZone);
  return hit.h === w.h && hit.mi === w.mi ? second : Math.max(first, second);
}

/** Longest search for a cron match: a Feb 29 schedule needs up to eight years. */
const CRON_SEARCH_DAYS = 366 * 8;

/** The first instant strictly after `afterMs` the schedule fires; null when it never will. */
export function nextRunAfter(schedule: PromptSchedule, timeZone: string, afterMs: number): number | null {
  if (schedule.kind === "once") return schedule.atMs > afterMs ? schedule.atMs : null;
  const cron = parseCron(schedule.expr);
  if (cron === null || !isValidTimeZone(timeZone)) return null;
  const start = wallAt(afterMs, timeZone);
  for (let k = 0; k <= CRON_SEARCH_DAYS; k += 1) {
    const day = new Date(Date.UTC(start.y, start.mo - 1, start.d + k));
    const y = day.getUTCFullYear();
    const mo = day.getUTCMonth() + 1;
    const d = day.getUTCDate();
    if (!cron.months.has(mo)) continue;
    const domHit = cron.days.has(d);
    const dowHit = cron.weekdays.has(day.getUTCDay());
    if (cron.dayOr ? !domHit && !dowHit : !domHit || !dowHit) continue;
    for (const h of cron.hours) {
      if (k === 0 && h < start.h) continue;
      for (const mi of cron.minutes) {
        if (k === 0 && h === start.h && mi < start.mi) continue;
        const at = wallToMs({ y, mo, d, h, mi }, timeZone);
        if (at > afterMs) return at;
      }
    }
  }
  return null;
}

/** Occurrences strictly after `fromMs` and at or before `toMs`, counted up to `cap`. */
export function countRunsBetween(
  schedule: PromptSchedule,
  timeZone: string,
  fromMs: number,
  toMs: number,
  cap = 100,
): number {
  let n = 0;
  let at = nextRunAfter(schedule, timeZone, fromMs);
  while (at !== null && at <= toMs && n < cap) {
    n += 1;
    at = nextRunAfter(schedule, timeZone, at);
  }
  return n;
}

/* ----------------------------------------------------------------- presets */

/** The Schedule dialog's recurring presets. `weekly` carries a weekday, 0 = Sunday. */
export type SchedulePreset =
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; hour: number; minute: number; weekday: number };

export function presetCron(preset: SchedulePreset): string {
  const time = `${preset.minute} ${preset.hour}`;
  if (preset.kind === "daily") return `${time} * * *`;
  if (preset.kind === "weekdays") return `${time} * * 1-5`;
  return `${time} * * ${preset.weekday}`;
}

/** The preset a cron expression spells, or null for any other expression. */
export function cronPreset(expr: string): SchedulePreset | null {
  const m = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|[0-6])$/.exec(expr.trim().replace(/\s+/g, " "));
  if (m === null) return null;
  const minute = Number(m[1]);
  const hour = Number(m[2]);
  if (minute > 59 || hour > 23) return null;
  if (m[3] === "*") return { kind: "daily", hour, minute };
  if (m[3] === "1-5") return { kind: "weekdays", hour, minute };
  return { kind: "weekly", hour, minute, weekday: Number(m[3]) };
}

/* -------------------------------------------------------------- validation */

function isSchedule(value: unknown): value is PromptSchedule {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (v.kind === "once") return typeof v.atMs === "number" && Number.isFinite(v.atMs) && Object.keys(v).length === 2;
  if (v.kind === "cron") return typeof v.expr === "string" && isValidCron(v.expr) && Object.keys(v).length === 2;
  return false;
}

function isNotice(value: unknown): value is ScheduledPromptNotice {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return (
    (v.kind === "skipped" || v.kind === "late" || v.kind === "failed") &&
    finite(v.atMs) &&
    finite(v.dueAtMs) &&
    finite(v.missed) &&
    (v.error === null || typeof v.error === "string")
  );
}

export function isScheduledPrompt(value: unknown): value is ScheduledPrompt {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  const finite = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n);
  return (
    typeof v.id === "string" &&
    v.id !== "" &&
    typeof v.text === "string" &&
    isSchedule(v.schedule) &&
    typeof v.timeZone === "string" &&
    isValidTimeZone(v.timeZone) &&
    finite(v.createdAtMs) &&
    (v.nextRunAtMs === null || finite(v.nextRunAtMs)) &&
    (v.lastRunAtMs === null || finite(v.lastRunAtMs)) &&
    Array.isArray(v.notices) &&
    v.notices.every(isNotice)
  );
}

/** Validates a Schedule request off the wire; throws with the reason. */
export function parseScheduledPromptRequest(value: unknown): ScheduledPromptRequest {
  if (value === null || typeof value !== "object") throw new Error("not an object");
  const v = value as Record<string, unknown>;
  for (const key of Object.keys(v)) {
    if (key !== "text" && key !== "schedule" && key !== "timeZone") throw new Error(`unknown field ${key}`);
  }
  if (typeof v.text !== "string" || v.text.trim() === "") throw new Error("the prompt is empty");
  if (v.text.length > SCHEDULED_PROMPT_TEXT_MAX) throw new Error(`the prompt is over ${SCHEDULED_PROMPT_TEXT_MAX} characters`);
  if (!isSchedule(v.schedule)) throw new Error("the schedule is not a valid time or cron expression");
  if (typeof v.timeZone !== "string" || !isValidTimeZone(v.timeZone)) throw new Error("unknown time zone");
  return { text: v.text, schedule: v.schedule, timeZone: v.timeZone };
}
