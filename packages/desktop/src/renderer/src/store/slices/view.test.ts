// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
vi.mock("../../backend", () => ({ backend: { setWindowChrome: vi.fn(async () => {}) } }));
import type { BackendState, ProjectGroup, SessionSummary } from "@omp-ui/core/types";
import type { RpcTabState, TabInfo } from "../../store";
import { backendState, remoteInstance, rpcTabState, tabInfo } from "../../test/fixtures";
import {
  createViewSlice,
  findOwner,
  findRecord,
  getNavigationGeneration,
  checkoutOccupant,
  effectiveWorkspacePolicy,
  isHomeView,
} from "./view";

const PROJECT = "/p";
const WORKTREE = "/wt/busy";

function summary(
  tabId: string,
  title: string,
  worktree: SessionSummary["worktree"] = null,
  patch: Partial<SessionSummary> = {},
): SessionSummary {
  return {
    tabId,
    sessionId: null,
    lineageDir: `omp-ui--p--${tabId}`,
    projectCwd: PROJECT,
    worktree,
    launchedAt: "t",
    mode: "rpc-ui",
    planImplementationSource: null, experiment: null, fleet: null,
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null, subagentModels: null,
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
    title,
    status: null,
    live: "live",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
    ...patch,
  };
}

function group(path: string, ...sessions: SessionSummary[]): ProjectGroup {
  return {
    project: { path, name: "p", addedAt: "t", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null },
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

describe("checkoutOccupant (Slice 2)", () => {
  it("guards a checkout a session runs in (rpc running or turnRunning)", () => {
    const s = pick(
      [summary("t1", "Busy")],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }) },
    );
    expect(checkoutOccupant(s, PROJECT)).toEqual({ tabId: "t1", title: "Busy", reason: "running" });

    const sTurn = pick(
      [summary("t1", "RemoteTurn", null, { turnRunning: true })],
      [],
      {},
    );
    expect(checkoutOccupant(sTurn, PROJECT)).toEqual({ tabId: "t1", title: "RemoteTurn", reason: "running" });
  });

  it("detects idle prompted Build sessions and live PTY sessions, while ignoring unprompted Build and Plan mode", () => {
    const idleBuild = pick(
      [summary("t1", "Idle Build", null, { sessionId: "sess-1", agentMode: "build" })],
      [],
      {},
    );
    expect(checkoutOccupant(idleBuild, PROJECT)).toEqual({
      tabId: "t1",
      title: "Idle Build",
      reason: "build-live",
    });

    const unpromptedBuild = pick(
      [summary("t1", "Blank", null, { sessionId: null, agentMode: "build" })],
      [],
      {},
    );
    expect(checkoutOccupant(unpromptedBuild, PROJECT)).toBeNull();

    const planSession = pick(
      [summary("t1", "Planner", null, { sessionId: "sess-1", agentMode: "plan" })],
      [],
      {},
    );
    expect(checkoutOccupant(planSession, PROJECT)).toBeNull();

    const ptySession = pick(
      [summary("t1", "Shell", null, { mode: "pty" })],
      [],
      {},
    );
    expect(checkoutOccupant(ptySession, PROJECT)).toEqual({
      tabId: "t1",
      title: "Shell",
      reason: "pty-live",
    });
  });

  it("decays occupancy when settled, snoozed, or dormant", () => {
    const settled = pick(
      [summary("t1", "Done", null, { sessionId: "s1", settledAtMs: 1000 })],
      [],
      {},
    );
    const snoozed = pick(
      [summary("t1", "Snoozed", null, { sessionId: "s1", snoozed: true })],
      [],
      {},
    );
    const dormant = pick(
      [summary("t1", "Dormant", null, { sessionId: "s1", live: "dormant" })],
      [],
      {},
    );
    expect(checkoutOccupant(settled, PROJECT)).toBeNull();
    expect(checkoutOccupant(snoozed, PROJECT)).toBeNull();
    expect(checkoutOccupant(dormant, PROJECT)).toBeNull();
  });

  it("ranks mid-turn running sessions ahead of idle Build or PTY sessions", () => {
    const s = pick(
      [
        summary("t1", "Idle Build", null, { sessionId: "s1" }),
        summary("t2", "MidTurn", null, { sessionId: "s2" }),
      ],
      [tabInfo({ tabId: "t2", projectCwd: PROJECT })],
      { t2: rpcTabState({ status: "running" }) },
    );
    expect(checkoutOccupant(s, PROJECT)).toEqual({ tabId: "t2", title: "MidTurn", reason: "running" });
  });

  it("does not flag the project root for a worktree session, and still guards the worktree checkout", () => {
    const s = pick(
      [summary("t1", "Busy", { path: WORKTREE, branch: "feat/busy", base: null })],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }) },
    );
    expect(checkoutOccupant(s, PROJECT)).toBeNull();
    expect(checkoutOccupant(s, WORKTREE)).toEqual({ tabId: "t1", title: "Busy", reason: "running" });
  });

  it("excludes the named tab and scopes by remote instanceId", () => {
    const s = pick(
      [summary("t1", "One"), summary("t2", "Two")],
      [tabInfo({ tabId: "t1", projectCwd: PROJECT }), tabInfo({ tabId: "t2", projectCwd: PROJECT })],
      { t1: rpcTabState({ status: "running" }), t2: rpcTabState({ status: "running" }) },
    );
    expect(checkoutOccupant(s, PROJECT, "t1")).toEqual({ tabId: "t2", title: "Two", reason: "running" });
    expect(checkoutOccupant(s, PROJECT, "t2")).toEqual({ tabId: "t1", title: "One", reason: "running" });
    expect(checkoutOccupant(s, undefined)).toBeNull();

    const remote = {
      state: backendState({
        projects: [group(PROJECT, summary("local-1", "Local", null, { sessionId: "s-l" }))],
        remoteInstances: [
          remoteInstance({
            id: "inst-a",
            projects: [group(PROJECT, summary("remote-1", "Remote", null, { sessionId: "s-r" }))],
          }),
        ],
      }),
      tabs: [],
      rpc: {},
    };
    expect(checkoutOccupant(remote, PROJECT, undefined, null)?.tabId).toBe("local-1");
    expect(checkoutOccupant(remote, PROJECT, undefined, "inst-a")?.tabId).toBe("remote-1");
  });

  it("resolves effectiveWorkspacePolicy from project override then global then auto", () => {
    const base = backendState({
      workspacePolicy: "worktree",
      projects: [
        {
          ...group(PROJECT),
          project: { ...group(PROJECT).project, workspacePolicy: "checkout" },
        },
      ],
    });
    expect(effectiveWorkspacePolicy(base, PROJECT)).toBe("checkout");
    expect(effectiveWorkspacePolicy(base, "/other")).toBe("worktree");
    expect(effectiveWorkspacePolicy(null, PROJECT)).toBe("auto");
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
});

describe("isHomeView and goHome (issue #1327)", () => {
  type HomeSnapshot = Parameters<typeof isHomeView>[0];
  const base = (patch: Partial<HomeSnapshot> = {}): HomeSnapshot => ({
    tabs: [],
    activeTabId: null,
    artifacts: null,
    routinesOpen: false,
    lab: null,
    stats: null,
    fleet: null,
    fleetTerminal: null,
    state: backendState(),
    ...patch,
  });

  it("is true only when no visible tab and no active full-pane overlay is shown", () => {
    expect(isHomeView(base())).toBe(true);

    // Visible active tab hides Welcome; hidden active tab leaves Welcome showing.
    expect(
      isHomeView(
        base({
          tabs: [tabInfo({ tabId: "t1", hidden: false })],
          activeTabId: "t1",
        }),
      ),
    ).toBe(false);
    expect(
      isHomeView(
        base({
          tabs: [tabInfo({ tabId: "t1", hidden: true })],
          activeTabId: "t1",
        }),
      ),
    ).toBe(true);

    // Gated overlays only hide Welcome while their feature gate is enabled.
    expect(
      isHomeView(
        base({
          artifacts: { artifactId: null },
          state: backendState({ artifactLibraryEnabled: false }),
        }),
      ),
    ).toBe(true);
    expect(
      isHomeView(
        base({
          artifacts: { artifactId: null },
          state: backendState({ artifactLibraryEnabled: true }),
        }),
      ),
    ).toBe(false);

    expect(
      isHomeView(
        base({
          routinesOpen: true,
          state: backendState({ routinesEnabled: false }),
        }),
      ),
    ).toBe(true);
    expect(
      isHomeView(
        base({
          routinesOpen: true,
          state: backendState({ routinesEnabled: true }),
        }),
      ),
    ).toBe(false);
    expect(
      isHomeView(
        base({
          routinesOpen: true,
          state: backendState({
            routinesEnabled: false,
            remoteInstances: [remoteInstance({ id: "inst-a", routinesEnabled: true })],
          }),
        }),
      ),
    ).toBe(false);

    expect(
      isHomeView(
        base({
          lab: { projectCwd: null, instanceId: null, experiment: null },
          state: backendState({ experimentsEnabled: false }),
        }),
      ),
    ).toBe(true);
    expect(
      isHomeView(
        base({
          lab: { projectCwd: null, instanceId: null, experiment: null },
          state: backendState({ experimentsEnabled: true }),
        }),
      ),
    ).toBe(false);

    expect(
      isHomeView(
        base({
          stats: { rangeDays: 7, projectKey: null, provider: null, model: null, agentType: null },
        }),
      ),
    ).toBe(false);
    expect(
      isHomeView(
        base({
          fleet: { machines: null, loading: false, error: null, audit: null, updateAll: null },
        }),
      ),
    ).toBe(false);

    // A stale fleetTerminal id not in state.fleetTerminals does not block Welcome.
    expect(isHomeView(base({ fleetTerminal: "ft-gone" }))).toBe(true);
    expect(
      isHomeView(
        base({
          fleetTerminal: "ft-live",
          state: backendState({
            fleetTerminals: [
              {
                terminalId: "ft-live",
                machineKey: "inst-a",
                nickname: "studio",
                openedAt: "2026-11-24T00:00:00Z",
                exitCode: null,
              },
            ],
          }),
        }),
      ),
    ).toBe(false);
  });

  it("goHome clears activeTabId and every overlay, stops Lab, bumps nav generation, and keeps tabs", () => {
    const tabs = [tabInfo({ tabId: "t1", hidden: false })];
    const closeLab = vi.fn();
    const state: Record<string, unknown> = {
      tabs,
      activeTabId: "t1",
      lab: { projectCwd: null, instanceId: null, experiment: null },
      stats: { projectCwd: null, instanceId: null },
      fleet: { focusMachineId: null },
      fleetTerminal: "ft-1",
      artifacts: { artifactId: "a1" },
      routinesOpen: true,
      routineFocusId: "r1",
      closeLab,
    };
    const set = (
      partial: Record<string, unknown> | ((s: Record<string, unknown>) => Record<string, unknown>),
    ) => {
      Object.assign(state, typeof partial === "function" ? partial(state) : partial);
    };
    const get = () => state;
    const slice = createViewSlice(set as never, get as never, {} as never);
    const genBefore = getNavigationGeneration();

    slice.goHome();

    expect(closeLab).toHaveBeenCalledOnce();
    expect(getNavigationGeneration()).toBeGreaterThan(genBefore);
    expect(state).toMatchObject({
      tabs,
      activeTabId: null,
      lab: null,
      stats: null,
      fleet: null,
      fleetTerminal: null,
      artifacts: null,
      routinesOpen: false,
      routineFocusId: null,
    });

    // Calling goHome when lab is already null does not invoke closeLab again.
    closeLab.mockClear();
    slice.goHome();
    expect(closeLab).not.toHaveBeenCalled();
  });
});
