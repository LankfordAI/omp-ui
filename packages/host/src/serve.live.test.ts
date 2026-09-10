import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BackendState, HostStatus } from "@omp-ui/core";
import { connectInstanceClient, HOST_PROTOCOL, type InstanceClient } from "@omp-ui/server";
import { lockPath, readOwnerRecord } from "./authority/lock";
import { hostRecordPath, readHostRecord, type HostConnectionRecordV1 } from "@omp-ui/core";
import type { KeyProtector } from "./credentials/host-key-cipher";
import { serve, type ServeOptions } from "./serve";

/**
 * Process-backed proof of `serve` (issue #442 §10; #450): a real lock claim,
 * a real ledger, a real HostApplication over a temp data root, and a real
 * loopback control plane dialled through the same client the CLI uses. The
 * DEK protector is the one seam taken — the real one would file a key in the
 * developer's keyring under a temp path. `omp` on PATH is a stub that prints
 * a version: nothing here spawns a session.
 */

const ENV_KEYS = ["OMP_UI_DATA_DIR", "PATH", "PI_CODING_AGENT_DIR", "OMP_UI_OMP_PATH", "XDG_DATA_HOME"] as const;
const savedEnv: Record<string, string | undefined> = {};
let base = "";
let root = "";
const clients: InstanceClient[] = [];
const running: Array<{ signals: EventEmitter; done: Promise<number> }> = [];

function memoryProtector(): KeyProtector {
  let stored: Buffer | null = randomBytes(32);
  return {
    backend: "memory",
    load: async () => stored,
    store: async (dek) => {
      stored = dek;
    },
  };
}

beforeEach(() => {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-serve-live-"));
  root = path.join(base, "data");
  const bin = path.join(base, "bin");
  fs.mkdirSync(bin);
  const stub = path.join(bin, process.platform === "win32" ? "omp.cmd" : "omp");
  fs.writeFileSync(
    stub,
    process.platform === "win32" ? "@echo omp 0.0.0-stub\r\n" : "#!/bin/sh\necho 'omp 0.0.0-stub'\nexit 0\n",
    { mode: 0o755 },
  );
  process.env.OMP_UI_DATA_DIR = root;
  process.env.PATH = `${bin}${path.delimiter}${process.env.PATH ?? ""}`;
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.OMP_UI_OMP_PATH;
  delete process.env.XDG_DATA_HOME;
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const { signals, done } of running.splice(0)) {
    signals.emit("SIGTERM");
    await done;
  }
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(base, { recursive: true, force: true });
});

/** Starts `serve` over `root`; the returned promise is the exit code and the emitter its signal source. */
function start(over: Partial<ServeOptions> = {}): { signals: EventEmitter; done: Promise<number>; log: string[] } {
  const signals = new EventEmitter();
  const log: string[] = [];
  const done = serve({
    dataRoot: root,
    hostVersion: "0.0.0-live",
    flavor: "dev",
    webRoot: "",
    verifier: null,
    signals,
    log: (line) => log.push(line),
    deps: { protector: memoryProtector },
    ...over,
  });
  running.push({ signals, done });
  return { signals, done, log };
}

/**
 * `host.json`, once the boot publishes it — or the boot's early exit, as a
 * failure naming its log. Real time: the awaited actor is a genuine boot
 * writing a file, so the poll is on that observed condition, never a guessed
 * duration (the executor form because the node tsconfig lib is ES2022).
 */
async function awaitRecord(done: Promise<number>, log: string[]): Promise<HostConnectionRecordV1> {
  const exited = done.then((code) => {
    throw new Error(`serve exited ${code} before publishing host.json:\n${log.join("\n")}`);
  });
  const published = (async () => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const record = readHostRecord(root);
      if (record !== null) return record;
      if (Date.now() > deadline) throw new Error(`host.json not published within 30 s:\n${log.join("\n")}`);
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  })();
  return Promise.race([published, exited]);
}

async function dial(record: HostConnectionRecordV1, credential: string, role: "browser" | "desktop"): Promise<InstanceClient> {
  const client = await connectInstanceClient(record.endpoint, credential, {
    timeoutMs: 5000,
    hello: { clientRole: role, clientKind: role, clientVersion: "live-test", clientProtocol: HOST_PROTOCOL },
  });
  clients.push(client);
  return client;
}

describe("serve (live)", () => {
  it("boots, answers both loopback credentials, refuses a forgery, vetoes a second claim, and shuts down clean", async () => {
    const first = start();
    const record = await awaitRecord(first.done, first.log);
    const canonicalRoot = fs.realpathSync.native(root);
    expect(record.dataRoot).toBe(canonicalRoot);
    expect(record.incarnation).toBe(1);

    const control = await dial(record, record.controlCredential, "browser");
    const status = await control.request<HostStatus>("host:status", []);
    expect(status.dataRoot).toBe(canonicalRoot);
    expect(status.incarnation).toBe(1);
    expect(status.hostVersion).toBe("0.0.0-live");
    expect(status.pid).toBe(process.pid);

    const desktop = await dial(record, record.desktopCredential, "desktop");
    const state = await desktop.request<BackendState>("state:get", []);
    expect(state.self.role).toBe("desktop");

    await expect(dial(record, "omp1.ctl.forged", "browser")).rejects.toMatchObject({
      failure: { kind: "unauthorized" },
    });

    // A second host over the same root while the first answers its probe: authority conflict, no takeover.
    const second = start();
    await expect(second.done).resolves.toBe(5);
    running.pop();
    expect(readHostRecord(root)).toEqual(record);
    expect(second.log.some((line) => line.startsWith("authority conflict"))).toBe(true);

    first.signals.emit("SIGTERM");
    await expect(first.done).resolves.toBe(0);
    running.pop();
    expect(fs.existsSync(hostRecordPath(root))).toBe(false);
    // Never unlinked; released in place so the next boot takes over without proving this pid dead.
    expect(fs.existsSync(lockPath(root))).toBe(true);
    expect(readOwnerRecord(root)?.releasedAtMs).toBeTypeOf("number");
    expect(first.log.at(-1)).toBe("shutdown complete");
    // The boot left its breadcrumbs on disk for the next reader.
    expect(fs.readFileSync(path.join(root, "logs", "breadcrumbs.log"), "utf8")).toContain("boot: host ready");
  });

  it("a control-plane host:stop ends the boot sequence the way a signal does", async () => {
    const { done, log } = start();
    const record = await awaitRecord(done, log);
    const control = await dial(record, record.controlCredential, "browser");
    // The socket closes under the request as the listener drains; either answer is the stop landing.
    await control.request("host:stop", []).catch(() => undefined);
    await expect(done).resolves.toBe(0);
    running.pop();
    expect(fs.existsSync(hostRecordPath(root))).toBe(false);
    expect(log).toContain("host:stop; shutting down");
    expect(log.at(-1)).toBe("shutdown complete");
  });

  it("stops on a corrupt registry and leaves the file exactly as it found it", async () => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, "registry.json"), "{not json");
    const { done, log } = start();
    await expect(done).resolves.toBe(1);
    running.pop();
    expect(fs.readFileSync(path.join(root, "registry.json"), "utf8")).toBe("{not json");
    expect(fs.readdirSync(root).filter((name) => name.includes(".corrupt-"))).toEqual([]);
    expect(fs.existsSync(hostRecordPath(root))).toBe(false);
    expect(log.some((line) => line.includes("nothing was moved"))).toBe(true);
  });
});
