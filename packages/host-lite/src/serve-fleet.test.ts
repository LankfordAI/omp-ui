/* Integration wiring for the fleet member legs (issue #1010): serve threading,
   attachFleet's table rebuild before the listener starts, buildFleet degradation,
   and stop() disposal. Pure fake handle — S4's suite covers register-fleet-legs
   semantics; these cover only the merge paths added at integration. */
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CH, Registry, type BackendState } from "@omp-ui/core";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server";
import type { FleetLegsHandle } from "./fleet-legs";
import { startLiteFleetMember, type LiteInstance, type LiteServeOptions } from "./serve";
import type { LiteSessions } from "./seams";

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

/** A temp data dir whose registry asks for a loopback listener on a free OS-granted port. */
async function memberDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-fleet-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  // Load-time validation rejects port 0 (needs >=1024): ask the OS for one.
  const server = net.createServer();
  const { promise: listening, resolve: listen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listen);
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  // close()'s callback receives an optional err, so the resolver needs a wrapper.
  const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
  server.close(() => onClose());
  await closed;
  registry.setSettings({ remoteEnabled: true, remoteBind: "localhost", remotePort: port });
  return dir;
}

async function boot(extra: Partial<LiteServeOptions> = {}): Promise<LiteInstance> {
  const instance = await startLiteFleetMember({
    dataDir: await memberDir(),
    version: "0.0.0",
    sessions: noSessions,
    log: () => {},
    ...extra,
  });
  instances.push(instance);
  return instance;
}

function origin(instance: LiteInstance): string {
  return `http://127.0.0.1:${instance.remote.state.port}`;
}

async function join(instance: LiteInstance): Promise<InstanceClient> {
  // The minted join credential lives in the member's own registry.
  const client = await connectInstanceClient(origin(instance), instance.registry.getSetting("remoteToken"));
  clients.push(client);
  return client;
}

/** A handle whose legs are distinguishable stubs; `disposed` flips on dispose(). */
function fakeHandle(): FleetLegsHandle & { disposed: boolean } {
  const handle: FleetLegsHandle & { disposed: boolean } = {
    disposed: false,
    // The transport round-trips handler results without codec validation, so
    // the stub shape is safe to force past the Partial<RequestHandlers> check.
    request: { [CH.fleetHostReport]: () => ({ fake: "host-report" }) } as unknown as FleetLegsHandle["request"],
    notify: {} as FleetLegsHandle["notify"],
    enforceLadder: () => {},
    dispose() {
      handle.disposed = true;
    },
  };
  return handle;
}

describe("serve fleet-legs wiring (issue #1010)", () => {
  it("without legs, no fleet channel is in the table", async () => {
    const instance = await boot();
    expect(CH.fleetHostReport in instance.backend.handlers().request).toBe(false);
  });

  it("a pre-built handle answers over the socket", async () => {
    const instance = await boot({ fleet: fakeHandle() });
    const client = await join(instance);
    expect(await client.request(CH.fleetHostReport, [])).toEqual({ fake: "host-report" });
  });

  it("core channels stay law over a leg that shadows one", async () => {
    const handle = fakeHandle();
    (handle.request as Record<string, unknown>)[CH.getState] = () => ({ fake: "shadow" });
    const instance = await boot({ fleet: handle });
    const getState = instance.backend.handlers().request[CH.getState]!;
    const state = (await getState()) as BackendState;
    // The table's state:get is the CORE handler: registry-shaped state, never the stub.
    expect(Array.isArray(state.projects)).toBe(true);
  });

  it("buildFleet attaches BEFORE the listener starts, and stop disposes the legs", async () => {
    const handle = fakeHandle();
    const instance = await boot({ buildFleet: async () => handle });
    // The listener is already up (boot awaited apply()); an over-socket hit
    // therefore proves the rebuild landed before serving, not after.
    const client = await join(instance);
    expect(await client.request(CH.fleetHostReport, [])).toEqual({ fake: "host-report" });
    await instance.stop();
    expect(handle.disposed).toBe(true);
  });

  it("a failing buildFleet degrades to a legs-absent member that still serves", async () => {
    const lines: string[] = [];
    const instance = await boot({
      log: (line) => lines.push(line),
      buildFleet: async (): Promise<FleetLegsHandle> => {
        throw new Error("adapters exploded");
      },
    });
    expect(lines.some((line) => line.includes("adapters exploded") && line.includes("absent"))).toBe(true);
    const client = await join(instance);
    expect(await client.request(CH.getInstanceIdentity, [])).toMatchObject({ version: "0.0.0" });
    // The fleet channel is absent: the transport's own unknown-channel rejection.
    await expect(client.request(CH.fleetHostReport, [])).rejects.toThrow(/unknown channel/i);
  });
});
