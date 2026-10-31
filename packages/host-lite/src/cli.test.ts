import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it } from "vitest";
import { Registry } from "@omp-ui/core";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server";
import { LITE_EXIT, runLiteCli, type LiteCliIo } from "./cli";
import { startLiteFleetMember, type LiteInstance } from "./serve";
import type { LiteSessions } from "./seams";
import type { BackendState } from "@omp-ui/core";

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

describe("omp-lite status (issue #1010)", () => {
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
    expect(board.out.join("\n")).toContain("Usage: omp-lite");
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
