import { makeBackendClient } from "@omp-ui/core/backend-channels";
import type { OmpBackend } from "@omp-ui/core/types";
import {
  decodeBinaryEvent,
  HOST_CLOSE_INCOMPATIBLE,
  makeClientHello,
  makeClientNotifyFrame,
  makeClientRequestFrame,
  parseServerFrame,
  parseServerHello,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
  type ClientHello,
  type ProtocolRange,
  type ServerHello,
} from "@omp-ui/server/protocol";

// The browser half owns only WebSocket lifecycle and wire decoding; method construction is shared
// with preload through makeBackendClient. Protocol 2 (issue #442): the hello goes out first and
// nothing else until the host's verdict is in.

type Listener = (...args: unknown[]) => void;

export interface RemoteConnection {
  backend: OmpBackend;
  /** The host's verdict — always `compatible` here; an incompatible one rejects the connect. */
  hello: ServerHello;
  /** Fires `false` on close/error, `true` on open. Registration is fire-once, like preload. */
  onStatus(cb: (up: boolean) => void): void;
}

/** The host refused the hello; `message` is its reason, fit to show as-is. */
export class IncompatibleHostError extends Error {
  constructor(
    reason: string,
    readonly hostVersion: string,
    readonly protocolRange: ProtocolRange,
  ) {
    super(reason);
    this.name = "IncompatibleHostError";
  }
}

export interface RemoteBackendOptions {
  /** WebSocket URL; defaults to the same-origin `/ws` with the page's `?t=` (the cookie covers the rest). */
  endpoint?: string;
  /** Overrides the token the URL would carry. */
  credential?: string;
  hello: Omit<ClientHello, "t">;
}

function socketUrl(credential: string | undefined): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const token = credential ?? new URLSearchParams(location.search).get(REMOTE_TOKEN_PARAM);
  // The cookie covers the normal case; the query keeps a cold load working.
  const query = token === null || token === "" ? "" : `?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  return `${scheme}//${location.host}${REMOTE_WS_PATH}${query}`;
}

export function connectRemoteBackend(opts: RemoteBackendOptions): Promise<RemoteConnection> {
  const ws = new WebSocket(opts.endpoint ?? socketUrl(opts.credential));
  ws.binaryType = "arraybuffer";

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Listener[]>();
  const statusCbs: Array<(up: boolean) => void> = [];
  /** Frames to send once the verdict is in; null once it is. */
  let outbox: string[] | null = [];
  let nextId = 1;
  let settled = false;

  const dispatch = (channel: string, args: unknown[]): void => {
    for (const cb of listeners.get(channel) ?? []) cb(...args);
  };

  const transmit = (frame: string): void => {
    if (outbox !== null) {
      outbox.push(frame);
      return;
    }
    ws.send(frame);
  };

  const request = <Args extends unknown[], Result>(
    channel: string,
    args: Args,
  ): Promise<Result> =>
    new Promise<Result>((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error("remote connection lost"));
        return;
      }
      const id = nextId++;
      // Like IPC, requests have no arbitrary timeout; close settles every outstanding call.
      pending.set(id, { resolve: (value) => resolve(value as Result), reject });
      transmit(JSON.stringify(makeClientRequestFrame(id, channel, args)));
    });

  const notify = <Args extends unknown[]>(channel: string, args: Args): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    transmit(JSON.stringify(makeClientNotifyFrame(channel, args)));
  };

  const on = <Args extends unknown[]>(
    channel: string,
    cb: (...args: Args) => void,
  ): void => {
    const listener: Listener = (...args) => cb(...(args as unknown as Args));
    const list = listeners.get(channel);
    if (list) list.push(listener);
    else listeners.set(channel, [listener]);
  };

  const backend = makeBackendClient({ request, notify, on });

  return new Promise<RemoteConnection>((resolve, reject) => {
    const settleOk = (hello: ServerHello): void => {
      settled = true;
      const queued = outbox ?? [];
      outbox = null;
      for (const frame of queued) ws.send(frame);
      for (const cb of statusCbs) cb(true);
      resolve({
        backend,
        hello,
        onStatus(cb) {
          statusCbs.push(cb);
        },
      });
    };

    const settleErr = (err: Error): void => {
      settled = true;
      outbox = null;
      reject(err);
    };

    ws.addEventListener("message", (ev: MessageEvent) => {
      if (ev.data instanceof ArrayBuffer) {
        const decoded = decodeBinaryEvent(new Uint8Array(ev.data));
        if (decoded) dispatch(decoded.channel, [decoded.tabId, decoded.payload]);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      if (!settled) {
        // The first text frame must be the verdict; anything else is a host that never said hello.
        const hello = parseServerHello(frame);
        if (hello === null) {
          settleErr(new Error("omp-ui did not answer the protocol hello"));
          ws.close(1000);
          return;
        }
        if (hello.verdict === "compatible") settleOk(hello);
        else {
          settleErr(
            new IncompatibleHostError(hello.reason ?? "incompatible", hello.hostVersion, hello.protocolRange),
          );
          ws.close(1000);
        }
        return;
      }
      // One narrowing (protocol's parseServerFrame, the server's mirror) — the
      // hand-written field checks this block used to carry were a second copy
      // of the grammar.
      const parsed = parseServerFrame(frame);
      if (parsed === null || parsed.t === "hello") return;
      if (parsed.t === "ev") {
        dispatch(parsed.ch, parsed.args);
        return;
      }
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      if (parsed.ok === true) entry.resolve(parsed.value);
      else entry.reject(new Error(parsed.message));
    });

    ws.addEventListener("open", () => {
      ws.send(JSON.stringify(makeClientHello(opts.hello)));
    });
    const down = (ev?: CloseEvent): void => {
      for (const cb of statusCbs) cb(false);
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (settled) return;
      if (ev?.code === HOST_CLOSE_INCOMPATIBLE) {
        settleErr(new IncompatibleHostError(ev.reason || "incompatible", "", { min: 0, max: 0 }));
        return;
      }
      settleErr(
        new Error("could not reach omp-ui — check the token and that remote access is enabled"),
      );
    };
    ws.addEventListener("close", down);
    ws.addEventListener("error", () => {
      // A pre-verdict error is followed by close; once open, error itself marks the connection down.
      if (settled) down();
    });
  });
}
