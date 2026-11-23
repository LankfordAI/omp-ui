// One rendering of omp's goal state (ADR-0046), shared by the `/goal` row and
// the HUD chip's popover so the two cannot drift.
import type { GoalState } from "@omp-ui/core/goal";
import { formatDuration } from "./duration";
import { exactNum } from "./format";

/** Objective, status, token usage, and elapsed time — four lines. */
export function goalDetails(state: GoalState): string {
  const { goal } = state;
  const tokens =
    goal.tokenBudget === null
      ? `Tokens: ${exactNum(goal.tokensUsed)} used (no budget)`
      : `Tokens: ${exactNum(goal.tokensUsed)} of ${exactNum(goal.tokenBudget)} used, ${exactNum(Math.max(0, goal.tokenBudget - goal.tokensUsed))} remaining`;
  return [
    `Objective: ${goal.objective}`,
    `Status: ${goal.status}`,
    tokens,
    `Elapsed: ${formatDuration(goal.timeUsedSeconds * 1000)}`,
  ].join("\n");
}
