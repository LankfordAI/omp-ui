// @vitest-environment jsdom
// Work-park leaf-module tests (issue #815; #826 precedence rules).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  armLiveProgressTimer,
  claimLiveSwitch,
  clearLiveWorkTimers,
  clearLiveWorkWindowTimers,
  disposeLiveWorkPark,
  finishLiveSwitch,
  liveVoiceGeneration,
  resetLiveWorkParkForTests,
  type LiveSwitchRequest,
} from "./live-work-park";

const TAB = "tab-1";

beforeEach(() => {
  vi.useFakeTimers();
  resetLiveWorkParkForTests();
});
afterEach(() => {
  vi.useRealTimers();
  resetLiveWorkParkForTests();
});

describe("progress cadence timer slot (#826)", () => {
  it("the latest arm replaces the pending tick", () => {
    const fired: string[] = [];
    armLiveProgressTimer(TAB, 60_000, () => fired.push("first"));
    armLiveProgressTimer(TAB, 120_000, () => fired.push("second"));
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(["second"]);
  });

  it("clearLiveWorkTimers drops the cadence; the window-only clear keeps it", () => {
    const fired: string[] = [];
    armLiveProgressTimer(TAB, 60_000, () => fired.push("cadence"));
    clearLiveWorkWindowTimers(TAB);
    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(["cadence"]);
    armLiveProgressTimer(TAB, 60_000, () => fired.push("gone"));
    clearLiveWorkTimers(TAB);
    vi.advanceTimersByTime(120_000);
    expect(fired).toEqual(["cadence"]);
  });

  it("dispose tears the cadence down with the runtime", () => {
    const fired: string[] = [];
    armLiveProgressTimer(TAB, 60_000, () => fired.push("never"));
    disposeLiveWorkPark(TAB);
    vi.advanceTimersByTime(120_000);
    expect(fired).toEqual([]);
  });
});

describe("claimLiveSwitch progress precedence (#826)", () => {
  const runtime = {};
  const park: LiveSwitchRequest = { mode: "park" };
  const wake: LiveSwitchRequest = { mode: "wake" };
  const report: LiveSwitchRequest = { mode: "wake", progress: true };
  it("a progress wake coalesces silently behind a queued wake", () => {
    const entry = claimLiveSwitch(TAB, wake, runtime);
    if (entry === "coalesced") throw new Error("fresh claim expected");
    expect(claimLiveSwitch(TAB, report, runtime)).toBe("coalesced");
    expect(entry.again).toBeUndefined();
    expect(liveVoiceGeneration(TAB)).toBe(0);
  });

  it("a progress wake also coalesces behind a wake queued behind a park", () => {
    claimLiveSwitch(TAB, park, runtime);
    // The final answer queues behind the running park, bumping generation.
    claimLiveSwitch(TAB, wake, runtime);
    const gen = liveVoiceGeneration(TAB);
    expect(gen).toBe(1);
    expect(claimLiveSwitch(TAB, report, runtime)).toBe("coalesced");
    expect(liveVoiceGeneration(TAB)).toBe(gen);
  });
  it("a final wake replaces a queued report and bumps the generation", () => {
    const entry = claimLiveSwitch(TAB, report, runtime);
    if (entry === "coalesced") throw new Error("fresh claim expected");
    expect(liveVoiceGeneration(TAB)).toBe(0);
    expect(claimLiveSwitch(TAB, wake, runtime)).toBe("coalesced");
    expect(liveVoiceGeneration(TAB)).toBe(1);
    expect(entry.again).toEqual(wake);
  });

  it("a progress wake behind a running park does not bump", () => {
    claimLiveSwitch(TAB, park, runtime);
    expect(claimLiveSwitch(TAB, report, runtime)).toBe("coalesced");
    expect(liveVoiceGeneration(TAB)).toBe(0);
  });

  it("the runner adopts the replaced answer wake at the bumped generation", () => {
    const entry = claimLiveSwitch(TAB, report, runtime);
    if (entry === "coalesced") throw new Error("fresh claim expected");
    claimLiveSwitch(TAB, wake, runtime);
    const next = finishLiveSwitch(TAB, entry);
    expect(next).not.toBeNull();
    expect(next!.request).toEqual(wake);
    expect(next!.generation).toBe(liveVoiceGeneration(TAB));
  });
});
