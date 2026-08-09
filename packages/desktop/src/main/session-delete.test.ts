import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// The real MainBackend imports electron; stub the three surfaces it touches.
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

vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof import("@omp-ui/core")>();
  return {
    ...core,
    spawnOmp: vi.fn(),
    resolveSessionLocation: vi.fn(core.resolveSessionLocation),
  };
});

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { spawnOmp, resolveSessionLocation } = await import("@omp-ui/core");
const spawnOmpMock = vi.mocked(spawnOmp);
const resolveSessionLocationMock = vi.mocked(resolveSessionLocation);

const SESSION_ID = "019faeab-cc7b-7000-8bfc-67242a2869d8";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const FILE_NAME = `2026-07-29T16-18-42-427Z_${SESSION_ID}.jsonl`;

const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;
let nextDiesOn: "default" | "SIGKILL" | "never" = "default";
const spawnedSignals: string[][] = [];

/** Real registry file + real lineage dirs in both roots, exactly as ADR-0003 lays them out. */
function setup(): {
  backend: InstanceType<typeof MainBackend>;
  sessionsRoot: string;
  archiveRoot: string;
} {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-del-"));
  const agentDir = path.join(base, "agent");
  // Default profile, so PI_CODING_AGENT_DIR wins over the XDG branch (paths.ts:38).
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  const ompBin = path.join(base, "omp");
  fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OMP_UI_OMP_PATH = ompBin;

  const sessionsRoot = path.join(agentDir, "sessions");
  const archiveRoot = path.join(agentDir, "archive", "sessions");
  const activeDir = path.join(sessionsRoot, LINEAGE);
  const artifacts = path.join(activeDir, path.basename(FILE_NAME, ".jsonl"));
  fs.mkdirSync(artifacts, { recursive: true });
  fs.mkdirSync(path.join(archiveRoot, LINEAGE), { recursive: true });
  fs.writeFileSync(
    path.join(activeDir, FILE_NAME),
    `${JSON.stringify({
      type: "session",
      id: SESSION_ID,
      cwd: "/proj",
      timestamp: "2026-07-29T16:18:42.427Z",
    })}\n`,
  );
  fs.writeFileSync(path.join(artifacts, "__advisor.jsonl"), "advisor\n");
  fs.writeFileSync(path.join(archiveRoot, LINEAGE, "old.jsonl.gz"), "gz");

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    settings: { defaultMode: "pty" },
    projects: [
      {
        path: "/proj",
        name: "proj",
        addedAt: "2026-07-29T00:00:00.000Z",
        lastModel: null,
        lastAdvisorModel: null,
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
  sent.length = 0;
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { backend, sessionsRoot, archiveRoot };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);
const readRegistry = (): { sessions: unknown[] } =>
  JSON.parse(fs.readFileSync(path.join(base, "registry.json"), "utf8"));

async function launchLive(diesOn: "default" | "SIGKILL" | "never"): Promise<string[]> {
  nextDiesOn = diesOn;
  await invoke(CH.spawnSession, {
    projectCwd: "/proj",
    mode: "pty",
    advisor: false,
    cols: 80,
    rows: 24,
    resumeTabId: "tab-1",
  });
  return spawnedSignals.at(-1)!;
}

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  delete process.env.OMP_UI_OMP_PATH;
  spawnedSignals.length = 0;
  nextDiesOn = "default";
  resolveSessionLocationMock.mockClear();
  spawnOmpMock.mockReset();
  spawnOmpMock.mockImplementation((opts) => {
    const signals: string[] = [];
    spawnedSignals.push(signals);
    let exitCb: ((event: { exitCode: number }) => void) | undefined;
    const kill: Mock = vi.fn((signal?: string) => {
      signals.push(signal ?? "default");
      const obeys =
        nextDiesOn === "default"
          ? signal === undefined
          : nextDiesOn === "SIGKILL" && signal === "SIGKILL";
      if (obeys) exitCb?.({ exitCode: 0 });
    });
    return {
      id: opts.id,
      onData: () => vi.fn(),
      onExit: (cb) => {
        exitCb = cb;
      },
      write: vi.fn(),
      resize: vi.fn(),
      kill,
    };
  });
});

describe("session:delete", () => {
  it("erases the record, the transcript, its artifacts, and the archived copy", async () => {
    const { sessionsRoot, archiveRoot } = setup();

    // The row is visible before the delete — the precondition the sidebar shows.
    const before = (await invoke(CH.getState)) as { projects: { sessions: { title: string }[] }[] };
    expect(before.projects[0]!.sessions.map((s) => s.title)).toEqual(["Old session"]);

    await invoke(CH.deleteSession, "tab-1");

    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
    expect(fs.existsSync(path.join(archiveRoot, LINEAGE))).toBe(false);
    expect(readRegistry().sessions).toEqual([]);
    // The sidebar learns about it by broadcast, not by polling.
    const broadcast = sent.filter((m) => m.channel === CH.onStateChanged).at(-1);
    const state = broadcast!.args[0] as { projects: { sessions: unknown[] }[] };
    expect(state.projects[0]!.sessions).toEqual([]);
    // The shared roots survive: omp's own sessions live there too.
    expect(fs.existsSync(sessionsRoot)).toBe(true);
    expect(fs.existsSync(archiveRoot)).toBe(true);
  });

  it("stops a live session, then erases the record and its files", async () => {
    const { sessionsRoot } = setup();
    const signals = await launchLive("default");

    await invoke(CH.deleteSession, "tab-1");

    expect(signals).toEqual(["default"]);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
    expect(readRegistry().sessions).toEqual([]);
    // The tab is going away — an exit notice would be noise about a session
    // the user just deleted.
    expect(sent.filter((m) => m.channel === CH.onPtyExit)).toEqual([]);
  });

  it("escalates to SIGKILL when omp ignores the first signal", async () => {
    vi.useFakeTimers();
    try {
      const { sessionsRoot } = setup();
      const signals = await launchLive("SIGKILL");

      const done = invoke(CH.deleteSession, "tab-1") as Promise<void>;
      await vi.advanceTimersByTimeAsync(3_000);
      await done;

      expect(signals).toEqual(["default", "SIGKILL"]);
      expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
      expect(readRegistry().sessions).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });

  // Unlinking the lineage dir under a live writer would lose the delete (or
  // see omp recreate it), so an unkillable process keeps its files.
  it("keeps the session when even SIGKILL does not reap the process", async () => {
    vi.useFakeTimers();
    try {
      const { sessionsRoot } = setup();
      await launchLive("never");

      const done = invoke(CH.deleteSession, "tab-1") as Promise<void>;
      const settled = expect(done).rejects.toThrow(/did not exit/);
      await vi.advanceTimersByTimeAsync(5_000);
      await settled;

      expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, FILE_NAME))).toBe(true);
      expect(readRegistry().sessions).toHaveLength(1);
      // Still live, so a later exit would remain renderer-visible.
      expect(spawnOmpMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  // The resume path awaits (unarchive/hydrate) before it registers the session
  // as live, so a delete arriving in that window has to wait for the spawn
  // rather than race the process that is about to own these files.
  it("waits for an in-flight resume spawn before deleting", async () => {
    const { sessionsRoot } = setup();
    let finishLookup = (): void => {};
    let lookupStarted = (): void => {};
    const started = new Promise<void>((resolve) => {
      lookupStarted = resolve;
    });
    const realLookup = resolveSessionLocationMock.getMockImplementation()!;
    resolveSessionLocationMock.mockImplementationOnce(async (...args) => {
      lookupStarted();
      await new Promise<void>((resolve) => {
        finishLookup = resolve;
      });
      return realLookup(...args);
    });

    const spawning = invoke(CH.spawnSession, {
      projectCwd: "/proj",
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
      resumeTabId: "tab-1",
    }) as Promise<unknown>;
    await started;
    const done = invoke(CH.deleteSession, "tab-1") as Promise<void>;
    // Nothing may happen while resume is still resolving its transcript.
    await Promise.resolve();
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE, FILE_NAME))).toBe(true);

    finishLookup();
    await spawning;
    await done;

    expect(spawnedSignals[0]).toEqual(["default"]);
    expect(readRegistry().sessions).toEqual([]);
  });

  it("keeps the record when the files cannot be deleted, so the row stays retryable", async () => {
    setup();
    const rm = vi.spyOn(fs.promises, "rm").mockRejectedValueOnce(new Error("EBUSY"));
    await expect(invoke(CH.deleteSession, "tab-1")).rejects.toThrow(/EBUSY/);
    expect(readRegistry().sessions).toHaveLength(1);
    rm.mockRestore();
  });

  it("is a no-op for an unknown tab", async () => {
    setup();
    await expect(invoke(CH.deleteSession, "nope")).resolves.toBeUndefined();
    expect(readRegistry().sessions).toHaveLength(1);
  });
});
