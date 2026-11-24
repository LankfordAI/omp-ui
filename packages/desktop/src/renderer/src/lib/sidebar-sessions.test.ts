import type {
  PlanImplementationSource,
  ProjectGroup,
  ProjectIcon,
  SessionSummary,
} from "@omp-ui/core/types";
import { describe, expect, it } from "vitest";
import { backendState, remoteInstance } from "../test/fixtures";
import { projectIdentitySeed } from "./repository-members";
import { buildAttentionEntries, buildSidebarLists, type SidebarEntry } from "./sidebar-sessions";

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
    snoozedUntilMs: null,
    reminderAtMs: null,
    pinnedAtMs: null,
    settledAtMs: (patch.live ?? "live") === "live" ? null : 1_000,
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

function group(
  path: string,
  name: string,
  sessions: SessionSummary[],
  identity: { repositoryKey?: string | null; icon?: ProjectIcon | null } = {},
): ProjectGroup {
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
      repositoryKey: identity.repositoryKey ?? null,
      icon: identity.icon ?? null,
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
      active.map(({ session: s, instanceId, nickname, project, reachable }) => ({
        id: s.tabId,
        instanceId,
        nickname,
        projectName: project?.name ?? null,
        reachable,
      })),
    ).toEqual([
      { id: "p", instanceId: null, nickname: null, projectName: "alpha", reachable: true },
      { id: "c", instanceId: null, nickname: null, projectName: null, reachable: true },
      { id: "r", instanceId: "inst-1", nickname: "box-a", projectName: "remote", reachable: true },
    ]);
  });

  it("faces share the quick-open identity", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [session("local")], {
          repositoryKey: "acme/alpha",
          icon: { source: "custom", dataUrl: "data:x" },
        }),
        group("/k", "keyless", [session("keyless", { projectCwd: "/k" })]),
      ],
      remoteInstances: [
        remoteInstance({
          id: "inst-1",
          projects: [group("/r/alpha", "alpha", [session("remote")], { repositoryKey: "acme/alpha" })],
        }),
      ],
    });

    const { active } = buildSidebarLists(state, "");
    const face = (id: string) => active.find((e) => e.session.tabId === id)?.project;

    // One repository, one hue and one icon across machines: the remote
    // checkout without an icon borrows its local twin's.
    expect(face("local")).toEqual({ name: "alpha", seed: "repo:acme/alpha", icon: "data:x" });
    expect(face("remote")).toEqual({ name: "alpha", seed: "repo:acme/alpha", icon: "data:x" });
    expect(face("keyless")).toEqual({
      name: "keyless",
      seed: projectIdentitySeed({ repositoryKey: null, instanceId: null, projectCwd: "/k" }),
      icon: null,
    });
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
      projects: [group("/a", "alpha", [session("busy", { turnRunning: true, snoozed: true })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.snoozed)).toEqual(["busy"]);
    expect(lists.working).toEqual([]);
    expect(lists.active).toEqual([]);
  });

  it("parks a snoozed dormant session in snoozed, not settled", () => {
    const state = backendState({
      projects: [group("/a", "alpha", [session("dormant", { live: "dormant", snoozed: true })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.snoozed)).toEqual(["dormant"]);
    expect(lists.settled).toEqual([]);
  });

  it("always partitions snoozed sessions into snoozed with no opt-in setting (#1323)", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("idle", { snoozed: true }),
          session("busy", { turnRunning: true, snoozed: true }),
          session("dormant", { live: "dormant", snoozed: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.snoozed)).toEqual(["idle", "busy", "dormant"]);
    expect(lists.active).toEqual([]);
    expect(lists.working).toEqual([]);
    expect(lists.settled).toEqual([]);
  });

  it("orders working and snoozed newest open first", () => {
    const state = backendState({
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

  it("returns a query match in its snoozed section", () => {
    const state = backendState({
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

describe("background work in flight (issue #1026)", () => {
  it("moves a live session with background work but no running turn into working", () => {
    const state = backendState({
      projects: [group("/a", "alpha", [session("bg", { turnRunning: false })])],
    });
    const lists = buildSidebarLists(state, "", new Set(["bg"]));
    expect(ids(lists.working)).toEqual(["bg"]);
    expect(lists.active).toEqual([]);
  });

  it("keeps a background-work row awaiting a human answer in active, not working", () => {
    const state = backendState({
      projects: [group("/a", "alpha", [session("bg-asking", { turnRunning: false, awaitingHumanAnswer: true })])],
    });
    const lists = buildSidebarLists(state, "", new Set(["bg-asking"]));
    expect(ids(lists.active)).toEqual(["bg-asking"]);
    expect(lists.working).toEqual([]);
  });

  it("keeps a background-work row with a pending plan in active, not working", () => {
    const pendingPlan = {
      title: "Pending plan",
      planFilePath: "local://plan.md",
      planAbsPath: null,
      frameId: "pending",
      proposedAt: "2026-10-26T10:00:00.000Z",
    };
    const state = backendState({
      projects: [group("/a", "alpha", [session("bg-plan", { turnRunning: false, pendingPlan })])],
    });
    const lists = buildSidebarLists(state, "", new Set(["bg-plan"]));
    expect(ids(lists.active)).toEqual(["bg-plan"]);
    expect(lists.working).toEqual([]);
  });

  it("pin and snooze outrank background work", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("bg-pin", { turnRunning: false, pinnedAtMs: 1_000 }),
          session("bg-snoozed", { turnRunning: false, snoozed: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "", new Set(["bg-pin", "bg-snoozed"]));
    expect(ids(lists.pinned)).toEqual(["bg-pin"]);
    expect(ids(lists.snoozed)).toEqual(["bg-snoozed"]);
    expect(lists.working).toEqual([]);
  });

  it("a tab absent from the set is unaffected", () => {
    const state = backendState({
      projects: [group("/a", "alpha", [session("idle", { turnRunning: false })])],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.active)).toEqual(["idle"]);
    expect(lists.working).toEqual([]);
  });
});

describe("Pinned group (issue #981)", () => {
  it("places a snoozed pinned session in Snoozed while keeping un-snoozed pinned rows in Pinned (#1323)", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("idle"),
          session("late-pin", { pinnedAtMs: 2_000, launchedAt: "2026-08-19T09:00:00.000Z" }),
          session("busy-pin", { pinnedAtMs: 1_000, turnRunning: true, launchedAt: "2026-08-19T12:00:00.000Z" }),
          session("snoozed-pin", { pinnedAtMs: 3_000, snoozed: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.pinned)).toEqual(["busy-pin", "late-pin"]);
    expect(ids(lists.active)).toEqual(["idle"]);
    expect(lists.working).toEqual([]);
    expect(ids(lists.snoozed)).toEqual(["snoozed-pin"]);
  });

  it("files a settled pinned session under settled, or snoozed when also snoozed", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("gone", { pinnedAtMs: 1_000, live: "dormant" }),
          session("parked", { pinnedAtMs: 2_000, live: "dormant", snoozed: true }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(lists.pinned).toEqual([]);
    expect(ids(lists.settled)).toEqual(["gone"]);
    expect(ids(lists.snoozed)).toEqual(["parked"]);
  });

  it("reads an older remote host's absent pinnedAtMs as unpinned", () => {
    const legacy = session("old-host", { turnRunning: true }) as Partial<SessionSummary>;
    delete legacy.pinnedAtMs;
    const state = backendState({
      projects: [group("/a", "alpha", [legacy as SessionSummary])],
    });
    const lists = buildSidebarLists(state, "");
    expect(lists.pinned).toEqual([]);
    expect(ids(lists.working)).toEqual(["old-host"]);
  });
});

describe("settledAtMs persistence across restarts and reboots (issue #1137)", () => {
  it("keeps dormant unsettled sessions in active and pinned instead of dropping them into settled", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("restarted-active", { live: "dormant", settledAtMs: null }),
          session("restarted-pinned", { live: "dormant", settledAtMs: null, pinnedAtMs: 1_000 }),
          session("deliberately-settled", { live: "dormant", settledAtMs: 2_000 }),
          session("archived-unsettled", { live: "archived", settledAtMs: null }),
          session("missing-unsettled", { live: "missing", settledAtMs: null }),
        ]),
      ],
    });
    const lists = buildSidebarLists(state, "");
    expect(ids(lists.pinned)).toEqual(["restarted-pinned"]);
    expect(ids(lists.active)).toEqual(["restarted-active"]);
    expect(ids(lists.settled)).toEqual(["deliberately-settled", "archived-unsettled", "missing-unsettled"]);
  });

  it("falls back to live !== 'live' when settledAtMs is undefined on an older remote host", () => {
    const legacyDormant = session("legacy-dormant", { live: "dormant" }) as Partial<SessionSummary>;
    delete legacyDormant.settledAtMs;
    const state = backendState({
      projects: [group("/a", "alpha", [legacyDormant as SessionSummary])],
    });
    const lists = buildSidebarLists(state, "");
    expect(lists.active).toEqual([]);
    expect(ids(lists.settled)).toEqual(["legacy-dormant"]);
  });
});

describe("Routine runs (ADR-0100, issue #1261)", () => {
  const routine = {
    id: "r".repeat(22),
    name: "Morning overview",
    approvalEntries: {},
    deniedBuiltins: [],
    warnCostUsd: 2,
    maxCostUsd: 5,
  };
  const all = (lists: ReturnType<typeof buildSidebarLists>): string[] => [
    ...ids(lists.pinned),
    ...ids(lists.active),
    ...ids(lists.working),
    ...ids(lists.snoozed),
    ...ids(lists.settled),
  ];

  it("files a local routine run into no section, whatever its state, while coding sessions stay", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("coding"),
          session("run-idle", { routine }),
          session("run-working", { routine, turnRunning: true }),
          session("run-pinned", { routine, pinnedAtMs: 5 }),
          session("run-snoozed", { routine, snoozed: true }),
          session("run-settled", { routine, live: "dormant" }),
        ]),
      ],
      chats: [session("run-chat", { routine, chat: true })],
    });
    expect(all(buildSidebarLists(state, ""))).toEqual(["coding"]);
  });

  it("excludes a joined instance's routine runs from every sidebar section (#1304)", () => {
    const state = backendState({
      remoteInstances: [
        remoteInstance({
          projects: [
            group("/r", "remote", [
              session("remote-coding"),
              session("remote-run-idle", { routine }),
              session("remote-run-working", { routine, turnRunning: true }),
              session("remote-run-pinned", { routine, pinnedAtMs: 5 }),
              session("remote-run-snoozed", { routine, snoozed: true }),
              session("remote-run-settled", { routine, live: "dormant" }),
            ]),
          ],
        }),
      ],
    });
    expect(all(buildSidebarLists(state, ""))).toEqual(["remote-coding"]);
  });

  it("surfaces a joined remote routine run awaiting approval in the attention stack and omits unreachable or non-waiting ones (#1304)", () => {
    const state = backendState({
      remoteInstances: [
        remoteInstance({
          id: "inst-fw",
          nickname: "FW-Desktop",
          status: "joined",
          projects: [
            group("/r", "omp-ui", [
              session("remote-wait", { routine, live: "live", awaitingHumanAnswer: true }),
              session("remote-idle", { routine, live: "live", awaitingHumanAnswer: false }),
              session("remote-dormant-wait", { routine, live: "dormant", awaitingHumanAnswer: true }),
            ]),
          ],
        }),
        remoteInstance({
          id: "inst-off",
          nickname: "Offline-Box",
          status: "unreachable",
          projects: [
            group("/r", "omp-ui", [
              session("offline-wait", { routine, live: "live", awaitingHumanAnswer: true }),
            ]),
          ],
        }),
      ],
    });
    const derive = (s: SessionSummary): string =>
      s.live === "live" && s.awaitingHumanAnswer === true ? "awaiting-answer" : s.live;
    const entries = buildAttentionEntries(state, {}, derive);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      state: "awaiting-answer",
      entry: {
        instanceId: "inst-fw",
        nickname: "FW-Desktop",
        session: { tabId: "remote-wait" },
      },
    });
  });

  it("drops a settled routine run from the attention stack even when marked unread, while keeping a live unmounted run in grace (#1305)", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("run-settled", { routine, live: "dormant", settledAtMs: 100 }),
          session("run-grace", { routine, live: "live", settledAtMs: null }),
          session("coding", { live: "dormant", settledAtMs: 100 }),
        ]),
      ],
    });
    const mark = { atMs: 10, snippet: "done" };
    const derive = (s: SessionSummary): string => s.live;
    const marked = buildAttentionEntries(
      state,
      { "run-settled": mark, "run-grace": mark, coding: mark },
      derive,
    );
    expect(marked.map((a) => [a.entry.session.tabId, a.state])).toEqual([["run-grace", "ready"]]);
    expect(buildAttentionEntries(state, {}, derive)).toEqual([]);
  });

  it("surfaces a routine run parked on an Approval card without any mark", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("run", { routine, awaitingHumanAnswer: true }),
          session("coding", { awaitingHumanAnswer: true }),
        ]),
      ],
    });
    const entries = buildAttentionEntries(state, {}, (s) => (s.awaitingHumanAnswer === true ? "awaiting-answer" : "live"));
    expect(entries.map((a) => [a.entry.session.tabId, a.state])).toEqual([["run", "awaiting-answer"]]);
  });

  it("drops a marked routine run while its turn is working", () => {
    const state = backendState({ projects: [group("/a", "alpha", [session("run", { routine, turnRunning: true })])] });
    expect(buildAttentionEntries(state, { run: { atMs: 1, snippet: null } }, () => "working")).toEqual([]);
  });
});

describe("Snooze reminders in Attention stack (issue #1323)", () => {
  it("surfaces local and joined-remote dormant unsettled rows with reminderAtMs, suppresses duplicate rows, and hides snoozed/settled ones", () => {
    const state = backendState({
      projects: [
        group("/a", "alpha", [
          session("local-due", { live: "dormant", settledAtMs: null, reminderAtMs: 5_000 }),
          session("local-snoozed", { live: "dormant", settledAtMs: null, snoozed: true, reminderAtMs: 6_000 }),
          session("local-settled", { live: "dormant", settledAtMs: 1_000, reminderAtMs: 7_000 }),
        ]),
      ],
      remoteInstances: [
        remoteInstance({
          id: "inst-r",
          nickname: "Remote-Box",
          status: "joined",
          projects: [
            group("/r", "beta", [
              session("remote-due", { live: "dormant", settledAtMs: null, reminderAtMs: 8_000 }),
            ]),
          ],
        }),
      ],
    });
    const entries = buildAttentionEntries(state, {}, (s) => s.live);
    expect(entries.map((a) => [a.entry.session.tabId, a.state, a.entry.instanceId])).toEqual([
      ["remote-due", "reminder", "inst-r"],
      ["local-due", "reminder", null],
    ]);

    const suppress = new Set(entries.map((a) => a.entry.session.tabId));
    const lists = buildSidebarLists(state, "", undefined, suppress);
    expect(ids(lists.active)).toEqual([]);
    expect(ids(lists.snoozed)).toEqual(["local-snoozed"]);
    expect(ids(lists.settled)).toEqual(["local-settled"]);
  });
});
