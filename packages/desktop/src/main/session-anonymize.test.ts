import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the surfaces it touches (the
// session-delete test's pattern).
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

// The redaction subprocess is what issue #834 delegates to; replace it so the
// test asserts the CALL main makes (resolved paths, gz handling), not omp.
vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return { ...core, anonymizeSession: vi.fn(core.anonymizeSession) };
});

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { anonymizeSession } = await import("@omp-ui/core");
const anonymizeMock = vi.mocked(anonymizeSession);

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const FILE_NAME = `2026-07-29T16-18-42-427Z_${SESSION_ID}.jsonl`;
const SESSION_LINE = `${JSON.stringify({
  type: "session",
  id: SESSION_ID,
  cwd: "/proj",
  timestamp: "2026-07-29T16:18:42.427Z",
})}\n`;

const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: () => {},
  },
};

let base: string;

/** Registry + roots as ADR-0003 lays them out; the active transcript exists
 *  by default, tests remove it to reach the archived/missing states. */
function setup(): { backend: InstanceType<typeof MainBackend>; sessionsRoot: string; archiveRoot: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-anon-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  const ompBin = path.join(base, "omp");
  fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OMP_UI_OMP_PATH = ompBin;

  const sessionsRoot = path.join(agentDir, "sessions");
  const archiveRoot = path.join(agentDir, "archive", "sessions");
  fs.mkdirSync(path.join(sessionsRoot, LINEAGE), { recursive: true });
  fs.mkdirSync(path.join(archiveRoot, LINEAGE), { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, LINEAGE, FILE_NAME), SESSION_LINE);
  fs.writeFileSync(
    path.join(archiveRoot, LINEAGE, `${FILE_NAME}.gz`),
    gzipSync(Buffer.from(SESSION_LINE, "utf8")),
  );

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    settings: { defaultMode: "pty" },
    projects: [
      {
        path: "/proj",
        name: "proj",
        addedAt: "2026-07-29T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
        browserClock: false,
        reviewRoster: null,
        knowledgeHome: null,
        repositoryKey: null,
      },
    ],
    sessions: [
      ownedSessionRecord({
        tabId: "tab-1",
        sessionId: SESSION_ID,
        lineageDir: LINEAGE,
        projectCwd: "/proj",
        launchedAt: "2026-07-29T16:18:42.427Z",
        mode: "pty",
        advisor: false,
        cachedTitle: "Old session",
        cachedModified: "2026-07-29T16:18:42.427Z",
      }),
    ],
  });

  handlers.clear();
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { backend, sessionsRoot, archiveRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  delete process.env.OMP_UI_OMP_PATH;
  anonymizeMock.mockReset();
  anonymizeMock.mockImplementation(async (_ompPath, sessionFile, outDir) => {
    await fs.promises.mkdir(outDir, { recursive: true });
    // Echo what omp would have read: proves main handed it a real transcript.
    await fs.promises.writeFile(
      path.join(outDir, "session.jsonl"),
      await fs.promises.readFile(sessionFile),
    );
    return { ok: true, path: outDir, message: null };
  });
});

describe("session:anonymize (issue #834)", () => {
  it("refuses an unknown tab without touching the binary", async () => {
    setup();
    await expect(invoke(CH.anonymizeSession, "tab-nope")).resolves.toEqual({
      ok: false,
      path: null,
      message: "session not found",
    });
    expect(anonymizeMock).not.toHaveBeenCalled();
  });

  it("runs the redaction into the lineage's anon dir for an active session", async () => {
    const { sessionsRoot } = setup();
    const outDir = path.join(sessionsRoot, LINEAGE, "anon");
    await expect(invoke(CH.anonymizeSession, "tab-1")).resolves.toEqual({
      ok: true,
      path: outDir,
      message: null,
    });
    const [ompPath, sessionFile, dir] = anonymizeMock.mock.calls[0]!;
    expect(ompPath).toBe(path.join(base, "omp"));
    expect(sessionFile).toBe(path.join(sessionsRoot, LINEAGE, FILE_NAME));
    expect(dir).toBe(outDir);
    // The output dir is main's promise to the notice's open/reveal buttons.
    expect(await fs.promises.readFile(path.join(outDir, "session.jsonl"), "utf8")).toBe(
      SESSION_LINE,
    );
  });

  it("gunzips an archived transcript to a temp file and cleans it up", async () => {
    const { sessionsRoot, archiveRoot } = setup();
    fs.rmSync(path.join(sessionsRoot, LINEAGE, FILE_NAME));
    let seenContent = "";
    anonymizeMock.mockImplementationOnce(async (_ompPath, sessionFile, outDir) => {
      seenContent = await fs.promises.readFile(sessionFile, "utf8");
      expect(sessionFile).toMatch(/^.*\.jsonl$/);
      await fs.promises.mkdir(outDir, { recursive: true });
      return { ok: true, path: outDir, message: null };
    });

    const result = (await invoke(CH.anonymizeSession, "tab-1")) as {
      ok: boolean;
      path: string | null;
    };
    expect(result.ok).toBe(true);
    expect(result.path).toBe(path.join(sessionsRoot, LINEAGE, "anon"));
    // omp rejects .jsonl.gz (exit 2, verified live): main fed it the
    // gunzipped bytes, and the temp copy is gone again.
    expect(seenContent).toBe(SESSION_LINE);
    expect(fs.existsSync(path.join(archiveRoot, LINEAGE, `${FILE_NAME}.gz`))).toBe(true);
    const tmpArgs = anonymizeMock.mock.calls[0]![1];
    expect(fs.existsSync(tmpArgs)).toBe(false);
  });

  it("reports a missing transcript", async () => {
    const { sessionsRoot, archiveRoot } = setup();
    fs.rmSync(path.join(sessionsRoot, LINEAGE, FILE_NAME));
    fs.rmSync(path.join(archiveRoot, LINEAGE, `${FILE_NAME}.gz`));
    await expect(invoke(CH.anonymizeSession, "tab-1")).resolves.toEqual({
      ok: false,
      path: null,
      message: "session file not found",
    });
    expect(anonymizeMock).not.toHaveBeenCalled();
  });

  it("passes the binary's refusal through verbatim", async () => {
    setup();
    anonymizeMock.mockResolvedValueOnce({
      ok: false,
      path: null,
      message: "not a valid session file",
    });
    await expect(invoke(CH.anonymizeSession, "tab-1")).resolves.toEqual({
      ok: false,
      path: null,
      message: "not a valid session file",
    });
  });
});
