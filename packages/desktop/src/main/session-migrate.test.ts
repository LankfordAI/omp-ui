import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// Electron surface stubbed the way the anonymize/delete tests do; dialog gets
// the save/open fakes the auth handlers call.
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
const showSaveDialog = vi.fn();
const showOpenDialog = vi.fn();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: {
    showSaveDialog: (...args: unknown[]) => showSaveDialog(...args),
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args),
  },
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

// The migration is 100% omp's CLI; assert the CALL main makes (paths, cwd)
// and not omp itself.
vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return {
    ...core,
    packSessionFile: vi.fn(core.packSessionFile),
    unpackSessionArchive: vi.fn(core.unpackSessionArchive),
    markSessionMoved: vi.fn(core.markSessionMoved),
    authExport: vi.fn(core.authExport),
    authImport: vi.fn(core.authImport),
  };
});

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const core = await import("@omp-ui/core");
const packMock = vi.mocked(core.packSessionFile);
const unpackMock = vi.mocked(core.unpackSessionArchive);
const movedMock = vi.mocked(core.markSessionMoved);
const exportMock = vi.mocked(core.authExport);
const importMock = vi.mocked(core.authImport);

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
let registryFile: string;
let targetDir: string;

function setup(): { backend: InstanceType<typeof MainBackend>; sessionsRoot: string } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-migrate-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  const ompBin = path.join(base, "omp");
  fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OMP_UI_OMP_PATH = ompBin;

  const sessionsRoot = path.join(agentDir, "sessions");
  fs.mkdirSync(path.join(sessionsRoot, LINEAGE), { recursive: true });
  fs.writeFileSync(path.join(sessionsRoot, LINEAGE, FILE_NAME), SESSION_LINE);
  targetDir = path.join(base, "target-project");
  fs.mkdirSync(targetDir);

  registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    settings: { defaultMode: "pty" },
    projects: [],
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
      ownedSessionRecord({
        tabId: "tab-lazy",
        sessionId: null,
        lineageDir: "omp-ui--proj--99999999-2222-3333-4444-555555555555",
        projectCwd: "/proj",
      }),
    ],
  });

  handlers.clear();
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { backend, sessionsRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  delete process.env.OMP_UI_OMP_PATH;
  for (const mock of [packMock, unpackMock, movedMock, exportMock, importMock]) mock.mockReset();
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("session:pack-start / pack-chunk (issue #888)", () => {
  it("refuses an unknown tab and a transcript-less row without running the binary", async () => {
    setup();
    await expect(invoke(CH.packStart, "tab-nope")).resolves.toMatchObject({
      ok: false,
      message: "session not found",
    });
    await expect(invoke(CH.packStart, "tab-lazy")).resolves.toMatchObject({
      ok: false,
      message: "no transcript to migrate yet",
    });
    expect(packMock).not.toHaveBeenCalled();
  });

  it("packs the active transcript into the staged file and streams it back in chunks", async () => {
    const { sessionsRoot } = setup();
    packMock.mockImplementation(async (_omp, sessionFile, outTar) => {
      expect(sessionFile).toBe(path.join(sessionsRoot, LINEAGE, FILE_NAME));
      await fs.promises.writeFile(outTar, "TARBALLBYTES");
      return { ok: true, missingBlobs: 2 };
    });
    const start = (await invoke(CH.packStart, "tab-1")) as {
      ok: boolean;
      packId: string;
      sizeBytes: number;
      missingBlobs: number;
    };
    expect(start).toMatchObject({ ok: true, sizeBytes: 12, missingBlobs: 2 });
    const chunk = (await invoke(CH.packChunk, start.packId, 0)) as string;
    expect(Buffer.from(chunk, "base64").toString()).toBe("TARBALLBYTES");
    await expect(invoke(CH.packChunk, start.packId, 1)).resolves.toBe("");
    // The staged bundle lives in a private temp dir, not the sessions root.
    const [argOmp, , outTar] = packMock.mock.calls[0]!;
    expect(argOmp).toBe(path.join(base, "omp"));
    expect(outTar.startsWith(os.tmpdir())).toBe(true);
    expect(outTar).not.toContain(sessionsRoot);

    await invoke(CH.packAbort, start.packId);
    expect(fs.existsSync(outTar)).toBe(false);
  });

  it("aborts the staging when omp refuses to pack", async () => {
    setup();
    packMock.mockResolvedValueOnce({ ok: false, message: "session is claimed by another process" });
    await expect(invoke(CH.packStart, "tab-1")).resolves.toMatchObject({
      ok: false,
      message: "session is claimed by another process",
    });
  });
});

describe("session:ingest-* (issue #888)", () => {
  it("unpacks, adopts into a minted lineage dir, and registers an owned row", async () => {
    const { sessionsRoot } = setup();
    const transferId = (await invoke(CH.ingestStart)) as string;
    await invoke(CH.ingestPush, transferId, Buffer.from("TAR").toString("base64"));

    // omp lands the transcript in its own staging layout under the sessions
    // root's default project dir; adoptIntoLineage (real, not mocked) moves it.
    unpackMock.mockImplementation(async (_omp, archive, cwd) => {
      expect(await fs.promises.readFile(archive, "utf8")).toBe("TAR");
      expect(cwd).toBe(targetDir);
      const staging = path.join(sessionsRoot, "unpack-staging");
      await fs.promises.mkdir(staging, { recursive: true });
      const placed = path.join(staging, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`);
      await fs.promises.writeFile(placed, SESSION_LINE);
      return { ok: true, sessionFile: placed };
    });

    const result = (await invoke(CH.ingestFinish, transferId, targetDir)) as {
      ok: boolean;
      tabId: string;
    };
    expect(result.ok).toBe(true);

    const registry = JSON.parse(await fs.promises.readFile(registryFile, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    const row = registry.sessions.find((s) => s.tabId === result.tabId);
    expect(row).toMatchObject({
      sessionId: SESSION_ID,
      projectCwd: targetDir,
      worktree: null,
      proposedPlans: [],
      private: false,
    });
    const lineageDir = row!.lineageDir as string;
    expect(lineageDir).toMatch(/^omp-ui--target-project--[0-9a-f-]{36}$/);
    expect(
      fs.existsSync(
        path.join(sessionsRoot, lineageDir, `2026-07-30T00-00-00-000Z_${SESSION_ID}.jsonl`),
      ),
    ).toBe(true);
  });

  it("refuses a target cwd that is not a directory and shreds the staged bundle", async () => {
    const { sessionsRoot } = setup();
    const transferId = (await invoke(CH.ingestStart)) as string;
    await invoke(CH.ingestPush, transferId, Buffer.from("TAR").toString("base64"));
    await expect(
      invoke(CH.ingestFinish, transferId, path.join(base, "nope")),
    ).resolves.toMatchObject({ ok: false, tabId: null });
    expect(unpackMock).not.toHaveBeenCalled();
    // The staged transfer is gone: a re-finish cannot find it.
    await expect(invoke(CH.ingestFinish, transferId, targetDir)).rejects.toThrow(
      /unknown or expired transfer/,
    );
    void sessionsRoot;
  });

  it("surfaces omp's unpack refusal", async () => {
    setup();
    const transferId = (await invoke(CH.ingestStart)) as string;
    await invoke(CH.ingestPush, transferId, Buffer.from("BAD").toString("base64"));
    unpackMock.mockResolvedValueOnce({ ok: false, message: "archive is corrupt" });
    await expect(invoke(CH.ingestFinish, transferId, targetDir)).resolves.toEqual({
      ok: false,
      tabId: null,
      message: "archive is corrupt",
    });
  });
});

describe("session:mark-moved (issue #888)", () => {
  it("runs omp session moved --to on the active transcript", async () => {
    const { sessionsRoot } = setup();
    movedMock.mockResolvedValueOnce({ ok: true });
    await expect(invoke(CH.markSessionMoved, "tab-1", "work-laptop")).resolves.toEqual({
      ok: true,
      message: null,
    });
    const [ompPath, file, label] = movedMock.mock.calls[0]!;
    expect(ompPath).toBe(path.join(base, "omp"));
    expect(file).toBe(path.join(sessionsRoot, LINEAGE, FILE_NAME));
    expect(label).toBe("work-laptop");
  });
});

describe("auth bundle handlers (issue #888)", () => {
  it("export-bundle writes the temp at 0600, returns base64, and leaves nothing behind", async () => {
    setup();
    exportMock.mockImplementation(async (_omp, outFile) => {
      // NTFS has no POSIX bits; statSync reports 0o666 for any writable
      // file, so the 0600 invariant is only assertable on POSIX (issue #893).
      if (process.platform !== "win32") {
        const mode = fs.statSync(outFile).mode & 0o777;
        expect(mode).toBe(0o600);
      }
      await fs.promises.writeFile(outFile, '{"creds":"secret"}', { mode: 0o600 });
      return { ok: true };
    });
    const b64 = (await invoke(CH.authExportBundle)) as string;
    expect(Buffer.from(b64, "base64").toString()).toBe('{"creds":"secret"}');
    const [, outFile] = exportMock.mock.calls[0]!;
    expect(fs.existsSync(outFile)).toBe(false);
    expect(fs.existsSync(path.dirname(outFile))).toBe(false);
  });

  it("import-bundle shreds the temp after a successful merge-import", async () => {
    setup();
    importMock.mockImplementation(async (_omp, inFile) => {
      expect(fs.readFileSync(inFile, "utf8")).toBe('{"creds":"secret"}');
      return { ok: true };
    });
    await expect(
      invoke(CH.authImportBundle, Buffer.from('{"creds":"secret"}').toString("base64")),
    ).resolves.toEqual({ ok: true, message: null });
    const [, inFile] = importMock.mock.calls[0]!;
    expect(fs.existsSync(inFile)).toBe(false);
    expect(fs.existsSync(path.dirname(inFile))).toBe(false);
  });

  it("save-bundle reports a cancelled dialog as an ok no-op and writes 0600 on confirm", async () => {
    setup();
    showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });
    await expect(invoke(CH.authSaveBundle)).resolves.toEqual({ ok: true, message: "cancelled" });
    expect(exportMock).not.toHaveBeenCalled();

    const chosen = path.join(base, "omp-credentials.json");
    showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: chosen });
    exportMock.mockImplementation(async (_omp, outFile) => {
      await fs.promises.writeFile(outFile, '{"creds":"secret"}', { mode: 0o600 });
      return { ok: true };
    });
    await expect(invoke(CH.authSaveBundle)).resolves.toEqual({ ok: true, message: null });
    expect(fs.readFileSync(chosen, "utf8")).toBe('{"creds":"secret"}');
    if (process.platform !== "win32") {
      expect(fs.statSync(chosen).mode & 0o777).toBe(0o600);
    }
  });

  it("import-file runs omp auth import on the user's own file untouched", async () => {
    setup();
    const userFile = path.join(base, "their-copy.json");
    fs.writeFileSync(userFile, '{"creds":"theirs"}');
    importMock.mockResolvedValueOnce({ ok: true });
    await expect(invoke(CH.authImportFile, userFile)).resolves.toEqual({ ok: true, message: null });
    expect(importMock.mock.calls[0]![1]).toBe(userFile);
    expect(fs.existsSync(userFile)).toBe(true);
  });
});
