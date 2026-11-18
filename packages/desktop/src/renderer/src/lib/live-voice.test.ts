import { describe, expect, it } from "vitest";
import { supportsNativeLive } from "./live-voice";

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
