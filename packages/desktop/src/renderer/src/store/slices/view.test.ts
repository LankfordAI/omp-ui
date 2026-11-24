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
  isHomeView,
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
