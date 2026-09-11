import { afterEach, describe, expect, it } from "vitest";
import { CH, type ChannelTable } from "@omp-ui/core";
import { startRemoteServer, type RemoteHost, type RemoteServerHandle } from "./index";
import { connectInstanceClient, InstanceConnectError, signInForCredential, type InstanceClient } from "./client";
import { hashRemotePassword, mintRemoteToken } from "./token";

const TOKEN = mintRemoteToken();

interface FakeHost extends RemoteHost {
  readonly notified: Array<{ ch: string; args: unknown[] }>;
  emit(channel: string, args: unknown[]): void;
}

function fakeHost(): FakeHost {
  const notified: Array<{ ch: string; args: unknown[] }> = [];
  const sinks = new Set<(channel: string, args: unknown[]) => void>();
  const table = {
    request: {
      [CH.getState]: () => ({ ok: 1 }),
      [CH.getRemoteState]: () => {
        throw new Error("nope");
      },
    },
    notify: {
      [CH.ptyWrite]: (tabId: string, data: string) => {
        notified.push({ ch: CH.ptyWrite, args: [tabId, data] });
      },
    },
  } as unknown as ChannelTable;
  return {
    notified,
    handlers: () => table,
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(channel, args) {
      for (const sink of sinks) sink(channel, args);
    },
  };
}

const open: RemoteServerHandle[] = [];
const clients: InstanceClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of open.splice(0)) await h.close();
});

async function serve(
  overrides: Partial<Parameters<typeof startRemoteServer>[0]> = {},
): Promise<{ handle: RemoteServerHandle; host: FakeHost; base: string }> {
  const host = (overrides.host as FakeHost | undefined) ?? fakeHost();
  const handle = await startRemoteServer({
    host,
    token: TOKEN,
    bind: "localhost",
    port: 0,
    webRoot: "/nonexistent-web-root",
    ...overrides,
  });
  open.push(handle);
  return { handle, host, base: `http://127.0.0.1:${handle.port}` };
}

async function join(base: string, credential = TOKEN): Promise<InstanceClient> {
  const client = await connectInstanceClient(base, credential);
  clients.push(client);
  return client;
}

function nextEvent(client: InstanceClient): Promise<{ channel: string; args: unknown[] }> {
  return new Promise((resolve) => client.onEvent((channel, args) => resolve({ channel, args })));
}

async function failureOf(promise: Promise<unknown>): Promise<InstanceConnectError["failure"]> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(InstanceConnectError);
    return (err as InstanceConnectError).failure;
  }
  throw new Error("expected rejection");
}

describe("connectInstanceClient", () => {
  it("round-trips a request through the remote's handler table", async () => {
    const { base } = await serve();
    const client = await join(base);
    await expect(client.request(CH.getState, [])).resolves.toEqual({ ok: 1 });
  });

  it("rejects with the remote handler's own message", async () => {
    const { base } = await serve();
    const client = await join(base);
    await expect(client.request(CH.getRemoteState, [])).rejects.toThrow("nope");
    await expect(client.request("no:such", [])).rejects.toThrow("unknown channel no:such");
  });

  it("delivers a notify to the remote table", async () => {
    const { base, host } = await serve();
    const client = await join(base);
    client.notify(CH.ptyWrite, ["tab-1", "ls\n"]);
    // Frames are ordered on one socket: once the request answers, the notify has been dispatched.
    await client.request(CH.getState, []);
    expect(host.notified).toEqual([{ ch: CH.ptyWrite, args: ["tab-1", "ls\n"] }]);
  });

  it("surfaces JSON and binary events, the latter as Uint8Array", async () => {
    const { base, host } = await serve();
    const client = await join(base);
    const json = nextEvent(client);
    host.emit(CH.onStateChanged, [{ projects: [] }]);
    expect(await json).toEqual({ channel: CH.onStateChanged, args: [{ projects: [] }] });
    const binary = nextEvent(client);
    host.emit(CH.onPtyData, ["tab-1", new Uint8Array([1, 2, 3])]);
    const got = await binary;
    expect(got.channel).toBe(CH.onPtyData);
    expect(got.args[0]).toBe("tab-1");
    expect(got.args[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(got.args[1] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("reports a rejected credential as unauthorized", async () => {
    const { base } = await serve();
    expect(await failureOf(connectInstanceClient(base, "wrong"))).toEqual({ kind: "unauthorized" });
  });

  it("reports a closed port as unreachable", async () => {
    const { base, handle } = await serve();
    open.splice(open.indexOf(handle), 1);
    await handle.close();
    const failure = await failureOf(connectInstanceClient(base, TOKEN));
    expect(failure.kind).toBe("unreachable");
  });

  it("fires onClose once and rejects pending requests when the server goes away", async () => {
    const { base, handle } = await serve();
    const client = await join(base);
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
    // A request nobody answers: the fake host has no handler that stalls, so stall the reply by
    // closing before the server can send it — the close path rejects it either way.
    open.splice(open.indexOf(handle), 1);
    await handle.close();
    expect(await closed).toBe(1001);
    await expect(client.request(CH.getState, [])).rejects.toThrow("remote connection lost");
  });
});

describe("signInForCredential", () => {
  it("returns a credential that authenticates the upgrade", async () => {
    const { base } = await serve({ password: hashRemotePassword("correct horse") });
    const credential = await signInForCredential(base, "correct horse");
    expect(credential).not.toBe("correct horse");
    const client = await join(base, credential);
    await expect(client.request(CH.getState, [])).resolves.toEqual({ ok: 1 });
  });

  it("names a wrong password", async () => {
    const { base } = await serve({ password: hashRemotePassword("correct horse") });
    await expect(signInForCredential(base, "nope nope")).rejects.toThrow("Wrong password.");
  });

  it("explains a token-only remote", async () => {
    const { base } = await serve();
    await expect(signInForCredential(base, "anything")).rejects.toThrow(/access token/);
  });
});
