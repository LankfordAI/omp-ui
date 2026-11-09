import { getEventListeners, once } from "node:events";
import * as http2 from "node:http2";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { decodeImage, encodeKeyInput, encodeTouchInput, GrpcMessageParser, grpcFrame } from "@omp-ui/core";
import { EmulatorGrpcClient, GrpcStatusError } from "./emulator-grpc";

type ServerHandler = (stream: http2.ServerHttp2Stream, headers: http2.IncomingHttpHeaders) => void;

const cleanup: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function loopback(handler: ServerHandler): Promise<EmulatorGrpcClient> {
  const server = http2.createServer();
  const sessions = new Set<http2.ServerHttp2Session>();
  server.on("session", (session) => {
    sessions.add(session);
    session.on("error", () => {});
    session.once("close", () => sessions.delete(session));
    session.on("stream", (stream, headers) => {
      stream.on("error", () => {});
      stream.resume();
      handler(stream, headers);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const client = new EmulatorGrpcClient({ port: (server.address() as AddressInfo).port, token: null });
  cleanup.push(async () => {
    client.close();
    for (const session of sessions) session.destroy();
    const closed = Promise.withResolvers<void>();
    server.close((err) => err ? closed.reject(err) : closed.resolve());
    await closed.promise;
  });
  return client;
}

function reply(stream: http2.ServerHttp2Stream, status = 0, payload?: Uint8Array, message = ""): void {
  stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
  stream.once("wantTrailers", () => {
    stream.sendTrailers({ "grpc-status": String(status), "grpc-message": encodeURIComponent(message) });
  });
  stream.end(payload === undefined ? undefined : grpcFrame(payload));
}

function deferGrpcConnection(): () => void {
  const ready = Promise.withResolvers<void>();
  const transport = EmulatorGrpcClient.prototype as unknown as {
    connectTo(host: string): Promise<http2.ClientHttp2Session>;
  };
  const connect = transport.connectTo;
  vi.spyOn(transport, "connectTo").mockImplementation(function (this: EmulatorGrpcClient, host) {
    return connect.call(this, host).then(async (session) => {
      await ready.promise;
      return session;
    });
  });
  cleanup.push(async () => ready.resolve());
  return ready.resolve;
}

// Read the actual InputEvent protobuf subset used by the touch/keyboard consumer.
function inputFields(bytes: Uint8Array): Map<number, number | Uint8Array> {
  const fields = new Map<number, number | Uint8Array>();
  let offset = 0;
  const uint = () => {
    let value = 0;
    for (let shift = 0; offset < bytes.length; shift += 7) {
      const byte = bytes[offset++];
      value |= (byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return value;
    }
    throw new Error("truncated input varint");
  };
  while (offset < bytes.length) {
    const tag = uint();
    if ((tag & 7) === 0) fields.set(tag >>> 3, uint());
    else if ((tag & 7) === 2) {
      const length = uint();
      fields.set(tag >>> 3, bytes.subarray(offset, offset + length));
      offset += length;
    } else throw new Error(`unexpected input wire type ${tag & 7}`);
  }
  return fields;
}

type ConsumedInput =
  | { kind: "touch"; id: number; x: number; y: number; pressure: number; display: number }
  | { kind: "key"; key: string; eventType: number };

interface InputConsumer {
  events: ConsumedInput[];
  pointers: Map<number, { x: number; y: number; display: number }>;
  keys: Set<string>;
  ended: Promise<void>;
}

function consumeInput(stream: http2.ServerHttp2Stream): InputConsumer {
  const events: ConsumedInput[] = [];
  const pointers = new Map<number, { x: number; y: number; display: number }>();
  const keys = new Set<string>();
  const ended = Promise.withResolvers<void>();
  const parser = new GrpcMessageParser(1024, (raw) => {
    const input = inputFields(raw);
    const touch = input.get(2);
    if (touch instanceof Uint8Array) {
      const touchEvent = inputFields(touch);
      const bytes = touchEvent.get(1);
      if (!(bytes instanceof Uint8Array)) throw new Error("missing touch");
      const point = inputFields(bytes);
      const id = Number(point.get(3) ?? 0);
      const x = Number(point.get(1) ?? 0);
      const y = Number(point.get(2) ?? 0);
      const pressure = Number(point.get(4) ?? 0);
      const display = Number(touchEvent.get(2) ?? 0);
      if (pressure === 0) pointers.delete(id);
      else pointers.set(id, { x, y, display });
      events.push({ kind: "touch", id, x, y, pressure, display });
    } else {
      const bytes = input.get(1);
      if (!(bytes instanceof Uint8Array)) throw new Error("missing keyboard event");
      const keyboard = inputFields(bytes);
      const bytesKey = keyboard.get(4);
      if (!(bytesKey instanceof Uint8Array)) throw new Error("missing keyboard key");
      const key = new TextDecoder().decode(bytesKey);
      const eventType = Number(keyboard.get(2) ?? 0);
      if (eventType === 0) keys.add(key);
      else if (eventType === 1) keys.delete(key);
      events.push({ kind: "key", key, eventType });
    }
  });
  stream.on("data", (chunk: Buffer) => parser.push(chunk));
  stream.once("end", () => {
    parser.end();
    reply(stream);
    ended.resolve();
  });
  return { events, pointers, keys, ended: ended.promise };
}

const optionalCalls: Array<[string, number, (client: EmulatorGrpcClient) => Promise<unknown>]> = [
  ["getPhysicalModel", 12, (client) => client.getPhysicalModel(10)],
  ["setPhysicalModel", 12, (client) => client.setPhysicalModel(10, [90])],
  ["getDisplayConfigurations", 9, (client) => client.getDisplayConfigurations()],
  ["streamNotification", 12, (client) => client.streamNotification(() => {}, new AbortController().signal)],
];

describe("EmulatorGrpcClient loopback HTTP/2", () => {
  it("drops stale queued touch and keyboard input while keeping releases and current input ordered on one stream", async () => {
    const connect = deferGrpcConnection();
    const opened = Promise.withResolvers<InputConsumer>();
    let inputStreams = 0;
    const client = await loopback((stream, headers) => {
      if (String(headers[":path"]).endsWith("/streamInputEvent")) {
        inputStreams++;
        opened.resolve(consumeInput(stream));
      } else reply(stream);
    });
    const transport = client as unknown as {
      request(rpc: string, session: http2.ClientHttp2Session): http2.ClientHttp2Stream;
    };
    const request = transport.request.bind(transport);
    const listenerEvents = ["response", "trailers", "data", "error", "close"] as const;
    const nativeRequests: Array<{ stream: http2.ClientHttp2Stream; counts: number[] }> = [];
    vi.spyOn(transport, "request").mockImplementation((method, session) => {
      const stream = request(method, session);
      if (method === "streamInputEvent") {
        nativeRequests.push({ stream, counts: listenerEvents.map((event) => stream.listenerCount(event)) });
      }
      return stream;
    });
    const lost = vi.fn();
    client.onError(lost);
    const input = client.openInput();
    let epoch = 0;
    const stale = vi.fn(() => epoch === 0);
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 20, pressure: 1 }], 6), stale);
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 15, pressure: 1 }], 6), stale);
    input.send(encodeKeyInput({ eventType: 0, key: "Shift" }), stale);
    epoch = 1;
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 20, pressure: 0 }], 6));
    input.send(encodeKeyInput({ eventType: 1, key: "Shift" }));
    const current = vi.fn(() => epoch === 1);
    input.send(encodeTouchInput([{ id: 1, x: 40, y: 50, pressure: 1 }], 6), current);
    input.send(encodeKeyInput({ eventType: 0, key: "Enter" }), current);
    expect(stale).not.toHaveBeenCalled();
    expect(current).not.toHaveBeenCalled();
    connect();
    const consumer = await opened.promise;
    const native = nativeRequests[0];
    const closed = once(native.stream, "close");
    input.send(encodeTouchInput([{ id: 1, x: 40, y: 50, pressure: 0 }], 6));
    input.send(encodeKeyInput({ eventType: 1, key: "Enter" }));
    input.close();
    await consumer.ended;
    await closed;
    expect(consumer.events).toEqual([
      { kind: "touch", id: 0, x: 10, y: 20, pressure: 0, display: 6 },
      { kind: "key", key: "Shift", eventType: 1 },
      { kind: "touch", id: 1, x: 40, y: 50, pressure: 1, display: 6 },
      { kind: "key", key: "Enter", eventType: 0 },
      { kind: "touch", id: 1, x: 40, y: 50, pressure: 0, display: 6 },
      { kind: "key", key: "Enter", eventType: 1 },
    ]);
    expect(consumer.pointers.size).toBe(0);
    expect(consumer.keys.size).toBe(0);
    expect(stale).toHaveBeenCalledTimes(3);
    expect(current).toHaveBeenCalledTimes(2);
    expect(inputStreams).toBe(1);
    expect(nativeRequests).toHaveLength(1);
    expect(native.stream.rstCode).toBe(http2.constants.NGHTTP2_NO_ERROR);
    listenerEvents.forEach((event, index) => {
      expect(native.stream.listenerCount(event)).toBeLessThanOrEqual(native.counts[index]);
    });
    await expect(client.setVmState(1)).resolves.toBeUndefined();
    expect(lost).not.toHaveBeenCalled();
  });

  it("checks opened-stream guards once per event without dropping forced releases or reopening the stream", async () => {
    const opened = Promise.withResolvers<InputConsumer>();
    let inputStreams = 0;
    const client = await loopback((stream, headers) => {
      if (String(headers[":path"]).endsWith("/streamInputEvent")) {
        inputStreams++;
        opened.resolve(consumeInput(stream));
      } else reply(stream);
    });
    const lost = vi.fn();
    client.onError(lost);
    const input = client.openInput();
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 20, pressure: 1 }]));
    const consumer = await opened.promise;
    let epoch = 0;
    const current = vi.fn(() => epoch === 0);
    input.send(encodeKeyInput({ eventType: 0, key: "A" }), current);
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 15, pressure: 1 }]), current);
    epoch = 1;
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 5, pressure: 1 }]), current);
    input.send(encodeKeyInput({ eventType: 0, key: "B" }), current);
    input.send(encodeKeyInput({ eventType: 1, key: "A" }));
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 15, pressure: 0 }]));
    const next = vi.fn(() => epoch === 1);
    input.send(encodeKeyInput({ eventType: 0, key: "C" }), next);
    input.send(encodeKeyInput({ eventType: 1, key: "C" }));
    input.close();
    await consumer.ended;
    expect(consumer.events).toEqual([
      { kind: "touch", id: 0, x: 10, y: 20, pressure: 1, display: 0 },
      { kind: "key", key: "A", eventType: 0 },
      { kind: "touch", id: 0, x: 10, y: 15, pressure: 1, display: 0 },
      { kind: "key", key: "A", eventType: 1 },
      { kind: "touch", id: 0, x: 10, y: 15, pressure: 0, display: 0 },
      { kind: "key", key: "C", eventType: 0 },
      { kind: "key", key: "C", eventType: 1 },
    ]);
    expect(consumer.pointers.size).toBe(0);
    expect(consumer.keys.size).toBe(0);
    expect(current).toHaveBeenCalledTimes(4);
    expect(next).toHaveBeenCalledTimes(1);
    expect(inputStreams).toBe(1);
    await expect(client.setVmState(1)).resolves.toBeUndefined();
    expect(lost).not.toHaveBeenCalled();
  });

  it("keeps pending input bounded to 256 events and evaluates only admitted events when opening", async () => {
    const connect = deferGrpcConnection();
    const opened = Promise.withResolvers<InputConsumer>();
    const client = await loopback((stream) => opened.resolve(consumeInput(stream)));
    const input = client.openInput();
    const current = vi.fn(() => true);
    for (let x = 0; x < 300; x++) {
      input.send(encodeTouchInput([{ id: 0, x, y: 20, pressure: 1 }]), current);
    }
    expect(current).not.toHaveBeenCalled();
    connect();
    const consumer = await opened.promise;
    input.send(encodeTouchInput([{ id: 0, x: 255, y: 20, pressure: 0 }]));
    input.close();
    await consumer.ended;
    expect(current).toHaveBeenCalledTimes(256);
    expect(consumer.events).toHaveLength(257);
    expect(consumer.events.flatMap((event) => event.kind === "touch" && event.pressure > 0 ? [event.x] : []))
      .toEqual(Array.from({ length: 256 }, (_, x) => x));
    expect(consumer.events.at(-1)).toEqual({ kind: "touch", id: 0, x: 255, y: 20, pressure: 0, display: 0 });
    expect(consumer.pointers.size).toBe(0);
  });

  it("clears closed pending input without creating a late request, evaluating guards or draining queued events", async () => {
    const connect = deferGrpcConnection();
    const received: string[] = [];
    const client = await loopback((stream, headers) => {
      received.push(String(headers[":path"]).split("/").at(-1) ?? "");
      reply(stream);
    });
    const lost = vi.fn();
    client.onError(lost);
    const input = client.openInput();
    const current = vi.fn(() => true);
    input.send(encodeTouchInput([{ id: 0, x: 10, y: 20, pressure: 1 }]), current);
    input.send(encodeKeyInput({ eventType: 0, key: "Shift" }), current);
    input.close();
    input.close();
    input.send(encodeKeyInput({ eventType: 0, key: "Enter" }), current);
    connect();
    await expect(client.setVmState(1)).resolves.toBeUndefined();
    expect(received).toEqual(["setVmState"]);
    expect(current).not.toHaveBeenCalled();
    expect(lost).not.toHaveBeenCalled();
  });

  it.each(optionalCalls)("keeps the connection usable after optional %s status %s", async (rpc, status, invoke) => {
    const screenshot = Uint8Array.from([10, 4, 24, 1, 32, 1, 34, 4, 1, 2, 3, 4]);
    const client = await loopback((stream, headers) => {
      if (String(headers[":path"]).endsWith(`/${rpc}`)) reply(stream, status, undefined, "optional feature unavailable");
      else reply(stream, 0, screenshot);
    });
    const lost = vi.fn();
    client.onError(lost);
    const failure = await invoke(client).catch((err: unknown) => err);
    expect(failure).toBeInstanceOf(GrpcStatusError);
    expect(failure).toMatchObject({ status, message: `${rpc}: grpc-status ${status} (optional feature unavailable)` });
    const image = decodeImage(await client.getScreenshot({ width: 1, height: 1 }));
    expect(image).toMatchObject({ width: 1, height: 1 });
    expect(Array.from(image!.pixels)).toEqual([1, 2, 3, 4]);
    expect(lost).not.toHaveBeenCalled();
  });

  it("decodes physical, display and streamed notification replies rather than request echoes", async () => {
    const client = await loopback((stream, headers) => {
      const rpc = String(headers[":path"]).split("/").at(-1);
      if (rpc === "getPhysicalModel") {
        reply(stream, 0, Uint8Array.from([8, 10, 26, 6, 10, 4, 0, 0, 180, 66]));
      } else if (rpc === "getDisplayConfigurations") {
        reply(stream, 0, Uint8Array.from([10, 9, 8, 160, 17, 16, 176, 14, 24, 164, 3]));
      } else if (rpc === "streamNotification") {
        stream.respond({ ":status": 200, "content-type": "application/grpc" });
        stream.write(grpcFrame(Uint8Array.from([34, 2, 24, 2])));
        stream.write(grpcFrame(Uint8Array.from([90, 4, 8, 6, 16, 2])));
      } else reply(stream);
    });
    await expect(client.getPhysicalModel(10)).resolves.toEqual({ target: 10, status: 0, values: [90] });
    await expect(client.setPhysicalModel(10, [90])).resolves.toBeUndefined();
    await expect(client.getDisplayConfigurations()).resolves.toEqual([
      { display: 0, width: 2208, height: 1840, dpi: 420, flags: 0 },
    ]);
    const controller = new AbortController();
    const received: unknown[] = [];
    const complete = Promise.withResolvers<void>();
    const notifications = client.streamNotification((notification) => {
      received.push(notification);
      if (received.length === 2) complete.resolve();
    }, controller.signal);
    await complete.promise;
    controller.abort();
    await notifications;
    expect(received).toEqual([
      { type: "posture", posture: 2 },
      { type: "display-power", display: 6, powerMode: 2 },
    ]);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("reports connection loss separately from an optional RPC failure", async () => {
    const seen = Promise.withResolvers<http2.ServerHttp2Stream>();
    const client = await loopback((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      seen.resolve(stream);
    });
    const lost = Promise.withResolvers<Error>();
    client.onError(lost.resolve);
    const screenshot = client.getScreenshot({ width: 1, height: 1 });
    const rejected = expect(screenshot).rejects.not.toBeInstanceOf(GrpcStatusError);
    const stream = await seen.promise;
    stream.session?.destroy();
    await rejected;
    await expect(lost.promise).resolves.toBeInstanceOf(Error);
  });

  it.each([
    ["getScreenshot", 5_000, (client: EmulatorGrpcClient) => client.getScreenshot({ width: 1, height: 1 })],
    ["getPhysicalModel", 10_000, (client: EmulatorGrpcClient) => client.getPhysicalModel(10)],
    ["setPhysicalModel", 10_000, (client: EmulatorGrpcClient) => client.setPhysicalModel(10, [90])],
    ["getDisplayConfigurations", 10_000, (client: EmulatorGrpcClient) => client.getDisplayConfigurations()],
    ["setClipboard", 10_000, (client: EmulatorGrpcClient) => client.setClipboard("text")],
    ["setVmState", 10_000, (client: EmulatorGrpcClient) => client.setVmState(1)],
  ] as const)("enforces the %s deadline at %s ms and closes its HTTP/2 request", async (rpc, timeout, invoke) => {
    const seen = Promise.withResolvers<http2.ServerHttp2Stream>();
    const closed = Promise.withResolvers<void>();
    const client = await loopback((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      stream.once("close", closed.resolve);
      seen.resolve(stream);
    });
    const lost = vi.fn();
    client.onError(lost);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let settled = false;
    const result = invoke(client);
    void result.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(result).rejects.toThrow(`${rpc}: timed out after ${timeout} ms`);
    await seen.promise;
    await vi.advanceTimersByTimeAsync(timeout - 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await rejection;
    await closed.promise;
    expect(lost).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["streamScreenshot", "streamNotification"] as const)("releases %s requests and abort listeners on repeated cancellation", async (rpc) => {
    const opened: http2.ServerHttp2Stream[] = [];
    const closing: Promise<void>[] = [];
    let observed = Promise.withResolvers<void>();
    const client = await loopback((stream) => {
      opened.push(stream);
      const closed = Promise.withResolvers<void>();
      stream.once("close", closed.resolve);
      closing.push(closed.promise);
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      observed.resolve();
    });
    // Capture the real native requests before watch() attaches its listeners.
    const transport = client as unknown as {
      request(rpc: string, session: http2.ClientHttp2Session): http2.ClientHttp2Stream;
    };
    const request = transport.request.bind(transport);
    const events = ["response", "trailers", "data", "error", "close"] as const;
    const nativeRequests: Array<{ stream: http2.ClientHttp2Stream; counts: number[] }> = [];
    vi.spyOn(transport, "request").mockImplementation((method, session) => {
      const stream = request(method, session);
      nativeRequests.push({ stream, counts: events.map((event) => stream.listenerCount(event)) });
      return stream;
    });
    const lost = vi.fn();
    client.onError(lost);
    for (let i = 0; i < 3; i++) {
      const controller = new AbortController();
      const result = rpc === "streamScreenshot"
        ? client.streamScreenshot({ width: 1, height: 1 }, () => {}, controller.signal)
        : client.streamNotification(() => {}, controller.signal);
      await observed.promise;
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(1);
      controller.abort();
      await result;
      await closing[i];
      expect(opened[i].closed).toBe(true);
      expect(opened[i].rstCode).toBe(http2.constants.NGHTTP2_CANCEL);
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
      expect(nativeRequests[i].stream.destroyed).toBe(true);
      events.forEach((event, index) => {
        expect(nativeRequests[i].stream.listenerCount(event)).toBeLessThanOrEqual(nativeRequests[i].counts[index]);
      });
      observed = Promise.withResolvers<void>();
    }
    expect(lost).not.toHaveBeenCalled();
  });

  it("rejects an aborted unary call and removes the abort listener", async () => {
    const seen = Promise.withResolvers<void>();
    const closed = Promise.withResolvers<void>();
    const client = await loopback((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" });
      stream.once("close", closed.resolve);
      seen.resolve();
    });
    const controller = new AbortController();
    const request = client.getPhysicalModel(10, controller.signal);
    const rejection = expect(request).rejects.toThrow("getPhysicalModel: aborted");
    await seen.promise;
    controller.abort();
    await rejection;
    await closed.promise;
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("does not open requests or retain listeners for an already-aborted signal", async () => {
    const received = vi.fn();
    const client = await loopback((stream, headers) => {
      received(stream, headers);
      reply(stream);
    });
    const controller = new AbortController();
    controller.abort();
    await expect(client.streamNotification(() => {}, controller.signal)).resolves.toBeUndefined();
    await expect(client.getDisplayConfigurations(controller.signal)).rejects.toThrow("aborted");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await client.setVmState(1);
    expect(received).toHaveBeenCalledTimes(1);
  });

  it("cancels before the ready continuation without creating a late HTTP/2 request", async () => {
    const received: string[] = [];
    const client = await loopback((stream, headers) => {
      received.push(String(headers[":path"]).split("/").at(-1) ?? "");
      reply(stream);
    });
    const controller = new AbortController();
    const cancelled = client.getPhysicalModel(10, controller.signal);
    controller.abort();
    await expect(cancelled).rejects.toThrow("getPhysicalModel: aborted");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await client.setVmState(1);
    expect(received).toEqual(["setVmState"]);
  });

  it("cancels malformed decoded replies without retaining listeners or losing the connection", async () => {
    const client = await loopback((stream, headers) => {
      if (String(headers[":path"]).endsWith("/getPhysicalModel")) reply(stream, 0, Uint8Array.from([8, 128]));
      else reply(stream);
    });
    const lost = vi.fn();
    client.onError(lost);
    const controller = new AbortController();
    await expect(client.getPhysicalModel(10, controller.signal)).rejects.toThrow("truncated varint");
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
    await client.setVmState(1);
    expect(lost).not.toHaveBeenCalled();
  });

  it.each([
    ["compressed", Uint8Array.from([1, 0, 0, 0, 0])],
    ["exceeds", Uint8Array.from([0, 4, 0, 0, 1])],
    ["truncated", Uint8Array.from([0, 0, 0, 0, 2, 1])],
  ] as const)("rejects %s gRPC responses without leaking the unary abort listener", async (reason, bytes) => {
    const client = await loopback((stream) => {
      stream.respond({ ":status": 200, "content-type": "application/grpc" }, { waitForTrailers: true });
      stream.once("wantTrailers", () => stream.sendTrailers({ "grpc-status": "0" }));
      stream.end(bytes);
    });
    const controller = new AbortController();
    await expect(client.getScreenshot({ width: 1, height: 1 }, controller.signal)).rejects.toThrow(reason);
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });
});
