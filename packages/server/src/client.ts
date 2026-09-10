import type { IncomingMessage } from "node:http";
import { WebSocket } from "ws";
import {
  decodeBinaryEvent,
  HOST_CLOSE_INCOMPATIBLE,
  INSTANCE_CLIENT_HEADER,
  makeClientHello,
  makeClientNotifyFrame,
  makeClientRequestFrame,
  parseServerFrame,
  parseServerHello,
  REMOTE_COOKIE,
  REMOTE_WS_PATH,
  type ClientHello,
  type ProtocolRange,
  type ServerHello,
} from "./protocol";

/**
 * The dial-out half of the remote transport (issue #416): one omp-ui's main
 * process joining another's embedded server. A Node port of the browser client
 * in desktop/src/web/remote-backend.ts — same frames, same pending map, same
 * close semantics — with the credential carried as a Bearer header instead of
 * a cookie or query parameter, and the joined-instance header beside it so the
 * server grants the `instance` role (issue #442).
 */

export interface InstanceClient {
  /** The host's hello verdict; null for a protocol-1 host, which never answers one. */
  readonly hello: ServerHello | null;
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
  | { kind: "unreachable"; message: string }
  | { kind: "incompatible"; hostVersion: string; protocolRange: ProtocolRange; reason: string };

export class InstanceConnectError extends Error {
  constructor(readonly failure: InstanceConnectFailure) {
    super(
      failure.kind === "unauthorized"
        ? "credential rejected"
        : failure.kind === "unreachable"
          ? failure.message
          : failure.reason,
    );
    this.name = "InstanceConnectError";
  }
}

const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;
/** How long a host gets to answer the hello before it is taken for a protocol-1 peer. */
const DEFAULT_HELLO_TIMEOUT_MS = 3000;

export interface InstanceConnectOptions {
  timeoutMs?: number;
  hello: Omit<ClientHello, "t">;
  helloTimeoutMs?: number;
}

/**
 * Dials `origin + /ws` with `Authorization: Bearer credential`, sends the hello first, and
 * resolves once the host's verdict is in — or, for a host that never answers one, once the
 * hello timeout has elapsed (protocol 1). Frames the host sends before that are buffered and
 * dispatched, in order, after resolution. Rejects with InstanceConnectError. Never throws
 * synchronously.
 */
export function connectInstanceClient(
  origin: string,
  credential: string,
  opts: InstanceConnectOptions,
): Promise<InstanceClient> {
  return new Promise<InstanceClient>((resolve, reject) => {
    let ws: WebSocket;
    try {
      ws = new WebSocket(`${origin.replace(/^http/, "ws")}${REMOTE_WS_PATH}`, {
        headers: { authorization: `Bearer ${credential}`, [INSTANCE_CLIENT_HEADER]: "instance" },
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
    /** Frames received before the hello settled, replayed in order once it has. */
    let buffered: Array<[Buffer, boolean]> | null = [];
    let nextId = 1;
    let opened = false;
    let settled = false;
    let failure: InstanceConnectFailure | null = null;
    let helloTimer: NodeJS.Timeout | undefined;

    const fail = (f: InstanceConnectFailure): void => {
      if (settled) return;
      settled = true;
      reject(new InstanceConnectError(f));
    };

    const connectTimer = setTimeout(() => {
      failure = { kind: "unreachable", message: "timed out" };
      ws.terminate();
    }, opts.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

    const dispatch = (raw: Buffer, isBinary: boolean): void => {
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
      if (parsed === null || parsed.t === "hello") return;
      if (parsed.t === "ev") {
        for (const cb of eventCbs) cb(parsed.ch, parsed.args);
        return;
      }
      const entry = pending.get(parsed.id);
      if (!entry) return;
      pending.delete(parsed.id);
      if (parsed.ok === true) entry.resolve(parsed.value);
      else entry.reject(new Error(parsed.message));
    };

    const settle = (hello: ServerHello | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(helloTimer);
      resolve({
        hello,
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
      // Replayed once the awaiting caller's continuation — however many awaits deep — has
      // registered its callbacks; frames arriving in between queue behind so wire order is kept.
      setImmediate(() => {
        const frames = buffered ?? [];
        buffered = null;
        for (const [raw, isBinary] of frames) dispatch(raw, isBinary);
      });
    };

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
      if (buffered === null) {
        dispatch(raw, isBinary);
        return;
      }
      if (!settled && !isBinary) {
        let frame: unknown;
        try {
          frame = JSON.parse(raw.toString("utf8"));
        } catch {
          return;
        }
        const hello = parseServerHello(frame);
        if (hello !== null) {
          clearTimeout(helloTimer);
          if (hello.verdict === "compatible") {
            settle(hello);
          } else {
            fail({
              kind: "incompatible",
              hostVersion: hello.hostVersion,
              protocolRange: hello.protocolRange,
              reason: hello.reason ?? "incompatible",
            });
            ws.close(1000);
          }
          return;
        }
      }
      buffered.push([raw, isBinary]);
    });

    ws.on("close", (code: number, reasonBuf: Buffer) => {
      clearTimeout(connectTimer);
      clearTimeout(helloTimer);
      for (const [, entry] of pending) entry.reject(new Error("remote connection lost"));
      pending.clear();
      const reason = reasonBuf.toString("utf8");
      if (!settled) {
        if (code === HOST_CLOSE_INCOMPATIBLE) {
          fail({
            kind: "incompatible",
            hostVersion: "",
            protocolRange: { min: 0, max: 0 },
            reason: reason || "incompatible",
          });
        } else if (!opened) {
          fail(failure ?? { kind: "unreachable", message: `closed before open (${code})` });
        } else {
          fail(failure ?? { kind: "unreachable", message: `closed before hello (${code})` });
        }
        return;
      }
      for (const cb of closeCbs) cb(code, reason);
    });

    ws.on("open", () => {
      clearTimeout(connectTimer);
      opened = true;
      ws.send(JSON.stringify(makeClientHello(opts.hello)));
      // No verdict within the window: a protocol-1 host, which ignores the hello as an unknown
      // frame and is already serving requests.
      helloTimer = setTimeout(() => settle(null), opts.helloTimeoutMs ?? DEFAULT_HELLO_TIMEOUT_MS);
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
