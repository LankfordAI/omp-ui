import { describe, expect, it } from "vitest";
import {
  countRunsBetween,
  cronPreset,
  isScheduledPrompt,
  nextRunAfter,
  parseScheduledPromptRequest,
  presetCron,
  type PromptSchedule,
} from "./scheduled-prompt";

const cron = (expr: string): PromptSchedule => ({ kind: "cron", expr });
const iso = (ms: number | null): string | null => (ms === null ? null : new Date(ms).toISOString());

describe("nextRunAfter (issue #987)", () => {
  it("reads a daily time in the schedule's zone, not UTC", () => {
    // 2026-10-30 12:00 UTC is 08:00 in New York (EDT, UTC-4).
    const after = Date.UTC(2026, 9, 30, 12, 0);
    expect(iso(nextRunAfter(cron("30 9 * * *"), "America/New_York", after))).toBe("2026-10-30T13:30:00.000Z");
    expect(iso(nextRunAfter(cron("30 9 * * *"), "Asia/Seoul", after))).toBe("2026-10-31T00:30:00.000Z");
  });

  it("is strictly after the given instant, so a fire never repeats its own occurrence", () => {
    const at = Date.UTC(2026, 9, 30, 13, 30);
    expect(iso(nextRunAfter(cron("30 9 * * *"), "America/New_York", at))).toBe("2026-10-31T13:30:00.000Z");
  });

  it("keeps the wall-clock time across a DST change", () => {
    // New York leaves DST on 2026-11-01: 09:00 is 13:00 UTC before, 14:00 UTC after.
    const sat = Date.UTC(2026, 9, 31, 14, 0);
    expect(iso(nextRunAfter(cron("0 9 * * *"), "America/New_York", sat))).toBe("2026-11-01T14:00:00.000Z");
  });

  it("fires a wall time a spring-forward gap skips just after the gap", () => {
    // 2027-03-14 02:30 does not exist in New York; 03:00 EDT is 07:00 UTC.
    const before = Date.UTC(2027, 2, 14, 5, 0);
    expect(iso(nextRunAfter(cron("30 2 * * *"), "America/New_York", before))).toBe("2027-03-14T07:30:00.000Z");
  });

  it("skips weekends for the weekdays preset and fires either restricted day field (Vixie OR)", () => {
    const fri = Date.UTC(2026, 9, 30, 18, 0); // Friday, after 09:00 UTC
    expect(iso(nextRunAfter(cron(presetCron({ kind: "weekdays", hour: 9, minute: 0 })), "UTC", fri))).toBe(
      "2026-11-02T09:00:00.000Z",
    );
    // The 1st of the month or any Monday.
    expect(iso(nextRunAfter(cron("0 9 1 * mon"), "UTC", fri))).toBe("2026-11-01T09:00:00.000Z");
  });

  it("returns null for a past one-shot and for a cron date that never comes", () => {
    expect(nextRunAfter({ kind: "once", atMs: 1000 }, "UTC", 2000)).toBeNull();
    expect(nextRunAfter(cron("0 0 31 2 *"), "UTC", 0)).toBeNull();
  });
});

describe("countRunsBetween", () => {
  it("counts the occurrences a closed app missed", () => {
    const from = Date.UTC(2026, 9, 26, 10, 0);
    const to = Date.UTC(2026, 9, 30, 10, 0);
    expect(countRunsBetween(cron("0 9 * * *"), "UTC", from, to)).toBe(4);
  });
});

describe("presets", () => {
  it("round-trips daily, weekdays, and weekly and rejects anything else", () => {
    for (const preset of [
      { kind: "daily", hour: 7, minute: 5 },
      { kind: "weekdays", hour: 18, minute: 0 },
      { kind: "weekly", hour: 9, minute: 30, weekday: 1 },
    ] as const) {
      expect(cronPreset(presetCron(preset))).toEqual(preset);
    }
    expect(cronPreset("*/15 * * * *")).toBeNull();
  });
});

describe("request and record validation", () => {
  it("rejects an empty prompt, a bad cron, an unknown zone, and stray fields", () => {
    const ok = { text: "audit deps", schedule: cron("0 3 * * *"), timeZone: "UTC" };
    expect(parseScheduledPromptRequest(ok)).toEqual(ok);
    expect(() => parseScheduledPromptRequest({ ...ok, text: "  " })).toThrow(/empty/);
    expect(() => parseScheduledPromptRequest({ ...ok, schedule: cron("61 * * * *") })).toThrow(/schedule/);
    expect(() => parseScheduledPromptRequest({ ...ok, timeZone: "Mars/Base" })).toThrow(/zone/);
    expect(() => parseScheduledPromptRequest({ ...ok, extra: 1 })).toThrow(/extra/);
  });

  it("refuses a record whose schedule no longer parses", () => {
    const record = {
      id: "s1",
      text: "x",
      schedule: cron("0 9 * * *"),
      timeZone: "UTC",
      createdAtMs: 1,
      nextRunAtMs: 2,
      lastRunAtMs: null,
      notices: [],
    };
    expect(isScheduledPrompt(record)).toBe(true);
    expect(isScheduledPrompt({ ...record, schedule: cron("bogus") })).toBe(false);
  });
});
