import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as http2 from "node:http2";
import * as net from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import * as path from "node:path";
import {
  DISCOVERY_FILE_PATTERN,
  GrpcMessageParser,
  androidChildEnv,
  emulatorDiscoveryDirs,
  encodeClipData,
  encodeImageFormat,
  encodeVmRunState,
  grpcFrame,
  parseDiscoveryIni,
  type AndroidSdkPaths,
} from "@omp-ui/core";

/**
 * The Android Emulator's gRPC control endpoint (issue #1006, ADR-0086), spoken
 * over plain node:http2 with core's hand-rolled protobuf subset: no grpc or
 * protobuf dependency. Endpoint discovery follows expo's serve-emu
 * (Apache-2.0): the running emulator's pid_<pid>.ini discovery file first,
 * then `adb emu grpc <port>` to enable the endpoint at runtime.
 */

export interface GrpcEndpoint {
  port: number;
  token: string | null;
}

/** One live emulator's discovery file. */
export interface EmulatorDiscoveryRecord {
  pid: number;
  mtimeMs: number;
  values: Map<string, string>;
}

const SERVICE_PATH = "/android.emulation.control.EmulatorController";
const MAX_MESSAGE_BYTES = 64 * 1024 * 1024;
const WINDOW_BYTES = 8 * 1024 * 1024;
const SCREENSHOT_TIMEOUT_MS = 5_000;
const UNARY_TIMEOUT_MS = 10_000;
const ENDPOINT_ATTEMPTS = 5;
const ENDPOINT_PROBES = 40;
const ENDPOINT_PROBE_MS = 50;
const PORT_PROBE_TIMEOUT_MS = 500;
const ADB_TIMEOUT_MS = 10_000;
const INPUT_QUEUE_MAX = 256;

/** `process.kill(pid, 0)`; EPERM means the process exists under another user. */
export function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Every live emulator discovery file in `dirs` (unreadable dirs and dead pids are skipped). */
export function readEmulatorDiscovery(
  dirs: string[] = emulatorDiscoveryDirs(),
  alive: (pid: number) => boolean = isPidAlive,
): EmulatorDiscoveryRecord[] {
  const records: EmulatorDiscoveryRecord[] = [];
  for (const dir of dirs) {
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      const m = DISCOVERY_FILE_PATTERN.exec(name);
      if (m === null) continue;
      const pid = Number(m[1]);
      if (!alive(pid)) continue;
      try {
        const file = path.join(dir, name);
        const mtimeMs = fs.statSync(file).mtimeMs;
        records.push({ pid, mtimeMs, values: parseDiscoveryIni(fs.readFileSync(file, "utf8")) });
      } catch {
        // Removed between readdir and read: the emulator just exited.
      }
    }
  }
  return records;
}

function newest(records: EmulatorDiscoveryRecord[]): EmulatorDiscoveryRecord | null {
  let best: EmulatorDiscoveryRecord | null = null;
  for (const r of records) if (best === null || r.mtimeMs > best.mtimeMs) best = r;
  return best;
}

/** The newest record whose port.serial is the serial's console port. */
export function discoveryForSerial(records: EmulatorDiscoveryRecord[], serial: string): EmulatorDiscoveryRecord | null {
  const port = /^emulator-(\d+)$/.exec(serial)?.[1];
  if (port === undefined) return null;
  return newest(records.filter((r) => r.values.get("port.serial") === port));
}

/** The newest record of a running AVD that already announced its console port. */
export function discoveryForAvd(records: EmulatorDiscoveryRecord[], avd: string): EmulatorDiscoveryRecord | null {
  return newest(records.filter((r) => r.values.get("avd.name") === avd && /^\d+$/.test(r.values.get("port.serial") ?? "")));
}

function endpointOf(record: EmulatorDiscoveryRecord | null): GrpcEndpoint | null {
  const raw = record?.values.get("grpc.port");
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const port = Number(raw);
  if (port <= 0 || port > 65_535) return null;
  const token = record?.values.get("grpc.token");
  return { port, token: token ? token : null };
}

function probePort(host: string, port: number): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const socket = net.connect({ host, port });
  const done = (ok: boolean) => {
    socket.destroy();
    resolve(ok);
  };
  socket.setTimeout(PORT_PROBE_TIMEOUT_MS, () => done(false));
  socket.once("connect", () => done(true));
  socket.once("error", () => done(false));
  return promise;
}

async function reachable(port: number): Promise<boolean> {
  return (await probePort("127.0.0.1", port)) || (await probePort("::1", port));
}

function freePort(): Promise<number> {
  const { promise, resolve, reject } = Promise.withResolvers<number>();
  const server = net.createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
  });
  return promise;
}

function runAdb(sdk: AndroidSdkPaths, args: string[]): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  execFile(
    sdk.adb,
    args,
    { env: androidChildEnv(sdk), timeout: ADB_TIMEOUT_MS, encoding: "utf8", maxBuffer: 1024 * 1024 },
    (error, stdout, stderr) => {
      const out = `${stdout ?? ""}${stderr ?? ""}`.trim();
      resolve(error === null ? out : out || error.message);
    },
  );
  return promise;
}

/** Discovery file first; if missing or unreachable, `adb -s S emu grpc <free port>`, then re-read (5 attempts × 40 probes × 50 ms, serve-emu's bounds). */
export async function ensureEmulatorGrpcEndpoint(
  serial: string,
  sdk: AndroidSdkPaths,
  signal: AbortSignal,
): Promise<GrpcEndpoint> {
  const discovered = () => endpointOf(discoveryForSerial(readEmulatorDiscovery(), serial));
  const first = discovered();
  if (first !== null && (await reachable(first.port))) return first;
  let lastOutput = "";
  for (let attempt = 0; attempt < ENDPOINT_ATTEMPTS; attempt++) {
    signal.throwIfAborted();
    const port = await freePort();
    lastOutput = await runAdb(sdk, ["-s", serial, "emu", "grpc", String(port)]);
    for (let probe = 0; probe < ENDPOINT_PROBES; probe++) {
      signal.throwIfAborted();
      const fromFile = discovered();
      if (fromFile !== null && (await reachable(fromFile.port))) return fromFile;
      if (await reachable(port)) return { port, token: fromFile?.token ?? null };
      await sleep(ENDPOINT_PROBE_MS, undefined, { signal });
    }
  }
  throw new Error(`no gRPC endpoint for ${serial}${lastOutput ? `: ${lastOutput}` : ""}`);
}

function grpcMessage(raw: unknown): string {
  if (typeof raw !== "string" || raw === "") return "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * One HTTP/2 connection to an emulator's EmulatorController service. Calls
 * made before the connection settles wait for it; a refused IPv4 loopback
 * falls back to [::1] once.
 */
export class EmulatorGrpcClient {
  private readonly ready: Promise<http2.ClientHttp2Session>;
  private readonly errorListeners = new Set<(err: Error) => void>();
  private closed = false;

  constructor(private readonly endpoint: GrpcEndpoint) {
    this.ready = this.connectTo("127.0.0.1")
      .catch((err: NodeJS.ErrnoException) => {
        if (err.code === "ECONNREFUSED") return this.connectTo("[::1]");
        throw err;
      })
      .then((session) => {
        if (this.closed) {
          session.close();
          throw new Error("emulator gRPC client closed");
        }
        session.on("error", (err) => this.emitError(err));
        session.on("close", () => {
          if (!this.closed) this.emitError(new Error("emulator gRPC connection closed"));
        });
        return session;
      });
    this.ready.catch((err: unknown) => {
      if (!this.closed) this.emitError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  streamScreenshot(
    format: { width: number; height: number },
    onMessage: (raw: Uint8Array) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return this.call("streamScreenshot", encodeImageFormat(format), onMessage, { signal });
  }

  /** The raw Image message; 5 s timeout. */
  async getScreenshot(format: { width: number; height: number }, signal?: AbortSignal): Promise<Uint8Array> {
    let message = null as Uint8Array | null;
    await this.call(
      "getScreenshot",
      encodeImageFormat(format),
      (m) => {
        message ??= m;
      },
      { signal, timeoutMs: SCREENSHOT_TIMEOUT_MS, rejectOnAbort: true },
    );
    if (message === null) throw new Error("getScreenshot: empty response");
    return message;
  }

  /** One client-streaming streamInputEvent; reopened on the next send if the stream ended. */
  openInput(): { send(inputEvent: Uint8Array): void; close(): void } {
    let stream: http2.ClientHttp2Stream | null = null;
    let opening = false;
    let closed = false;
    const queue: Uint8Array[] = [];
    const writable = (s: http2.ClientHttp2Stream | null): s is http2.ClientHttp2Stream =>
      s !== null && !s.closed && !s.destroyed && s.writable;
    const open = () => {
      if (opening) return;
      opening = true;
      this.openStream("streamInputEvent").then(
        (s) => {
          opening = false;
          if (closed) {
            s.close(http2.constants.NGHTTP2_CANCEL);
            return;
          }
          stream = s;
          this.watch("streamInputEvent", s, () => {}).catch(() => {}).finally(() => {
            if (stream === s) stream = null;
          });
          for (const ev of queue.splice(0)) s.write(grpcFrame(ev));
        },
        () => {
          opening = false;
          queue.length = 0;
        },
      );
    };
    return {
      send: (inputEvent) => {
        if (closed) return;
        if (writable(stream)) {
          stream.write(grpcFrame(inputEvent));
          return;
        }
        if (queue.length < INPUT_QUEUE_MAX) queue.push(inputEvent);
        open();
      },
      close: () => {
        closed = true;
        queue.length = 0;
        if (writable(stream)) stream.end();
        stream = null;
      },
    };
  }

  async setClipboard(text: string): Promise<void> {
    await this.call("setClipboard", encodeClipData(text), () => {}, { timeoutMs: UNARY_TIMEOUT_MS, rejectOnAbort: true });
  }

  async setVmState(state: number): Promise<void> {
    await this.call("setVmState", encodeVmRunState(state), () => {}, { timeoutMs: UNARY_TIMEOUT_MS, rejectOnAbort: true });
  }

  onError(cb: (err: Error) => void): () => void {
    this.errorListeners.add(cb);
    return () => {
      this.errorListeners.delete(cb);
    };
  }

  /** Graceful: open streams finish (a just-written input release still flushes); no new ones start. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.errorListeners.clear();
    void this.ready.then(
      (session) => {
        session.close();
        setTimeout(() => {
          if (!session.destroyed) session.destroy();
        }, 2_000).unref();
      },
      () => {},
    );
  }

  private connectTo(host: string): Promise<http2.ClientHttp2Session> {
    const { promise, resolve, reject } = Promise.withResolvers<http2.ClientHttp2Session>();
    const session = http2.connect(`http://${host}:${this.endpoint.port}`, {
      settings: { initialWindowSize: WINDOW_BYTES },
      maxSessionMemory: 128,
    });
    const onError = (err: Error) => {
      session.destroy();
      reject(err);
    };
    session.once("error", onError);
    session.once("connect", () => {
      session.off("error", onError);
      session.setLocalWindowSize(WINDOW_BYTES);
      resolve(session);
    });
    return promise;
  }

  private emitError(err: Error): void {
    for (const cb of [...this.errorListeners]) cb(err);
  }

  private async openStream(rpc: string): Promise<http2.ClientHttp2Stream> {
    const session = await this.ready;
    if (this.closed) throw new Error(`${rpc}: emulator gRPC client closed`);
    const headers: http2.OutgoingHttpHeaders = {
      ":method": "POST",
      ":path": `${SERVICE_PATH}/${rpc}`,
      "content-type": "application/grpc",
      te: "trailers",
    };
    if (this.endpoint.token !== null) headers.authorization = `Bearer ${this.endpoint.token}`;
    return session.request(headers);
  }

  /**
   * Sends one request message and reads the response stream to its trailers.
   * An abort resolves (the caller stopped it) unless `rejectOnAbort`; a
   * timeout always rejects.
   */
  private async call(
    rpc: string,
    body: Uint8Array,
    onMessage: (m: Uint8Array) => void,
    opts: { signal?: AbortSignal; timeoutMs?: number; rejectOnAbort?: boolean },
  ): Promise<void> {
    const { signal } = opts;
    if (signal?.aborted) {
      if (opts.rejectOnAbort) throw new Error(`${rpc}: aborted`);
      return;
    }
    const stream = await this.openStream(rpc);
    let timedOut = false;
    const cancel = () => {
      if (!stream.closed) stream.close(http2.constants.NGHTTP2_CANCEL);
    };
    const timer =
      opts.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            cancel();
          }, opts.timeoutMs);
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    stream.end(grpcFrame(body));
    try {
      await this.watch(rpc, stream, onMessage);
    } catch (err) {
      if (timedOut) throw new Error(`${rpc}: timed out after ${opts.timeoutMs} ms`, { cause: err });
      if (signal?.aborted && !opts.rejectOnAbort) return;
      throw err;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
    }
  }

  private watch(rpc: string, stream: http2.ClientHttp2Stream, onMessage: (m: Uint8Array) => void): Promise<void> {
    const { promise, resolve, reject } = Promise.withResolvers<void>();
    let settled = false;
    let status: string | undefined;
    let message = "";
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err === undefined) resolve();
      else reject(err);
    };
    const parser = new GrpcMessageParser(MAX_MESSAGE_BYTES, onMessage);
    const readStatus = (headers: http2.IncomingHttpHeaders) => {
      const raw = headers["grpc-status"];
      if (raw === undefined) return;
      status = String(raw);
      message = grpcMessage(headers["grpc-message"]);
    };
    stream.on("response", (headers) => {
      const httpStatus = headers[":status"];
      if (httpStatus !== undefined && httpStatus !== 200) {
        finish(new Error(`${rpc}: HTTP ${httpStatus}`));
        stream.close(http2.constants.NGHTTP2_CANCEL);
        return;
      }
      readStatus(headers);
    });
    stream.on("trailers", readStatus);
    stream.on("data", (chunk: Buffer) => {
      try {
        parser.push(chunk);
      } catch (err) {
        finish(new Error(`${rpc}: ${err instanceof Error ? err.message : String(err)}`));
        stream.close(http2.constants.NGHTTP2_CANCEL);
      }
    });
    stream.on("error", (err) => finish(new Error(`${rpc}: ${err.message}`)));
    stream.on("close", () => {
      if (status === undefined) finish(new Error(`${rpc}: stream closed without grpc-status`));
      else if (status !== "0") finish(new Error(`${rpc}: grpc-status ${status}${message ? ` (${message})` : ""}`));
      else finish();
    });
    return promise;
  }
}
