/**
 * Timed snooze presets and the deadline label (issue #979). Every preset is a
 * local wall-clock time; main stores and enforces the resulting epoch ms.
 */

/** Hour of day the evening and morning presets land on. */
const EVENING_HOUR = 18;
const MORNING_HOUR = 9;

export type SnoozePreset = "hour" | "evening" | "morning" | "nextWeek";

function at(base: Date, dayOffset: number, hour: number): number {
  const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + dayOffset, hour, 0, 0, 0);
  return d.getTime();
}

/**
 * The deadline each preset offers at `now`, in menu order. "This evening"
 * (today 18:00) is absent once the evening has begun; "Next week" is the
 * coming Monday 09:00, a full week out when today is Monday.
 */
export function snoozePresets(now: Date): { preset: SnoozePreset; untilMs: number }[] {
  const out: { preset: SnoozePreset; untilMs: number }[] = [{ preset: "hour", untilMs: now.getTime() + 3_600_000 }];
  if (now.getHours() < EVENING_HOUR) out.push({ preset: "evening", untilMs: at(now, 0, EVENING_HOUR) });
  out.push({ preset: "morning", untilMs: at(now, 1, MORNING_HOUR) });
  // getDay(): 0 Sunday … 6 Saturday; days until the next Monday, 7 on a Monday.
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  out.push({ preset: "nextWeek", untilMs: at(now, toMonday, MORNING_HOUR) });
  return out;
}

/**
 * The row's "until …" label: weekday and 24-hour time inside the coming
 * week ("Tue 09:00"), month and day beyond it ("Nov 12 09:00").
 */
export function formatSnoozeUntil(untilMs: number, now: Date, locale: string): string {
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(untilMs);
  const withinWeek = untilMs - now.getTime() < 6 * 86_400_000;
  const day = new Intl.DateTimeFormat(
    locale,
    withinWeek ? { weekday: "short" } : { month: "short", day: "numeric" },
  ).format(untilMs);
  return `${day} ${time}`;
}

/** `<input type="datetime-local">` value for an epoch-ms instant, in local time. */
export function toDateTimeLocal(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Epoch ms of a datetime-local value (a local wall-clock time), or null when blank or invalid. */
export function fromDateTimeLocal(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (m === null) return null;
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const ms = new Date(y, mo - 1, d, h, mi, 0, 0).getTime();
  return Number.isFinite(ms) ? ms : null;
}
