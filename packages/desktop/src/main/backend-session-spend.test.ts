import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CoreModule from "@omp-ui/core";
import {
  CH,
  SESSION_SPEND_STATUS_KEY,
  emptySpendTotals,
  type BackendState,
  type ProjectRecord,
  type RpcFrame,
  type SessionSpendSnapshot,
  type SpendTotals,
} from "@omp-ui/core";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
const resolveSessionLocationMock = vi.hoisted(() => vi.fn());
const rpcClients: Array<{ onFrame?: (frame: RpcFrame) => void; onExit?: (code: number) => void; kill: () => void }> = [];

vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
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
  const original = await importOriginal<typeof CoreModule>();
  return {
    ...original,
    resolveSessionLocation: resolveSessionLocationMock,
    RpcClient: vi.fn(function (this: Record<string, unknown>, opts: { onFrame?: (frame: RpcFrame) => void; onExit?: (code: number) => void }) {
      const client = {
        onFrame: opts.onFrame,
        onExit: opts.onExit,
        kill: vi.fn(),
        send: vi.fn(),
        dead: false,
      };
      rpcClients.push(client);
      return client;
    }),
    watchLineageDir: vi.fn(() => () => {}),
    watchGitHead: vi.fn(async () => () => {}),
  };
});

const win = {
  isDestroyed: () => false,
  webContents: {
    mainFrame: {},
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
  },
};

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve().then(() =>
    handlers.get(ch)!({ sender: win.webContents, senderFrame: win.webContents.mainFrame }, ...args),
  );

const PROJECT: ProjectRecord = {
  path: "/p/spend",
  name: "Spend",
  addedAt: "2026-11-22T00:00:00.000Z",
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

let base = "";
let agentDir = "";
let registryFile = "";
let sessionsRoot = "";
let archiveRoot = "";
let backend: MainBackend | null = null;

function writeTranscript(filePath: string, cost: number, tokens: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const lines = [
    JSON.stringify({ type: "session", id: "sess-1", timestamp: "2026-11-22T10:00:00.000Z", cwd: PROJECT.path }),
    JSON.stringify({
      type: "message",
      timestamp: "2026-11-22T10:00:05.000Z",
      message: {
        role: "assistant",
        usage: { cost: { total: cost }, input: tokens, output: 0, totalTokens: tokens, premiumRequests: 1 },
      },
    }),
  ].join("\n") + "\n";
  if (filePath.endsWith(".gz")) {
    fs.writeFileSync(filePath, zlib.gzipSync(Buffer.from(lines, "utf8")));
  } else {
    fs.writeFileSync(filePath, lines, "utf8");
  }
}

beforeEach(() => {
  handlers.clear();
  rpcClients.length = 0;
  resolveSessionLocationMock.mockReset();
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-spend-"));
  agentDir = path.join(base, "agent");
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  registryFile = path.join(base, "registry.json");
  sessionsRoot = path.join(base, "sessions");
  archiveRoot = path.join(base, "archive");
});

afterEach(async () => {
  await backend?.killAll();
  backend = null;
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("MainBackend SessionSummary.spend", () => {
  it("reports disk-scanned spend for dormant active and archived sessions, and null when missing", async () => {
    const activePath = path.join(sessionsRoot, "lin-active", "2026-11-22_s-active.jsonl");
    const archivedPath = path.join(archiveRoot, "lin-arch", "2026-11-22_s-arch.jsonl.gz");
    writeTranscript(activePath, 0.35, 350);
    writeTranscript(archivedPath, 0.45, 450);

    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({ tabId: "t-active", sessionId: "s-active", lineageDir: "lin-active", projectCwd: PROJECT.path }),
        ownedSessionRecord({ tabId: "t-arch", sessionId: "s-arch", lineageDir: "lin-arch", projectCwd: PROJECT.path }),
        ownedSessionRecord({ tabId: "t-new", sessionId: null, lineageDir: "lin-new", projectCwd: PROJECT.path }),
      ],
    });
    resolveSessionLocationMock.mockImplementation(async (_sr: string, _ar: string, lineageDir: string) => {
      if (lineageDir === "lin-active") return { where: "active", filePath: activePath };
      if (lineageDir === "lin-arch") return { where: "archived", filePath: archivedPath };
      return { where: "missing" };
    });

    backend = new MainBackend(win as never, registryFile, {
      historyEnv: { PI_CODING_AGENT_DIR: agentDir },
    });
    backend.registerIpc();

    const state = (await invoke(CH.getState)) as BackendState;
    const byId = new Map(state.projects[0]!.sessions.map((s) => [s.tabId, s]));
    expect(byId.get("t-active")?.spend?.cost).toBeCloseTo(0.35, 6);
    expect(byId.get("t-active")?.spend?.totalTokens).toBe(350);
    expect(byId.get("t-arch")?.spend?.cost).toBeCloseTo(0.45, 6);
    expect(byId.get("t-arch")?.spend?.totalTokens).toBe(450);
    expect(byId.get("t-new")?.spend).toBeNull();
  });

  it("prefers live bridge spend while running and falls back to disk scan on process exit", async () => {
    const activePath = path.join(sessionsRoot, "lin-live", "2026-11-22_s-live.jsonl");
    writeTranscript(activePath, 0.2, 200);

    seedRegistry(registryFile, {
      projects: [PROJECT],
      sessions: [
        ownedSessionRecord({
          tabId: "t-live",
          sessionId: "s-live",
          lineageDir: "lin-live",
          projectCwd: PROJECT.path,
          mode: "rpc-ui",
        }),
      ],
    });
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath: activePath });

    backend = new MainBackend(win as never, registryFile, {
      historyEnv: { PI_CODING_AGENT_DIR: agentDir },
    });
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

    // Update transcript on disk, then exit the live process -> summarize falls back to disk.
    writeTranscript(activePath, 0.95, 950);
    client.onExit?.(0);
    const dormantState = (await invoke(CH.getState)) as BackendState;
    expect(dormantState.projects[0]!.sessions[0]!.spend?.cost).toBeCloseTo(0.95, 6);
  });
});
