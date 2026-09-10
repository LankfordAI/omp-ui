import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { CH, type ChannelTable } from "@omp-ui/core";
import {
  startHostServer,
  withRemoteToken,
  type ConnectionContext,
  type EventScope,
  type HostServerHandle,
  type HostServerOptions,
  type HostSurface,
  type UpgradeGrant,
} from "./index";
import {
  decodeBinaryEvent,
  HOST_CLOSE_INCOMPATIBLE,
  makeClientHello,
  REMOTE_WS_PATH,
  type ClientRole,
  type ServerHello,
} from "./protocol";
import {
  hashRemotePassword,
  mintRemoteToken,
  passwordSessionCredential,
  tokenMatches,
  type PasswordHash,
} from "./token";

const TOKEN = mintRemoteToken();
/** A second credential the per-role tests grant `instance` to. */
const INSTANCE_TOKEN = mintRemoteToken();
const HOST_VERSION = "9.9.9-test";

const BROWSER_GRANT: UpgradeGrant = { role: "browser", local: false, control: false };
const INSTANCE_GRANT: UpgradeGrant = { role: "instance", local: false, control: true };

/**
 * The token policy the server used to own, now the test's: TOKEN → browser, INSTANCE_TOKEN →
 * instance, and the password-derived session credential → browser when a password is set.
 */
function tokenAuth(password: PasswordHash | null): HostServerOptions["authenticate"] {
  const sessionCred = password ? passwordSessionCredential(password.hash) : null;
  return (presented) => {
    if (presented === null) return null;
    if (tokenMatches(TOKEN, presented)) return BROWSER_GRANT;
    if (tokenMatches(INSTANCE_TOKEN, presented)) return INSTANCE_GRANT;
    if (sessionCred !== null && tokenMatches(sessionCred, presented)) return BROWSER_GRANT;
    return null;
  };
}

interface FakeSurface extends HostSurface {
  /** Every notify the table received, in order. */
  readonly notified: Array<{ ch: string; args: unknown[] }>;
  /** Every context handlers() built a table for, in order. */
  readonly built: ConnectionContext[];
  /** Every id connectionClosed() reported, in order. */
  readonly closed: string[];
  /** Fires every registered sink, as HostApplication.send() does. */
  emit(scope: EventScope, channel: string, args: unknown[]): void;
}

function fakeSurface(): FakeSurface {
  const notified: Array<{ ch: string; args: unknown[] }> = [];
  const built: ConnectionContext[] = [];
  const closed: string[] = [];
  const sinks = new Set<(scope: EventScope, channel: string, args: unknown[]) => void>();
  const table = {
    request: {
      [CH.getState]: () => ({ ok: 1 }),
      [CH.getRemoteState]: () => {
        throw new Error("nope");
      },
      [CH.getBranchDiff]: function (_project: string, base?: string | null) {
        return { base, argumentLength: arguments.length };
      },
    },
    notify: {
      [CH.ptyWrite]: (tabId: string, data: string) => {
        notified.push({ ch: CH.ptyWrite, args: [tabId, data] });
      },
    },
  } as unknown as ChannelTable;
  return {
    notified,
    built,
    closed,
    handlers(ctx) {
      // A snapshot: the server mutates its context in place when the hello lands.
      built.push({ ...ctx });
      return table;
    },
    connectionClosed(id) {
      closed.push(id);
    },
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(scope, channel, args) {
      for (const sink of sinks) sink(scope, channel, args);
    },
  };
}

const open: HostServerHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of open.splice(0)) await h.close();
});

function serverOptions(overrides: Partial<HostServerOptions> = {}): HostServerOptions {
  return {
    surface: fakeSurface(),
    bind: "loopback",
    port: 0,
    // Deliberately absent: the static route's 503 branch is not what these cases exercise.
    webRoot: "/nonexistent-web-root",
    authenticate: tokenAuth(overrides.password ?? null),
    manifestToken: overrides.password ? null : () => TOKEN,
    hostVersion: HOST_VERSION,
    allowImplicitProtocol1: true,
    local: false,
    ...overrides,
  };
}

async function serve(
  overrides: Partial<HostServerOptions> = {},
): Promise<{ handle: HostServerHandle; surface: FakeSurface; base: string }> {
  const options = serverOptions(overrides);
  const handle = await startHostServer(options);
  open.push(handle);
  return {
    handle,
    surface: options.surface as FakeSurface,
    base: `http://127.0.0.1:${handle.port}`,
  };
}

/** Opens a socket and resolves once it is OPEN; rejects if it closes first. */
function connect(base: string, token: string | null): Promise<WebSocket> {
  const url = `${base.replace("http://", "ws://")}${REMOTE_WS_PATH}${token === null ? "" : `?t=${token}`}`;
  const ws = new WebSocket(url);
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", () => reject(new Error("closed before open")));
    ws.once("error", () => {
      /* the close handler is the one that settles */
    });
  });
}

/** Next text frame as parsed JSON. */
function nextJson(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    ws.once("message", (raw: Buffer) => resolve(JSON.parse(raw.toString("utf8"))));
  });
}

/** Next close event as its code and reason. */
function nextClose(ws: WebSocket): Promise<{ code: number; reason: string }> {
  return new Promise((resolve) => {
    ws.once("close", (code: number, reason: Buffer) => resolve({ code, reason: reason.toString("utf8") }));
  });
}

/** Sends a hello for `role` and resolves with the server's answer. */
async function sayHello(
  ws: WebSocket,
  role: ClientRole,
  clientProtocol = 2,
): Promise<ServerHello> {
  const answer = nextJson(ws);
  ws.send(
    JSON.stringify(
      makeClientHello({ clientRole: role, clientKind: role, clientVersion: "1.2.3", clientProtocol }),
    ),
  );
  return (await answer) as unknown as ServerHello;
}

/** Connects with the credential for `role` and completes a compatible hello. */
async function connectOpen(base: string, role: "browser" | "instance"): Promise<WebSocket> {
  const ws = await connect(base, role === "browser" ? TOKEN : INSTANCE_TOKEN);
  const hello = await sayHello(ws, role);
  expect(hello.verdict).toBe("compatible");
  return ws;
}

function nextBinary(ws: WebSocket): Promise<Buffer> {
  return new Promise((resolve) => {
    const onMessage = (raw: Buffer, isBinary: boolean): void => {
      if (!isBinary) {
        ws.once("message", onMessage);
        return;
      }
      resolve(raw);
    };
    ws.once("message", onMessage);
  });
}

describe("startHostServer auth", () => {
  it("rejects every route without a token, manifest included", async () => {
    const { base } = await serve();
    for (const route of ["/", "/manifest.webmanifest", "/healthz"]) {
      const res = await fetch(`${base}${route}`);
      expect(res.status).toBe(401);
      expect(await res.text()).toBe("unauthorized");
    }
  });

  it("accepts a query token, sets the cookie, and then accepts the cookie alone", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/?t=${TOKEN}`, { redirect: "manual" });
    // No bundle on disk, so the static route answers 503 — the point is that auth passed.
    expect(res.status).toBe(503);
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("omp_ui_token=");
    expect(cookie).toContain("HttpOnly");

    const jar = cookie!.split(";")[0];
    const second = await fetch(`${base}/healthz`, { headers: { cookie: jar } });
    expect(second.status).toBe(200);
    expect(await second.text()).toBe("ok");
  });

  it("accepts a bearer header", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/healthz`, { headers: { authorization: `Bearer ${TOKEN}` } });
    expect(res.status).toBe(200);
  });

  it("rejects a wrong token", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/healthz?t=${mintRemoteToken()}`);
    expect(res.status).toBe(401);
  });

  it("serves the manifest with the token in start_url", async () => {
    const { base } = await serve();
    const res = await fetch(`${base}/manifest.webmanifest?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/manifest+json");
    const body = (await res.json()) as { start_url: string; display: string };
    expect(body.start_url).toContain(TOKEN);
    expect(body.display).toBe("standalone");
  });
});

const PW = "correct-horse-battery";
const PW_HASH = hashRemotePassword(PW);

/** Native form POST to /login, following no redirects. */
function postLogin(base: string, password: string): Promise<Response> {
  return fetch(`${base}/login`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
}

/** Opens a socket authenticated only by the given cookie header. */
function connectWithCookie(base: string, cookie: string): Promise<WebSocket> {
  const url = `${base.replace("http://", "ws://")}${REMOTE_WS_PATH}`;
  const ws = new WebSocket(url, { headers: { cookie } });
  sockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", () => reject(new Error("closed before open")));
    ws.once("error", () => {
      /* the close handler is the one that settles */
    });
  });
}

describe("startHostServer password auth", () => {
  it("redirects an unauthenticated GET / to /login, but /healthz stays a bare 401", async () => {
    const { base } = await serve({ password: PW_HASH });
    const res = await fetch(`${base}/`, { redirect: "manual" });
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/login");

    const health = await fetch(`${base}/healthz`);
    expect(health.status).toBe(401);
    expect(health.headers.get("location")).toBeNull();
    expect(await health.text()).toBe("unauthorized");
  });

  it("serves the login form at GET /login", async () => {
    const { base } = await serve({ password: PW_HASH });
    const res = await fetch(`${base}/login`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain('name="password"');
    expect(body).toContain('<form method="post" action="/login">');
  });

  it("answers a wrong password with 401 and an empty password with 400", async () => {
    const { base } = await serve({ password: PW_HASH });
    const wrong = await postLogin(base, "wrong-horse-battery");
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("Wrong password");

    const empty = await fetch(`${base}/login`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: "password=",
      redirect: "manual",
    });
    expect(empty.status).toBe(400);
    expect(await empty.text()).toContain("Password is required");
  });

  it("answers a correct password with a redirect and a session cookie that then works", async () => {
    const { base } = await serve({ password: PW_HASH });
    const res = await postLogin(base, PW);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("omp_ui_token=");
    expect(cookie).toContain("HttpOnly");

    const jar = cookie!.split(";")[0];
    const health = await fetch(`${base}/healthz`, { headers: { cookie: jar } });
    expect(health.status).toBe(200);
    expect(await health.text()).toBe("ok");
  });

  it("keeps the token working as a fallback while a password is set", async () => {
    const { base } = await serve({ password: PW_HASH });
    const query = await fetch(`${base}/?t=${TOKEN}`, { redirect: "manual" });
    // No bundle on disk, so the static route answers 503 — the point is that auth passed.
    expect(query.status).toBe(503);
    expect(query.headers.get("set-cookie")).toContain("omp_ui_token=");

    const bearer = await fetch(`${base}/healthz`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(bearer.status).toBe(200);
  });

  it("accepts a WS upgrade carrying only the session cookie, and rejects one with none", async () => {
    const { base } = await serve({ password: PW_HASH });
    const cred = passwordSessionCredential(PW_HASH.hash);
    const ws = await connectWithCookie(base, `omp_ui_token=${cred}`);
    expect(ws.readyState).toBe(WebSocket.OPEN);
    await expect(connectWithCookie(base, "omp_ui_token=nope")).rejects.toThrow(
      "closed before open",
    );
  });

  it("locks an IP out after five failed logins and a fresh server is not locked", async () => {
    const { base } = await serve({ password: PW_HASH });
    for (let i = 0; i < 5; i++) {
      const res = await postLogin(base, "wrong-horse-battery");
      expect(res.status, `attempt ${i + 1}`).toBe(401);
    }
    const locked = await postLogin(base, "wrong-horse-battery");
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await locked.text()).toContain("Too many attempts");
    // Even the right password is refused while locked.
    const stillLocked = await postLogin(base, PW);
    expect(stillLocked.status).toBe(429);

    // Lockout state is per-server: a fresh listener answers normally.
    const fresh = await serve({ password: PW_HASH });
    const ok = await postLogin(fresh.base, PW);
    expect(ok.status).toBe(302);
  });

  it("serves a bare manifest start_url in password mode", async () => {
    const { base } = await serve({ password: PW_HASH });
    const res = await fetch(`${base}/manifest.webmanifest`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { start_url: string };
    expect(body.start_url).toBe("./");
  });

  it("revokes old session cookies when the server restarts with a different password", async () => {
    const first = await serve({ password: PW_HASH });
    const cred = passwordSessionCredential(PW_HASH.hash);
    const health = await fetch(`${first.base}/healthz`, {
      headers: { cookie: `omp_ui_token=${cred}` },
    });
    expect(health.status).toBe(200);
    const port = first.handle.port;
    open.splice(open.indexOf(first.handle), 1);
    await first.handle.close();

    const second = await startHostServer(
      serverOptions({ port, password: hashRemotePassword("some-other-passphrase") }),
    );
    open.push(second);
    const stale = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { cookie: `omp_ui_token=${cred}` },
    });
    expect(stale.status).toBe(401);
  });

  it("hands the session cookie to authenticate on the upgrade, like any credential", async () => {
    const authenticate = vi.fn(tokenAuth(PW_HASH));
    const { base, surface } = await serve({ password: PW_HASH, authenticate });
    const login = await postLogin(base, PW);
    const jar = login.headers.get("set-cookie")!.split(";")[0];
    const cred = passwordSessionCredential(PW_HASH.hash);
    expect(jar).toBe(`omp_ui_token=${encodeURIComponent(cred)}`);

    const ws = await connectWithCookie(base, jar);
    const hello = await sayHello(ws, "browser");
    expect(hello.verdict).toBe("compatible");
    // The upgrade's grant came out of authenticate, and the connection wears its role.
    expect(authenticate).toHaveBeenLastCalledWith(cred, expect.anything());
    expect(surface.built.map((c) => c.role)).toEqual(["browser"]);
  });
});

describe("startHostServer websocket", () => {
  it("refuses an upgrade without a token and accepts one with it", async () => {
    const { base } = await serve();
    await expect(connect(base, null)).rejects.toThrow("closed before open");
    const ws = await connect(base, TOKEN);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("refuses an upgrade on a path other than /ws", async () => {
    const { base } = await serve();
    const ws = new WebSocket(`${base.replace("http://", "ws://")}/nope?t=${TOKEN}`);
    sockets.push(ws);
    await expect(
      new Promise((resolve, reject) => {
        ws.once("open", () => resolve(null));
        ws.once("close", () => reject(new Error("closed before open")));
        ws.once("error", () => {});
      }),
    ).rejects.toThrow("closed before open");
  });

  it("answers a request from the surface's table", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await reply).toEqual({ t: "res", id: 1, ok: true, value: { ok: 1 } });
  });

  it("reports a throwing handler as ok:false with its message", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 7, ch: CH.getRemoteState, args: [] }));
    expect(await reply).toEqual({ t: "res", id: 7, ok: false, message: "nope" });
  });

  it("returns a static decoder error for malformed request arguments", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 8, ch: CH.getState, args: ["do-not-echo"] }));
    expect(await reply).toEqual({
      t: "res",
      id: 8,
      ok: false,
      message: `invalid arguments for ${CH.getState}: expected at most 0`,
    });
  });

  it("normalizes a WebSocket-null trailing optional argument", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 9, ch: CH.getBranchDiff, args: ["/project", null] }));
    expect(await reply).toEqual({
      t: "res",
      id: 9,
      ok: true,
      value: { argumentLength: 2 },
    });
  });

  it("reports an unknown channel by name", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 2, ch: "nope:nope", args: [] }));
    expect(await reply).toEqual({
      t: "res",
      id: 2,
      ok: false,
      message: "unknown channel nope:nope",
    });
  });

  it("routes a notify to the notify table and replies nothing", async () => {
    const { base, surface } = await serve();
    const ws = await connect(base, TOKEN);
    let replied = false;
    ws.on("message", () => {
      replied = true;
    });
    ws.send(JSON.stringify({ t: "notify", ch: CH.ptyWrite, args: ["tab", "x"] }));
    // A round-trip through a known request proves the notify was processed first.
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 3, ch: CH.getState, args: [] }));
    await reply;
    expect(surface.notified).toEqual([{ ch: CH.ptyWrite, args: ["tab", "x"] }]);
    // The only frame seen was the request's own reply.
    expect(replied).toBe(true);
  });

  it("drops malformed notifications and keeps the socket usable", async () => {
    const { base, surface } = await serve();
    const ws = await connect(base, TOKEN);
    ws.send(JSON.stringify({ t: "notify", ch: CH.ptyWrite, args: ["tab", 42] }));
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 4, ch: CH.getState, args: [] }));
    expect(await reply).toMatchObject({ id: 4, ok: true });
    expect(surface.notified).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("accepts an Attachment-sized remote notification", async () => {
    const { base, surface } = await serve();
    const ws = await connect(base, TOKEN);
    const payload = "x".repeat(2 * 1024 * 1024);
    ws.send(JSON.stringify({ t: "notify", ch: "pty:write", args: ["tab", payload] }));

    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 5, ch: "state:get", args: [] }));
    await reply;
    expect(surface.notified).toEqual([{ ch: "pty:write", args: ["tab", payload] }]);
  });

  it("closes an over-limit client without taking down the server", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const closed = new Promise<number>((resolve) => ws.once("close", resolve));
    ws.send("x".repeat(64 * 1024 * 1024 + 1));
    expect(await closed).toBe(1009);

    const replacement = await connect(base, TOKEN);
    const reply = nextJson(replacement);
    replacement.send(JSON.stringify({ t: "req", id: 6, ch: "state:get", args: [] }));
    expect(await reply).toMatchObject({ id: 6, ok: true });
  }, 15_000);

  it("ignores non-JSON and unshaped frames without closing the socket", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    ws.send("{not json");
    ws.send(JSON.stringify({ t: "req" }));
    ws.send(JSON.stringify([1, 2, 3]));
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 4, ch: "state:get", args: [] }));
    expect(await reply).toMatchObject({ id: 4, ok: true });
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("builds the surface's table once per connection, not per message", async () => {
    const { base, surface } = await serve();
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "notify", ch: "pty:write", args: ["tab", "x"] }));
    ws.send(JSON.stringify({ t: "req", id: 9, ch: "nope:nope", args: [] }));
    ws.send(JSON.stringify({ t: "req", id: 10, ch: "state:get", args: [] }));
    expect(await reply).toMatchObject({ id: 10, ok: true });
    expect(surface.built).toHaveLength(1);
  });
});

describe("startHostServer hello", () => {
  it("answers a compatible hello and builds the table from the hello's claims", async () => {
    const { base, surface } = await serve();
    const ws = await connect(base, TOKEN);
    const hello = await sayHello(ws, "browser");
    expect(hello).toEqual({
      t: "hello",
      verdict: "compatible",
      hostVersion: HOST_VERSION,
      hostProtocol: 2,
      protocolRange: { min: 1, max: 2 },
      reason: null,
    });
    expect(surface.built).toHaveLength(1);
    expect(surface.built[0]).toMatchObject({
      role: "browser",
      local: false,
      control: false,
      clientKind: "browser",
      clientVersion: "1.2.3",
      protocolVersion: 2,
    });

    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await reply).toEqual({ t: "res", id: 1, ok: true, value: { ok: 1 } });
  });

  it("stamps the server's `local` on every context", async () => {
    const { base, surface } = await serve({ local: true });
    await connectOpen(base, "browser");
    expect(surface.built[0].local).toBe(true);
  });

  it("refuses a hello whose role contradicts the credential's grant", async () => {
    const { base, surface } = await serve();
    const ws = await connect(base, TOKEN);
    const closed = nextClose(ws);
    const hello = await sayHello(ws, "instance");
    expect(hello).toMatchObject({ verdict: "incompatible", reason: "role mismatch" });
    expect(await closed).toEqual({ code: HOST_CLOSE_INCOMPATIBLE, reason: "role mismatch" });
    expect(surface.built).toEqual([]);
  });

  it("refuses a protocol outside the host's range, naming the range", async () => {
    const { base } = await serve();
    const ws = await connect(base, TOKEN);
    const closed = nextClose(ws);
    const hello = await sayHello(ws, "browser", 3);
    const reason = "protocol 3 unsupported; host supports 1..2";
    expect(hello).toMatchObject({ verdict: "incompatible", reason });
    expect(await closed).toEqual({ code: HOST_CLOSE_INCOMPATIBLE, reason });
  });

  it("honours a narrowed protocolRange override", async () => {
    const { base } = await serve({ protocolRange: { min: 2, max: 2 } });
    const ws = await connect(base, TOKEN);
    const closed = nextClose(ws);
    const hello = await sayHello(ws, "browser", 1);
    expect(hello).toMatchObject({ reason: "protocol 1 unsupported; host supports 2..2" });
    expect((await closed).code).toBe(HOST_CLOSE_INCOMPATIBLE);
  });

  it("accepts an implicit protocol-1 client when allowed, with an unversioned context", async () => {
    const { base, surface } = await serve({ allowImplicitProtocol1: true });
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await reply).toMatchObject({ id: 1, ok: true });
    expect(surface.built[0]).toMatchObject({
      role: "browser",
      clientKind: "browser",
      clientVersion: "",
      protocolVersion: 1,
    });
  });

  it("closes an implicit protocol-1 client with 4002 when a hello is required", async () => {
    const { base, surface } = await serve({ allowImplicitProtocol1: false });
    const ws = await connect(base, TOKEN);
    const closed = nextClose(ws);
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await closed).toEqual({ code: HOST_CLOSE_INCOMPATIBLE, reason: "hello required" });
    expect(surface.built).toEqual([]);

    // The same listener still opens a hello-first client.
    await connectOpen(base, "browser");
    expect(surface.built).toHaveLength(1);
  });

  it("drops a malformed first frame and keeps waiting for the hello", async () => {
    const { base, surface } = await serve({ allowImplicitProtocol1: false });
    const ws = await connect(base, TOKEN);
    ws.send("{not json");
    ws.send(JSON.stringify({ t: "hello", clientRole: "browser" }));
    const hello = await sayHello(ws, "browser");
    expect(hello.verdict).toBe("compatible");
    expect(surface.built).toHaveLength(1);
  });

  it("ignores a second hello on an open socket", async () => {
    const { base, surface } = await serve();
    const ws = await connectOpen(base, "browser");
    ws.send(
      JSON.stringify(
        makeClientHello({ clientRole: "browser", clientKind: "browser", clientVersion: "9", clientProtocol: 2 }),
      ),
    );
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await reply).toMatchObject({ id: 1, ok: true });
    expect(surface.built).toHaveLength(1);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("builds each socket's table with its own context", async () => {
    const { base, surface, handle } = await serve();
    await connectOpen(base, "browser");
    await connectOpen(base, "instance");
    expect(surface.built.map((c) => c.role)).toEqual(["browser", "instance"]);
    expect(surface.built.map((c) => c.control)).toEqual([false, true]);
    expect(surface.built[0].id).not.toBe(surface.built[1].id);
    expect(handle.connections().map((c) => c.id).sort()).toEqual(
      surface.built.map((c) => c.id).sort(),
    );
  });
});

describe("startHostServer event fan-out", () => {
  it("mirrors one broadcast event to every open client", async () => {
    const { base, surface } = await serve();
    const a = await connectOpen(base, "browser");
    const b = await connectOpen(base, "instance");
    const both = Promise.all([nextJson(a), nextJson(b)]);
    surface.emit({ kind: "broadcast" }, "state:changed", [{ projects: [] }]);
    expect(await both).toEqual([
      { t: "ev", ch: "state:changed", args: [{ projects: [] }] },
      { t: "ev", ch: "state:changed", args: [{ projects: [] }] },
    ]);
  });

  it("sends a byte payload as a binary frame decodeBinaryEvent resolves", async () => {
    const { base, surface } = await serve();
    const ws = await connectOpen(base, "browser");
    const frame = nextBinary(ws);
    surface.emit({ kind: "broadcast" }, "pty:data", ["tab-1", Buffer.from([1, 2, 3])]);
    const raw = await frame;
    // Golden vector: kind, u16 channel length, u16 tab length, channel, tab, payload.
    expect([...raw]).toEqual([
      0x01, 0x00, 0x08, 0x00, 0x05,
      ...Buffer.from("pty:data"), ...Buffer.from("tab-1"),
      1, 2, 3,
    ]);
    const decoded = decodeBinaryEvent(new Uint8Array(raw));
    expect(decoded?.channel).toBe("pty:data");
    expect(decoded?.tabId).toBe("tab-1");
    expect([...(decoded?.payload ?? [])]).toEqual([1, 2, 3]);
  });

  it("does not deliver to a socket still awaiting its hello", async () => {
    const { base, surface } = await serve();
    const opened = await connectOpen(base, "browser");
    const waiting = await connect(base, TOKEN);
    let leaked = false;
    waiting.on("message", () => {
      leaked = true;
    });
    const got = nextJson(opened);
    surface.emit({ kind: "broadcast" }, "state:changed", [1]);
    expect(await got).toEqual({ t: "ev", ch: "state:changed", args: [1] });
    expect(leaked).toBe(false);
  });

  it("delivers a role-scoped event only to sockets of that role", async () => {
    const { base, surface } = await serve();
    const browser = await connectOpen(base, "browser");
    const instance = await connectOpen(base, "instance");
    let browserGot = 0;
    browser.on("message", () => {
      browserGot += 1;
    });
    const got = nextJson(instance);
    surface.emit({ kind: "role", role: "instance" }, "peer:only", ["x"]);
    expect(await got).toEqual({ t: "ev", ch: "peer:only", args: ["x"] });
    // A round-trip on the browser socket proves nothing else was queued ahead of it.
    const reply = nextJson(browser);
    browser.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    await reply;
    expect(browserGot).toBe(1);
  });

  it("delivers a connection-scoped event to exactly that socket", async () => {
    const { base, surface } = await serve();
    const a = await connectOpen(base, "browser");
    const b = await connectOpen(base, "browser");
    const [ctxA] = surface.built;
    let bGot = 0;
    b.on("message", () => {
      bGot += 1;
    });
    const got = nextJson(a);
    surface.emit({ kind: "connection", id: ctxA.id }, "you:only", [7]);
    expect(await got).toEqual({ t: "ev", ch: "you:only", args: [7] });
    const reply = nextJson(b);
    b.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    await reply;
    expect(bGot).toBe(1);
  });

  it("reports a connection-scoped event for a gone socket through onEmitMiss", async () => {
    const onEmitMiss = vi.fn();
    const { base, surface } = await serve({ onEmitMiss });
    const ws = await connectOpen(base, "browser");
    const [ctx] = surface.built;
    ws.close();
    await vi.waitFor(() => expect(surface.closed).toEqual([ctx.id]));
    surface.emit({ kind: "connection", id: ctx.id }, "you:only", [7]);
    expect(onEmitMiss).toHaveBeenCalledWith({ kind: "connection", id: ctx.id }, "you:only");

    // A broadcast into an empty room is silence, not a miss.
    surface.emit({ kind: "broadcast" }, "state:changed", []);
    expect(onEmitMiss).toHaveBeenCalledTimes(1);
  });
});

describe("startHostServer lifecycle", () => {
  it("close() ends every connection and frees the port", async () => {
    const { handle, base } = await serve();
    const ws = await connect(base, TOKEN);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const port = handle.port;
    await handle.close();
    open.length = 0;
    expect(await closed).toBe(1001);

    // The port is genuinely free: a fresh server binds the same number.
    const second = await startHostServer(serverOptions({ port }));
    open.push(second);
    expect(second.port).toBe(port);
  });

  it("reports connectionClosed exactly once per socket, including sockets close() tears down", async () => {
    const { handle, base, surface } = await serve();
    const a = await connectOpen(base, "browser");
    const b = await connectOpen(base, "instance");
    // A socket that never said hello is still a connection the surface hears about.
    await connect(base, TOKEN);
    const [ctxA, ctxB] = surface.built;
    a.close();
    await vi.waitFor(() => expect(surface.closed).toEqual([ctxA.id]));
    const bClosed = nextClose(b);
    open.splice(open.indexOf(handle), 1);
    await handle.close();
    expect((await bClosed).code).toBe(1001);
    await vi.waitFor(() => expect(surface.closed).toHaveLength(3));
    expect(surface.closed.filter((id) => id === ctxA.id)).toHaveLength(1);
    expect(surface.closed.filter((id) => id === ctxB.id)).toHaveLength(1);
    expect(new Set(surface.closed).size).toBe(3);
  });

  it("closeConnections() closes the matching sockets with the given code and keeps listening", async () => {
    const { handle, base, surface } = await serve();
    const browser = await connectOpen(base, "browser");
    const instance = await connectOpen(base, "instance");
    const browserClosed = nextClose(browser);
    let instanceClosed = false;
    instance.once("close", () => {
      instanceClosed = true;
    });
    handle.closeConnections((ctx) => ctx.role === "browser", 4001, "credential rotated");
    expect(await browserClosed).toEqual({ code: 4001, reason: "credential rotated" });
    expect(instanceClosed).toBe(false);
    await vi.waitFor(() => expect(handle.connections().map((c) => c.role)).toEqual(["instance"]));

    handle.closeConnections(() => true, 4001, "credential rotated");
    await vi.waitFor(() => expect(instanceClosed).toBe(true));
    expect(handle.connections()).toEqual([]);

    // The listener itself is untouched: a fresh client pairs and is served.
    const fresh = await connectOpen(base, "browser");
    const reply = nextJson(fresh);
    fresh.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));
    expect(await reply).toMatchObject({ id: 1, ok: true });
    expect(surface.built).toHaveLength(3);
  });

  it("rejects with a port-in-use message when the port is taken", async () => {
    const { handle } = await serve();
    await expect(
      startHostServer(serverOptions({ port: handle.port })),
    ).rejects.toThrow(`port ${handle.port} is already in use`);
  });

  it("reports webBundleMissing and answers the static route with a build hint", async () => {
    const { handle, base } = await serve();
    expect(handle.webBundleMissing).toBe(true);
    const res = await fetch(`${base}/?t=${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('omp-ui web bundle not built — run "npm run build:web"');
  });

  it("reports bare URLs; withRemoteToken builds the pairing links", async () => {
    const { handle } = await serve();
    expect(handle.urls).toEqual([`http://127.0.0.1:${handle.port}/`]);
    expect(withRemoteToken(handle.urls, TOKEN)).toEqual([
      `http://127.0.0.1:${handle.port}/?t=${encodeURIComponent(TOKEN)}`,
    ]);
  });
});

describe("startHostServer malformed requests", () => {
  // One malformed escape anywhere in attacker-controlled text must never crash main: the
  // process installs no uncaughtException handler, so a throw here would kill the whole app.

  function tempWebRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-malformed-"));
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
    return dir;
  }

  it("401s a cookie with a malformed percent-escape and keeps serving", async () => {
    const root = tempWebRoot();
    try {
      const { handle } = await serve({ webRoot: root });
      // Cookie-only (no query token): the malformed value must fail as a credential, not throw.
      const bad = await rawGetWithHeader(handle.port, "/", "Cookie: omp_ui_token=%ZZ");
      expect(bad.status).toBe(401);
      const good = await rawGet(handle.port, `/healthz?t=${TOKEN}`);
      expect(good.status).toBe(200);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("400s a malformed percent-escape in the path and keeps serving", async () => {
    const root = tempWebRoot();
    try {
      const { handle } = await serve({ webRoot: root });
      const bad = await rawGet(handle.port, `/%ZZ?t=${TOKEN}`);
      expect(bad.status).toBe(400);
      expect(bad.body).toBe("bad request");
      const good = await rawGet(handle.port, `/healthz?t=${TOKEN}`);
      expect(good.status).toBe(200);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("400s a target Node's parser accepts but WHATWG URL rejects", async () => {
    // An invalid bracketed IPv6 authority in absolute form: llhttp keeps it verbatim in
    // req.url (verified), `new URL` then throws TypeError inside requestUrl().
    const { handle } = await serve();
    const bad = await rawGet(handle.port, "http://[bad/");
    expect(bad.status).toBe(400);
    expect(bad.body).toBe("bad request");
    const good = await rawGet(handle.port, `/healthz?t=${TOKEN}`);
    expect(good.status).toBe(200);
  });

  it("destroys the socket on an upgrade whose target WHATWG URL rejects", async () => {
    const { handle } = await serve();
    // The upgrade handler's catch path: no 401 write, no TypeError escaping — just a dead socket.
    await expect(rawUpgrade(handle.port, "http://[bad/")).rejects.toThrow();
    const good = await rawGet(handle.port, `/healthz?t=${TOKEN}`);
    expect(good.status).toBe(200);
  });
});

describe("startHostServer static bundle", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function webRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-web-"));
    roots.push(dir);
    fs.writeFileSync(path.join(dir, "index.html"), "<!doctype html><div id=root></div>");
    fs.mkdirSync(path.join(dir, "assets"));
    fs.writeFileSync(path.join(dir, "assets", "app.js"), "export const x = 1;\n");
    fs.writeFileSync(path.join(dir, "icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    return dir;
  }

  it("serves index.html, hashed assets, and the icon with correct MIME", async () => {
    const { base, handle } = await serve({ webRoot: webRoot() });
    expect(handle.webBundleMissing).toBe(false);

    const index = await fetch(`${base}/?t=${TOKEN}`);
    expect(index.status).toBe(200);
    expect(index.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(await index.text()).toContain('id=root');

    const js = await fetch(`${base}/assets/app.js?t=${TOKEN}`);
    expect(js.status).toBe(200);
    expect(js.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(js.headers.get("content-length")).toBe(String(Buffer.byteLength("export const x = 1;\n")));
    expect(await js.text()).toBe("export const x = 1;\n");
    const png = await fetch(`${base}/icon.png?t=${TOKEN}`);
    expect(png.status).toBe(200);
    expect(png.headers.get("content-type")).toBe("image/png");
  });

  it.skipIf(
    process.platform === "win32" || typeof process.getuid !== "function" || process.getuid() === 0,
  )("404s when a statted asset cannot be opened before headers", async () => {
    const root = webRoot();
    const file = path.join(root, "assets", "app.js");
    fs.chmodSync(file, 0o000);
    try {
      const { base } = await serve({ webRoot: root });
      const res = await fetch(`${base}/assets/app.js?t=${TOKEN}`);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe("not found");
    } finally {
      fs.chmodSync(file, 0o600);
    }
  });

  it("falls back to index.html for an extensionless client route", async () => {
    const { base } = await serve({ webRoot: webRoot() });
    const res = await fetch(`${base}/some/spa/route?t=${TOKEN}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("id=root");
  });

  it("404s a missing asset rather than serving index.html", async () => {
    const { base } = await serve({ webRoot: webRoot() });
    const res = await fetch(`${base}/assets/gone.js?t=${TOKEN}`);
    expect(res.status).toBe(404);
  });

  it("refuses to escape webRoot", async () => {
    const root = webRoot();
    // The secret sits beside the bundle, exactly where a traversal would aim.
    fs.writeFileSync(path.join(root, "..", "outside.txt"), "secret");
    const { handle } = await serve({ webRoot: root });
    // `%2f` is the traversal that survives: WHATWG URL collapses a literal `/../`, but leaves an
    // encoded slash alone, so `..` only reappears at the decodeURIComponent the static route does.
    // Raw http because fetch rewrites the request-target before it hits the wire.
    const res = await rawGet(handle.port, `/%2e%2e%2foutside.txt?t=${TOKEN}`);
    expect(res.status).toBe(403);
    expect(res.body).not.toContain("secret");
  });

  it("normalizes a literal parent segment instead of leaking through it", async () => {
    const root = webRoot();
    fs.writeFileSync(path.join(root, "..", "outside.txt"), "secret");
    const { handle } = await serve({ webRoot: root });
    const res = await rawGet(handle.port, `/../outside.txt?t=${TOKEN}`);
    expect(res.body).not.toContain("secret");
  });
});

/**
 * A GET with the request-target written by hand. `fetch` resolves `..` client-side, so this is
 * the only way to put a traversal on the wire for the server's guard to reject.
 */
function rawGet(port: number, target: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\n\r\n`);
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(raw.slice(9, 12));
      resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
    });
  });
}

/** `rawGet` with one extra header line (used to forge a cookie without a fetch credential store). */
function rawGetWithHeader(
  port: number,
  target: string,
  header: string,
): Promise<{ status: number; body: string }> {
  // Executor form (not Promise.withResolvers): the node tsconfig lib is ES2022.
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${header}\r\nConnection: close\r\n\r\n`,
      );
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("error", reject);
    socket.on("close", () => {
      const status = Number(raw.slice(9, 12));
      resolve({ status, body: raw.slice(raw.indexOf("\r\n\r\n") + 4) });
    });
  });
}

/**
 * An upgrade request whose socket the server is expected to destroy without a response.
 * Resolves only if bytes arrive (a leaked reply); rejects when the socket dies silent.
 */
function rawUpgrade(port: number, target: string): Promise<never> {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, "127.0.0.1", () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n` +
          "Upgrade: websocket\r\nConnection: Upgrade\r\n\r\n",
      );
    });
    let raw = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      raw += chunk;
    });
    socket.on("error", () => {
      /* destroyed by the server: the expected path; close settles */
    });
    socket.on("close", () => {
      if (raw.length > 0) resolve(raw as never);
      else reject(new Error("socket destroyed without a response"));
    });
  });
}
