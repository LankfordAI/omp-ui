import type { ProposedPlan, SessionSummary } from "@omp-ui/core/types";

/**
 * The session's proposed plans, newest first (ADR-0033). An older remote
 * host's summary has no `proposedPlans`: its live gate alone stands in, so the
 * pane never loses the plan the agent is blocked on.
 */
export function proposedPlansFor(record: SessionSummary | undefined): readonly ProposedPlan[] {
  if (record === undefined) return [];
  if (Array.isArray(record.proposedPlans)) return record.proposedPlans;
  const gate = record.pendingPlan;
  return gate == null ? [] : [{ key: gate.planFilePath, title: gate.title, status: "pending" }];
}

/** A pending plan with no gate behind it: its process ended without a verdict. */
export function isInterruptedPlan(
  plan: ProposedPlan,
  record: SessionSummary | undefined,
  reviewPath: string | undefined,
): boolean {
  return plan.status === "pending" && plan.key !== reviewPath && record?.pendingPlan?.planFilePath !== plan.key;
}

/** Plans awaiting the user — live or interrupted — for the rail badge. */
export function pendingPlanCount(record: SessionSummary | undefined, reviewPath: string | undefined): number {
  const keys = new Set(proposedPlansFor(record).filter((p) => p.status === "pending").map((p) => p.key));
  if (reviewPath !== undefined) keys.add(reviewPath);
  return keys.size;
}
