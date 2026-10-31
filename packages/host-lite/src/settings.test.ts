import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { CH, Registry, type RemoteState } from "@omp-ui/core";
import { connectInstanceClient, type InstanceClient } from "@omp-ui/server";
import { electronAppDataDir, ensureInstanceId, ensureLiteHome, resolveLiteHome } from "./config";
import { startLiteFleetMember, seedMemberDefaults, type LiteInstance } from "./serve";
import type { LiteSessions } from "./seams";
import type { BackendState } from "@omp-ui/core";

// Settings-channel proof (issue #1010): the remote:* glue ported from desktop's
// remote-handlers.ts persists against the member's own Registry and drives the
// listener — bind/port/enabled reconcile (apply), token rotation restarts and
// invalidates the old credential.

const dirs: string[] = [];
const instances: LiteInstance[] = [];
const clients: InstanceClient[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const instance of instances.splice(0)) await instance.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-settings-"));
  dirs.push(dir);
  return dir;
}

/** An OS-chosen loopback port, released before it is dialed (a race only against other suites). */
async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

const noSessions: LiteSessions = {
  handlers: {},
  state: () =>
    ({
      projects: [],
      chats: [],
      spawnGate: { model: null, advisorModel: null },
      remoteInstances: [],
      fleetPending: [],
      fleetTerminals: [],
    }) as unknown as BackendState,
  on: () => () => {},
  dispose: async () => {},
};

async function bootMember(): Promise<LiteInstance> {
  const dir = tempDir();
  const registry = Registry.load(path.join(dir, "registry.json"));
  // Port validation at load requires >=1024: persist a real OS-granted port, not 0.
  registry.setSettings({ remoteEnabled: true, remoteBind: "localhost", remotePort: await freePort() });
  const instance = await startLiteFleetMember({ dataDir: dir, version: "0.0.0", sessions: noSessions, log: () => {} });
  instances.push(instance);
  return instance;
}

describe("lite member config resolution (issue #1010)", () => {
  it("OMP_UI_LITE_HOME overrides the appData-derived dir", () => {
    const home = resolveLiteHome({ OMP_UI_LITE_HOME: "/srv/lite-data", HOME: "/home/a" });
    expect(home).toBe("/srv/lite-data");
  });

  it("mirrors Electron's appData parent with the omp-ui-lite[-dev] leaf", () => {
    // A sibling of the desktop's userData dirs (desktop index.ts pins those names under appData).
    const linux = resolveLiteHome({ HOME: "/home/a", XDG_CONFIG_HOME: "", OS: "linux" });
    expect(linux).toBe("/home/a/.config/omp-ui-lite");
    const dev = resolveLiteHome({ HOME: "/home/a", XDG_CONFIG_HOME: "", OS: "linux", NODE_ENV: "development" });
    expect(dev).toBe("/home/a/.config/omp-ui-lite-dev");
    const xdg = resolveLiteHome({ HOME: "/home/a", XDG_CONFIG_HOME: "/xdg", OS: "linux" });
    expect(xdg).toBe("/xdg/omp-ui-lite");
    expect(electronAppDataDir({ APPDATA: "C:\\Users\\a\\AppData\\Roaming", OS: "win32" })).toBe(
      "C:\\Users\\a\\AppData\\Roaming",
    );
    expect(electronAppDataDir({ HOME: "/Users/a", OS: "darwin" })).toBe("/Users/a/Library/Application Support");
  });

  it("creates the data dir 0700 and the instance id file 0600, stable across calls", () => {
    const base = tempDir();
    const dataDir = path.join(base, "nested", "omp-ui-lite");
    ensureLiteHome(dataDir);
    expect(fs.statSync(dataDir).mode & 0o777).toBe(0o700);
    let mints = 0;
    const first = ensureInstanceId(dataDir, () => {
      mints += 1;
      return "0f8fad5b-d9cb-469f-a165-70867728950e";
    });
    const second = ensureInstanceId(dataDir, () => {
      mints += 1;
      return "never-used";
    });
    expect(second).toBe(first);
    expect(mints).toBe(1);
    expect(fs.statSync(path.join(dataDir, "instance-id")).mode & 0o777).toBe(0o600);
  });

  it("a fresh member boots enabled on lan (fleet-member default) without touching the port", async () => {
    const instance = await startLiteFleetMember({
      dataDir: tempDir(),
      version: "0.0.0",
      sessions: noSessions,
      listen: false,
      log: () => {},
    });
    instances.push(instance);
    expect(instance.registry.getSetting("remoteEnabled")).toBe(true);
    expect(instance.registry.getSetting("remoteBind")).toBe("lan");
    expect(instance.registry.getSetting("remoteToken")).not.toBe("");
  });

  it("seedMemberDefaults only writes a never-persisted registry; later choices are law", () => {
    const dir = tempDir();
    const blank = Registry.load(path.join(dir, "registry.json"));
    expect(seedMemberDefaults(blank, true)).toBe(true);
    expect(blank.getSetting("remoteBind")).toBe("lan");
    // An existing registry (persisted settings) is never re-seeded.
    const persistedDir = tempDir();
    const existing = Registry.load(path.join(persistedDir, "registry.json"));
    existing.setSettings({ remoteEnabled: false, remoteBind: "localhost" });
    expect(seedMemberDefaults(existing, false)).toBe(false);
    expect(existing.getSetting("remoteBind")).toBe("localhost");
  });
});

describe("lite member remote settings channels (issue #1010)", () => {
  it("getRemoteState answers the live RemoteState, not an error", async () => {
    const instance = await bootMember();
    const state = instance.backend.handlers().request[CH.getRemoteState]!() as RemoteState;
    expect(state.status).toBe("listening");
    expect(state.bind).toBe("localhost");
    expect(state.port).toBe(instance.remote.state.port);
    expect(state.urls.length + state.tokenUrls.length).toBeGreaterThan(0);
  });

  it("setRemoteBind persists and restarts the listener on the new bind", async () => {
    const instance = await bootMember();
    await instance.backend.handlers().request[CH.setRemoteBind]!("lan");
    expect(instance.registry.getSetting("remoteBind")).toBe("lan");
    // The live listener followed the setting (apply → same-port localhost→0.0.0.0 rebind).
    expect(instance.remote.state.bind).toBe("lan");
    expect(instance.remote.state.status).toBe("listening");
    // And it survived a reload: the persisted value is law for the next boot.
    const reopened = Registry.load(path.join(instance.dataDir, "registry.json"));
    expect(reopened.getSetting("remoteBind")).toBe("lan");
  });

  it("setRemotePort persists and moves the listener to the new port", async () => {
    const instance = await bootMember();
    const initialPort = instance.registry.getSetting("remotePort");
    await expect(instance.backend.handlers().request[CH.setRemotePort]!(80)).rejects.toThrow(
      "port must be a whole number between 1024 and 65535",
    );
    expect(instance.registry.getSetting("remotePort")).toBe(initialPort); // rejected before persisting

    const oldPort = instance.remote.state.port;
    const port = await freePort();
    await instance.backend.handlers().request[CH.setRemotePort]!(port);
    expect(instance.registry.getSetting("remotePort")).toBe(port);
    expect(instance.remote.state.status).toBe("listening");
    expect(instance.remote.state.port).toBe(port);
    // The new port answers the handshake; the old listener is gone.
    const fresh = await connectInstanceClient(`http://127.0.0.1:${port}`, instance.registry.getSetting("remoteToken"));
    clients.push(fresh);
    await fresh.request<BackendState>(CH.getState, []);
    await expect(connectInstanceClient(`http://127.0.0.1:${oldPort}`, "x")).rejects.toBeDefined();
  });

  it("regenerateRemoteToken restarts the listener and invalidates the old token over the wire", async () => {
    const instance = await bootMember();
    const oldToken = instance.registry.getSetting("remoteToken");
    const client = await connectInstanceClient(`http://127.0.0.1:${instance.remote.state.port}`, oldToken);
    clients.push(client);
    // Live before rotation.
    await client.request<BackendState>(CH.getState, []);
    // Arm the close watch BEFORE rotating: restart tears the socket down as
    // part of apply(), and a late-added onClose callback would never fire.
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));

    await instance.backend.handlers().request[CH.regenerateRemoteToken]!();
    const newToken = instance.registry.getSetting("remoteToken");
    expect(newToken).not.toBe(oldToken);
    expect(newToken).not.toBe("");

    // The old credential no longer dials.
    await expect(
      connectInstanceClient(`http://127.0.0.1:${instance.remote.state.port}`, oldToken),
    ).rejects.toBeDefined();
    // restart() tore the listener down: the live socket got the graceful 1001
    // "going away" close (the transport's handle.close contract, not a revoke).
    expect(await closed).toBe(1001);
    // The fresh credential dials.
    const fresh = await connectInstanceClient(
      `http://127.0.0.1:${instance.remote.state.port}`,
      newToken,
    );
    clients.push(fresh);
    await fresh.request<BackendState>(CH.getState, []);
  });

  it("setRemoteEnabled off stops the listener and persists; on brings it back", async () => {
    const instance = await bootMember();
    const port = instance.remote.state.port;
    await instance.backend.handlers().request[CH.setRemoteEnabled]!(false);
    expect(instance.registry.getSetting("remoteEnabled")).toBe(false);
    expect(instance.remote.state.status).toBe("stopped");
    await expect(connectInstanceClient(`http://127.0.0.1:${port}`, "x")).rejects.toBeDefined();
    await instance.backend.handlers().request[CH.setRemoteEnabled]!(true);
    expect(instance.remote.state.status).toBe("listening");
  });

  it("remote:state publishes reach host sinks (desktop delivers them to the renderer)", async () => {
    // Honest lifecycle fact ported from RemoteServerManager: a real settings
    // change RESTARTS the listener, so a socket dialed before the change is
    // gone by the time "listening" publishes — joined owners see the change as
    // a connection loss, exactly like on desktop. What LiteBackend owns is that
    // every publish hits its sinks while a server holds one: attach directly.
    const instance = await bootMember();
    const { promise, resolve } = Promise.withResolvers<RemoteState[]>();
    const seen: RemoteState[] = [];
    instance.backend.addSink((channel, args) => {
      if (channel !== CH.onRemoteState) return;
      seen.push(args[0] as RemoteState);
      resolve(seen);
    });
    await instance.backend.handlers().request[CH.setRemoteEnabled]!(false);
    const [stopped] = await promise;
    expect(stopped.status).toBe("stopped");
    // The full field set only — no hash/salt keys exist on RemoteState.
    expect(Object.keys(stopped).sort()).toEqual(
      ["bind", "enabled", "error", "hasPassword", "port", "status", "token", "tokenUrls", "urls", "webBundleMissing"].sort(),
    );
  });

  it("a token minted at first boot persists in the registry, not minted per boot", async () => {
    const dir = tempDir();
    const first = await startLiteFleetMember({
      dataDir: dir,
      version: "0.0.0",
      sessions: noSessions,
      listen: false,
      log: () => {},
    });
    instances.push(first);
    const token = first.registry.getSetting("remoteToken");
    // mintRemoteToken's shape: 32 bytes base64url — 43 URL-safe chars.
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const reopened = Registry.load(path.join(dir, "registry.json"));
    expect(reopened.getSetting("remoteToken")).toBe(token);
  });
});
