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
import { tokenMatches } from "./token";

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
}

export interface RemoteServerHandle {
  readonly urls: string[];
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

function manifest(token: string): string {
  return JSON.stringify({
    name: "omp-ui",
    short_name: "omp-ui",
    start_url: `./?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`,
    scope: "./",
    display: "standalone",
    background_color: "#0a0b0d",
    theme_color: "#0a0b0d",
    icons: [{ src: "./icon.png", sizes: "512x512", type: "image/png" }],
  });
}

function lanUrls(port: number, token: string): string[] {
  const q = `/?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`;
  const out: string[] = [];
  for (const addrs of Object.values(networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== "IPv4" || a.internal) continue;
      out.push(`http://${a.address}:${port}${q}`);
    }
  }
  out.push(`http://127.0.0.1:${port}${q}`);
  return out;
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
  const indexFile = path.join(webRoot, "index.html");
  const webBundleMissing = !fs.existsSync(indexFile);

  const send = (res: ServerResponse, code: number, body: string, type = "text/plain; charset=utf-8"): void => {
    res.writeHead(code, { "Content-Type": type, "Content-Length": Buffer.byteLength(body) });
    res.end(body);
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

  const server: Server = createServer((req, res) => {
    const url = requestUrl(req);
    const { value, from } = presentedToken(req, url);
    if (!tokenMatches(token, value)) {
      // Auth precedes every route including the manifest: an unauthenticated caller learns
      // nothing beyond the fact that something listens here.
      send(res, 401, "unauthorized");
      return;
    }
    if (from === "query") {
      // No `Secure`: plain HTTP is the v1 transport (see the settings footer's honesty note).
      res.setHeader(
        "Set-Cookie",
        `${REMOTE_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${COOKIE_MAX_AGE}`,
      );
    }
    if (url.pathname === "/healthz") {
      send(res, 200, "ok");
      return;
    }
    if (url.pathname === "/manifest.webmanifest") {
      send(res, 200, manifest(token), "application/manifest+json");
      return;
    }
    serveStatic(res, url.pathname);
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = requestUrl(req);
    const { value } = presentedToken(req, url);
    if (url.pathname !== REMOTE_WS_PATH || !tokenMatches(token, value)) {
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
      resolve({
        urls:
          bind === "lan"
            ? lanUrls(bound, token)
            : [`http://127.0.0.1:${bound}/?${REMOTE_TOKEN_PARAM}=${encodeURIComponent(token)}`],
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
export { decodeBinaryEvent, encodeBinaryEvent } from "./protocol";
export type { ClientFrame, ServerFrame } from "./protocol";
export { mintRemoteToken, tokenMatches } from "./token";

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
