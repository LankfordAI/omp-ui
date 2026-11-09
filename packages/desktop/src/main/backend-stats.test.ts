import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Mock } from "vitest";
import {
  CH,
  emptyStatsOverview,
} from "@omp-ui/core";
import type {
  StatsCollectorDependencies,
  StatsOverview,
  StatsQuery,
  StatsSourceInfo,
  StatsSyncMode,
  StatsSyncState,
} from "@omp-ui/core";
import { MainBackend } from "./backend";
import { seedRegistry } from "./test/fixtures";

const mocks = vi.hoisted(() => ({
  collector: vi.fn(),
  source: vi.fn(),
  read: vi.fn(),
  ompPath: vi.fn(),
}));
const ipc = new Map<string, (event: unknown, ...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  Notification: class {
    static isSupported(): boolean { return false; }
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (value: string) => Buffer.from(`enc:${value}`, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ipc.set(channel, fn),
    on: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => ipc.set(channel, fn),
  },
}));

vi.mock("@omp-ui/core", async (importOriginal) => ({
  ...(await importOriginal() as object),
  StatsCollector: vi.fn(function (deps: StatsCollectorDependencies) { return mocks.collector(deps); }),
  resolveStatsSource: mocks.source,
  readStatsOverview: mocks.read,
  resolveOmpBinary: mocks.ompPath,
  RpcClient: vi.fn(),
  watchLineageDir: vi.fn(() => () => {}),
  watchGitHead: vi.fn(async () => () => {}),
}));

const win = {
  isDestroyed: () => false,
  webContents: { mainFrame: {}, isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};
const query: StatsQuery = {
  rangeDays: 7,
  projectKey: null,
  provider: null,
  model: null,
  agentType: null,
};
const backends: MainBackend[] = [];
let base: string;
let registryFile: string;
let source: StatsSourceInfo;
let collector: {
  start: Mock<(mode: StatsSyncMode) => StatsSyncState>;
  status: Mock<() => StatsSyncState>;
  dispose: Mock<() => Promise<void>>;
};

function boot(): MainBackend {
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  backends.push(backend);
  return backend;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = ipc.get(channel);
  if (!handler) throw new Error(`missing IPC handler: ${channel}`);
  return Promise.resolve().then(() => handler({sender: win.webContents, senderFrame: win.webContents.mainFrame}, ...args));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-stats-"));
  registryFile = path.join(base, "registry.json");
  vi.stubEnv("PI_CODING_AGENT_DIR", path.join(base, "agent"));
  vi.stubEnv("OMP_PROFILE", "");
  vi.stubEnv("PI_PROFILE", "");
  vi.stubEnv("XDG_DATA_HOME", "");
  source = {
    profile: null,
    databasePath: path.join(base, "stats-source", "stats.db"),
    sessionsRoot: path.join(base, "stats-source", "sessions"),
    archiveRoot: path.join(base, "stats-source", "sessions", "archive"),
  };
  mocks.collector.mockReset();
  mocks.source.mockReset().mockReturnValue(source);
  mocks.ompPath.mockReset().mockReturnValue(path.join(base, "omp-before-update"));
  mocks.read.mockReset().mockImplementation(async (selection: StatsQuery) => emptyStatsOverview(selection, source, null));
  collector = {
    start: vi.fn(),
    status: vi.fn(),
    dispose: vi.fn().mockResolvedValue(undefined),
  };
  mocks.collector.mockReturnValue(collector);
  ipc.clear();
  seedRegistry(registryFile);
});

afterEach(async () => {
  await Promise.allSettled(backends.splice(0).map((backend) => backend.killAll()));
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("host-owned Stats", () => {

  it("returns invalid-source explicitly without reading a different database, then recovers", async () => {
    boot();
    mocks.source.mockImplementationOnce(() => { throw new Error("Invalid OMP profile"); });
    const invalid = await invoke(CH.statsOverview, query) as StatsOverview;
    expect(invalid).toMatchObject({
      query, source: null, databasePresent: false, dataState: "invalid-source", error: "Invalid OMP profile",
    });
    expect(mocks.read).not.toHaveBeenCalled();
    expect(collector.start).not.toHaveBeenCalled();
    const recovered = await invoke(CH.statsOverview, query) as StatsOverview;
    expect(recovered.source).toEqual(source);
    expect(recovered.dataState).toBe("missing");
    expect(mocks.read).toHaveBeenCalledTimes(1);
  });


  it("begins collector cancellation synchronously and awaits settlement before shutdown resolves", async () => {
    const backend = boot();
    const reaped = Promise.withResolvers<void>();
    collector.dispose.mockReturnValueOnce(reaped.promise);
    const shutdown = backend.killAll();
    expect(collector.dispose).toHaveBeenCalledTimes(1);
    let settled = false;
    void shutdown.then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    reaped.resolve();
    await shutdown;
    expect(settled).toBe(true);
  });

  it("settles shutdown even when collector disposal rejects", async () => {
    const backend = boot();
    collector.dispose.mockRejectedValueOnce(new Error("fixture reaping failure"));
    await expect(backend.killAll()).resolves.toBeUndefined();
  });
});
