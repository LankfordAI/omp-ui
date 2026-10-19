import { describe, expect, it } from "vitest";
import { SEANCE_MIN_OMP, supportsSeance } from "./seance";

describe("supportsSeance (issue #885)", () => {
  it("admits omp at and above 18.11.3", () => {
    expect(SEANCE_MIN_OMP).toBe("18.11.3");
    expect(supportsSeance("18.11.3")).toBe(true);
    expect(supportsSeance("18.11.4")).toBe(true);
    expect(supportsSeance("18.12.2")).toBe(true);
    expect(supportsSeance("19.0.0")).toBe(true);
    expect(supportsSeance("v18.11.3")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsSeance("18.11.2")).toBe(false);
    expect(supportsSeance("18.10.9")).toBe(false);
    expect(supportsSeance(null)).toBe(false);
    expect(supportsSeance("garbage")).toBe(false);
    expect(supportsSeance("")).toBe(false);
  });
});
