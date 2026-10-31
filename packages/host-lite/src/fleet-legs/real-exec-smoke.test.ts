import { describe, expect, it } from "vitest";
import type { ChannelTable, FleetRequester } from "@omp-ui/core";
import { CH, dispatchRequest } from "@omp-ui/core";
import { createExecLegs } from "./adapters-node";
import { registerFleetLegs } from "./register-fleet-legs";
import type { FleetLegsSettings, FleetLegsSettingKey } from "./types";

const WHO: FleetRequester = { instanceId: "m-1", label: "desk", kind: "agent", sourceTabId: null };

// The fixed-shell commands are POSIX (mirrors backend-fleet-exec.test.ts's guard).
describe("production exec adapter through the member wiring", () => {
  it("runs bounded and detached commands for real", { skip: process.platform === "win32" }, async () => {
    const store: Record<string, unknown> = {
      instanceId: "host-1", modelFavorites: [], remoteToken: "", remotePasswordHash: "", remotePasswordSalt: "",
      fleetExecEnabled: true, fleetExecCeiling: "full",
      fleetGrants: { "m-1": { rung: "full", label: "desk", updatedAt: "t" } },
      fleetProjectRoots: [],
    };
    const registry = {
      getSetting: <K extends FleetLegsSettingKey>(k: K) => store[k] as never,
      setSetting: <K extends FleetLegsSettingKey>(k: K, v: FleetLegsSettings[K]) => { store[k] = v; },
      projects: [],
    };
    const legs = await createExecLegs({ commandDeps: { homeDir: () => "/tmp" } });
    const table = registerFleetLegs({ registry: registry as never, host: {
      resources: async () => ({ cpuCount: 1, cpuUtilization: null, totalMemoryBytes: 1, availableMemoryBytes: 1 }),
      projects: async () => [], activity: () => ({ liveSessions: 0, runningTurns: 0 }),
    }, exec: legs }) as unknown as ChannelTable;

    const bounded = await dispatchRequest(table, CH.fleetExec, [{ requester: WHO, command: "printf fleet-ok", cwd: null, timeoutMs: 5_000 }]) as { status: string; stdout?: string; exitCode?: number };
    expect(bounded).toMatchObject({ status: "accepted", exitCode: 0, stdout: "fleet-ok" });

    const started = await dispatchRequest(table, CH.fleetExecDetach, [{ requester: WHO, command: "printf slow; sleep 3", cwd: null, timeoutMs: null }]) as { status?: string; execId?: string };
    expect(started.status).toBe("accepted");
    const running = await dispatchRequest(table, CH.fleetExecPoll, [{ requester: WHO, execId: started.execId, waitMs: 300, cancel: false }]) as { state?: string; stdout?: string };
    expect(running.state).toBe("running");
    expect(running.stdout).toContain("slow");
    const cancelled = await dispatchRequest(table, CH.fleetExecPoll, [{ requester: WHO, execId: started.execId, waitMs: 1_000, cancel: true }]) as { state?: string };
    expect(cancelled.state).toBe("cancelled");
    // A different dispatcher cannot see it (seam ownership rule survives the wiring).
    const stranger = await dispatchRequest(table, CH.fleetExecPoll, [{ requester: { ...WHO, instanceId: "other" }, execId: started.execId, waitMs: 0, cancel: false }]) as { status?: string };
    expect(stranger).toMatchObject({ status: "refused" });
    legs.dispose();
  });
});
