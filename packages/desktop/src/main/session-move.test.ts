import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MainBackend } from "./backend";
import { CH } from "@omp-ui/core";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

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
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-session-move-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      { path: "/p/a", name: "A", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      { path: "/p/b", name: "B", addedAt: "2026-08-02T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
    ],
    // Insertion order deliberately disagrees with recency within /p/a: the
    // persisted array order must win over either (issue #274).
    sessions: [
      ownedSessionRecord({ tabId: "a-old", projectCwd: "/p/a", launchedAt: "2026-08-01T00:00:00.000Z" }),
      ownedSessionRecord({ tabId: "a-new", projectCwd: "/p/a", launchedAt: "2026-08-05T00:00:00.000Z" }),
      ownedSessionRecord({ tabId: "b-1", projectCwd: "/p/b", launchedAt: "2026-08-03T00:00:00.000Z" }),
    ],
    settings: { sessionOrderFrozen: true },
  });

  handlers.clear();
  sent.length = 0;
  new MainBackend(win as never, registryFile).registerIpc();
  return { registryFile };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

/** The per-project session id arrays of the last stateChanged broadcast. */
function lastBroadcastSessions(): Record<string, string[]> {
  const last = [...sent].reverse().find((m) => m.channel === CH.onStateChanged);
  if (last === undefined) throw new Error("no stateChanged broadcast captured");
  const state = last.args[0] as { projects: { project: { path: string }; sessions: { tabId: string }[] }[] };
  return Object.fromEntries(
    state.projects.map((g) => [g.project.path, g.sessions.map((s) => s.tabId)]),
  );
}

function diskSessions(registryFile: string): Record<string, string[]> {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    sessions: { tabId: string; projectCwd: string }[];
  };
  const out: Record<string, string[]> = {};
  for (const s of raw.sessions) (out[s.projectCwd] ??= []).push(s.tabId);
  return out;
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("session reorder (issue #274)", () => {
  it("moves a session before another and broadcasts the new order", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "a-old", "a-new");
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
  });

  it("appends within its project when beforeTabId is null", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "a-new", null);
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
  });

  it("appends within its project when beforeTabId names another project's session", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "a-old", "b-1");
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-new", "a-old"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-new", "a-old"], "/p/b": ["b-1"] });
  });

  it("is a broadcast-only no-op for an unknown source", async () => {
    const { registryFile } = setup();
    await invoke(CH.moveSession, "zzz", "a-new");
    expect(lastBroadcastSessions()).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
    expect(diskSessions(registryFile)).toEqual({ "/p/a": ["a-old", "a-new"], "/p/b": ["b-1"] });
  });
});
