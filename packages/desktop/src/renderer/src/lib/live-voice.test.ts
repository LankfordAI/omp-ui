import { describe, expect, it } from "vitest";
import { NATIVE_LIVE_MIN_OMP, supportsNativeLive } from "./live-voice";

describe("supportsNativeLive (issue #778)", () => {
  it("admits omp at and above 18.5.1", () => {
    expect(NATIVE_LIVE_MIN_OMP).toBe("18.5.1");
    expect(supportsNativeLive("18.5.1")).toBe(true);
    expect(supportsNativeLive("18.7.0")).toBe(true);
    expect(supportsNativeLive("19.0.0")).toBe(true);
    expect(supportsNativeLive("v18.5.1")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsNativeLive("18.5.0")).toBe(false);
    expect(supportsNativeLive("18.4.9")).toBe(false);
    expect(supportsNativeLive("17.9.9")).toBe(false);
    expect(supportsNativeLive(null)).toBe(false);
    expect(supportsNativeLive("garbage")).toBe(false);
    expect(supportsNativeLive("")).toBe(false);
  });
});
