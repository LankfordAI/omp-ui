import { describe, expect, it } from "vitest";
import type { OmpSettingEntry } from "./types";
import {
  compactionSettingsFromEntries,
  compactionThresholdTokens,
  matchModelCompactionThreshold,
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

  it("lets fixed thresholdTokens win over the percent, clamped by reserve at the window", () => {
    expect(compactionThresholdTokens(256000, { thresholdTokens: 1000 })).toBe(1000);
    expect(
      compactionThresholdTokens(256000, { thresholdTokens: 500000, thresholdPercent: 50 }),
    ).toBe(217600); // 18.8.8: ≥ window → window − reserve, not window − 1
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

  describe("modelThresholds (omp 18.8.8)", () => {
    const model = { provider: "anthropic", id: "claude-sonnet-4-5" };

    it("treats a plain-number match as a base window", () => {
      const settings = {
        modelThresholds: { "anthropic/claude-sonnet-4-5": { thresholdPercent: -1, thresholdTokens: 400000 } },
      };
      // 1M window: 400000 − max(0.15·400000, 16384) = 340000.
      expect(compactionThresholdTokens(1000000, settings, model)).toBe(340000);
      // Base above the window → the window path: 256000 − 38400 = 217600.
      expect(compactionThresholdTokens(256000, settings, model)).toBe(217600);
      // Base + global percent: percent applies to the scaled base.
      expect(compactionThresholdTokens(1000000, { ...settings, thresholdPercent: 50 }, model)).toBe(200000);
      // Below the ~109k crossover the 16384 default reserve dominates.
      expect(compactionThresholdTokens(128000, {
        modelThresholds: { "anthropic/claude-sonnet-4-5": { thresholdPercent: -1, thresholdTokens: 50000 } },
      }, model)).toBe(33616); // 50000 − 16384
    });

    it("keeps f-syntax entries exact triggers and clamps them by reserve at the window", () => {
      const settings = (value: { thresholdPercent: number; thresholdTokens: number; fixed?: boolean }) => ({
        modelThresholds: { "anthropic/claude-sonnet-4-5": value },
      });
      // "f250000" on a 200k window: ≥ window → 200000 − 30000 = 170000.
      expect(compactionThresholdTokens(200000, settings({ thresholdPercent: -1, thresholdTokens: 250000, fixed: true }), model)).toBe(170000);
      // "f100000" on 200k: below window → exact.
      expect(compactionThresholdTokens(200000, settings({ thresholdPercent: -1, thresholdTokens: 100000, fixed: true }), model)).toBe(100000);
      // "80%" of the window (no base scaling).
      expect(compactionThresholdTokens(256000, settings({ thresholdPercent: 80, thresholdTokens: -1 }), model)).toBe(204800);
    });

    it("resolves exact keys over prefixes and longest prefixes over shorter", () => {
      const thresholds = {
        "openrouter/*": { thresholdPercent: -1, thresholdTokens: 100000 },
        "openrouter/openai/*": { thresholdPercent: -1, thresholdTokens: 200000 },
        "openrouter/openai/gpt-4o": { thresholdPercent: -1, thresholdTokens: 50000 },
      };
      const gpt = { provider: "openrouter", id: "openai/gpt-4o" };
      expect(compactionThresholdTokens(1000000, { modelThresholds: thresholds }, gpt)).toBe(50000 - 16384);
      const other = { provider: "openrouter", id: "openai/gpt-4o-mini" };
      expect(compactionThresholdTokens(1000000, { modelThresholds: thresholds }, other)).toBe(200000 - 30000);
      const anthropic = { provider: "openrouter", id: "anthropic/claude-sonnet-4-5" };
      expect(compactionThresholdTokens(1000000, { modelThresholds: thresholds }, anthropic)).toBe(100000 - 16384);
    });

    it("falls back to the global path without a model or with the map disabled", () => {
      const settings = {
        modelThresholds: { "anthropic/claude-sonnet-4-5": { thresholdPercent: -1, thresholdTokens: 400000 } },
      };
      expect(compactionThresholdTokens(256000, settings, null)).toBe(217600);
      expect(compactionThresholdTokens(256000, { ...settings, modelThresholdsEnabled: false }, model)).toBe(217600);
    });

    it("matchModelCompactionThreshold skips malformed keys", () => {
      const thresholds = {
        "no-slash": { thresholdPercent: -1, thresholdTokens: 1 },
        "mid*star": { thresholdPercent: -1, thresholdTokens: 2 },
        "anthropic/*": { thresholdPercent: -1, thresholdTokens: 3 },
      };
      expect(matchModelCompactionThreshold(thresholds, model)).toEqual({ thresholdPercent: -1, thresholdTokens: 3 });
    });
  });
});

describe("compactionSettingsFromEntries", () => {
  const entry = (key: string, value: OmpSettingEntry["value"]): OmpSettingEntry => ({
    key,
    type: "number",
    description: "",
    value,
    globalValue: value,
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

  it("parses modelThresholds records and drops invalid values and keys", () => {
    const record = {
      "anthropic/claude-sonnet-4-5": 400000,
      "openai/gpt-4o": "f250000",
      "openrouter/*": "80%",
      "bad/openai/*": "not-a-threshold",
      "malformed-key": 400000,
    };
    const settings = compactionSettingsFromEntries([
      {
        key: "compaction.modelThresholds",
        type: "record",
        description: "",
        value: record,
        globalValue: record,
        options: null,
        layer: "default",
      },
    ]);
    expect(settings.modelThresholds).toEqual({
      "anthropic/claude-sonnet-4-5": { thresholdPercent: -1, thresholdTokens: 400000 },
      "openai/gpt-4o": { thresholdPercent: -1, thresholdTokens: 250000, fixed: true },
      "openrouter/*": { thresholdPercent: 80, thresholdTokens: -1 },
    });
  });

  it("round-trips modelThresholdsEnabled and leaves absent keys undefined", () => {
    const bool = (value: boolean): OmpSettingEntry => ({
      key: "compaction.modelThresholdsEnabled",
      type: "boolean",
      description: "",
      value,
      globalValue: value,
      options: null,
      layer: "default",
    });
    expect(compactionSettingsFromEntries([bool(true)]).modelThresholdsEnabled).toBe(true);
    expect(compactionSettingsFromEntries([bool(false)]).modelThresholdsEnabled).toBe(false);
    const settings = compactionSettingsFromEntries([entry("compaction.thresholdPercent", -1)]);
    expect(settings.modelThresholds).toBeUndefined();
    expect(settings.modelThresholdsEnabled).toBeUndefined();
  });
});
