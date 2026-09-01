import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CH,
  PLAN_EXECUTE,
  PLAN_REVIEW_SENTINEL,
  ProviderKeys,
  Registry,
  RpcClient,
  type BackendState,
  type KeyCipher,
  type SpawnRequest,
} from "@omp-ui/core";
import { MainBackend } from "./backend";
import { DesktopNotifier } from "./desktop-notifier";
import { SessionManager } from "./session-manager";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

const handlers = vi.hoisted(
  () => new Map<string, (e: unknown, ...args: unknown[]) => unknown>(),
);
const resolveSessionLocationMock = vi.hoisted(() => vi.fn());
const RpcClientMock = vi.mocked(RpcClient);

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

vi.mock("@omp-ui/core", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    resolveSessionLocation: resolveSessionLocationMock,
    RpcClient: vi.fn(),
    watchLineageDir: vi.fn(() => () => {}),
  };
});

const sent: { channel: string; args: unknown[] }[] = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base = "";

interface FakeRpc {
  kill: Mock;
  send: Mock;
  exit: (code: number) => void;
  frame: (frame: unknown) => void;
}

const rpcInstances: FakeRpc[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> =>
  Promise.resolve(handlers.get(ch)!(null, ...args));

function broadcastStates(): {
  projects: { project: { path: string } }[];
  themeId: string;
  localeId: string;
}[] {
  return sent
    .filter((event) => event.channel === CH.onStateChanged)
    .map((event) => event.args[0] as {
      projects: { project: { path: string } }[];
      themeId: string;
      localeId: string;
    });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-broadcast-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      {
        path: "/p/a",
        name: "A",
        addedAt: "2026-08-01T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
      {
        path: "/p/b",
        name: "B",
        addedAt: "2026-08-02T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
    ],
    sessions: [ownedSessionRecord({ projectCwd: "/p/a" })],
  });

  handlers.clear();
  sent.length = 0;
  rpcInstances.length = 0;
  resolveSessionLocationMock.mockReset().mockResolvedValue({ where: "missing" });
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
  new MainBackend(win as never, registryFile).registerIpc();
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("IPC spawn argument boundary (issue #358)", () => {
  const request: SpawnRequest = {
    origin: "new",
    mode: "rpc-ui",
    projectCwd: "/p/a",
    advisor: false,
    cols: 120,
    rows: 40,
    worktree: null,
  };

  it("rejects malformed input before SessionManager.spawn", async () => {
    const spawn = vi.fn().mockResolvedValue({ tabId: "tab-new" });
    new MainBackend(win as never, path.join(base, "registry.json"), {
      sessions: { spawn } as unknown as SessionManager,
    }).registerIpc();

    await expect(
      invoke(CH.spawnSession, { ...request, unexpected: "do-not-echo" }),
    ).rejects.toThrow(`invalid arguments for ${CH.spawnSession}: argument 0`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes a parsed request to SessionManager.spawn", async () => {
    const spawn = vi.fn().mockResolvedValue({ tabId: "tab-new" });
    new MainBackend(win as never, path.join(base, "registry.json"), {
      sessions: { spawn } as unknown as SessionManager,
    }).registerIpc();

    await expect(invoke(CH.spawnSession, request)).resolves.toEqual({ tabId: "tab-new" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(request);
    expect(spawn.mock.calls[0]![0]).not.toBe(request);
  });
});
describe("settings:setLocaleId (issue #363)", () => {
  it("replies, writes the registry, and broadcasts once", async () => {
    await expect(invoke(CH.setLocaleId, "ko")).resolves.toBeUndefined();
    expect(
      Registry.load(path.join(base, "registry.json")).getSetting("localeId"),
    ).toBe("ko");
    expect(broadcastStates()).toHaveLength(1);
    expect(broadcastStates()[0]?.localeId).toBe("ko");
  });
});

describe("ordered backend broadcasts (issue #146)", () => {
  it("finishes an older state build and delivery before starting the next one", async () => {
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<{ where: "missing" }>();
    resolveSessionLocationMock.mockImplementationOnce(() => {
      firstReadStarted.resolve(undefined);
      return releaseFirstRead.promise;
    });

    const first = invoke(CH.toggleFavorite, "model-a");
    await firstReadStarted.promise;

    const second = invoke(CH.moveProject, "/p/a", null);
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(1);
    expect(broadcastStates()).toEqual([]);

    releaseFirstRead.resolve({ where: "missing" });
    await Promise.all([first, second]);

    const orders = broadcastStates().map((state) =>
      state.projects.map((group) => group.project.path),
    );
    expect(orders).toEqual([
      ["/p/a", "/p/b"],
      ["/p/b", "/p/a"],
    ]);
    expect(orders.at(-1)).toEqual(["/p/b", "/p/a"]);
  });

  it("keeps the chain usable after returning a failed build to its caller", async () => {
    resolveSessionLocationMock.mockRejectedValueOnce(new Error("state read failed"));

    const failed = invoke(CH.toggleFavorite, "model-a");
    await expect(failed).rejects.toThrow("state read failed");

    await expect(invoke(CH.setThemeId, "nord")).resolves.toBeUndefined();
    expect(broadcastStates()).toHaveLength(1);
    expect(broadcastStates()[0]?.themeId).toBe("nord");
  });
});

describe("window sink resilience (issue #183)", () => {
  const freshBackend = (): MainBackend =>
    new MainBackend(win as never, path.join(base, "registry.json"));

  it("skips the window sink while the renderer is crashed", async () => {
    const original = win.webContents.isCrashed;
    win.webContents.isCrashed = () => true;
    try {
      freshBackend().registerIpc();
      await invoke(CH.setThemeId, "nord");
      expect(sent).toEqual([]);
    } finally {
      win.webContents.isCrashed = original;
    }
  });

  it("tolerates a disposed-frame throw and rate-limits the warn", async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const original = win.webContents.send;
    win.webContents.send = () => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    };
    try {
      freshBackend().registerIpc();
      await invoke(CH.setThemeId, "nord");
      await invoke(CH.setThemeId, "nord");
      expect(warn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(61_000);
      await invoke(CH.setThemeId, "nord");
      expect(warn).toHaveBeenCalledTimes(2);
    } finally {
      win.webContents.send = original;
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("remote sinks still receive events when the window sink fails", async () => {
    const original = win.webContents.send;
    win.webContents.send = () => {
      throw new Error("Render frame was disposed before WebFrameMain could be accessed");
    };
    const remote: { channel: string; args: unknown[] }[] = [];
    try {
      const backend = freshBackend();
      backend.registerIpc();
      backend.addSink((channel, args) => remote.push({ channel, args }));
      await invoke(CH.setThemeId, "nord");
      expect(remote.map((e) => e.channel)).toContain(CH.onStateChanged);
    } finally {
      win.webContents.send = original;
    }
  });
});

describe("plan-review gate on the wire (issue #215)", () => {
  const LINEAGE_A = "omp-ui--a--11111111-2222-3333-4444-555555555555";
  const LINEAGE_B = "omp-ui--b--aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const TAB_A = "tab-a";
  const TAB_B = "tab-b";

  const proposalFrame = (id: string) => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: `${PLAN_REVIEW_SENTINEL}${JSON.stringify({
      title: "add auth",
      planFilePath: "local://auth-plan.html",
      planAbsPath: "/l/auth-plan.html",
    })}`,
  });

  // broadcast() is private in production; the injected manager must fan out
  // on the backend's own chain, so the test reaches it through one named view.
  const backendBroadcast = (
    target: MainBackend,
  ): (() => Promise<void>) =>
    (target as unknown as { broadcast(): Promise<void> }).broadcast.bind(target);

  /**
   * A MainBackend whose SessionManager is injected so the test drives the
   * fake RpcClient directly. Spawns the /p/a session before returning, and
   * the manager's gate mutations broadcast through the backend's own chain,
   * exactly like the default manager's.
   */
  const gateBackend = async (): Promise<{ manager: SessionManager; rpc: FakeRpc }> => {
    const registryFile = path.join(base, "registry.json");
    seedRegistry(registryFile, {
      projects: [
        { path: "/p/a", name: "A", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
        { path: "/p/b", name: "B", addedAt: "2026-08-02T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      ],
      sessions: [
        ownedSessionRecord({ tabId: TAB_A, lineageDir: LINEAGE_A, projectCwd: "/p/a", mode: "rpc-ui" }),
        ownedSessionRecord({ tabId: TAB_B, lineageDir: LINEAGE_B, projectCwd: "/p/b", mode: "rpc-ui" }),
      ],
    });
    const sessionsRoot = path.join(base, "agent", "sessions");
    fs.mkdirSync(path.join(sessionsRoot, LINEAGE_A), { recursive: true });
    fs.mkdirSync(path.join(sessionsRoot, LINEAGE_B), { recursive: true });

    const cipher: KeyCipher = {
      available: true,
      backend: "test",
      encrypt: (plain) => Buffer.from(plain),
      decrypt: (blob) => blob.toString("utf8"),
    };
    const backendRef: { current: MainBackend | null } = { current: null };
    const manager = new SessionManager({
      registry: Registry.load(registryFile),
      providerKeys: new ProviderKeys(
        path.join(base, "provider-keys.json"),
        cipher,
        { OPENROUTER_API_KEY: "test-key" },
      ),
      getOmpPath: () => path.join(base, "omp"),
      getSessionsRoot: () => sessionsRoot,
      getArchiveRoot: () => path.join(base, "archive"),
      getWorktreesRoot: () => path.join(base, "worktrees"),
      send: () => {},
      broadcast: () =>
        backendRef.current === null
          ? Promise.resolve()
          : backendBroadcast(backendRef.current)(),
    });
    const backend = new MainBackend(win as never, registryFile, { sessions: manager });
    backend.registerIpc();
    backendRef.current = backend;
    await invoke(CH.spawnSession, {
      origin: "resume",
      resumeTabId: TAB_A,
      cols: 80,
      rows: 24,
    });
    return { manager, rpc: rpcInstances[0]! };
  };

  const lastBroadcast = (): BackendState => {
    const event = sent.filter((e) => e.channel === CH.onStateChanged).at(-1);
    expect(event).toBeDefined();
    return event!.args[0] as BackendState;
  };

  const sessionsOf = (state: BackendState, projectPath: string) =>
    state.projects.find((group) => group.project.path === projectPath)!.sessions;

  it("carries the pending plan on the summary and to the window sink", async () => {
    const { manager, rpc } = await gateBackend();
    expect(manager.planGate(TAB_A)).toBeUndefined();

    rpc.frame(proposalFrame("p1"));
    // The gate's broadcast queued first; this state change lands behind it, so
    // awaiting it proves the gate's state already reached the sink.
    await invoke(CH.toggleFavorite, "model-a");

    const broadcasted = lastBroadcast();
    expect(sessionsOf(broadcasted, "/p/a")[0]!.pendingPlan).toEqual({
      title: "add auth",
      planFilePath: "local://auth-plan.html",
      planAbsPath: "/l/auth-plan.html",
      frameId: "p1",
      proposedAt: expect.any(String),
    });
    expect(sessionsOf(broadcasted, "/p/b")[0]!.pendingPlan).toBeNull();
    expect(sessionsOf(broadcasted, "/p/b")[0]!.planSettle).toBeNull();

    // A direct state read — what a late-joining renderer fetches — agrees.
    const state = (await invoke(CH.getState)) as BackendState;
    expect(sessionsOf(state, "/p/a")[0]!.pendingPlan?.frameId).toBe("p1");
    expect(sessionsOf(state, "/p/b")[0]!.pendingPlan).toBeNull();
  });

  it("settles on the verdict, and clears both fields once the process exits", async () => {
    const { manager, rpc } = await gateBackend();
    rpc.frame(proposalFrame("p1"));

    manager.rpcSend(TAB_A, {
      type: "extension_ui_response",
      id: "p1",
      value: PLAN_EXECUTE,
    });
    await invoke(CH.toggleFavorite, "model-b");
    let state = lastBroadcast();
    expect(sessionsOf(state, "/p/a")[0]!.pendingPlan).toBeNull();
    expect(sessionsOf(state, "/p/a")[0]!.planSettle).toEqual({
      frameId: "p1",
      verdict: "executed",
    });

    rpc.exit(0);
    await invoke(CH.toggleFavorite, "model-c");
    state = lastBroadcast();
    expect(sessionsOf(state, "/p/a")[0]!.pendingPlan).toBeNull();
    expect(sessionsOf(state, "/p/a")[0]!.planSettle).toBeNull();
  });
});

describe("orphan worktree sweep on startup (issue #262)", () => {
  it("removes an unreferenced checkout dir under the worktrees root", async () => {
    // The default worktrees root sits beside the registry file.
    const orphan = path.join(base, "worktrees", "proj--deadbeef", "omp-ui-cafe");
    fs.mkdirSync(orphan, { recursive: true });

    new MainBackend(win as never, path.join(base, "registry.json")).registerIpc();

    // The constructor fires the sweep without awaiting it.
    await vi.waitFor(() => {
      expect(fs.existsSync(orphan)).toBe(false);
    });
  });
});

describe("dispatch and state builds (issue #301)", () => {
  it("summarizes every session concurrently", async () => {
    seedRegistry(path.join(base, "registry.json"), {
      projects: [
        {
          path: "/p/a",
          name: "A",
          addedAt: "2026-08-01T00:00:00.000Z",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
        },
      ],
      sessions: [
        ownedSessionRecord({ projectCwd: "/p/a" }),
        ownedSessionRecord({
          tabId: "tab-2",
          projectCwd: "/p/a",
          lineageDir: "omp-ui--proj--99999999-8888-7777-6666-555555555555",
        }),
      ],
    });
    const gate = deferred<void>();
    let locationReads = 0;
    resolveSessionLocationMock.mockImplementation(() => {
      locationReads += 1;
      return gate.promise.then(() => ({ where: "missing" as const }));
    });

    const backend = new MainBackend(win as never, path.join(base, "registry.json"));
    backend.registerIpc();
    const pending = invoke(CH.getState);

    // Both summarizes must have started before either resolved: a serial build
    // stalls at one outstanding location read.
    expect(locationReads).toBe(2);
    gate.resolve(undefined);
    const state = (await pending) as BackendState;
    expect(state.projects.map((group) => group.sessions.length)).toEqual([2]);
  });

  it("marks desktop viewed reports and raises the notifier (issue #271)", async () => {
    const noteDesktop = vi.spyOn(SessionManager.prototype, "noteDesktopClientId");
    const viewedChanged = vi.spyOn(DesktopNotifier.prototype, "viewedChanged");
    try {
      const backend = new MainBackend(win as never, path.join(base, "registry.json"));
      backend.registerIpc();
      invoke(CH.tabViewed, "desktop-client", "tab-1");
      expect(noteDesktop).toHaveBeenCalledWith("desktop-client");
      expect(viewedChanged).toHaveBeenCalledWith("tab-1");

      noteDesktop.mockClear();
      viewedChanged.mockClear();
      invoke(CH.tabViewed, "remote-client", null);
      expect(noteDesktop).toHaveBeenCalledWith("remote-client");
      expect(viewedChanged).not.toHaveBeenCalled();
    } finally {
      noteDesktop.mockRestore();
      viewedChanged.mockRestore();
    }
  });
});
