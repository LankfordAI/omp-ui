import { randomBytes } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import {
  LOSSY_CHANNELS,
  PANE_FRAME_CHANNELS,
  dispatchNotify,
  dispatchRequest,
  type ChannelTable,
  type RemoteBind,
} from "@omp-ui/core";
import { loginPage } from "./login-page";
import { LoginThrottle } from "./login-throttle";
import {
  encodeBinaryEvent,
  encodeFrameDelivery,
  makeServerEventFrame,
  makeServerFrameStream,
  makeServerResponseErr,
  makeServerResponseOk,
  parseClientFrame,
  parseFrameAck,
  REMOTE_COOKIE,
  REMOTE_FRAME_KEY_PARAM,
  REMOTE_FRAME_WS_PATH,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
  type ServerFrame,
} from "./protocol";
import {
  passwordSessionCredential,
  tokenMatches,
  verifyRemotePassword,
} from "./token";
import {
  WEBHOOK_BODY_MAX_BYTES,
  WEBHOOK_ID_PATTERN,
  WEBHOOK_PATH_PREFIX,
  type WebhookAuth,
} from "@omp-ui/core/webhook";
import { verifyWebhookRequest } from "./webhook-auth";
import { MCP_PATH } from "@omp-ui/core/mcp-endpoint";
import { handleMcpRequest, type McpIntake } from "./mcp";

/** What the transport needs from MainBackend — nothing about sessions, Electron, or the registry. */
export interface RemoteHost {
  handlers(): ChannelTable;
  addSink(sink: (channel: string, args: unknown[]) => void): () => void;
}

export interface RemoteServerOptions {
  host: RemoteHost;
  token: string;
  bind: RemoteBind;
  port: number;
  /** Directory holding the built browser bundle (index.html + assets + icon.png). */
  webRoot: string;
  /** Password credential; null = password auth disabled (token-only). */
  password?: { salt: string; hash: string } | null;
  /**
   * WebSocket keepalive ping cadence (issue #890). A socket that misses one
   * pong gets `terminate()`d at the next tick, releasing its FramePair when a
   * phone silently wanders off Wi-Fi. 0 disables. Tests shrink it.
   */
  keepAliveIntervalMs?: number;
  /**
   * Webhook intake (issue #997, ADR-0075). Absent, or `enabled()` false, means
   * `/webhooks/…` is not a route at all and falls through to the normal
   * unauthenticated handling.
   */
  webhooks?: WebhookIntake | null;
  /**
   * MCP endpoint intake (issue #996, ADR-0080). Absent, or `enabled()` false,
   * means `/mcp` is not a route at all and falls through to the normal
   * unauthenticated handling.
   */
  mcp?: McpIntake | null;
  /** The app version `initialize` reports as serverInfo.version. */
  version?: string;
}

/** What the route learns about one webhook id; null for an unknown id. */
export interface WebhookLookup {
  auth: WebhookAuth;
  /** Null when the stored secret no longer decrypts: every delivery is unauthorized. */
  secret: string | null;
  enabled: boolean;
}

/** Request facts handed to the intake; never the raw headers, never a credential. */
export interface WebhookRequestMeta {
  remoteAddress: string;
  event: string | null;
  deliveryId: string | null;
  contentType: string | null;
  bytes: number;
}

export type WebhookRefusal = "unauthorized" | "disabled" | "too-large" | "bad-request";

export interface WebhookAnswer {
  status: number;
  /** JSON body sent back to the caller. */
  body: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/** Main's side of the webhook route; the server owns parsing, the body cap, and authentication. */
export interface WebhookIntake {
  enabled(): boolean;
  lookup(id: string): WebhookLookup | null;
  /** A known webhook's delivery the server refused; audit only. */
  refused(id: string, reason: WebhookRefusal, meta: WebhookRequestMeta): void;
  /** An authenticated delivery with a UTF-8 body. */
  accept(id: string, meta: WebhookRequestMeta, body: string): WebhookAnswer;
}

export interface RemoteServerHandle {
  /** Primary pairing URLs: bare when a password is set, otherwise see tokenUrls. */
  readonly urls: string[];
  /** Token-bearing pairing URLs (fallback), always carrying the token. */
  readonly tokenUrls: string[];
  /** Records entry-file absence at startup; later HTTP responses check availability per request. */
  readonly webBundleMissing: boolean;
  /** The bound port — meaningful when `port: 0` asked the OS to pick one. */
  readonly port: number;
  close(): Promise<void>;
}

/** Matches core/rpc's maximum reassembled logical frame. */
const MAX_PAYLOAD = 64 * 1024 * 1024;
const COOKIE_MAX_AGE = 31_536_000;
/** How long a 1001 close handshake gets before the socket is torn down anyway. */
const CLOSE_DRAIN_MS = 250;
/** POST /login body ceiling; a real form is a few dozen bytes. */
const MAX_LOGIN_BODY = 8192;
/** Default WebSocket keepalive cadence; a missed pong costs the socket (issue #890). */
const REMOTE_KEEP_ALIVE_MS = 30_000;

interface PendingFrame {
  id: number;
  /** `${frameChannel}\u0000${tabId}`: one pending slot per pane per tab. */
  key: string;
  tabId: string;
  bytes: Uint8Array;
}

interface FramePair {
  reliable: WebSocket;
  frames: WebSocket | null;
  /** Viewer client ids keyed by `${frameChannel}\u0000${tabId}`. */
  subscriptions: Map<string, Set<string>>;
  pending: Map<string, PendingFrame>;
  inFlight: PendingFrame | null;
  replayInFlight: boolean;
}

type PaneFrameChannels = (typeof PANE_FRAME_CHANNELS)[number];

/** A tab's subscription key for one pane, so a browser viewer never receives that tab's device frames. */
function paneKey(frameChannel: string, tabId: string): string {
  return `${frameChannel}\u0000${tabId}`;
}

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

/** One header's value; a repeated header reads as absent rather than picking one. */
function singleHeader(req: IncomingMessage, name: string): string | null {
  const value = req.headers[name];
  return typeof value === "string" ? value : null;
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

function withToken(urls: string[], token: string): string[] {
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

export function startRemoteServer(opts: RemoteServerOptions): Promise<RemoteServerHandle> {
  const { host, token, bind, port, webRoot } = opts;
  const password = opts.password ?? null;
  // The session credential is derived from the stored hash, never from the password: a logged-in
  // browser can present it indefinitely, and it rotates the moment the hash changes.
  const sessionCred = password ? passwordSessionCredential(password.hash) : null;
  const root = path.resolve(webRoot);
  const indexFile = path.join(root, "index.html");
  const webBundleMissing = !fs.existsSync(indexFile);

  const send = (res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void => {
    res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  };

  /** Accepts the bearer token or the password-derived session credential. */
  const credentialMatches = (value: string | null): boolean => {
    if (value === null) return false;
    return tokenMatches(token, value) || (sessionCred !== null && tokenMatches(sessionCred, value));
  };

  // One throttle per server: a restart (config change) resetting the lockout is the
  // documented v1 behavior.
  const loginThrottle = new LoginThrottle();

  const serveStatic = async (res: ServerResponse, pathname: string): Promise<void> => {
    const indexStat = await statOrNull(indexFile);
    if (!indexStat?.isFile()) {
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
    const resolved = path.resolve(root, rel);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      send(res, 403, "forbidden");
      return;
    }
    let file = resolved;
    let stat = file === indexFile ? indexStat : await statOrNull(file);
    // SPA fallback: an extensionless unknown path is a client route, not a missing asset.
    if (stat?.isDirectory() || (stat === null && path.extname(file) === "")) {
      file = indexFile;
      stat = indexStat;
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

  // --- Webhooks (issue #997, ADR-0075) ---
  // Matched before the remote credential check and never consulting it: the remote token or
  // cookie never authenticates a delivery, and a webhook secret never opens the app.
  const webhooks = opts.webhooks ?? null;
  const handleWebhook = (req: IncomingMessage, res: ServerResponse, id: string): void => {
    const intake = webhooks!;
    const json = (code: number, body: Record<string, unknown>, extra: Record<string, string> = {}): void => {
      const text = JSON.stringify(body);
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...extra });
      res.end(text);
    };
    if (req.method !== "POST") {
      json(405, { error: "method not allowed" }, { Allow: "POST" });
      return;
    }
    const hook = intake.lookup(id);
    if (hook === null) {
      // Same answer as a bad signature: the endpoint never reveals which ids exist.
      json(401, { error: "unauthorized" });
      return;
    }
    const meta = (bytes: number): WebhookRequestMeta => ({
      remoteAddress: req.socket.remoteAddress ?? "?",
      event: singleHeader(req, "x-github-event"),
      deliveryId: singleHeader(req, "x-github-delivery"),
      contentType: singleHeader(req, "content-type"),
      bytes,
    });
    const tooLarge = (bytes: number): void => {
      intake.refused(id, "too-large", meta(bytes));
      // Stop reading an oversized body: answer 413, then drop the connection once it flushed.
      res.once("finish", () => req.destroy());
      json(413, { error: `body exceeds ${WEBHOOK_BODY_MAX_BYTES} bytes` }, { Connection: "close" });
    };
    const declared = Number(req.headers["content-length"] ?? "0");
    if (Number.isFinite(declared) && declared > WEBHOOK_BODY_MAX_BYTES) {
      tooLarge(declared);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      if (aborted) return;
      size += chunk.length;
      if (size > WEBHOOK_BODY_MAX_BYTES) {
        aborted = true;
        tooLarge(size);
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (aborted) return;
      const body = Buffer.concat(chunks);
      const facts = meta(body.length);
      // Re-read after the body: the webhook may have been removed or rotated meanwhile.
      const current = intake.lookup(id);
      if (current === null || current.secret === null || !verifyWebhookRequest(current.auth, current.secret, req.headers, body)) {
        if (current !== null) intake.refused(id, "unauthorized", facts);
        json(401, { error: "unauthorized" });
        return;
      }
      if (!current.enabled || !intake.enabled()) {
        intake.refused(id, "disabled", facts);
        json(401, { error: "unauthorized" });
        return;
      }
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        intake.refused(id, "bad-request", facts);
        json(400, { error: "body must be UTF-8 text" });
        return;
      }
      let answer: WebhookAnswer;
      try {
        answer = intake.accept(id, facts, text);
      } catch (err) {
        console.warn("[remote] webhook intake failed:", err instanceof Error ? err.message : String(err));
        json(500, { error: "internal error" });
        return;
      }
      json(
        answer.status,
        answer.body,
        answer.retryAfterSeconds === undefined ? {} : { "Retry-After": String(answer.retryAfterSeconds) },
      );
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
    if (webhooks !== null && webhooks.enabled() && url.pathname.startsWith(WEBHOOK_PATH_PREFIX)) {
      const id = url.pathname.slice(WEBHOOK_PATH_PREFIX.length);
      if (WEBHOOK_ID_PATTERN.test(id)) {
        handleWebhook(req, res, id);
        return;
      }
    }
    // MCP endpoint (issue #996, ADR-0080): matched before the remote credential check and never
    // consulting it, exactly like webhooks — a client token never opens the app.
    if (opts.mcp != null && opts.mcp.enabled() && url.pathname === MCP_PATH) {
      handleMcpRequest(req, res, opts.mcp, opts.version ?? "0.0.0");
      return;
    }
    const { value, from } = presentedToken(req, url);

    if (credentialMatches(value)) {
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
        // Password mode: bare start_url, the cookie carries the credential.
        send(res, 200, manifest(password ? null : token), "application/manifest+json");
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

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });
  const frameWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  const pairs = new Map<string, FramePair>();
  let nextFrameId = 0;
  let closing = false;

  // --- Keepalive (issue #890) ---
  // Phones that background the tab stop answering pongs; without this their
  // half-open sockets keep FramePairs (and upstream pane capture) alive forever.
  // Browsers answer pongs automatically, so a healthy client needs no change.
  const keepAliveIntervalMs = opts.keepAliveIntervalMs ?? REMOTE_KEEP_ALIVE_MS;
  const aliveSockets = new WeakMap<WebSocket, boolean>();
  const markAlive = (ws: WebSocket): void => {
    aliveSockets.set(ws, true);
    ws.on("pong", () => aliveSockets.set(ws, true));
  };
  const keepAliveTimer =
    keepAliveIntervalMs > 0
      ? setInterval(() => {
          for (const ws of [...wss.clients, ...frameWss.clients]) {
            if (aliveSockets.get(ws) === true) {
              aliveSockets.set(ws, false);
              ws.ping();
            } else {
              ws.terminate();
            }
          }
        }, keepAliveIntervalMs)
      : undefined;
  keepAliveTimer?.unref();

  const flushFrame = (pair: FramePair): void => {
    if (pair.inFlight !== null || pair.frames?.readyState !== WebSocket.OPEN) return;
    const next = pair.pending.entries().next();
    if (next.done) return;
    const [key, frame] = next.value;
    pair.pending.delete(key);
    pair.inFlight = frame;
    pair.replayInFlight = true;
    pair.frames.send(frame.bytes);
  };

  const attachFrames = (pair: FramePair, ws: WebSocket): void => {
    pair.frames = ws;
    markAlive(ws);
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary || pair.frames !== ws) return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      const ack = parseFrameAck(parsed);
      if (ack === null || ack.id !== pair.inFlight?.id) return;
      pair.inFlight = null;
      pair.replayInFlight = false;
      flushFrame(pair);
    });
    ws.on("close", () => {
      if (pair.frames !== ws) return;
      pair.frames = null;
      const frame = pair.inFlight;
      if (
        frame !== null && pair.replayInFlight && pair.subscriptions.has(frame.key) &&
        !pair.pending.has(frame.key)
      ) {
        pair.pending.set(frame.key, frame);
      }
      pair.inFlight = null;
      pair.replayInFlight = false;
    });
    flushFrame(pair);
  };

  /** Releases one viewer tuple upstream only after no live pair still holds it: two sockets from one
   *  browser share a stable client id, and the host's sink set is keyed by that id alone. */
  const releaseUpstream = (subscribe: PaneFrameChannels["subscribe"], tabId: string, clientId: string): void => {
    const pane = PANE_FRAME_CHANNELS.find((row) => row.subscribe === subscribe)!;
    const key = paneKey(pane.frame, tabId);
    for (const other of pairs.values()) {
      if (other.subscriptions.get(key)?.has(clientId) === true) return;
    }
    table.notify[subscribe](tabId, clientId, false);
  };

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    let url: URL;
    try {
      url = requestUrl(req);
    } catch {
      socket.destroy();
      return;
    }
    const { value } = presentedToken(req, url);
    if (
      closing || !credentialMatches(value) ||
      (url.pathname !== REMOTE_WS_PATH && url.pathname !== REMOTE_FRAME_WS_PATH)
    ) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    if (url.pathname === REMOTE_FRAME_WS_PATH) {
      const key = url.searchParams.get(REMOTE_FRAME_KEY_PARAM);
      const pair = key === null ? undefined : pairs.get(key);
      if (pair === undefined || pair.reliable.readyState !== WebSocket.OPEN) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      if (pair.frames !== null) {
        socket.write("HTTP/1.1 409 Conflict\r\n\r\n");
        socket.destroy();
        return;
      }
      frameWss.handleUpgrade(req, socket, head, (ws) => attachFrames(pair, ws));
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    markAlive(ws);
    const key = randomBytes(32).toString("hex");
    const pair: FramePair = {
      reliable: ws,
      frames: null,
      subscriptions: new Map(),
      pending: new Map(),
      inFlight: null,
      replayInFlight: false,
    };
    pairs.set(key, pair);
    // Let the shared notify decoder validate the tuple before recording it, then call the
    // host. A subscribe may synchronously replay the cached frame through our sink.
    const subscriptionTable: ChannelTable = {
      request: table.request,
      notify: Object.fromEntries(
        PANE_FRAME_CHANNELS.map((pane) => [
          pane.subscribe,
          (tabId: string, clientId: string, on: boolean) => {
            const subKey = paneKey(pane.frame, tabId);
            if (on) {
              let viewers = pair.subscriptions.get(subKey);
              if (viewers === undefined) {
                viewers = new Set();
                pair.subscriptions.set(subKey, viewers);
              }
              viewers.add(clientId);
              table.notify[pane.subscribe](tabId, clientId, true);
            } else {
              const viewers = pair.subscriptions.get(subKey);
              viewers?.delete(clientId);
              if (viewers?.size === 0) {
                pair.subscriptions.delete(subKey);
                pair.pending.delete(subKey);
                if (pair.inFlight?.key === subKey) pair.replayInFlight = false;
              }
              releaseUpstream(pane.subscribe, tabId, clientId);
            }
          },
        ]),
      ) as unknown as ChannelTable["notify"],
    };
    ws.on("close", () => {
      pairs.delete(key);
      // End capture upstream for the departed viewers unless another live pair holds the same tuple.
      for (const [subKey, viewers] of pair.subscriptions) {
        const pane = PANE_FRAME_CHANNELS.find((row) => subKey.startsWith(`${row.frame}\u0000`))!;
        const tabId = subKey.slice(pane.frame.length + 1);
        for (const clientId of viewers) releaseUpstream(pane.subscribe, tabId, clientId);
      }
      pair.subscriptions.clear();
      pair.pending.clear();
      pair.inFlight = null;
      pair.replayInFlight = false;
      const frames = pair.frames;
      pair.frames = null;
      if (frames !== null) {
        frames.close(1001);
        const timer = setTimeout(() => frames.terminate(), CLOSE_DRAIN_MS);
        timer.unref();
        frames.once("close", () => clearTimeout(timer));
      }
    });
    // `ws` emits receiver failures (including maxPayload close 1009) here. A
    // malformed remote client may lose its socket, but must never crash the
    // Electron main process with an uncaught exception.
    ws.on("error", () => {});
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
      if (frame.t === "notify") {
        const paneSubscribe = PANE_FRAME_CHANNELS.some((row) => row.subscribe === frame.ch);
        dispatchNotify(paneSubscribe ? subscriptionTable : table, frame.ch, frame.args);
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
    reply(ws, makeServerFrameStream(key));
  });

  // Built once per server, not per message: the handlers are stateless closures over the
  // host and nothing invalidates the table (issue #301).
  const table = host.handlers();

  // One sink for the whole server, not one per socket: the host fans out once and we fan to clients.
  const unsink = host.addSink((channel, args) => {
    const payload = args[1];
    if (LOSSY_CHANNELS.has(channel)) {
      // Lossy bytes never share the reliable socket, even before a companion has connected.
      if (!(payload instanceof Uint8Array) || typeof args[0] !== "string") return;
      const tabId = args[0];
      const subKey = paneKey(channel, tabId);
      let frame: PendingFrame | null = null;
      for (const pair of pairs.values()) {
        if (!pair.subscriptions.has(subKey) || pair.reliable.readyState !== WebSocket.OPEN) continue;
        if (frame === null) {
          nextFrameId = nextFrameId === 0xffffffff ? 1 : nextFrameId + 1;
          frame = {
            id: nextFrameId,
            key: subKey,
            tabId,
            bytes: encodeFrameDelivery(nextFrameId, channel, tabId, payload),
          };
        }
        // Replacing an entry preserves its insertion order: busy tabs cannot starve others.
        pair.pending.set(subKey, frame);
        flushFrame(pair);
      }
      return;
    }
    // Structural detection, not a channel allowlist: remaining byte events (PTY and shell)
    // retain their reliable binary format.
    const frame =
      payload instanceof Uint8Array && typeof args[0] === "string"
        ? encodeBinaryEvent(channel, args[0], payload)
        : JSON.stringify(makeServerEventFrame(channel, args));
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(frame);
    }
  });

  return new Promise<RemoteServerHandle>((resolve, reject) => {
    const onEarlyError = (err: NodeJS.ErrnoException): void => {
      unsink();
      wss.close();
      frameWss.close();
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
      const bare = bind === "lan" ? lanHosts(bound) : [`http://127.0.0.1:${bound}/`];
      resolve({
        urls: bare,
        tokenUrls: withToken(bare, token),
        webBundleMissing,
        port: bound,
        close: async () => {
          closing = true;
          clearInterval(keepAliveTimer);
          unsink();
          // A graceful 1001 first so a live browser client sees "going away" and starts its
          // reconnect probe rather than a bare socket reset.
          for (const client of wss.clients) client.close(1001);
          for (const client of frameWss.clients) client.close(1001);
          await Promise.all([
            settledClients(wss, CLOSE_DRAIN_MS),
            settledClients(frameWss, CLOSE_DRAIN_MS),
          ]);
          wss.close();
          frameWss.close();
          pairs.clear();
          await new Promise<void>((done) => {
            server.close(() => done());
            // Upgraded sockets are never "idle" to the HTTP server, so a client that ignored
            // the close handshake would otherwise hold the port past this promise.
            server.closeAllConnections();
          });
        },
      });
    });
  });
}

function reply(ws: WebSocket, frame: ServerFrame): void {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(frame));
}

export { REMOTE_CLOSE_REVOKED, REMOTE_COOKIE, REMOTE_TOKEN_PARAM, REMOTE_WS_PATH } from "./protocol";
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
export { decodeBinaryEvent, encodeBinaryEvent } from "./protocol";
export type { ClientFrame, ServerFrame } from "./protocol";
export {
  connectInstanceClient,
  InstanceConnectError,
  signInForCredential,
  type InstanceClient,
  type InstanceConnectFailure,
} from "./client";
export { mintWebhookId, mintWebhookSecret, verifyWebhookRequest, webhookSignature } from "./webhook-auth";
export { mintMcpClientId, mintMcpToken, type McpCaller, type McpIntake, type McpRequestMeta, type McpToolResult } from "./mcp";

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
