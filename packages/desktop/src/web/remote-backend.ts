import { makeBackendClient } from "@omp-ui/core/backend-channels";
import type { OmpBackend } from "@omp-ui/core/types";
import {
  decodeBinaryEvent,
  decodeFrameDelivery,
  makeFrameAck,
  makeClientNotifyFrame,
  makeClientRequestFrame,
  parseServerFrame,
  REMOTE_CLOSE_REVOKED,
  REMOTE_FRAME_KEY_PARAM,
  REMOTE_FRAME_WS_PATH,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
} from "@omp-ui/server/protocol";

// The browser half owns only WebSocket lifecycle and wire decoding; method construction is shared
// with preload through makeBackendClient.

type Listener = (...args: unknown[]) => void | Promise<void>;

export interface RemoteConnection {
  backend: OmpBackend;
  /** Reports reliable-connection loss; frame-only reconnects leave the backend usable. */
  onStatus(cb: (up: boolean) => void): void;
}

function socketUrl(path: string, key?: string): string {
  const scheme = location.protocol === "https:" ? "wss:" : "ws:";
  const url = new URL(`${scheme}//${location.host}${path}`);
  const token = new URLSearchParams(location.search).get(REMOTE_TOKEN_PARAM);
  // The cookie covers the normal case; the query keeps a cold load working.
  if (token) url.searchParams.set(REMOTE_TOKEN_PARAM, token);
  if (key) url.searchParams.set(REMOTE_FRAME_KEY_PARAM, key);
  return url.href;
}

export function connectRemoteBackend(): Promise<RemoteConnection> {
  return new Promise<RemoteConnection>((resolve, reject) => {
    const ws = new WebSocket(socketUrl(REMOTE_WS_PATH));
    ws.binaryType = "arraybuffer";

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const listeners = new Map<string, Listener[]>();
    const statusCbs: Array<(up: boolean) => void> = [];
    let nextId = 1;
    let opened = false;
    let stopped = false;
    let frameKey: string | null = null;
    let frames: WebSocket | null = null;
    let retry: number | undefined;
    let frameTimer: number | undefined;
    let retryDelay = 500;
    let health: AbortController | null = null;

    const down = (): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      clearTimeout(retry);
      clearTimeout(frameTimer);
      health?.abort();
      health = null;
      const socket = frames;
      frames = null;
      socket?.close();
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (!opened) {
        reject(new Error("could not reach omp-ui — check the token and that remote access is enabled"));
      }
      for (const cb of statusCbs) cb(false);
    };

    const timer = window.setTimeout(down, 10_000);

    const dispatch = (channel: string, args: unknown[]): void | Promise<void> => {
      let waits: Promise<void>[] | undefined;
      for (const cb of listeners.get(channel) ?? []) {
        try {
          const result = cb(...args);
          if (result !== undefined) (waits ??= []).push(result);
        } catch {
          // A failed receiver intentionally drops the frame instead of holding credit forever.
        }
      }
      if (waits !== undefined) return Promise.allSettled(waits).then(() => {});
    };

    const request = <Args extends unknown[], Result>(channel: string, args: Args): Promise<Result> =>
      new Promise<Result>((res, rej) => {
        if (stopped || ws.readyState !== WebSocket.OPEN) {
          rej(new Error("remote connection lost"));
          return;
        }
        const id = nextId++;
        // Like IPC, requests have no arbitrary timeout; close settles every outstanding call.
        pending.set(id, { resolve: (value) => res(value as Result), reject: rej });
        ws.send(JSON.stringify(makeClientRequestFrame(id, channel, args)));
      });

    const notify = <Args extends unknown[]>(channel: string, args: Args): void => {
      if (stopped || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify(makeClientNotifyFrame(channel, args)));
    };

    const on = <Args extends unknown[]>(channel: string, cb: (...args: Args) => void): void => {
      const listener: Listener = (...args) => cb(...(args as unknown as Args));
      const list = listeners.get(channel);
      if (list) list.push(listener);
      else listeners.set(channel, [listener]);
    };

    const backend = makeBackendClient({ request, notify, on });

    const ready = (): void => {
      if (opened || stopped || ws.readyState !== WebSocket.OPEN || frames?.readyState !== WebSocket.OPEN) return;
      opened = true;
      clearTimeout(timer);
      resolve({
        backend,
        onStatus(cb) {
          statusCbs.push(cb);
          if (stopped) cb(false);
        },
      });
    };

    const checkCredential = (): void => {
      if (health !== null) return;
      const controller = new AbortController();
      health = controller;
      const timeout = window.setTimeout(() => controller.abort(), 10_000);
      const url = new URL("/healthz", location.href);
      const token = new URLSearchParams(location.search).get(REMOTE_TOKEN_PARAM);
      if (token) url.searchParams.set(REMOTE_TOKEN_PARAM, token);
      // Browsers hide an upgrade's HTTP status. Use the existing authenticated probe
      // to distinguish revocation from transient frame-only network failure.
      void fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
        .then((res) => {
          if (!stopped && health === controller && res.status === 401) down();
        })
        .catch(() => {
          // The independent reconnect keeps retrying while the reliable stream is alive.
        })
        .finally(() => {
          clearTimeout(timeout);
          if (health === controller) health = null;
        });
    };

    const scheduleFrames = (): void => {
      if (stopped || ws.readyState !== WebSocket.OPEN || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        connectFrames();
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 5_000);
    };

    const connectFrames = (): void => {
      if (stopped || ws.readyState !== WebSocket.OPEN || frameKey === null || frames !== null) return;
      const socket = new WebSocket(socketUrl(REMOTE_FRAME_WS_PATH, frameKey));
      frames = socket;
      socket.binaryType = "arraybuffer";
      frameTimer = window.setTimeout(() => socket.close(), 10_000);
      socket.addEventListener("open", () => {
        if (stopped || frames !== socket) {
          socket.close();
          return;
        }
        clearTimeout(frameTimer);
        health?.abort();
        health = null;
        retryDelay = 500;
        ready();
      });
      socket.addEventListener("message", (ev: MessageEvent) => {
        if (stopped || frames !== socket || !(ev.data instanceof ArrayBuffer)) return;
        const decoded = decodeFrameDelivery(new Uint8Array(ev.data));
        if (decoded === null) return;
        void Promise.resolve(dispatch(decoded.channel, [decoded.tabId, decoded.payload])).then(() => {
          if (!stopped && frames === socket && ws.readyState === WebSocket.OPEN && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(makeFrameAck(decoded.id)));
          }
        });
      });
      socket.addEventListener("error", () => {
        if (!stopped && frames === socket) checkCredential();
      });
      socket.addEventListener("close", (ev: CloseEvent) => {
        if (frames !== socket) return;
        clearTimeout(frameTimer);
        frames = null;
        if (ev.code === REMOTE_CLOSE_REVOKED || ev.code === 1008) {
          down();
          return;
        }
        scheduleFrames();
      });
    };

    ws.addEventListener("message", (ev: MessageEvent) => {
      if (stopped) return;
      if (ev.data instanceof ArrayBuffer) {
        const decoded = decodeBinaryEvent(new Uint8Array(ev.data));
        if (decoded) void dispatch(decoded.channel, [decoded.tabId, decoded.payload]);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(String(ev.data));
      } catch {
        return;
      }
      const parsed = parseServerFrame(frame);
      if (parsed === null) return;
      if (parsed.t === "frames") {
        if (frameKey === null) {
          frameKey = parsed.key;
          connectFrames();
        }
        return;
      }
      if (parsed.t === "ev") {
        void dispatch(parsed.ch, parsed.args);
        return;
      }
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      if (parsed.ok === true) entry.resolve(parsed.value);
      else entry.reject(new Error(parsed.message));
    });

    ws.addEventListener("open", ready);
    ws.addEventListener("close", down);
    ws.addEventListener("error", down);
  });
}
