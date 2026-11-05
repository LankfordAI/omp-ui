// Issue #1034: the resume picker's title fallback chain gains a third rung —
// omp's read-only history.db `session_titles` index — inside MainBackend's
// SessionSummary builder. Chain: live-file hydrate title > record.cachedTitle
// > history.db title > "New session". Everything here is hermetic: the backend
// takes a `historyEnv` seam and core's readSessionTitles treats
// PI_CODING_AGENT_DIR as a true override, so the developer's real ~/.omp is
// never consulted; fixture dbs are built writable per call (memory-store.test.ts
// convention) under an mkdtemp dir.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, type BackendState, type ProjectRecord } from "@omp-ui/core";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
const resolveSessionLocationMock = vi.hoisted(() => vi.fn());

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
  const original = await importOriginal();
  return {
    ...(original as object),
    resolveSessionLocation: resolveSessionLocationMock,
    RpcClient: vi.fn(),
    watchLineageDir: vi.fn(() => () => {}),
    watchGitHead: vi.fn(async () => () => {}),
  };
});

const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
  },
};

let base = "";
let agentDir = "";
let registryFile = "";

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

/** Port of session-index.ts (omp ≥18.3.0): the only table core's probe needs. */
const SESSION_TITLES_DDL = `
CREATE TABLE IF NOT EXISTS session_titles (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
`;

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

/** Write a fixture history.db with title rows at <agentDir>/history.db. */
function seedHistoryTitles(rows: Array<[string, string]>): void {
  fs.mkdirSync(agentDir, { recursive: true });
  const dbPath = path.join(agentDir, "history.db");
  withDb(dbPath, (db) => {
    db.exec(SESSION_TITLES_DDL);
    const insert = db.prepare("INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)");
    for (const [sessionId, title] of rows) {
      insert.run(sessionId, title, 1_760_000_000);
    }
  });
}

function writeSessionFile(filePath: string, sessionId: string, title?: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(
    filePath,
    `${JSON.stringify({ type: "session", id: sessionId, cwd: "/p/a", ...(title ? { title } : {}) })}\n`,
    "utf8",
  );
}

const PROJECT_A = {
  path: "/p/a",
  name: "A",
  addedAt: "2026-08-01T00:00:00.000Z",
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
} satisfies ProjectRecord;

function seedSession(patch = {}): void {
  seedRegistry(registryFile, {
    projects: [PROJECT_A],
    sessions: [ownedSessionRecord({ projectCwd: "/p/a", ...patch })],
  });
}

// A fresh backend per test (constructed AFTER seeding): the env seam points
// core's candidate list at the mkdtemp agent dir ONLY (PI_CODING_AGENT_DIR is a
// true override core-side), so the fixtures below decide everything the
// picker sees — never the developer's real ~/.omp/agent/history.db.
function registerBackend(): void {
  new MainBackend(win as never, registryFile, {
    historyEnv: { PI_CODING_AGENT_DIR: agentDir },
  }).registerIpc();
}

async function stateTitle(): Promise<string | undefined> {
  const state = (await invoke(CH.getState)) as BackendState;
  return state.projects[0]?.sessions[0]?.title;
}

const SESSION_ID = "0198c0ffee-0000-7000-8000-000000000001";

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-titles-"));
  agentDir = path.join(base, "agent");
  registryFile = path.join(base, "registry.json");
  // Keep every non-history path resolver inside the tmp tree too.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  handlers.clear();
  resolveSessionLocationMock.mockReset().mockResolvedValue({ where: "missing" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("history.db title gap-fill in SessionSummary (issue #1034)", () => {
  it("fills a dormant untitled record from the history index", async () => {
    seedSession({ sessionId: SESSION_ID, cachedTitle: null });
    // Dormant: the transcript exists at the active location but carries no
    // title of its own.
    const filePath = path.join(base, "sessions", "omp-ui--a--1", "s.jsonl");
    writeSessionFile(filePath, SESSION_ID);
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath });
    seedHistoryTitles([[SESSION_ID, "Refactor the parser"]]);
    registerBackend();

    expect(await stateTitle()).toBe("Refactor the parser");
  });

  it("never regresses a cachedTitle onto a history title", async () => {
    seedSession({ sessionId: SESSION_ID, cachedTitle: "Cached name" });
    const filePath = path.join(base, "sessions", "omp-ui--a--1", "s.jsonl");
    writeSessionFile(filePath, SESSION_ID);
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath });
    seedHistoryTitles([[SESSION_ID, "Stale index title"]]);
    registerBackend();

    expect(await stateTitle()).toBe("Cached name");
  });

  it("keeps the live-file title above every cached source", async () => {
    seedSession({ sessionId: SESSION_ID, cachedTitle: "Cached name" });
    const filePath = path.join(base, "sessions", "omp-ui--a--1", "s.jsonl");
    writeSessionFile(filePath, SESSION_ID, "⚡ FIX-1: File title");
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath });
    seedHistoryTitles([[SESSION_ID, "Stale index title"]]);
    registerBackend();

    // Raw string through main — title-card splitting is renderer-side only.
    expect(await stateTitle()).toBe("⚡ FIX-1: File title");
  });

  it("does not persist a history title into the registry cache", async () => {
    seedSession({ sessionId: SESSION_ID, cachedTitle: null });
    const filePath = path.join(base, "sessions", "omp-ui--a--1", "s.jsonl");
    writeSessionFile(filePath, SESSION_ID);
    resolveSessionLocationMock.mockResolvedValue({ where: "active", filePath });
    seedHistoryTitles([[SESSION_ID, "Refactor the parser"]]);
    registerBackend();

    await invoke(CH.getState);
    // History.db rows are tombstone-free orphans until `omp gc`; caching one
    // could persist a stale title, so cachedTitle stays null on disk.
    const persisted = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
      sessions: Array<{ tabId: string; cachedTitle: string | null }>;
    };
    expect(persisted.sessions.find((s) => s.tabId === "tab-1")?.cachedTitle).toBeNull();
  });

  it("swallows a missing history db and still builds state", async () => {
    seedSession({ sessionId: SESSION_ID, cachedTitle: null });
    // agentDir stays empty → readSessionTitles resolves nothing → .error path.
    registerBackend();

    expect(await stateTitle()).toBe("New session");
  });

  it("swallows a foreign database at the history.db path", async () => {
    seedSession({ sessionId: SESSION_ID, cachedTitle: "Cached name" });
    fs.mkdirSync(agentDir, { recursive: true });
    withDb(path.join(agentDir, "history.db"), (db) => {
      db.exec("CREATE TABLE unrelated (x INTEGER)");
    });
    registerBackend();

    expect(await stateTitle()).toBe("Cached name");
  });

  it("ignores history rows for records with no session id", async () => {
    seedSession({ sessionId: null, cachedTitle: null });
    seedHistoryTitles([["some-other-session", "Not mine"]]);
    registerBackend();

    expect(await stateTitle()).toBe("New session");
  });
});
