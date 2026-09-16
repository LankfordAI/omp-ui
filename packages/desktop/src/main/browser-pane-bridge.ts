import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import {
  BROWSER_PANE_MAX_CDP_CLIENTS,
  BROWSER_PANE_ROOT_VERSION_WINDOW_MS,
  isObject,
} from "@omp-ui/core";
import { tokenMatches } from "@omp-ui/server";
import type { PaneContents, PaneDebugger } from "./browser-pane-contents";

// Loopback CDP bridge for one browser pane (issue #519, ADR-0029, spec 5.4).
// Chrome-flavoured CDP clients (omp's browser tools through puppeteer-core)
// expect a *browser* endpoint: `/json/version`, a root session that answers the
// `Target` domain, and a tab target they can auto-attach to. Electron's
// `webContents.debugger` is a *page*-level session with a root that only
// partially speaks `Target`. The root shim below papers over exactly that gap
// and forwards everything else verbatim — session ids included — so the pane
// stays a plain Chromium page as far as the client can tell.
//
// Two layers, split so the shim is testable without sockets:
//   createBridgeSession — the pure-ish protocol shim over one `PaneDebugger`,
//                         generic over the client handle type;
//   createBridgeListener — node:http + ws transport, gated by the pure
//                          `gateBridgeRequest` decision.

export interface BridgeListenerDeps {
  token: string;
  /** host.ensurePage — awaited before the first client is admitted or a tokened `/json/version` answers. */
  onFirstClient: () => Promise<void>;
  /** Null until the page exists. */
  pane: () => PaneContents | null;
  onClientCount: (n: number) => void;
  /** Every client command the bridge forwards to Electron (agent-state derivation). */
  onCommand: (method: string) => void;
  appVersion?: string;
  now?: () => number;
}

export interface BridgeListener {
  readonly port: number;
  /** `http://127.0.0.1:PORT/TOKEN` — the endpoint handed to the agent. */
  readonly url: string;
  close(): void;
  clientCount(): number;
}

export type CreateBridgeListener = (deps: BridgeListenerDeps) => Promise<BridgeListener>;

export interface BridgeRequest {
  remoteAddress: string | undefined;
  host: string | undefined;
  origin: string | undefined;
  url: string;
  port: number;
  token: string;
  tokenHitAt: number | null;
  now: number;
  clients: number;
}

export type BridgeGate =
  | { kind: "forbidden" }
  | { kind: "not-found" }
  | { kind: "version"; tokened: boolean }
  | { kind: "upgrade" }
  | { kind: "busy" };

/**
 * Pure decision for one HTTP request or upgrade (#531). Anything not from
 * loopback, not addressed to `127.0.0.1:PORT`, or carrying an `Origin` (a
 * browser page probing the port) is forbidden. The bare `/json/version` that
 * puppeteer insists on fetching is only answered inside a short window after
 * the tokened one, so a port scan never learns the debugger URL.
 */
export function gateBridgeRequest(req: BridgeRequest): BridgeGate {
  const addr = req.remoteAddress;
  const loopback = addr === "127.0.0.1" || addr === "::ffff:127.0.0.1" || addr === "::1";
  if (!loopback || req.host !== `127.0.0.1:${req.port}` || req.origin !== undefined) {
    return { kind: "forbidden" };
  }
  if (req.url === "/json/version") {
    const fresh =
      req.tokenHitAt !== null && req.now - req.tokenHitAt <= BROWSER_PANE_ROOT_VERSION_WINDOW_MS;
    return fresh ? { kind: "version", tokened: false } : { kind: "not-found" };
  }
  if (!req.url.startsWith("/")) return { kind: "not-found" };
  const slash = req.url.indexOf("/", 1);
  const first = slash === -1 ? req.url.slice(1) : req.url.slice(1, slash);
  const rest = slash === -1 ? "" : req.url.slice(slash);
  if (!tokenMatches(req.token, first)) return { kind: "not-found" };
  if (rest === "/json/version") return { kind: "version", tokened: true };
  if (rest === "") {
    return req.clients >= BROWSER_PANE_MAX_CDP_CLIENTS ? { kind: "busy" } : { kind: "upgrade" };
  }
  return { kind: "not-found" };
}

// ---------------------------------------------------------------- protocol shim

/** One CDP frame in either direction; only the keys present are serialised. */
export interface BridgeFrame {
  id?: number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string };
  sessionId?: string;
}

export interface BridgeSessionDeps<T> {
  debugger: PaneDebugger;
  onCommand: (method: string) => void;
  send: (client: T, frame: BridgeFrame) => void;
  /** Close the client's transport; the transport then calls `removeClient`. */
  close: (client: T) => void;
}

export interface BridgeSession<T> {
  addClient(client: T): void;
  handleClientMessage(client: T, raw: string): Promise<void>;
  /** Detaches the client's sessions from Electron; errors ignored (nested sessions die with their parent). */
  removeClient(client: T): Promise<void>;
  /** Closes every client transport (debugger detached / pane gone). */
  closeAll(): void;
}

interface TargetIds {
  pageId: string;
  /** Null when Electron's root exposes no `tab` target; auto-attach then fails loudly. */
  tabId: string | null;
}

interface SessionInfo {
  targetId: string | null;
  type: string | null;
  /** Envelope session the attach event arrived under; null for root-level attaches. */
  parent: string | null;
}

interface ClientState<T> {
  readonly handle: T;
  discovering: boolean;
  /** Insertion-ordered: the tab session first, nested page sessions after it. */
  readonly owned: Set<string>;
}

const BRIDGE_BROWSER_TARGET = {
  targetId: "omp-ui-bridge-browser",
  type: "browser",
  title: "omp-ui",
  url: "",
  attached: true,
  canAccessOpener: false,
} as const;

const TARGET_RANK: Readonly<Record<string, number>> = { tab: 0, page: 1 };

function field(value: unknown, key: string): unknown {
  return isObject(value) ? value[key] : undefined;
}

function stringField(value: unknown, key: string): string | null {
  const v = field(value, key);
  return typeof v === "string" ? v : null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function readTargetInfos(result: unknown): unknown[] {
  const infos = field(result, "targetInfos");
  return Array.isArray(infos) ? infos : [];
}

export function createBridgeSession<T>(deps: BridgeSessionDeps<T>): BridgeSession<T> {
  const dbg = deps.debugger;
  const clients = new Map<T, ClientState<T>>();
  const owner = new Map<string, ClientState<T>>();
  const sessions = new Map<string, SessionInfo>();
  /** Root `Target.attachedToTarget` params seen before the attach reply that names their owner. */
  const unowned = new Map<string, unknown>();
  let ids: Promise<TargetIds> | null = null;
  let detached = false;

  function cmd(method: string, params: object, sessionId?: string): Promise<unknown> {
    // Electron rejects an explicit `undefined` third argument; only pass it when scoped.
    return sessionId === undefined
      ? dbg.sendCommand(method, params)
      : dbg.sendCommand(method, params, sessionId);
  }

  /** A client command going to Electron verbatim. */
  function forward(method: string, params: object, sessionId?: string): Promise<unknown> {
    deps.onCommand(method);
    return cmd(method, params, sessionId);
  }

  async function learnIds(): Promise<TargetIds> {
    if (!dbg.isAttached()) dbg.attach("1.3");
    const pageId = stringField(field(await cmd("Target.getTargetInfo", {}), "targetInfo"), "targetId");
    if (pageId === null) throw new Error("the browser pane reported no page target");
    // Turns on the root target-event stream the discovering clients are fed from.
    await cmd("Target.setDiscoverTargets", { discover: true, filter: [{}] });
    const tab = readTargetInfos(await cmd("Target.getTargets", {})).find(
      (t) => stringField(t, "type") === "tab",
    );
    return { pageId, tabId: tab === undefined ? null : stringField(tab, "targetId") };
  }

  function targetIds(): Promise<TargetIds> {
    ids ??= learnIds().catch((err: unknown) => {
      ids = null;
      throw err;
    });
    return ids;
  }

  function send(c: ClientState<T>, frame: BridgeFrame): void {
    if (clients.has(c.handle)) deps.send(c.handle, frame);
  }

  function claim(c: ClientState<T>, sid: string, targetInfo: unknown, parent: string | null): void {
    owner.set(sid, c);
    c.owned.add(sid);
    sessions.set(sid, {
      targetId: stringField(targetInfo, "targetId"),
      type: stringField(targetInfo, "type"),
      parent,
    });
  }

  function release(sid: string): void {
    owner.get(sid)?.owned.delete(sid);
    owner.delete(sid);
    sessions.delete(sid);
    unowned.delete(sid);
  }

  /** Deliver the buffered root attach event for `sid` now that `c` owns it. */
  function flushUnowned(c: ClientState<T>, sid: string): void {
    const params = unowned.get(sid);
    if (params === undefined) return;
    unowned.delete(sid);
    claim(c, sid, field(params, "targetInfo"), null);
    send(c, { method: "Target.attachedToTarget", params });
  }

  async function detachOwned(c: ClientState<T>): Promise<void> {
    for (const sid of [...c.owned]) {
      // Released first so Electron's own detach notification finds no owner and is
      // dropped — the client either asked for this or is already gone.
      release(sid);
      if (detached) continue;
      try {
        await cmd("Target.detachFromTarget", { sessionId: sid });
      } catch {
        // "No session with given id": a nested page session died with its tab.
      }
    }
  }

  /** `Target.closeTarget` / `Page.close`: the client sees its targets die; the pane lives on. */
  async function fakeClose(c: ClientState<T>): Promise<void> {
    const { pageId, tabId } = await targetIds();
    for (const sid of [...c.owned].reverse()) {
      const info = sessions.get(sid);
      const frame: BridgeFrame = {
        method: "Target.detachedFromTarget",
        params: { sessionId: sid, targetId: info?.targetId ?? pageId },
      };
      if (info?.parent != null) frame.sessionId = info.parent;
      send(c, frame);
    }
    send(c, { method: "Target.targetDestroyed", params: { targetId: pageId } });
    if (tabId !== null) send(c, { method: "Target.targetDestroyed", params: { targetId: tabId } });
    await detachOwned(c);
  }

  async function handleRoot(
    c: ClientState<T>,
    method: string,
    params: object,
    reply: (result: unknown) => void,
  ): Promise<void> {
    switch (method) {
      case "Target.getBrowserContexts":
        reply({ browserContextIds: [] });
        return;
      case "Target.setDiscoverTargets": {
        c.discovering = field(params, "discover") === true;
        if (!c.discovering) {
          // Never forwarded: Electron's discovery is shared by every client.
          reply({});
          return;
        }
        await forward(method, params);
        send(c, { method: "Target.targetCreated", params: { targetInfo: BRIDGE_BROWSER_TARGET } });
        const infos = readTargetInfos(await cmd("Target.getTargets", {}));
        const rank = (t: unknown): number => TARGET_RANK[stringField(t, "type") ?? ""] ?? 2;
        for (const targetInfo of infos.sort((a, b) => rank(a) - rank(b))) {
          send(c, { method: "Target.targetCreated", params: { targetInfo } });
        }
        reply({});
        return;
      }
      case "Target.setAutoAttach": {
        // Not forwarded: a root auto-attach on Electron's page-level session would
        // spawn duplicate, paused worker sessions no client owns. The client wants
        // the tab; attach it on the client's behalf and hand over the event first.
        if (field(params, "autoAttach") !== true) {
          await detachOwned(c);
          reply({});
          return;
        }
        const ownsTab = [...c.owned].some((sid) => sessions.get(sid)?.type === "tab");
        if (!ownsTab) {
          const { tabId } = await targetIds();
          if (tabId === null) throw new Error("the browser pane exposes no tab target");
          const result = await cmd("Target.attachToTarget", { targetId: tabId, flatten: true });
          const sid = stringField(result, "sessionId");
          if (sid === null) throw new Error("Target.attachToTarget returned no sessionId");
          if (!owner.has(sid)) claim(c, sid, { targetId: tabId, type: "tab" }, null);
          flushUnowned(c, sid);
        }
        reply({});
        return;
      }
      case "Target.attachToTarget": {
        const result = await forward(method, params);
        const sid = stringField(result, "sessionId");
        if (sid !== null) {
          if (!owner.has(sid)) claim(c, sid, { targetId: stringField(params, "targetId") }, null);
          flushUnowned(c, sid);
        }
        reply(result);
        return;
      }
      case "Target.detachFromTarget": {
        const result = await forward(method, params);
        const sid = stringField(params, "sessionId");
        if (sid !== null) release(sid);
        reply(result);
        return;
      }
      case "Target.createTarget":
        reply({ targetId: (await targetIds()).pageId });
        return;
      case "Target.closeTarget":
        await fakeClose(c);
        reply({ success: true });
        return;
      case "Browser.close":
        reply({});
        deps.close(c.handle);
        return;
      default:
        reply(await forward(method, params));
    }
  }

  function onElectronMessage(_event: unknown, method: string, params: unknown, sessionId?: string): void {
    const envelope = sessionId === undefined || sessionId === "" ? null : sessionId;
    if (envelope !== null) {
      const c = owner.get(envelope);
      if (c === undefined) return;
      const sid = stringField(params, "sessionId");
      if (method === "Target.attachedToTarget" && sid !== null) {
        claim(c, sid, field(params, "targetInfo"), envelope);
      }
      send(c, { method, params, sessionId: envelope });
      if (method === "Target.detachedFromTarget" && sid !== null) release(sid);
      return;
    }
    switch (method) {
      case "Target.attachedToTarget": {
        const sid = stringField(params, "sessionId");
        if (sid === null) return;
        const c = owner.get(sid);
        if (c === undefined) {
          unowned.set(sid, params);
          return;
        }
        claim(c, sid, field(params, "targetInfo"), null);
        send(c, { method, params });
        return;
      }
      case "Target.detachedFromTarget": {
        const sid = stringField(params, "sessionId");
        if (sid === null) return;
        const c = owner.get(sid);
        if (c !== undefined) send(c, { method, params });
        release(sid);
        return;
      }
      case "Target.targetCreated":
      case "Target.targetDestroyed":
      case "Target.targetInfoChanged":
        for (const c of clients.values()) if (c.discovering) send(c, { method, params });
        return;
      default:
        return;
    }
  }

  dbg.on("message", onElectronMessage);
  dbg.on("detach", () => {
    detached = true;
    closeAll();
  });

  function closeAll(): void {
    for (const c of clients.values()) deps.close(c.handle);
  }

  return {
    addClient(handle) {
      clients.set(handle, { handle, discovering: false, owned: new Set() });
      // Overlaps target discovery with the client's first round trip; a failure
      // is retried (and surfaced) by the first command instead.
      targetIds().catch(() => {});
    },

    async handleClientMessage(handle, raw) {
      const c = clients.get(handle);
      if (c === undefined) return;
      let msg: unknown;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      const id = field(msg, "id");
      if (typeof id !== "number") return;
      const method = field(msg, "method");
      const scoped = stringField(msg, "sessionId");
      const sid = scoped === null || scoped === "" ? undefined : scoped;
      const reply = (result: unknown): void => {
        send(c, sid === undefined ? { id, result } : { id, result, sessionId: sid });
      };
      const fail = (code: number, message: string): void => {
        const error = { code, message };
        send(c, sid === undefined ? { id, error } : { id, error, sessionId: sid });
      };
      if (typeof method !== "string") {
        fail(-32600, "Message must have a string 'method' property");
        return;
      }
      const rawParams = field(msg, "params");
      const params = typeof rawParams === "object" && rawParams !== null ? rawParams : {};
      try {
        await targetIds();
        if (sid !== undefined) {
          if (method === "Page.close" || method === "Target.closeTarget") {
            await fakeClose(c);
            reply(method === "Page.close" ? {} : { success: true });
            return;
          }
          reply(await forward(method, params, sid));
          return;
        }
        await handleRoot(c, method, params, reply);
      } catch (err) {
        fail(-32000, errorMessage(err));
      }
    },

    async removeClient(handle) {
      const c = clients.get(handle);
      if (c === undefined) return;
      clients.delete(handle);
      await detachOwned(c);
    },

    closeAll,
  };
}

// ---------------------------------------------------------------- transport

function rawText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

function rejectUpgrade(socket: Duplex, status: string): void {
  socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
  socket.destroy();
}

const REJECT_STATUS: Readonly<Record<Exclude<BridgeGate["kind"], "upgrade">, string>> = {
  forbidden: "403 Forbidden",
  "not-found": "404 Not Found",
  version: "404 Not Found",
  busy: "503 Service Unavailable",
};

export const createBridgeListener: CreateBridgeListener = (deps) =>
  new Promise<BridgeListener>((resolve, reject) => {
    const now = deps.now ?? Date.now;
    const wss = new WebSocketServer({ noServer: true });
    const sockets = new Set<WebSocket>();
    /** The shim is bound to one pane instance; a recreated pane gets a fresh one. */
    let active: { pane: PaneContents; session: BridgeSession<WebSocket> } | null = null;
    let tokenHitAt: number | null = null;
    let pendingUpgrades = 0;
    let port = 0;
    let closed = false;

    const gate = (req: IncomingMessage): BridgeGate =>
      gateBridgeRequest({
        remoteAddress: req.socket.remoteAddress,
        host: req.headers.host,
        origin: req.headers.origin,
        url: req.url ?? "",
        port,
        token: deps.token,
        tokenHitAt,
        now: now(),
        clients: sockets.size + pendingUpgrades,
      });

    /** The page, created on demand; null when the host could not create it. */
    async function ensurePane(): Promise<PaneContents | null> {
      const pane = deps.pane();
      if (pane !== null) return pane;
      try {
        await deps.onFirstClient();
      } catch {
        return null;
      }
      return deps.pane();
    }

    function sessionFor(pane: PaneContents): BridgeSession<WebSocket> {
      if (active === null || active.pane !== pane) {
        active = {
          pane,
          session: createBridgeSession<WebSocket>({
            debugger: pane.debugger,
            onCommand: deps.onCommand,
            send: (ws, frame) => {
              if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
            },
            close: (ws) => ws.close(),
          }),
        };
      }
      return active.session;
    }

    async function handleHttp(req: IncomingMessage, res: ServerResponse): Promise<void> {
      const decision = gate(req);
      if (decision.kind === "forbidden") {
        res.writeHead(403);
        res.end();
        return;
      }
      if (decision.kind !== "version" || req.method !== "GET") {
        res.writeHead(404);
        res.end();
        return;
      }
      if (decision.tokened) tokenHitAt = now();
      const pane = await ensurePane();
      if (pane === null) {
        res.writeHead(503);
        res.end();
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          Browser: `omp-ui-browser-pane/${deps.appVersion ?? "0.0.0"}`,
          "Protocol-Version": "1.3",
          "User-Agent": pane.userAgent,
          webSocketDebuggerUrl: `ws://127.0.0.1:${port}/${deps.token}`,
        }),
      );
    }

    async function acceptUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
      pendingUpgrades += 1;
      let pane: PaneContents | null;
      try {
        pane = await ensurePane();
      } finally {
        pendingUpgrades -= 1;
      }
      if (socket.destroyed) return;
      if (pane === null || closed) {
        rejectUpgrade(socket, REJECT_STATUS.busy);
        return;
      }
      const session = sessionFor(pane);
      wss.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws);
        session.addClient(ws);
        deps.onClientCount(sockets.size);
        ws.on("message", (data) => {
          session.handleClientMessage(ws, rawText(data)).catch(() => {});
        });
        ws.on("close", () => {
          sockets.delete(ws);
          if (!closed) deps.onClientCount(sockets.size);
          session.removeClient(ws).catch(() => {});
        });
        ws.on("error", () => {});
      });
    }

    const server = createServer((req, res) => {
      handleHttp(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
      const decision = gate(req);
      if (decision.kind !== "upgrade") {
        rejectUpgrade(socket, REJECT_STATUS[decision.kind]);
        return;
      }
      acceptUpgrade(req, socket, head).catch(() => socket.destroy());
    });

    const onEarlyError = (err: Error): void => reject(err);
    server.on("error", onEarlyError);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", onEarlyError);
      server.on("error", () => {});
      const address = server.address();
      port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        url: `http://127.0.0.1:${port}/${deps.token}`,
        clientCount: () => sockets.size,
        close: () => {
          closed = true;
          for (const ws of sockets) ws.terminate();
          wss.close();
          server.close();
          // Upgraded sockets are never "idle" to the HTTP server; keep-alive ones are.
          server.closeAllConnections();
        },
      });
    });
  });
