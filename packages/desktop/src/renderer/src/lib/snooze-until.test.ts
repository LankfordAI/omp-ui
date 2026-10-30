import { describe, expect, it } from "vitest";
import { formatSnoozeUntil, fromDateTimeLocal, snoozePresets, toDateTimeLocal } from "./snooze-until";

const local = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi);

describe("snoozePresets (issue #979)", () => {
  it("offers this evening only before 18:00", () => {
    const afternoon = snoozePresets(local(2026, 10, 27, 14, 30));
    expect(afternoon.map((p) => p.preset)).toEqual(["hour", "evening", "morning", "nextWeek"]);
    expect(afternoon.find((p) => p.preset === "evening")!.untilMs).toBe(local(2026, 10, 27, 18).getTime());
    expect(snoozePresets(local(2026, 10, 27, 18, 0)).map((p) => p.preset)).toEqual(["hour", "morning", "nextWeek"]);
  });

  it("lands tomorrow morning at 09:00 across a month end", () => {
    const presets = snoozePresets(local(2026, 10, 31, 23, 50));
    expect(presets.find((p) => p.preset === "morning")!.untilMs).toBe(local(2026, 11, 1, 9).getTime());
  });

  it("lands next week on the coming Monday 09:00, a full week out from a Monday", () => {
    // 2026-10-27 is a Tuesday; 2026-11-02 a Monday; 2026-11-01 a Sunday.
    const nextWeek = (now: Date) => snoozePresets(now).find((p) => p.preset === "nextWeek")!.untilMs;
    expect(nextWeek(local(2026, 10, 27, 10))).toBe(local(2026, 11, 2, 9).getTime());
    expect(nextWeek(local(2026, 11, 1, 10))).toBe(local(2026, 11, 2, 9).getTime());
    expect(nextWeek(local(2026, 11, 2, 10))).toBe(local(2026, 11, 9, 9).getTime());
  });
});

describe("formatSnoozeUntil", () => {
  it("names the weekday within the week and the date beyond it", () => {
    const now = local(2026, 10, 27, 10);
    expect(formatSnoozeUntil(local(2026, 10, 28, 9).getTime(), now, "en-US")).toBe("Wed 09:00");
    expect(formatSnoozeUntil(local(2026, 11, 12, 9).getTime(), now, "en-US")).toBe("Nov 12 09:00");
  });
});

describe("datetime-local round trip", () => {
  it("reads back the same local minute and rejects malformed input", () => {
    const ms = local(2026, 11, 3, 7, 45).getTime();
    expect(toDateTimeLocal(ms)).toBe("2026-11-03T07:45");
    expect(fromDateTimeLocal("2026-11-03T07:45")).toBe(ms);
    expect(fromDateTimeLocal("")).toBeNull();
  });
});
