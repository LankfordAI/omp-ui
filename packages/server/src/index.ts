import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { networkInterfaces } from "node:os";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import type { ChannelTable, RemoteBind } from "@omp-ui/core";
import {
  encodeBinaryEvent,
  REMOTE_COOKIE,
  REMOTE_TOKEN_PARAM,
  REMOTE_WS_PATH,
} from "./protocol";
import {
  passwordSessionCredential,
  tokenMatches,
  verifyRemotePassword,
} from "./token";

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
}

export interface RemoteServerHandle {
  /** Primary pairing URLs: bare when a password is set, otherwise see tokenUrls. */
  readonly urls: string[];
  /** Token-bearing pairing URLs (fallback), always carrying the token. */
  readonly tokenUrls: string[];
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
/** Consecutive failures before an IP is locked out of /login. */
const LOGIN_FAIL_THRESHOLD = 5;
const LOGIN_LOCK_BASE_S = 60;
const LOGIN_LOCK_CAP_S = 900;
/** Caps the per-IP attempt map; the oldest insertion goes first. */
const LOGIN_ATTEMPTS_CAP = 10_000;

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
    return decodeURIComponent(part.slice(eq + 1).trim());
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

/**
 * The sign-in form served at /login in password mode. Inline CSS, no JS, no external assets:
 * it must render even when the web bundle is missing, and it deliberately reveals the service
 * is omp-ui to an unauthenticated caller (accepted trade-off for usability).
 */
function loginPage(error: string | null): string {
  const errorHtml = error
    ? `<p role="alert" style="margin:0 0 12px;color:#f87171;font-size:13px">${escapeHtml(error)}</p>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>omp-ui — Sign in</title>
<style>
  * { box-sizing: border-box; margin: 0; }
  body { display:flex; align-items:center; justify-content:center; min-height:100dvh;
         background:#0a0b0d; color:#c8d0da; font:14px/1.5 system-ui,sans-serif; padding:24px; }
  .card { width:100%; max-width:340px; }
  h1 { font-size:18px; font-weight:600; color:#e6ebf2; margin-bottom:4px; }
  .sub { font-size:12px; color:#8b95a3; margin-bottom:20px; }
  label { display:block; font-size:12px; color:#8b95a3; margin-bottom:6px; }
  input[type="password"] { width:100%; padding:9px 12px; border:1px solid #2a3038;
    border-radius:6px; background:#14171b; color:#e6ebf2; font:inherit; outline:none; }
  input[type="password"]:focus { border-color:#4a5568; }
  button { margin-top:12px; width:100%; padding:9px 12px; border:none; border-radius:6px;
    background:#c8d0da; color:#0a0b0d; font:inherit; font-weight:600; cursor:pointer; }
  button:hover { background:#e6ebf2; }
  .hint { margin-top:16px; font-size:11px; color:#8b95a3; text-align:center; }
</style>
</head>
<body>
<div class="card">
  <h1>omp-ui</h1>
  <p class="sub">Remote access &mdash; sign in to continue</p>
  ${errorHtml}
  <form method="post" action="/login">
    <label for="password">Password</label>
    <input id="password" name="password" type="password" required autofocus autocomplete="current-password">
    <button type="submit">Sign in</button>
  </form>
  <p class="hint">or open a pairing link with an access token</p>
</div>
</body>
</html>`;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** null rather than a throw: a missing path is a routing decision here, not an error. */
function statOrNull(file: string): fs.Stats | null {
  try {
    return fs.statSync(file);
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
  const indexFile = path.join(webRoot, "index.html");
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

  // In-memory per-IP lockout state for POST /login. Function-scoped on purpose: every
  // startRemoteServer is a fresh server, and a restart (config change) resetting the lockout is
  // the documented v1 behavior.
  const loginAttempts = new Map<string, { fails: number; until: number }>();
  const pruneLoginAttempts = (): void => {
    if (loginAttempts.size <= LOGIN_ATTEMPTS_CAP) return;
    // Map iterates in insertion order — evict the oldest first.
    for (const key of loginAttempts.keys()) {
      loginAttempts.delete(key);
      if (loginAttempts.size <= LOGIN_ATTEMPTS_CAP) break;
    }
  };
  const recordLoginFailure = (ip: string): void => {
    const entry = loginAttempts.get(ip);
    const fails = (entry?.fails ?? 0) + 1;
    let until = 0;
    if (fails >= LOGIN_FAIL_THRESHOLD) {
      until =
        Date.now() +
        Math.min(LOGIN_LOCK_BASE_S * 2 ** (fails - LOGIN_FAIL_THRESHOLD), LOGIN_LOCK_CAP_S) * 1000;
    }
    loginAttempts.set(ip, { fails, until });
    pruneLoginAttempts();
  };

  const serveStatic = (res: ServerResponse, pathname: string): void => {
    if (webBundleMissing) {
      send(res, 503, 'omp-ui web bundle not built — run "npm run build:web"');
      return;
    }
    const rel = decodeURIComponent(pathname).replace(/^\/+/, "");
    const resolved = path.resolve(webRoot, rel);
    const root = path.resolve(webRoot);
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      send(res, 403, "forbidden");
      return;
    }
    let file = resolved;
    let stat = statOrNull(file);
    // SPA fallback: an extensionless unknown path is a client route, not a missing asset.
    if (stat?.isDirectory() || (stat === null && path.extname(file) === "")) {
      file = indexFile;
      stat = statOrNull(file);
    }
    if (!stat?.isFile()) {
      send(res, 404, "not found");
      return;
    }
    const body = fs.readFileSync(file);
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file).toLowerCase()] ?? "application/octet-stream",
      "Content-Length": body.length,
    });
    res.end(body);
  };

  const handleLogin = (req: IncomingMessage, res: ServerResponse): void => {
    const ip = req.socket.remoteAddress ?? "?";
    const entry = loginAttempts.get(ip);
    if (entry !== undefined && entry.until > Date.now()) {
      const retryAfter = Math.ceil((entry.until - Date.now()) / 1000);
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
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (size > MAX_LOGIN_BODY) {
        send(res, 400, "request too large");
        return;
      }
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
        recordLoginFailure(ip);
        send(res, 401, loginPage("Wrong password. Try again."), "text/html; charset=utf-8");
        return;
      }
      loginAttempts.delete(ip);
      res.writeHead(302, {
        // No `Secure`: plain HTTP is the v1 transport (see the settings footer's honesty note).
        "Set-Cookie": `${REMOTE_COOKIE}=${encodeURIComponent(sessionCred!)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
        Location: "/",
      });
      res.end();
    });
  };

  const server: Server = createServer((req, res) => {
    const url = requestUrl(req);
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
      serveStatic(res, url.pathname);
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

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = requestUrl(req);
    const { value } = presentedToken(req, url);
    if (url.pathname !== REMOTE_WS_PATH || !credentialMatches(value)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    // `ws` emits receiver failures (including maxPayload close 1009) here. A
    // malformed remote client may lose its socket, but must never crash the
    // Electron main process with an uncaught exception.
    ws.on("error", () => {});
    ws.on("message", (raw: Buffer, isBinary: boolean) => {
      if (isBinary) return; // clients never send binary — nothing upstream takes bytes.
      let frame: unknown;
      try {
        frame = JSON.parse(raw.toString("utf8"));
      } catch {
        return;
      }
      if (frame === null || typeof frame !== "object") return;
      const f = frame as { t?: unknown; id?: unknown; ch?: unknown; args?: unknown };
      if (typeof f.ch !== "string") return;
      const args = Array.isArray(f.args) ? f.args : [];
      const table = host.handlers();
      if (f.t === "notify") {
        const notifyHandlers = table.notify as unknown as Record<
          string,
          (...args: unknown[]) => void
        >;
        const fn = notifyHandlers[f.ch];
        if (!fn) return; // unknown notify channel is ignored — there is no one to tell.
        try {
          fn(...args);
        } catch {
          // A notify has no reply channel; a throwing handler must not kill the socket.
        }
        return;
      }
      if (f.t !== "req" || typeof f.id !== "number") return;
      const id = f.id;
      const fn = (table.request as unknown as Record<string, (...args: unknown[]) => unknown>)[
        f.ch
      ];
      if (!fn) {
        reply(ws, { t: "res", id, ok: false, message: `unknown channel ${f.ch}` });
        return;
      }
      void (async () => {
        try {
          const value = await fn(...args);
          // JSON.stringify turns an undefined return into null, which every Promise<void>
          // caller ignores.
          reply(ws, { t: "res", id, ok: true, value: value ?? null });
        } catch (err) {
          reply(ws, {
            t: "res",
            id,
            ok: false,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      })();
    });
  });

  // One sink for the whole server, not one per socket: the host fans out once and we fan to clients.
  const unsink = host.addSink((channel, args) => {
    const payload = args[1];
    // Structural detection, not a channel allowlist: any event whose second arg is bytes rides
    // a binary frame (pty:data, shell:data today).
    const frame =
      payload instanceof Uint8Array && typeof args[0] === "string"
        ? encodeBinaryEvent(channel, args[0], payload)
        : JSON.stringify({ t: "ev", ch: channel, args });
    for (const client of wss.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      client.send(frame);
    }
  });

  return new Promise<RemoteServerHandle>((resolve, reject) => {
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
      const bare = bind === "lan" ? lanHosts(bound) : [`http://127.0.0.1:${bound}/`];
      resolve({
        urls: bare,
        tokenUrls: withToken(bare, token),
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
      });
    });
  });
}

function reply(ws: WebSocket, frame: unknown): void {
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
