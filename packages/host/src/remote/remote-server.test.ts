import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { CH } from "@omp-ui/core";
import type { RemoteState } from "@omp-ui/core/types";
import {
  HOST_PROTOCOL,
  makeClientHello,
  parseServerHello,
  REMOTE_WS_PATH,
} from "@omp-ui/server/protocol";
import { HostApplication } from "../host-application";
import { bindConnection, hostDeps, testHost, type BoundConnection } from "../test/fixtures";

let base: string;
let ipc: BoundConnection;
let registryFile: string;

const invoke = (channel: string, ...args: unknown[]): Promise<unknown> => ipc.invoke(channel, ...args);

/** Every remote:state push the desktop connection saw so far, newest last. */
function pushes(of: BoundConnection = ipc): RemoteState[] {
  return of.sent
    .filter((s) => s.channel === CH.onRemoteState)
    .map((s) => s.args[0] as RemoteState);
}

function lastPush(of: BoundConnection = ipc): RemoteState {
  const last = pushes(of).at(-1);
  if (!last) throw new Error("no remote:state push observed");
  return last;
}

function registryToken(): string {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    settings: { remoteToken: string };
  };
  return raw.settings.remoteToken;
}

const openSockets: WebSocket[] = [];

/** A browser-role protocol-2 client: opens, says hello, and resolves on the compatible verdict. */
function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${REMOTE_WS_PATH}?t=${token}`);
  openSockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => {
      ws.send(
        JSON.stringify(
          makeClientHello({
            clientRole: "browser",
            clientKind: "browser",
            clientVersion: "0.0.0",
            clientProtocol: HOST_PROTOCOL,
          }),
        ),
      );
      ws.once("message", (raw: Buffer) => {
        const hello = parseServerHello(JSON.parse(raw.toString("utf8")));
        if (hello?.verdict === "compatible") resolve(ws);
        else reject(new Error(`hello refused: ${hello?.reason ?? "not a hello"}`));
      });
    });
    ws.once("close", () => reject(new Error("closed before open")));
    ws.once("error", () => {});
  });
}

/** Native form POST to /login on the given port, following no redirects. */
function postLogin(port: number, password: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/login`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Not pooled: a password set/clear restarts the server, and a keep-alive socket into the
      // old listener would race its closeAllConnections() on the next request.
      connection: "close",
    },
    body: `password=${encodeURIComponent(password)}`,
    redirect: "manual",
  });
}

function registryPassword(): { hash: string; salt: string } {
  const raw = JSON.parse(fs.readFileSync(registryFile, "utf8")) as {
    settings: { remotePasswordHash: string; remotePasswordSalt: string };
  };
  return { hash: raw.settings.remotePasswordHash, salt: raw.settings.remotePasswordSalt };
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-remote-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
  // No webRoot: the transport is what this suite exercises, and the 503 static branch is
  // covered by packages/server's own suite.
  ipc = testHost(registryFile);
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.close();
  // shutdown awaits the remote listener's close, so the next test does not race a closing
  // listener onto its own port.
  await ipc.host.shutdown();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("remote server lifecycle", () => {
  it("reports stopped with a minted token on a fresh registry", async () => {
    const state = (await invoke(CH.getRemoteState)) as RemoteState;
    expect(state.status).toBe("stopped");
    expect(state.enabled).toBe(false);
    expect(state.bind).toBe("localhost");
    expect(state.port).toBe(4677);
    // Minted at construction so the settings page always has one to reveal.
    expect(state.token).not.toBe("");
    expect(state.token).toBe(registryToken());
    expect(state.urls).toEqual([]);
  });

  it("starts listening on enable and answers /healthz with the token", async () => {
    await invoke(CH.setRemotePort, 45677);
    await invoke(CH.setRemoteEnabled, true);

    const state = lastPush();
    expect(state.status).toBe("listening");
    expect(state.enabled).toBe(true);
    expect(state.urls[0]).toContain("127.0.0.1");
    expect(state.urls[0]).toContain(state.token);

    const res = await fetch(`http://127.0.0.1:45677/healthz?t=${state.token}`);
    expect(res.status).toBe(200);
    // The starting→listening transition is published, never skipped.
    expect(pushes().map((p) => p.status)).toContain("starting");
  });

  it("restarts onto a new port without touching sessions", async () => {
    await invoke(CH.setRemotePort, 45678);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;
    const before = ipc.host.liveCount;

    await invoke(CH.setRemotePort, 45679);
    expect(lastPush().port).toBe(45679);
    expect(lastPush().status).toBe("listening");

    const moved = await fetch(`http://127.0.0.1:45679/healthz?t=${token}`);
    expect(moved.status).toBe(200);
    // The old port is genuinely released.
    await expect(fetch(`http://127.0.0.1:45678/healthz?t=${token}`)).rejects.toThrow();
    expect(ipc.host.liveCount).toBe(before);
  });

  it("rejects an out-of-range port and keeps the server where it was", async () => {
    await invoke(CH.setRemotePort, 45680);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;

    await expect(invoke(CH.setRemotePort, 80)).rejects.toThrow(
      "port must be a whole number between 1024 and 65535",
    );
    expect(lastPush().port).toBe(45680);
    const still = await fetch(`http://127.0.0.1:45680/healthz?t=${token}`);
    expect(still.status).toBe(200);
  });

  it("regenerating the token drops connected clients and 401s the old token without restarting", async () => {
    await invoke(CH.setRemotePort, 45681);
    await invoke(CH.setRemoteEnabled, true);
    const oldToken = lastPush().token;
    const oldUrls = lastPush().urls;

    const ws = await connect(45681, oldToken);
    const closed = new Promise<number>((resolve) => ws.once("close", (code) => resolve(code)));
    const before = pushes().length;

    await invoke(CH.regenerateRemoteToken);
    expect(await closed).toBe(4001);

    // One push, straight to listening: a restart would have gone through "starting" first.
    expect(pushes().slice(before).map((p) => p.status)).toEqual(["listening"]);
    const state = lastPush();
    expect(state.port).toBe(45681);
    expect(state.token).not.toBe(oldToken);
    expect(state.token).toBe(registryToken());
    expect(state.urls).not.toEqual(oldUrls);
    expect(state.urls[0]).toContain(state.token);

    const stale = await fetch(`http://127.0.0.1:45681/healthz?t=${oldToken}`);
    expect(stale.status).toBe(401);
    const fresh = await fetch(`http://127.0.0.1:45681/healthz?t=${state.token}`);
    expect(fresh.status).toBe(200);
    // The new token joins over the same listener.
    await connect(45681, state.token);
  });

  it("mirrors a state broadcast to a connected remote client", async () => {
    await invoke(CH.setRemotePort, 45682);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;
    const ws = await connect(45682, token);

    const frame = new Promise<Record<string, unknown>>((resolve) => {
      const onMessage = (raw: Buffer): void => {
        const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (parsed.ch === CH.onStateChanged) resolve(parsed);
        else ws.once("message", onMessage);
      };
      ws.once("message", onMessage);
    });

    // Any registry mutation broadcasts; addProject is the cheapest one with no child process.
    await invoke(CH.addProject, base);
    const ev = await frame;
    expect(ev.t).toBe("ev");
    expect(ev.ch).toBe(CH.onStateChanged);
  });

  it("serves a request from the shared handler table over the socket", async () => {
    await invoke(CH.setRemotePort, 45683);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;
    const ws = await connect(45683, token);

    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (raw: Buffer) =>
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>),
      );
    });
    ws.send(JSON.stringify({ t: "req", id: 1, ch: CH.getState, args: [] }));

    const res = await reply;
    expect(res).toMatchObject({ t: "res", id: 1, ok: true });
    // Every client sees the same BackendState shape, whatever its role.
    expect(res.value).toHaveProperty("projects");
  });

  it("disabling stops the listener and frees the port", async () => {
    await invoke(CH.setRemotePort, 45684);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;
    expect((await fetch(`http://127.0.0.1:45684/healthz?t=${token}`)).status).toBe(200);

    await invoke(CH.setRemoteEnabled, false);
    expect(lastPush().status).toBe("stopped");
    expect(lastPush().urls).toEqual([]);
    await expect(fetch(`http://127.0.0.1:45684/healthz?t=${token}`)).rejects.toThrow();
  });

  it("publishes an error status when the port is already taken", async () => {
    await invoke(CH.setRemotePort, 45685);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;

    // A second host against the same port is the realistic collision.
    const other = bindConnection(new HostApplication(hostDeps(path.join(base, "other.json"))));
    try {
      await other.invoke(CH.setRemotePort, 45685);
      await other.invoke(CH.setRemoteEnabled, true);
      const otherState = lastPush(other);

      expect(otherState.status).toBe("error");
      expect(otherState.error).toBe("port 45685 is already in use");
    } finally {
      await other.host.shutdown();
    }

    // The original listener is untouched by the failed start.
    expect((await fetch(`http://127.0.0.1:45685/healthz?t=${token}`)).status).toBe(200);
  });

  it("keeps serving remote clients after the desktop window is gone", async () => {
    await invoke(CH.setRemotePort, 45686);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;
    const ws = await connect(45686, token);

    // broadcast() must not depend on the desktop connection, or remote clients starve.
    ipc.unbind();
    ipc.host.connectionClosed(ipc.ctx.id);
    const frame = new Promise<Record<string, unknown>>((resolve) => {
      const onMessage = (raw: Buffer): void => {
        const parsed = JSON.parse(raw.toString("utf8")) as Record<string, unknown>;
        if (parsed.ch === CH.onStateChanged) resolve(parsed);
        else ws.once("message", onMessage);
      };
      ws.once("message", onMessage);
    });
    await invoke(CH.addProject, base);
    expect((await frame).ch).toBe(CH.onStateChanged);
  });
});

describe("remote password sign-in", () => {
  it("setting a password switches primary URLs to bare and keeps the token fallback", async () => {
    await invoke(CH.setRemotePort, 45688);
    await invoke(CH.setRemoteEnabled, true);
    await invoke(CH.setRemotePassword, "correct-horse-battery");

    const state = lastPush();
    expect(state.status).toBe("listening");
    expect(state.hasPassword).toBe(true);
    expect(state.urls[0]).toBe("http://127.0.0.1:45688/");
    expect(state.urls[0]).not.toContain("?t=");
    expect(state.tokenUrls[0]).toContain(state.token);

    // Only the salted hash is persisted — never the password itself.
    const { hash, salt } = registryPassword();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(salt).toMatch(/^[0-9a-f]{32}$/);
    expect(fs.readFileSync(registryFile, "utf8")).not.toContain("correct-horse-battery");
  });

  it("rejects a too-short password without persisting", async () => {
    await expect(invoke(CH.setRemotePassword, "short")).rejects.toThrow(/at least 8 characters/);
    const state = (await invoke(CH.getRemoteState)) as RemoteState;
    expect(state.hasPassword).toBe(false);
    expect(registryPassword().hash).toBe("");
  });

  it("password login works end to end", async () => {
    await invoke(CH.setRemotePort, 45689);
    await invoke(CH.setRemoteEnabled, true);
    await invoke(CH.setRemotePassword, "correct-horse-battery");

    const res = await postLogin(45689, "correct-horse-battery");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/");
    const cookie = res.headers.get("set-cookie");
    expect(cookie).toContain("omp_ui_token=");
    const jar = cookie!.split(";")[0];
    expect(
      (await fetch(`http://127.0.0.1:45689/healthz`, { headers: { cookie: jar } })).status,
    ).toBe(200);

    const anon = await fetch("http://127.0.0.1:45689/", { redirect: "manual" });
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/login");
  });

  it("clearing the password restores token-only behavior", async () => {
    await invoke(CH.setRemotePort, 45690);
    await invoke(CH.setRemoteEnabled, true);
    await invoke(CH.setRemotePassword, "correct-horse-battery");
    expect(lastPush().hasPassword).toBe(true);

    await invoke(CH.clearRemotePassword);
    const cleared = lastPush();
    expect(cleared.hasPassword).toBe(false);
    expect(cleared.urls[0]).toContain(cleared.token);
    expect(cleared.tokenUrls[0]).toContain(cleared.token);
    expect(registryPassword().hash).toBe("");

    const anon = await fetch("http://127.0.0.1:45690/", { redirect: "manual" });
    expect(anon.status).toBe(401);
    expect(anon.headers.get("location")).toBeNull();
  });

  it("changing the password drops connected clients and revokes old cookies", async () => {
    await invoke(CH.setRemotePort, 45691);
    await invoke(CH.setRemoteEnabled, true);
    await invoke(CH.setRemotePassword, "correct-horse-battery");

    const login = await postLogin(45691, "correct-horse-battery");
    const jar = login.headers.get("set-cookie")!.split(";")[0];
    expect(
      (
        await fetch(`http://127.0.0.1:45691/healthz`, {
          headers: { cookie: jar, connection: "close" },
        })
      ).status,
    ).toBe(200);

    const ws = await connect(45691, lastPush().token);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));

    await invoke(CH.setRemotePassword, "some-other-passphrase");
    await closed;
    expect(lastPush().hasPassword).toBe(true);

    // The first password's session credential is dead; the token still works.
    const stale = await fetch(`http://127.0.0.1:45691/healthz`, { headers: { cookie: jar } });
    expect(stale.status).toBe(401);
    const token = lastPush().token;
    expect(
      (await fetch(`http://127.0.0.1:45691/healthz?t=${token}`)).status,
    ).toBe(200);
  });
});
