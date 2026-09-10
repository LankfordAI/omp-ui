import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { CH, spawnOmpTui, spawnShell, type PtyHandle } from "@omp-ui/core";
import type * as Core from "@omp-ui/core";
import { parseSpawnGate, type SpawnGate } from "./spawn-gate";
import type { ChildEntry, ChildrenLedger } from "../authority/children-ledger";
import { ownedSessionRecord, seedRegistry, testHost, type BoundConnection } from "../test/fixtures";

// Neither a real login shell nor a real omp TUI is spawned — every other core
// export stays real.
vi.mock("@omp-ui/core", async (importOriginal) => ({
  ...(await importOriginal<typeof Core>()),
  spawnShell: vi.fn(),
  spawnOmpTui: vi.fn(),
}));

const spawnShellMock = vi.mocked(spawnShell);
const spawnOmpTuiMock = vi.mocked(spawnOmpTui);

const LINEAGE = "omp-ui--proj--11111111-2222-3333-4444-555555555555";
const TAB = "tab-1";
let ipc: BoundConnection;

let base: string;
/** The path the TUI handoff must hand to spawnOmpTui — see setup(). */
let ompBin: string;

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

/** The pid `fakeHandle` gave the n-th fake (in creation order). */
const fakeHandlePid = (index: number): number => 2000 + index;

/** Both console programs hand back the same fake handle; only the call differs. */
function fakeHandle(opts: { id: string }): PtyHandle {
  const fake = makeFakeShell(opts.id);
  fakeShells.push(fake);
  // The fake only fakes the handle; launchShell wires its callbacks itself.
  return {
    id: fake.id,
    pid: fakeHandlePid(fakeShells.length - 1),
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

/**
 * A session exactly as `newSession` leaves it: registered and **not yet
 * materialized** — `sessionId: null` and an empty lineage dir. The shell
 * lifecycle needs a registry record only for the deleteSession case; the
 * fixture mirrors session-advisor.test.ts so both suites exercise the same
 * boot path.
 */
function setup(opts: { spawnGate?: SpawnGate; ledger?: ChildrenLedger } = {}): BoundConnection {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-shell-"));
  const agentDir = path.join(base, "agent");
  process.env.PI_CODING_AGENT_DIR = agentDir;
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  // resolveOmpBinary runs once in the HostApplication constructor, so the override
  // must exist before it: the omp-tui handoff asserts on this exact path.
  ompBin = path.join(base, "omp");
  fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
  process.env.OMP_UI_OMP_PATH = ompBin;

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
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
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

  ipc = testHost(registryFile, opts);
  return ipc;
}

const invoke = (ch: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(ch, ...args);

beforeEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
  delete process.env.OMP_UI_OMP_PATH;
  fakeShells.length = 0;
  spawnShellMock.mockReset();
  spawnShellMock.mockImplementation(fakeHandle);
  spawnOmpTuiMock.mockReset();
  spawnOmpTuiMock.mockImplementation(fakeHandle);
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
    expect(ipc.sent).toContainEqual({ channel: CH.onShellData, args: [TAB, chunk] });
  });

  it("natural exit unregisters the handle and reports the exit code", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    fake.exitCb!({ exitCode: 3 });
    expect(ipc.sent).toContainEqual({ channel: CH.onShellExit, args: [TAB, 3] });

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
    expect(ipc.sent.find((m) => m.channel === CH.onShellExit)).toBeUndefined();

    // The successor is still the registered handle.
    invoke(CH.shellWrite, TAB, "pwd\n");
    expect(second.write).toHaveBeenCalledWith("pwd\n");
    expect(first.write).not.toHaveBeenCalled();
  });

  it("ledgers the console child before its handle is published and removes it on exit (#450)", () => {
    const added: Array<{ entry: ChildEntry; writesReachedAtAdd: boolean }> = [];
    const removed: number[] = [];
    const ledger = {
      bootId: () => "boot-T",
      add: (entry: ChildEntry) => {
        // The handle is published after the ledger write: a write now must not reach any shell.
        invoke(CH.shellWrite, TAB, "early\n");
        added.push({ entry, writesReachedAtAdd: fakeShells.some((s) => s.write.mock.calls.length > 0) });
      },
      remove: (pid: number) => {
        removed.push(pid);
      },
    } as unknown as ChildrenLedger;
    setup({ ledger });
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const shellPid = fakeHandlePid(0);
    expect(added).toEqual([
      {
        writesReachedAtAdd: false,
        entry: expect.objectContaining({
          pid: shellPid,
          pgid: process.platform === "win32" ? 0 : shellPid,
          bootId: "boot-T",
          kind: "shell",
          tabId: TAB,
          executable: expect.stringMatching(/./),
        }),
      },
    ]);
    fakeShells[0]!.exitCb!({ exitCode: 0 });
    expect(removed).toEqual([shellPid]);

    invoke(CH.shellSpawn, TAB, "/proj", 80, 24, "omp-tui");
    expect(added[1]!.entry).toMatchObject({ pid: fakeHandlePid(1), kind: "shell", executable: ompBin });
    invoke(CH.shellKill, TAB);
    fakeShells[1]!.exitCb!({ exitCode: 0 });
    expect(removed).toEqual([shellPid, fakeHandlePid(1)]);
  });

  it("shell:kill removes the handle and suppresses its exit", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    invoke(CH.shellKill, TAB);
    expect(fake.kill).toHaveBeenCalled();
    fake.exitCb!({ exitCode: 0 });
    expect(ipc.sent.find((m) => m.channel === CH.onShellExit)).toBeUndefined();
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

  it("killAll kills every live shell", async () => {
    const { host } = setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const fake = fakeShells[0]!;

    await host.shutdown();
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

    await invoke(CH.deleteSession, TAB, false);
    expect(fake.kill).toHaveBeenCalled();
  });
});

describe("console-drawer TUI handoff (issue #243)", () => {
  it("shell:spawn without a program keeps the login shell", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);

    expect(spawnShellMock).toHaveBeenCalledWith({ id: TAB, cwd: "/proj", cols: 80, rows: 24 });
    expect(spawnOmpTuiMock).not.toHaveBeenCalled();
  });

  it("shell:spawn with omp-tui runs omp in the tab's cwd at the drawer's size", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 100, 30, "omp-tui");

    expect(spawnOmpTuiMock).toHaveBeenCalledWith({
      id: TAB,
      cwd: "/proj",
      cols: 100,
      rows: 30,
      ompPath: ompBin,
    });
    expect(spawnShellMock).not.toHaveBeenCalled();

    // The handoff's handle is the registered one: the banner's send must land
    // in the TUI, not in a dead shell.
    invoke(CH.shellWrite, TAB, "/mcp reauth ctx\r");
    expect(fakeShells[0]!.write).toHaveBeenCalledWith("/mcp reauth ctx\r");
  });

  it("hands the dev/test spawn gate's selector to the TUI, which runs real turns", () => {
    setup({ spawnGate: parseSpawnGate({ OMP_UI_TEST_MODEL: "gate/model:low" }) });
    invoke(CH.shellSpawn, TAB, "/proj", 100, 30, "omp-tui");

    expect(spawnOmpTuiMock).toHaveBeenCalledWith({
      id: TAB,
      cwd: "/proj",
      cols: 100,
      rows: 30,
      ompPath: ompBin,
      model: "gate/model:low",
    });
  });

  it("a staged handoff replaces the running login shell without a stale exit", () => {
    setup();
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24);
    const shell = fakeShells[0]!;
    invoke(CH.shellSpawn, TAB, "/proj", 80, 24, "omp-tui");
    const tui = fakeShells[1]!;

    expect(shell.kill).toHaveBeenCalled();
    // Its exit lands after the TUI registered — reporting it would close the
    // drawer out from under the handoff.
    shell.exitCb!({ exitCode: 0 });
    expect(ipc.sent.find((m) => m.channel === CH.onShellExit)).toBeUndefined();

    tui.exitCb!({ exitCode: 0 });
    expect(ipc.sent).toContainEqual({ channel: CH.onShellExit, args: [TAB, 0] });
  });
});
