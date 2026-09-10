import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CH } from "@omp-ui/core";
import { seedRegistry, testHost, type BoundConnection } from "./test/fixtures";

let ipc: BoundConnection;

let base: string;

function setup(): { registryFile: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-pins-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
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
    ],
  });

  ipc = testHost(registryFile);
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(ch, ...args);

/** The project record's pin fields, read straight off disk. */
function diskPins(registryFile: string): {
  defaultModel: string | null;
  defaultAdvisorModel: string | null;
} {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    projects: Array<{ defaultModel?: string | null; defaultAdvisorModel?: string | null }>;
  };
  const project = raw.projects[0]!;
  return {
    defaultModel: project.defaultModel ?? null,
    defaultAdvisorModel: project.defaultAdvisorModel ?? null,
  };
}

/** The pin fields of the first project in the last stateChanged broadcast. */
function broadcastPins(): { defaultModel: string | null; defaultAdvisorModel: string | null } {
  const last = [...ipc.sent].reverse().find((m) => m.channel === CH.onStateChanged);
  if (last === undefined) throw new Error("no stateChanged broadcast captured");
  const state = last.args[0] as {
    projects: Array<{ project: { defaultModel?: string | null; defaultAdvisorModel?: string | null } }>;
  };
  const project = state.projects[0]!.project;
  return {
    defaultModel: project.defaultModel ?? null,
    defaultAdvisorModel: project.defaultAdvisorModel ?? null,
  };
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("project model pins (issue #257)", () => {
  it("pins the default main model and broadcasts the updated record", async () => {
    const { registryFile } = setup();
    await invoke(CH.setProjectDefaultModel, "/p/a", "p/m");
    expect(diskPins(registryFile)).toMatchObject({ defaultModel: "p/m" });
    expect(broadcastPins()).toMatchObject({ defaultModel: "p/m" });
  });

  it("pins the default advisor model and broadcasts the updated record", async () => {
    const { registryFile } = setup();
    await invoke(CH.setProjectDefaultAdvisorModel, "/p/a", "p/m:high");
    expect(diskPins(registryFile)).toMatchObject({ defaultAdvisorModel: "p/m:high" });
    expect(broadcastPins()).toMatchObject({ defaultAdvisorModel: "p/m:high" });
  });

  it("clears a pin with null and normalizes an empty string to a clear", async () => {
    const { registryFile } = setup();
    await invoke(CH.setProjectDefaultModel, "/p/a", "p/m");
    await invoke(CH.setProjectDefaultAdvisorModel, "/p/a", "p/a");
    await invoke(CH.setProjectDefaultModel, "/p/a", "");
    await invoke(CH.setProjectDefaultAdvisorModel, "/p/a", null);
    expect(diskPins(registryFile)).toMatchObject({
      defaultModel: null,
      defaultAdvisorModel: null,
    });
    expect(broadcastPins()).toMatchObject({ defaultModel: null, defaultAdvisorModel: null });
  });

  it("is a no-op for an unknown project", async () => {
    const { registryFile } = setup();
    await invoke(CH.setProjectDefaultModel, "/p/zzz", "p/m");
    await invoke(CH.setProjectDefaultAdvisorModel, "/p/zzz", "p/m");
    expect(diskPins(registryFile)).toMatchObject({ defaultModel: null, defaultAdvisorModel: null });
  });
});
