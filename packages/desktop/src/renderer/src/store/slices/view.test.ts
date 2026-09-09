// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import type { BackendState, ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import type { RpcTabState, TabInfo } from "../../store";
import { backendState, remoteInstance, rpcTabState, tabInfo } from "../../test/fixtures";
import { projectKey } from "../../lib/project-key";
import {
  findOwner,
  findRecord,
  forgetFocus,
  pruneFocus,
  runningSessionTitleOnCheckout,
} from "./view";

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
    planImplementationSource: null,
    agentMode: "build",
    compactionMethod: null,
    model: null,
    thinkingLevel: null,
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

function group(path: string, ...sessions: SessionSummary[]): ProjectGroup {
  return {
    project: { path, name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
    sessions,
  };
}

function stateWith(...sessions: SessionSummary[]): BackendState {
  return backendState({ projects: [group(PROJECT, ...sessions)] });
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

describe("remote instance groups (issue #416)", () => {
  const INSTANCE = "inst-a";
  // The same absolute path is registered locally and on the remote: the
  // record lookups must not confuse the two, and the focus keys must differ.
  const remoteState = (): BackendState =>
    backendState({
      projects: [group(PROJECT, summary("local-1", "Local"))],
      remoteInstances: [
        remoteInstance({
          id: INSTANCE,
          projects: [group(PROJECT, summary("remote-1", "Remote"))],
        }),
      ],
    });

  it("findRecord and findOwner resolve a session that lives in a remote group", () => {
    const state = remoteState();
    expect(findRecord(state, "remote-1")?.title).toBe("Remote");
    expect(findOwner(state, "remote-1")).toEqual({
      instanceId: INSTANCE,
      record: expect.objectContaining({ tabId: "remote-1" }),
    });
    expect(findOwner(state, "local-1")?.instanceId).toBeNull();
    expect(findOwner(state, "nowhere")).toBeUndefined();
  });

  it("pruneFocus keeps a composite key while its instance and tab exist, drops it once the instance vanishes", () => {
    const remoteKey = projectKey(INSTANCE, PROJECT);
    const focus = { [PROJECT]: "local-1", [remoteKey]: "remote-1" };
    expect(pruneFocus(focus, remoteState())).toBe(focus);

    const gone = backendState({ projects: [group(PROJECT, summary("local-1", "Local"))] });
    expect(pruneFocus(focus, gone)).toEqual({ [PROJECT]: "local-1" });
  });

  it("forgetFocus reassigns within the same instance, never across the path twin", () => {
    const remoteKey = projectKey(INSTANCE, PROJECT);
    const tabs: TabInfo[] = [
      tabInfo({ tabId: "local-1", projectCwd: PROJECT }),
      tabInfo({ tabId: "remote-1", projectCwd: PROJECT, instanceId: INSTANCE }),
      tabInfo({ tabId: "remote-2", projectCwd: PROJECT, instanceId: INSTANCE }),
    ];
    const focus = { [PROJECT]: "local-1", [remoteKey]: "remote-2" };
    // Hiding the remote's focused tab hands focus to its sibling on that
    // instance; the local twin is untouched.
    expect(forgetFocus(focus, "remote-2", tabs.filter((t) => t.tabId !== "remote-2"))).toEqual({
      [PROJECT]: "local-1",
      [remoteKey]: "remote-1",
    });
    // With no remote sibling left the composite entry goes, not the local one.
    expect(forgetFocus(focus, "remote-2", [tabs[0]!])).toEqual({ [PROJECT]: "local-1" });
  });
});
