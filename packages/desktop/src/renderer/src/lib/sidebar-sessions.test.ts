import type {
  PlanImplementationSource,
  ProjectGroup,
  SessionSummary,
} from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { backendState, remoteInstance } from "../test/fixtures";
import { buildSidebarLists, type SidebarEntry } from "./sidebar-sessions";

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
    launchedAt: "2026-08-19T12:00:00.000Z",
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
      reviewRoster: null,
      knowledgeHome: null,
      repositoryKey: null,
    },
    sessions,
  };
}

function ids(entries: SidebarEntry[]): string[] {
  return entries.map((entry) => entry.session.tabId);
}

describe("buildSidebarLists", () => {
  it("puts live sessions in active and every other liveness in settled", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("live"),
          session("dormant", { live: "dormant" }),
          session("archived", { live: "archived" }),
          session("missing", { live: "missing" }),
        ]),
      ],
    });

    const lists = buildSidebarLists(state, "");

    expect(ids(lists.active)).toEqual(["live"]);
    expect(ids(lists.settled)).toEqual(["dormant", "archived", "missing"]);
  });

  it("orders project sessions, chats, and remote sessions together by open order", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("local-old", { launchedAt: "2026-08-19T10:00:00.000Z" }),
          // Activity does not reorder: newest cachedModified, oldest open.
          session("local-stale-but-active", {
            launchedAt: "2026-08-19T09:00:00.000Z",
            cachedModified: "2026-08-19T23:00:00.000Z",
          }),
          session("garbled", { launchedAt: "not a date" }),
        ]),
      ],
      chats: [
        session("chat", { projectCwd: "/chats", chat: true, launchedAt: "2026-08-19T14:00:00.000Z" }),
        session("tie-local", { chat: true, launchedAt: "2026-08-19T11:00:00.000Z" }),
      ],
      remoteInstances: [
        remoteInstance({
          projects: [
            group("/r", "remote", [
              session("remote", { launchedAt: "2026-08-19T12:30:00.000Z" }),
              session("tie-remote", { launchedAt: "2026-08-19T11:00:00.000Z" }),
            ]),
          ],
        }),
      ],
    });

    const { active } = buildSidebarLists(state, "");

    expect(ids(active)).toEqual([
      "chat",
      "remote",
      // Equal opens keep build order: local chats before remote sessions.
      "tie-local",
      "tie-remote",
      "local-old",
      "local-stale-but-active",
      "garbled",
    ]);
  });

  it("labels entries with their project name, or null for a chat, and their host", () => {
    const state = backendState({
      projects: [group("/a", "alpha", [session("p")])],
      chats: [session("c", { chat: true })],
      remoteInstances: [
        remoteInstance({ id: "inst-1", nickname: "box-a", projects: [group("/r", "remote", [session("r")])] }),
      ],
    });

    const { active } = buildSidebarLists(state, "");

    expect(
      active.map(({ session: s, instanceId, nickname, projectName, reachable }) => ({
        id: s.tabId,
        instanceId,
        nickname,
        projectName,
        reachable,
      })),
    ).toEqual([
      { id: "p", instanceId: null, nickname: null, projectName: "alpha", reachable: true },
      { id: "c", instanceId: null, nickname: null, projectName: null, reachable: true },
      { id: "r", instanceId: "inst-1", nickname: "box-a", projectName: "remote", reachable: true },
    ]);
  });

  it("filters on title, plan title, project name, and nickname", () => {
    const plan: PlanImplementationSource = {
      sourceTabId: "gone",
      planTitle: "Refactor Parser",
      planFilePath: "local://plans/gone.md",
    };
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("by-title", { title: "Fix auth bug" }),
          session("by-plan", { planImplementationSource: plan }),
        ]),
        group("/b", "Beta Project", [session("by-project")]),
      ],
      chats: [session("chat", { chat: true, title: "Quarterly notes" })],
      remoteInstances: [
        remoteInstance({ nickname: "gpu-box", projects: [group("/r", "remote", [session("by-nick")])] }),
      ],
    });

    const pick = (query: string): string[] => ids(buildSidebarLists(state, query).active);

    expect(pick("  AUTH ")).toEqual(["by-title"]);
    expect(pick("parser")).toEqual(["by-plan"]);
    expect(pick("beta")).toEqual(["by-project"]);
    expect(pick("GPU")).toEqual(["by-nick"]);
    expect(pick("zzz")).toEqual([]);
    expect(pick("   ")).toHaveLength(5);
  });

  it("excludes self instances and marks non-joined instances unreachable", () => {
    const state = backendState({
      remoteInstances: [
        remoteInstance({ id: "self", status: "self", projects: [group("/s", "self", [session("mine")])] }),
        remoteInstance({
          id: "down",
          status: "unreachable",
          projects: [group("/d", "down", [session("down-live"), session("down-old", { live: "dormant" })])],
        }),
        remoteInstance({ id: "up", status: "joined", projects: [group("/u", "up", [session("up-live")])] }),
      ],
    });

    const lists = buildSidebarLists(state, "");
    const all = [...lists.active, ...lists.settled];

    expect(ids(all)).not.toContain("mine");
    expect(Object.fromEntries(all.map((e) => [e.session.tabId, e.reachable]))).toEqual({
      "down-live": false,
      "down-old": false,
      "up-live": true,
    });
  });

  it("resolves a live implementation's settled planning source", () => {
    const plan = session("plan", {
      live: "dormant",
      cachedModified: "2026-08-19T09:00:00.000Z",
    });
    const implementation = session("impl", {
      planImplementationSource: {
        sourceTabId: "plan",
        planTitle: "Ship it",
        planFilePath: "local://plans/plan.md",
      },
    });
    const state = backendState({ projects: [group("/a", "alpha", [implementation, plan])] });

    // The query hides the plan row, but resolution ran over the full set.
    const lists = buildSidebarLists(state, "ship");

    expect(ids(lists.active)).toEqual(["impl"]);
    expect(lists.active[0]!.handoff.source).toBe(plan);
    expect(buildSidebarLists(state, "").settled[0]!.handoff.hasDescendants).toBe(true);
  });
});

describe("Working and Snoozed sections (issue #935)", () => {
  it("puts a live session with a running turn in working, not active", () => {
    const state = backendState({
      projects: [group("/a", "alpha", [session("idle"), session("busy", { turnRunning: true })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.active)).toEqual(["idle"]);
    expect(ids(lists.working)).toEqual(["busy"]);
  });

  it("never puts a terminal (pty) session in working", () => {
    // A PTY raises no rpc turn latch, so it reads as not in a turn.
    const state = backendState({
      projects: [group("/a", "alpha", [session("pty", { mode: "pty" })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.active)).toEqual(["pty"]);
    expect(lists.working).toEqual([]);
  });

  it("parks a snoozed live in-turn session in snoozed, outranking working", () => {
    const state = backendState({
      snoozedSectionEnabled: true,
      projects: [group("/a", "alpha", [session("busy", { turnRunning: true, snoozed: true })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.snoozed)).toEqual(["busy"]);
    expect(lists.working).toEqual([]);
    expect(lists.active).toEqual([]);
  });

  it("parks a snoozed dormant session in snoozed, not settled", () => {
    const state = backendState({
      snoozedSectionEnabled: true,
      projects: [group("/a", "alpha", [session("dormant", { live: "dormant", snoozed: true })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.snoozed)).toEqual(["dormant"]);
    expect(lists.settled).toEqual([]);
  });

  it("distributes snoozed-flagged sessions by liveness when the setting is off", () => {
    const state = backendState({
      // snoozedSectionEnabled defaults to false.
      projects: [
        group("/a", "alpha", [
          session("idle", { snoozed: true }),
          session("busy", { turnRunning: true, snoozed: true }),
          session("dormant", { live: "dormant", snoozed: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(lists.snoozed).toEqual([]);
    expect(ids(lists.active)).toEqual(["idle"]);
    expect(ids(lists.working)).toEqual(["busy"]);
    expect(ids(lists.settled)).toEqual(["dormant"]);
  });

  it("orders working and snoozed newest open first", () => {
    const state = backendState({
      snoozedSectionEnabled: true,
      projects: [
        group("/a", "alpha", [
          session("w-old", { turnRunning: true, launchedAt: "2026-08-19T10:00:00.000Z" }),
          session("w-new", { turnRunning: true, launchedAt: "2026-08-19T12:00:00.000Z" }),
          session("s-old", { snoozed: true, launchedAt: "2026-08-19T09:00:00.000Z" }),
          session("s-new", { snoozed: true, launchedAt: "2026-08-19T11:00:00.000Z" }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.working)).toEqual(["w-new", "w-old"]);
    expect(ids(lists.snoozed)).toEqual(["s-new", "s-old"]);
  });

  it("returns a query match in its snoozed section when the setting is on", () => {
    const state = backendState({
      snoozedSectionEnabled: true,
      projects: [group("/a", "alpha", [session("parked", { snoozed: true, title: "Parked plan" })])],
    });
    const lists = buildSidebarLists(state, "parked");
    expect(ids(lists.snoozed)).toEqual(["parked"]);
    expect(lists.active).toEqual([]);
  });

  it("puts an in-turn session awaiting a human answer in active, not working (issue #944)", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("busy", { turnRunning: true }),
          session("asking", { turnRunning: true, awaitingHumanAnswer: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.active)).toEqual(["asking"]);
    expect(ids(lists.working)).toEqual(["busy"]);
  });

  it("puts an in-turn session with a pending plan in active even without the answer level (older host)", () => {
    const pendingPlan = {
      title: "Pending plan",
      planFilePath: "local://plan.md",
      planAbsPath: null,
      frameId: "pending",
      proposedAt: "2026-10-26T10:00:00.000Z",
    };
    const state = backendState({
      projects: [group("/a", "alpha", [session("plan", { turnRunning: true, pendingPlan })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.active)).toEqual(["plan"]);
    expect(lists.working).toEqual([]);
  });

  it("keeps a snoozed session awaiting an answer in snoozed", () => {
    const state = backendState({
      snoozedSectionEnabled: true,
      projects: [
        group("/a", "alpha", [
          session("parked", { turnRunning: true, awaitingHumanAnswer: true, snoozed: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.snoozed)).toEqual(["parked"]);
    expect(lists.active).toEqual([]);
    expect(lists.working).toEqual([]);
  });
});
