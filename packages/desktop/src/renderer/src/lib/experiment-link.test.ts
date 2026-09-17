import { describe, expect, it } from "vitest";
import type { ExperimentRecord, ProjectExperiments, SessionSummary } from "@omp-ui/core/types";
import { experimentSession, linkedExperiment } from "./experiment-link";

function record(patch: Partial<ExperimentRecord> & Pick<ExperimentRecord, "id">): ExperimentRecord {
  return {
    name: `exp-${patch.id}`,
    goal: null,
    primaryMetric: "latency",
    metricUnit: "ms",
    direction: "lower",
    preferredCommand: null,
    branch: null,
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
      pendingRunId: null,
      lastActivityAt: null,
      metricSeries: [],
    },
    ...patch,
  };
}

function session(patch: Partial<SessionSummary> & Pick<SessionSummary, "tabId">): SessionSummary {
  return {
    sessionId: null,
    lineageDir: "omp-ui--p--1",
    projectCwd: "/p",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    launchedAt: "2026-01-01T00:00:00.000Z",
    mode: "rpc-ui",
    agentMode: "build",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
    cachedTitle: null,
    cachedModified: null,
    title: "t",
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

const checkout = (
  tabId: string | null,
  cwd: string,
  branch: string | null,
  experiments: ExperimentRecord[],
): ProjectExperiments["checkouts"][number] => ({
  cwd,
  tabId,
  branch,
  result: { source: { cwd, key: "k", dbPath: "/db" }, experiments, error: null },
});

const overview = (checkouts: ProjectExperiments["checkouts"]): ProjectExperiments => ({
  projectCwd: "/p",
  repo: "git",
  checkouts,
  pendingLaunches: [],
});

const provenance = (launchedBranch: string | null) => ({
  goal: "g",
  metric: "latency",
  unit: "ms",
  direction: "lower" as const,
  launchedBranch,
  launchedAt: "2026-01-01T00:00:00.000Z",
});

describe("linkedExperiment", () => {
  it("prefers the worktree checkout's row on the session's branch over a newer row", () => {
    const newer = record({ id: 9, branch: "other" });
    const onBranch = record({ id: 3, branch: "autoresearch/x/abcd1234" });
    const result = overview([
      checkout(null, "/p", "main", [record({ id: 20, branch: "main" })]),
      checkout("wt", "/wt", "autoresearch/x/abcd1234", [newer, onBranch]),
    ]);
    const summary = session({
      tabId: "wt",
      worktree: { path: "/wt", branch: "autoresearch/x/abcd1234", base: "main" },
    });
    expect(linkedExperiment(result, "wt", summary)).toEqual({ checkoutTabId: "wt", record: onBranch });
  });

  it("falls back to the checkout's newest open row when no row names the branch", () => {
    const closed = record({ id: 9, branch: "other", closedAt: 5 });
    const open = record({ id: 4, branch: "other" });
    const result = overview([checkout("wt", "/wt", "b", [closed, open])]);
    const summary = session({ tabId: "wt", worktree: { path: "/wt", branch: "b", base: null } });
    expect(linkedExperiment(result, "wt", summary)?.record).toBe(open);
  });

  it("links a fork sharing the checkout by path when its own tabId is not a checkout", () => {
    const row = record({ id: 1, branch: "b" });
    const result = overview([checkout("origin", "/wt", "b", [row])]);
    const fork = session({ tabId: "fork", worktree: { path: "/wt", branch: "b", base: null } });
    expect(linkedExperiment(result, "fork", fork)).toEqual({ checkoutTabId: "origin", record: row });
  });

  it("links a project-checkout session through its launch provenance branch, newest open first", () => {
    const closedOnBranch = record({ id: 7, branch: "main", closedAt: 9 });
    const openOnBranch = record({ id: 5, branch: "main" });
    const other = record({ id: 8, branch: "feature" });
    const result = overview([checkout(null, "/p", "main", [other, closedOnBranch, openOnBranch])]);
    const summary = session({ tabId: "s", experiment: provenance("main") });
    expect(linkedExperiment(result, "s", summary)).toEqual({ checkoutTabId: null, record: openOnBranch });
  });

  it("returns null without provenance, without an overview, or when no branch matches", () => {
    const result = overview([checkout(null, "/p", "main", [record({ id: 1, branch: "main" })])]);
    expect(linkedExperiment(result, "s", session({ tabId: "s" }))).toBeNull();
    expect(linkedExperiment(null, "s", session({ tabId: "s", experiment: provenance("main") }))).toBeNull();
    expect(
      linkedExperiment(result, "s", session({ tabId: "s", experiment: provenance("feature") })),
    ).toBeNull();
  });
});

describe("experimentSession", () => {
  it("resolves a worktree checkout to its own session", () => {
    const wt = session({ tabId: "wt", worktree: { path: "/wt", branch: "b", base: null } });
    expect(experimentSession("wt", record({ id: 1, branch: "b" }), [session({ tabId: "x" }), wt])).toBe(wt);
    expect(experimentSession("gone", record({ id: 1 }), [wt])).toBeNull();
  });

  it("picks the newest project-checkout session launched on the record's branch", () => {
    const older = session({ tabId: "a", experiment: provenance("main"), launchedAt: "2026-01-01T00:00:00.000Z" });
    const newest = session({ tabId: "b", experiment: provenance("main"), launchedAt: "2026-02-01T00:00:00.000Z" });
    const elsewhere = session({ tabId: "c", experiment: provenance("feature"), launchedAt: "2026-03-01T00:00:00.000Z" });
    const worktree = session({
      tabId: "d",
      experiment: provenance("main"),
      worktree: { path: "/wt", branch: "main", base: null },
      launchedAt: "2026-04-01T00:00:00.000Z",
    });
    expect(experimentSession(null, record({ id: 1, branch: "main" }), [older, elsewhere, worktree, newest])).toBe(newest);
    expect(experimentSession(null, record({ id: 1, branch: "none" }), [older, newest])).toBeNull();
  });
});
