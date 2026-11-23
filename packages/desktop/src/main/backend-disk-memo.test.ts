import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CH,
  RpcClient,
  SESSION_SPEND_STATUS_KEY,
  emptySpendTotals,
  type BackendState,
  type Registry,
  type RpcFrame,
  type SessionSpendSnapshot,
  type SpendTotals,
} from "@omp-ui/core";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

interface BackendWithRegistry {
  registry: Registry;
}

function backendRegistry(b: MainBackend): Registry {
  // Access private registry in hermetic unit tests to mutate records directly.
  const view = b as unknown as BackendWithRegistry;
  return view.registry;
}

const handlers = vi.hoisted(
  () => new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
);
const resolveSessionLocationMock = vi.hoisted(() => vi.fn());
const hydrateSessionFileMock = vi.hoisted(() => vi.fn());
const readSessionTitlesMock = vi.hoisted(() => vi.fn());
const watchCallbacks = vi.hoisted(
  () => new Map<string, (event: { kind: "changed"; filePath: string } | { kind: "vanished" }) => void>(),
);

interface FakeRpcClient {
  onFrame?: (frame: RpcFrame) => void;
  onExit?: (code: number) => void;
  send: Mock;
  kill: Mock;
}
const rpcClients: FakeRpcClient[] = [];

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  nativeTheme: { shouldUseDarkColors: true },
  Notification: class {
    static isSupported(): boolean {
      return false;
    }
  },
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

vi.mock("@omp-ui/core", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    resolveSessionLocation: resolveSessionLocationMock,
    hydrateSessionFile: hydrateSessionFileMock,
    readSessionTitles: readSessionTitlesMock,
    RpcClient: vi.fn(),
    watchLineageDir: vi.fn((absDir: string, cb: (event: { kind: "changed"; filePath: string } | { kind: "vanished" }) => void) => {
      watchCallbacks.set(absDir, cb);
      return () => {
        watchCallbacks.delete(absDir);
      };
    }),
    watchGitHead: vi.fn(async () => () => {}),
  };
});

const win = {
  isDestroyed: () => false,
  webContents: {
    mainFrame: {},
    isDestroyed: () => false,
    isCrashed: () => false,
    send: vi.fn(),
  },
};

const PROJECT = {
  path: "/projects/memo-test",
  name: "Memo Test",
  addedAt: "2026-10-01T00:00:00.000Z",
  lastModel: null,
  lastThinkingLevel: null,
  lastAdvisor: null,
  lastAdvisorModel: null,
  defaultModel: null,
  defaultAdvisorModel: null,
  browserClock: false,
  councilRoster: null,
  knowledgeHome: null,
  repositoryKey: null,
  icon: null,
};

function writeTranscript(filePath: string, cost: number, totalTokens: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", version: 1, id: "s-1", timestamp: "2026-10-01T00:00:00.000Z", cwd: PROJECT.path }),
    JSON.stringify({
      type: "message",
      id: "m1",
      parentId: null,
      timestamp: "2026-10-01T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [],
        usage: { input: totalTokens, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } },
      },
    }),
  ];
  fs.writeFileSync(filePath, `${lines.join("\n")}\n`, "utf8");
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args));

describe("MainBackend disk memo and cached history titles (#1286)", () => {
  let base = "";
  let agentDir = "";
  let sessionsRoot = "";
  let registryFile = "";
  let backend: MainBackend | null = null;
  let originalAgentDir: string | undefined;

  beforeEach(() => {
    originalAgentDir = process.env.PI_CODING_AGENT_DIR;
    base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-disk-memo-"));
    agentDir = path.join(base, "agent");
    sessionsRoot = path.join(agentDir, "sessions");
    fs.mkdirSync(sessionsRoot, { recursive: true });
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.XDG_DATA_HOME;
    delete process.env.OMP_PROFILE;
    delete process.env.PI_PROFILE;
    registryFile = path.join(base, "registry.json");

    handlers.clear();
    watchCallbacks.clear();
    rpcClients.length = 0;
    win.webContents.send.mockReset();
    resolveSessionLocationMock.mockReset();
    hydrateSessionFileMock.mockReset();
    readSessionTitlesMock.mockReset();
    readSessionTitlesMock.mockReturnValue({ titles: {}, error: null });

    vi.mocked(RpcClient).mockImplementation(function (this: unknown, opts) {
      const client: FakeRpcClient = {
        onFrame: opts.onFrame,
        onExit: opts.onExit,
        send: vi.fn(),
        kill: vi.fn(),
      };
      rpcClients.push(client);
      return client as never;
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    if (backend) {
      await backend.killAll();
      backend = null;
    }
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    fs.rmSync(base, { recursive: true, force: true });
  });

  it("hits the per-record disk memo on consecutive builds with zero extra hydrations", async () => {
    const fileA = path.join(sessionsRoot, "lin-a", "2026-10-01_s-a.jsonl");
    const fileB = path.join(sessionsRoot, "lin-b", "2026-10-01_s-b.jsonl");
    writeTranscript(fileA, 0.1, 100);
    writeTranscript(fileB, 0.2, 200);
    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "tab-a", sessionId: "s-a", lineageDir: "lin-a", projectCwd: PROJECT.path, cachedTitle: "Alpha", cachedModified: "2026-10-01T00:00:00.000Z" }),
        ownedSessionRecord({ tabId: "tab-b", sessionId: "s-b", lineageDir: "lin-b", projectCwd: PROJECT.path, cachedTitle: "Beta", cachedModified: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    resolveSessionLocationMock.mockImplementation(async (_sr: string, _ar: string, lineage: string) => ({
      where: "active" as const,
      filePath: lineage === "lin-a" ? fileA : fileB,
    }));
    hydrateSessionFileMock.mockImplementation(async (fp: string) => ({
      id: fp === fileA ? "s-a" : "s-b",
      title: fp === fileA ? "Alpha" : "Beta",
      status: "idle" as const,
      mtime: new Date("2026-10-01T00:00:00.000Z"),
    }));

    backend = new MainBackend(win as never, registryFile, { historyEnv: { PI_CODING_AGENT_DIR: agentDir } });
    backend.registerIpc();

    await invoke(CH.getState);
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(2);
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(2);

    // Consecutive builds with no change hit the memo completely.
    await invoke(CH.getState);
    await invoke(CH.toggleFavorite, "model-x");
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(2);
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(2);

    // Updating one record's cachedModified re-reads only that one session.
    backendRegistry(backend).updateSession("tab-a", {
      cachedModified: "2026-10-01T00:05:00.000Z",
    });
    await invoke(CH.getState);
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(3);
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(3);
    expect(hydrateSessionFileMock.mock.calls[2]?.[0]).toBe(fileA);
  });

  it("invalidates a memoized record when its lineage watcher emits vanished", async () => {
    const lineageDir = path.join(sessionsRoot, "lin-v");
    const fileV = path.join(lineageDir, "2026-10-01_s-v.jsonl");
    writeTranscript(fileV, 0.1, 100);
    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "tab-v", sessionId: "s-v", lineageDir: "lin-v", projectCwd: PROJECT.path, cachedTitle: "Vanish", cachedModified: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath: fileV });
    hydrateSessionFileMock.mockResolvedValue({
      id: "s-v",
      title: "Vanish",
      status: "idle",
      mtime: new Date("2026-10-01T00:00:00.000Z"),
    });

    backend = new MainBackend(win as never, registryFile, { historyEnv: { PI_CODING_AGENT_DIR: agentDir } });
    backend.registerIpc();
    await backend.hydrateAll();

    const first = (await invoke(CH.getState)) as BackendState;
    expect(first.projects[0]!.sessions[0]!.live).toBe("dormant");
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(1);

    // Simulate watcher reporting lineage vanished; location flips to missing with no registry field change.
    resolveSessionLocationMock.mockResolvedValue({ where: "missing" });
    const cb = watchCallbacks.get(lineageDir);
    expect(cb).toBeDefined();
    const vanishedBroadcast = Promise.withResolvers<BackendState>();
    win.webContents.send.mockImplementationOnce((_ch: string, payload: BackendState) => {
      vanishedBroadcast.resolve(payload);
    });
    cb!({ kind: "vanished" });
    const broadcasted = await vanishedBroadcast.promise;
    expect(broadcasted.projects[0]!.sessions[0]!.live).toBe("missing");
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(2);
    // Subsequent getState hits the newly filled memo (no third resolveSessionLocation call).
    const after = (await invoke(CH.getState)) as BackendState;
    expect(after.projects[0]!.sessions[0]!.live).toBe("missing");
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(2);
  });

  it("re-resolves forkSourceTabId on every build when the parent record is added post-memo", async () => {
    const fileChild = path.join(sessionsRoot, "lin-child", "2026-10-01_s-child.jsonl");
    const fileParent = path.join(sessionsRoot, "lin-parent", "2026-10-01_s-parent.jsonl");
    writeTranscript(fileChild, 0.1, 100);
    writeTranscript(fileParent, 0.1, 100);
    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "tab-child", sessionId: "s-child", lineageDir: "lin-child", projectCwd: PROJECT.path, cachedTitle: "Child", cachedModified: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    resolveSessionLocationMock.mockImplementation(async (_sr: string, _ar: string, lineage: string) => ({
      where: "active" as const,
      filePath: lineage === "lin-child" ? fileChild : fileParent,
    }));
    hydrateSessionFileMock.mockImplementation(async (fp: string) =>
      fp === fileChild
        ? { id: "s-child", title: "Child", parentSession: fileParent, status: "idle" as const, mtime: new Date("2026-10-01T00:00:00.000Z") }
        : { id: "s-parent", title: "Parent", status: "idle" as const, mtime: new Date("2026-10-01T00:00:00.000Z") },
    );

    backend = new MainBackend(win as never, registryFile, { historyEnv: { PI_CODING_AGENT_DIR: agentDir } });
    backend.registerIpc();

    const before = (await invoke(CH.getState)) as BackendState;
    expect(before.projects[0]!.sessions[0]!.forkSourceTabId).toBeNull();
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(1);

    // Add parent record without invalidating child's memo.
    backendRegistry(backend).addSession(
      ownedSessionRecord({ tabId: "tab-parent", sessionId: "s-parent", lineageDir: "lin-parent", projectCwd: PROJECT.path, cachedTitle: "Parent", cachedModified: "2026-10-01T00:00:00.000Z" }),
    );
    const after = (await invoke(CH.getState)) as BackendState;
    const childSummary = after.projects[0]!.sessions.find((s) => s.tabId === "tab-child");
    expect(childSummary?.forkSourceTabId).toBe("tab-parent");
    // Child was not re-hydrated; only the newly added parent hydrated.
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(2);
    expect(hydrateSessionFileMock.mock.calls[1]?.[0]).toBe(fileParent);
  });

  it("forces a miss across live->dormant transition so exit-time disk spend is read immediately", async () => {
    const activePath = path.join(sessionsRoot, "lin-live", "2026-10-01_s-live.jsonl");
    writeTranscript(activePath, 0.25, 250);
    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "t-live", sessionId: "s-live", lineageDir: "lin-live", projectCwd: PROJECT.path, mode: "rpc-ui", cachedTitle: "Live", cachedModified: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath: activePath });
    hydrateSessionFileMock.mockResolvedValue({
      id: "s-live",
      title: "Live",
      status: "idle",
      mtime: new Date("2026-10-01T00:00:00.000Z"),
    });

    backend = new MainBackend(win as never, registryFile, { historyEnv: { PI_CODING_AGENT_DIR: agentDir } });
    backend.registerIpc();

    await invoke(CH.spawnSession, { origin: "resume", resumeTabId: "t-live", cols: 80, rows: 24 });
    const client = rpcClients.at(-1)!;
    const liveTotals: SpendTotals = { ...emptySpendTotals(), cost: 0.9, totalTokens: 900, premiumRequests: 2, requests: 3 };
    const snap: SessionSpendSnapshot = {
      version: 1,
      processKey: "proc-live",
      revision: 1,
      available: true,
      unavailable: null,
      sessionFile: activePath,
      main: liveTotals,
      subagents: emptySpendTotals(),
      total: liveTotals,
      transcripts: 0,
      cacheWarm: emptySpendTotals(),
    };
    client.onFrame?.({
      type: "extension_ui_request",
      id: "spend-1",
      method: "setStatus",
      statusKey: SESSION_SPEND_STATUS_KEY,
      statusText: JSON.stringify(snap),
    });

    const liveState = (await invoke(CH.getState)) as BackendState;
    expect(liveState.projects[0]!.sessions[0]!.spend?.cost).toBeCloseTo(0.9, 6);

    writeTranscript(activePath, 0.95, 950);
    client.onExit?.(0);
    const dormantState = (await invoke(CH.getState)) as BackendState;
    expect(dormantState.projects[0]!.sessions[0]!.spend?.cost).toBeCloseTo(0.95, 6);
  });

  it("re-walks disk spend only after SPEND_PLAN_TTL_MS and clears all on sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-01T00:00:00.000Z"));
    const activePath = path.join(sessionsRoot, "lin-ttl", "2026-10-01_s-ttl.jsonl");
    writeTranscript(activePath, 0.5, 500);
    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "tab-ttl", sessionId: "s-ttl", lineageDir: "lin-ttl", projectCwd: PROJECT.path, cachedTitle: "TTL", cachedModified: "2026-10-01T00:00:00.000Z" }),
      ],
    });
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath: activePath });
    hydrateSessionFileMock.mockResolvedValue({
      id: "s-ttl",
      title: "TTL",
      status: "idle",
      mtime: new Date("2026-10-01T00:00:00.000Z"),
    });

    backend = new MainBackend(win as never, registryFile, { historyEnv: { PI_CODING_AGENT_DIR: agentDir } });
    backend.registerIpc();

    const first = (await invoke(CH.getState)) as BackendState;
    expect(first.projects[0]!.sessions[0]!.spend?.cost).toBeCloseTo(0.5, 6);

    // Mutate transcript on disk without changing registry key; inside 30s TTL it serves cached spend.
    writeTranscript(activePath, 1.25, 1250);
    vi.advanceTimersByTime(10_000);
    const withinTtl = (await invoke(CH.getState)) as BackendState;
    expect(withinTtl.projects[0]!.sessions[0]!.spend?.cost).toBeCloseTo(0.5, 6);
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(1);

    // Past 30s TTL, disk spend re-reads while hydrate remains memoized.
    vi.advanceTimersByTime(25_000);
    const pastTtl = (await invoke(CH.getState)) as BackendState;
    expect(pastTtl.projects[0]!.sessions[0]!.spend?.cost).toBeCloseTo(1.25, 6);
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(1);

    // 10-minute sweep clears the entire memo and triggers a fresh hydrate.
    vi.advanceTimersByTime(10 * 60_000);
    await invoke(CH.getState);
    expect(hydrateSessionFileMock).toHaveBeenCalledTimes(2);
  });

  it("caches readSessionTitles across builds and invalidates when history.db-wal changes", async () => {
    const dbPath = path.join(agentDir, "history.db");
    const walPath = `${dbPath}-wal`;
    fs.writeFileSync(dbPath, "sqlite-placeholder", "utf8");
    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "tab-h", sessionId: "s-h", lineageDir: "lin-h", projectCwd: PROJECT.path, cachedTitle: null }),
      ],
    });
    resolveSessionLocationMock.mockResolvedValue({ where: "missing" });
    readSessionTitlesMock.mockReturnValue({
      titles: { "s-h": { title: "Title v1", updatedAt: 1 } },
      error: null,
    });

    backend = new MainBackend(win as never, registryFile, { historyEnv: { PI_CODING_AGENT_DIR: agentDir } });
    backend.registerIpc();

    const s1 = (await invoke(CH.getState)) as BackendState;
    expect(s1.projects[0]!.sessions[0]!.title).toBe("Title v1");
    expect(readSessionTitlesMock).toHaveBeenCalledTimes(1);

    // Unchanged db + absent wal -> cached, zero extra SQLite reads.
    await invoke(CH.getState);
    expect(readSessionTitlesMock).toHaveBeenCalledTimes(1);

    // Writing history.db-wal invalidates the title cache immediately.
    readSessionTitlesMock.mockReturnValue({
      titles: { "s-h": { title: "Title v2", updatedAt: 2 } },
      error: null,
    });
    fs.writeFileSync(walPath, "wal-bytes", "utf8");
    const s2 = (await invoke(CH.getState)) as BackendState;
    expect(s2.projects[0]!.sessions[0]!.title).toBe("Title v2");
    expect(readSessionTitlesMock).toHaveBeenCalledTimes(2);
  });
});
