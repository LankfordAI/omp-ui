import { describe, expect, it } from "vitest";
import type { OmpSettingEntry } from "./types";
import {
  compactionSettingsFromEntries,
  compactionThresholdTokens,
} from "./compaction-threshold";

describe("compactionThresholdTokens", () => {
  it("defaults to window − max(15% of window, 16384) with no settings", () => {
    expect(compactionThresholdTokens(256000, {})).toBe(217600); // 85.0%
    expect(compactionThresholdTokens(128000, {})).toBe(108800); // 85.0%
    // 1M windows are 15%-reserve bound, not 16K-reserve bound.
    expect(compactionThresholdTokens(1000000, {})).toBe(850000);
  });

  it("lets the 16K default reserve dominate small windows", () => {
    expect(compactionThresholdTokens(32768, {})).toBe(16384); // 50.0%
  });

  it("falls back to the 15% reserve when the defaulted 16K reserve is effectively impossible", () => {
    // 16K default >= window − 15% (16384 ≥ 13927) → proportional reserve.
    expect(compactionThresholdTokens(16384, {})).toBe(13927);
    // 16K default ≥ window → proportional reserve.
    expect(compactionThresholdTokens(10000, {})).toBe(8500);
  });

  it("returns null when no window is known", () => {
    expect(compactionThresholdTokens(0, {})).toBeNull();
    expect(compactionThresholdTokens(-1, {})).toBeNull();
    expect(compactionThresholdTokens(Number.NaN, {})).toBeNull();
  });

  it("honors an explicit thresholdPercent, clamped to 1–99", () => {
    expect(compactionThresholdTokens(256000, { thresholdPercent: 50 })).toBe(128000);
    expect(compactionThresholdTokens(256000, { thresholdPercent: 150 })).toBe(253440); // 99%
    expect(compactionThresholdTokens(256000, { thresholdPercent: 1 })).toBe(2560); // 1%
  });

  it("treats thresholdPercent ≤ 0 as omp's default (−1)", () => {
    expect(compactionThresholdTokens(256000, { thresholdPercent: 0 })).toBe(217600);
    expect(compactionThresholdTokens(256000, { thresholdPercent: -1 })).toBe(217600);
    expect(compactionThresholdTokens(256000, {})).toBe(217600);
  });

  it("lets fixed thresholdTokens win over the percent, clamped to the window", () => {
    expect(compactionThresholdTokens(256000, { thresholdTokens: 1000 })).toBe(1000);
    expect(
      compactionThresholdTokens(256000, { thresholdTokens: 500000, thresholdPercent: 50 }),
    ).toBe(255999); // clamped to window − 1
  });

  it("ignores omp's default −1 thresholdTokens", () => {
    expect(compactionThresholdTokens(256000, { thresholdTokens: -1 })).toBe(217600);
  });

  it("honors an explicit reserveTokens", () => {
    expect(compactionThresholdTokens(256000, { reserveTokens: 50000 })).toBe(206000);
    expect(compactionThresholdTokens(10000, { reserveTokens: 5000 })).toBe(5000);
    // Explicit-but-equal-default: provenance differs (no impossibility check
    // for a user-chosen reserve), but the reserve still exceeds the window.
    expect(compactionThresholdTokens(16384, { reserveTokens: 16384 })).toBe(13927);
  });
});

describe("compactionSettingsFromEntries", () => {
  const entry = (key: string, value: OmpSettingEntry["value"]): OmpSettingEntry => ({
    key,
    type: "number",
    description: "",
    value,
    options: null,
    layer: "default",
  });

  it("reads finite numeric values, including omp's sentinel −1", () => {
    expect(
      compactionSettingsFromEntries([
        entry("compaction.thresholdPercent", -1),
        entry("compaction.thresholdTokens", -1),
        entry("compaction.reserveTokens", 50000),
      ]),
    ).toEqual({ thresholdPercent: -1, thresholdTokens: -1, reserveTokens: 50000 });
  });

  it("maps absent entries to undefined so the formula applies omp defaults", () => {
    expect(compactionSettingsFromEntries([entry("compaction.thresholdPercent", -1)])).toEqual({
      thresholdPercent: -1,
      thresholdTokens: undefined,
      reserveTokens: undefined,
    });
  });

  it("treats value-less entries (omp's live output for reserveTokens) as unset", () => {
    expect(
      compactionSettingsFromEntries([
        entry("compaction.reserveTokens", undefined),
        entry("compaction.thresholdTokens", 1000),
      ]),
    ).toEqual({
      thresholdPercent: undefined,
      thresholdTokens: 1000,
      reserveTokens: undefined,
    });
  });

  it("treats non-finite values as unset", () => {
    expect(
      compactionSettingsFromEntries([
        entry("compaction.thresholdPercent", Number.NaN),
        entry("compaction.thresholdTokens", Number.POSITIVE_INFINITY),
      ]),
    ).toEqual({ thresholdPercent: undefined, thresholdTokens: undefined, reserveTokens: undefined });
  });

  it("ignores non-numeric values", () => {
    expect(
      compactionSettingsFromEntries([entry("compaction.thresholdPercent", "50")]),
    ).toEqual({ thresholdPercent: undefined, thresholdTokens: undefined, reserveTokens: undefined });
  });
});
