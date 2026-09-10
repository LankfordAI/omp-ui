import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer } from "ws";
import { CH, type ChannelTable } from "@omp-ui/core";
import {
  startHostServer,
  type ConnectionContext,
  type HostServerHandle,
  type HostServerOptions,
  type HostSurface,
  type ScopedSink,
} from "./index";
import {
  connectInstanceClient,
  InstanceConnectError,
  signInForCredential,
  type InstanceClient,
  type InstanceConnectOptions,
} from "./client";
import {
  HOST_CLOSE_INCOMPATIBLE,
  HOST_PROTOCOL,
  INSTANCE_CLIENT_HEADER,
  REMOTE_WS_PATH,
  type ClientHello,
} from "./protocol";
import { hashRemotePassword, mintRemoteToken, passwordSessionCredential, tokenMatches } from "./token";

const TOKEN = mintRemoteToken();
const HELLO: Omit<ClientHello, "t"> = {
  clientRole: "instance",
  clientKind: "instance",
  clientVersion: "1.2.3",
  clientProtocol: HOST_PROTOCOL,
};

interface FakeSurface extends HostSurface {
  readonly notified: Array<{ ch: string; args: unknown[] }>;
  readonly contexts: ConnectionContext[];
  readonly closed: string[];
  emit(channel: string, args: unknown[]): void;
}

function fakeSurface(): FakeSurface {
  const notified: Array<{ ch: string; args: unknown[] }> = [];
  const contexts: ConnectionContext[] = [];
  const closed: string[] = [];
  const sinks = new Set<ScopedSink>();
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
    contexts,
    closed,
    handlers(ctx) {
      contexts.push(ctx);
      return table;
    },
    connectionClosed(id) {
      closed.push(id);
    },
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(channel, args) {
      for (const sink of sinks) sink({ kind: "broadcast" }, channel, args);
    },
  };
}

const open: HostServerHandle[] = [];
const rawServers: Server[] = [];
const clients: InstanceClient[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const h of open.splice(0)) await h.close();
  for (const s of rawServers.splice(0)) await new Promise<void>((resolve) => s.close(() => resolve()));
});

/** Token or password-session credential, with the joined-instance header selecting the role. */
function authenticateWith(
  password: { salt: string; hash: string } | null,
): HostServerOptions["authenticate"] {
  return (presented, req) => {
    if (presented === null) return null;
    const ok =
      tokenMatches(TOKEN, presented) ||
      (password !== null && tokenMatches(passwordSessionCredential(password.hash), presented));
    if (!ok) return null;
    return req.headers[INSTANCE_CLIENT_HEADER] === "instance"
      ? { role: "instance", local: false, control: false }
      : { role: "browser", local: false, control: false };
  };
}

async function serve(
  overrides: Partial<HostServerOptions> = {},
): Promise<{ handle: HostServerHandle; surface: FakeSurface; base: string }> {
  const surface = (overrides.surface as FakeSurface | undefined) ?? fakeSurface();
  const password = overrides.password ?? null;
  const handle = await startHostServer({
    surface,
    bind: "localhost",
    port: 0,
    webRoot: "/nonexistent-web-root",
    authenticate: authenticateWith(password),
    password,
    manifestToken: () => (password ? null : TOKEN),
    hostVersion: "9.9.9",
    allowImplicitProtocol1: true,
    local: false,
    ...overrides,
  });
  open.push(handle);
  return { handle, surface, base: `http://127.0.0.1:${handle.port}` };
}

async function join(
  base: string,
  credential = TOKEN,
  opts: Partial<InstanceConnectOptions> = {},
): Promise<InstanceClient> {
  const client = await connectInstanceClient(base, credential, { hello: HELLO, ...opts });
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

/**
 * A protocol-1 host: a bare `ws` server that answers req frames and treats a hello as noise,
 * exactly like the pre-#442 server did. `onHello` observes what the client sent first.
 */
function rawProtocol1Server(
  onFrame: (frame: Record<string, unknown>, reply: (frame: unknown) => void) => void,
): Promise<string> {
  const server = createServer();
  const wss = new WebSocketServer({ server, path: REMOTE_WS_PATH });
  wss.on("connection", (ws) => {
    ws.on("message", (raw: Buffer) => {
      onFrame(JSON.parse(raw.toString("utf8")) as Record<string, unknown>, (frame) =>
        ws.send(JSON.stringify(frame)),
      );
    });
  });
  rawServers.push(server);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("no port");
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

describe("connectInstanceClient", () => {
  it("says hello first and resolves with the host's compatible verdict and role", async () => {
    const { base, surface } = await serve();
    const client = await join(base);
    expect(client.hello).toEqual({
      t: "hello",
      verdict: "compatible",
      hostVersion: "9.9.9",
      hostProtocol: HOST_PROTOCOL,
      protocolRange: { min: 1, max: HOST_PROTOCOL },
      reason: null,
    });
    // The instance header earned the instance role; the hello filled in kind and version.
    expect(surface.contexts).toHaveLength(1);
    expect(surface.contexts[0]).toMatchObject({
      role: "instance",
      clientKind: "instance",
      clientVersion: "1.2.3",
      protocolVersion: HOST_PROTOCOL,
    });
    await expect(client.request(CH.getState, [])).resolves.toEqual({ ok: 1 });
  });

  it("rejects with the remote handler's own message", async () => {
    const { base } = await serve();
    const client = await join(base);
    await expect(client.request(CH.getRemoteState, [])).rejects.toThrow("nope");
    await expect(client.request("no:such", [])).rejects.toThrow("unknown channel no:such");
  });

  it("delivers a notify to the remote table", async () => {
    const { base, surface } = await serve();
    const client = await join(base);
    client.notify(CH.ptyWrite, ["tab-1", "ls\n"]);
    // Frames are ordered on one socket: once the request answers, the notify has been dispatched.
    await client.request(CH.getState, []);
    expect(surface.notified).toEqual([{ ch: CH.ptyWrite, args: ["tab-1", "ls\n"] }]);
  });

  it("surfaces JSON and binary events, the latter as Uint8Array", async () => {
    const { base, surface } = await serve();
    const client = await join(base);
    const json = nextEvent(client);
    surface.emit(CH.onStateChanged, [{ projects: [] }]);
    expect(await json).toEqual({ channel: CH.onStateChanged, args: [{ projects: [] }] });
    const binary = nextEvent(client);
    surface.emit(CH.onPtyData, ["tab-1", new Uint8Array([1, 2, 3])]);
    const got = await binary;
    expect(got.channel).toBe(CH.onPtyData);
    expect(got.args[0]).toBe("tab-1");
    expect(got.args[1]).toBeInstanceOf(Uint8Array);
    expect(Array.from(got.args[1] as Uint8Array)).toEqual([1, 2, 3]);
  });

  it("classifies an incompatible verdict with the host's version, range, and reason", async () => {
    const { base } = await serve({ protocolRange: { min: 5, max: 6 } });
    const failure = await failureOf(connectInstanceClient(base, TOKEN, { hello: HELLO }));
    expect(failure).toEqual({
      kind: "incompatible",
      hostVersion: "9.9.9",
      protocolRange: { min: 5, max: 6 },
      reason: `protocol ${HOST_PROTOCOL} unsupported; host supports 5..6`,
    });
  });

  it("carries the reason as the error message", async () => {
    const { base } = await serve();
    // Claiming a browser role over an instance grant is the server's role-mismatch refusal.
    await expect(
      connectInstanceClient(base, TOKEN, { hello: { ...HELLO, clientRole: "browser" } }),
    ).rejects.toThrow("role mismatch");
  });

  it("reads a bare 4002 close before any hello as incompatible with the close reason", async () => {
    const base = await rawProtocol1Server(() => {});
    // Reach under the harness: the raw server closes with the host's code and no hello frame.
    const server = rawServers.at(-1)!;
    server.removeAllListeners("upgrade");
    const wss = new WebSocketServer({ server, path: REMOTE_WS_PATH });
    wss.on("connection", (ws) => {
      ws.on("message", () => ws.close(HOST_CLOSE_INCOMPATIBLE, "hello required"));
    });
    const failure = await failureOf(connectInstanceClient(base, TOKEN, { hello: HELLO }));
    expect(failure).toEqual({
      kind: "incompatible",
      hostVersion: "",
      protocolRange: { min: 0, max: 0 },
      reason: "hello required",
    });
  });

  it("falls back to protocol 1 when the host never answers the hello but serves requests", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const base = await rawProtocol1Server((frame, reply) => {
      seen.push(frame);
      if (frame.t === "req") reply({ t: "res", id: frame.id, ok: true, value: { legacy: true } });
    });
    const client = await join(base, TOKEN, { helloTimeoutMs: 50 });
    expect(client.hello).toBeNull();
    expect(seen[0]).toMatchObject({ t: "hello", clientRole: "instance", clientProtocol: HOST_PROTOCOL });
    await expect(client.request(CH.getState, [])).resolves.toEqual({ legacy: true });
  });

  it("replays events a protocol-1 host sent during the hello window, in order", async () => {
    const base = await rawProtocol1Server((frame, reply) => {
      if (frame.t === "hello") {
        reply({ t: "ev", ch: CH.onStateChanged, args: [1] });
        reply({ t: "ev", ch: CH.onStateChanged, args: [2] });
      }
    });
    const client = await join(base, TOKEN, { helloTimeoutMs: 50 });
    const got: unknown[] = [];
    client.onEvent((_channel, args) => got.push(args[0]));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(got).toEqual([1, 2]);
  });

  it("sends the instance header on the upgrade", async () => {
    const headers: Array<string | undefined> = [];
    const base = await rawProtocol1Server(() => {});
    const server = rawServers.at(-1)!;
    server.prependListener("upgrade", (req) => {
      headers.push(req.headers[INSTANCE_CLIENT_HEADER] as string | undefined);
    });
    await join(base, TOKEN, { helloTimeoutMs: 20 });
    expect(headers).toEqual(["instance"]);
  });

  it("reports a rejected credential as unauthorized", async () => {
    const { base } = await serve();
    expect(await failureOf(connectInstanceClient(base, "wrong", { hello: HELLO }))).toEqual({
      kind: "unauthorized",
    });
  });

  it("reports a closed port as unreachable", async () => {
    const { base, handle } = await serve();
    open.splice(open.indexOf(handle), 1);
    await handle.close();
    const failure = await failureOf(connectInstanceClient(base, TOKEN, { hello: HELLO }));
    expect(failure.kind).toBe("unreachable");
  });

  it("fires onClose once and rejects pending requests when the server goes away", async () => {
    const { base, handle, surface } = await serve();
    const client = await join(base);
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
    open.splice(open.indexOf(handle), 1);
    await handle.close();
    expect(await closed).toBe(1001);
    await expect(client.request(CH.getState, [])).rejects.toThrow("remote connection lost");
    // The surface hears exactly one connectionClosed for the socket it handed a table to.
    expect(surface.closed).toEqual([surface.contexts[0]!.id]);
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
