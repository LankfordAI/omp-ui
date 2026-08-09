import { makeBackendClient } from "@omp-ui/core/backend-channels";
import type { OmpBackend } from "@omp-ui/core/types";
import { decodeBinaryEvent, REMOTE_TOKEN_PARAM, REMOTE_WS_PATH } from "@omp-ui/server/protocol";

// The browser half owns only WebSocket lifecycle and wire decoding; method construction is shared
// with preload through makeBackendClient.

type Listener = (...args: unknown[]) => void;

export interface RemoteConnection {
  backend: OmpBackend;
  /** Fires `false` on close/error, `true` on open. Registration is fire-once, like preload. */
  onStatus(cb: (up: boolean) => void): void;
}

function socketUrl(): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const token = new URLSearchParams(location.search).get(REMOTE_TOKEN_PARAM);
  // The cookie covers the normal case; the query keeps a cold load working.
  const query = token === null || token === "" ? "" : `?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  return `${scheme}//${location.host}${REMOTE_WS_PATH}${query}`;
}

export function connectRemoteBackend(): Promise<RemoteConnection> {
  const ws = new WebSocket(socketUrl());
  ws.binaryType = "arraybuffer";

  const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  const listeners = new Map<string, Listener[]>();
  const statusCbs: Array<(up: boolean) => void> = [];
  let nextId = 1;
  let opened = false;

  const dispatch = (channel: string, args: unknown[]): void => {
    for (const cb of listeners.get(channel) ?? []) cb(...args);
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
    if (frame === null || typeof frame !== "object") return;
    const f = frame as {
      t?: unknown;
      id?: unknown;
      ch?: unknown;
      ok?: unknown;
      value?: unknown;
      message?: unknown;
      args?: unknown;
    };
    if (f.t === "ev" && typeof f.ch === "string") {
      dispatch(f.ch, Array.isArray(f.args) ? f.args : []);
      return;
    }
    if (f.t !== "res" || typeof f.id !== "number") return;
    const entry = pending.get(f.id);
    if (!entry) return;
    pending.delete(f.id);
    if (f.ok === true) entry.resolve(f.value);
    else entry.reject(new Error(typeof f.message === "string" ? f.message : "remote call failed"));
  });

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
      ws.send(JSON.stringify({ t: "req", id, ch: channel, args }));
    });

  const notify = <Args extends unknown[]>(channel: string, args: Args): void => {
    if (ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ t: "notify", ch: channel, args }));
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
    ws.addEventListener("open", () => {
      opened = true;
      for (const cb of statusCbs) cb(true);
      resolve({
        backend,
        onStatus(cb) {
          statusCbs.push(cb);
        },
      });
    });
    const down = (): void => {
      for (const cb of statusCbs) cb(false);
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (!opened) {
        reject(
          new Error("could not reach omp-ui — check the token and that remote access is enabled"),
        );
      }
    };
    ws.addEventListener("close", down);
    ws.addEventListener("error", () => {
      // A pre-open error is followed by close; once open, error itself marks the connection down.
      if (opened) down();
    });
  });
}
