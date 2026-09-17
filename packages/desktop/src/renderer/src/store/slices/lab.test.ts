// Lab slice tests (issue #559): the New experiment launch sequence, its
// refusal paths, and the overview cache's generation guard.
import { describe, expect, it } from "vitest";
import type { ProjectExperiments } from "@omp-ui/core/types";
import { rpcTabState } from "../../test/fixtures";
import { h } from "../../test/store-harness";
import type { NewExperimentSpec } from "../types";
import { focusOn } from "./view";

const FRESH = "exp-1";

const spec = (patch: Partial<NewExperimentSpec> = {}): NewExperimentSpec => ({
  goal: "Reduce p95 latency of /search!",
  metric: "p95_ms",
  unit: "ms",
  direction: "lower",
  command: "npm run bench",
  scopePaths: ["src/"],
  offLimits: [],
  constraints: [],
  maxIterations: null,
  model: null,
  worktree: {
    mint: { branch: "autoresearch/reduce-p95-latency-of-search/0badf00d", baseRef: "main", baseBranch: null },
  },
  ...patch,
});

const overview = (patch: Partial<ProjectExperiments> = {}): ProjectExperiments => ({
  projectCwd: "/p",
  repo: "git",
  checkouts: [],
  pendingLaunches: [],
  ...patch,
});

/** Seeds a registered project with no live tabs and a spawn that lands on FRESH. */
function seed(): void {
  h.backendState = h.stateWithRecord("sess-1", "dormant");
  h.useStore.setState({
    state: h.backendState,
    advisorDefaults: { "/p": { enabled: false, model: null } },
    experimentDialog: { projectCwd: "/p", instanceId: null },
  });
  h.mockBackend.spawnSession.mockResolvedValue({ tabId: FRESH });
}

/** Answers every command the launch has sent so far, returning their wire messages. */
function answerSent(): string[] {
  return h.sent.splice(0).map(({ tabId, cmd }) => {
    h.respond(tabId, cmd, {});
    return String(cmd.message);
  });
}

describe("newExperiment", () => {
  it("spawns the worktree session with provenance, arms /autoresearch, then sends the kickoff", async () => {
    seed();
    const launch = h.useStore.getState().newExperiment("/p", spec());
    await h.flushMicrotasks();

    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith({
      origin: "new",
      projectCwd: "/p",
      mode: "rpc-ui",
      advisor: false,
      advisorModel: null,
      cols: 80,
      rows: 24,
      planMode: false,
      worktree: spec().worktree,
      experiment: {
        goal: "Reduce p95 latency of /search!",
        metric: "p95_ms",
        unit: "ms",
        direction: "lower",
        launchedBranch: "autoresearch/reduce-p95-latency-of-search/0badf00d",
        launchedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      },
    });
    const mounted = h.useStore.getState();
    expect(mounted.tabs.map((tab) => tab.tabId)).toEqual([FRESH]);
    expect(mounted.activeTabId).toBe(FRESH);
    expect(mounted.experimentDialog).toBeNull();
    // Nothing goes to omp before the process reports ready.
    expect(h.sent).toEqual([]);

    // The fresh tab boots: readiness releases the launch.
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState({ hasRenamed: true }) } });
    await h.flushMicrotasks();
    expect(answerSent()).toEqual(["/autoresearch"]);
    await h.flushMicrotasks();
    const [kickoff] = answerSent();
    expect(kickoff).toMatch(/^Autoresearch experiment: Reduce p95 latency of \/search!\n/);
    expect(kickoff).toContain('init_experiment with name "reduce-p95-latency-of-search"');
    expect(kickoff).toContain('preferred_command "npm run bench", scope_paths ["src/"]');
    await launch;
    expect(h.sent).toEqual([]);
  });

  it("applies the picked model before arming, and stops when that fails", async () => {
    seed();
    const picked = { id: "opus", name: "Opus", provider: "anthropic" };
    const launch = h.useStore.getState().newExperiment("/p", spec({ model: picked }));
    await h.flushMicrotasks();
    h.useStore.setState({
      rpc: { [FRESH]: rpcTabState({ hasRenamed: true, model: { id: "sonnet", name: "Sonnet", provider: "anthropic" } }) },
    });
    await h.flushMicrotasks();
    const [setModel] = h.sent.splice(0);
    expect(setModel?.cmd).toMatchObject({ type: "set_model", provider: "anthropic", modelId: "opus" });
    h.respond(FRESH, setModel!.cmd, "boom", false);
    await launch;
    expect(h.sent).toEqual([]);
  });

  it("propagates a rejected spawn and sends nothing", async () => {
    seed();
    h.mockBackend.spawnSession.mockRejectedValueOnce(new Error("fatal: branch exists"));
    await expect(h.useStore.getState().newExperiment("/p", spec())).rejects.toThrow("branch exists");
    expect(h.useStore.getState().tabs).toEqual([]);
    expect(h.useStore.getState().experimentDialog).not.toBeNull();
    expect(h.sent).toEqual([]);
  });

  it("records the project checkout's branch as provenance when launching without a worktree", async () => {
    seed();
    h.useStore.setState({
      branches: {
        "/p": {
          repoRoot: "/p",
          current: "main",
          branches: ["main"],
          defaultBranch: "main",
          upstreamRef: null,
          upstreamRemote: null,
          hasUpstream: false,
          ahead: 0,
          behind: 0,
          upstreamFetchedAt: null,
          upstreamRefreshError: null,
          defaultRemote: null,
        },
      },
    });
    const launch = h.useStore.getState().newExperiment("/p", spec({ worktree: null }));
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({
        worktree: null,
        experiment: expect.objectContaining({ launchedBranch: "main" }),
      }),
    );
    // The process dies before ready: the launch gives up without prompting.
    h.useStore.setState({ exited: { [FRESH]: 1 } });
    await launch;
    expect(h.sent).toEqual([]);
  });
});

describe("Lab view", () => {
  it("focusOn closes the Lab", () => {
    expect(focusOn({ activeTabId: null, focusedTabByProject: {} }, h.TAB, "/p")).toEqual({
      activeTabId: h.TAB,
      focusedTabByProject: { "/p": h.TAB },
      lab: null,
    });
  });

  it("opens the detail of a tab's linked experiment when the cache knows it", () => {
    h.backendState = h.stateWithRecord("sess-1", "live", {
      path: "/wt",
      branch: "autoresearch/x/0badf00d",
      base: "main",
    });
    const record = {
      id: 7,
      name: "x",
      goal: null,
      primaryMetric: "m",
      metricUnit: "",
      direction: "lower" as const,
      preferredCommand: null,
      branch: "autoresearch/x/0badf00d",
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
    };
    h.useStore.setState({
      state: h.backendState,
      tabs: [{ tabId: h.TAB, mode: "rpc-ui", projectCwd: "/p", hidden: false, instanceId: null }],
      activeTabId: h.TAB,
      experiments: {
        "/p": {
          load: "ready",
          error: null,
          revision: 1,
          detail: {},
          result: overview({
            checkouts: [
              {
                cwd: "/wt",
                tabId: h.TAB,
                branch: record.branch,
                result: { source: null, experiments: [record], error: null },
              },
            ],
          }),
        },
      },
    });
    h.useStore.getState().openLab(null, null, { tabId: h.TAB });
    const st = h.useStore.getState();
    expect(st.lab).toEqual({
      projectCwd: "/p",
      instanceId: null,
      experiment: { projectCwd: "/p", instanceId: null, tabId: h.TAB, experimentId: 7 },
    });
    // The Lab is a main-pane surface over the tabs, not a replacement for focus.
    expect(st.activeTabId).toBe(h.TAB);
    expect(h.mockBackend.autoresearchExperiment).toHaveBeenCalledWith("/p", h.TAB, 7);
    h.useStore.getState().closeLab();
    expect(h.useStore.getState().lab).toBeNull();
  });
});

describe("stopExperiment / startNewSegment", () => {
  it("refuses a dormant session with a notice and sends nothing", async () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpcTabState() } });
    await h.useStore.getState().stopExperiment(h.TAB);
    await h.useStore.getState().startNewSegment(h.TAB);
    expect(h.errorMessages()).toHaveLength(2);
    expect(h.sent).toEqual([]);
  });

  it("sends /autoresearch off to a live native session", async () => {
    h.backendState = h.stateWithRecord("sess-1");
    h.useStore.setState({ state: h.backendState, rpc: { [h.TAB]: rpcTabState() } });
    const stop = h.useStore.getState().stopExperiment(h.TAB);
    await h.flushMicrotasks();
    expect(answerSent()).toEqual(["/autoresearch off"]);
    await stop;
    expect(h.errorMessages()).toEqual([]);
  });
});

describe("loadExperiments", () => {
  it("ignores a late reply from an older request", async () => {
    const first = h.deferred<ProjectExperiments>();
    const second = h.deferred<ProjectExperiments>();
    h.mockBackend.autoresearchOverview
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const store = h.useStore.getState();
    const a = store.loadExperiments("/p");
    const b = store.loadExperiments("/p");
    expect(h.useStore.getState().experiments["/p"]?.load).toBe("loading");

    second.resolve(overview({ repo: "none" }));
    await b;
    expect(h.useStore.getState().experiments["/p"]).toMatchObject({
      load: "ready",
      revision: 1,
      result: { repo: "none" },
    });

    first.resolve(overview({ repo: "jj-only" }));
    await a;
    expect(h.useStore.getState().experiments["/p"]).toMatchObject({ revision: 1, result: { repo: "none" } });
  });

  it("keeps the previous answer and records the message when a read fails", async () => {
    h.mockBackend.autoresearchOverview.mockResolvedValueOnce(overview());
    await h.useStore.getState().loadExperiments("/p");
    h.mockBackend.autoresearchOverview.mockRejectedValueOnce(new Error("sqlite locked"));
    await h.useStore.getState().loadExperiments("/p");
    expect(h.useStore.getState().experiments["/p"]).toMatchObject({
      load: "error",
      error: "sqlite locked",
      result: { repo: "git" },
    });
  });
});
