import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ChannelTable, FleetRequester } from "@omp-ui/core";
import { CH, dispatchRequest } from "@omp-ui/core";
import { createExecLegs } from "./adapters-node";
import { registerFleetLegs } from "./register-fleet-legs";
import type { FleetLegsSettings, FleetLegsSettingKey } from "./types";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..", "..");
// The artifact under test lives in a gitignored .build dir and is removed in
// afterAll (the same contract bundle.test.ts keeps): dist/ only exists after an
// explicit build, so the test must not depend on that side effect — and a
// built bundle left inside src/ would be swept up by the repo's eslint pass.
const outDir = path.join(here, ".build");
const smokeBundle = path.join(outDir, "smoke-session-bundle.mjs");

beforeAll(async () => {
  if (process.platform === "win32") return; // the only consumer skips there
  await execFileP(process.execPath, [path.join(pkgRoot, "scripts/bundle-session.mjs"), "--outfile", smokeBundle], {
    cwd: pkgRoot,
  });
}, 120_000);

afterAll(() => {
  fs.rmSync(outDir, { recursive: true, force: true });
});

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
    const legs = await createExecLegs({ commandDeps: { homeDir: () => "/tmp" }, bundlePath: smokeBundle });
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
