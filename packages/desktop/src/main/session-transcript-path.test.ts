import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  webContents: { mainFrame: {}, send: () => {}, on: () => {}, isDestroyed: () => false, isCrashed: () => false },
};

let base: string;
let backend: InstanceType<typeof MainBackend> | undefined;

afterEach(async () => {
  try {
    await backend?.killAll();
  } finally {
    backend = undefined;
    vi.unstubAllEnvs();
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/**
 * Real registry file and lineage directories (ADR-0003). The lazy tab shares
 * the lineage, so a null session id must not resolve the other transcript.
 */
function setup(file: "active" | "missing"): { sessionsRoot: string; archiveRoot: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-transcript-path-"));
  const agentDir = path.join(base, "agent");
  // Default profile, so PI_CODING_AGENT_DIR wins over the XDG branch.
  vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
  vi.stubEnv("XDG_DATA_HOME", undefined);
  vi.stubEnv("OMP_PROFILE", undefined);
  vi.stubEnv("PI_PROFILE", undefined);

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
      ownedSessionRecord({ tabId: "tab-lazy", sessionId: null, lineageDir: LINEAGE }),
    ],
  });

  handlers.clear();
  backend = new MainBackend(win as never, path.join(base, "registry.json"));
  backend.registerIpc();
  return { sessionsRoot, archiveRoot };
}

const sessionReference = (tabId: string): Promise<unknown> =>
  Promise.resolve(
    handlers.get(CH.sessionReference)!(
      { sender: win.webContents, senderFrame: win.webContents.mainFrame },
      tabId,
    ),
  );

describe("session:reference transcript resolution", () => {
  it("resolves the active transcript by _<sessionId>.jsonl", async () => {
    const { sessionsRoot } = setup("active");
    await expect(sessionReference("tab-1")).resolves.toMatchObject({
      sessionId: SESSION_ID,
      path: path.join(sessionsRoot, LINEAGE, FILE_NAME),
    });
  });

  it("re-resolves the transcript after omp gc relocates it to the gzipped archive", async () => {
    const { sessionsRoot, archiveRoot } = setup("active");
    const activePath = path.join(sessionsRoot, LINEAGE, FILE_NAME);
    await expect(sessionReference("tab-1")).resolves.toMatchObject({ path: activePath });

    const archivedDir = path.join(archiveRoot, LINEAGE);
    const archivedPath = path.join(archivedDir, `${FILE_NAME}.gz`);
    fs.mkdirSync(archivedDir, { recursive: true });
    fs.writeFileSync(archivedPath, gzipSync(fs.readFileSync(activePath)));
    fs.unlinkSync(activePath);

    await expect(sessionReference("tab-1")).resolves.toMatchObject({ path: archivedPath });
  });

  it("returns null when the files are gone", async () => {
    setup("missing");
    await expect(sessionReference("tab-1")).resolves.toBeNull();
  });

  it("returns null for a never-materialized session id (lazy write)", async () => {
    setup("active");
    await expect(sessionReference("tab-lazy")).resolves.toBeNull();
  });

  it("returns null for an unknown tab", async () => {
    setup("active");
    await expect(sessionReference("nope")).resolves.toBeNull();
  });
});
