import { describe, expect, it } from "vitest";
import type { ProjectGroup } from "@omp-ui/core/types";
import { backendState, remoteInstance } from "../test/fixtures";
import { tabTitle } from "./tab-title";

function group(path: string, tabId: string, title: string): ProjectGroup {
  return {
    project: {
      path,
      name: path.split("/").pop() ?? path,
      addedAt: "2026-08-03T00:00:00.000Z",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
    },
    sessions: [
      {
        tabId,
        sessionId: `${tabId}-session`,
        lineageDir: `omp-ui--${tabId}`,
        projectCwd: path,
        launchedAt: "2026-08-03T00:00:00.000Z",
        mode: "rpc-ui",
        worktree: null,
        planImplementationSource: null,
        agentMode: "build",
        compactionMethod: null,
        model: null,
        thinkingLevel: null,
        advisor: false,
        advisorModel: null,
        cachedTitle: title,
        cachedModified: "2026-08-03T00:00:00.000Z",
        title,
        status: "complete",
        live: "live",
        pendingPlan: null,
        planSettle: null,
        streamStalled: false,
      },
    ],
  };
}

describe("tabTitle (issue #416)", () => {
  const state = backendState({
    projects: [group("/projects/one", "tab-local", "Fix the build")],
    remoteInstances: [
      remoteInstance({
        id: "inst-a",
        nickname: "box-a",
        projects: [group("/projects/one", "tab-remote", "Fix the build")],
      }),
    ],
  });

  it("prefixes only the titles of sessions owned by a remote instance", () => {
    expect(tabTitle(state, "tab-local")).toBe("Fix the build");
    expect(tabTitle(state, "tab-remote")).toBe("box-a · Fix the build");
  });

  it("is undefined for an unknown tab and before the first state", () => {
    expect(tabTitle(state, "tab-missing")).toBeUndefined();
    expect(tabTitle(null, "tab-local")).toBeUndefined();
  });
});
