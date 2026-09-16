import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH } from "@omp-ui/core/backend-channels";
import { encodeBrowserPaneFrameHeader } from "@omp-ui/core/browser-pane";
import {
  encodeBinaryEvent,
  encodeFrameDelivery,
  makeServerFrameStream,
  makeServerResponseOk,
  REMOTE_CLOSE_REVOKED,
  REMOTE_FRAME_KEY_PARAM,
  REMOTE_FRAME_WS_PATH,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
} from "@omp-ui/server/protocol";
import { createFramePainter } from "../renderer/src/lib/browser-pane-frame";
import { connectRemoteBackend } from "./remote-backend";

const KEY = "b".repeat(64);

class Socket extends EventTarget {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: Socket[] = [];
  readyState = Socket.CONNECTING;
  binaryType = "blob";
  readonly sent: unknown[] = [];

  constructor(readonly url: string) {
    super();
    Socket.instances.push(this);
  }

  open(): void {
    this.readyState = Socket.OPEN;
    this.dispatchEvent(new Event("open"));
  }

  message(data: string | ArrayBufferLike): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  send(data: string): void {
    if (this.readyState !== Socket.OPEN) throw new Error("late send on closed socket");
    this.sent.push(JSON.parse(data));
  }

  end(code = 1006): void {
    if (this.readyState === Socket.CLOSED) return;
    this.readyState = Socket.CLOSED;
    this.dispatchEvent(Object.assign(new Event("close"), { code }));
  }

  close(): void {
    this.end(1000);
  }
}

beforeEach(() => {
  vi.useFakeTimers();
  Socket.instances = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.stubGlobal("location", new URL("https://remote.test/?t=cold%20token"));
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout });
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 200 }));
});

afterEach(() => {
  for (const socket of Socket.instances) socket.close();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function join() {
  const connecting = connectRemoteBackend();
  const reliable = Socket.instances[0]!;
  reliable.open();
  reliable.message(JSON.stringify(makeServerFrameStream(KEY)));
  const frames = Socket.instances[1]!;
  frames.open();
  const connection = await connecting;
  return { ...connection, reliable, frames };
}

function delivery(id: number, marker = id): Uint8Array {
  const frame = new Uint8Array(9);
  frame.set(encodeBrowserPaneFrameHeader({ width: 1280, height: 800, dsf: 1 }));
  frame[8] = marker;
  return encodeFrameDelivery(id, CH.onBrowserPaneFrame, "tab-1", frame);
}

describe("remote backend paired readiness", () => {
  it("waits for both streams and authenticates the companion with the same credential", async () => {
    let ready = false;
    const connecting = connectRemoteBackend().then((connection) => {
      ready = true;
      return connection;
    });
    const reliable = Socket.instances[0]!;
    reliable.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    reliable.message(JSON.stringify(makeServerFrameStream(KEY)));
    const frames = Socket.instances[1]!;
    await vi.advanceTimersByTimeAsync(0);
    expect(ready).toBe(false);
    const reliableUrl = new URL(reliable.url);
    const frameUrl = new URL(frames.url);
    expect(reliableUrl.pathname).toBe(REMOTE_WS_PATH);
    expect(frameUrl.pathname).toBe(REMOTE_FRAME_WS_PATH);
    expect(frameUrl.searchParams.get(REMOTE_TOKEN_PARAM)).toBe("cold token");
    expect(frameUrl.searchParams.get(REMOTE_FRAME_KEY_PARAM)).toBe(KEY);
    frames.open();
    await connecting;
    expect(ready).toBe(true);
  });

  it("fails a missing handshake within ten seconds and closes the reliable stream", async () => {
    const connecting = connectRemoteBackend();
    const failure = expect(connecting).rejects.toThrow("could not reach omp-ui");
    const reliable = Socket.instances[0]!;
    reliable.open();
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    expect(reliable.readyState).toBe(Socket.CLOSED);
    expect(Socket.instances).toHaveLength(1);
  });

  it("bounds an unopened companion and ignores its late open", async () => {
    const connecting = connectRemoteBackend();
    const failure = expect(connecting).rejects.toThrow("could not reach omp-ui");
    const reliable = Socket.instances[0]!;
    reliable.open();
    reliable.message(JSON.stringify(makeServerFrameStream(KEY)));
    const frames = Socket.instances[1]!;
    await vi.advanceTimersByTimeAsync(10_000);
    await failure;
    frames.open();
    expect(frames.readyState).toBe(Socket.CLOSED);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Socket.instances).toHaveLength(2);
  });
});

describe("remote backend receiver ACK", () => {
  it("withholds ACK until the real painter draws without delaying PTY or replies", async () => {
    const { backend, reliable, frames } = await join();
    const decode = Promise.withResolvers<ImageBitmap>();
    const drawImage = vi.fn();
    const bitmap = { close: vi.fn() } as unknown as ImageBitmap;
    const canvas = { width: 0, height: 0, getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    const painter = createFramePainter(canvas, () => {}, () => decode.promise);
    backend.onBrowserPaneFrame((_tabId, bytes) => painter.write(bytes));
    frames.message(delivery(11).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([]);
    const pty = vi.fn();
    backend.onPtyData(pty);
    reliable.message(encodeBinaryEvent(CH.onPtyData, "tab-1", new Uint8Array([7])).buffer);
    expect(pty).toHaveBeenCalledWith("tab-1", new Uint8Array([7]));
    const state = backend.getState();
    reliable.message(JSON.stringify(makeServerResponseOk(1, { projects: [] })));
    await expect(state).resolves.toEqual({ projects: [] });
    expect(frames.sent).toEqual([]);
    decode.resolve(bitmap);
    await vi.advanceTimersByTimeAsync(0);
    expect(drawImage).toHaveBeenCalledWith(bitmap, 0, 0);
    expect(frames.sent).toEqual([{ t: "ack", id: 11 }]);
  });

  it("ACKs intentional drops and waits for every listener despite another throwing", async () => {
    const { backend, frames } = await join();
    frames.message(delivery(1).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([{ t: "ack", id: 1 }]);
    const held = Promise.withResolvers<void>();
    backend.onBrowserPaneFrame(() => { throw new Error("disposed consumer"); });
    backend.onBrowserPaneFrame(() => held.promise);
    frames.message(delivery(2).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([{ t: "ack", id: 1 }]);
    held.reject(new Error("decode failed"));
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([{ t: "ack", id: 1 }, { t: "ack", id: 2 }]);
  });

  it("ACKs painter disposal immediately, even if its decoder never resolves", async () => {
    const { backend, frames } = await join();
    const decode = Promise.withResolvers<ImageBitmap>();
    const drawImage = vi.fn();
    const canvas = { getContext: () => ({ drawImage }) } as unknown as HTMLCanvasElement;
    const painter = createFramePainter(canvas, () => {}, () => decode.promise);
    backend.onBrowserPaneFrame((_tabId, bytes) => painter.write(bytes));
    frames.message(delivery(3).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([]);
    painter.dispose();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([{ t: "ack", id: 3 }]);
    expect(drawImage).not.toHaveBeenCalled();
  });
});

describe("independent browser frame reconnect", () => {
  it("replaces only the frame socket and never sends a late ACK on either socket", async () => {
    const { backend, reliable, frames, onStatus } = await join();
    const status = vi.fn();
    onStatus(status);
    const held = Promise.withResolvers<void>();
    backend.onBrowserPaneFrame(() => held.promise);
    frames.message(delivery(21).buffer);
    frames.end();
    backend.ptyWrite("tab-1", "ls\n");
    expect(reliable.sent).toContainEqual({ t: "notify", ch: CH.ptyWrite, args: ["tab-1", "ls\n"] });
    await vi.advanceTimersByTimeAsync(500);
    const replacement = Socket.instances[2]!;
    replacement.open();
    held.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(frames.sent).toEqual([]);
    expect(replacement.sent).toEqual([]);
    replacement.message(delivery(22).buffer);
    await vi.advanceTimersByTimeAsync(0);
    expect(replacement.sent).toEqual([{ t: "ack", id: 22 }]);
    expect(status).not.toHaveBeenCalled();
    expect(reliable.readyState).toBe(Socket.OPEN);
    reliable.end();
    expect(replacement.readyState).toBe(Socket.CLOSED);
    expect(status.mock.calls).toEqual([[false]]);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(Socket.instances).toHaveLength(3);
  });

  it("caps reconnect backoff while a transient frame failure leaves reliable calls usable", async () => {
    const { backend, reliable, frames } = await join();
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));
    let latest = frames;
    for (const [index, delay] of [500, 1_000, 2_000, 4_000, 5_000, 5_000].entries()) {
      latest.dispatchEvent(new Event("error"));
      latest.end();
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(Socket.instances).toHaveLength(index + 2);
      await vi.advanceTimersByTimeAsync(1);
      expect(Socket.instances).toHaveLength(index + 3);
      latest = Socket.instances.at(-1)!;
      expect(reliable.readyState).toBe(Socket.OPEN);
    }
    const state = backend.getState();
    reliable.message(JSON.stringify(makeServerResponseOk(1, { projects: [] })));
    await expect(state).resolves.toEqual({ projects: [] });
    reliable.end();
    expect(latest.readyState).toBe(Socket.CLOSED);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Socket.instances).toHaveLength(8);
  });

  it("uses the authenticated health probe to stop a revoked frame upgrade", async () => {
    const { backend, reliable, frames, onStatus } = await join();
    const status = vi.fn();
    onStatus(status);
    vi.mocked(fetch).mockResolvedValue({ status: 401 } as Response);
    const pending = backend.getState();
    const rejected = expect(pending).rejects.toThrow("remote connection lost");
    frames.dispatchEvent(new Event("error"));
    frames.end();
    await vi.advanceTimersByTimeAsync(0);
    await rejected;
    const [url, options] = vi.mocked(fetch).mock.calls[0]!;
    expect(String(url)).toBe("https://remote.test/healthz?t=cold+token");
    expect(options).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(reliable.readyState).toBe(Socket.CLOSED);
    expect(status.mock.calls).toEqual([[false]]);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Socket.instances).toHaveLength(2);
  });

  it("keeps one slow credential probe across failed reconnects so revocation can finish", async () => {
    const { reliable, frames } = await join();
    const health = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValue(health.promise);
    frames.dispatchEvent(new Event("error"));
    frames.end();
    await vi.advanceTimersByTimeAsync(500);
    const replacement = Socket.instances[2]!;
    replacement.dispatchEvent(new Event("error"));
    replacement.end();
    expect(fetch).toHaveBeenCalledTimes(1);
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    expect(signal.aborted).toBe(false);
    health.resolve({ status: 401 } as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(reliable.readyState).toBe(Socket.CLOSED);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(Socket.instances).toHaveLength(3);
  });

  it("ignores stale probe results after successful pairing and handles explicit revocation", async () => {
    const { reliable, frames, onStatus } = await join();
    const status = vi.fn();
    onStatus(status);
    const health = Promise.withResolvers<Response>();
    vi.mocked(fetch).mockReturnValue(health.promise);
    frames.dispatchEvent(new Event("error"));
    frames.end();
    const signal = vi.mocked(fetch).mock.calls[0]![1]!.signal!;
    await vi.advanceTimersByTimeAsync(500);
    const replacement = Socket.instances[2]!;
    replacement.open();
    expect(signal.aborted).toBe(true);
    health.resolve({ status: 401 } as Response);
    await vi.advanceTimersByTimeAsync(0);
    expect(reliable.readyState).toBe(Socket.OPEN);
    replacement.end(REMOTE_CLOSE_REVOKED);
    expect(reliable.readyState).toBe(Socket.CLOSED);
    expect(status.mock.calls).toEqual([[false]]);
  });

  it("tears down pending reconnects and suppresses ACKs after reliable close", async () => {
    const { backend, reliable, frames } = await join();
    const held = Promise.withResolvers<void>();
    backend.onBrowserPaneFrame(() => held.promise);
    frames.message(delivery(31).buffer);
    frames.end();
    reliable.end();
    held.resolve();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(frames.sent).toEqual([]);
    expect(Socket.instances).toHaveLength(2);
  });
});
