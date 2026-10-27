import { describe, expect, it } from "vitest";
import { ASK_AND_REMEMBER_MIN_OMP, supportsAskAndRemember } from "./ask-and-remember";

describe("supportsAskAndRemember (issue #950)", () => {
  it("admits omp at and above 18.12.3", () => {
    expect(ASK_AND_REMEMBER_MIN_OMP).toBe("18.12.3");
    expect(supportsAskAndRemember("18.12.3")).toBe(true);
    expect(supportsAskAndRemember("19.0.0")).toBe(true);
  });

  it("rejects older omp and an unknown version", () => {
    expect(supportsAskAndRemember("18.12.2")).toBe(false);
    expect(supportsAskAndRemember(null)).toBe(false);
  });
});
