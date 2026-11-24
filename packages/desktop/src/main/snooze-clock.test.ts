import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OwnedSessionRecord } from "@omp-ui/core";
import { SnoozeClock } from "./snooze-clock";

function snoozed(tabId: string, untilMs: number | null): OwnedSessionRecord {
  return { tabId, snoozed: true, snoozedUntilMs: untilMs, reminderAtMs: null } as OwnedSessionRecord;
}

function setup(sessions: OwnedSessionRecord[]) {
  const cleared: string[] = [];
  const wakes: string[][] = [];
  let broadcasts = 0;
  const clock = new SnoozeClock({
    sessions: () => sessions,
    updateSession: (tabId, patch) => {
      cleared.push(tabId);
      const s = sessions.find((r) => r.tabId === tabId);
      if (s !== undefined) {
        s.snoozed = patch.snoozed;
        s.snoozedUntilMs = patch.snoozedUntilMs;
        s.reminderAtMs = patch.reminderAtMs;
      }
    },
    broadcast: () => {
      broadcasts += 1;
    },
    onWake: (tabIds) => wakes.push([...tabIds]),
  });
  return { clock, sessions, cleared, wakes, broadcastCount: () => broadcasts };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("SnoozeClock wake notification", () => {
  it("stays silent on the startup catch-up: elapsed deadlines clear without waking", () => {
    const now = Date.now();
    const h = setup([snoozed("a", now - 1000), snoozed("b", now - 500)]);
    h.clock.sync();
    expect(h.cleared).toEqual(["a", "b"]);
    expect(h.broadcastCount()).toBe(1);
    expect(h.wakes).toEqual([]);
  });

  it("stays silent on a write-time sync whose deadline is already past", () => {
    const now = Date.now();
    const h = setup([snoozed("a", now)]);
    h.clock.sync(); // startup, silent
    // A later write sync finds the same row (already cleared) — nothing to do.
    h.clock.sync();
    expect(h.wakes).toEqual([]);
  });

  it("notifies once and stamps reminderAtMs when a live timer's deadline passes", () => {
    const now = Date.now();
    const h = setup([snoozed("a", now + 10_000)]);
    h.clock.sync();
    expect(h.wakes).toEqual([]);

    vi.advanceTimersByTime(10_001);
    expect(h.cleared).toEqual(["a"]);
    expect(h.wakes).toEqual([["a"]]);
    expect(h.sessions[0]!.reminderAtMs).toBe(now + 10_000);
  });
  it("coalesces a simultaneous multi-wake into one callback", () => {
    const now = Date.now();
    const h = setup([snoozed("a", now + 10_000), snoozed("b", now + 10_000), snoozed("c", now + 40_000)]);
    h.clock.sync();
    vi.advanceTimersByTime(10_001);
    expect(h.wakes).toEqual([["a", "b"]]);

    // MAX_WAIT_MS re-checks run silently; the wake fires once the wall deadline passes.
    vi.advanceTimersByTime(30_001);
    expect(h.wakes).toEqual([["a", "b"], ["c"]]);
  });

  it("re-notifies on a later live wake after a silent catch-up cleared older rows", () => {
    const now = Date.now();
    // One row already overdue at startup (silent), one live deadline.
    const h = setup([snoozed("old", now - 1), snoozed("live", now + 5_000)]);
    h.clock.sync();
    expect(h.wakes).toEqual([]);

    vi.advanceTimersByTime(5_001);
    expect(h.wakes).toEqual([["live"]]);
  });

  it("dispose stops the timer and the wake", () => {
    const now = Date.now();
    const h = setup([snoozed("a", now + 5_000)]);
    h.clock.sync();
    h.clock.dispose();
    vi.advanceTimersByTime(6_000);
    expect(h.wakes).toEqual([]);
    expect(h.cleared).toEqual([]);
  });
});
