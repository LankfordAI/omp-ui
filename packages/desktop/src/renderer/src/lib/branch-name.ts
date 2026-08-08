/**
 * Mechanical branch-name fallback for the plan-execute flow (issue #25): the
 * plan's slug as a checkout-ready name. This is the degraded path for when
 * omp's small model suggests nothing — the same role generateTitleFromPrompt
 * plays for session titles.
 */
export function branchNameFromPlanPath(planFilePath: string): string {
  const file = planFilePath.split("/").pop() ?? "";
  return file
    .replace(/\.(?:md|html)$/i, "")
    .replace(/-plan$/, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
