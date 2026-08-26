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
    isCrashed: () => false,
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
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
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
    await expect(invoke(CH.deleteSession, "tab-1", false)).rejects.toThrow(/EBUSY/);
    expect(readRegistry().sessions).toHaveLength(1);
    rm.mockRestore();
  });

  it("is a no-op for an unknown tab", async () => {
    setup();
    await expect(invoke(CH.deleteSession, "nope", false)).resolves.toBeUndefined();
    expect(readRegistry().sessions).toHaveLength(1);
  });
});

const LINEAGE_S = "omp-ui--proj--aaaaaaaa-1111-2222-3333-444444444444";
const LINEAGE_I1 = "omp-ui--proj--bbbbbbbb-1111-2222-3333-444444444444";
const LINEAGE_I2 = "omp-ui--proj--cccccccc-1111-2222-3333-444444444444";
const LINEAGE_U = "omp-ui--proj--dddddddd-1111-2222-3333-444444444444";

const handoff = (sourceTabId: string) => ({
  sourceTabId,
  planTitle: "Plan",
  planFilePath: "local://plans/plan.md",
});

/**
 * source tab-s → implementation tab-i1 → grandchild tab-i2, plus an
 * unrelated tab-u; every session gets its own lineage dir in both roots.
 */
function setupCascade(): {
  sessionsRoot: string;
  archiveRoot: string;
} {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-del-"));
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
  const files: Array<[lineage: string, title: string]> = [
    [LINEAGE_S, "Source session"],
    [LINEAGE_I1, "Implementation one"],
    [LINEAGE_I2, "Implementation two"],
    [LINEAGE_U, "Unrelated session"],
  ];
  for (const [lineage, title] of files) {
    const activeDir = path.join(sessionsRoot, lineage);
    fs.mkdirSync(activeDir, { recursive: true });
    fs.writeFileSync(
      path.join(activeDir, FILE_NAME),
      `${JSON.stringify({ type: "title", title })}\n${JSON.stringify({
        type: "session",
        id: SESSION_ID,
        cwd: "/proj",
        timestamp: "2026-07-29T16:18:42.427Z",
      })}\n`,
    );
    fs.mkdirSync(path.join(archiveRoot, lineage), { recursive: true });
  }

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
      },
    ],
    sessions: [
      ownedSessionRecord({
        tabId: "tab-s",
        sessionId: SESSION_ID,
        lineageDir: LINEAGE_S,
        projectCwd: "/proj",
        mode: "pty",
        cachedTitle: "Source session",
      }),
      ownedSessionRecord({
        tabId: "tab-i1",
        sessionId: SESSION_ID,
        lineageDir: LINEAGE_I1,
        projectCwd: "/proj",
        mode: "pty",
        planImplementationSource: handoff("tab-s"),
        cachedTitle: "Implementation one",
      }),
      ownedSessionRecord({
        tabId: "tab-i2",
        sessionId: SESSION_ID,
        lineageDir: LINEAGE_I2,
        projectCwd: "/proj",
        mode: "rpc-ui",
        planImplementationSource: handoff("tab-i1"),
        cachedTitle: "Implementation two",
      }),
      ownedSessionRecord({
        tabId: "tab-u",
        sessionId: SESSION_ID,
        lineageDir: LINEAGE_U,
        projectCwd: "/proj",
        mode: "pty",
        cachedTitle: "Unrelated session",
      }),
    ],
  });

  handlers.clear();
  sent.length = 0;
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { sessionsRoot, archiveRoot };
}

const launchTab = async (tabId: string): Promise<string[]> => {
  await invoke(CH.spawnSession, {
    projectCwd: "/proj",
    mode: "pty",
    advisor: false,
    cols: 80,
    rows: 24,
    resumeTabId: tabId,
  });
  return spawnedSignals.at(-1)!;
};

const isSessionRow = (s: unknown): s is { tabId: string } =>
  typeof s === "object" && s !== null && "tabId" in s && typeof s.tabId === "string";

/** Registered tab ids, in registry order. */
const sessionIds = (): string[] =>
  readRegistry().sessions.filter(isSessionRow).map((s) => s.tabId);

describe("session:delete cascade (issue #309)", () => {
  it("previews the whole descendant closure with titles and liveness", async () => {
    setupCascade();
    await expect(invoke(CH.deleteSessionPreview, "tab-s")).resolves.toEqual({
      descendants: [
        { tabId: "tab-i1", title: "Implementation one", running: false },
        { tabId: "tab-i2", title: "Implementation two", running: false },
      ],
    });
    await expect(invoke(CH.deleteSessionPreview, "tab-u")).resolves.toEqual({
      descendants: [],
    });
    await expect(invoke(CH.deleteSessionPreview, "unknown")).resolves.toEqual({
      descendants: [],
    });
  });

  it("marks a live descendant as running in the preview", async () => {
    setupCascade();
    await launchTab("tab-i1");
    await expect(invoke(CH.deleteSessionPreview, "tab-s")).resolves.toEqual({
      descendants: [

        { tabId: "tab-i1", title: "Implementation one", running: true },
        { tabId: "tab-i2", title: "Implementation two", running: false },
      ],
    });
  });

  it("erases the source, every descendant, and their files, and stops a live descendant", async () => {
    const { sessionsRoot, archiveRoot } = setupCascade();
    const signals = await launchTab("tab-i1");

    await invoke(CH.deleteSession, "tab-s", true);

    expect(signals).toEqual(["default"]);
    expect(sessionIds()).toEqual(["tab-u"]);
    for (const lineage of [LINEAGE_S, LINEAGE_I1, LINEAGE_I2]) {
      expect(fs.existsSync(path.join(sessionsRoot, lineage))).toBe(false);
      expect(fs.existsSync(path.join(archiveRoot, lineage))).toBe(false);
    }
    // The unrelated session's record and files are untouched.
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE_U, FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(archiveRoot, LINEAGE_U))).toBe(true);
  });

  it("leaves the descendants behind without cascade", async () => {
    const { sessionsRoot } = setupCascade();

    await invoke(CH.deleteSession, "tab-s", false);

    expect(sessionIds()).toEqual(["tab-i1", "tab-i2", "tab-u"]);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE_S))).toBe(false);
    for (const lineage of [LINEAGE_I1, LINEAGE_I2, LINEAGE_U]) {
      expect(fs.existsSync(path.join(sessionsRoot, lineage))).toBe(true);
    }
  });

  it("keeps the failed descendant retryable while the rest of the closure is erased", async () => {
    const { sessionsRoot } = setupCascade();
    const realRm = fs.promises.rm.bind(fs.promises);
    const rm = vi.spyOn(fs.promises, "rm").mockImplementation(async (target, options) => {
      if (String(target).includes(LINEAGE_I2)) {
        throw new Error("EBUSY: resource busy");
      }
      return realRm(target, options);
    });

    await expect(invoke(CH.deleteSession, "tab-s", true)).rejects.toThrow(/EBUSY/);
    rm.mockRestore();

    // The failed tab's op rejects Promise.all immediately; the siblings
    // finish their per-session deletes in the background.
    await vi.waitFor(() => {
      expect(sessionIds()).toEqual(["tab-i2", "tab-u"]);
    });
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE_S))).toBe(false);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE_I1))).toBe(false);
    // The failed session's files survive for the retry.
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE_I2, FILE_NAME))).toBe(true);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE_U, FILE_NAME))).toBe(true);
  });
});
