import type { AutoresearchSnapshot } from "@omp-ui/core/autoresearch";
import type { ExperimentRecord, SessionSummary } from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { deltaLabel, experimentState } from "./experiment-state";

function record(patch: Partial<ExperimentRecord> = {}, pendingRunId: number | null = null): ExperimentRecord {
  return {
    id: 1,
    name: "latency",
    goal: "reduce p95",
    primaryMetric: "p95_ms",
    metricUnit: "ms",
    direction: "lower",
    preferredCommand: null,
    branch: "autoresearch/latency/ab12",
    baselineCommit: null,
    currentSegment: 1,
    maxIterations: null,
    scopePaths: [],
    offLimits: [],
    constraints: [],
    secondaryMetrics: [],
    notes: "",
    createdAt: 1,
    closedAt: null,
    progress: {
      segmentRuns: 0,
      kept: 0,
      discarded: 0,
      crashed: 0,
      checksFailed: 0,
      baseline: null,
      best: null,
      pendingRunId,
      lastActivityAt: null,
      metricSeries: [],
    },
    ...patch,
  };
}

function summary(patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId: "tab",
    sessionId: null,
    lineageDir: "lineage",
    projectCwd: "/project",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    launchedAt: "2026-09-01T00:00:00.000Z",
    mode: "rpc-ui",
    model: null,
    thinkingLevel: null,
    agentMode: "build",
    compactionMethod: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
    cachedTitle: null,
    cachedModified: null,
    title: "Session",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function snapshot(mode: AutoresearchSnapshot["mode"]): AutoresearchSnapshot {
  return {
    version: 1,
    processKey: "p",
    sessionId: "",
    revision: 1,
    available: true,
    unavailable: null,
    mode,
    goal: null,
    goalTruncated: false,
    lastTool: null,
  };
}

describe("experimentState", () => {
  it("reads a closed row as closed whatever the session is doing", () => {
    expect(
      experimentState(record({ closedAt: 5 }, 7), summary({ turnRunning: true }), snapshot("on")),
    ).toBe("closed");
  });

  it("is off with no linked session, even when a run is pending", () => {
    expect(experimentState(record({}, 7), null, null)).toBe("off");
  });

  it("is dormant when the linked session has no process", () => {
    expect(experimentState(record(), summary({ live: "dormant" }), snapshot("on"))).toBe("dormant");
    expect(experimentState(record(), summary({ live: "archived" }), snapshot("on"))).toBe("dormant");
  });

  it("is off when the live session is outside autoresearch mode or has no snapshot", () => {
    expect(experimentState(record(), summary({ turnRunning: true }), snapshot("off"))).toBe("off");
    expect(experimentState(record(), summary({ turnRunning: true }), null)).toBe("off");
  });

  it("awaits the log while a run is started but unlogged, even mid-turn", () => {
    expect(experimentState(record({}, 3), summary({ turnRunning: true }), snapshot("on"))).toBe(
      "awaiting-log",
    );
  });

  it("splits a mode-on session into running and on by the turn", () => {
    expect(experimentState(record(), summary({ turnRunning: true }), snapshot("on"))).toBe("running");
    expect(experimentState(record(), summary({ turnRunning: false }), snapshot("on"))).toBe("on");
    expect(experimentState(record(), summary(), snapshot("on"))).toBe("on");
  });
});

describe("deltaLabel", () => {
  it("signs by the raw difference with a real minus sign, one decimal", () => {
    expect(deltaLabel(50, 41)).toBe("−18.0%");
    expect(deltaLabel(50, 55)).toBe("+10.0%");
    expect(deltaLabel(50, 50)).toBe("0.0%");
  });

  it("measures against the baseline's magnitude, so a negative baseline keeps the sign of the change", () => {
    expect(deltaLabel(-10, -5)).toBe("+50.0%");
  });

  it("falls back to the difference when the baseline is zero", () => {
    expect(deltaLabel(0, 3)).toBe("+3");
    expect(deltaLabel(0, -0.5)).toBe("−0.5");
  });
});
