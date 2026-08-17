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
    RpcClient: vi.fn(),
  };
});

const TAB = "tab-1";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const resolveSessionLocationMock = vi.mocked(Core.resolveSessionLocation);
const spawnOmpMock = vi.mocked(Core.spawnOmp);
const spawnShellMock = vi.mocked(Core.spawnShell);
const watchLineageDirMock = vi.mocked(Core.watchLineageDir);
const RpcClientMock = vi.mocked(Core.RpcClient);

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
const rpcInstances: {
  kill: Mock;
  send: Mock;
  exit: (code: number) => void;
  frame: (frame: unknown) => void;
}[] = [];
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

function setup(opts: { mode?: "pty" | "rpc-ui" } = {}): {
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
        mode: opts.mode ?? "pty",
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
  rpcInstances.length = 0;
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
  RpcClientMock.mockReset();
  RpcClientMock.mockImplementation(function (
    this: unknown,
    opts: { onExit: (code: number | null) => void; onFrame: (frame: unknown) => void },
  ) {
    const instance = {
      kill: vi.fn(),
      send: vi.fn(),
      exit: (code: number) => opts.onExit(code),
      frame: (frame: unknown) => opts.onFrame(frame),
    };
    rpcInstances.push(instance);
    return instance;
  } as unknown as typeof Core.RpcClient);
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

describe("lineage watcher broadcast throttle (issue #187)", () => {
  const SESSION_ID = "019ffc67-522c-7000-95a3-01eca0266c03";
  const FILE = `2026-08-13T00-00-00-000Z_${SESSION_ID}.jsonl`;

  // setImmediate stays real so the fs.promises inside hydrateSessionFile can
  // drain; only the throttle window and clock are fake. Poll the observable
  // effect rather than guessing a yield count — parallel workers stretch I/O.
  // Each iteration is one event-loop turn, so the turn budget doubles as an
  // I/O-latency budget: a release cut lands CI and the release lane in the
  // same window on the shared runner, and one backed-up fs round-trip has
  // stretched past 500 turns (issue #203). 5000 covers ~500ms at observed
  // turn rates; the hrtime deadline — untouched by the fake clock — bounds
  // the wait in wall time if turns themselves are starved.
  const flushUntil = async (cond: () => boolean): Promise<void> => {
    const deadline = process.hrtime.bigint() + 3_000_000_000n; // 3s
    for (let i = 0; i < 5000 && !cond(); i++) {
      if (process.hrtime.bigint() > deadline) break;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
  };

  it("throttles mtime-only churn and keeps identity changes immediate", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    try {
      const { manager, registry, broadcast, sessionsRoot } = setup();
      const watcherEvents: Parameters<typeof Core.watchLineageDir>[1][] = [];
      watchLineageDirMock.mockImplementation((_dir, onEvent) => {
        watcherEvents.push(onEvent);
        return vi.fn();
      });
      const filePath = path.join(sessionsRoot, LINEAGE, FILE);
      const write = (title: string, mtimeMs: number): void => {
        fs.writeFileSync(
          filePath,
          `${JSON.stringify({ type: "title", title })}\n` +
            `${JSON.stringify({ type: "session", id: SESSION_ID, cwd: "/proj" })}\n`,
        );
        fs.utimesSync(filePath, new Date(mtimeMs), new Date(mtimeMs));
      };
      write("Alpha", 1_000);
      await manager.hydrateAll();
      broadcast.mockClear();
      const fire = (): void =>
        watcherEvents[0]!({ kind: "session-file", filePath });

      // First adoption (session id + title) is immediate.
      fire();
      await flushUntil(() => broadcast.mock.calls.length === 1);
      expect(broadcast).toHaveBeenCalledTimes(1);

      // Pure mtime bumps arrive at turn rate but coalesce into one trailing call.
      write("Alpha", 2_000);
      fire();
      await flushUntil(
        () =>
          registry.sessions[0]!.cachedModified === new Date(2_000).toISOString(),
      );
      expect(broadcast).toHaveBeenCalledTimes(1);
      write("Alpha", 3_000);
      fire();
      await flushUntil(
        () =>
          registry.sessions[0]!.cachedModified === new Date(3_000).toISOString(),
      );
      expect(broadcast).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1_000);
      expect(broadcast).toHaveBeenCalledTimes(2);
      // The registry converged even while broadcasts were throttled.
      expect(registry.sessions[0]!.cachedModified).toBe(
        new Date(3_000).toISOString(),
      );

      // A title rewrite is identity, not churn — it jumps the throttle.
      write("Beta", 4_000);
      fire();
      await flushUntil(() => broadcast.mock.calls.length === 3);
      expect(broadcast).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(2_000);
      expect(broadcast).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe("plan-review gate (issue #215)", () => {
  const proposalFrame = (id: string) => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: `${Core.PLAN_REVIEW_SENTINEL}${JSON.stringify({
      title: "add auth",
      planFilePath: "local://auth-plan.html",
      planAbsPath: "/l/auth-plan.html",
    })}`,
  });

  const resumeRpc = (manager: SessionManager): Promise<{ tabId: string }> =>
    manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      resumeTabId: TAB,
    });

  it("records a proposal as its frame passes through, and broadcasts it", async () => {
    const { manager, broadcast } = setup({ mode: "rpc-ui" });
    await resumeRpc(manager);
    broadcast.mockClear();

    rpcInstances[0]!.frame(proposalFrame("p1"));

    expect(manager.planGate(TAB)).toEqual({
      pending: {
        title: "add auth",
        planFilePath: "local://auth-plan.html",
        planAbsPath: "/l/auth-plan.html",
        frameId: "p1",
        proposedAt: expect.any(String),
      },
      settle: null,
    });
    expect(broadcast).toHaveBeenCalledTimes(1);
  });

  it("leaves the gate untouched for ordinary extension dialogs", async () => {
    const { manager } = setup({ mode: "rpc-ui" });
    await resumeRpc(manager);

    rpcInstances[0]!.frame({
      type: "extension_ui_request",
      id: "q1",
      method: "select",
      title: "Pick an option",
    });

    expect(manager.planGate(TAB)).toBeUndefined();
  });

  it("settles the gate when its own answer comes back, still forwarding the verdict", async () => {
    const { manager } = setup({ mode: "rpc-ui" });
    await resumeRpc(manager);
    rpcInstances[0]!.frame(proposalFrame("p1"));

    manager.rpcSend(TAB, {
      type: "extension_ui_response",
      id: "p1",
      value: Core.PLAN_EXECUTE,
    });

    expect(manager.planGate(TAB)).toEqual({
      pending: null,
      settle: { frameId: "p1", verdict: "executed" },
    });
    expect(rpcInstances[0]!.send).toHaveBeenCalledWith({
      type: "extension_ui_response",
      id: "p1",
      value: Core.PLAN_EXECUTE,
    });
  });

  it("ignores an answer whose id matches no pending gate", async () => {
    const { manager } = setup({ mode: "rpc-ui" });
    await resumeRpc(manager);
    rpcInstances[0]!.frame(proposalFrame("p1"));
    const before = manager.planGate(TAB);

    manager.rpcSend(TAB, {
      type: "extension_ui_response",
      id: "other",
      value: Core.PLAN_EXECUTE,
    });

    expect(manager.planGate(TAB)).toEqual(before);
  });

  it("drops the gate when the process exits", async () => {
    const { manager } = setup({ mode: "rpc-ui" });
    await resumeRpc(manager);
    rpcInstances[0]!.frame(proposalFrame("p1"));

    rpcInstances[0]!.exit(0);

    expect(manager.planGate(TAB)).toBeUndefined();
  });
});
