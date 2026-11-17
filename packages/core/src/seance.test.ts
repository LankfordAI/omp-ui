import { describe, expect, it } from "vitest";
import { SEANCE_MAX_OMP, SEANCE_MIN_OMP, seanceRemovedFromOmp, supportsSeance } from "./seance";

describe("supportsSeance (issue #885, window closed by #1189)", () => {
  it("admits omp inside the window and nothing above it", () => {
    expect(SEANCE_MIN_OMP).toBe("18.11.3");
    expect(SEANCE_MAX_OMP).toBe("18.20.3");
    expect(supportsSeance("18.11.3")).toBe(true);
    expect(supportsSeance("18.11.4")).toBe(true);
    expect(supportsSeance("18.12.2")).toBe(true);
    // The last harness that still ships the seance agent.
    expect(supportsSeance("18.20.2")).toBe(true);
    expect(supportsSeance("v18.20.2")).toBe(true);
  });

  it("rejects older omp, removed omp, and unknown versions", () => {
    expect(supportsSeance("18.11.2")).toBe(false);
    expect(supportsSeance("18.10.9")).toBe(false);
    // omp 18.20.3 removed the agent, `/seance`, and `sourceSession`.
    expect(supportsSeance("18.20.3")).toBe(false);
    expect(supportsSeance("18.21.0")).toBe(false);
    expect(supportsSeance("18.22.0")).toBe(false);
    expect(supportsSeance("19.0.0")).toBe(false);
    expect(supportsSeance(null)).toBe(false);
    expect(supportsSeance("garbage")).toBe(false);
    expect(supportsSeance("")).toBe(false);
  });
});

describe("seanceRemovedFromOmp (issue #1189)", () => {
  it("names only harnesses at or above the removal", () => {
    expect(seanceRemovedFromOmp("18.20.3")).toBe(true);
    expect(seanceRemovedFromOmp("18.22.0")).toBe(true);
    expect(seanceRemovedFromOmp("18.20.2")).toBe(false);
    expect(seanceRemovedFromOmp("18.11.2")).toBe(false);
    expect(seanceRemovedFromOmp(null)).toBe(false);
  });

  it("partitions versions: supported, pre-floor (updatable), removed (hiding)", () => {
    // An unsupported version has exactly one refusal reason: below the floor,
    // where updating unlocks the feature, or at/above the removal, where the
    // surfaces hide instead of pointing at an unreachable floor.
    const cases = [
      ["18.10.0", "pre-floor"],
      ["18.11.2", "pre-floor"],
      ["18.11.3", "supported"],
      ["18.20.2", "supported"],
      ["18.20.3", "removed"],
      ["18.22.0", "removed"],
    ] as const;
    for (const [version, expected] of cases) {
      expect([supportsSeance(version), seanceRemovedFromOmp(version)], version).toEqual(
        expected === "supported"
          ? [true, false]
          : expected === "removed"
            ? [false, true]
            : [false, false],
      );
    }
  });
});
