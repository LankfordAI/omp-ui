import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { LineageEvent, PtyHandle } from "@omp-ui/core";
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
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

// No real omp child, no real fs.watch — every other core export stays real.
vi.mock("@omp-ui/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omp-ui/core")>()),
  spawnOmp: vi.fn(),
  watchLineageDir: vi.fn(),
  RpcClient: vi.fn(),
}));

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { spawnOmp, watchLineageDir, RpcClient } = await import("@omp-ui/core");
const spawnOmpMock = vi.mocked(spawnOmp);
const watchLineageDirMock = vi.mocked(watchLineageDir);
const RpcClientMock = vi.mocked(RpcClient);

const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const TAB = "tab-1";
const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;

interface FakePty {
  id: string;
  dataCb: ((data: Buffer) => void) | null;
  exitCb: ((e: { exitCode: number; signal?: number }) => void) | null;
  exit: (exitCode: number) => void;
  detachData: Mock;
  kill: Mock;
}

const fakePtys: FakePty[] = [];
const watcherEvents: ((e: LineageEvent) => void)[] = [];
const watcherDisposes: Mock[] = [];
const rpcInstances: { kill: Mock; send: Mock; exit: (code: number) => void; frame: (frame: unknown) => void }[] = [];

/**
 * A registry holding one dormant session with an existing lineage dir, plus a
 * fake omp binary so resolveOmpBinary succeeds at MainBackend construction.
 */
function setup(): { backend: InstanceType<typeof MainBackend> } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-teardown-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;
  process.env.OPENROUTER_API_KEY = "test-provider-key";

  const ompBin = path.join(base, "omp");
  fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OMP_UI_OMP_PATH = ompBin;

  const sessionsRoot = path.join(agentDir, "sessions");
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
        launchedAt: "2026-07-29T16:18:42.427Z",
        mode: "pty",
        advisor: false,
      }),
    ],
  });

  handlers.clear();
  sent.length = 0;
  const backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
  return { backend };
}

const invoke = (ch: string, ...args: unknown[]): unknown => handlers.get(ch)!(null, ...args);

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  delete process.env.OMP_UI_OMP_PATH;
  fakePtys.length = 0;
  watcherEvents.length = 0;
  watcherDisposes.length = 0;
  rpcInstances.length = 0;

  spawnOmpMock.mockReset();
  spawnOmpMock.mockImplementation((opts) => {
    const fake: FakePty = {
      id: opts.id,
      dataCb: null,
      exitCb: null,
      exit(exitCode) {
        this.exitCb?.({ exitCode });
      },
      detachData: vi.fn(),
      kill: vi.fn(),
    };
    fakePtys.push(fake);
    const handle: PtyHandle = {
      id: fake.id,
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
      write: vi.fn(),
      resize: vi.fn(),
      kill: fake.kill,
    };
    return handle;
  });

  watchLineageDirMock.mockReset();
  watchLineageDirMock.mockImplementation((_dir, onEvent) => {
    watcherEvents.push(onEvent);
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
  } as unknown as typeof RpcClient);
});

describe("lineage watcher teardown (issue #64)", () => {
  it("vanished disposes the watcher, not just the map entry", async () => {
    const { backend } = setup();
    await backend.hydrateAll();
    expect(watchLineageDirMock).toHaveBeenCalledTimes(1);

    watcherEvents[0]!({ kind: "vanished" });

    // The FSWatcher close function must run — a forgotten entry leaks the fd.
    expect(watcherDisposes[0]).toHaveBeenCalledTimes(1);
  });

  it("killAll disposes every lineage watcher", async () => {
    const { backend } = setup();
    await backend.hydrateAll();

    backend.killAll();

    expect(watcherDisposes[0]).toHaveBeenCalledTimes(1);
  });

  it("sessionDelete disposes the session's watcher", async () => {
    const { backend } = setup();
    await backend.hydrateAll();
    expect(watcherDisposes.length).toBeGreaterThan(0);

    await invoke(CH.deleteSession, TAB);

    expect(watcherDisposes[0]).toHaveBeenCalled();
  });
});

describe("live session teardown (issue #64)", () => {
  const spawnPtySession = async (): Promise<string> => {
    const res = (await invoke(CH.spawnSession, {
      projectCwd: "/proj",
      mode: "pty",
      cols: 80,
      rows: 24,
    })) as { tabId: string };
    return res.tabId;
  };

  const relaunchCases: {
    name: string;
    begin: (tabId: string) => Promise<void>;
    rpcSuccessor: boolean;
  }[] = [
    {
      name: "mode switch",
      begin: (tabId) => invoke(CH.switchMode, tabId, "rpc-ui") as Promise<void>,
      rpcSuccessor: true,
    },
    {
      name: "restart",
      begin: (tabId) => invoke(CH.restartSession, tabId) as Promise<void>,
      rpcSuccessor: false,
    },
    {
      name: "advisor relaunch",
      begin: (tabId) => invoke(CH.setSessionAdvisor, tabId, true, null) as Promise<void>,
      rpcSuccessor: false,
    },
  ];

  const processStarts = (): number =>
    spawnOmpMock.mock.calls.length + RpcClientMock.mock.calls.length;

  it("terminate detaches the pty data listener and kills the process", async () => {
    setup();
    const tabId = await spawnPtySession();
    const fake = fakePtys[0]!;

    invoke(CH.terminateSession, tabId);

    expect(fake.detachData).toHaveBeenCalled();
    expect(fake.dataCb).toBeNull();
    expect(fake.kill).toHaveBeenCalled();
  });

  it.each(relaunchCases)(
    "$name reaps the predecessor before starting exactly one successor",
    async ({ begin, rpcSuccessor }) => {
      setup();
      const tabId = await spawnPtySession();
      const predecessor = fakePtys[0]!;

      const done = begin(tabId);

      expect(predecessor.detachData).toHaveBeenCalled();
      expect(predecessor.kill).toHaveBeenCalled();
      expect(processStarts()).toBe(1);

      predecessor.exit(0);
      await done;

      expect(processStarts()).toBe(2);
      if (rpcSuccessor) {
        expect(RpcClientMock).toHaveBeenCalledWith(
          expect.objectContaining({ initialCommands: undefined }),
        );
      }
    },
  );

  it(
    "rejects a relaunch without starting a successor when the predecessor cannot be reaped",
    async () => {
      vi.useFakeTimers();
      try {
        setup();
        const tabId = await spawnPtySession();
        const predecessor = fakePtys[0]!;

        const done = invoke(CH.restartSession, tabId) as Promise<void>;
        const rejected = expect(done).rejects.toThrow(/did not exit/);
        expect(processStarts()).toBe(1);

        await vi.advanceTimersByTimeAsync(5_000);
        await rejected;

        expect(predecessor.kill).toHaveBeenCalledWith("SIGKILL");
        expect(processStarts()).toBe(1);

        predecessor.exit(23);
        expect(sent).toContainEqual({ channel: CH.onPtyExit, args: [tabId, 23] });
        expect(sent).not.toContainEqual({ channel: CH.onPtyExit, args: [tabId, -1] });
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("queues Plan mode during the handshake only for a genuinely new rpc-ui session (issue #140)", async () => {
    setup();
    await invoke(CH.spawnSession, {
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
    });

    expect(RpcClientMock).toHaveBeenCalledWith(
      expect.objectContaining({
        initialCommands: [
          expect.objectContaining({ type: "prompt", message: "/omp-ui-plan on html" }),
        ],
      }),
    );
  });

  it("does not queue Plan when Build is the configured default agent mode (issue #143)", async () => {
    setup();
    await invoke(CH.setDefaultAgentMode, "build");
    await invoke(CH.spawnSession, {
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
    });

    expect(RpcClientMock).toHaveBeenCalledWith(
      expect.objectContaining({ initialCommands: undefined }),
    );
  });

  it("mode switch away from rpc-ui waits for the rpc child to exit before spawning PTY", async () => {
    setup();
    const res = (await invoke(CH.spawnSession, {
      projectCwd: "/proj",
      mode: "rpc-ui",
      cols: 80,
      rows: 24,
    })) as { tabId: string };
    const predecessor = rpcInstances[0]!;

    const done = invoke(CH.switchMode, res.tabId, "pty") as Promise<void>;

    expect(predecessor.kill).toHaveBeenCalled();
    expect(fakePtys).toHaveLength(0);

    predecessor.exit(0);
    await done;

    expect(fakePtys).toHaveLength(1);
  });

  it("sessionDelete kills the rpc child and reaps it before removing files", async () => {
    setup();
    const res = (await invoke(CH.spawnSession, {
      projectCwd: "/proj",
      mode: "rpc-ui",
      cols: 80,
      rows: 24,
    })) as { tabId: string };
    const rpc = rpcInstances[0]!;
    // The child honours the kill: killAndReap must not need the SIGKILL escalation.
    rpc.kill.mockImplementation(() => rpc.exit(0));

    await invoke(CH.deleteSession, res.tabId);

    expect(rpc.kill).toHaveBeenCalled();
    expect(rpc.kill).not.toHaveBeenCalledWith("SIGKILL");
  });

  it("killAll detaches and kills every live session child", async () => {
    const { backend } = setup();
    await spawnPtySession();
    const fake = fakePtys[0]!;
    expect(backend.liveCount).toBe(1);

    backend.killAll();
    expect(backend.liveCount).toBe(0);

    expect(fake.detachData).toHaveBeenCalled();
    expect(fake.kill).toHaveBeenCalled();
  });
});
