import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import {
  decodeBinaryEvent,
  makeClientNotifyFrame,
  makeClientRequestFrame,
  parseServerFrame,
  REMOTE_COOKIE,
  REMOTE_WS_PATH,
} from "./protocol";

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
  onEvent(cb: (channel: string, args: unknown[]) => void): void;
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

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

/**
 * Dials `origin + /ws` with `Authorization: Bearer credential`. Resolves once open;
 * rejects with InstanceConnectError. Never throws synchronously.
 */
export function connectInstanceClient(
  origin: string,
  credential: string,
  opts: { timeoutMs?: number } = {},
): Promise<InstanceClient> {
  return new Promise<InstanceClient>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${origin.replace(/^http/, "ws")}${REMOTE_WS_PATH}`, {
        headers: { authorization: `Bearer ${credential}` },
      });
    } catch (err) {
      reject(
        new InstanceConnectError({
          kind: "unreachable",
          message: err instanceof Error ? err.message : String(err),
        }),
      );
      return;
    }

    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const eventCbs: Array<(channel: string, args: unknown[]) => void> = [];
    const closeCbs: Array<(code: number, reason: string) => void> = [];
    let nextId = 1;
    let opened = false;
    let settled = false;
    let failure: InstanceConnectFailure | null = null;

    const fail = (f: InstanceConnectFailure): void => {
      if (settled) return;
      settled = true;
      reject(new InstanceConnectError(f));
    };

    const timer = setTimeout(() => {
      failure = { kind: "unreachable", message: "timed out" };
      ws.terminate();
    }, opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    ws.on("unexpected-response", (_req, res: IncomingMessage) => {
      failure =
        res.statusCode === 401
          ? { kind: "unauthorized" }
          : { kind: "unreachable", message: `HTTP ${res.statusCode ?? "?"}` };
      res.resume();
      ws.terminate();
    });

    ws.on("error", (err: Error) => {
      // A pre-open error is followed by close, which settles; once open, close does the work.
      if (failure === null) failure = { kind: "unreachable", message: err.message };
    });

    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) {
        const decoded = decodeBinaryEvent(new Uint8Array(raw));
        if (decoded) for (const cb of eventCbs) cb(decoded.channel, [decoded.tabId, decoded.payload]);
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
      if (parsed.t === "ev") {
        for (const cb of eventCbs) cb(parsed.ch, parsed.args);
        return;
      }
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      if (parsed.ok === true) entry.resolve(parsed.value);
      else entry.reject(new Error(parsed.message));
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      clearTimeout(timer);
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      if (!opened) {
        fail(failure ?? { kind: "unreachable", message: `closed before open (${code})` });
        return;
      }
      const reason = reasonBuf.toString("utf8");
      for (const cb of closeCbs) cb(code, reason);
    });

    ws.on("open", () => {
      clearTimeout(timer);
      opened = true;
      settled = true;
      resolve({
        request<Result>(channel: string, args: unknown[]): Promise<Result> {
          return new Promise<Result>((res, rej) => {
            if (ws.readyState !== WebSocket.OPEN) {
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
          if (ws.readyState !== WebSocket.OPEN) return;
          ws.send(JSON.stringify(makeClientNotifyFrame(channel, args)));
        },
        onEvent(cb) {
          eventCbs.push(cb);
        },
        onClose(cb) {
          closeCbs.push(cb);
        },
        close() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1000);
        },
      });
    });
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
