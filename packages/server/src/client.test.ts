import { createServer } from "node:http";
import type { Socket } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CH, type ChannelTable } from "@omp-ui/core";
import { startRemoteServer, type RemoteHost, type RemoteServerHandle } from "./index";
import { connectInstanceClient, InstanceConnectError, signInForCredential, type InstanceClient } from "./client";
import { hashRemotePassword, mintRemoteToken } from "./token";
import {
  encodeBinaryEvent,
  encodeFrameDelivery,
  makeServerFrameStream,
  makeServerResponseOk,
  parseClientFrame,
  parseFrameAck,
  REMOTE_CLOSE_REVOKED,
  REMOTE_FRAME_KEY_PARAM,
  REMOTE_FRAME_WS_PATH,
  REMOTE_WS_PATH,
  type FrameAck,
} from "./protocol";

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
const wireCleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  for (const c of clients.splice(0)) c.close();
  for (const close of wireCleanup.splice(0)) await close();
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

async function wireServer(opts: { holdFrames?: boolean; announce?: boolean } = {}) {
  const key = "a".repeat(64);
  const server = createServer();
  const reliableServer = new WebSocketServer({ noServer: true });
  const frameServer = new WebSocketServer({ noServer: true });
  const controls: WebSocket[] = [];
  const frames: Array<{ socket: WebSocket; acks: FrameAck[] }> = [];
  const upgrades: Array<() => void> = [];
  const sockets = new Set<Socket>();
  const access = { frameStatus: 101 };
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  reliableServer.on("connection", (socket) => {
    controls.push(socket);
    socket.on("message", (raw) => {
      const request = parseClientFrame(JSON.parse(raw.toString()));
      if (request?.t === "req") socket.send(JSON.stringify(makeServerResponseOk(request.id, { ok: 1 })));
    });
    if (opts.announce !== false) socket.send(JSON.stringify(makeServerFrameStream(key)));
  });
  frameServer.on("connection", (socket) => {
    const acks: FrameAck[] = [];
    frames.push({ socket, acks });
    socket.on("message", (raw) => {
      const ack = parseFrameAck(JSON.parse(raw.toString()));
      if (ack !== null) acks.push(ack);
    });
  });
  server.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url!, "http://localhost");
    const frame = url.pathname === REMOTE_FRAME_WS_PATH;
    if (!frame && url.pathname !== REMOTE_WS_PATH) {
      socket.destroy();
      return;
    }
    if (request.headers.authorization !== `Bearer ${TOKEN}` ||
      (frame && (url.searchParams.get(REMOTE_FRAME_KEY_PARAM) !== key || access.frameStatus === 401))) {
      socket.end("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      return;
    }
    const target = frame ? frameServer : reliableServer;
    const accept = () => target.handleUpgrade(request, socket, head, (ws) => target.emit("connection", ws));
    if (frame && opts.holdFrames) upgrades.push(accept);
    else accept();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing listener address");
  wireCleanup.push(async () => {
    for (const ws of reliableServer.clients) ws.terminate();
    for (const ws of frameServer.clients) ws.terminate();
    for (const socket of sockets) socket.destroy();
    await Promise.all([
      new Promise<void>((resolve) => reliableServer.close(() => resolve())),
      new Promise<void>((resolve) => frameServer.close(() => resolve())),
      new Promise<void>((resolve) => server.close(() => resolve())),
    ]);
  });
  return { base: `http://127.0.0.1:${address.port}`, key, controls, frames, upgrades, access };
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

describe("paired instance frame stream", () => {
  it("waits for the authenticated companion before becoming ready", async () => {
    const wire = await wireServer({ holdFrames: true });
    let ready = false;
    const connecting = join(wire.base).then((client) => {
      ready = true;
      return client;
    });
    await vi.waitFor(() => expect(wire.upgrades).toHaveLength(1));
    expect(ready).toBe(false);
    wire.upgrades[0]!();
    const client = await connecting;
    await expect(client.request(CH.getState, [])).resolves.toEqual({ ok: 1 });
  });

  it("bounds an absent pairing handshake instead of falling back to the reliable stream", async () => {
    const wire = await wireServer({ announce: false });
    const failure = await failureOf(connectInstanceClient(wire.base, TOKEN, { timeoutMs: 100 }));
    expect(failure.kind).toBe("unreachable");
    await vi.waitFor(() => expect(wire.controls[0]?.readyState).toBe(WebSocket.CLOSED));
    expect(wire.frames).toHaveLength(0);
  });

  it("reports an unauthorized companion during the initial pairing", async () => {
    const wire = await wireServer();
    wire.access.frameStatus = 401;
    expect(await failureOf(connectInstanceClient(wire.base, TOKEN))).toEqual({ kind: "unauthorized" });
    await vi.waitFor(() => expect(wire.controls[0]?.readyState).toBe(WebSocket.CLOSED));
  });

  it("waits for every local consumer while PTY and requests stay reliable", async () => {
    const wire = await wireServer();
    const client = await join(wire.base);
    let resolveFirst!: () => void;
    let rejectSecond!: (reason: Error) => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const second = new Promise<void>((_resolve, reject) => { rejectSecond = reject; });
    let received = 0;
    client.onEvent((channel) => {
      if (channel !== CH.onBrowserPaneFrame) return;
      received++;
      return first;
    });
    client.onEvent((channel) => channel === CH.onBrowserPaneFrame ? second : undefined);
    const frame = wire.frames[0]!;
    frame.socket.send(encodeFrameDelivery(17, CH.onBrowserPaneFrame, "tab-1", new Uint8Array([4])));
    await vi.waitFor(() => expect(received).toBe(1));
    expect(frame.acks).toEqual([]);
    const pty = nextEvent(client);
    wire.controls[0]!.send(encodeBinaryEvent(CH.onPtyData, "tab-1", new Uint8Array([9])));
    expect((await pty).channel).toBe(CH.onPtyData);
    await expect(client.request(CH.getState, [])).resolves.toEqual({ ok: 1 });
    resolveFirst();
    await client.request(CH.getState, []);
    expect(frame.acks).toEqual([]);
    rejectSecond(new Error("receiver disposed"));
    await vi.waitFor(() => expect(frame.acks).toEqual([{ t: "ack", id: 17 }]));
    client.onEvent(() => { throw new Error("failed consumer"); });
    frame.socket.send(encodeFrameDelivery(18, CH.onBrowserPaneFrame, "tab-1", new Uint8Array([5])));
    await vi.waitFor(() => expect(frame.acks).toEqual([{ t: "ack", id: 17 }, { t: "ack", id: 18 }]));
  });

  it("reconnects only frames and never ACKs an old delivery on its replacement", async () => {
    const wire = await wireServer();
    const client = await join(wire.base);
    let releaseHeld!: () => void;
    const held = new Promise<void>((resolve) => { releaseHeld = resolve; });
    let received = 0;
    const closed = vi.fn();
    client.onClose(closed);
    client.onEvent((channel) => {
      if (channel === CH.onBrowserPaneFrame) {
        received++;
        return received === 1 ? held : undefined;
      }
    });
    const old = wire.frames[0]!;
    old.socket.send(encodeFrameDelivery(21, CH.onBrowserPaneFrame, "tab-1", new Uint8Array([1])));
    await vi.waitFor(() => expect(received).toBe(1));
    old.socket.terminate();
    await expect(client.request(CH.getState, [])).resolves.toEqual({ ok: 1 });
    await vi.waitFor(() => expect(wire.frames).toHaveLength(2));
    releaseHeld();
    const next = wire.frames[1]!;
    next.socket.send(encodeFrameDelivery(22, CH.onBrowserPaneFrame, "tab-1", new Uint8Array([2])));
    await vi.waitFor(() => expect(next.acks).toEqual([{ t: "ack", id: 22 }]));
    expect(old.acks).toEqual([]);
    expect(wire.controls).toHaveLength(1);
    expect(closed).not.toHaveBeenCalled();
    client.close();
    await vi.waitFor(() => expect(next.socket.readyState).toBe(WebSocket.CLOSED));
    expect(closed).toHaveBeenCalledTimes(1);
  });

  it("surfaces revocation on frame reconnect rather than retrying forever", async () => {
    const wire = await wireServer();
    const client = await join(wire.base);
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
    wire.access.frameStatus = 401;
    wire.frames[0]!.socket.terminate();
    expect(await closed).toBe(REMOTE_CLOSE_REVOKED);
    await expect(client.request(CH.getState, [])).rejects.toThrow("remote connection lost");
    expect(wire.frames).toHaveLength(1);
  });

  it("cancels frame reconnect when the reliable connection closes", async () => {
    const wire = await wireServer();
    const client = await join(wire.base);
    vi.useFakeTimers();
    try {
      const closed = new Promise<void>((resolve) => client.onClose(() => resolve()));
      wire.frames[0]!.socket.terminate();
      client.close();
      await closed;
      await vi.advanceTimersByTimeAsync(10_000);
      expect(wire.frames).toHaveLength(1);
      expect(wire.controls[0]?.readyState).toBe(WebSocket.CLOSED);
    } finally {
      vi.useRealTimers();
    }
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
