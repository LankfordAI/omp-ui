import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Registry, type BackendState, type RoutinesState } from "@omp-ui/core";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server";
import { LITE_EXIT, runLiteCli, type LiteCliIo } from "./cli";
import { dataDirLockPath } from "./data-dir-lock";
import { controlSocketPath } from "./local-control";
import { startLiteFleetMember, type LiteInstance } from "./serve";
import type { LiteRoutinesControl, LiteSessions } from "./seams";
// `status` is the operator's one-line answer to "is my member reachable?" — it
// must read only persisted settings (never load processes), print bind/port/url,
// and prove reachability the way the owner does: an authenticated state:get.

const dirs: string[] = [];
const instances: LiteInstance[] = [];
const clients: InstanceClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const instance of instances.splice(0)) await instance.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const noSessions: LiteSessions = {
  handlers: {},
  state: () =>
    ({
      projects: [],
      chats: [],
      spawnGate: { model: null, advisorModel: null },
      remoteInstances: [],
      fleetPending: [],
      fleetTerminals: [],
    }) as unknown as BackendState,
  on: () => () => {},
  dispose: async () => {},
};

function io(): LiteCliIo & { out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, stdout: (line) => out.push(line), stderr: (line) => err.push(line), env: {} };
}

function memberDir(enabled: boolean): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-cli-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  registry.setSettings({ remoteEnabled: enabled, remoteBind: "localhost", remotePort: 0 });
  return dir;
}

/** An OS-chosen loopback port, released before it is dialed. */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

describe("omp-ui-lite status (issue #1010)", () => {
  it("reports reachable with a live listener and an authenticated probe", async () => {
    // Real end to end: boot the member on a concrete persisted port, then run
    // `status` against the same data dir with the real connector.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-cli-"));
    dirs.push(dir);
    const registry = Registry.load(path.join(dir, "registry.json"));
    registry.setSettings({ remoteEnabled: true, remoteBind: "localhost", remotePort: await freePort() });
    const instance = await startLiteFleetMember({ dataDir: dir, version: "0.0.0", sessions: noSessions, log: () => {} });
    instances.push(instance);
    expect(instance.remote.state.status).toBe("listening");
    const board = io();
    const code = await runLiteCli(["status"], {
      io: board,
      serve: async () => {
        throw new Error("status must never boot the member");
      },
      connect: connectInstanceClient,
      resolveDataDir: () => dir,
    });
    expect(code).toBe(LITE_EXIT.OK);
    expect(board.out.join("\n")).toContain(`port ${instance.remote.state.port}`);
    expect(board.out.join("\n")).toContain("reachable");
  });

  it("reports unreachable when nothing listens on the persisted port", async () => {
    const dir = memberDir(true);
    // Persist a concrete port nobody holds: an OS-granted number, released again.
    const port = await freePort();
    const registry = Registry.load(path.join(dir, "registry.json"));
    registry.setSetting("remotePort", port);
    registry.setSetting("remoteToken", "x".repeat(43));
    const board = io();
    const code = await runLiteCli(["status"], {
      io: board,
      serve: async () => {
        throw new Error("status must never boot the member");
      },
      connect: connectInstanceClient,
      resolveDataDir: () => dir,
    });
    expect(code).toBe(LITE_EXIT.OPERATIONAL);
    expect(board.out.join("\n")).toContain("unreachable");
    expect(board.out.join("\n")).toContain(`port ${port}`);
  });

  it("reports off without probing when remoteEnabled is persisted off", async () => {
    const dir = memberDir(false);
    const board = io();
    const code = await runLiteCli(["status"], {
      io: board,
      serve: async () => {
        throw new Error("status must never boot the member");
      },
      connect: (url) => {
        void url;
        throw new Error("must not probe while off");
      },
      resolveDataDir: () => dir,
    });
    expect(code).toBe(LITE_EXIT.OPERATIONAL);
    expect(board.out.join("\n")).toContain("off");
  });

  it("unknown command exits usage with the help text", async () => {
    const board = io();
    const code = await runLiteCli(["wat"], {
      io: board,
      serve: async () => ({ stop: async () => {} }),
      connect: connectInstanceClient,
      resolveDataDir: () => "/unused",
    });
    expect(code).toBe(LITE_EXIT.USAGE);
    expect(board.err.join("\n")).toContain('unknown command "wat"');
    expect(board.out.join("\n")).toContain("Usage: omp-ui-lite");
  });

  it("serve boots through the injected pipeline and drains on signal", async () => {
    const dir = memberDir(true);
    let stopped = 0;
    const board = io();
    const signals = new EventEmitter();
    const running = runLiteCli(["serve"], {
      io: board,
      signals,
      serve: async ({ dataDir }) => {
        expect(dataDir).toBe(dir);
        return {
          stop: async () => {
            stopped += 1;
          },
        };
      },
      connect: connectInstanceClient,
      resolveDataDir: () => dir,
    });
    // serve parks on the signal gate; SIGINT must drain and resolve OK.
    signals.emit("SIGINT");
    expect(await running).toBe(LITE_EXIT.OK);
    expect(stopped).toBe(1);
  });

  it("serve drains when the stop signal arrives mid-boot", async () => {
    const board = io();
    const signals = new EventEmitter();
    let stopped = 0;
    const running = runLiteCli(["serve"], {
      io: board,
      signals,
      serve: async () => {
        // The gate armed before boot: a signal that lands here still drains.
        signals.emit("SIGTERM");
        return {
          stop: async () => {
            stopped += 1;
          },
        };
      },
      connect: connectInstanceClient,
      resolveDataDir: () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-cli-"));
        dirs.push(dir);
        return dir;
      },
    });
    expect(await running).toBe(LITE_EXIT.OK);
    expect(stopped).toBe(1);
  });
});

function makeRoutinesControlFake(registry: Registry): {
  sessions: LiteSessions;
  enableCalls: Array<{ warnUsd?: number; maxUsd?: number; warnAtFire: number; maxAtFire: number }>;
} {
  const enableCalls: Array<{ warnUsd?: number; maxUsd?: number; warnAtFire: number; maxAtFire: number }> = [];
  const state = (): RoutinesState => ({
    enabled: registry.getSetting("routinesEnabled"),
    machineLabel: "lite-box",
    routines: [],
    runs: [
      {
        id: "r1",
        routineId: "AAAAAAAAAAAAAAAAAAAAAA",
        routineName: "Inbox",
        firedAtMs: 1_000,
        scheduledForMs: 1_000,
        trigger: "clock",
        outcome: "waiting-approval",
        tabId: "tab-wait",
        reasonCode: null,
        missed: 0,
        pruned: false,
        staleCatalog: false,
      },
    ],
    activeRunTabId: null,
    defaultWarnCostUsd: registry.getSetting("routineWarnCostUsd"),
    defaultMaxCostUsd: registry.getSetting("routineMaxCostUsd"),
  });
  const routinesControl: LiteRoutinesControl = {
    state,
    enable: async (caps) => {
      const patch: { routinesEnabled: boolean; routineWarnCostUsd?: number; routineMaxCostUsd?: number } = {
        routinesEnabled: true,
      };
      if (caps?.warnUsd !== undefined) patch.routineWarnCostUsd = caps.warnUsd;
      if (caps?.maxUsd !== undefined) patch.routineMaxCostUsd = caps.maxUsd;
      registry.setSettings(patch);
      enableCalls.push({
        ...caps,
        warnAtFire: registry.getSetting("routineWarnCostUsd"),
        maxAtFire: registry.getSetting("routineMaxCostUsd"),
      });
      return state();
    },
    disable: async () => {
      registry.setSetting("routinesEnabled", false);
      return state();
    },
    setSpendDefaults: async (caps) => {
      if (!registry.getSetting("routinesEnabled")) {
        throw new Error("Routines is disabled in Settings → Routines");
      }
      registry.setSettings({
        routineWarnCostUsd: caps.warnUsd ?? registry.getSetting("routineWarnCostUsd"),
        routineMaxCostUsd: caps.maxUsd ?? registry.getSetting("routineMaxCostUsd"),
      });
      return state();
    },
  };
  return {
    enableCalls,
    sessions: {
      ...noSessions,
      routinesControl,
    },
  };
}

describe("omp-ui-lite routines CLI (#1368)", () => {
  it("controls a live daemon over the local control socket even when remoteEnabled is false", async () => {
    const dir = memberDir(false);
    let enableCalls: Array<{ warnUsd?: number; maxUsd?: number; warnAtFire: number; maxAtFire: number }> = [];
    const instance = await startLiteFleetMember({
      dataDir: dir,
      version: "0.0.0",
      listen: true,
      log: () => {},
      buildSessions: async ({ registry }) => {
        const fake = makeRoutinesControlFake(registry);
        enableCalls = fake.enableCalls;
        return fake.sessions;
      },
    });
    instances.push(instance);
    expect(instance.remote.state.status).toBe("stopped");
    if (process.platform !== "win32") {
      expect(fs.statSync(controlSocketPath(dir)).mode & 0o777).toBe(0o600);
    }

    const runCli = (args: string[]) => {
      const board = io();
      return runLiteCli(args, {
        io: board,
        serve: async () => ({ stop: async () => {} }),
        connect: connectInstanceClient,
        resolveDataDir: () => dir,
      }).then((code) => ({ code, board }));
    };

    // Status while disabled shows waiting-approval count derived from runs.
    const s0 = await runCli(["routines", "status"]);
    expect(s0.code).toBe(LITE_EXIT.OK);
    expect(s0.board.out.join("\n")).toContain("routines: disabled");
    expect(s0.board.out.join("\n")).toContain("waiting approval: 1");

    // Spend while disabled refuses with exit 1.
    const spDisabled = await runCli(["routines", "spend", "--warn", "1"]);
    expect(spDisabled.code).toBe(LITE_EXIT.OPERATIONAL);
    expect(spDisabled.board.err.join("\n")).toMatch(/disabled/i);

    // Atomic enable with --warn and --max commits caps before arming.
    const en = await runCli(["routines", "enable", "--warn", "1.5", "--max", "4"]);
    expect(en.code).toBe(LITE_EXIT.OK);
    expect(enableCalls).toEqual([{ warnUsd: 1.5, maxUsd: 4, warnAtFire: 1.5, maxAtFire: 4 }]);
    expect(instance.registry.getSetting("routinesEnabled")).toBe(true);
    expect(instance.registry.getSetting("routineWarnCostUsd")).toBe(1.5);
    expect(instance.registry.getSetting("routineMaxCostUsd")).toBe(4);

    // Spend while enabled updates live registry.
    const sp = await runCli(["routines", "spend", "--max=9"]);
    expect(sp.code).toBe(LITE_EXIT.OK);
    expect(instance.registry.getSetting("routineWarnCostUsd")).toBe(1.5);
    expect(instance.registry.getSetting("routineMaxCostUsd")).toBe(9);

    // Disable turns gate off cleanly.
    const dis = await runCli(["routines", "disable"]);
    expect(dis.code).toBe(LITE_EXIT.OK);
    expect(instance.registry.getSetting("routinesEnabled")).toBe(false);
  });

  it("offline routines status creates no files; offline enable enforces 0700 home and seeds member defaults", async () => {
    const parent = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-fresh-"));
    dirs.push(parent);
    const dir = path.join(parent, "brand-new-home");

    const runCli = (args: string[]) => {
      const board = io();
      return runLiteCli(args, {
        io: board,
        serve: async () => ({ stop: async () => {} }),
        connect: connectInstanceClient,
        resolveDataDir: () => dir,
      }).then((code) => ({ code, board }));
    };

    // Side-effect-free offline status creates nothing.
    const st = await runCli(["routines"]);
    expect(st.code).toBe(LITE_EXIT.OK);
    expect(st.board.out.join("\n")).toContain("routines: disabled");
    expect(st.board.out.join("\n")).toContain("daemon offline");
    expect(fs.existsSync(dir)).toBe(false);

    // Offline spend while disabled refuses with exit 1.
    const sp0 = await runCli(["routines", "spend", "--warn", "1"]);
    expect(sp0.code).toBe(LITE_EXIT.OPERATIONAL);
    expect(sp0.board.err.join("\n")).toMatch(/disabled/i);

    // Offline enable on fresh dir creates 0700 home, seeds remoteEnabled/lan, and sets caps.
    const fresh2 = path.join(parent, "brand-new-home-2");
    const board2 = io();
    const en = await runLiteCli(["routines", "enable", "--warn", "3", "--max", "8"], {
      io: board2,
      serve: async () => ({ stop: async () => {} }),
      connect: connectInstanceClient,
      resolveDataDir: () => fresh2,
    });
    expect(en).toBe(LITE_EXIT.OK);
    if (process.platform !== "win32") {
      expect(fs.statSync(fresh2).mode & 0o777).toBe(0o700);
    }
    const reg = Registry.load(path.join(fresh2, "registry.json"));
    expect(reg.getSetting("remoteEnabled")).toBe(true);
    expect(reg.getSetting("remoteBind")).toBe("lan");
    expect(reg.getSetting("routinesEnabled")).toBe(true);
    expect(reg.getSetting("routineWarnCostUsd")).toBe(3);
    expect(reg.getSetting("routineMaxCostUsd")).toBe(8);
  });

  it("fails closed with exit 1 if a live daemon owns lite.lock with an unresponsive socket, and exits 2 on bad flags", async () => {
    const dir = memberDir(false);
    // Simulate a live daemon holding lite.lock (current PID) while control.sock is missing.
    fs.writeFileSync(
      dataDirLockPath(dir),
      `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      { mode: 0o600 },
    );
    const board = io();
    const locked = await runLiteCli(["routines", "enable"], {
      io: board,
      serve: async () => ({ stop: async () => {} }),
      connect: connectInstanceClient,
      resolveDataDir: () => dir,
    });
    expect(locked).toBe(LITE_EXIT.OPERATIONAL);
    expect(board.err.join("\n")).toContain(`pid ${process.pid}`);
    expect(Registry.load(path.join(dir, "registry.json")).getSetting("routinesEnabled")).toBe(false);

    // Bad CLI flags exit USAGE (2).
    const bad1 = io();
    expect(
      await runLiteCli(["routines", "spend"], {
        io: bad1,
        serve: async () => ({ stop: async () => {} }),
        connect: connectInstanceClient,
        resolveDataDir: () => dir,
      }),
    ).toBe(LITE_EXIT.USAGE);

    const bad2 = io();
    expect(
      await runLiteCli(["routines", "enable", "--warn", "-5"], {
        io: bad2,
        serve: async () => ({ stop: async () => {} }),
        connect: connectInstanceClient,
        resolveDataDir: () => dir,
      }),
    ).toBe(LITE_EXIT.USAGE);

    const bad3 = io();
    expect(
      await runLiteCli(["routines", "bogus"], {
        io: bad3,
        serve: async () => ({ stop: async () => {} }),
        connect: connectInstanceClient,
        resolveDataDir: () => dir,
      }),
    ).toBe(LITE_EXIT.USAGE);
  });
});
