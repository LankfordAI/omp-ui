import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
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
    writeMcpStatusExtension: vi.fn(core.writeMcpStatusExtension),
    RpcClient: vi.fn(),
  };
});

const TAB = "tab-1";
const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const resolveSessionLocationMock = vi.mocked(Core.resolveSessionLocation);
const spawnOmpMock = vi.mocked(Core.spawnOmp);
const spawnShellMock = vi.mocked(Core.spawnShell);
const watchLineageDirMock = vi.mocked(Core.watchLineageDir);
const writeMcpStatusExtensionMock = vi.mocked(Core.writeMcpStatusExtension);
const RpcClientMock = vi.mocked(Core.RpcClient);
const execFileP = promisify(execFile);
const spawnCalls: Array<Record<string, unknown>> = [];

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

/** A real git repo under the harness base: one committed file, repo-local identity. */
async function gitProject(baseDir: string): Promise<string> {
  const dir = fs.mkdtempSync(path.join(baseDir, "project-"));
  const git = (args: string[]) => execFileP("git", args, { cwd: dir });
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "test"]);
  fs.writeFileSync(path.join(dir, ".seed"), "seed\n");
  await git(["add", "."]);
  await git(["commit", "-q", "-m", "init"]);
  return dir;
}

/** The project's current HEAD SHA. */
async function headSha(projectCwd: string): Promise<string> {
  const { stdout } = await execFileP("git", ["rev-parse", "HEAD"], { cwd: projectCwd });
  return stdout.trim();
}

function setup(opts: { mode?: "pty" | "rpc-ui"; project?: string } = {}): {
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
        path: opts.project ?? "/proj",
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
        projectCwd: opts.project ?? "/proj",
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
    getWorktreesRoot: () => path.join(base, "worktrees"),
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
  spawnCalls.length = 0;
  nextPtyDiesOn = "never";
  writeMcpStatusExtensionMock.mockClear();
  resolveSessionLocationMock.mockClear();
  spawnOmpMock.mockReset();
  spawnOmpMock.mockImplementation((opts) => {
    const fake = fakeHandle(nextPtyDiesOn);
    fakePtys.push(fake);
    spawnCalls.push({ ...opts });
    return asPtyHandle(opts.id, fake);
  });
  spawnShellMock.mockReset();
  spawnShellMock.mockImplementation((opts) => {
    const fake = fakeHandle("never");
    fakeShells.push(fake);
    spawnCalls.push({ ...opts });
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

describe("MCP runtime status bridge", () => {
  it.each([
    ["ordinary", false],
    ["resumed", true],
  ] as const)("loads and flushes the bridge for an %s rpc-ui spawn", async (_case, resumed) => {
    const { manager } = setup({ mode: "rpc-ui" });
    await manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      startInPlanMode: false,
      ...(resumed ? { resumeTabId: TAB } : {}),
    });

    const options = RpcClientMock.mock.calls.at(-1)?.[0];
    expect(options?.extensions).toContainEqual(expect.stringMatching(/omp-ui-mcp-status\.ts$/));
    // The flush precedes the mode command; the mode command is published on
    // every spawn, Build included (issue #142; regression #256).
    const messages = (options?.initialCommands as Array<{ message?: unknown }> | undefined)
      ?.map((command) => command.message);
    expect(messages).toEqual([
      Core.mcpRuntimeStatusMessage(),
      Core.planMessage(false, "html"),
    ]);
  });

  it("flushes MCP status before entering initial Plan mode", async () => {
    const { manager } = setup({ mode: "rpc-ui" });
    await manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      startInPlanMode: true,
    });

    const commands = RpcClientMock.mock.calls.at(-1)?.[0].initialCommands as
      | Array<{ message?: unknown }>
      | undefined;
    expect(commands?.map((command) => command.message)).toEqual([
      Core.mcpRuntimeStatusMessage(),
      Core.planMessage(true, "html"),
    ]);
  });

  it("omits only the flush command when writing the bridge fails", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    writeMcpStatusExtensionMock.mockImplementationOnce(() => {
      throw new Error("read-only lineage");
    });
    const { manager } = setup({ mode: "rpc-ui" });
    await manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      startInPlanMode: true,
    });

    const options = RpcClientMock.mock.calls.at(-1)?.[0];
    expect(options?.extensions).not.toContainEqual(expect.stringMatching(/omp-ui-mcp-status\.ts$/));
    const messages = (options?.initialCommands as Array<{ message?: unknown }> | undefined)
      ?.map((command) => command.message);
    expect(messages).toEqual([
      Core.planMessage(true, "html"),
    ]);
    expect(RpcClientMock).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(
      "[mcp] could not write the MCP-status extension:",
      expect.any(Error),
    );
    warning.mockRestore();
  });
});

describe("project default model pins (issue #257)", () => {
  const freshSpawn = (manager: SessionManager): Promise<{ tabId: string }> =>
    manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
    });

  it("spawns a fresh session on the pinned model, ahead of last-used memory", async () => {
    const { manager, registry, sessionsRoot } = setup({ mode: "rpc-ui" });
    registry.setSessionModel(TAB, "last/model", null);
    registry.setProjectDefaultModel("/proj", "pin/model");

    const { tabId } = await freshSpawn(manager);
    const record = registry.sessions.find((s) => s.tabId === tabId);
    expect(record).toBeDefined();
    expect(record).toMatchObject({ model: "pin/model" });

    const options = RpcClientMock.mock.calls.at(-1)?.[0] as
      | { configOverlays?: string[] }
      | undefined;
    const overlay = options?.configOverlays?.find(
      (file) => path.basename(file) === "omp-ui-model.yml",
    );
    expect(overlay).toBeDefined();
    expect(overlay).toBe(
      Core.modelOverlayPath(path.join(sessionsRoot, record!.lineageDir)),
    );
    expect(fs.readFileSync(overlay!, "utf8")).toBe('modelRoles:\n  default: "pin/model"\n');
  });

  it("keeps the last-used model when no pin is set", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });
    registry.setSessionModel(TAB, "last/model", null);

    const { tabId } = await freshSpawn(manager);
    expect(registry.sessions.find((s) => s.tabId === tabId)).toMatchObject({
      model: "last/model",
    });
  });

  it("combines the pinned model with the last-used thinking level", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });
    registry.setSessionModel(TAB, "last/model", "high");
    registry.setProjectDefaultModel("/proj", "pin/model");

    await freshSpawn(manager);
    const options = RpcClientMock.mock.calls.at(-1)?.[0] as
      | { configOverlays?: string[] }
      | undefined;
    const overlay = options?.configOverlays?.find(
      (file) => path.basename(file) === "omp-ui-model.yml",
    );
    expect(fs.readFileSync(overlay!, "utf8")).toBe('modelRoles:\n  default: "pin/model:high"\n');
  });

  it("never consults the pin for a resumed session", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });
    registry.setProjectDefaultModel("/proj", "pin/model");

    const { tabId } = await resume(manager);
    expect(tabId).toBe(TAB);
    // The resumed record keeps its own model (null here) — the pin is a
    // fresh-spawn concern only.
    expect(registry.sessions.find((s) => s.tabId === TAB)).toMatchObject({
      model: null,
    });
  });
});

describe("plan implementation handoff persistence (issue #238)", () => {
  const handoff = {
    sourceTabId: TAB,
    planTitle: "Ship the handoff",
    planFilePath: "local://plans/ship-the-handoff.md",
  };

  it("creates a fresh rpc-ui record with the exact source snapshot before broadcasting", async () => {
    const { manager, registry, broadcast } = setup({ mode: "rpc-ui" });
    const broadcastSources: Array<Core.PlanImplementationSource | null | undefined> = [];
    broadcast.mockImplementation(async () => {
      const child = registry.sessions.find((session) => session.tabId !== TAB);
      if (child) broadcastSources.push(child.planImplementationSource);
    });

    const { tabId } = await manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      planImplementationSource: handoff,
    });

    const child = registry.sessions.find((session) => session.tabId === tabId)!;
    expect(child.lineageDir).not.toBe(LINEAGE);
    expect(child.planImplementationSource).toEqual(handoff);
    expect(broadcastSources).toEqual([handoff]);
  });

  it.each([
    ["empty source tab id", { ...handoff, sourceTabId: "" }, "sourceTabId"],
    ["non-string source tab id", { ...handoff, sourceTabId: 42 }, "sourceTabId"],
    ["empty plan title", { ...handoff, planTitle: "" }, "planTitle"],
    ["non-string plan title", { ...handoff, planTitle: 42 }, "planTitle"],
    ["empty plan file path", { ...handoff, planFilePath: "" }, "planFilePath"],
    ["non-string plan file path", { ...handoff, planFilePath: 42 }, "planFilePath"],
  ] as const)(
    "rejects a handoff with %s before creating a record or lineage directory",
    async (_case, malformedHandoff, field) => {
      const { manager, registry, sessionsRoot } = setup({ mode: "rpc-ui" });
      const addSession = vi.spyOn(registry, "addSession");
      const tabIdsBefore = registry.sessions.map((session) => session.tabId);
      const directoriesBefore = fs.readdirSync(sessionsRoot);

      await expect(
        manager.spawn({
          projectCwd: "/proj",
          mode: "rpc-ui",
          advisor: false,
          cols: 80,
          rows: 24,
          planImplementationSource:
            malformedHandoff as unknown as Core.PlanImplementationSource,
        }),
      ).rejects.toThrow(
        `plan implementation source ${field} must be a non-empty string`,
      );

      expect(addSession).not.toHaveBeenCalled();
      expect(registry.sessions.map((session) => session.tabId)).toEqual(tabIdsBefore);
      expect(fs.readdirSync(sessionsRoot)).toEqual(directoriesBefore);
      expect(RpcClientMock).not.toHaveBeenCalled();
    },
  );

  it("rejects a missing source before creating a record or lineage directory", async () => {
    const { manager, registry, sessionsRoot } = setup({ mode: "rpc-ui" });
    const addSession = vi.spyOn(registry, "addSession");
    const directoriesBefore = fs.readdirSync(sessionsRoot);

    await expect(
      manager.spawn({
        projectCwd: "/proj",
        mode: "rpc-ui",
        advisor: false,
        cols: 80,
        rows: 24,
        planImplementationSource: { ...handoff, sourceTabId: "missing-source" },
      }),
    ).rejects.toThrow("unknown plan source tab missing-source");

    expect(addSession).not.toHaveBeenCalled();
    expect(fs.readdirSync(sessionsRoot)).toEqual(directoriesBefore);
    expect(RpcClientMock).not.toHaveBeenCalled();
  });

  it("rejects a cross-project source before creating a record or lineage directory", async () => {
    const { manager, registry, sessionsRoot } = setup({ mode: "rpc-ui" });
    const addSession = vi.spyOn(registry, "addSession");
    const directoriesBefore = fs.readdirSync(sessionsRoot);

    await expect(
      manager.spawn({
        projectCwd: "/other-project",
        mode: "rpc-ui",
        advisor: false,
        cols: 80,
        rows: 24,
        planImplementationSource: handoff,
      }),
    ).rejects.toThrow("must belong to the same project");

    expect(addSession).not.toHaveBeenCalled();
    expect(fs.readdirSync(sessionsRoot)).toEqual(directoriesBefore);
    expect(RpcClientMock).not.toHaveBeenCalled();
  });

  it("rejects a terminal-mode source before creating a child record", async () => {
    const { manager, registry } = setup({ mode: "pty" });
    const addSession = vi.spyOn(registry, "addSession");

    await expect(
      manager.spawn({
        projectCwd: "/proj",
        mode: "rpc-ui",
        advisor: false,
        cols: 80,
        rows: 24,
        planImplementationSource: handoff,
      }),
    ).rejects.toThrow("plan implementation source must use rpc-ui mode");

    expect(addSession).not.toHaveBeenCalled();
    expect(RpcClientMock).not.toHaveBeenCalled();
  });

  it("keeps an ordinary fresh spawn unlinked", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });

    const { tabId } = await manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
    });

    expect(registry.sessions.find((session) => session.tabId === tabId)!.planImplementationSource)
      .toBeNull();
  });

  it("rejects a handoff for a terminal spawn", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });
    const addSession = vi.spyOn(registry, "addSession");

    await expect(
      manager.spawn({
        projectCwd: "/proj",
        mode: "pty",
        advisor: false,
        cols: 80,
        rows: 24,
        planImplementationSource: handoff,
      }),
    ).rejects.toThrow("requires rpc-ui mode");

    expect(addSession).not.toHaveBeenCalled();
    expect(spawnOmpMock).not.toHaveBeenCalled();
  });

  it("rejects a handoff for a resumed spawn", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });
    const addSession = vi.spyOn(registry, "addSession");

    await expect(
      manager.spawn({
        projectCwd: "/proj",
        mode: "rpc-ui",
        advisor: false,
        cols: 80,
        rows: 24,
        resumeTabId: TAB,
        planImplementationSource: handoff,
      }),
    ).rejects.toThrow("cannot be attached when resuming");

    expect(addSession).not.toHaveBeenCalled();
    expect(RpcClientMock).not.toHaveBeenCalled();
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

describe("worktree sessions (issue #224)", () => {
  const worktreesRoot = (): string => path.join(base, "worktrees");

  it("spawns a worktree session in its own checkout and persists it on the record", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-spawn";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);

    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: { branch, baseRef: null },
    });

    const record = registry.sessions.find((s) => s.tabId === tabId)!;
    // base is the project HEAD at spawn time (issue #259).
    expect(record.worktree).toEqual({ path: worktreePath, branch, base: await headSha(project) });
    expect(fs.existsSync(worktreePath)).toBe(true);
    const call = spawnCalls[spawnCalls.length - 1]!;
    expect(call.id).toBe(tabId);
    expect(call.cwd).toBe(worktreePath);
  });

  it("persists an explicit baseRef verbatim on the record (issue #259)", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    // A named ref distinct from HEAD; the record carries the ref, not its SHA.
    await execFileP("git", ["branch", "cut-point"], { cwd: project });
    const branch = "omp-ui/wt-baseref";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);

    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: { branch, baseRef: "cut-point" },
    });

    const record = registry.sessions.find((s) => s.tabId === tabId)!;
    expect(record.worktree).toEqual({ path: worktreePath, branch, base: "cut-point" });
    expect(fs.existsSync(worktreePath)).toBe(true);
  });

  it("resumes a worktree session in its persisted checkout, not the project root", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-resume";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);
    await Core.addWorktree(project, worktreePath, branch, null);
    const record = registry.addSession(
      ownedSessionRecord({
        tabId: "tab-wt",
        projectCwd: project,
        mode: "pty",
        worktree: { path: worktreePath, branch, base: null },
      }),
    );

    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
      resumeTabId: record.tabId,
    });

    expect(tabId).toBe(record.tabId);
    const call = spawnCalls[spawnCalls.length - 1]!;
    expect(call.id).toBe(record.tabId);
    expect(call.cwd).toBe(worktreePath);
  });

  it("removes the checkout and prunes it from git when a worktree session is deleted", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-delete";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);

    nextPtyDiesOn = "default";
    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: { branch, baseRef: null },
    });
    expect(fs.existsSync(worktreePath)).toBe(true);

    await manager.deleteSession(tabId);

    expect(registry.sessions.some((s) => s.tabId === tabId)).toBe(false);
    expect(fs.existsSync(worktreePath)).toBe(false);
    const { stdout: worktrees } = await execFileP("git", ["worktree", "list"], {
      cwd: project,
    });
    expect(worktrees).not.toContain(worktreePath);
    const { stdout: branches } = await execFileP("git", ["branch", "--list", branch], {
      cwd: project,
    });
    expect(branches).toContain(branch);
  });

  it("keeps the checkout while a fork shares it, and removes it with the last session", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-fork";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);

    nextPtyDiesOn = "default";
    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: { branch, baseRef: null },
    });
    // forkSessionFile reads the source transcript — seed one in the lineage dir.
    const source = registry.sessions.find((s) => s.tabId === tabId)!;
    const transcript = path.join(
      base,
      "sessions",
      source.lineageDir,
      "2026-08-13T00-00-00-000Z_wt-source.jsonl",
    );
    fs.mkdirSync(path.dirname(transcript), { recursive: true });
    fs.writeFileSync(
      transcript,
      `${JSON.stringify({ type: "session", id: "wt-source", cwd: project })}\n`,
    );

    const { tabId: forkTabId } = await manager.forkSession(tabId);

    await manager.deleteSession(tabId);

    expect(registry.sessions.some((s) => s.tabId === tabId)).toBe(false);
    const fork = registry.sessions.find((s) => s.tabId === forkTabId)!;
    expect(fork.worktree).toEqual({ path: worktreePath, branch, base: await headSha(project) });
    expect(fs.existsSync(worktreePath)).toBe(true);

    await manager.deleteSession(forkTabId);

    expect(registry.sessions.some((s) => s.tabId === forkTabId)).toBe(false);
    expect(fs.existsSync(worktreePath)).toBe(false);
    const { stdout: worktrees } = await execFileP("git", ["worktree", "list"], {
      cwd: project,
    });
    expect(worktrees).not.toContain(worktreePath);
    const { stdout: branches } = await execFileP("git", ["branch", "--list", branch], {
      cwd: project,
    });
    expect(branches).toContain(branch);
  });

  it("refuses to resume a worktree session whose checkout was removed from disk", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-gone";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);
    fs.mkdirSync(worktreePath, { recursive: true });
    const record = registry.addSession(
      ownedSessionRecord({
        tabId: "tab-wt",
        projectCwd: project,
        mode: "pty",
        worktree: { path: worktreePath, branch, base: null },
      }),
    );

    fs.rmSync(worktreePath, { recursive: true, force: true });

    await expect(
      manager.spawn({
        projectCwd: project,
        mode: "pty",
        advisor: false,
        cols: 80,
        rows: 24,
        resumeTabId: record.tabId,
      }),
    ).rejects.toThrow("worktree checkout is gone");
    expect(spawnOmpMock).not.toHaveBeenCalled();
  });

  it("spawns an rpc-ui worktree session in its checkout (RpcClient cwd)", async () => {
    const { manager, registry } = setup({ mode: "rpc-ui" });
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-rpc";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);

    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: { branch, baseRef: null },
    });

    const record = registry.sessions.find((s) => s.tabId === tabId)!;
    expect(record.worktree).toEqual({ path: worktreePath, branch, base: await headSha(project) });
    const opts = RpcClientMock.mock.calls.at(-1)![0] as { cwd: string };
    expect(opts.cwd).toBe(worktreePath);
  });

  it("leaves no record or checkout when the worktree branch already exists", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-taken";
    await execFileP("git", ["branch", branch], { cwd: project });
    const before = registry.sessions.length;

    await expect(
      manager.spawn({
        projectCwd: project,
        mode: "pty",
        advisor: false,
        cols: 80,
        rows: 24,
        worktree: { branch, baseRef: null },
      }),
    ).rejects.toThrow(/already exists/);

    expect(registry.sessions.length).toBe(before);
    expect(fs.existsSync(Core.mintWorktreePath(worktreesRoot(), project, branch))).toBe(false);
  });

  it("never cleans up outside the worktrees root, even for a corrupt record", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    // A corrupt registry value: branch ".." mints to the worktrees root
    // itself, which canonical-path equality alone would accept.
    const root = worktreesRoot();
    fs.mkdirSync(root, { recursive: true });
    const sentinel = path.join(root, "sentinel");
    fs.writeFileSync(sentinel, "keep\n");
    registry.addSession(
      ownedSessionRecord({
        tabId: "tab-wt-bad",
        projectCwd: project,
        mode: "pty",
        worktree: { path: root, branch: "..", base: null },
      }),
    );

    await manager.deleteSession("tab-wt-bad");

    expect(fs.existsSync(sentinel)).toBe(true);
    expect(registry.sessions.some((s) => s.tabId === "tab-wt-bad")).toBe(false);
  });
});

describe("convert to worktree (issue #225)", () => {
  const worktreesRoot = (): string => path.join(base, "worktrees");

  it("kills a live session, patches the record, and respawns in the checkout", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-convert";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);

    nextPtyDiesOn = "default";
    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
    });
    const predecessor = fakePtys[0]!;

    await manager.convertToWorktree(tabId, branch, null);

    // The idle process was killed (the fake exited on the default signal)…
    expect(predecessor.signals).toEqual(["default"]);
    // …the record carries the worktree…
    const record = registry.sessions.find((s) => s.tabId === tabId)!;
    expect(record.worktree).toEqual({ path: worktreePath, branch, base: await headSha(project) });
    // …the checkout exists on disk…
    expect(fs.existsSync(worktreePath)).toBe(true);
    // …and the successor runs in it.
    expect(spawnOmpMock).toHaveBeenCalledTimes(2);
    const call = spawnCalls[spawnCalls.length - 1]!;
    expect(call.id).toBe(tabId);
    expect(call.cwd).toBe(worktreePath);
    expect(manager.isLive(tabId)).toBe(true);
  });

  it("leaves the live session untouched when the branch already exists", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-taken";
    await execFileP("git", ["branch", branch], { cwd: project });
    const { tabId } = await manager.spawn({
      projectCwd: project,
      mode: "pty",
      advisor: false,
      cols: 80,
      rows: 24,
    });
    const predecessor = fakePtys[0]!;

    await expect(manager.convertToWorktree(tabId, branch, null)).rejects.toThrow(
      /already exists/,
    );

    // Create-before-kill: no kill, no respawn, no record patch.
    expect(predecessor.kill).not.toHaveBeenCalled();
    expect(spawnOmpMock).toHaveBeenCalledTimes(1);
    expect(manager.isLive(tabId)).toBe(true);
    const record = registry.sessions.find((s) => s.tabId === tabId)!;
    expect(record.worktree ?? null).toBeNull();
    expect(fs.existsSync(Core.mintWorktreePath(worktreesRoot(), project, branch))).toBe(false);
  });

  it("patches a dormant record without killing or spawning", async () => {
    const { manager, registry, broadcast } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    const branch = "omp-ui/wt-dormant";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);
    const record = registry.addSession(
      ownedSessionRecord({ tabId: "tab-dormant", projectCwd: project, mode: "pty" }),
    );

    await manager.convertToWorktree(record.tabId, branch, null);

    const updated = registry.sessions.find((s) => s.tabId === record.tabId)!;
    expect(updated.worktree).toEqual({ path: worktreePath, branch, base: await headSha(project) });
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(spawnOmpMock).not.toHaveBeenCalled();
    expect(manager.isLive(record.tabId)).toBe(false);
    expect(broadcast).toHaveBeenCalled();
  });

  it("persists an explicit baseRef verbatim when converting (issue #259)", async () => {
    const { manager, registry } = setup();
    const project = await gitProject(base);
    registry.addProject(project);
    await execFileP("git", ["branch", "cut-point"], { cwd: project });
    const branch = "omp-ui/wt-convert-baseref";
    const worktreePath = Core.mintWorktreePath(worktreesRoot(), project, branch);
    const record = registry.addSession(
      ownedSessionRecord({ tabId: "tab-convert-base", projectCwd: project, mode: "pty" }),
    );

    await manager.convertToWorktree(record.tabId, branch, "cut-point");

    const updated = registry.sessions.find((s) => s.tabId === record.tabId)!;
    expect(updated.worktree).toEqual({ path: worktreePath, branch, base: "cut-point" });
    expect(fs.existsSync(worktreePath)).toBe(true);
  });
});

describe("stream-stall watchdog (issue #248)", () => {
  /** Fixture default: 180s window; the sweep ticks every 15s. */
  const STALL_WINDOW = 180_000;

  const resumeRpc = (manager: SessionManager): Promise<{ tabId: string }> =>
    manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      resumeTabId: TAB,
    });

  const stallNotices = (sent: { channel: string; args: unknown[] }[]): unknown[] =>
    sent
      .filter((s) => s.channel === CH.onRpcFrame)
      .map((s) => s.args[1])
      .filter(
        (f) =>
          typeof f === "object" &&
          f !== null &&
          (f as Record<string, unknown>).type === "omp_ui_notice",
      );

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

  const blockingDialog = (id: string) => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: "Pick an option",
  });

  const answerDialog = (manager: SessionManager, id: string): void =>
    manager.rpcSend(TAB, { type: "extension_ui_response", id, value: "chosen" });

  it("suppresses the watchdog while an ordinary dialog awaits an answer", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame({ type: "tool_execution_start", toolCallId: "t1" });
      rpc.frame({ type: "tool_execution_end", toolCallId: "t1" });
      rpc.frame(blockingDialog("q1"));
      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      expect(stallNotices(sent)).toHaveLength(0);
      expect(manager.isStreamStalled(TAB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suppresses the watchdog while plan review awaits a verdict", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame({ type: "tool_execution_start", toolCallId: "t1" });
      rpc.frame({ type: "tool_execution_end", toolCallId: "t1" });
      rpc.frame(proposalFrame("p1"));
      await vi.advanceTimersByTimeAsync(6 * 60_000);

      expect(manager.planGate(TAB)?.pending).not.toBeNull();
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      expect(stallNotices(sent)).toHaveLength(0);
      expect(manager.isStreamStalled(TAB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("starts a fresh silence interval after the final human answer", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame(blockingDialog("q1"));
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      answerDialog(manager, "q1");

      await vi.advanceTimersByTimeAsync(STALL_WINDOW - 15_000);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(rpc.send.mock.calls.filter(([cmd]) => cmd.type === "abort")).toHaveLength(1);
      expect(stallNotices(sent)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebases silence only after every outstanding dialog is answered", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame(blockingDialog("q1"));
      rpc.frame(blockingDialog("q2"));
      await vi.advanceTimersByTimeAsync(6 * 60_000);
      answerDialog(manager, "q1");
      await vi.advanceTimersByTimeAsync(STALL_WINDOW * 2);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });

      answerDialog(manager, "q2");
      await vi.advanceTimersByTimeAsync(STALL_WINDOW - 15_000);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(rpc.send.mock.calls.filter(([cmd]) => cmd.type === "abort")).toHaveLength(1);
      expect(stallNotices(sent)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("aborts a turn whose model stream has been silent past the window", async () => {
    vi.useFakeTimers();
    try {
      const { manager, broadcast, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);

      expect(rpc.send).toHaveBeenCalledWith({ type: "abort" });
      const notices = stallNotices(sent);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        level: "warn",
        message: expect.stringMatching(/stalled turn #1.*turn started/),
      });
      expect(manager.isStreamStalled(TAB)).toBe(true);
      expect(broadcast).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("leaves a busy stream alone", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      for (let elapsed = 0; elapsed < STALL_WINDOW + 60_000; elapsed += 30_000) {
        rpc.frame({
          type: "message_update",
          assistantMessageEvent: { type: "text_delta", delta: "x" },
        });
        await vi.advanceTimersByTimeAsync(30_000);
      }

      expect(rpc.send).not.toHaveBeenCalled();
      expect(stallNotices(sent)).toHaveLength(0);
      expect(manager.isStreamStalled(TAB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("suspends the watchdog while a tool execution is open and gives the next model call a fresh window", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame({ type: "tool_execution_start", toolCallId: "t1" });

      // Half an hour inside one tool run: omp owns tool deadlines; the
      // provider stream owes nothing while local work executes (issue #253).
      await vi.advanceTimersByTimeAsync(30 * 60_000);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });

      // The tool finishing starts the next model request's window.
      rpc.frame({ type: "tool_execution_end", toolCallId: "t1" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW - 15_000);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      await vi.advanceTimersByTimeAsync(15_000);

      expect(rpc.send.mock.calls.filter(([cmd]) => cmd.type === "abort")).toHaveLength(1);
      const notices = stallNotices(sent);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        message: expect.stringMatching(/tool execution finished/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("a ghost tool_execution_end neither underflows nor rebases", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      // No matching start: must neither suspend the watchdog (underflow to
      // -1 would read as "open") nor extend the silence window.
      rpc.frame({ type: "tool_execution_end", toolCallId: "ghost" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);

      expect(rpc.send).toHaveBeenCalledWith({ type: "abort" });
      const notices = stallNotices(sent);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        message: expect.stringMatching(/turn started/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("an orphan tool_execution_update recovers a lost start", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      // The start frame was lost; the update proves a tool is open.
      rpc.frame({ type: "tool_execution_update", toolCallId: "t9" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });

      rpc.frame({ type: "tool_execution_end", toolCallId: "t9" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);

      expect(rpc.send.mock.calls.filter(([cmd]) => cmd.type === "abort")).toHaveLength(1);
      expect(stallNotices(sent)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("turn boundaries clear leaked open tools", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      // Aborted teardown: the tool's end frame never arrives.
      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame({ type: "tool_execution_start", toolCallId: "t1" });
      rpc.frame({ type: "agent_end" });

      // A leaked count must not suppress the watchdog for the next turn.
      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);

      expect(rpc.send).toHaveBeenCalledWith({ type: "abort" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("compaction and retry boundaries rebase the clock", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(170_000);
      rpc.frame({ type: "auto_compaction_start" });
      // 340s of total stream silence, but the compaction boundary rebased:
      // rebase — never suspend — so a wedged compaction still trips the
      // watchdog one full window later.
      await vi.advanceTimersByTimeAsync(170_000);
      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });

      rpc.frame({ type: "auto_compaction_end" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);

      expect(rpc.send.mock.calls.filter(([cmd]) => cmd.type === "abort")).toHaveLength(1);
      const notices = stallNotices(sent);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({
        message: expect.stringMatching(/compaction finished/),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the abort notice carries reason: stall-abort", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);

      const notices = stallNotices(sent);
      expect(notices).toHaveLength(1);
      // Machine-readable hook for the renderer's stall auto-continue
      // (issue #254): the aborted turn's end can never classify as a
      // stall end on its own.
      expect(notices[0]).toMatchObject({ reason: "stall-abort" });
    } finally {
      vi.useRealTimers();
    }
  });

  it("the stalled badge clears when a new turn starts", async () => {
    vi.useFakeTimers();
    try {
      const { manager, broadcast } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);
      expect(manager.isStreamStalled(TAB)).toBe(true);
      const broadcastsAtStall = broadcast.mock.calls.length;

      // The badge is a call-to-action; the next turn is that continuation,
      // whoever sent it (issue #255).
      rpc.frame({ type: "agent_start" });
      expect(manager.isStreamStalled(TAB)).toBe(false);
      expect(broadcast.mock.calls.length).toBeGreaterThan(broadcastsAtStall);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never aborts an idle session, even when its last turn ended long ago", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW * 3);

      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      expect(manager.isStreamStalled(TAB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("fires once per wedged turn — a refused abort does not re-fire every tick", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW * 3);

      const aborts = rpc.send.mock.calls.filter(
        (call) =>
          typeof call[0] === "object" &&
          call[0] !== null &&
          (call[0] as Record<string, unknown>).type === "abort",
      );
      expect(aborts).toHaveLength(1);
      expect(stallNotices(sent)).toHaveLength(1);
      expect(manager.isStreamStalled(TAB)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the stalled badge when the session respawns", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(STALL_WINDOW + 15_000);
      expect(manager.isStreamStalled(TAB)).toBe(true);

      rpc.exit(0);
      await resumeRpc(manager);
      expect(manager.isStreamStalled(TAB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does nothing while the setting is off", async () => {
    vi.useFakeTimers();
    try {
      const { manager, registry } = setup({ mode: "rpc-ui" });
      registry.setStreamStallAbortSeconds(0);
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "turn_start" });
      await vi.advanceTimersByTimeAsync(10 * 60_000);

      expect(rpc.send).not.toHaveBeenCalledWith({ type: "abort" });
      expect(manager.isStreamStalled(TAB)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hibernation (issue #246)", () => {
  /** The default hibernateIdleMinutes is 30; the harness registry keeps it. */
  const WINDOW = 30 * 60_000;
  const PROBE_TIMEOUT = 5_000;
  /** SETTLE_WINDOW_MS in session-manager.ts. */
  const SETTLE = 30 * 60_000;

  const resumeRpc = (manager: SessionManager): Promise<{ tabId: string }> =>
    manager.spawn({
      projectCwd: "/proj",
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      resumeTabId: TAB,
    });

  /** Microtask drain: probe settle → guard re-check → SIGTERM → reap. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 8; i += 1) await Promise.resolve();
  };

  // The fake records raw command objects; the probe is the get_state call.
  const lastProbeId = (rpc: (typeof rpcInstances)[number]): string => {
    for (let i = rpc.send.mock.calls.length - 1; i >= 0; i -= 1) {
      const cmd = rpc.send.mock.calls[i]?.[0];
      if (cmd !== null && typeof cmd === "object" && "type" in cmd && "id" in cmd) {
        if (cmd.type === "get_state") return cmd.id;
      }
    }
    throw new Error("no get_state probe was sent");
  };

  const cleanProbe = (rpc: (typeof rpcInstances)[number]): void => {
    rpc.frame({
      type: "response",
      id: lastProbeId(rpc),
      command: "get_state",
      success: true,
      data: { queuedMessageCount: 0, isStreaming: false },
    });
  };

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

  it("arms on the first frame and hibernates after the quiet window", async () => {
    vi.useFakeTimers();
    try {
      const { manager, broadcast, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));
      broadcast.mockClear();

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      expect(rpc.send).toHaveBeenCalledTimes(1);
      expect(rpc.send.mock.calls[0]![0]).toMatchObject({ type: "get_state" });

      cleanProbe(rpc);
      await flush();

      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(rpc.kill.mock.calls[0]![0]).toBeUndefined(); // SIGTERM first
      expect(
        sent.some((s) => s.channel === CH.onSessionHibernated && s.args[0] === TAB),
      ).toBe(true);
      expect(sent.some((s) => s.channel === CH.onPtyExit)).toBe(false);
      expect(manager.liveCount).toBe(0);
      expect(broadcast).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("never probes or kills while a turn is running", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_start" });
      await vi.advanceTimersByTimeAsync(WINDOW * 2);

      expect(rpc.send).not.toHaveBeenCalled();
      expect(rpc.kill).not.toHaveBeenCalled();
      expect(manager.isLive(TAB)).toBe(true);
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("defers hibernation while messages are parked, and hibernates after they drain", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      rpc.frame({
        type: "response",
        id: lastProbeId(rpc),
        command: "get_state",
        success: true,
        data: { queuedMessageCount: 1, isStreaming: false },
      });
      await flush();
      expect(rpc.kill).not.toHaveBeenCalled();
      expect(manager.isLive(TAB)).toBe(true);

      // The next real frame re-arms; a drained probe then hibernates.
      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      cleanProbe(rpc);
      await flush();
      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(sent.filter((s) => s.channel === CH.onSessionHibernated)).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-probes a quiet session every window when the probe never answers, never killing on silence", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      expect(rpc.send).toHaveBeenCalledTimes(1); // the probe went out

      // No answer: the probe times out and the attempt is dropped — but the
      // clock re-arms (issue #247), so a still-quiet session is re-examined.
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT + 1);
      expect(rpc.kill).not.toHaveBeenCalled();
      expect(manager.isLive(TAB)).toBe(true);

      await vi.advanceTimersByTimeAsync(WINDOW);
      expect(rpc.send).toHaveBeenCalledTimes(2); // one re-probe per window
      expect(rpc.kill).not.toHaveBeenCalled(); // still silent: still not killed
      expect(manager.isLive(TAB)).toBe(true);
      expect(sent.some((s) => s.channel === CH.onPtyExit)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hibernates a quiet session on the re-probe after a transient probe failure (issue #247)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW); // probe #1 goes out
      await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT + 1); // it times out; clock re-arms
      await vi.advanceTimersByTimeAsync(WINDOW); // probe #2 goes out
      expect(rpc.send).toHaveBeenCalledTimes(2);

      cleanProbe(rpc); // the child answers the re-probe this time
      await flush();

      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds hibernation across a plan review and the post-verdict settle window", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));

      rpc.frame(proposalFrame("p1"));
      expect(manager.planGate(TAB)?.pending).not.toBeNull();
      await vi.advanceTimersByTimeAsync(WINDOW);
      expect(rpc.send).not.toHaveBeenCalled(); // gate open: no probe

      manager.rpcSend(TAB, {
        type: "extension_ui_response",
        id: "p1",
        value: Core.PLAN_EXECUTE,
      });
      // The implementation turn ends the settle window and re-arms.
      rpc.frame({ type: "agent_start" });
      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      cleanProbe(rpc);
      await flush();

      expect(rpc.kill).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hibernates a quiet session once the post-verdict settle window lapses (issue #247)", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent, registry } = setup({ mode: "rpc-ui" });
      // Window shorter than SETTLE, so the lapse falls off the re-arm
      // chain's grid: the verdict's one-shot is the only check that can
      // land exactly there (issue #247).
      registry.setHibernateIdleMinutes(8);
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));

      // t=0: plan proposed (the frame arms t=8m). t=5m: reject, no frames
      // after — settle runs to 5m + SETTLE (t=35m) while the 8m re-arm
      // chain fires at t=8/16/24/32/40m. Without the one-shot, the first
      // check at or after the lapse would be t=40m, not the lapse itself.
      rpc.frame(proposalFrame("p1"));
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      manager.rpcSend(TAB, {
        type: "extension_ui_response",
        id: "p1",
        value: Core.PLAN_REFINE,
      });
      expect(rpc.send).toHaveBeenCalledTimes(1); // just the verdict command

      // Every chain fire inside the open settle window: guard in force,
      // re-arm, no probe. The last is t=32m, 3m before the lapse.
      await vi.advanceTimersByTimeAsync(SETTLE - 3 * 60_000);
      expect(rpc.send).toHaveBeenCalledTimes(1);

      // The one-shot scheduled at the verdict lands exactly at the lapse.
      await vi.advanceTimersByTimeAsync(3 * 60_000);
      expect(rpc.send).toHaveBeenCalledTimes(2); // the get_state probe
      cleanProbe(rpc);
      await flush();

      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("holds hibernation while an extension dialog awaits an answer", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));

      rpc.frame({
        type: "extension_ui_request",
        id: "q1",
        method: "select",
        title: "Pick an option",
      });
      await vi.advanceTimersByTimeAsync(WINDOW * 2);
      expect(rpc.send).not.toHaveBeenCalled();
      expect(rpc.kill).not.toHaveBeenCalled();

      // The answer is a command, not a frame; the next real frame re-arms.
      manager.rpcSend(TAB, { type: "extension_ui_response", id: "q1", value: "a" });
      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      cleanProbe(rpc);
      await flush();

      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hold hibernation on fire-and-forget extension requests", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      rpc.kill.mockImplementation(() => rpc.exit(0));

      // setStatus/setWidget are state frames the renderer consumes without a
      // reply; tracking them would block hibernation forever (issue #246).
      rpc.frame({ type: "extension_ui_request", id: "s1", method: "setStatus", statusKey: "omp-ui:advisorStats" });
      rpc.frame({ type: "extension_ui_request", id: "w1", method: "setWidget", widgetKey: "ctx" });

      await vi.advanceTimersByTimeAsync(WINDOW);
      cleanProbe(rpc);
      await flush();

      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never hibernates a PTY session", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup();
      await resume(manager);
      const pty = fakePtys[0]!;

      pty.dataCb?.(Buffer.from("hello"));
      await vi.advanceTimersByTimeAsync(WINDOW * 2);

      expect(pty.kill).not.toHaveBeenCalled();
      expect(manager.isLive(TAB)).toBe(true);
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("never arms a timer when the setting is 0", async () => {
    vi.useFakeTimers();
    try {
      const { manager, registry } = setup({ mode: "rpc-ui" });
      registry.setHibernateIdleMinutes(0);
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW * 2);

      expect(rpc.send).not.toHaveBeenCalled();
      expect(rpc.kill).not.toHaveBeenCalled();
      expect(manager.isLive(TAB)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("hands back to the normal exit path when the child ignores both signals", async () => {
    vi.useFakeTimers();
    try {
      const { manager, sent } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!; // kill is a no-op: the child ignores signals

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      cleanProbe(rpc);
      await flush();
      await vi.advanceTimersByTimeAsync(3_000 + 2_000); // grace + SIGKILL windows

      expect(rpc.kill).toHaveBeenCalledTimes(2);
      expect(rpc.kill.mock.calls[1]![0]).toBe("SIGKILL");
      expect(sent.some((s) => s.channel === CH.onSessionHibernated)).toBe(false);
      expect(manager.isLive(TAB)).toBe(true); // still live: the kill was ignored

      // The later natural exit is a plain exit, not a phantom hibernation.
      rpc.exit(0);
      expect(sent.some((s) => s.channel === CH.onPtyExit)).toBe(true);
      expect(sent.filter((s) => s.channel === CH.onSessionHibernated)).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("makes a concurrent resume wait for an in-flight reap instead of deduping", async () => {
    vi.useFakeTimers();
    try {
      const { manager } = setup({ mode: "rpc-ui" });
      await resumeRpc(manager);
      const rpc = rpcInstances[0]!;
      // SIGTERM acknowledged but the process lingers: the reap is observable.
      rpc.kill.mockImplementation(() => {});

      rpc.frame({ type: "agent_end" });
      await vi.advanceTimersByTimeAsync(WINDOW);
      cleanProbe(rpc);
      await flush();
      expect(rpc.kill).toHaveBeenCalledTimes(1);
      expect(manager.isLive(TAB)).toBe(true); // kill in flight, entry not reaped

      const resuming = resumeRpc(manager); // must not dedupe against the dying entry
      await flush();
      rpc.exit(0); // the reap completes
      await resuming;

      expect(RpcClientMock).toHaveBeenCalledTimes(2);
      expect(manager.liveCount).toBe(1);
      expect(manager.isLive(TAB)).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});
