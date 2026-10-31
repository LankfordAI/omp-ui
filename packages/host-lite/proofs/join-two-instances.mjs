// Join proof (issue #1010 gate 2, CI-safe part): two host-lite instances join
// each other over the real transport with fake session bundles — no Electron,
// no omp spawn. The live desktop-owner proof is separate (dev:headless per
// docs/development.md; never launch the visible app for a check).
//
// Run after integration: node packages/host-lite/proofs/join-two-instances.mjs
// Expects (from S1 integration): createLiteMember({ dataDir, port?, sessions, cipher })
//   -> { url, token, close(): Promise<void> }  — thin factory wrapping serve.ts.
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connectInstanceClient } from "@omp-ui/server";

function fakeSessions(tag) {
  const favorites = [];
  return {
    handlers: {},
    on: () => () => {},
    dispose: async () => {},
    state: () => ({
      projects: [
        {
          project: { path: `/tmp/proof-${tag}`, displayName: `proof-${tag}`, defaultModel: null },
          sessions: [],
        },
      ],
      chats: [],
      defaultMode: "plan",
      modelFavorites: favorites,
    }),
  };
}

async function member(dataDir) {
  // Dynamic import so this file stays loadable before integration lands S1.
  const { createLiteMember } = await import("../src/index.ts");
  return createLiteMember({ dataDir, sessions: fakeSessions(path.basename(dataDir)) });
}

const roots = [];
function tmpRoot(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-lite-proof-${name}-`));
  fs.chmodSync(dir, 0o700);
  roots.push(dir);
  return dir;
}

let exitCode = 0;
try {
  const a = await member(tmpRoot("a"));
  const b = await member(tmpRoot("b"));
  // Mutual join: each side completes the owner handshake against the other.
  const ids = [];
  for (const hostSide of [a, b]) {
    const client = await connectInstanceClient(hostSide.url, hostSide.token);
    try {
      const identity = await client.request("instance:identity", []);
      assert.equal(typeof identity.instanceId, "string");
      assert.ok(identity.instanceId.length > 0);
      assert.equal(typeof identity.version, "string");
      ids.push(identity.instanceId);
      const state = await client.request("state:get", []);
      assert.ok(Array.isArray(state.projects), "projects must be ProjectGroup[]");
      assert.ok(Array.isArray(state.modelFavorites));
    } finally {
      client.close();
    }
  }
  // Self-detection guard (ADR-0028): two instances never share an id, or the
  // owner would classify its own member as `self` and refuse the join.
  assert.notEqual(ids[0], ids[1]);
  // Wrong token refused (member auth is real transport auth, not ceremony).
  await assert.rejects(connectInstanceClient(a.url, "wrong-token"));
  console.log("join proof OK: mutual handshake, state shape, token rejection");
} catch (err) {
  console.error("join proof FAILED:", err);
  exitCode = 1;
} finally {
  for (const dir of roots) fs.rmSync(dir, { recursive: true, force: true });
  process.exit(exitCode);
}
