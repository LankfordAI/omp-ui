import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the surfaces it touches at ipc
// registration (same harness shape as session-fork.test.ts).
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
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
    on: () => {},
  },
}));

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const FILE_NAME = `2026-07-29T16-18-42-427Z_${SESSION_ID}.jsonl`;

const win = {
  isDestroyed: () => false,
  webContents: { send: () => {}, on: () => {}, isDestroyed: () => false },
};

let base: string;

/**
 * Real registry file + real lineage dirs (ADR-0003 layout). `file`: "active"
 * writes the transcript, "archived" only a gzipped one under the archive
 * root, "missing" leaves the lineage dir empty.
 */
function setup(file: "active" | "archived" | "missing"): {
  sessionsRoot: string;
  archiveRoot: string;
} {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-transcript-path-"));
  const agentDir = path.join(base, "agent");
  // Default profile, so PI_CODING_AGENT_DIR wins over the XDG branch.
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const sessionsRoot = path.join(agentDir, "sessions");
  const archiveRoot = path.join(agentDir, "archive", "sessions");
  const activeDir = path.join(sessionsRoot, LINEAGE);
  fs.mkdirSync(activeDir, { recursive: true });
  if (file === "active") {
    fs.writeFileSync(
      path.join(activeDir, FILE_NAME),
      `${JSON.stringify({ type: "session", id: SESSION_ID, cwd: "/proj", timestamp: "2026-07-29T16:18:42.427Z" })}\n`,
    );
  }
  if (file === "archived") {
    const archivedDir = path.join(archiveRoot, LINEAGE);
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(path.join(archivedDir, `${FILE_NAME}.gz`), "gz");
  }

  seedRegistry(path.join(base, "registry.json"), {
    settings: { defaultMode: "pty" },
    projects: [],
    sessions: [
      ownedSessionRecord({
        tabId: "tab-1",
        sessionId: SESSION_ID,
        lineageDir: LINEAGE,
        projectCwd: "/proj",
        launchedAt: "2026-07-29T16:18:42.427Z",
        mode: "rpc-ui",
      }),
    ],
  });

  handlers.clear();
  new MainBackend(win as never, path.join(base, "registry.json")).registerIpc();
  return { sessionsRoot, archiveRoot };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

describe("session:transcriptPath", () => {
  it("resolves the active transcript by _<sessionId>.jsonl", async () => {
    const { sessionsRoot } = setup("active");
    await expect(invoke(CH.sessionTranscriptPath, "tab-1")).resolves.toBe(
      path.join(sessionsRoot, LINEAGE, FILE_NAME),
    );
  });

  it("falls back to the gzipped archive relocation", async () => {
    const { archiveRoot } = setup("archived");
    await expect(invoke(CH.sessionTranscriptPath, "tab-1")).resolves.toBe(
      path.join(archiveRoot, LINEAGE, `${FILE_NAME}.gz`),
    );
  });

  it("returns null when the files are gone", async () => {
    setup("missing");
    await expect(invoke(CH.sessionTranscriptPath, "tab-1")).resolves.toBeNull();
  });

  it("returns null for a never-materialized session id (lazy write)", async () => {
    setup("active");
    // A second record whose transcript never existed.
    const registryFile = path.join(base, "registry.json");
    const raw = JSON.parse(fs.readFileSync(registryFile, "utf8"));
    raw.sessions.push(ownedSessionRecord({ tabId: "tab-lazy", sessionId: null }));
    fs.writeFileSync(registryFile, JSON.stringify(raw));
    await expect(invoke(CH.sessionTranscriptPath, "tab-lazy")).resolves.toBeNull();
  });

  it("returns null for an unknown tab", async () => {
    setup("active");
    await expect(invoke(CH.sessionTranscriptPath, "nope")).resolves.toBeNull();
  });
});
