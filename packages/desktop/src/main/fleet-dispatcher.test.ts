import { describe, expect, it, vi } from "vitest";
import {
  CH,
  LOCAL_MACHINE_KEY,
  type FleetDispatchRequest,
  type FleetHostProject,
  type FleetHostReport,
  type NewRpcSpawnRequest,
  type RemoteInstanceSummary,
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
    now: () => NOW,
    uuid: () => `id-${++ids}`,
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
      outcomes: [{ dispatchId: "d-original", machineKey: "r1", projectCwd: "/srv/app", status: "started", tabId: "r1-tab" }],
    });
    expect(spawnsTo(h, "r1")[0]!.fleet).toMatchObject({ dispatchId: "d-original", batchId: "b-original" });
  });
});
