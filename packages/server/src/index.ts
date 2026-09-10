import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { networkInterfaces } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { dispatchNotify, dispatchRequest, type ChannelTable, type RemoteBind } from "@omp-ui/core";
import { loginPage } from "./login-page";
import { LoginThrottle } from "./login-throttle";
import {
  encodeBinaryEvent,
  HOST_CLOSE_INCOMPATIBLE,
  HOST_PROTOCOL,
  HOST_PROTOCOL_RANGE,
  makeServerEventFrame,
  makeServerHello,
  makeServerResponseErr,
  makeServerResponseOk,
  MAX_PAYLOAD_BYTES,
  parseClientFrame,
  REMOTE_COOKIE,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
  type ClientHello,
  type ClientRole,
  type ConnectionContext,
  type ProtocolRange,
  type ServerFrame,
} from "./protocol";
import { passwordSessionCredential, verifyRemotePassword } from "./token";

/** Who an event is for. The surface decides; the server only resolves scope to sockets. */
export type EventScope =
  | { kind: "broadcast" }
  | { kind: "role"; role: ClientRole }
  | { kind: "connection"; id: string };

export type ScopedSink = (scope: EventScope, channel: string, args: unknown[]) => void;

/** What the transport needs from the host application — nothing about sessions, Electron, or the registry. */
export interface HostSurface {
  /** Built once per connection, with that connection's context; the table is what the socket dispatches into. */
  handlers(ctx: ConnectionContext): ChannelTable;
  /** Fired exactly once per socket the server ever accepted, hello or not. */
  connectionClosed(id: string): void;
  addSink(sink: ScopedSink): () => void;
}

/** What `authenticate` says about a credential: the server owns no token policy. */
export interface UpgradeGrant {
  role: ClientRole;
  local: boolean;
  control: boolean;
}

export interface HostServerOptions {
  surface: HostSurface;
  bind: RemoteBind | "loopback";
  port: number;
  /** Directory holding the built browser bundle (index.html + assets + icon.png). */
  webRoot: string;
  /** null = unauthenticated. Called for every HTTP request and upgrade, with whatever credential was presented (or none). */
  authenticate: (presented: string | null, req: IncomingMessage) => UpgradeGrant | null;
  /** Enables /login; the server derives the session credential from `hash` and hands it to `authenticate` like any other credential. */
  password?: { salt: string; hash: string } | null;
  /** Token the manifest's start_url carries; null = bare start_url (password mode). */
  manifestToken?: (() => string | null) | null;
  hostVersion: string;
  hostProtocol?: number;
  protocolRange?: ProtocolRange;
  /** Accept a protocol-1 client whose first frame is req/notify rather than a hello. */
  allowImplicitProtocol1: boolean;
  /** Stamped on every ConnectionContext: this listener serves loopback only. */
  local: boolean;
  /** A connection-scoped event whose socket is gone. */
  onEmitMiss?: (scope: EventScope, channel: string) => void;
}

export interface HostServerHandle {
  /** The bound port — meaningful when `port: 0` asked the OS to pick one. */
  readonly port: number;
  /** Bare URLs, LAN first (lan bind) or loopback alone; see withRemoteToken for pairing links. */
  readonly urls: string[];
  readonly webBundleMissing: boolean;
  close(): Promise<void>;
  /** Closes every open socket the predicate selects with the given code — credential rotation, role eviction. */
  closeConnections(predicate: (ctx: ConnectionContext) => boolean, code: number, reason: string): void;
  /** Context of every socket currently open, hello answered or still awaited. */
  connections(): readonly ConnectionContext[];
}

const COOKIE_MAX_AGE = 31_536_000;
/** How long a 1001 close handshake gets before the socket is torn down anyway. */
const CLOSE_DRAIN_MS = 250;
/** POST /login body ceiling; a real form is a few dozen bytes. */
const MAX_LOGIN_BODY = 8192;

const MIME: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

/** Per-socket state. A socket dispatches into its own table, built with its own context. */
interface ConnState {
  readonly ctx: ConnectionContext;
  phase: "awaiting-hello" | "open";
  table: ChannelTable | null;
  closed: boolean;
}

function cookieToken(header: string | undefined): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== REMOTE_COOKIE) continue;
    // A malformed escape in the cookie is a failed credential, not a crash.
    return safeDecode(part.slice(eq + 1).trim());
  }
  return null;
}

/** Where the presented token came from — a query hit is what earns the cookie. */
type TokenSource = "header" | "query" | "cookie" | null;

function presentedToken(req: IncomingMessage, url: URL): { value: string | null; from: TokenSource } {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return { value: auth.slice("Bearer ".length).trim(), from: "header" };
  const query = url.searchParams.get(REMOTE_TOKEN_PARAM);
  if (query !== null && query !== "") return { value: query, from: "query" };
  const cookie = cookieToken(req.headers.cookie);
  if (cookie !== null) return { value: cookie, from: "cookie" };
  return { value: null, from: null };
}

function requestUrl(req: IncomingMessage): URL {
  // The host header only shapes the URL object we parse against; nothing is echoed back to
  // the client from it, so a forged Host cannot poison a response.
  return new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
}

/** `decodeURIComponent` throws on malformed escapes — attacker-controlled text must never crash main. */
function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

function manifest(token: string | null): string {
  return JSON.stringify({
    name: "omp-ui",
    short_name: "omp-ui",
    // Password mode serves a bare start_url: the session cookie carries the credential, and
    // baking a token in would outlive a password change for an installed PWA.
    start_url: token ? `./?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}` : "./",
    scope: "./",
    display: "standalone",
    background_color: "#0a0b0d",
    theme_color: "#0a0b0d",
    icons: [{ src: "./icon.png", sizes: "512x512", type: "image/png" }],
  });
}

/** Bare (token-free) URLs, LAN first, loopback last. */
function lanHosts(port: number): string[] {
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push(`http://${a.address}:${port}/`);
    }
  }
  out.push(`http://127.0.0.1:${port}/`);
  return out;
}

/** Pairing links: each bare URL with the token as its `?t=` query. */
export function withRemoteToken(urls: string[], token: string): string[] {
  return urls.map((u) => `${u}?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`);
}

/** null rather than a throw: a missing path is a routing decision here, not an error. */
async function statOrNull(file: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return null;
  }
}

export function startHostServer(opts: HostServerOptions): Promise<HostServerHandle> {
  const { surface, bind, port, webRoot, authenticate, hostVersion, allowImplicitProtocol1 } = opts;
  const hostProtocol = opts.hostProtocol ?? HOST_PROTOCOL;
  const protocolRange = opts.protocolRange ?? HOST_PROTOCOL_RANGE;
  const password = opts.password ?? null;
  // The session credential is derived from the stored hash, never from the password: a logged-in
  // browser can present it indefinitely, and it rotates the moment the hash changes.
  const sessionCred = password ? passwordSessionCredential(password.hash) : null;
  const indexFile = path.join(webRoot, "index.html");
  const webBundleMissing = !fs.existsSync(indexFile);

  const send = (res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void => {
    res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };

  // One throttle per server: a restart (config change) resetting the lockout is the
  // documented v1 behavior.
  const loginThrottle = new LoginThrottle();

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    if (webBundleMissing) {
      send(res, 503, 'omp-ui web bundle not built — run "npm run build:web"');
      return;
    }
    // Safety ordering (server.test.ts proves it): decode first, then path.resolve, then the
    // containment check below. WHATWG URL keeps percent-escapes verbatim, so encoded separators
    // only become separators here — the check after this line is what rejects them.
    const decoded = safeDecode(pathname);
    if (decoded === null) {
      send(res, 400, "bad request");
      return;
    }
    const rel = decoded.replace(/^\/+/, "");
    const resolved = path.resolve(webRoot, rel);
    const root = path.resolve(webRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      send(res, 403, "forbidden");
      return;
    }
    let file = resolved;
    let stat = await statOrNull(file);
    // SPA fallback: an extensionless unknown path is a client route, not a missing asset.
    if (stat?.isDirectory() || (stat === null && path.extname(file) === "")) {
      file = indexFile;
      stat = await statOrNull(file);
    }
    if (!stat?.isFile()) {
      send(res, 404, "not found");
      return;
    }

    const contentLength = stat.size;
    const stream = fs.createReadStream(file);
    stream.once("open", () => {
      res.writeHead(200, {
        "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
        "Content-Length": contentLength,
      });
      stream.pipe(res);
    });
    stream.once("error", (err) => {
      // Opening can lose a race with replacement/deletion after stat. Before headers this is a
      // normal missing-file response; once streaming has begun the only honest response is reset.
      if (!res.headersSent) send(res, 404, "not found");
      else res.destroy(err);
    });
  };

  const handleLogin = (req: IncomingMessage, res: ServerResponse): void => {
    const ip = req.socket.remoteAddress ?? "?";
    const retryAfter = loginThrottle.retryAfter(ip);
    if (retryAfter > 0) {
      res.writeHead(429, {
        "Content-Type": "text/html; charset=utf-8",
        "Retry-After": String(retryAfter),
      });
      res.end(loginPage(`Too many attempts. Try again in ${retryAfter}s.`));
      return;
    }

    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_LOGIN_BODY) {
        // Deliberately reset instead of replying: continuing to read an oversized unauthenticated
        // body wastes resources, while destroying the request prevents its `end` handler running.
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const contentType = req.headers["content-type"] ?? "";
      if (!contentType.includes("application/x-www-form-urlencoded")) {
        send(res, 400, "expected form-encoded body");
        return;
      }
      const params = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      const pw = params.get("password") ?? "";
      if (pw === "") {
        // An empty field is not a guess, so it is not counted against the rate limit.
        send(res, 400, loginPage("Password is required."), "text/html; charset=utf-8");
        return;
      }
      if (!password || !verifyRemotePassword(pw, password.salt, password.hash)) {
        loginThrottle.recordFailure(ip);
        send(res, 401, loginPage("Wrong password. Try again."), "text/html; charset=utf-8");
        return;
      }
      loginThrottle.clear(ip);
      res.writeHead(302, {
        // No `Secure`: plain HTTP is the v1 transport (see the settings footer's honesty note).
        "Set-Cookie": `${REMOTE_COOKIE}=${encodeURIComponent(sessionCred!)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
        Location: "/",
      });
      res.end();
    });
  };

  const server: Server = createServer((req, res) => {
    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      send(res, 400, "bad request");
      return;
    }
    const { value, from } = presentedToken(req, url);

    if (authenticate(value, req) !== null) {
      if (from === "query" && value !== null) {
        // A query hit re-sets the cookie to the exact credential presented, so a pairing link
        // (token) and the login page (session credential) both work for the WS upgrade.
        res.setHeader(
          "Set-Cookie",
          `${REMOTE_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
        );
      }
      if (url.pathname === "/healthz") {
        send(res, 200, "ok");
        return;
      }
      if (url.pathname === "/manifest.webmanifest") {
        send(res, 200, manifest(opts.manifestToken?.() ?? null), "application/manifest+json");
        return;
      }
      void serveStatic(res, url.pathname);
      return;
    }

    // --- Unauthenticated ---
    if (password === null) {
      // Token-only mode: an unauthenticated caller learns nothing beyond the fact that
      // something listens here.
      send(res, 401, "unauthorized");
      return;
    }

    // /healthz stays a bare 401 so the reconnect probe in main.web.tsx can distinguish
    // "server down" from "credential revoked".
    if (url.pathname === "/healthz") {
      send(res, 401, "unauthorized");
      return;
    }

    if (url.pathname === "/login") {
      if (req.method === "GET") {
        send(res, 200, loginPage(null), "text/html; charset=utf-8");
        return;
      }
      if (req.method === "POST") {
        handleLogin(req, res);
        return;
      }
    }

    if (req.method === "GET") {
      res.writeHead(302, { Location: "/login" });
      res.end();
      return;
    }

    send(res, 401, "unauthorized");
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const states = new WeakMap<WebSocket, ConnState>();

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      socket.destroy();
      return;
    }
    const { value } = presentedToken(req, url);
    const grant = url.pathname === REMOTE_WS_PATH ? authenticate(value, req) : null;
    if (grant === null) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    // Protocol 1 until a hello says otherwise: kind mirrors the role, version unknown.
    const ctx: ConnectionContext = {
      id: randomUUID(),
      role: grant.role,
      local: opts.local,
      control: grant.control,
      clientKind: grant.role,
      clientVersion: "",
      protocolVersion: 1,
    };
    wss.handleUpgrade(req, socket, head, (ws) => attach(ws, ctx));
  });

  const refuse = (ws: WebSocket, reason: string): void => {
    reply(
      ws,
      makeServerHello({ verdict: "incompatible", hostVersion, hostProtocol, protocolRange, reason }),
    );
    ws.close(HOST_CLOSE_INCOMPATIBLE, reason);
  };

  /** Answers the first frame's hello: a compatible verdict opens the socket, anything else closes it. */
  const greet = (ws: WebSocket, state: ConnState, hello: ClientHello): void => {
    if (hello.clientRole !== state.ctx.role) {
      refuse(ws, "role mismatch");
      return;
    }
    if (hello.clientProtocol < protocolRange.min || hello.clientProtocol > protocolRange.max) {
      refuse(
        ws,
        `protocol ${hello.clientProtocol} unsupported; host supports ${protocolRange.min}..${protocolRange.max}`,
      );
      return;
    }
    state.ctx.clientKind = hello.clientKind;
    state.ctx.clientVersion = hello.clientVersion;
    state.ctx.protocolVersion = hello.clientProtocol;
    reply(
      ws,
      makeServerHello({ verdict: "compatible", hostVersion, hostProtocol, protocolRange, reason: null }),
    );
    state.table = surface.handlers(state.ctx);
    state.phase = "open";
  };

  const attach = (ws: WebSocket, ctx: ConnectionContext): void => {
    const state: ConnState = { ctx, phase: "awaiting-hello", table: null, closed: false };
    states.set(ws, state);
    // `ws` emits receiver failures (including maxPayload close 1009) here. A
    // malformed remote client may lose its socket, but must never crash the
    // Electron main process with an uncaught exception.
    ws.on("error", () => {});
    ws.on("close", () => {
      if (state.closed) return;
      state.closed = true;
      surface.connectionClosed(ctx.id);
    });
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return; // clients never send binary — nothing upstream takes bytes.
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      const frame = parseClientFrame(parsed);
      if (frame === null) return;
      if (frame.t === "hello") {
        // Only the first frame may be a hello; a later one is noise.
        if (state.phase === "awaiting-hello") greet(ws, state, frame);
        return;
      }
      let table = state.table;
      if (table === null) {
        // First frame is req/notify: a protocol-1 client that never says hello.
        if (!allowImplicitProtocol1) {
          ws.close(HOST_CLOSE_INCOMPATIBLE, "hello required");
          return;
        }
        table = surface.handlers(ctx);
        state.table = table;
        state.phase = "open";
      }
      if (frame.t === "notify") {
        dispatchNotify(table, frame.ch, frame.args);
        return;
      }
      const id = frame.id;
      void dispatchRequest(table, frame.ch, frame.args)
        .then((value) => {
          reply(ws, makeServerResponseOk(id, value));
        })
        .catch((err: unknown) => {
          reply(ws, makeServerResponseErr(id, err instanceof Error ? err.message : String(err)));
        });
    });
  };

  /** Open sockets that have finished their hello, with their state. */
  const openStates = (): Array<[WebSocket, ConnState]> => {
    const out: Array<[WebSocket, ConnState]> = [];
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      const state = states.get(client);
      if (state !== undefined) out.push([client, state]);
    }
    return out;
  };

  // One sink for the whole server, not one per socket: the surface fans out once and we fan to clients.
  const unsink = surface.addSink((scope, channel, args) => {
    const targets: WebSocket[] = [];
    for (const [client, state] of openStates()) {
      if (state.phase !== "open") continue;
      if (scope.kind === "role" && state.ctx.role !== scope.role) continue;
      if (scope.kind === "connection" && state.ctx.id !== scope.id) continue;
      targets.push(client);
    }
    if (targets.length === 0) {
      if (scope.kind === "connection") opts.onEmitMiss?.(scope, channel);
      return;
    }
    const payload = args[1];
    // Structural detection, not a channel allowlist: any event whose second arg is bytes rides
    // a binary frame (pty:data, shell:data today).
    const frame =
      payload instanceof Uint8Array && typeof args[0] === "string"
        ? encodeBinaryEvent(channel, args[0], payload)
        : JSON.stringify(makeServerEventFrame(channel, args));
    for (const client of targets) client.send(frame);
  });

  return new Promise<HostServerHandle>((resolve, reject) => {
    const onEarlyError = (err: NodeJS.ErrnoException): void => {
      unsink();
      wss.close();
      reject(
        new Error(
          err.code === "EADDRINUSE" ? `port ${port} is already in use` : err.message,
        ),
      );
    };
    server.once("error", onEarlyError);
    server.listen(port, bind === "lan" ? "0.0.0.0" : "127.0.0.1", () => {
      server.removeListener("error", onEarlyError);
      const address = server.address();
      const bound = typeof address === "object" && address !== null ? address.port : port;
      resolve({
        urls: bind === "lan" ? lanHosts(bound) : [`http://127.0.0.1:${bound}/`],
        webBundleMissing,
        port: bound,
        close: async () => {
          unsink();
          // A graceful 1001 first so a live browser client sees "going away" and starts its
          // reconnect probe rather than a bare socket reset.
          for (const client of wss.clients) client.close(1001);
          await settledClients(wss, CLOSE_DRAIN_MS);
          wss.close();
          await new Promise<void>((done) => {
            server.close(() => done());
            // Upgraded sockets are never "idle" to the HTTP server, so a client that ignored
            // the close handshake would otherwise hold the port past this promise.
            server.closeAllConnections();
          });
        },
        closeConnections: (predicate, code, reason) => {
          for (const [client, state] of openStates()) {
            if (predicate(state.ctx)) client.close(code, reason);
          }
        },
        connections: () => openStates().map(([, state]) => state.ctx),
      });
    });
  });
}

function reply(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export {
  decodeBinaryEvent,
  encodeBinaryEvent,
  HOST_CLOSE_INCOMPATIBLE,
  HOST_PROTOCOL,
  HOST_PROTOCOL_RANGE,
  INSTANCE_CLIENT_HEADER,
  makeClientHello,
  parseServerHello,
  REMOTE_CLOSE_REVOKED,
  REMOTE_COOKIE,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
  type ClientFrame,
  type ClientHello,
  type ClientKind,
  type ClientRole,
  type ConnectionContext,
  type ProtocolRange,
  type ServerFrame,
  type ServerHello,
} from "./protocol";
export {
  hashRemotePassword,
  mintRemoteToken,
  passwordSessionCredential,
  REMOTE_PASSWORD_MAX_BYTES,
  REMOTE_PASSWORD_MIN,
  tokenMatches,
  validateRemotePassword,
  verifyRemotePassword,
  type PasswordHash,
} from "./token";
export {
  connectInstanceClient,
  InstanceConnectError,
  signInForCredential,
  type InstanceClient,
  type InstanceConnectFailure,
  type InstanceConnectOptions,
} from "./client";

/**
 * Resolves once every client socket has left OPEN/CLOSING, or after `ms` — whichever first. A
 * wedged client must not stall the caller's `close()`; the hard teardown below handles it.
 */
function settledClients(wss: WebSocketServer, ms: number): Promise<void> {
  const pending = [...wss.clients].filter((c) => c.readyState !== WebSocket.CLOSED);
  if (pending.length === 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    let left = pending.length;
    const timer = setTimeout(() => {
      for (const c of pending) c.terminate();
      resolve();
    }, ms);
    for (const c of pending) {
      c.once("close", () => {
        if (--left > 0) return;
        clearTimeout(timer);
        resolve();
      });
    }
  });
}
