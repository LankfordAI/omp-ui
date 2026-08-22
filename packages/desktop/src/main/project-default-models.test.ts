import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainBackend } from "./backend";
import { CH } from "@omp-ui/core";
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
        lastAdvisorModel: null,
      },
    ],
  });

  handlers.clear();
  sent.length = 0;
  new MainBackend(win as never, registryFile).registerIpc();
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

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
  const last = [...sent].reverse().find((m) => m.channel === CH.onStateChanged);
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
