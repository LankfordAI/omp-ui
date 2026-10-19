import { describe, expect, it } from "vitest";
import { NARRATION_MIN_OMP, supportsNarration } from "./narration";

describe("supportsNarration (issue #884)", () => {
  it("admits omp at and above 18.12.0", () => {
    expect(NARRATION_MIN_OMP).toBe("18.12.0");
    expect(supportsNarration("18.12.0")).toBe(true);
    expect(supportsNarration("18.12.2")).toBe(true);
    expect(supportsNarration("19.0.0")).toBe(true);
    expect(supportsNarration("v18.12.0")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsNarration("18.11.3")).toBe(false);
    expect(supportsNarration(null)).toBe(false);
    expect(supportsNarration("garbage")).toBe(false);
    expect(supportsNarration("")).toBe(false);
  });
});
