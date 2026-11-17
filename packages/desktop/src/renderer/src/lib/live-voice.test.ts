import { describe, expect, it } from "vitest";
import { speechSpeedBand, supportsNativeLive } from "./live-voice";

describe("supportsNativeLive (issue #778, ADR-0071)", () => {
  it("admits omp with live_connect: 18.14.0 and above", () => {
    expect(supportsNativeLive("18.14.0")).toBe(true);
    expect(supportsNativeLive("18.14.1")).toBe(true);
    expect(supportsNativeLive("19.0.0")).toBe(true);
    expect(supportsNativeLive("v18.14.0")).toBe(true);
  });

  it("rejects omp without live_connect and unknown versions", () => {
    expect(supportsNativeLive("18.13.3")).toBe(false);
    expect(supportsNativeLive("18.5.1")).toBe(false);
    expect(supportsNativeLive(null)).toBe(false);
    expect(supportsNativeLive("garbage")).toBe(false);
    expect(supportsNativeLive("")).toBe(false);
  });
});

describe("speechSpeedBand (issue #1198)", () => {
  it("narrows to the Phonon band on omp with the 18.21.0 clamp", () => {
    expect(speechSpeedBand("18.21.0")).toEqual({ min: 0.8, max: 1.3 });
    expect(speechSpeedBand("18.22.0")).toEqual({ min: 0.8, max: 1.3 });
    expect(speechSpeedBand("19.0.0")).toEqual({ min: 0.8, max: 1.3 });
  });

  it("keeps the pre-Phonon band below 18.21.0 and for unknown versions", () => {
    expect(speechSpeedBand("18.20.9")).toEqual({ min: 0.5, max: 2.5 });
    expect(speechSpeedBand("18.18.7")).toEqual({ min: 0.5, max: 2.5 });
    expect(speechSpeedBand(null)).toEqual({ min: 0.5, max: 2.5 });
    expect(speechSpeedBand("garbage")).toEqual({ min: 0.5, max: 2.5 });
  });
});
