/* global process, console */
/* Join proof (issue #1010 gate 2, CI-safe part): two real host-lite members boot
   over the real transport (fake session bundles, no Electron, no omp spawn) and
   each answers the other's owner-side handshake. The live desktop-owner proof
   is separate: dev:headless per docs/development.md — never launch the visible
   app for a check, and target instances by port, never process name (#858).

   Run after integration: node --import tsx packages/host-lite/proofs/join-two-instances.mjs */
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { connectInstanceClient } from "@omp-ui/server";
import { startLiteFleetMember } from "../src/index.ts";

function fakeSessions(tag) {
  return {
    handlers: {},
    on: () => () => {},
    dispose: async () => {},
    state: () => ({
      projects: [
        {
          project: { path: `/tmp/proof-${tag}`, displayName: `proof-${tag}` },
          sessions: [],
        },
      ],
      chats: [],
      spawnGate: { model: null, advisorModel: null },
      remoteInstances: [],
      fleetPending: [],
      fleetTerminals: [],
      modelFavorites: [],
    }),
  };
}

async function freePort() {
  const server = net.createServer();
  const { promise: listening, resolve: listen } = Promise.withResolvers();
  server.listen(0, "127.0.0.1", listen);
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const { promise: closed, resolve: onClose } = Promise.withResolvers();
  server.close(() => onClose());
  await closed;
  return port;
}

const roots = [];
function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-lite-proof-${name}-`));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

/** Boot one member on a loopback port of its own. */
async function member(name) {
  const dir = tmpRoot(name);
  const { Registry } = await import("@omp-ui/core");
  const registry = Registry.load(path.join(dir, "registry.json"));
  registry.setSettings({ remoteEnabled: true, remoteBind: "localhost", remotePort: await freePort() });
  const instance = await startLiteFleetMember({
    dataDir: dir,
    version: "0.0.0-proof",
    sessions: fakeSessions(name),
    log: () => {},
  });
  return instance;
}

let exitCode = 0;
try {
  const a = await member("a");
  const b = await member("b");
  // Mutual owner-side handshake: each side is dialed with its own credential
  // (that is what RemoteInstanceManager does to a joined member).
  const ids = [];
  for (const host of [a, b]) {
    const client = await connectInstanceClient(
      `http://127.0.0.1:${host.remote.state.port}`,
      host.registry.getSetting("remoteToken"),
    );
    try {
      const identity = await client.request("instance:identity", []);
      assert.equal(typeof identity.instanceId, "string");
      assert.ok(identity.instanceId.length > 0);
      assert.equal(identity.version, "0.0.0-proof");
      ids.push(identity.instanceId);
      const state = await client.request("state:get", []);
      assert.ok(Array.isArray(state.projects), "projects must be ProjectGroup[]");
      assert.ok(Array.isArray(state.modelFavorites));
    } finally {
      client.close();
    }
  }
  // Self-detection guard (ADR-0028): two members never share an id, or the
  // owner would classify its own member as `self` and refuse the join.
  assert.notEqual(ids[0], ids[1]);
  // Wrong credential refused: member auth is real transport auth, not ceremony.
  await assert.rejects(
    connectInstanceClient(`http://127.0.0.1:${a.remote.state.port}`, "wrong-token"),
  );
  console.log("join proof OK: mutual handshake, state shape, distinct ids, token rejection");
} catch (err) {
  console.error("join proof FAILED:", err);
  exitCode = 1;
} finally {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
}
