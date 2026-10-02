// One rendering of omp's goal state (ADR-0046), shared by the `/goal` row and
// the HUD chip's popover so the two cannot drift.
import type { GoalState } from "@omp-ui/core/goal";
import { formatDuration } from "./duration";
import { exactNum } from "./format";
import { t } from "./i18n";

/** Objective, status, token usage, and elapsed time — four lines. */
export function goalDetails(state: GoalState): string {
  const { goal } = state;
  const tokens =
    goal.tokenBudget === null
      ? t("composer.goal.detailTokensUnbounded", { used: exactNum(goal.tokensUsed) })
      : t("composer.goal.detailTokens", {
          used: exactNum(goal.tokensUsed),
          budget: exactNum(goal.tokenBudget),
          remaining: exactNum(Math.max(0, goal.tokenBudget - goal.tokensUsed)),
        });
  return [
    t("composer.goal.detailObjective", { objective: goal.objective }),
    t("composer.goal.detailStatus", { status: goal.status }),
    tokens,
    t("composer.goal.detailElapsed", { duration: formatDuration(goal.timeUsedSeconds * 1000) }),
  ].join("\n");
}
