import { makeBackendClient } from "@omp-ui/core/backend-channels";
import type { OmpBackend } from "@omp-ui/core/types";
import {
  decodeBinaryEvent,
  decodeFrameDelivery,
  makeFrameAck,
  makeClientNotifyFrame,
  makeClientRequestFrame,
  parseServerFrame,
  REMOTE_FRAME_KEY_PARAM,
  REMOTE_FRAME_WS_PATH,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
} from "@omp-ui/server/protocol";
import {
  REMOTE_CONNECT_TIMEOUT_MS,
  REMOTE_FRAME_RETRY_INITIAL_MS,
  dispatchRemoteListeners,
  isCredentialClose,
  nextFrameRetryDelay,
} from "@omp-ui/server/transport-core";

// The browser half owns only WebSocket lifecycle and wire decoding; method construction is shared
// with preload through makeBackendClient.

type Listener = (...args: unknown[]) => void | Promise<void>;

export interface RemoteConnection {
  backend: OmpBackend;
  /** Reports reliable-connection transitions after the first pairing: false on every drop, true once both sockets are re-paired. */
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
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const listeners = new Map<string, Listener[]>();
    const statusCbs: Array<(up: boolean) => void> = [];
    let nextId = 1;
    // `settled` latches the one-time promise resolution; `up` is the current
    // reliable-connection truth so re-pairing fires exactly one status(true).
    let settled = false;
    let up = false;
    // Terminal only for a bad credential (or a failed first dial): revoked-close
    // codes and healthz 401 stop redialing; everything else retries (issue #890).
    let stopped = false;
    let socket: WebSocket | null = null;
    let frameKey: string | null = null;
    let frames: WebSocket | null = null;
    let openTimer: number | undefined;
    let retry: number | undefined;
    let frameTimer: number | undefined;
    let dialTimer: number | undefined;
    let retryDelay = REMOTE_FRAME_RETRY_INITIAL_MS;
    let dialDelay = REMOTE_FRAME_RETRY_INITIAL_MS;
    let health: AbortController | null = null;

    const dispatch = (channel: string, args: unknown[]): void | Promise<void> =>
      dispatchRemoteListeners(listeners.get(channel) ?? [], (cb) => cb(...args));

    const request = <Args extends unknown[], Result>(channel: string, args: Args): Promise<Result> =>
      new Promise<Result>((res, rej) => {
        const live = socket;
        if (stopped || live === null || live.readyState !== WebSocket.OPEN) {
          rej(new Error("remote connection lost"));
          return;
        }
        const id = nextId++;
        // Like IPC, requests have no arbitrary timeout; close settles every outstanding call.
        pending.set(id, { resolve: (value) => res(value as Result), reject: rej });
        live.send(JSON.stringify(makeClientRequestFrame(id, channel, args)));
      });

    const notify = <Args extends unknown[]>(channel: string, args: Args): void => {
      const live = socket;
      if (stopped || live === null || live.readyState !== WebSocket.OPEN) return;
      live.send(JSON.stringify(makeClientNotifyFrame(channel, args)));
    };

    const on = <Args extends unknown[]>(channel: string, cb: (...args: Args) => void): void => {
      const listener: Listener = (...args) => cb(...(args as unknown as Args));
      const list = listeners.get(channel);
      if (list) list.push(listener);
      else listeners.set(channel, [listener]);
    };

    const backend = makeBackendClient({ request, notify, on });

    const ready = (): void => {
      if (
        stopped ||
        socket?.readyState !== WebSocket.OPEN ||
        frames?.readyState !== WebSocket.OPEN
      ) {
        return;
      }
      clearTimeout(openTimer);
      openTimer = undefined;
      if (!settled) {
        settled = true;
        up = true;
        resolve({
          backend,
          onStatus(cb) {
            statusCbs.push(cb);
            if (stopped) cb(false);
          },
        });
        return;
      }
      // A redial re-paired both sockets: report recovery without touching the
      // pending-request machinery, and let the next drop wait its own turn.
      if (!up) {
        up = true;
        dialDelay = REMOTE_FRAME_RETRY_INITIAL_MS;
        for (const cb of statusCbs) cb(true);
      }
    };

    const stop = (): void => {
      if (stopped) return;
      stopped = true;
      clearTimeout(openTimer);
      clearTimeout(retry);
      clearTimeout(frameTimer);
      clearTimeout(dialTimer);
      health?.abort();
      health = null;
      const departed = frames;
      frames = null;
      departed?.close();
      const s = socket;
      if (s !== null && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
        s.close();
      }
      frameKey = null;
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (!settled) {
        reject(new Error("could not reach omp-ui — check the token and that remote access is enabled"));
        return;
      }
      if (up) {
        up = false;
        for (const cb of statusCbs) cb(false);
      }
    };

    /** Reliable loss after the first pairing: tear the pair down, then redial with backoff. */
    const drop = (): void => {
      if (stopped || dialTimer !== undefined) return;
      // Arm the redial first: closing a socket can re-enter through its own
      // close handler, and the armed timer makes that re-entry a no-op.
      dialTimer = window.setTimeout(() => {
        dialTimer = undefined;
        if (!stopped) dial();
      }, dialDelay);
      dialDelay = nextFrameRetryDelay(dialDelay);
      const s = socket;
      if (s !== null && (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING)) {
        s.close();
      }
      const departed = frames;
      frames = null;
      departed?.close();
      clearTimeout(retry);
      clearTimeout(frameTimer);
      retry = undefined;
      frameTimer = undefined;
      // The server mints a fresh pairing key per reliable connection; take the next one.
      frameKey = null;
      retryDelay = REMOTE_FRAME_RETRY_INITIAL_MS;
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (up) {
        up = false;
        for (const cb of statusCbs) cb(false);
      }
    };

    const checkCredential = (): void => {
      if (health !== null) return;
      const controller = new AbortController();
      health = controller;
      const timeout = window.setTimeout(
        () => controller.abort(),
        REMOTE_CONNECT_TIMEOUT_MS,
      );
      const url = new URL("/healthz", location.href);
      const token = new URLSearchParams(location.search).get(REMOTE_TOKEN_PARAM);
      if (token) url.searchParams.set(REMOTE_TOKEN_PARAM, token);
      // Browsers hide an upgrade's HTTP status. Use the existing authenticated probe
      // to distinguish revocation from transient frame-only network failure.
      void fetch(url, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
        .then((res) => {
          if (!stopped && health === controller && res.status === 401) stop();
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
      const live = socket;
      if (stopped || live === null || live.readyState !== WebSocket.OPEN || retry !== undefined) return;
      retry = window.setTimeout(() => {
        retry = undefined;
        connectFrames();
      }, retryDelay);
      retryDelay = nextFrameRetryDelay(retryDelay);
    };

    const connectFrames = (): void => {
      const live = socket;
      if (stopped || live === null || live.readyState !== WebSocket.OPEN || frameKey === null || frames !== null) {
        return;
      }
      const s = new WebSocket(socketUrl(REMOTE_FRAME_WS_PATH, frameKey));
      frames = s;
      s.binaryType = "arraybuffer";
      frameTimer = window.setTimeout(
        () => s.close(),
        REMOTE_CONNECT_TIMEOUT_MS,
      );
      s.addEventListener("open", () => {
        if (stopped || frames !== s) {
          s.close();
          return;
        }
        clearTimeout(frameTimer);
        frameTimer = undefined;
        health?.abort();
        health = null;
        retryDelay = REMOTE_FRAME_RETRY_INITIAL_MS;
        ready();
      });
      s.addEventListener("message", (ev: MessageEvent) => {
        if (stopped || frames !== s || !(ev.data instanceof ArrayBuffer)) return;
        const decoded = decodeFrameDelivery(new Uint8Array(ev.data));
        if (decoded === null) return;
        void Promise.resolve(dispatch(decoded.channel, [decoded.tabId, decoded.payload])).then(() => {
          const reliable = socket;
          if (
            !stopped && frames === s &&
            reliable !== null && reliable.readyState === WebSocket.OPEN &&
            s.readyState === WebSocket.OPEN
          ) {
            s.send(JSON.stringify(makeFrameAck(decoded.id)));
          }
        });
      });
      s.addEventListener("error", () => {
        if (!stopped && frames === s) checkCredential();
      });
      s.addEventListener("close", (ev: CloseEvent) => {
        if (frames !== s) return;
        clearTimeout(frameTimer);
        frameTimer = undefined;
        frames = null;
        if (isCredentialClose(ev.code)) {
          stop();
          return;
        }
        scheduleFrames();
      });
    };

    const dial = (): void => {
      const s = new WebSocket(socketUrl(REMOTE_WS_PATH));
      s.binaryType = "arraybuffer";
      socket = s;
      if (!settled) {
        // Before the first pairing the whole attempt is bounded (issue #37 semantics):
        // one failure rejects the boot with no retries, keeping the failure screen honest.
        clearTimeout(openTimer);
        openTimer = window.setTimeout(stop, REMOTE_CONNECT_TIMEOUT_MS);
      }
      s.addEventListener("message", (ev: MessageEvent) => {
        if (stopped || socket !== s) return;
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
          // A fresh key on every authenticated connection — never latch the first one.
          frameKey = parsed.key;
          connectFrames();
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
      s.addEventListener("open", () => {
        if (socket !== s) return;
        ready();
      });
      s.addEventListener("close", (ev: CloseEvent) => {
        if (socket !== s) return;
        // Pre-pairing failure or a revoked credential: stop for good. Anything
        // else after pairing is survivable — redial with backoff (issue #890).
        if (!settled || isCredentialClose(ev.code)) {
          stop();
          return;
        }
        drop();
      });
      s.addEventListener("error", () => {
        if (socket !== s) return;
        if (!settled) {
          stop();
          return;
        }
        checkCredential();
        drop();
      });
    };

    dial();
  });
}
