import { addSpendTotals, emptySpendTotals, type SpendTotals } from "@omp-ui/core/session-spend";
import type { BackendState } from "@omp-ui/core/types";
import { NO_DISPATCH, resolveDispatchLinks, type DispatchLink } from "./dispatched-sessions";
import type { RpcTabState } from "../store/types";
export interface DispatchedSpendSummary {
  /** Number of resolved dispatched children (same as children.length). */
  count: number;
  /** Children whose spend is known (includes brand-new unmaterialized $0 children). */
  reported: number;
  /** Children whose spend is unknown (older remote host, unreachable remote, missing/unreadable). */
  missing: number;
  /** Sum of all reported children's whole-session totals (each child's main + subagents). */
  totals: SpendTotals;
}

/**
 * Aggregates whole-session spend across every agent-dispatched child of an
 * orchestrator session (ADR-0098, issue #1279).
 *
 * Resolution priority per child:
 * 1. Live renderer `rpc[childTabId]?.sessionSpend` when `available === true`
 *    (avoids up to 2s throttle lag if the child tab is also open).
 * 2. `SessionSummary.spend` when present and non-null (unopened live, settled,
 *    dormant, archived, or remote child).
 * 3. Newly dispatched unmaterialized child (`spend === null` and `sessionId === null`
 *    and `reachable`): counted as known $0 rather than missing.
 * 4. Otherwise (`spend === undefined` from older remote host, `!reachable`,
 *    `live === "missing"`, or unreadable persisted session): counted as `missing`.
 */
export function aggregateDispatchedSpend(
  children: readonly DispatchLink[],
  rpc: Readonly<Record<string, RpcTabState | undefined>>,
): DispatchedSpendSummary | null {
  if (children.length === 0) return null;
  const totals = emptySpendTotals();
  let reported = 0;
  let missing = 0;
  for (const link of children) {
    const childRpc = rpc[link.session.tabId]?.sessionSpend;
    if (childRpc?.available === true) {
      addSpendTotals(totals, childRpc.total);
      reported += 1;
      continue;
    }
    if (!link.reachable || link.session.live === "missing") {
      missing += 1;
      continue;
    }
    const summarySpend = link.session.spend;
    if (summarySpend !== undefined && summarySpend !== null) {
      addSpendTotals(totals, summarySpend);
      reported += 1;
    } else if (summarySpend === null && link.session.sessionId === null) {
      reported += 1;
    } else {
      missing += 1;
    }
  }
  return { count: children.length, reported, missing, totals };
}

/**
 * Computes `aggregateDispatchedSpend` for `tabId` from a store state snapshot.
 */
export function dispatchedSpendForTab(
  state: BackendState | null,
  rpc: Readonly<Record<string, RpcTabState | undefined>>,
  tabId: string,
): DispatchedSpendSummary | null {
  const children = state === null ? NO_DISPATCH.children : (resolveDispatchLinks(state).get(tabId)?.children ?? NO_DISPATCH.children);
  return aggregateDispatchedSpend(children, rpc);
}

/** Primitive equality key for narrow Zustand selectors over dispatched spend. */
export function dispatchedSpendFingerprint(summary: DispatchedSpendSummary | null): string {
  if (summary === null) return "";
  const t = summary.totals;
  return `${summary.count}:${summary.reported}:${summary.missing}:${t.cost}:${t.input}:${t.output}:${t.reasoning}:${t.cacheRead}:${t.cacheWrite}:${t.totalTokens}:${t.premiumRequests}:${t.requests}`;
}
