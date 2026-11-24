import type { FleetRequester } from "@omp-ui/core/fleet";
import type { ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { backendState, remoteInstance } from "../test/fixtures";
import { resolveDispatchLinks, type SessionDispatch } from "./dispatched-sessions";

function session(tabId: string, patch: Partial<SessionSummary> = {}): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `lineage-${tabId}`,
    projectCwd: "/a",
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    fleet: null,
    launchedAt: "2026-11-18T12:00:00.000Z",
    mode: "rpc-ui",
    model: null,
    thinkingLevel: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
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
    cachedTitle: null,
    cachedModified: null,
    title: `Session ${tabId}`,
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function dispatched(
  tabId: string,
  sourceTabId: string | null,
  dispatchedAt = "2026-11-18T12:00:00.000Z",
  kind: FleetRequester["kind"] = "agent",
): SessionSummary {
  return session(tabId, {
    projectCwd: "/b",
    fleet: {
      dispatchId: `d-${tabId}`,
      batchId: null,
      dispatchedAt,
      requestedBy: { instanceId: "self", label: "this computer", kind, sourceTabId },
    },
  });
}

function group(path: string, name: string, sessions: SessionSummary[]): ProjectGroup {
  return {
    project: {
      path,
      name,
      addedAt: "t",
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      councilRoster: null,
      knowledgeHome: null,
      repositoryKey: null,
      icon: null,
    },
    sessions,
  };
}

const childIds = (links: ReadonlyMap<string, SessionDispatch>, tabId: string): string[] =>
  (links.get(tabId)?.children ?? []).map((c) => c.session.tabId);

describe("resolveDispatchLinks (#1226)", () => {
  it("groups local agent-dispatched children under their local parent, in dispatch order", () => {
    const state = backendState({
      projects: [
        group("/a", "A", [session("parent")]),
        group("/b", "B", [
          dispatched("late", "parent", "2026-11-18T12:05:00.000Z"),
          dispatched("early", "parent", "2026-11-18T12:01:00.000Z"),
          dispatched("garbled", "parent", "not a date"),
        ]),
      ],
    });
    const links = resolveDispatchLinks(state);
    expect(childIds(links, "parent")).toEqual(["early", "late", "garbled"]);
    expect(links.get("parent")?.parent).toBeNull();
    const child = links.get("early")!;
    expect(child.parent?.session.tabId).toBe("parent");
    expect(child.parent?.project?.name).toBe("A");
    expect(links.get("parent")?.children[0]?.project?.name).toBe("B");
    // Cached per state object: selectors get one stable map.
    expect(resolveDispatchLinks(state)).toBe(links);
  });

  it("resolves a remote child under a local parent with its nickname and reachability", () => {
    const state = backendState({
      projects: [group("/a", "A", [session("parent")])],
      remoteInstances: [
        remoteInstance({ id: "inst-2", nickname: "box-b", status: "unreachable", projects: [group("/r", "R", [dispatched("remote-child", "parent")])] }),
      ],
    });
    const [child] = resolveDispatchLinks(state).get("parent")!.children;
    expect(child).toMatchObject({ instanceId: "inst-2", nickname: "box-b", reachable: false });
    expect(child!.project?.name).toBe("R");
  });

  it.each(["user", "webhook", "mcp"] as const)("ignores %s-started sessions", (kind) => {
    const state = backendState({
      projects: [group("/a", "A", [session("parent"), dispatched("child", "parent", undefined, kind)])],
    });
    expect(resolveDispatchLinks(state).size).toBe(0);
  });

  it("resolves nothing for a duplicate parent, a duplicate child, a missing parent, or a self-reference", () => {
    const dupParent = backendState({
      projects: [group("/a", "A", [session("parent"), session("parent"), dispatched("child", "parent")])],
    });
    expect(resolveDispatchLinks(dupParent).size).toBe(0);

    const dupChild = backendState({
      projects: [group("/a", "A", [session("parent"), dispatched("child", "parent"), dispatched("child", "parent")])],
    });
    expect(resolveDispatchLinks(dupChild).size).toBe(0);

    const missing = backendState({
      projects: [group("/a", "A", [session("parent", { live: "missing" }), dispatched("child", "parent")])],
    });
    expect(resolveDispatchLinks(missing).size).toBe(0);

    const self = backendState({ projects: [group("/a", "A", [dispatched("loop", "loop")])] });
    expect(resolveDispatchLinks(self).size).toBe(0);
  });

  it("lets a local chat be a parent", () => {
    const state = backendState({
      chats: [session("chat", { chat: true })],
      projects: [group("/b", "B", [dispatched("child", "chat")])],
    });
    const links = resolveDispatchLinks(state);
    expect(childIds(links, "chat")).toEqual(["child"]);
    expect(links.get("child")?.parent?.project).toBeNull();
  });
});
