import { describe, expect, it } from "vitest";
import type { PlanReviewTier } from "@omp-ui/core/plan";
import { PLAN_TIERS_MIN_OMP, supportsPlanTiers, tierModelInfo } from "./plan-tiers";
import type { ModelInfo } from "./rpc-types";

describe("supportsPlanTiers (issue #886)", () => {
  it("admits omp at and above 18.10.4", () => {
    expect(PLAN_TIERS_MIN_OMP).toBe("18.10.4");
    expect(supportsPlanTiers("18.10.4")).toBe(true);
    expect(supportsPlanTiers("18.10.5")).toBe(true);
    expect(supportsPlanTiers("18.12.2")).toBe(true);
    expect(supportsPlanTiers("19.0.0")).toBe(true);
  });

  it("rejects older omp and unknown versions", () => {
    expect(supportsPlanTiers("18.10.3")).toBe(false);
    expect(supportsPlanTiers("18.9.9")).toBe(false);
    expect(supportsPlanTiers(null)).toBe(false);
  });
});

describe("tierModelInfo (issue #886)", () => {
  const tier: PlanReviewTier = { role: "task", provider: "anthropic", model: "claude-opus-5" };
  const catalogRow: ModelInfo = {
    id: "claude-opus-5",
    name: "Opus 5",
    provider: "anthropic",
    reasoning: true,
    contextWindow: 200000,
  };

  it("prefers the live catalog row", () => {
    expect(tierModelInfo(tier, [catalogRow])).toBe(catalogRow);
  });

  it("falls back to a minimal row when the catalog raced", () => {
    expect(tierModelInfo(tier, [])).toEqual({
      id: "claude-opus-5",
      name: "claude-opus-5",
      provider: "anthropic",
    });
  });

  it("does not match a same-id row from another provider", () => {
    expect(tierModelInfo(tier, [{ id: "claude-opus-5", name: "Opus 5", provider: "openrouter" }])).toEqual({
      id: "claude-opus-5",
      name: "claude-opus-5",
      provider: "anthropic",
    });
  });
});
