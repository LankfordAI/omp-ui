import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainBackend } from "./backend";
import { CH } from "./channels";

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
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;

function setup(): { registryFile: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-move-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  fs.writeFileSync(
    registryFile,
    JSON.stringify({
      schemaVersion: 1,
      settings: { defaultMode: "rpc-ui" },
      projects: [
        // Distinct addedAt times: the registry order must win over add-order
        // in buildState (previously re-sorted by addedAt — issue #115).
        { path: "/p/a", name: "A", addedAt: "2026-08-01T00:00:00.000Z" },
        { path: "/p/b", name: "B", addedAt: "2026-08-02T00:00:00.000Z" },
        { path: "/p/c", name: "C", addedAt: "2026-08-03T00:00:00.000Z" },
      ],
      sessions: [],
    }),
  );

  handlers.clear();
  sent.length = 0;
  new MainBackend(win as never, registryFile).registerIpc();
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

/** The projects array of the last stateChanged broadcast. */
function lastBroadcastOrder(): string[] {
  const last = [...sent].reverse().find((m) => m.channel === CH.stateChanged);
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
    await invoke(CH.projectMove, "/p/a", "/p/c");
    // A lands immediately before C — between B and C — despite A's earlier
    // addedAt: the registry order is the sidebar order.
    expect(lastBroadcastOrder()).toEqual(["/p/b", "/p/a", "/p/c"]);
    expect(diskOrder(registryFile)).toEqual(["/p/b", "/p/a", "/p/c"]);
  });

  it("appends when beforePath is null", async () => {
    const { registryFile } = setup();
    await invoke(CH.projectMove, "/p/a", null);
    expect(lastBroadcastOrder()).toEqual(["/p/b", "/p/c", "/p/a"]);
    expect(diskOrder(registryFile)).toEqual(["/p/b", "/p/c", "/p/a"]);
  });

  it("is a broadcast-only no-op for an unknown source", async () => {
    const { registryFile } = setup();
    await invoke(CH.projectMove, "/p/zzz", "/p/b");
    expect(lastBroadcastOrder()).toEqual(["/p/a", "/p/b", "/p/c"]);
    expect(diskOrder(registryFile)).toEqual(["/p/a", "/p/b", "/p/c"]);
  });
});