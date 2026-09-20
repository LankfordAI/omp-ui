import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import {
  decodeBinaryEvent,
  decodeFrameDelivery,
  makeFrameAck,
  makeClientNotifyFrame,
  makeClientRequestFrame,
  parseServerFrame,
  REMOTE_COOKIE,
  REMOTE_CLOSE_REVOKED,
  REMOTE_FRAME_KEY_PARAM,
  REMOTE_FRAME_WS_PATH,
  REMOTE_WS_PATH,
} from "./protocol";
import {
  REMOTE_CONNECT_TIMEOUT_MS,
  REMOTE_FRAME_RETRY_INITIAL_MS,
  dispatchRemoteListeners,
  isCredentialClose,
  nextFrameRetryDelay,
} from "./transport-core";

/**
 * The dial-out half of the remote transport (issue #416): one omp-ui's main
 * process joining another's embedded server. A Node port of the browser client
 * in desktop/src/web/remote-backend.ts — same frames, same pending map, same
 * close semantics — with the credential carried as a Bearer header instead of
 * a cookie or query parameter.
 */

export interface InstanceClient {
  request<Result>(channel: string, args: unknown[]): Promise<Result>;
  notify(channel: string, args: unknown[]): void;
  /** Every event the remote fans out, JSON or binary-decoded; binary payloads arrive as Uint8Array. */
  onEvent(cb: (channel: string, args: unknown[]) => void | Promise<void>): void;
  /** Fires once, after open. `code` is the WS close code; `reason` its text. */
  onClose(cb: (code: number, reason: string) => void): void;
  close(): void;
}

export type InstanceConnectFailure =
  | { kind: "unauthorized" }
  | { kind: "unreachable"; message: string };

export class InstanceConnectError extends Error {
  constructor(readonly failure: InstanceConnectFailure) {
    super(failure.kind === "unauthorized" ? "credential rejected" : failure.message);
    this.name = "InstanceConnectError";
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = REMOTE_CONNECT_TIMEOUT_MS;

/**
 * Dials the reliable and paired frame streams with `Authorization: Bearer credential`.
 * Resolves once both are open; rejects with InstanceConnectError. Never throws synchronously.
 */
export function connectInstanceClient(
  origin: string,
  credential: string,
  opts: { timeoutMs?: number } = {},
): Promise<InstanceClient> {
  return new Promise<InstanceClient>((resolve, reject) => {
    const headers = { authorization: `Bearer ${credential}` };
    const base = origin.replace(/^http/, "ws");
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${base}${REMOTE_WS_PATH}`, { headers });
    } catch (err) {
      reject(new InstanceConnectError({
        kind: "unreachable",
        message: err instanceof Error ? err.message : String(err),
      }));
      return;
    }

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const eventCbs: Array<(channel: string, args: unknown[]) => void | Promise<void>> = [];
    const closeCbs: Array<(code: number, reason: string) => void> = [];
    let nextId = 1;
    let opened = false;
    let stopped = false;
    let failure: InstanceConnectFailure | null = null;
    let frameKey: string | null = null;
    let frames: WebSocket | null = null;
    let retry: NodeJS.Timeout | undefined;
    let frameTimer: NodeJS.Timeout | undefined;
    let retryDelay = REMOTE_FRAME_RETRY_INITIAL_MS;

    const stopFrames = (): void => {
      clearTimeout(retry);
      clearTimeout(frameTimer);
      retry = undefined;
      const socket = frames;
      frames = null;
      if (socket !== null && socket.readyState !== WebSocket.CLOSED) socket.terminate();
    };

    const stop = (): void => {
      stopped = true;
      clearTimeout(timer);
      stopFrames();
      if (ws.readyState !== WebSocket.CLOSED) ws.terminate();
    };

    const timer = setTimeout(() => {
      failure = { kind: "unreachable", message: "timed out waiting for remote frame stream" };
      stop();
    }, opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    // Invoke local sinks together. Relay sinks hand off synchronously; each downstream
    // server pair owns its own credit, rather than lending it to this upstream socket.
    const dispatch = (channel: string, args: unknown[]): void | Promise<void> =>
      dispatchRemoteListeners(eventCbs, (cb) => cb(channel, args));

    const ready = (): void => {
      if (opened || stopped || ws.readyState !== WebSocket.OPEN || frames?.readyState !== WebSocket.OPEN) return;
      opened = true;
      clearTimeout(timer);
      resolve({
        request<Result>(channel: string, args: unknown[]): Promise<Result> {
          return new Promise<Result>((res, rej) => {
            if (stopped || ws.readyState !== WebSocket.OPEN) {
              rej(new Error("remote connection lost"));
              return;
            }
            const id = nextId++;
            // Like IPC, requests have no arbitrary timeout; close settles every outstanding call.
            pending.set(id, { resolve: (value) => res(value as Result), reject: rej });
            ws.send(JSON.stringify(makeClientRequestFrame(id, channel, args)));
          });
        },
        notify(channel, args) {
          if (!stopped && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(makeClientNotifyFrame(channel, args)));
          }
        },
        onEvent(cb) {
          eventCbs.push(cb);
        },
        onClose(cb) {
          closeCbs.push(cb);
        },
        close() {
          stopped = true;
          stopFrames();
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
        },
      });
    };

    const scheduleFrames = (): void => {
      if (stopped || ws.readyState !== WebSocket.OPEN || retry !== undefined) return;
      retry = setTimeout(() => {
        retry = undefined;
        connectFrames();
      }, retryDelay);
      retryDelay = nextFrameRetryDelay(retryDelay);
    };

    const connectFrames = (): void => {
      if (stopped || ws.readyState !== WebSocket.OPEN || frameKey === null || frames !== null) return;
      const socket = new WebSocket(
        `${base}${REMOTE_FRAME_WS_PATH}?${REMOTE_FRAME_KEY_PARAM}=${frameKey}`,
        { headers },
      );
      frames = socket;
      frameTimer = setTimeout(() => socket.terminate(), DEFAULT_CONNECT_TIMEOUT_MS);
      socket.on("open", () => {
        if (stopped || frames !== socket) {
          socket.terminate();
          return;
        }
        clearTimeout(frameTimer);
        retryDelay = REMOTE_FRAME_RETRY_INITIAL_MS;
        ready();
      });
      socket.on("message", (raw: Buffer, isBinary: boolean) => {
        if (!isBinary || stopped || frames !== socket) return;
        const decoded = decodeFrameDelivery(raw);
        if (decoded === null) return;
        void Promise.resolve(dispatch(decoded.channel, [decoded.tabId, decoded.payload])).then(() => {
          if (!stopped && frames === socket && ws.readyState === WebSocket.OPEN && socket.readyState === WebSocket.OPEN) {
            socket.send(JSON.stringify(makeFrameAck(decoded.id)));
          }
        });
      });
      socket.on("unexpected-response", (_req, res: IncomingMessage) => {
        res.resume();
        // Only the initial pairing proves the credential. Afterwards the server also
        // answers 401 for a retired pairing key (its reliable socket closed first), so
        // retry and let the reliable socket's own close report a real revocation.
        if (res.statusCode === 401 && frames === socket && !opened) {
          failure = { kind: "unauthorized" };
          stop();
        } else {
          socket.terminate();
        }
      });
      socket.on("error", () => {
        // Close schedules an independent retry; an HTTP 401 above instead tears down the pair.
      });
      socket.on("close", (code) => {
        if (frames !== socket) return;
        clearTimeout(frameTimer);
        frames = null;
        if (isCredentialClose(code)) {
          failure = { kind: "unauthorized" };
          stop();
          return;
        }
        scheduleFrames();
      });
    };

    ws.on("unexpected-response", (_req, res: IncomingMessage) => {
      failure = res.statusCode === 401
        ? { kind: "unauthorized" }
        : { kind: "unreachable", message: `HTTP ${res.statusCode ?? "?"}` };
      res.resume();
      stop();
    });

    ws.on("error", (err: Error) => {
      if (failure === null) failure = { kind: "unreachable", message: err.message };
    });

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (stopped) return;
      if (isBinary) {
        const decoded = decodeBinaryEvent(raw);
        if (decoded) void dispatch(decoded.channel, [decoded.tabId, decoded.payload]);
        return;
      }
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString("utf8"));
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

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      stopped = true;
      clearTimeout(timer);
      stopFrames();
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (!opened) {
        reject(new InstanceConnectError(failure ?? { kind: "unreachable", message: `closed before paired open (${code})` }));
        return;
      }
      const unauthorized = failure?.kind === "unauthorized";
      for (const cb of closeCbs) cb(unauthorized ? REMOTE_CLOSE_REVOKED : code, unauthorized ? "credential rejected" : reasonBuf.toString("utf8"));
    });

    ws.on("open", ready);
  });
}

/**
 * POSTs the password form exactly as the login page does and returns the
 * credential the server set in its cookie. 401 → "Wrong password."; 429 →
 * "Too many attempts. Try again in Ns."; anything else → the status text.
 */
export async function signInForCredential(origin: string, password: string): Promise<string> {
  let response: Response;
  try {
    response = await fetch(`${origin}/login`, {
      method: "POST",
      redirect: "manual",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ password }),
    });
  } catch (err) {
    throw new Error(
      `could not reach ${origin}: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
  if (response.status === 401) {
    // A password-enabled remote answers the form with its login page; a token-only remote has
    // no /login route and falls through to the bare text 401 (server/index.ts).
    const html = (response.headers.get("content-type") ?? "").includes("text/html");
    throw new Error(
      html ? "Wrong password." : "the remote has no sign-in password — join with its access token instead",
    );
  }
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") ?? "?";
    throw new Error(`Too many attempts. Try again in ${retryAfter}s.`);
  }
  if (response.status !== 302) {
    throw new Error(
      `sign-in failed: HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
    );
  }
  for (const cookie of response.headers.getSetCookie()) {
    if (!cookie.startsWith(`${REMOTE_COOKIE}=`)) continue;
    const raw = cookie.slice(REMOTE_COOKIE.length + 1);
    const end = raw.indexOf(";");
    return decodeURIComponent(end === -1 ? raw : raw.slice(0, end));
  }
  throw new Error("sign-in succeeded but the remote set no credential cookie");
}
