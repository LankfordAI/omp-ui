import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as Core from "@omp-ui/core";
import type { KeyCipher, PtyHandle } from "@omp-ui/core";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CH } from "@omp-ui/core";
import { SessionManager } from "./session-manager";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

vi.mock("@omp-ui/core", async (importOriginal) => {
  const core = await importOriginal<typeof Core>();
  return {
    ...core,
    resolveSessionLocation: vi.fn(core.resolveSessionLocation),
    spawnOmp: vi.fn(),
    spawnShell: vi.fn(),
    watchLineageDir: vi.fn(),
  };
});

const TAB = "tab-1";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const resolveSessionLocationMock = vi.mocked(Core.resolveSessionLocation);
const spawnOmpMock = vi.mocked(Core.spawnOmp);
const spawnShellMock = vi.mocked(Core.spawnShell);
const watchLineageDirMock = vi.mocked(Core.watchLineageDir);

interface FakePty {
  dataCb: ((data: Buffer) => void) | null;
  exitCb: ((event: { exitCode: number }) => void) | null;
  detachData: Mock;
  write: Mock;
  resize: Mock;
  kill: Mock;
  signals: string[];
  exit: (code?: number) => void;
}

const fakePtys: FakePty[] = [];
const fakeShells: FakePty[] = [];
const watcherDisposes: Mock[] = [];
let nextPtyDiesOn: "default" | "SIGKILL" | "never" = "never";
let base = "";

function fakeHandle(diesOn: "default" | "SIGKILL" | "never"): FakePty {
  const fake: FakePty = {
    dataCb: null,
    exitCb: null,
    detachData: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
    signals: [],
    exit: (code = 0) => fake.exitCb?.({ exitCode: code }),
  };
  fake.kill.mockImplementation((signal?: string) => {
    fake.signals.push(signal ?? "default");
    const obeys =
      diesOn === "default" ? signal === undefined : diesOn === "SIGKILL" && signal === "SIGKILL";
    if (obeys) fake.exit();
  });
  return fake;
}

function asPtyHandle(id: string, fake: FakePty): PtyHandle {
  return {
    id,
    onData: (cb) => {
      fake.dataCb = cb;
      return () => {
        fake.detachData();
        fake.dataCb = null;
      };
    },
    onExit: (cb) => {
      fake.exitCb = cb;
    },
    write: fake.write,
    resize: fake.resize,
    kill: fake.kill,
  };
}

function setup(): {
  manager: SessionManager;
  registry: Core.Registry;
  broadcast: Mock;
  sent: { channel: string; args: unknown[] }[];
  sessionsRoot: string;
} {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-manager-"));
  const sessionsRoot = path.join(base, "sessions");
  const archiveRoot = path.join(base, "archive", "sessions");
  fs.mkdirSync(path.join(sessionsRoot, LINEAGE), { recursive: true });
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
        tabId: TAB,
        sessionId: null,
        lineageDir: LINEAGE,
        projectCwd: "/proj",
        mode: "pty",
      }),
    ],
  });
  const registry = Core.Registry.load(registryFile);
  const cipher: KeyCipher = {
    available: true,
    backend: "test",
    encrypt: (plain) => Buffer.from(plain),
    decrypt: (blob) => blob.toString("utf8"),
  };
  const providerKeys = new Core.ProviderKeys(
    path.join(base, "provider-keys.json"),
    cipher,
    { OPENROUTER_API_KEY: "test-key" },
  );
  const sent: { channel: string; args: unknown[] }[] = [];
  const broadcast = vi.fn(async () => {});
  const manager = new SessionManager({
    registry,
    providerKeys,
    getOmpPath: () => "/test/omp",
    getSessionsRoot: () => sessionsRoot,
    getArchiveRoot: () => archiveRoot,
    send: (channel, ...args) => sent.push({ channel, args }),
    broadcast,
  });
  return { manager, registry, broadcast, sent, sessionsRoot };
}

const resume = (manager: SessionManager): Promise<{ tabId: string }> =>
  manager.spawn({
    projectCwd: "/proj",
    mode: "pty",
    advisor: false,
    cols: 80,
    rows: 24,
    resumeTabId: TAB,
  });

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  fakePtys.length = 0;
  fakeShells.length = 0;
  watcherDisposes.length = 0;
  nextPtyDiesOn = "never";
  resolveSessionLocationMock.mockClear();
  spawnOmpMock.mockReset();
  spawnOmpMock.mockImplementation((opts) => {
    const fake = fakeHandle(nextPtyDiesOn);
    fakePtys.push(fake);
    return asPtyHandle(opts.id, fake);
  });
  spawnShellMock.mockReset();
  spawnShellMock.mockImplementation((opts) => {
    const fake = fakeHandle("never");
    fakeShells.push(fake);
    return asPtyHandle(opts.id, fake);
  });
  watchLineageDirMock.mockReset();
  watchLineageDirMock.mockImplementation(() => {
    const dispose = vi.fn();
    watcherDisposes.push(dispose);
    return dispose;
  });
});

describe("SessionManager live ownership", () => {
  it("reports live ownership from process registration through observed exit", async () => {
    const { manager } = setup();

    await resume(manager);

    expect(manager.liveCount).toBe(1);
    expect(manager.isLive(TAB)).toBe(true);
    expect(manager.hasLiveInProject("/proj")).toBe(true);
    expect(manager.hasLiveInProject("/other")).toBe(false);

    fakePtys[0]!.exit(7);
    expect(manager.liveCount).toBe(0);
    expect(manager.isLive(TAB)).toBe(false);
    expect(manager.hasLiveInProject("/proj")).toBe(false);
  });

  it("deduplicates a resume while its first async preparation is in flight", async () => {
    const { manager } = setup();
    let release = (): void => {};
    let started = (): void => {};
    const preparationStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    resolveSessionLocationMock.mockImplementationOnce(async () => {
      started();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      return { where: "missing" };
    });

    const first = resume(manager);
    await preparationStarted;
    await expect(resume(manager)).resolves.toEqual({ tabId: TAB });
    expect(spawnOmpMock).not.toHaveBeenCalled();

    release();
    await first;
    expect(spawnOmpMock).toHaveBeenCalledTimes(1);
    expect(manager.liveCount).toBe(1);
  });

  it("reaps the predecessor before starting a successor", async () => {
    const { manager } = setup();
    await resume(manager);
    const predecessor = fakePtys[0]!;

    const restarted = manager.restart(TAB);

    expect(predecessor.detachData).toHaveBeenCalledTimes(1);
    expect(predecessor.signals).toEqual(["default"]);
    expect(spawnOmpMock).toHaveBeenCalledTimes(1);

    predecessor.exit();
    await restarted;

    expect(spawnOmpMock).toHaveBeenCalledTimes(2);
    expect(manager.isLive(TAB)).toBe(true);
  });

  it("does not start a successor when the hard-stop timeout expires", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup();
      await resume(manager);
      const predecessor = fakePtys[0]!;

      const restarted = manager.restart(TAB);
      const rejected = expect(restarted).rejects.toThrow(/did not exit/);
      await vi.advanceTimersByTimeAsync(5_000);
      await rejected;

      expect(predecessor.signals).toEqual(["default", "SIGKILL"]);
      expect(spawnOmpMock).toHaveBeenCalledTimes(1);
      expect(manager.isLive(TAB)).toBe(true);

      predecessor.exit(23);
      expect(sent).toContainEqual({ channel: CH.onPtyExit, args: [TAB, 23] });
      expect(sent).not.toContainEqual({ channel: CH.onPtyExit, args: [TAB, -1] });
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a live child to exit before deleting its registry record and files", async () => {
    const { manager, registry, sessionsRoot } = setup();
    await resume(manager);

    const deleting = manager.deleteSession(TAB);
    await Promise.resolve();
    expect(registry.sessions.some((record) => record.tabId === TAB)).toBe(true);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(true);

    fakePtys[0]!.exit();
    await deleting;

    expect(registry.sessions.some((record) => record.tabId === TAB)).toBe(false);
    expect(fs.existsSync(path.join(sessionsRoot, LINEAGE))).toBe(false);
  });

  it("killAll detaches and kills sessions and shells and disposes lineage watchers", async () => {
    const { manager } = setup();
    await manager.hydrateAll();
    await resume(manager);
    manager.launchShell(TAB, "/proj", 80, 24);
    const session = fakePtys[0]!;
    const shell = fakeShells[0]!;

    manager.killAll();

    expect(session.detachData).toHaveBeenCalledTimes(1);
    expect(session.kill).toHaveBeenCalledTimes(1);
    expect(watcherDisposes).toHaveLength(2);
    expect(shell.detachData).toHaveBeenCalledTimes(1);
    expect(shell.kill).toHaveBeenCalledTimes(1);
    expect(watcherDisposes.every((dispose) => dispose.mock.calls.length === 1)).toBe(true);
    expect(manager.liveCount).toBe(0);
  });
});
