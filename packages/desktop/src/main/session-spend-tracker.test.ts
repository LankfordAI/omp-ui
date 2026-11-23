import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SESSION_SPEND_STATUS_KEY,
  emptySpendTotals,
  type RpcFrame,
  type SessionSpendSnapshot,
  type SpendTotals,
} from "@omp-ui/core";
import { SessionSpendTracker } from "./session-spend-tracker";

function spendFrame(snapshot: SessionSpendSnapshot): RpcFrame {
  return {
    type: "extension_ui_request",
    id: `spend-${snapshot.revision}`,
    method: "setStatus",
    statusKey: SESSION_SPEND_STATUS_KEY,
    statusText: JSON.stringify(snapshot),
  };
}

function makeTotals(cost: number, totalTokens = 100): SpendTotals {
  return {
    ...emptySpendTotals(),
    cost,
    totalTokens,
    requests: cost > 0 ? 1 : 0,
  };
}

function makeSnapshot(overrides: Partial<SessionSpendSnapshot> = {}): SessionSpendSnapshot {
  const total = overrides.total ?? makeTotals(0.25, 100);
  return {
    version: 1,
    processKey: "proc-1",
    revision: 1,
    available: true,
    unavailable: null,
    sessionFile: "/s/root.jsonl",
    main: total,
    subagents: emptySpendTotals(),
    total,
    transcripts: 0,
    cacheWarm: emptySpendTotals(),
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionSpendTracker", () => {
  it("adopts monotonic revisions, ignores older revisions, and hands off across processKeys", () => {
    const broadcast = vi.fn(async () => {});
    let now = 1_000;
    const tracker = new SessionSpendTracker({ broadcast, throttleMs: 2_000, now: () => now });

    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 2, total: makeTotals(0.2, 100) })));
    expect(tracker.snapshot("tab-1")?.total.cost).toBe(0.2);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Older revision from same process is dropped.
    now += 5_000;
    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 1, total: makeTotals(0.1, 50) })));
    expect(tracker.snapshot("tab-1")?.total.cost).toBe(0.2);
    expect(broadcast).toHaveBeenCalledTimes(1);

    // New processKey takes ownership; retired processKey is rejected.
    now += 5_000;
    tracker.onFrame(
      "tab-1",
      spendFrame(makeSnapshot({ processKey: "proc-2", revision: 1, total: makeTotals(0.5, 250) })),
    );
    expect(tracker.snapshot("tab-1")?.processKey).toBe("proc-2");
    expect(tracker.snapshot("tab-1")?.total.cost).toBe(0.5);
    expect(broadcast).toHaveBeenCalledTimes(2);

    now += 5_000;
    tracker.onFrame(
      "tab-1",
      spendFrame(makeSnapshot({ processKey: "proc-1", revision: 99, total: makeTotals(9.9, 999) })),
    );
    expect(tracker.snapshot("tab-1")?.processKey).toBe("proc-2");
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it("suppresses redundant broadcasts when force-republish reports unchanged totals", () => {
    const broadcast = vi.fn(async () => {});
    let now = 1_000;
    const tracker = new SessionSpendTracker({ broadcast, throttleMs: 2_000, now: () => now });

    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 1, total: makeTotals(0.25, 100) })));
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Revision bumped (e.g. renderer opened tab and ran /omp-ui-session-spend), totals identical.
    now += 5_000;
    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 2, total: makeTotals(0.25, 100) })));
    expect(tracker.snapshot("tab-1")?.revision).toBe(2);
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("throttles rapid live spend updates per tab with a trailing-edge broadcast", () => {
    vi.useFakeTimers();
    const broadcast = vi.fn(async () => {});
    const tracker = new SessionSpendTracker({ broadcast, throttleMs: 2_000, now: () => Date.now() });

    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 1, total: makeTotals(0.1, 10) })));
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Rapid updates within the throttle window coalesce to one trailing broadcast.
    vi.advanceTimersByTime(500);
    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 2, total: makeTotals(0.2, 20) })));
    vi.advanceTimersByTime(500);
    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 3, total: makeTotals(0.3, 30) })));
    expect(broadcast).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(broadcast).toHaveBeenCalledTimes(2);
    expect(tracker.snapshot("tab-1")?.total.cost).toBe(0.3);

    tracker.disposeAll();
  });

  it("clears live snapshot and triggers one broadcast on exit so summarize falls back to disk", () => {
    vi.useFakeTimers();
    const broadcast = vi.fn(async () => {});
    const tracker = new SessionSpendTracker({ broadcast, throttleMs: 2_000, now: () => Date.now() });

    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 1, total: makeTotals(0.4, 80) })));
    expect(broadcast).toHaveBeenCalledTimes(1);

    // Queue a pending trailing update, then exit before it fires.
    vi.advanceTimersByTime(200);
    tracker.onFrame("tab-1", spendFrame(makeSnapshot({ revision: 2, total: makeTotals(0.6, 120) })));
    tracker.onExit("tab-1");
    expect(tracker.snapshot("tab-1")).toBeUndefined();
    expect(broadcast).toHaveBeenCalledTimes(2);

    // Pending timer must have been cancelled on exit.
    vi.advanceTimersByTime(5_000);
    expect(broadcast).toHaveBeenCalledTimes(2);
  });
});
