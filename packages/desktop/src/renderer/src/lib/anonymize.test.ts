import { describe, expect, it } from "vitest";
import { ANONYMIZE_MIN_OMP, supportsAnonymize } from "./anonymize";

describe("supportsAnonymize (issue #834)", () => {
  it("admits omp at and above 18.8.8", () => {
    expect(ANONYMIZE_MIN_OMP).toBe("18.8.8");
    expect(supportsAnonymize("18.8.8")).toBe(true);
    expect(supportsAnonymize("18.8.9")).toBe(true);
    expect(supportsAnonymize("19.0.0")).toBe(true);
    expect(supportsAnonymize("v18.8.8")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsAnonymize("18.8.7")).toBe(false);
    expect(supportsAnonymize("18.7.9")).toBe(false);
    expect(supportsAnonymize(null)).toBe(false);
    expect(supportsAnonymize("garbage")).toBe(false);
    expect(supportsAnonymize("")).toBe(false);
  });
});
