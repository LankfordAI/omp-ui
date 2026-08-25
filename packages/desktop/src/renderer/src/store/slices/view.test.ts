// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import type { RpcTabState, TabInfo } from "../../store";
import { backendState, rpcTabState, tabInfo } from "../../test/fixtures";
import { runningSessionTitleOnCheckout } from "./view";

const PROJECT = "/p";
const WORKTREE = "/wt/busy";

function summary(
  tabId: string,
  title: string,
  worktree: SessionSummary["worktree"] = null,
): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: PROJECT,
    worktree,
    launchedAt: "t",
    mode: "rpc-ui",
    advisor: false,
    advisorModel: null,
    cachedTitle: null,
    cachedModified: null,
    title,
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

function stateWith(...sessions: SessionSummary[]): BackendState {
  return backendState({
    projects: [
      {
        project: { path: PROJECT, name: "p", addedAt: "t", lastModel: null, lastAdvisorModel: null },
        sessions,
      },
    ],
  });
}

const pick = (
  sessions: SessionSummary[],
  tabs: TabInfo[],
  rpc: Record<string, RpcTabState>,
) => ({ state: stateWith(...sessions), tabs, rpc });

describe("runningSessionTitleOnCheckout (issue #292)", () => {
  it("guards a checkout a session runs in", () => {
    const s = pick(
      [summary("t1", "Busy")],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }) },
    );
    expect(runningSessionTitleOnCheckout(s, PROJECT)).toBe("Busy");
  });

  it("does not flag the project root for a running worktree session", () => {
    const s = pick(
      [summary("t1", "Busy", { path: WORKTREE, branch: "feat/busy", base: null })],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }) },
    );
    expect(runningSessionTitleOnCheckout(s, PROJECT)).toBeNull();
  });

  it("still guards the worktree's own checkout", () => {
    const s = pick(
      [summary("t1", "Busy", { path: WORKTREE, branch: "feat/busy", base: null })],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }) },
    );
    expect(runningSessionTitleOnCheckout(s, WORKTREE)).toBe("Busy");
  });

  it("excludes the named tab but keeps the others", () => {
    const s = pick(
      [summary("t1", "One"), summary("t2", "Two")],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT }), tabInfo({ tabId: "t2", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }), t2: rpcTabState({ status: "running" }) },
    );
    expect(runningSessionTitleOnCheckout(s, PROJECT, "t1")).toBe("Two");
    expect(runningSessionTitleOnCheckout(s, PROJECT, "t2")).toBe("One");
    expect(runningSessionTitleOnCheckout(s, PROJECT)).toBe("One");
  });

  it("returns null without a cwd, without a record, or when not running", () => {
    const s = pick(
      [summary("t1", "Busy")],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT }), tabInfo({ tabId: "ghost", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "ready" }), ghost: rpcTabState({ status: "running" }) },
    );
    expect(runningSessionTitleOnCheckout(s, undefined)).toBeNull();
    // t1 is not running; `ghost` is running but has no backend record.
    expect(runningSessionTitleOnCheckout(s, PROJECT)).toBeNull();
  });
});
