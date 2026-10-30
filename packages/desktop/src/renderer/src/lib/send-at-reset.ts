import { isUsageLimitError, usageResetMs } from "@omp-ui/core/held-prompt";
import type { RpcTabState } from "../store/types";

/**
 * The reset the composer's Send at reset offers (issue #986), or null when
 * nothing says the session is limited: an exhausted rate window from the
 * limits bridge, or the last turn's failure on omp's usage-limit class with
 * the binding window still ahead.
 */
export function sendAtResetMs(tab: RpcTabState | undefined, now: number): number | null {
  if (tab === undefined) return null;
  const failedOnLimit =
    tab.lastTurn !== undefined && isUsageLimitError(tab.lastTurn.stopReason, tab.lastTurn.errorId);
  return usageResetMs(tab.limits, failedOnLimit, now);
}
