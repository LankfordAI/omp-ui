import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CH } from "@omp-ui/core";
import { seedRegistry, testHost, type BoundConnection } from "./test/fixtures";

let ipc: BoundConnection;

let base: string;

function setup(): { registryFile: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-move-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      // Distinct addedAt times: the registry order must win over add-order
      // in buildState (previously re-sorted by addedAt — issue #115).
      {
        path: "/p/a",
        name: "A",
        addedAt: "2026-08-01T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
      {
        path: "/p/b",
        name: "B",
        addedAt: "2026-08-02T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
      {
        path: "/p/c",
        name: "C",
        addedAt: "2026-08-03T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
    ],
  });

  ipc = testHost(registryFile);
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(ch, ...args);

/** The projects array of the last stateChanged broadcast. */
function lastBroadcastOrder(): string[] {
  const last = [...ipc.sent].reverse().find((m) => m.channel === CH.onStateChanged);
  if (last === undefined) throw new Error("no stateChanged broadcast captured");
  const state = last.args[0] as { projects: { project: { path: string } }[] };
  return state.projects.map((g) => g.project.path);
}

function diskOrder(registryFile: string): string[] {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    projects: { path: string }[];
  };
  return raw.projects.map((p) => p.path);
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("project reorder (issue #115)", () => {
  it("moves a project before another and broadcasts the new order", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveProject, "/p/a", "/p/c");
    // A lands immediately before C — between B and C — despite A's earlier
    // addedAt: the registry order is the sidebar order.
    expect(lastBroadcastOrder()).toEqual(["/p/b", "/p/a", "/p/c"]);
    expect(diskOrder(registryFile)).toEqual(["/p/b", "/p/a", "/p/c"]);
  });

  it("appends when beforePath is null", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveProject, "/p/a", null);
    expect(lastBroadcastOrder()).toEqual(["/p/b", "/p/c", "/p/a"]);
    expect(diskOrder(registryFile)).toEqual(["/p/b", "/p/c", "/p/a"]);
  });

  it("is a broadcast-only no-op for an unknown source", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveProject, "/p/zzz", "/p/b");
    expect(lastBroadcastOrder()).toEqual(["/p/a", "/p/b", "/p/c"]);
    expect(diskOrder(registryFile)).toEqual(["/p/a", "/p/b", "/p/c"]);
  });
});