import * as net from "node:net";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CH, type ChannelTable } from "@omp-ui/core";
import { startRemoteServer, type RemoteServerHandle, type RemoteHost } from "./index";
import { decodeBinaryEvent, REMOTE_WS_PATH } from "./protocol";
import {
  hashRemotePassword,
  mintRemoteToken,
  passwordSessionCredential,
} from "./token";

const TOKEN = mintRemoteToken();

interface FakeHost extends RemoteHost {
  /** Every notify the table received, in order. */
  readonly notified: Array<{ ch: string; args: unknown[] }>;
  /** Fires every registered sink, as MainBackend.send() does. */
  emit(channel: string, args: unknown[]): void;
}

function fakeHost(): FakeHost {
  const notified: Array<{ ch: string; args: unknown[] }> = [];
  const sinks = new Set<(channel: string, args: unknown[]) => void>();
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
    handlers: () => table,
    addSink(sink) {
      sinks.add(sink);
      return () => sinks.delete(sink);
    },
    emit(channel, args) {
      for (const sink of sinks) sink(channel, args);
    },
  };
}

const open: RemoteServerHandle[] = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const ws of sockets.splice(0)) ws.close();
  for (const h of open.splice(0)) await h.close();
});

async function serve(
  overrides: Partial<Parameters<typeof startRemoteServer>[0]> = {},
): Promise<{ handle: RemoteServerHandle; host: FakeHost; base: string }> {
  const host = (overrides.host as FakeHost | undefined) ?? fakeHost();
  const handle = await startRemoteServer({
    host,
    token: TOKEN,
    bind: "localhost",
    port: 0,
    // Deliberately absent: the static route's 503 branch is not what these cases exercise.
    webRoot: "/nonexistent-web-root",
    ...overrides,
  });
  open.push(handle);
  return { handle, host, base: `http://127.0.0.1:${handle.port}` };
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

describe("startRemoteServer auth", () => {
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

describe("startRemoteServer password auth", () => {
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

    const second = await startRemoteServer({
      host: fakeHost(),
      token: TOKEN,
      bind: "localhost",
      port,
      webRoot: "/nonexistent-web-root",
      password: hashRemotePassword("some-other-passphrase"),
    });
    open.push(second);
    const stale = await fetch(`http://127.0.0.1:${port}/healthz`, {
      headers: { cookie: `omp_ui_token=${cred}` },
    });
    expect(stale.status).toBe(401);
  });
});

describe("startRemoteServer websocket", () => {
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

  it("answers a request from the host's table", async () => {
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
    const { base, host } = await serve();
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
    expect(host.notified).toEqual([{ ch: CH.ptyWrite, args: ["tab", "x"] }]);
    // The only frame seen was the request's own reply.
    expect(replied).toBe(true);
  });

  it("drops malformed notifications and keeps the socket usable", async () => {
    const { base, host } = await serve();
    const ws = await connect(base, TOKEN);
    ws.send(JSON.stringify({ t: "notify", ch: CH.ptyWrite, args: ["tab", 42] }));
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 4, ch: CH.getState, args: [] }));
    expect(await reply).toMatchObject({ id: 4, ok: true });
    expect(host.notified).toEqual([]);
    expect(ws.readyState).toBe(WebSocket.OPEN);
  });

  it("accepts an Attachment-sized remote notification", async () => {
    const { base, host } = await serve();
    const ws = await connect(base, TOKEN);
    const payload = "x".repeat(2 * 1024 * 1024);
    ws.send(JSON.stringify({ t: "notify", ch: "pty:write", args: ["tab", payload] }));

    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "req", id: 5, ch: "state:get", args: [] }));
    await reply;
    expect(host.notified).toEqual([{ ch: "pty:write", args: ["tab", payload] }]);
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

  it("builds the host's table once per server, not per message", async () => {
    const host = fakeHost();
    let tableCalls = 0;
    const original = host.handlers;
    host.handlers = () => {
      tableCalls += 1;
      return original();
    };
    const { base } = await serve({ host });
    const ws = await connect(base, TOKEN);
    const reply = nextJson(ws);
    ws.send(JSON.stringify({ t: "notify", ch: "pty:write", args: ["tab", "x"] }));
    ws.send(JSON.stringify({ t: "req", id: 9, ch: "nope:nope", args: [] }));
    ws.send(JSON.stringify({ t: "req", id: 10, ch: "state:get", args: [] }));
    expect(await reply).toMatchObject({ id: 10, ok: true });
    expect(tableCalls).toBe(1);
  });

});

describe("startRemoteServer event fan-out", () => {
  it("mirrors one host event to every connected client", async () => {
    const { base, host } = await serve();
    const a = await connect(base, TOKEN);
    const b = await connect(base, TOKEN);
    const both = Promise.all([nextJson(a), nextJson(b)]);
    host.emit("state:changed", [{ projects: [] }]);
    expect(await both).toEqual([
      { t: "ev", ch: "state:changed", args: [{ projects: [] }] },
      { t: "ev", ch: "state:changed", args: [{ projects: [] }] },
    ]);
  });

  it("sends a byte payload as a binary frame decodeBinaryEvent resolves", async () => {
    const { base, host } = await serve();
    const ws = await connect(base, TOKEN);
    const frame = nextBinary(ws);
    host.emit("pty:data", ["tab-1", Buffer.from([1, 2, 3])]);
    const decoded = decodeBinaryEvent(new Uint8Array(await frame));
    expect(decoded?.channel).toBe("pty:data");
    expect(decoded?.tabId).toBe("tab-1");
    expect([...(decoded?.payload ?? [])]).toEqual([1, 2, 3]);
  });
});

describe("startRemoteServer lifecycle", () => {
  it("close() ends every connection and frees the port", async () => {
    const { handle, base } = await serve();
    const ws = await connect(base, TOKEN);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const port = handle.port;
    await handle.close();
    open.length = 0;
    expect(await closed).toBe(1001);

    // The port is genuinely free: a fresh server binds the same number.
    const second = await startRemoteServer({
      host: fakeHost(),
      token: TOKEN,
      bind: "localhost",
      port,
      webRoot: "/nonexistent-web-root",
    });
    open.push(second);
    expect(second.port).toBe(port);
  });

  it("rejects with a port-in-use message when the port is taken", async () => {
    const { handle } = await serve();
    await expect(
      startRemoteServer({
        host: fakeHost(),
        token: TOKEN,
        bind: "localhost",
        port: handle.port,
        webRoot: "/nonexistent-web-root",
      }),
    ).rejects.toThrow(`port ${handle.port} is already in use`);
  });

  it("reports webBundleMissing and answers the static route with a build hint", async () => {
    const { handle, base } = await serve();
    expect(handle.webBundleMissing).toBe(true);
    const res = await fetch(`${base}/?t=${TOKEN}`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('omp-ui web bundle not built — run "npm run build:web"');
  });

  it("puts the bare loopback URL first and keeps the token in tokenUrls", async () => {
    const { handle } = await serve();
    expect(handle.urls).toEqual([`http://127.0.0.1:${handle.port}/`]);
    expect(handle.tokenUrls).toEqual([`http://127.0.0.1:${handle.port}/?t=${TOKEN}`]);
  });
});

describe("startRemoteServer malformed requests", () => {
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

describe("startRemoteServer static bundle", () => {
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
