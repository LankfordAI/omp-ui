import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LOCAL_MACHINE_KEY,
  Registry,
  type FleetDispatchRequest,
  type NewRpcSpawnRequest,
  type SessionRoutine,
  type SpawnAnswer,
} from "@omp-ui/core";
import { createLocalRoutineDispatch } from "./local-routine-dispatch";

const dirs: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function makeRegistry(projectCwd: string): Registry {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-lite-routine-dispatch-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  registry.addProject(projectCwd);
  return registry;
}

const ROUTINE_SNAP: SessionRoutine = {
  id: "AAAAAAAAAAAAAAAAAAAAAA",
  name: "Daily triage",
  approvalEntries: { read: "allow", bash: "deny" },
  deniedBuiltins: ["bash"],
  warnCostUsd: 2,
  maxCostUsd: 5,
};

function makeRequest(projectCwd: string, overrides: Partial<FleetDispatchRequest> = {}): FleetDispatchRequest {
  return {
    targets: { kind: "explicit", picks: [{ machineKey: LOCAL_MACHINE_KEY, projectCwd }] },
    prompt: "Check overnight CI failures.",
    title: "Daily triage · 2026-11-25 08:00",
    workspace: "worktree",
    planMode: false,
    ...overrides,
  };
}

describe("createLocalRoutineDispatch (#1368)", () => {
  it("builds exact NewRpcSpawnRequest (worktree + checkout, advisor inheritance, pinned model) and returns started", async () => {
    const projectCwd = "/srv/repo-alpha";
    const registry = makeRegistry(projectCwd);
    registry.setSetting("defaultAdvisor", true);
    registry.setProjectDefaultAdvisorModel(projectCwd, "anthropic/claude-opus");
    const seen: NewRpcSpawnRequest[] = [];
    const dispatch = createLocalRoutineDispatch({
      registry,
      instanceId: () => "lite-instance-1",
      machineLabel: () => "homelab",
      providerReady: () => true,
      spawnLocal: async (req) => {
        seen.push(req);
        return {
          tabId: "tab-new-1",
          choice: { model: "openrouter/google/gemini-4-neon", thinkingLevel: "medium" },
        } as unknown as SpawnAnswer;
      },
      settleOrphan: async () => true,
      uuid: () => "dispatch-1",
    });

    const result = await dispatch(
      makeRequest(projectCwd, {
        workspace: "worktree",
        planMode: true,
        model: "openrouter/google/gemini-4-neon",
        thinkingLevel: "medium",
      }),
      { kind: "routine", routine: ROUTINE_SNAP },
      { deadlineMs: 5_000 },
    );

    expect(result.batchId).toBeNull();
    expect(result.outcomes).toEqual([
      {
        dispatchId: "dispatch-1",
        machineKey: LOCAL_MACHINE_KEY,
        projectCwd,
        status: "started",
        tabId: "tab-new-1",
        choice: { model: "openrouter/google/gemini-4-neon", thinkingLevel: "medium" },
      },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      origin: "new",
      mode: "rpc-ui",
      projectCwd,
      cols: 80,
      rows: 24,
      advisor: true,
      advisorModel: "anthropic/claude-opus",
      planMode: true,
      private: true,
      fleet: {
        dispatchId: "dispatch-1",
        batchId: null,
        title: "Daily triage · 2026-11-25 08:00",
        prompt: "Check overnight CI failures.",
        requestedBy: {
          instanceId: "lite-instance-1",
          label: "homelab",
          kind: "routine",
          sourceTabId: null,
        },
        model: "openrouter/google/gemini-4-neon",
        thinkingLevel: "medium",
        routine: ROUTINE_SNAP,
      },
    });
    expect(seen[0]!.worktree).toMatchObject({ mint: { baseRef: null, baseBranch: null } });
    expect(seen[0]!.worktree && "mint" in seen[0]!.worktree && seen[0]!.worktree.mint.branch.length).toBeGreaterThan(0);
    // Checkout workspace sets worktree: null and inherits null advisorModel when unpinned.
    registry.setProjectDefaultAdvisorModel(projectCwd, null);
    registry.setSetting("defaultAdvisor", false);
    await dispatch(
      makeRequest(projectCwd, { workspace: "checkout", planMode: false }),
      { kind: "routine", routine: ROUTINE_SNAP },
      { deadlineMs: 5_000 },
    );
    expect(seen[1]!.worktree).toBeNull();
    expect(seen[1]!.advisor).toBe(false);
    expect(seen[1]!.advisorModel).toBeNull();
  });

  it("throws on non-explicit targets and fails non-local, unregistered project, or provider-unready targets", async () => {
    const projectCwd = "/srv/repo-beta";
    const registry = makeRegistry(projectCwd);
    let ready = true;
    const spawnLocal = vi.fn<() => Promise<SpawnAnswer>>();
    const dispatch = createLocalRoutineDispatch({
      registry,
      instanceId: () => "lite-instance-2",
      machineLabel: () => "homelab",
      providerReady: () => ready,
      spawnLocal,
      settleOrphan: async () => true,
      uuid: () => "d-x",
    });

    await expect(
      dispatch(
        {
          targets: { kind: "auto", reference: { machineKey: LOCAL_MACHINE_KEY, projectCwd }, count: 1 },
          title: null,
          prompt: "Hi",
          workspace: "worktree",
          planMode: false,
        },
        { kind: "routine", routine: ROUTINE_SNAP },
        { deadlineMs: 5_000 },
      ),
    ).rejects.toThrow("routines only target local projects");

    const remoteRes = await dispatch(
      {
        targets: { kind: "explicit", picks: [{ machineKey: "remote-1", projectCwd }] },
        title: null,
        prompt: "Hi",
        workspace: "worktree",
        planMode: false,
      },
      { kind: "routine", routine: ROUTINE_SNAP },
      { deadlineMs: 5_000 },
    );
    expect(remoteRes.outcomes[0]).toMatchObject({ status: "failed", message: "routines only target local projects" });

    const missingRes = await dispatch(
      makeRequest("/srv/unregistered"),
      { kind: "routine", routine: ROUTINE_SNAP },
      { deadlineMs: 5_000 },
    );
    expect(missingRes.outcomes[0]).toMatchObject({
      status: "failed",
      message: "this computer has no project /srv/unregistered",
    });

    ready = false;
    const noProvRes = await dispatch(
      makeRequest(projectCwd),
      { kind: "routine", routine: ROUTINE_SNAP },
      { deadlineMs: 5_000 },
    );
    expect(noProvRes.outcomes[0]).toMatchObject({
      status: "failed",
      message: "no model provider on this computer",
    });
    expect(spawnLocal).not.toHaveBeenCalled();
  });

  it("times out cleanly as unknown and settles any late-resolving orphan spawn", async () => {
    vi.useFakeTimers();
    const projectCwd = "/srv/repo-gamma";
    const registry = makeRegistry(projectCwd);
    const pendingSpawn = Promise.withResolvers<SpawnAnswer>();
    const settled: string[] = [];

    const dispatch = createLocalRoutineDispatch({
      registry,
      instanceId: () => "lite-instance-3",
      machineLabel: () => "homelab",
      providerReady: () => true,
      spawnLocal: () => pendingSpawn.promise,
      settleOrphan: async (tabId) => {
        settled.push(tabId);
        return true;
      },
      uuid: () => "d-slow",
    });

    const running = dispatch(
      makeRequest(projectCwd),
      { kind: "routine", routine: ROUTINE_SNAP },
      { deadlineMs: 45_000 },
    );
    await vi.advanceTimersByTimeAsync(45_000);
    const res = await running;
    expect(res.outcomes[0]).toMatchObject({
      dispatchId: "d-slow",
      status: "unknown",
      message: "no answer within 45 s; the session may still start",
    });
    expect(settled).toEqual([]);

    // Spawn resolves late after the deadline: orphan reaper must settle it.
    pendingSpawn.resolve({ tabId: "tab-late-orphan", choice: null } as unknown as SpawnAnswer);
    await Promise.resolve();
    await Promise.resolve();
    expect(settled).toEqual(["tab-late-orphan"]);
  });
});
