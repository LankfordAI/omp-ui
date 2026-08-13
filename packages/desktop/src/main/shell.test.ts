import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PtyHandle } from "@omp-ui/core";
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
    // `on` channels matter here: shell kill/write/resize are fire-and-forget.
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

// No real login shell is spawned — every other core export stays real.
vi.mock("@omp-ui/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@omp-ui/core")>()),
  spawnShell: vi.fn(),
}));

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { spawnShell } = await import("@omp-ui/core");
const spawnShellMock = vi.mocked(spawnShell);

const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const TAB = "tab-1";
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

interface FakeShell {
  id: string;
  dataCb: ((data: Buffer) => void) | null;
  exitCb: ((e: { exitCode: number; signal?: number }) => void) | null;
  detachData: Mock;
  write: Mock;
  resize: Mock;
  kill: Mock;
}

function makeFakeShell(id: string): FakeShell {
  const fake: FakeShell = {
    id,
    dataCb: null,
    exitCb: null,
    detachData: vi.fn(),
    write: vi.fn(),
    resize: vi.fn(),
    kill: vi.fn(),
  };
  return fake;
}

const fakeShells: FakeShell[] = [];

/**
 * A session exactly as `newSession` leaves it: registered and **not yet
 * materialized** — `sessionId: null` and an empty lineage dir. The shell
 * lifecycle needs a registry record only for the deleteSession case; the
 * fixture mirrors session-advisor.test.ts so both suites exercise the same
 * boot path.
 */
function setup(): { backend: InstanceType<typeof MainBackend> } {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-shell-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const sessionsRoot = path.join(agentDir, "sessions");
  fs.mkdirSync(path.join(sessionsRoot, LINEAGE), { recursive: true });

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    settings: { defaultMode: "rpc-ui" },
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
        mode: "rpc-ui",
        model: "openrouter/openai/gpt-5.6",
        thinkingLevel: "high",
        advisor: false,
        advisorModel: null,
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
  fakeShells.length = 0;
  spawnShellMock.mockReset();
  spawnShellMock.mockImplementation((opts) => {
    const fake = makeFakeShell(opts.id);
    fakeShells.push(fake);
    // The fake only fakes the handle; launchShell wires its callbacks itself.
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
      write: fake.write,
      resize: fake.resize,
      kill: fake.kill,
    };
    return handle;
  });
});

describe("console-drawer shell lifecycle (issue #42)", () => {
  it("shell:spawn registers the handle; write/resize reach it; data goes to the tab", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);

    expect(spawnShellMock).toHaveBeenCalledWith({ id: TAB, cwd: "/proj", cols: 80, rows: 24 });
    const fake = fakeShells[0]!;
    invoke(CH.shellWrite, TAB, "ls\n");
    expect(fake.write).toHaveBeenCalledWith("ls\n");
    invoke(CH.shellResize, TAB, 120, 40);
    expect(fake.resize).toHaveBeenCalledWith(120, 40);

    const chunk = Buffer.from("prompt$ ");
    fake.dataCb!(chunk);
    expect(sent).toContainEqual({ channel: CH.onShellData, args: [TAB, chunk] });
  });

  it("natural exit unregisters the handle and reports the exit code", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    fake.exitCb!({ exitCode: 3 });
    expect(sent).toContainEqual({ channel: CH.onShellExit, args: [TAB, 3] });

    // Gone from the map: a later write is a no-op.
    invoke(CH.shellWrite, TAB, "ls\n");
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("respawn replaces: the stale exit cannot evict its successor", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const first = fakeShells[0]!;
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const second = fakeShells[1]!;

    expect(first.kill).toHaveBeenCalled();
    // The old process's exit arrives after the replacement registered: silent.
    first.exitCb!({ exitCode: 0 });
    expect(sent.find((m) => m.channel === CH.onShellExit)).toBeUndefined();

    // The successor is still the registered handle.
    invoke(CH.shellWrite, TAB, "pwd\n");
    expect(second.write).toHaveBeenCalledWith("pwd\n");
    expect(first.write).not.toHaveBeenCalled();
  });

  it("shell:kill removes the handle and suppresses its exit", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    invoke(CH.shellKill, TAB);
    expect(fake.kill).toHaveBeenCalled();
    fake.exitCb!({ exitCode: 0 });
    expect(sent.find((m) => m.channel === CH.onShellExit)).toBeUndefined();
  });

  it("respawn detaches the predecessor's data listener: its last output never reaches the tab (issue #64)", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const first = fakeShells[0]!;
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);

    // The kill-first replacement must detach before killing — a dying shell's
    // final chunk would otherwise interleave into the successor's terminal.
    expect(first.detachData).toHaveBeenCalled();
    expect(first.dataCb).toBeNull();
    expect(first.kill).toHaveBeenCalled();
  });

  it("shell:kill detaches the data listener before killing (issue #64)", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    invoke(CH.shellKill, TAB);

    expect(fake.detachData).toHaveBeenCalled();
    expect(fake.dataCb).toBeNull();
    expect(fake.kill).toHaveBeenCalled();
  });

  it("killAll kills every live shell", () => {
    const { backend } = setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    backend.killAll();
    expect(fake.detachData).toHaveBeenCalled();
    expect(fake.dataCb).toBeNull();
    expect(fake.kill).toHaveBeenCalled();
    invoke(CH.shellWrite, TAB, "ls\n");
    expect(fake.write).not.toHaveBeenCalled();
  });

  it("terminate kills the tab's shell even with no live session", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    invoke(CH.terminateSession, TAB);
    expect(fake.kill).toHaveBeenCalled();
  });

  it("deleteSession kills the tab's shell", async () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    await invoke(CH.deleteSession, TAB);
    expect(fake.kill).toHaveBeenCalled();
  });
});
