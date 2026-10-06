import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainBackend } from "./backend";
import { CH } from "@omp-ui/core";
import type { SidebarGroup } from "@omp-ui/core";
import { seedRegistry } from "./test/fixtures";

// Hoisted so the electron mock's factory (run while importing ./backend, i.e.
// before this module body) can register into it.
const handlers = vi.hoisted(
  () => new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
);

// The real MainBackend imports electron; stub the surfaces it touches.
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;

function project(projectPath: string, name: string, addedAt: string) {
  return {
    path: projectPath,
    name,
    addedAt,
    lastModel: null,
    lastThinkingLevel: null,
    lastAdvisor: null,
    lastAdvisorModel: null,
    defaultModel: null,
    defaultAdvisorModel: null,
    browserClock: false,
    reviewRoster: null,
    knowledgeHome: null,
  };
}

function setup(): { registryFile: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-groups-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      project("/p/a", "A", "2026-08-01T00:00:00.000Z"),
      project("/p/b", "B", "2026-08-02T00:00:00.000Z"),
      project("/p/c", "C", "2026-08-03T00:00:00.000Z"),
    ],
  });

  handlers.clear();
  sent.length = 0;
  new MainBackend(win as never, registryFile).registerIpc();
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

interface BroadcastState {
  projects: { project: { path: string } }[];
  sidebarGroups: SidebarGroup[];
}

/** The payload of the last stateChanged broadcast. */
function lastBroadcast(): BroadcastState {
  const last = [...sent].reverse().find((m) => m.channel === CH.onStateChanged);
  if (last === undefined) throw new Error("no stateChanged broadcast captured");
  return last.args[0] as BroadcastState;
}

function readDisk(registryFile: string): { projects: { path: string }[]; sidebarGroups: SidebarGroup[] } {
  return JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    projects: { path: string }[];
    sidebarGroups: SidebarGroup[];
  };
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("sidebar groups (issue #745)", () => {
  it("creates a group holding the project and broadcasts it last in the order", async () => {
    const { registryFile } = setup();
    const group = (await invoke(CH.createSidebarGroup, "Team", "/p/a")) as SidebarGroup;
    expect(group).toMatchObject({ name: "Team", collapsed: false, projectPaths: ["/p/a"] });

    const state = lastBroadcast();
    expect(state.sidebarGroups).toEqual([group]);
    expect(state.sidebarGroups[0]?.projectPaths).toEqual(["/p/a"]);
    expect(state.projects.map((g) => g.project.path)).toEqual(["/p/b", "/p/c", "/p/a"]);

    const disk = readDisk(registryFile);
    expect(disk.sidebarGroups).toEqual([group]);
    expect(disk.projects.map((p) => p.path)).toEqual(["/p/b", "/p/c", "/p/a"]);
  });

  it("ungroups a project and broadcasts the emptied group", async () => {
    const { registryFile } = setup();
    const group = (await invoke(CH.createSidebarGroup, "Team", "/p/a")) as SidebarGroup;
    await invoke(CH.setProjectSidebarGroup, "/p/a", null);

    expect(lastBroadcast().sidebarGroups).toEqual([{ ...group, projectPaths: [] }]);
    expect(readDisk(registryFile).sidebarGroups[0]?.projectPaths).toEqual([]);
  });
});
