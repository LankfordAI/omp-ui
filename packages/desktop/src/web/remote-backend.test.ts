import { afterEach, describe, expect, it } from "vitest";
import { CH, type ChannelTable } from "@omp-ui/core";
import { startHostServer, type HostServerHandle } from "@omp-ui/server";
import { HOST_PROTOCOL, type ClientHello } from "@omp-ui/server/protocol";
import { connectRemoteBackend, IncompatibleHostError } from "./remote-backend";

// The browser transport against the real host server. Node's global WebSocket stands in for the
// browser's; `endpoint` sidesteps `location`, which this environment has none of.

const open: HostServerHandle[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function serve(protocolRange?: { min: number; max: number }): Promise<string> {
  const table = {
    request: { [CH.getState]: () => ({ ok: 1 }) },
    notify: {},
  } as unknown as ChannelTable;
  const handle = await startHostServer({
    surface: { handlers: () => table, connectionClosed() {}, addSink: () => () => {} },
    bind: "localhost",
    port: 0,
    webRoot: "/nonexistent-web-root",
    authenticate: () => ({ role: "browser", local: false, control: false }),
    hostVersion: "7.7.7",
    protocolRange,
    allowImplicitProtocol1: true,
    local: false,
  });
  open.push(handle);
  return `ws://127.0.0.1:${handle.port}/ws`;
}

const HELLO: Omit<ClientHello, "t"> = {
  clientRole: "browser",
  clientKind: "browser",
  clientVersion: "0.0.0",
  clientProtocol: HOST_PROTOCOL,
};

describe("connectRemoteBackend", () => {
  it("resolves on a compatible verdict with the host's hello and serves requests", async () => {
    const endpoint = await serve();
    const conn = await connectRemoteBackend({ endpoint, hello: HELLO });
    expect(conn.hello).toMatchObject({ verdict: "compatible", hostVersion: "7.7.7" });
    await expect(conn.backend.getState()).resolves.toEqual({ ok: 1 });
  });

  it("rejects an incompatible verdict with the host's reason and version", async () => {
    const endpoint = await serve({ min: 9, max: 9 });
    const err = await connectRemoteBackend({ endpoint, hello: HELLO }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(IncompatibleHostError);
    const refused = err as IncompatibleHostError;
    expect(refused.message).toBe(`protocol ${HOST_PROTOCOL} unsupported; host supports 9..9`);
    expect(refused.hostVersion).toBe("7.7.7");
    expect(refused.protocolRange).toEqual({ min: 9, max: 9 });
  });
});
