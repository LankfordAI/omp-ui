import { describe, expect, it, vi } from "vitest";
import {
  CH,
  LOCAL_MACHINE_KEY,
  type FleetDispatchRequest,
  type FleetHostProject,
  type FleetHostReport,
  type FleetSendRequest,
  type NewRpcSpawnRequest,
  type RemoteInstanceSummary,
  type SessionSummary,
} from "@omp-ui/core";
import { FleetDispatcher, type FleetDispatcherDeps } from "./fleet-dispatcher";

const NOW = 1_000_000;

function project(patch: Partial<FleetHostProject> = {}): FleetHostProject {
  return {
    path: "/work/app",
    name: "app",
    repositoryKey: "github.com/acme/app",
    headCommit: "abc",
    providerReady: true,
    advisor: false,
    advisorModel: null,
    ...patch,
  };
}

function report(projects: FleetHostProject[], patch: Partial<FleetHostReport> = {}): FleetHostReport {
  return {
    instanceId: "id",
    label: "host",
    version: "1.0.0",
    platform: "linux",
    arch: "x64",
    cpuCount: 8,
    cpuUtilization: 0.1,
    totalMemoryBytes: 100,
    availableMemoryBytes: 80,
    liveSessions: 0,
    runningTurns: 0,
    sampledAt: NOW,
    projects,
    user: "austin",
    projectRoots: [],
    os: { name: "Fedora Linux 44 (Workstation Edition)", version: "44" },
    packageManagers: [{ name: "dnf", path: "/usr/bin/dnf", onPath: true }],
    ompVersion: null,
    ompPath: null,
    ompPinned: false,
    ompBelowMinimum: false,
    packageFormat: null,
    appLatestVersion: null,
    appUpdateStaged: false,
    modelFavorites: [],
    ...patch,
  };
}

function remote(id: string, patch: Partial<RemoteInstanceSummary> = {}): RemoteInstanceSummary {
  return {
    id,
    nickname: `box-${id}`,
    url: `http://${id}:4677`,
    status: "joined",
    error: null,
    version: "1.0.0",
    projects: [],
    modelFavorites: [],
    ...patch,
  };
}

interface Harness {
  dispatcher: FleetDispatcher;
  spawnLocal: ReturnType<typeof vi.fn<(req: NewRpcSpawnRequest) => Promise<{ tabId: string }>>>;
  request: ReturnType<typeof vi.fn<(id: string, channel: string, args: unknown[]) => Promise<unknown>>>;
  known: Set<string>;
  broadcasts: number;
}

/** `remotes` maps an instance id to its host-report answer (or rejection) and session:spawn answer. */
function harness(opts: {
  local: FleetHostReport;
  remotes?: Record<string, { report: () => Promise<FleetHostReport>; spawn?: (req: NewRpcSpawnRequest) => Promise<unknown> }>;
  deps?: Partial<FleetDispatcherDeps>;
}): Harness {
  let ids = 0;
  const known = new Set<string>();
  const remotes = opts.remotes ?? {};
  const h: Harness = {
    dispatcher: undefined as unknown as FleetDispatcher,
    spawnLocal: vi.fn(async () => ({ tabId: `local-tab-${++ids}` })),
    request: vi.fn(async (id: string, channel: string, args: unknown[]) => {
      const r = remotes[id]!;
      if (channel === CH.fleetHostReport) return r.report();
      if (channel === CH.spawnSession) return r.spawn!(args[0] as NewRpcSpawnRequest);
      throw new Error(`unexpected ${channel}`);
    }),
    known,
    broadcasts: 0,
  };
  const deps: FleetDispatcherDeps = {
    localReport: async () => opts.local,
    spawnLocal: h.spawnLocal,
    remotes: () => Object.keys(remotes).map((id) => remote(id)),
    request: h.request,
    preferences: () => ({}),
    requesterBase: () => ({ instanceId: "dispatcher", label: "desk" }),
    knownDispatchIds: () => known,
    fleetSessions: async () => [],
    localSummary: async () => "",
    broadcast: async () => {
      h.broadcasts += 1;
    },
    probeSsh: async () => true,
    providerKeyValue: () => null,
    watchAgentDispatch: () => {},
    nextBroadcast: async () => {},
    sendLocal: async () => ({ status: "delivered" }),
    now: () => NOW,
    uuid: () => `id-${++ids}`,
    ...opts.deps,
  };
  h.dispatcher = new FleetDispatcher(deps);
  return h;
}

function explicit(picks: Array<{ machineKey: string; projectCwd: string }>, workspace: "worktree" | "checkout" = "worktree"): FleetDispatchRequest {
  return { targets: { kind: "explicit", picks }, prompt: "Fix the flaky test", title: null, workspace, planMode: false };
}

function spawnsTo(h: Harness, id: string): NewRpcSpawnRequest[] {
  return h.request.mock.calls.filter(([to, ch]) => to === id && ch === CH.spawnSession).map(([, , args]) => args[0] as NewRpcSpawnRequest);
}

describe("FleetDispatcher", () => {
  it("turns a lost remote connection into an unknown outcome held in pending, never re-sent", async () => {
    const h = harness({
      local: report([project()]),
      remotes: {
        r1: {
          report: async () => report([project({ path: "/srv/app" })]),
          spawn: async () => {
            throw new Error("remote connection lost");
          },
        },
      },
    });
    const result = await h.dispatcher.dispatch(explicit([{ machineKey: "r1", projectCwd: "/srv/app" }]), { kind: "user" });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ machineKey: "r1", status: "unknown", message: expect.stringContaining("remote connection lost") }),
    ]);
    const [pending] = h.dispatcher.pending();
    expect(pending).toMatchObject({ dispatchId: result.outcomes[0]!.dispatchId, machineKey: "r1", nickname: "box-r1", projectCwd: "/srv/app", title: "Fix the flaky test" });
    expect(h.broadcasts).toBe(1);
    expect(spawnsTo(h, "r1")).toHaveLength(1);
    await h.dispatcher.machines();
    h.dispatcher.pending();
    expect(spawnsTo(h, "r1")).toHaveLength(1);
  });

  it("drops a pending entry once a session carrying its dispatchId is known", async () => {
    const h = harness({
      local: report([project()]),
      remotes: {
        r1: {
          report: async () => report([project({ path: "/srv/app" })]),
          spawn: async () => {
            throw new Error("remote connection lost");
          },
        },
      },
    });
    const result = await h.dispatcher.dispatch(explicit([{ machineKey: "r1", projectCwd: "/srv/app" }]), { kind: "user" });
    expect(h.dispatcher.pending()).toHaveLength(1);

    h.known.add(result.outcomes[0]!.dispatchId);
    expect(h.dispatcher.pending()).toEqual([]);
  });

  it("reports a member without fleet:hostReport as unsupported", async () => {
    const h = harness({
      local: report([project()]),
      remotes: {
        old: {
          report: async () => {
            throw new Error("unknown channel fleet:hostReport");
          },
        },
      },
    });
    const [local, old] = await h.dispatcher.machines();
    expect(local).toMatchObject({ key: LOCAL_MACHINE_KEY, status: "ready", nickname: null, receivedAt: NOW });
    expect(old).toMatchObject({ key: "old", status: "unsupported", error: "update omp-ui on this instance to use Fleet", report: null });
  });

  it("auto placement skips machines with another repository or no ready model provider", async () => {
    const h = harness({
      // The reference is busy, so it scores below every eligible remote.
      local: report([project()], { cpuUtilization: 0.9 }),
      remotes: {
        other: { report: async () => report([project({ path: "/srv/other", repositoryKey: "github.com/acme/other" })]) },
        nokey: { report: async () => report([project({ path: "/srv/app", providerReady: false })]) },
        good: { report: async () => report([project({ path: "/srv/app-clone" })]), spawn: async () => ({ tabId: "good-tab" }) },
      },
    });
    const reference = { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" };
    const req: FleetDispatchRequest = {
      targets: { kind: "auto", reference, count: 2 },
      prompt: "Fix it",
      title: null,
      workspace: "worktree",
      planMode: false,
    };
    const result = await h.dispatcher.dispatch(req, { kind: "user" });

    expect(result.outcomes.map((o) => [o.machineKey, o.projectCwd, o.status])).toEqual([
      ["good", "/srv/app-clone", "started"],
      [LOCAL_MACHINE_KEY, "/work/app", "started"],
    ]);
    expect(spawnsTo(h, "other")).toEqual([]);
    expect(spawnsTo(h, "nokey")).toEqual([]);
    await expect(h.dispatcher.dispatch({ ...req, targets: { kind: "auto", reference, count: 3 } }, { kind: "user" })).rejects.toThrow(
      "Only 2 fleet machines can take this work now",
    );
  });

  it("mints a distinct worktree branch for each explicit pick on one machine", async () => {
    const h = harness({ local: report([project()]) });
    const pick = { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" };
    const result = await h.dispatcher.dispatch(explicit([pick, pick, pick]), { kind: "user" });

    expect(result.batchId).not.toBeNull();
    expect(result.outcomes.every((o) => o.status === "started")).toBe(true);
    const branches = h.spawnLocal.mock.calls.map(([req]) =>
      req.worktree !== null && "mint" in req.worktree ? req.worktree.mint.branch : null,
    );
    expect(branches).toHaveLength(3);
    expect(new Set(branches).size).toBe(3);
    for (const branch of branches) expect(branch).toMatch(/^app\/[0-9a-f]{8}$/);
    expect(new Set(h.spawnLocal.mock.calls.map(([req]) => req.fleet!.dispatchId)).size).toBe(3);
    expect(new Set(h.spawnLocal.mock.calls.map(([req]) => req.fleet!.batchId))).toEqual(new Set([result.batchId]));
  });

  it("turns targets still unsettled at the deadline into unknown outcomes", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        local: report([project()]),
        remotes: {
          slow: { report: async () => report([project({ path: "/srv/app" })]), spawn: () => new Promise(() => {}) },
        },
      });
      const pending = h.dispatcher.dispatch(
        explicit([
          { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" },
          { machineKey: "slow", projectCwd: "/srv/app" },
        ]),
        { kind: "agent", sourceTabId: "agent-tab" },
        { deadlineMs: 45_000 },
      );
      await vi.advanceTimersByTimeAsync(45_000);
      const result = await pending;

      expect(result.outcomes.map((o) => [o.machineKey, o.status])).toEqual([
        [LOCAL_MACHINE_KEY, "started"],
        ["slow", "unknown"],
      ]);
      expect(h.dispatcher.pending().map((p) => p.machineKey)).toEqual(["slow"]);
      expect(spawnsTo(h, "slow")[0]!.fleet!.requestedBy).toEqual({
        instanceId: "dispatcher",
        label: "desk",
        kind: "agent",
        sourceTabId: "agent-tab",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("bounds a user dispatch whose remote spawn never answers (issue #907)", async () => {
    vi.useFakeTimers();
    try {
      const h = harness({
        local: report([project()]),
        remotes: {
          slow: { report: async () => report([project({ path: "/srv/app" })]), spawn: () => new Promise(() => {}) },
        },
      });
      const pending = h.dispatcher.dispatch(explicit([{ machineKey: "slow", projectCwd: "/srv/app" }]), { kind: "user" });
      await vi.advanceTimersByTimeAsync(90_000);
      const result = await pending;

      expect(result.outcomes).toEqual([
        expect.objectContaining({
          machineKey: "slow",
          status: "unknown",
          message: "no answer within 90 s; the session may still start",
        }),
      ]);
      expect(h.dispatcher.pending().map((p) => p.machineKey)).toEqual(["slow"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a retry re-sends with both the original dispatchId and batchId", async () => {
    const h = harness({
      local: report([project()]),
      remotes: { r1: { report: async () => report([project({ path: "/srv/app" })]), spawn: async () => ({ tabId: "r1-tab" }) } },
    });
    const result = await h.dispatcher.dispatch(
      { ...explicit([{ machineKey: "r1", projectCwd: "/srv/app" }]), retryOf: { dispatchId: "d-original", batchId: "b-original" } },
      { kind: "user" },
    );

    expect(result).toEqual({
      batchId: "b-original",
      outcomes: [{ dispatchId: "d-original", machineKey: "r1", projectCwd: "/srv/app", status: "started", tabId: "r1-tab", choice: null }],
    });
    expect(spawnsTo(h, "r1")[0]!.fleet).toMatchObject({ dispatchId: "d-original", batchId: "b-original" });
  });

  describe("dispatch model choice (#956)", () => {
    it("carries model and thinkingLevel in spawn.fleet only when requested", async () => {
      const h = harness({ local: report([project()]) });
      const pick = { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" };
      await h.dispatcher.dispatch({ ...explicit([pick]), model: "openrouter/openai/gpt-5.6-luna", thinkingLevel: "low" }, { kind: "user" });
      await h.dispatcher.dispatch(explicit([pick]), { kind: "user" });

      const [chosen, bare] = h.spawnLocal.mock.calls.map(([spawn]) => spawn);
      expect(chosen!.fleet).toMatchObject({ model: "openrouter/openai/gpt-5.6-luna", thinkingLevel: "low" });
      expect(Object.keys(bare!.fleet!)).not.toContain("model");
      expect(Object.keys(bare!.fleet!)).not.toContain("thinkingLevel");
    });

    it("fails an explicit choice on a member that predates #956 without sending it", async () => {
      const { modelFavorites: _modelFavorites, ...older } = report([project({ path: "/srv/app" })]);
      const h = harness({
        local: report([project()]),
        remotes: { r1: { report: async () => older as FleetHostReport, spawn: async () => ({ tabId: "r1-tab" }) } },
      });
      const result = await h.dispatcher.dispatch(
        { ...explicit([{ machineKey: "r1", projectCwd: "/srv/app" }]), model: "openrouter/openai/gpt-5.6-luna" },
        { kind: "user" },
      );

      expect(result.outcomes).toEqual([
        expect.objectContaining({
          status: "failed",
          message: "box-r1 runs an omp-ui without dispatch model selection; update omp-ui there",
        }),
      ]);
      expect(spawnsTo(h, "r1")).toEqual([]);
    });

    it("auto placement with a model skips a member that predates #956", async () => {
      const { modelFavorites: _modelFavorites, ...older } = report([project({ path: "/srv/app-old" })]);
      const h = harness({
        local: report([project()], { cpuUtilization: 0.9 }),
        remotes: {
          old: { report: async () => older as FleetHostReport, spawn: async () => ({ tabId: "old-tab" }) },
          good: { report: async () => report([project({ path: "/srv/app-clone" })]), spawn: async () => ({ tabId: "good-tab" }) },
        },
      });
      const req: FleetDispatchRequest = {
        targets: { kind: "auto", reference: { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" }, count: 2 },
        prompt: "Fix it",
        title: null,
        workspace: "worktree",
        planMode: false,
        model: "openrouter/openai/gpt-5.6-luna",
      };
      const result = await h.dispatcher.dispatch(req, { kind: "user" });

      expect(result.outcomes.map((o) => [o.machineKey, o.status])).toEqual([
        ["good", "started"],
        [LOCAL_MACHINE_KEY, "started"],
      ]);
      expect(spawnsTo(h, "old")).toEqual([]);
      await expect(
        h.dispatcher.dispatch({ ...req, targets: { ...req.targets, count: 3 } as FleetDispatchRequest["targets"] }, { kind: "user" }),
      ).rejects.toThrow("a ready model provider, an omp-ui that supports model selection, CPU under 95%");
    });

    it("takes the started outcome's choice from the owner's answer, or null for a bare tabId", async () => {
      const choice = { model: "openrouter/openai/gpt-5.6-luna", thinkingLevel: "low" };
      const h = harness({
        local: report([project()]),
        remotes: {
          r1: { report: async () => report([project({ path: "/srv/app" })]), spawn: async () => ({ tabId: "r1-tab", choice }) },
          r2: { report: async () => report([project({ path: "/srv/app" })]), spawn: async () => ({ tabId: "r2-tab" }) },
        },
      });
      const result = await h.dispatcher.dispatch(
        explicit([
          { machineKey: "r1", projectCwd: "/srv/app" },
          { machineKey: "r2", projectCwd: "/srv/app" },
        ]),
        { kind: "user" },
      );

      expect(result.outcomes).toEqual([
        expect.objectContaining({ machineKey: "r1", status: "started", tabId: "r1-tab", choice }),
        expect.objectContaining({ machineKey: "r2", status: "started", tabId: "r2-tab", choice: null }),
      ]);
    });
  });
});

/** A live dispatched session; by default it finished its run (settled). */
function fleetSession(
  machineKey: string,
  dispatchId: string,
  patch: Partial<SessionSummary> = {},
): { machineKey: string; nickname: string | null; summary: SessionSummary } {
  return {
    machineKey,
    nickname: null,
    summary: {
      tabId: `tab-${dispatchId}`,
      title: "Fix the flaky test",
      live: "live",
      pendingPlan: null,
      awaitingHumanAnswer: false,
      turnRunning: false,
      sessionId: `session-${dispatchId}`,
      status: "complete",
      fleet: {
        dispatchId,
        batchId: null,
        title: "Fix the flaky test",
        prompt: "Fix the flaky test",
        requestedBy: { instanceId: "dispatcher", label: "desk", kind: "agent", sourceTabId: "parent" },
      },
      ...patch,
    } as unknown as SessionSummary,
  };
}

describe("FleetDispatcher wake-up, long-poll status, send (issues #957-#959)", () => {
  it("watches only an agent dispatch's non-failed outcomes, never a user dispatch", async () => {
    const watch = vi.fn();
    const picks = [
      { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" },
      { machineKey: LOCAL_MACHINE_KEY, projectCwd: "/nowhere" },
    ];
    const h = harness({ local: report([project()]), deps: { watchAgentDispatch: watch } });
    const result = await h.dispatcher.dispatch(explicit(picks), { kind: "agent", sourceTabId: "parent" });
    const started = result.outcomes.find((o) => o.status === "started")!;
    expect(result.outcomes.some((o) => o.status === "failed")).toBe(true);
    expect(watch).toHaveBeenCalledTimes(1);
    expect(watch).toHaveBeenCalledWith("parent", [{ dispatchId: started.dispatchId, machineKey: LOCAL_MACHINE_KEY }]);

    await h.dispatcher.dispatch(explicit(picks), { kind: "user" });
    expect(watch).toHaveBeenCalledTimes(1);
  });

  it("answers at once with waitMs when the session already settled", async () => {
    const nextBroadcast = vi.fn(async () => {});
    const h = harness({
      local: report([project()]),
      deps: { nextBroadcast, fleetSessions: async () => [fleetSession(LOCAL_MACHINE_KEY, "d1")] },
    });
    expect(await h.dispatcher.statusText({ dispatchId: "d1" }, 30_000)).toContain("idle");
    expect(nextBroadcast).not.toHaveBeenCalled();
  });

  it("answers after the broadcast that turns a working session idle", async () => {
    let running = true;
    let broadcasts = 0;
    const h = harness({
      local: report([project()]),
      deps: {
        fleetSessions: async () => [fleetSession(LOCAL_MACHINE_KEY, "d1", { turnRunning: running })],
        nextBroadcast: async () => {
          broadcasts += 1;
          if (broadcasts === 2) running = false;
        },
      },
    });
    expect(await h.dispatcher.statusText({ dispatchId: "d1" }, 30_000)).toContain("idle");
    expect(broadcasts).toBe(2);
  });

  it("keeps waiting on a fresh child through its first turn and answers once it settles", async () => {
    let summary: Partial<SessionSummary> = { turnRunning: false, sessionId: null, status: null };
    let broadcasts = 0;
    const h = harness({
      local: report([project()]),
      deps: {
        fleetSessions: async () => [fleetSession(LOCAL_MACHINE_KEY, "d1", summary)],
        nextBroadcast: async () => {
          broadcasts += 1;
          summary =
            broadcasts === 1
              ? { turnRunning: true, sessionId: "session-d1", status: null }
              : { turnRunning: false, sessionId: "session-d1", status: "complete" };
        },
      },
    });
    expect(await h.dispatcher.statusText({ dispatchId: "d1" }, 30_000)).toContain("idle");
    expect(broadcasts).toBe(2);
  });

  it("gives up at the deadline while the session keeps working", async () => {
    let now = NOW;
    const waits: number[] = [];
    const h = harness({
      local: report([project()]),
      deps: {
        now: () => now,
        fleetSessions: async () => [fleetSession(LOCAL_MACHINE_KEY, "d1", { turnRunning: true })],
        nextBroadcast: async (timeoutMs) => {
          waits.push(timeoutMs);
          now += 4_000;
        },
      },
    });
    expect(await h.dispatcher.statusText({ dispatchId: "d1" }, 10_000)).toContain("working");
    expect(waits).toEqual([10_000, 6_000, 2_000]);
  });

  it("refuses a send from a session that did not dispatch the child, without contacting the owner", async () => {
    const sendLocal = vi.fn(async () => ({ status: "delivered" as const }));
    const h = harness({
      local: report([project()]),
      remotes: { r1: { report: async () => report([]) } },
      deps: { sendLocal, fleetSessions: async () => [fleetSession("r1", "d1")] },
    });
    const outcome = await h.dispatcher.send("stranger", { dispatchId: "d1", message: "hi", mode: "queue" });
    expect(outcome.status).toBe("refused");
    expect(sendLocal).not.toHaveBeenCalled();
    expect(h.request.mock.calls.some(([, ch]) => ch === CH.fleetSend)).toBe(false);
  });

  it("sends to a remote child through fleet:send on its owner", async () => {
    const h = harness({
      local: report([project()]),
      remotes: { r1: { report: async () => report([]) } },
      deps: { fleetSessions: async () => [fleetSession("r1", "d1")] },
    });
    h.request.mockImplementation(async (_id, channel) => {
      if (channel === CH.fleetSend) return { status: "delivered" };
      throw new Error(`unexpected ${channel}`);
    });
    const outcome = await h.dispatcher.send("parent", { dispatchId: "d1", message: "hi", mode: "steer" });
    expect(outcome).toEqual({ status: "delivered" });
    const call = h.request.mock.calls.find(([, ch]) => ch === CH.fleetSend)!;
    expect(call[0]).toBe("r1");
    expect(CH.fleetSend).toBe("fleet:send");
    expect(call[2][0] as FleetSendRequest).toMatchObject({
      requester: { instanceId: "dispatcher", kind: "agent", sourceTabId: "parent" },
      dispatchId: "d1",
      message: "hi",
      mode: "steer",
    });
  });
});

describe("FleetDispatcher fleet ladder (issue #901)", () => {
  /** One joined member r1 ("box-r1"), answering whatever `answer` returns per channel. */
  function ladder(
    answer: (channel: string, args: unknown[]) => Promise<unknown>,
    remotes = [remote("r1")],
    providerKeyValue: (envName: string) => string | null = () => null,
  ) {
    const request = vi.fn(async (_id: string, channel: string, args: unknown[]) => {
      if (channel === CH.fleetHostReport) return report([project({ path: "/srv/app" })]);
      return answer(channel, args);
    });
    const dispatcher = new FleetDispatcher({
      localReport: async () => report([project()]),
      spawnLocal: async () => ({ tabId: "t" }),
      remotes: () => remotes,
      request,
      preferences: () => ({}),
      requesterBase: () => ({ instanceId: "dispatcher", label: "desk" }),
      knownDispatchIds: () => new Set(),
      fleetSessions: async () => [],
      localSummary: async () => "",
      broadcast: async () => {},
      probeSsh: async () => true,
      providerKeyValue,
      watchAgentDispatch: () => {},
      nextBroadcast: async () => {},
      sendLocal: async () => ({ status: "delivered" }),
      now: () => NOW,
      uuid: () => "u",
    });
    const sent = (channel: string) => request.mock.calls.filter(([, ch]) => ch === channel).map(([id, , args]) => ({ id, args }));
    return { dispatcher, request, sent };
  }

  it("reports each ready member's rung and null for this computer and silent members", async () => {
    const answering = ladder(async (channel) => (channel === CH.fleetGrantRung ? { rung: "full", ceiling: "full", execEnabled: true } : null));
    const machines = await answering.dispatcher.machines();
    expect(machines.find((m) => m.key === LOCAL_MACHINE_KEY)?.grantRung).toBeNull();
    expect(machines.find((m) => m.key === "r1")?.grantRung).toBe("full");
    expect(answering.sent(CH.fleetGrantRung)).toEqual([
      { id: "r1", args: [{ instanceId: "dispatcher", label: "desk", kind: "user", sourceTabId: null }] },
    ]);

    // An older peer answers the probe with unknown channel: still ready, rung unknown.
    const older = ladder(async () => {
      throw new Error("unknown channel fleet:grantRung");
    });
    expect((await older.dispatcher.machines()).find((m) => m.key === "r1")).toMatchObject({ status: "ready", grantRung: null });
  });

  it("refuses exec on this computer without contacting anyone", async () => {
    const h = ladder(async () => ({ status: "accepted" }));
    for (const machine of ["this computer", "This Computer"]) {
      expect(await h.dispatcher.exec("tab-1", { machine, command: "uname -a", cwd: null, timeoutMs: null, detach: false })).toEqual({
        status: "refused",
        reason: "exec runs only on fleet members; use your own tools on this computer",
      });
    }
    expect(h.sent(CH.fleetExec)).toEqual([]);
  });

  it("sends exec to the member by nickname with the agent's claimed identity and returns its outcome", async () => {
    const outcome = { status: "accepted", exitCode: 0, stdout: "Linux\n", stderr: "", truncated: false, timedOut: false };
    const h = ladder(async (channel) => (channel === CH.fleetExec ? outcome : null));
    expect(await h.dispatcher.exec("tab-1", { machine: "BOX-R1", command: "uname", cwd: "/srv", timeoutMs: 500, detach: false })).toEqual(outcome);
    expect(h.sent(CH.fleetExec)).toEqual([
      {
        id: "r1",
        args: [
          expect.objectContaining({
            command: "uname",
            cwd: "/srv",
            timeoutMs: 500,
            requester: { instanceId: "dispatcher", label: "desk", kind: "agent", sourceTabId: "tab-1" },
          }),
        ],
      },
    ]);
  });

  it("refuses an unknown machine and passes the member's refusal through as an outcome", async () => {
    const h = ladder(async (channel) => (channel === CH.fleetExec ? { status: "refused", reason: "fleet exec is off on this machine" } : null));
    const unknown = await h.dispatcher.exec("tab-1", { machine: "nowhere", command: "true", cwd: null, timeoutMs: null, detach: false });
    expect(unknown).toEqual({ status: "refused", reason: expect.stringContaining("box-r1") });
    expect(await h.dispatcher.exec("tab-1", { machine: "box-r1", command: "true", cwd: null, timeoutMs: null, detach: false })).toEqual({
      status: "refused",
      reason: "fleet exec is off on this machine",
    });
  });

  it("turns a silent member into a refusal after the 45 s bound", async () => {
    vi.useFakeTimers();
    try {
      const h = ladder((channel) => (channel === CH.fleetExec ? new Promise(() => {}) : Promise.resolve(null)));
      const pending = h.dispatcher.exec("tab-1", { machine: "box-r1", command: "sleep 99", cwd: null, timeoutMs: null, detach: false });
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toEqual({ status: "refused", reason: "no answer from box-r1 within 45 s" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("forwards project verbs and refuses them on this computer", async () => {
    const h = ladder(async (channel) => (channel === CH.fleetProjectManage ? { status: "accepted", path: "/srv/repos/app", headCommit: null } : null));
    expect(await h.dispatcher.projectManage("tab-1", { machine: "this computer", verb: "register", repositoryUrl: null, path: "/x" })).toMatchObject({ status: "refused" });
    expect(await h.dispatcher.projectManage("tab-1", { machine: "box-r1", verb: "clone", repositoryUrl: "https://github.com/acme/app", path: null })).toMatchObject({
      status: "accepted",
    });
    expect(h.sent(CH.fleetProjectManage)).toEqual([
      { id: "r1", args: [expect.objectContaining({ verb: "clone", repositoryUrl: "https://github.com/acme/app" })] },
    ]);
  });

  it("sends the freshly typed secret in one grant raise, and nothing for an unknown member", async () => {
    const h = ladder(async (channel) => (channel === CH.fleetGrantRaise ? { ok: true, rung: "manage" } : null));
    expect(await h.dispatcher.requestGrant("ghost", "manage", "s3cret")).toEqual({ ok: false, reason: expect.any(String) });
    expect(h.sent(CH.fleetGrantRaise)).toEqual([]);
    expect(await h.dispatcher.requestGrant("r1", "manage", "s3cret")).toEqual({ ok: true, rung: "manage" });
    expect(h.sent(CH.fleetGrantRaise)).toEqual([
      { id: "r1", args: [{ requester: { instanceId: "dispatcher", label: "desk", kind: "user", sourceTabId: null }, targetRung: "manage", credential: "s3cret" }] },
    ]);
  });

  it("refuses a grant request to a member that is not joined", async () => {
    const h = ladder(async () => ({ ok: true, rung: "manage" }), [remote("r1", { status: "unreachable" })]);
    expect(await h.dispatcher.requestGrant("r1", "manage", "s3cret")).toEqual({ ok: false, reason: expect.stringContaining("not joined") });
    expect(h.sent(CH.fleetGrantRaise)).toEqual([]);
  });

  const execArgs = { machine: "box-r1", command: "dnf -y install ripgrep", cwd: null, timeoutMs: null, detach: true };

  it("starts a detached exec on fleet:execDetach with the agent's identity and refuses this computer", async () => {
    const h = ladder(async (channel) => (channel === CH.fleetExecDetach ? { status: "accepted", execId: "e-1" } : null));
    expect(await h.dispatcher.execDetach("tab-1", { ...execArgs, machine: "this computer" })).toEqual({
      status: "refused",
      reason: "exec runs only on fleet members; use your own tools on this computer",
    });
    expect(await h.dispatcher.execDetach("tab-1", execArgs)).toEqual({ status: "accepted", execId: "e-1" });
    expect(h.sent(CH.fleetExecDetach)).toEqual([
      {
        id: "r1",
        args: [
          {
            command: "dnf -y install ripgrep",
            cwd: null,
            timeoutMs: null,
            requester: { instanceId: "dispatcher", label: "desk", kind: "agent", sourceTabId: "tab-1" },
          },
        ],
      },
    ]);
    expect(h.sent(CH.fleetExec)).toEqual([]);
  });

  it("polls on fleet:execPoll with the 25 s default wait and refuses this computer", async () => {
    const answer = { status: "accepted", execId: "e-1", state: "running", exitCode: null, stdout: "", stderr: "", truncated: false, elapsedMs: 1_000 };
    const h = ladder(async (channel) => (channel === CH.fleetExecPoll ? answer : null));
    expect(await h.dispatcher.execPoll("tab-1", { machine: "this computer", execId: "e-1", cancel: false, waitMs: null })).toMatchObject({
      status: "refused",
    });
    expect(await h.dispatcher.execPoll("tab-1", { machine: "box-r1", execId: "e-1", cancel: true, waitMs: null })).toEqual(answer);
    expect(h.sent(CH.fleetExecPoll)).toEqual([
      {
        id: "r1",
        args: [
          {
            execId: "e-1",
            waitMs: 25_000,
            cancel: true,
            requester: { instanceId: "dispatcher", label: "desk", kind: "agent", sourceTabId: "tab-1" },
          },
        ],
      },
    ]);
  });

  it("maps an older member's unknown channel on detach and poll to update text", async () => {
    const h = ladder(async (channel) => {
      throw new Error(`unknown channel ${channel}`);
    });
    const update = { status: "refused", reason: "box-r1 runs an omp-ui without detached exec; update omp-ui there" };
    expect(await h.dispatcher.execDetach("tab-1", execArgs)).toEqual(update);
    expect(await h.dispatcher.execPoll("tab-1", { machine: "box-r1", execId: "e-1", cancel: false, waitMs: 0 })).toEqual(update);
  });

  it("refuses a Provider key rollout to this computer, an unknown member, and an unjoined one without sending", async () => {
    const h = ladder(async () => ({ status: "accepted", installed: [], failed: [] }), [remote("r1"), remote("r2", { status: "unreachable" })], () => "sk-x");
    expect(await h.dispatcher.rolloutProviderKeys(LOCAL_MACHINE_KEY, ["OPENAI_API_KEY"])).toEqual({
      status: "refused",
      reason: "Provider keys already live on this computer",
    });
    expect(await h.dispatcher.rolloutProviderKeys("ghost", ["OPENAI_API_KEY"])).toEqual({ status: "refused", reason: "no joined fleet instance has that id" });
    expect(await h.dispatcher.rolloutProviderKeys("r2", ["OPENAI_API_KEY"])).toEqual({ status: "refused", reason: "box-r2 is not joined" });
    expect(h.sent(CH.fleetProviderKeys)).toEqual([]);
  });

  it("sends only resolved key values once each and reports unset or unknown keys as local failures", async () => {
    const values: Record<string, string> = { OPENAI_API_KEY: "sk-openai-secret", ANTHROPIC_API_KEY: "sk-ant-secret" };
    const h = ladder(
      async (channel) => (channel === CH.fleetProviderKeys ? { status: "accepted", installed: ["OPENAI_API_KEY"], failed: [{ envName: "ANTHROPIC_API_KEY", reason: "no keyring" }] } : null),
      [remote("r1")],
      (envName) => {
        if (envName === "NOT_A_PROVIDER") throw new Error(`unknown provider variable: ${envName}`);
        return values[envName] ?? null;
      },
    );
    const outcome = await h.dispatcher.rolloutProviderKeys("r1", ["OPENAI_API_KEY", "GEMINI_API_KEY", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "NOT_A_PROVIDER"]);
    expect(outcome).toEqual({
      status: "accepted",
      installed: ["OPENAI_API_KEY"],
      failed: [
        { envName: "GEMINI_API_KEY", reason: "not set on this computer" },
        { envName: "NOT_A_PROVIDER", reason: "unknown provider variable: NOT_A_PROVIDER" },
        { envName: "ANTHROPIC_API_KEY", reason: "no keyring" },
      ],
    });
    expect(h.sent(CH.fleetProviderKeys)).toEqual([
      {
        id: "r1",
        args: [
          {
            requester: { instanceId: "dispatcher", label: "desk", kind: "user", sourceTabId: null },
            keys: [
              { envName: "OPENAI_API_KEY", value: "sk-openai-secret" },
              { envName: "ANTHROPIC_API_KEY", value: "sk-ant-secret" },
            ],
          },
        ],
      },
    ]);
  });

  it("refuses a rollout when no chosen key is set here, and maps an older member's unknown channel to update text", async () => {
    const unset = ladder(async () => ({ status: "accepted", installed: [], failed: [] }));
    expect(await unset.dispatcher.rolloutProviderKeys("r1", ["OPENAI_API_KEY"])).toEqual({
      status: "refused",
      reason: "none of the chosen keys is set on this computer",
    });
    expect(unset.sent(CH.fleetProviderKeys)).toEqual([]);

    const older = ladder(
      async (channel) => {
        if (channel === CH.fleetProviderKeys) throw new Error("unknown channel fleet:providerKeys");
        return null;
      },
      [remote("r1")],
      () => "sk-openai-secret",
    );
    const outcome = await older.dispatcher.rolloutProviderKeys("r1", ["OPENAI_API_KEY"]);
    expect(outcome).toEqual({ status: "refused", reason: "box-r1 runs an omp-ui without Provider key rollout; update omp-ui there" });
    expect(JSON.stringify(outcome)).not.toContain("sk-openai-secret");
  });

  it("turns a silent member into a rollout refusal after the 45 s bound", async () => {
    vi.useFakeTimers();
    try {
      const h = ladder((channel) => (channel === CH.fleetProviderKeys ? new Promise(() => {}) : Promise.resolve(null)), [remote("r1")], () => "sk-x");
      const pending = h.dispatcher.rolloutProviderKeys("r1", ["OPENAI_API_KEY"]);
      await vi.advanceTimersByTimeAsync(45_000);
      expect(await pending).toEqual({ status: "refused", reason: "no answer from box-r1 within 45 s" });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("FleetDispatcher member address (issue #904)", () => {
  it("probes each joined member's join host once per window and never this computer or an unjoined member", async () => {
    const { user: _user, projectRoots: _roots, os: _os, packageManagers: _managers, ...older } = report([]);
    const probeSsh = vi.fn<(host: string) => Promise<boolean>>(async () => false);
    const dispatcher = new FleetDispatcher({
      localReport: async () => report([project()]),
      spawnLocal: async () => ({ tabId: "t" }),
      remotes: () => [remote("r1", { url: "http://[fd00::7]:4677" }), remote("r2", { status: "unreachable" })],
      request: async (_id, channel) => (channel === CH.fleetHostReport ? older : null),
      preferences: () => ({}),
      requesterBase: () => ({ instanceId: "dispatcher", label: "desk" }),
      knownDispatchIds: () => new Set(),
      fleetSessions: async () => [],
      localSummary: async () => "",
      broadcast: async () => {},
      probeSsh,
      providerKeyValue: () => null,
      watchAgentDispatch: () => {},
      nextBroadcast: async () => {},
      sendLocal: async () => ({ status: "delivered" }),
      now: () => NOW,
      uuid: () => "u",
    });
    await dispatcher.machines();
    const machines = await dispatcher.machines();
    expect(probeSsh.mock.calls).toEqual([["fd00::7"]]);
    const r1 = machines.find((m) => m.key === "r1")!;
    expect(r1).toMatchObject({ status: "ready", address: "fd00::7", sshReachable: false });
    expect(r1.report).toMatchObject({ user: null, projectRoots: null, os: null, packageManagers: null });
    expect(machines.find((m) => m.key === "r2")).toMatchObject({ address: "r2", sshReachable: null });
    expect(machines.find((m) => m.key === LOCAL_MACHINE_KEY)).toMatchObject({ address: null, sshReachable: null });
  });
});

describe("FleetDispatcher fleet maintenance (fleet remote version update)", () => {
  const USER = { instanceId: "dispatcher", label: "desk", kind: "user", sourceTabId: null };
  const AGENT = { instanceId: "dispatcher", label: "desk", kind: "agent", sourceTabId: "tab-1" };
  const LOCAL_REFUSAL = "this computer updates itself from Settings → Updates";
  const stageOmp = { target: "omp" as const, action: "stage" as const, version: null, allowLiveSessions: false };

  /** One joined member r1 ("box-r1") whose host report is `hostReport`; every other channel rides `answer`. */
  function updater(
    answer: (channel: string, args: unknown[]) => Promise<unknown>,
    remotes = [remote("r1")],
    hostReport = report([project({ path: "/srv/app" })]),
  ) {
    const request = vi.fn(async (_id: string, channel: string, args: unknown[]) => {
      if (channel === CH.fleetHostReport) return hostReport;
      return answer(channel, args);
    });
    const dispatcher = new FleetDispatcher({
      localReport: async () => report([project()]),
      spawnLocal: async () => ({ tabId: "t" }),
      remotes: () => remotes,
      request,
      preferences: () => ({}),
      requesterBase: () => ({ instanceId: "dispatcher", label: "desk" }),
      knownDispatchIds: () => new Set(),
      fleetSessions: async () => [],
      localSummary: async () => "",
      broadcast: async () => {},
      probeSsh: async () => true,
      providerKeyValue: () => null,
      watchAgentDispatch: () => {},
      nextBroadcast: async () => {},
      sendLocal: async () => ({ status: "delivered" }),
      now: () => NOW,
      uuid: () => "u",
    });
    const sent = (channel: string) => request.mock.calls.filter(([, ch]) => ch === channel).map(([id, , args]) => ({ id, args }));
    return { dispatcher, request, sent };
  }

  it("refuses an update on this computer, an unknown member, and an unjoined one without sending", async () => {
    const h = updater(async () => ({ status: "accepted", jobId: "j1" }));
    expect(await h.dispatcher.updateMachine(LOCAL_MACHINE_KEY, stageOmp)).toEqual({ status: "refused", reason: LOCAL_REFUSAL });
    expect(await h.dispatcher.updateMachine("ghost", stageOmp)).toEqual({
      status: "refused",
      reason: "no joined fleet instance has that id",
    });
    const unjoined = updater(async () => ({ status: "accepted", jobId: "j1" }), [remote("r1", { status: "unreachable" })]);
    expect(await unjoined.dispatcher.updateMachine("r1", stageOmp)).toEqual({ status: "refused", reason: "box-r1 is not joined" });
    expect(h.sent(CH.fleetUpdateMember)).toEqual([]);
    expect(unjoined.sent(CH.fleetUpdateMember)).toEqual([]);
  });

  it("sends the user's update to the member and records the started job for the chip", async () => {
    const h = updater(async (channel) => (channel === CH.fleetUpdateMember ? { status: "accepted", jobId: "job-1" } : null));
    expect(await h.dispatcher.updateMachine("r1", stageOmp)).toEqual({ status: "accepted", jobId: "job-1" });
    expect(h.sent(CH.fleetUpdateMember)).toEqual([{ id: "r1", args: [{ ...stageOmp, requester: USER }] }]);
  });

  it("maps an older member's unknown channel to fleet-update update text", async () => {
    const older = updater(
      async (channel) => {
        throw new Error(`unknown channel ${channel}`);
      },
      [remote("r1")],
    );
    expect(await older.dispatcher.updateMachine("r1", stageOmp)).toEqual({
      status: "refused",
      reason: "box-r1 runs an omp-ui without fleet updates; update omp-ui there",
    });
    expect(JSON.stringify(await older.dispatcher.updateMachine("r1", stageOmp))).not.toContain("unknown channel");
  });

  it("polls a recorded job from machines() with waitMs 0 and merges the running chip", async () => {
    const h = updater(
      async (channel) =>
        channel === CH.fleetUpdateMember
          ? { status: "accepted", jobId: "job-1" }
          : { status: "accepted", jobId: "job-1", state: "running", progress: { percent: 40, phase: "downloading" }, detail: null, elapsedMs: 800 },
    );
    await h.dispatcher.updateMachine("r1", stageOmp);
    const r1 = (await h.dispatcher.machines()).find((m) => m.key === "r1")!;
    expect(h.sent(CH.fleetUpdatePoll)).toEqual([{ id: "r1", args: [{ requester: USER, jobId: "job-1", waitMs: 0 }] }]);
    expect(r1.maintenance).toEqual({ jobId: "job-1", target: "omp", state: "running", progress: 40, detail: null, at: NOW });
  });

  it("shows a finished job for exactly one extra machines() poll, then stops polling it", async () => {
    let state = "running";
    const h = updater(
      async (channel) =>
        channel === CH.fleetUpdateMember
          ? { status: "accepted", jobId: "job-1" }
          : { status: "accepted", jobId: "job-1", state, progress: null, detail: state === "running" ? null : "omp 18.12.0 → 18.13.1", elapsedMs: 1 },
    );
    await h.dispatcher.updateMachine("r1", stageOmp);
    expect((await h.dispatcher.machines()).find((m) => m.key === "r1")!.maintenance).toMatchObject({ state: "running" });
    state = "succeeded";
    // The poll that catches the transition shows succeeded…
    expect((await h.dispatcher.machines()).find((m) => m.key === "r1")!.maintenance).toMatchObject({
      state: "succeeded",
      detail: "omp 18.12.0 → 18.13.1",
    });
    // …exactly one more shows it, and the chip is gone after that.
    expect((await h.dispatcher.machines()).find((m) => m.key === "r1")!.maintenance).toMatchObject({ state: "succeeded" });
    const settled = await h.dispatcher.machines();
    expect(settled.find((m) => m.key === "r1")!.maintenance).toBeNull();
    // Three polls ran (running, transition, one extra); the entry is gone,
    // so machines() no longer touches fleet:updatePoll for r1 at all.
    expect(h.sent(CH.fleetUpdatePoll)).toHaveLength(3);
    // This computer never carries a chip of its own.
    expect(settled.find((m) => m.key === LOCAL_MACHINE_KEY)!.maintenance).toBeNull();
  });

  it("drops the chip silently when the member refuses or loses the poll", async () => {
    let fail = false;
    const h = updater(
      async (channel) => {
        if (channel === CH.fleetUpdateMember) return { status: "accepted", jobId: "job-1" };
        if (fail) throw new Error("remote connection lost");
        return { status: "accepted", jobId: "job-1", state: "running", progress: null, detail: null, elapsedMs: 1 };
      },
    );
    await h.dispatcher.updateMachine("r1", stageOmp);
    expect((await h.dispatcher.machines()).find((m) => m.key === "r1")!.maintenance).toMatchObject({ state: "running" });
    fail = true;
    expect((await h.dispatcher.machines()).find((m) => m.key === "r1")!.maintenance).toBeNull();
    // The entry is gone: no further polls, and no refusal text reaches the machine row.
    await h.dispatcher.machines();
    expect(h.sent(CH.fleetUpdatePoll)).toHaveLength(2);
  });

  it("drops the chip silently when the poll wedges past its 40 s bound", async () => {
    vi.useFakeTimers();
    try {
      const h = updater(
        async (channel) => {
          if (channel === CH.fleetUpdateMember) return { status: "accepted", jobId: "job-1" };
          if (channel === CH.fleetUpdatePoll) return new Promise(() => {});
          return null;
        },
      );
      await h.dispatcher.updateMachine("r1", stageOmp);
      const pending = h.dispatcher.machines();
      // The report answers at once, but machines() waits the poll's own bound…
      await vi.advanceTimersByTimeAsync(39_000);
      // …and settles as no chip (never a refusal) right after it expires.
      await vi.advanceTimersByTimeAsync(1_000);
      expect((await pending).find((m) => m.key === "r1")!.maintenance).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("normalizes an older member report's missing update facts instead of leaking undefined", async () => {
    const {
      ompVersion: _ompVersion,
      ompPath: _ompPath,
      ompPinned: _ompPinned,
      ompBelowMinimum: _ompBelowMinimum,
      packageFormat: _packageFormat,
      appLatestVersion: _appLatestVersion,
      appUpdateStaged: _appUpdateStaged,
      modelFavorites: _modelFavorites,
      ...older
    } = report([]);
    const h = updater(async () => null, [remote("r1")], older as FleetHostReport);
    const r1 = (await h.dispatcher.machines()).find((m) => m.key === "r1")!;
    expect(r1.status).toBe("ready");
    expect(r1.report).toMatchObject({
      ompVersion: null,
      ompPath: null,
      ompPinned: false,
      ompBelowMinimum: false,
      packageFormat: null,
      appLatestVersion: null,
      appUpdateStaged: false,
      modelFavorites: null,
    });
  });

  it("refuses the agent's update on this computer without contacting anyone", async () => {
    const h = updater(async () => ({ status: "accepted", jobId: "j1" }));
    expect(await h.dispatcher.update("tab-1", { machine: "this computer", target: "omp", action: "update", version: null })).toEqual({
      kind: "refused",
      reason: LOCAL_REFUSAL,
    });
    expect(h.sent(CH.fleetUpdateMember)).toEqual([]);
    expect(h.sent(CH.fleetUpdatePoll)).toEqual([]);
  });

  it("starts a job for the agent and answers started; a second call while running polls instead", async () => {
    let polls = 0;
    const h = updater(
      async (channel) =>
        channel === CH.fleetUpdateMember
          ? { status: "accepted", jobId: "job-1" }
          : { status: "accepted", jobId: "job-1", state: "running", progress: { percent: 40, phase: "downloading" }, detail: null, elapsedMs: ++polls },
    );
    const args = { machine: "box-r1", target: "omp" as const, action: "update" as const, version: null };
    expect(await h.dispatcher.update("tab-1", args)).toEqual({ kind: "started", jobId: "job-1" });
    expect(h.sent(CH.fleetUpdateMember)).toEqual([{ id: "r1", args: [{ target: "omp", action: "stage", version: null, allowLiveSessions: false, requester: AGENT }] }]);
    // The second call with the same arguments sees the running job and polls;
    // machines() refreshes the chip inside the same call, so two polls ride
    // fleet:updatePoll — the member never gets a second start.
    expect(await h.dispatcher.update("tab-1", args)).toEqual({
      kind: "poll",
      state: "running",
      progress: { percent: 40, phase: "downloading" },
      detail: null,
    });
    expect(h.sent(CH.fleetUpdateMember)).toHaveLength(1);
    const agentPolls = h.sent(CH.fleetUpdatePoll);
    expect(agentPolls).toHaveLength(2);
    expect(agentPolls[1]).toEqual({ id: "r1", args: [{ requester: AGENT, jobId: "job-1", waitMs: 0 }] });
  });

  it("answers a finished job with its final detail and lets a later call start fresh", async () => {
    let state = "running";
    const h = updater(
      async (channel) =>
        channel === CH.fleetUpdateMember
          ? { status: "accepted", jobId: "job-1" }
          : { status: "accepted", jobId: "job-1", state, progress: null, detail: state === "running" ? null : "omp 18.12.0 → 18.13.1 at ~/.local/bin/omp", elapsedMs: 1 },
    );
    const args = { machine: "box-r1", target: "omp" as const, action: "update" as const, version: null };
    await h.dispatcher.update("tab-1", args);
    state = "succeeded";
    expect(await h.dispatcher.update("tab-1", args)).toEqual({
      kind: "poll",
      state: "succeeded",
      progress: null,
      detail: "omp 18.12.0 → 18.13.1 at ~/.local/bin/omp",
    });
    // The pointer dropped with the finish: a later call is an ordinary start.
    expect(await h.dispatcher.update("tab-1", args)).toEqual({ kind: "started", jobId: "job-1" });
    expect(h.sent(CH.fleetUpdateMember)).toHaveLength(2);
  });

  it("answers a fresh check with the member's check and an app apply with its detail", async () => {
    const check = { target: "app", currentVersion: "1.0.0", latestVersion: "1.1.0", format: "appimage", staged: false, installOnQuit: false, liveSessions: 0 };
    const h = updater(async (channel) => (channel === CH.fleetUpdateMember ? { status: "accepted", check } : null));
    expect(await h.dispatcher.update("tab-1", { machine: "box-r1", target: "app", action: "check", version: null })).toEqual({ kind: "check", check });
    expect(h.sent(CH.fleetUpdateMember)).toEqual([
      { id: "r1", args: [{ target: "app", action: "check", version: null, allowLiveSessions: false, requester: AGENT }] },
    ]);
    const h2 = updater(async (channel) => (channel === CH.fleetUpdateMember ? { status: "accepted", detail: "update staged; installs when I quit" } : null));
    expect(await h2.dispatcher.update("tab-1", { machine: "box-r1", target: "app", action: "apply", version: null })).toEqual({
      kind: "applied",
      detail: "update staged; installs when I quit",
    });
  });

  it("passes a member refusal through as the agent's refused answer", async () => {
    const h = updater(async () => ({ status: "refused", reason: "omp is pinned by OMP_UI_OMP_PATH on this machine; install into the managed path or clear the pin" }));
    expect(await h.dispatcher.update("tab-1", { machine: "box-r1", target: "omp", action: "update", version: null })).toEqual({
      kind: "refused",
      reason: "omp is pinned by OMP_UI_OMP_PATH on this machine; install into the managed path or clear the pin",
    });
  });
});
