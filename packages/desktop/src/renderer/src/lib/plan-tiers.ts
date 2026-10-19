import { compareVersions } from "@omp-ui/core/semver";
import type { PlanReviewTier } from "@omp-ui/core/plan";
import type { ModelInfo } from "./rpc-types";

/** omp's plan review gained execution tiers in 18.10.4 (upstream #15552). */
export const PLAN_TIERS_MIN_OMP = "18.10.4";

/** Unknown version hides the feature: an older harness reports no tiers. */
export function supportsPlanTiers(ompVersion: string | null): boolean {
  return ompVersion !== null && compareVersions(ompVersion, PLAN_TIERS_MIN_OMP) >= 0;
}

/** Resolve a tier to the ModelInfo the dispatch rail takes. Prefer the live
 * catalog row (full name/capabilities); fall back to a minimal row so a tier
 * omp just reported still executes if the catalog raced. */
export function tierModelInfo(tier: PlanReviewTier, available: readonly ModelInfo[]): ModelInfo {
  return available.find(m => m.provider === tier.provider && m.id === tier.model)
    ?? { id: tier.model, name: tier.model, provider: tier.provider };
}
