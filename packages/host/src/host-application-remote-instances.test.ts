import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CH, type BackendState, type InstanceIdentity } from "@omp-ui/core";
import { HOST_PROTOCOL, HOST_PROTOCOL_RANGE } from "@omp-ui/server";
import { testHost, type BoundConnection } from "./test/fixtures";

let base: string;
let registryFile: string;
let ipc: BoundConnection;
const hosts: BoundConnection[] = [];

function boot(): void {
  ipc = testHost(registryFile, { hostVersion: "1.2.3" });
  hosts.push(ipc);
}

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(channel, ...args);

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-ri-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
});

afterEach(async () => {
  for (const { host } of hosts.splice(0)) await host.shutdown();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("remote instances wiring (issue #416)", () => {
  it("projects an empty remoteInstances list and answers instance:identity with a minted id and its protocol", async () => {
    boot();
    const state = (await invoke(CH.getState)) as BackendState;
    expect(state.remoteInstances).toEqual([]);
    expect(state.hostVersion).toBe("1.2.3");
    expect(state.hostProtocol).toBe(HOST_PROTOCOL);

    const identity = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    expect(identity.version).toBe("1.2.3");
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    expect(identity.protocolVersion).toBe(HOST_PROTOCOL);
    expect(identity.protocolRange).toEqual(HOST_PROTOCOL_RANGE);
  });

  it("keeps the same instanceId across a reload", async () => {
    boot();
    const first = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    boot();
    const second = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    expect(second.instanceId).toBe(first.instanceId);
  });

  it("refuses the renderer proxy for an unknown instance", async () => {
    boot();
    await expect(invoke(CH.remoteInstanceRequest, "nope", CH.getState, [])).rejects.toThrow(
      "unknown instance nope",
    );
  });
});
