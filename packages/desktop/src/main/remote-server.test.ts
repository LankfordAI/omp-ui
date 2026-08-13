import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import type { RemoteState } from "@omp-ui/core/types";

// The real MainBackend imports electron; stub the surfaces it touches (shell.test.ts's pattern).
const handlers = new Map<string, (e: unknown, ...args: unknown[]) => unknown>();
vi.mock("electron", () => ({
  app: { isPackaged: false, getVersion: () => "0.0.0", getPath: () => os.tmpdir() },
  dialog: { showOpenDialog: vi.fn() },
  safeStorage: {
    isEncryptionAvailable: () => true,
    getSelectedStorageBackend: () => "test_stub",
    encryptString: (s: string) => Buffer.from(`enc:${s}`, "utf8"),
    decryptString: (b: Buffer) => b.toString("utf8").replace(/^enc:/, ""),
  },
  ipcMain: {
    handle: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
    on: (ch: string, fn: (e: unknown, ...args: unknown[]) => unknown) => handlers.set(ch, fn),
  },
}));

const { MainBackend } = await import("./backend");
const { CH } = await import("@omp-ui/core");
const { REMOTE_WS_PATH } = await import("@omp-ui/server/protocol");

const sent: Array<{ channel: string; args: unknown[] }> = [];
const win = {
  isDestroyed: () => false,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
  },
};

let base: string;
let backend: InstanceType<typeof MainBackend>;
let registryFile: string;

/** Invokes a `request` channel exactly as ipcMain.handle would. */
function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve(fn(null, ...args));
}

/** Every remote:state push so far, newest last. */
function pushes(): RemoteState[] {
  return sent.filter((s) => s.channel === CH.onRemoteState).map((s) => s.args[0] as RemoteState);
}

function lastPush(): RemoteState {
  const all = pushes();
  const last = all.at(-1);
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

function connect(port: number, token: string): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}${REMOTE_WS_PATH}?t=${token}`);
  openSockets.push(ws);
  return new Promise((resolve, reject) => {
    ws.once("open", () => resolve(ws));
    ws.once("close", () => reject(new Error("closed before open")));
    ws.once("error", () => {});
  });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-remote-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
  handlers.clear();
  sent.length = 0;
  // No webRoot: the transport is what this suite exercises, and the 503 static branch is
  // covered by packages/server's own suite.
  backend = new MainBackend(win as never, registryFile);
  backend.registerIpc();
});

afterEach(async () => {
  for (const ws of openSockets.splice(0)) ws.close();
  backend.killAll();
  // killAll fires remote.stop() without awaiting; drain the manager's chain so the next test
  // does not race a closing listener onto its own port.
  await invoke(CH.setRemoteEnabled, false);
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
    const before = backend.liveCount;

    await invoke(CH.setRemotePort, 45679);
    expect(lastPush().port).toBe(45679);
    expect(lastPush().status).toBe("listening");

    const moved = await fetch(`http://127.0.0.1:45679/healthz?t=${token}`);
    expect(moved.status).toBe(200);
    // The old port is genuinely released.
    await expect(fetch(`http://127.0.0.1:45678/healthz?t=${token}`)).rejects.toThrow();
    expect(backend.liveCount).toBe(before);
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

  it("regenerating the token drops connected clients and 401s the old token", async () => {
    await invoke(CH.setRemotePort, 45681);
    await invoke(CH.setRemoteEnabled, true);
    const oldToken = lastPush().token;

    const ws = await connect(45681, oldToken);
    const closed = new Promise<void>((resolve) => ws.once("close", () => resolve()));

    await invoke(CH.regenerateRemoteToken);
    await closed;

    const newToken = lastPush().token;
    expect(newToken).not.toBe(oldToken);
    expect(newToken).toBe(registryToken());

    const stale = await fetch(`http://127.0.0.1:45681/healthz?t=${oldToken}`);
    expect(stale.status).toBe(401);
    const fresh = await fetch(`http://127.0.0.1:45681/healthz?t=${newToken}`);
    expect(fresh.status).toBe(200);
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
    // The remote client sees the same BackendState the desktop window does.
    expect(res.value).toHaveProperty("projects");
  });

  it("returns the app-update restart handshake over the remote socket", async () => {
    await invoke(CH.setRemotePort, 45687);
    await invoke(CH.setRemoteEnabled, true);
    const ws = await connect(45687, lastPush().token);
    const reply = new Promise<Record<string, unknown>>((resolve) => {
      ws.once("message", (raw: Buffer) =>
        resolve(JSON.parse(raw.toString("utf8")) as Record<string, unknown>),
      );
    });

    ws.send(JSON.stringify({ t: "req", id: 138, ch: CH.restartForAppUpdate, args: [false] }));

    expect(await reply).toMatchObject({
      t: "res",
      id: 138,
      ok: true,
      value: "unavailable",
    });
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

    // A second backend against the same port is the realistic collision.
    const other = new MainBackend(win as never, path.join(base, "other.json"));
    const otherState: RemoteState[] = [];
    // Its handlers overwrote ours in the shared map, so drive it directly and restore after.
    const ourHandlers = new Map(handlers);
    sent.length = 0;
    other.registerIpc();
    await invoke(CH.setRemotePort, 45685);
    await invoke(CH.setRemoteEnabled, true);
    otherState.push(lastPush());

    expect(otherState[0].status).toBe("error");
    expect(otherState[0].error).toBe("port 45685 is already in use");
    other.killAll();

    // The original listener is untouched by the failed start.
    for (const [ch, fn] of ourHandlers) handlers.set(ch, fn);
    expect((await fetch(`http://127.0.0.1:45685/healthz?t=${token}`)).status).toBe(200);
  });

  it("keeps serving remote clients after the desktop window is gone", async () => {
    await invoke(CH.setRemotePort, 45686);
    await invoke(CH.setRemoteEnabled, true);
    const token = lastPush().token;
    const ws = await connect(45686, token);

    // broadcast() must not early-return on a destroyed window, or remote clients starve.
    const destroyed = { isDestroyed: () => true, webContents: { isDestroyed: () => true, send: () => {} } };
    Object.assign(win, destroyed);
    try {
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
    } finally {
      Object.assign(win, {
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          isCrashed: () => false,
          send: (channel: string, ...args: unknown[]) => sent.push({ channel, args }),
        },
      });
    }
  });
});
