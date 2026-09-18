// Lab slice tests (issue #559): the New experiment launch sequence, its
import { beforeEach, describe, expect, it } from "vitest";
import type { ProjectExperiments } from "@omp-ui/core/types";
import { rpcTabState, tabInfo } from "../../test/fixtures";
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
  brief: null,
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
    state: { ...h.backendState, experimentsEnabled: true },
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

describe("experiment proposal gate (issue #567)", () => {
  const proposal = {
    goal: "faster",
    metric: "t",
    unit: "ms",
    direction: "lower" as const,
    command: null,
    scopePaths: ["src/"],
    offLimits: [],
    constraints: [],
    maxIterations: null,
    brief: null,
  };
  const frame = { type: "extension_ui_request", id: "gate-1", method: "select", title: "sentinel" };

  beforeEach(() => {
    h.sent.length = 0;
  });

  it("Launch answers the held gate after the spawn resolves, with the spec as launched", async () => {
    seed();
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      rpc: { [h.TAB]: rpcTabState({ experimentProposal: { proposal, frame } }) },
    });
    const launch = h.useStore.getState().newExperiment("/p", spec(), null, { tabId: h.TAB });
    await h.flushMicrotasks();
    // Spawn has resolved; the answer carries the minted branch.
    const response = h.sent.find((s) => s.cmd.type === "extension_ui_response");
    expect(response).toBeDefined();
    expect(response!.cmd).toMatchObject({ id: "gate-1" });
    const value = String(response!.cmd.value);
    expect(value.startsWith("launched:")).toBe(true);
    const launched = JSON.parse(value.slice("launched:".length));
    expect(launched).toMatchObject({
      goal: "Reduce p95 latency of /search!",
      metric: "p95_ms",
      branch: "autoresearch/reduce-p95-latency-of-search/0badf00d",
      brief: null,
    });
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).toBeNull();
    // The process never boots here; stop the launch's readiness poll.
    h.useStore.setState({ exited: { [FRESH]: 1 } });
    await launch;
  });

  it("a rejected spawn leaves the gate pending and sends nothing", async () => {
    seed();
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      rpc: { [h.TAB]: rpcTabState({ experimentProposal: { proposal, frame } }) },
    });
    h.mockBackend.spawnSession.mockRejectedValueOnce(new Error("fatal: branch exists"));
    await expect(
      h.useStore.getState().newExperiment("/p", spec(), null, { tabId: h.TAB }),
    ).rejects.toThrow("branch exists");
    expect(h.sent.filter((s) => s.cmd.type === "extension_ui_response")).toEqual([]);
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).not.toBeNull();
  });

  it("answerExperimentProposal sends, skips an exited tab, and refuses when none is held", () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB })],
      rpc: { [h.TAB]: rpcTabState({ experimentProposal: { proposal, frame } }) },
    });
    expect(h.useStore.getState().answerExperimentProposal(h.TAB, "revise")).toBe(true);
    expect(h.sent).toEqual([
      { tabId: h.TAB, cmd: { type: "extension_ui_response", id: "gate-1", value: "revise" } },
    ]);
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).toBeNull();
    expect(h.useStore.getState().answerExperimentProposal(h.TAB, "revise")).toBe(false);
    expect(h.sent).toHaveLength(1);

    h.useStore.setState({
      exited: { [h.TAB]: 1 },
      rpc: { [h.TAB]: rpcTabState({ experimentProposal: { proposal, frame } }) },
    });
    h.sent.length = 0;
    expect(h.useStore.getState().answerExperimentProposal(h.TAB, "revise")).toBe(true);
    expect(h.sent).toEqual([]);
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).toBeNull();
  });

  it("closeExperimentDialog opens the next held proposal", () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" }), tabInfo({ tabId: "tab-2", projectCwd: "/q" })],
      rpc: {
        [h.TAB]: rpcTabState({ experimentProposal: { proposal, frame } }),
        "tab-2": rpcTabState({ experimentProposal: { proposal, frame: { ...frame, id: "gate-2" } } }),
      },
      experimentDialog: { projectCwd: "/p", instanceId: null, proposalTabId: h.TAB },
    });
    // Answering the open one and then closing hands the queue to tab-2.
    expect(h.useStore.getState().answerExperimentProposal(h.TAB, "revise")).toBe(true);
    h.useStore.getState().closeExperimentDialog();
    expect(h.useStore.getState().experimentDialog).toEqual({
      projectCwd: "/q",
      instanceId: null,
      proposalTabId: "tab-2",
    });
  });

  it("acceptExperimentProposal holds it and opens the dialog only when none is open", () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      rpc: { [h.TAB]: rpcTabState() },
      experimentDialog: null,
    });
    h.useStore.getState().acceptExperimentProposal(h.TAB, proposal, frame);
    expect(h.useStore.getState().rpc[h.TAB]!.experimentProposal).toMatchObject({ frame });
    expect(h.useStore.getState().experimentDialog).toEqual({
      projectCwd: "/p",
      instanceId: null,
      proposalTabId: h.TAB,
    });
    // A second tab proposing while the dialog is open is held, not swapped in.
    h.useStore.setState({
      tabs: [...h.useStore.getState().tabs, tabInfo({ tabId: "tab-2", projectCwd: "/q" })],
      rpc: { ...h.useStore.getState().rpc, "tab-2": rpcTabState() },
    });
    h.useStore.getState().acceptExperimentProposal("tab-2", proposal, { ...frame, id: "gate-2" });
    expect(h.useStore.getState().rpc["tab-2"]!.experimentProposal).not.toBeNull();
    expect(h.useStore.getState().experimentDialog).toMatchObject({ proposalTabId: h.TAB });
  });

  it("startExperimentInterview in a tab prompts it and spawns nothing", async () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      rpc: { [h.TAB]: rpcTabState() },
      experimentDialog: { projectCwd: "/p", instanceId: null },
    });
    const run = h.useStore.getState().startExperimentInterview("/p", null, "make tests faster", h.TAB);
    // The send precedes the command ack: the frame is already on the wire.
    expect(h.mockBackend.spawnSession).not.toHaveBeenCalled();
    expect(h.useStore.getState().experimentDialog).toBeNull();
    const prompts = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]!.cmd.message)).toContain("make tests faster");
    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await run;
  });

  it("startExperimentInterview in a fresh session spawns, mounts, focuses, then prompts on ready", async () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
      tabs: [],
      activeTabId: null,
      focusedTabByProject: {},
      rpc: {},
      experimentDialog: { projectCwd: "/p", instanceId: null },
    });
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: FRESH });
    const run = h.useStore.getState().startExperimentInterview("/p", null, "go");
    await h.flushMicrotasks();
    expect(h.mockBackend.spawnSession).toHaveBeenCalledWith(
      expect.objectContaining({ origin: "new", projectCwd: "/p", mode: "rpc-ui", worktree: null }),
    );
    const mounted = h.useStore.getState();
    expect(mounted.tabs.map((tab) => tab.tabId)).toEqual([FRESH]);
    expect(mounted.activeTabId).toBe(FRESH);
    // Nothing is sent before the tab is ready.
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toEqual([]);
    h.useStore.setState({ rpc: { [FRESH]: rpcTabState({ hasRenamed: true }) } });
    await h.flushMicrotasks();
    const prompts = h.sent.filter((s) => s.cmd.type === "prompt");
    expect(prompts).toHaveLength(1);
    expect(String(prompts[0]!.cmd.message)).toContain("propose_experiment");
    for (const { tabId, cmd } of h.sent.splice(0)) h.respond(tabId, cmd, {});
    await run;
  });

  it("startExperimentInterview reports an unmountable bridge and sends nothing", async () => {
    h.useStore.setState({
      tabs: [tabInfo({ tabId: h.TAB, projectCwd: "/p" })],
      rpc: {
        [h.TAB]: rpcTabState({
          autoresearch: {
            version: 1, processKey: "p", sessionId: "s", revision: 1, available: true, unavailable: null,
            mode: "off", goal: null, goalTruncated: false, lastTool: null,
            proposeUnavailable: "pi.registerTool is missing",
          },
        }),
      },
    });
    await h.useStore.getState().startExperimentInterview("/p", null, "go", h.TAB);
    expect(h.sent).toEqual([]);
    expect(h.errorMessages().at(-1)).toContain("pi.registerTool is missing");
  });

  it("a spawn that dies before ready prompts nothing", async () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
      tabs: [],
      rpc: {},
    });
    h.mockBackend.spawnSession.mockResolvedValueOnce({ tabId: FRESH });
    const run = h.useStore.getState().startExperimentInterview("/p", null, "go");
    await h.flushMicrotasks();
    h.useStore.setState({ exited: { [FRESH]: 1 } });
    await run;
    expect(h.sent.filter((s) => s.cmd.type === "prompt")).toEqual([]);
  });

  it("a failed fresh spawn becomes an error notice, not a throw", async () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({
      state: h.backendState,
      advisorDefaults: { "/p": { enabled: false, model: null } },
      tabs: [],
      rpc: {},
    });
    h.mockBackend.spawnSession.mockRejectedValueOnce(new Error("spawn exploded"));
    await h.useStore.getState().startExperimentInterview("/p", null, "go");
    expect(h.errorMessages().at(-1)).toContain("spawn exploded");
    expect(h.useStore.getState().tabs).toEqual([]);
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
      state: { ...h.backendState, experimentsEnabled: true },
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

  it("leaves lab null when openLab runs with the flag off", () => {
    h.backendState = h.stateWithRecord("sess-1", "dormant");
    h.useStore.setState({ state: h.backendState, tabs: [], rpc: {} });
    h.useStore.getState().openLab("/p", null);
    expect(h.useStore.getState().lab).toBeNull();
    h.useStore.getState().openExperimentDialog("/p", null);
    expect(h.useStore.getState().experimentDialog).toBeNull();
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
