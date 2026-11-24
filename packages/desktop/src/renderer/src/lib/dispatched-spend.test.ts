// @vitest-environment node
import { describe, expect, it } from "vitest";
import { emptySpendTotals, type SpendTotals } from "@omp-ui/core/session-spend";
import type { SessionSummary } from "@omp-ui/core/types";
import type { DispatchLink } from "./dispatched-sessions";
import { aggregateDispatchedSpend } from "./dispatched-spend";
import { rpcTabState } from "../test/fixtures";

function makeTotals(cost: number, totalTokens: number, premiumRequests = 0): SpendTotals {
  return {
    ...emptySpendTotals(),
    cost,
    input: Math.floor(totalTokens * 0.7),
    output: Math.ceil(totalTokens * 0.3),
    totalTokens,
    premiumRequests,
    requests: cost > 0 ? 1 : 0,
  };
}

function makeLink(
  tabId: string,
  overrides: Partial<SessionSummary> = {},
  reachable = true,
): DispatchLink {
  return {
    instanceId: null,
    nickname: null,
    project: null,
    reachable,
    session: {
      tabId,
      sessionId: `session-${tabId}`,
      lineageDir: `lineage-${tabId}`,
      projectCwd: "/p",
      launchedAt: "2026-11-22T10:00:00.000Z",
      mode: "rpc-ui",
      worktree: null,
      planImplementationSource: null,
      experiment: null,
      fleet: null,
      agentMode: "build",
      compactionMethod: null,
      approvalMode: null,
      serviceTier: null,
      model: null,
      thinkingLevel: null,
      advisor: false,
      advisorModel: null,
      subagentModels: null,
      proposedPlans: [],
      autoTitled: false,
      snoozed: false,
      snoozedUntilMs: null,
      reminderAtMs: null,
      pinnedAtMs: null,
      settledAtMs: null,
      heldPrompt: null,
      scheduledPrompt: null,
      routine: null,
      pullRequests: [],
      autoSettleOnMerge: null,
      private: false,
      chat: false,
      askSource: null,
      cachedTitle: tabId,
      cachedModified: "2026-11-22T10:00:00.000Z",
      title: tabId,
      status: "complete",
      live: "dormant",
      pendingPlan: null,
      planSettle: null,
      streamStalled: false,
      ...overrides,
    },
  };
}

describe("aggregateDispatchedSpend", () => {
  it("returns null when there are no dispatched children", () => {
    expect(aggregateDispatchedSpend([], {})).toBeNull();
  });

  it("prefers live renderer sessionSpend when available, else uses SessionSummary.spend", () => {
    const childLiveOpen = makeLink("c-live", { live: "live", spend: makeTotals(0.1, 100, 1) });
    const childUnopened = makeLink("c-unopened", { live: "live", spend: makeTotals(0.3, 300, 2) });
    const childDormant = makeLink("c-dormant", { live: "dormant", spend: makeTotals(0.25, 250, 0) });

    const result = aggregateDispatchedSpend([childLiveOpen, childUnopened, childDormant], {
      "c-live": rpcTabState({
        sessionSpend: {
          version: 1,
          processKey: "p",
          revision: 3,
          available: true,
          unavailable: null,
          sessionFile: "/s/c-live.jsonl",
          main: makeTotals(0.15, 150, 1),
          subagents: makeTotals(0.05, 50, 0),
          total: makeTotals(0.2, 200, 1),
          transcripts: 1,
          cacheWarm: emptySpendTotals(),
        },
      }),
    });

    expect(result).not.toBeNull();
    expect(result!.count).toBe(3);
    expect(result!.reported).toBe(3);
    expect(result!.missing).toBe(0);
    expect(result!.totals.cost).toBeCloseTo(0.75, 6);
    expect(result!.totals.totalTokens).toBe(750);
    expect(result!.totals.premiumRequests).toBe(3);
  });

  it("treats newly dispatched unmaterialized children as known $0, not missing", () => {
    const brandNew = makeLink("c-new", { live: "live", sessionId: null, spend: null });
    const result = aggregateDispatchedSpend([brandNew], {});
    expect(result).toEqual({
      count: 1,
      reported: 1,
      missing: 0,
      totals: emptySpendTotals(),
    });
  });

  it("marks older remote host (undefined spend), unreachable remote, missing, and unreadable persisted children as missing", () => {
    const reported = makeLink("c-ok", { live: "dormant", spend: makeTotals(0.5, 500, 1) });
    const olderRemote = makeLink("c-older", { live: "live", spend: undefined });
    const disconnected = makeLink("c-offline", { live: "live", spend: makeTotals(0.9, 900, 0) }, false);
    const missingFile = makeLink("c-missing", { live: "missing", spend: null });
    const unreadable = makeLink("c-corrupt", { live: "dormant", sessionId: "s-corrupt", spend: null });

    const result = aggregateDispatchedSpend(
      [reported, olderRemote, disconnected, missingFile, unreadable],
      {},
    );
    expect(result!.count).toBe(5);
    expect(result!.reported).toBe(1);
    expect(result!.missing).toBe(4);
    expect(result!.totals.cost).toBeCloseTo(0.5, 6);
    expect(result!.totals.totalTokens).toBe(500);
    expect(result!.totals.premiumRequests).toBe(1);
  });
});
