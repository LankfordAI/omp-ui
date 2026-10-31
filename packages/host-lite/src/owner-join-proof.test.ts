/* Fleet-visible join proof (issue #1010 gate 3, CI-safe half): a real member
   booted with its production composition (fake session bundle; the fleet legs
   built from the bundle artifact — the same wiring `omp-lite serve` uses) is
   joined by the REAL owner-side RemoteInstanceManager client code. The owner
   sees it `joined`, projects projected, and gets a bounded exec through the
   member's ladder — the machines-list and exec semantics of gate 3 without an
   Electron window. The live dev:headless desktop-owner check stays a separate
   manual step per docs/development.md (#858 port-targeting). */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CH,
  Registry,
  RemoteInstanceStore,
  type FleetExecOutcome,
  type FleetHostReport,
  type KeyCipher,
} from "@omp-ui/core";
// The owner's actual join client — zero Electron imports, same code the desktop runs.
import { RemoteInstanceManager } from "../../desktop/src/main/remote-instance-manager";
import { buildProductionFleetLegs } from "./production-legs";
import { startLiteFleetMember, type LiteInstance } from "./serve";
import type { LiteSessions } from "./seams";

const execFileP = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.join(here, "..");
// Hermetic artifact, same contract as bundle.test/real-exec-smoke: built once
// into a .build dir (already gitignored) and removed in afterAll so lint never
// sweeps a bundle left inside src/.
const outDir = path.join(here, ".build");
const artifact = path.join(outDir, "session-bundle.mjs");

const OWNER_ID = "owner-app-id";
const OWNER_LABEL = "owner-box";
const requester = { instanceId: OWNER_ID, label: OWNER_LABEL, kind: "user", sourceTabId: null } as const;

const storeCipher: KeyCipher = {
  available: true,
  backend: "fake",
  encrypt: (s) => Buffer.from(s, "utf8"),
  decrypt: (b) => b.toString("utf8"),
};

function fakeSessions(): LiteSessions {
  return {
    handlers: {},
    on: () => () => {},
    dispose: async () => {},
    // No live session rows: mergeRegistryState builds the owner-visible
    // project groups from the registry itself, which is what this proof asserts.
    state: () =>
      ({
        projects: [],
        chats: [],
        spawnGate: { model: null, advisorModel: null },
        remoteInstances: [],
        fleetPending: [],
        fleetTerminals: [],
      }) as never,
  };
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  const { promise: listening, resolve: listen } = Promise.withResolvers<void>();
  server.listen(0, "127.0.0.1", listen);
  await listening;
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  const { promise: closed, resolve: onClose } = Promise.withResolvers<void>();
  server.close(() => onClose());
  await closed;
  return port;
}

const dirs: string[] = [];
const instances: LiteInstance[] = [];
const managers: RemoteInstanceManager[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

/**
 * Every join transition (dial settle, handshake done) fires the manager's
 * `broadcast` callback — the test above resolves on that real signal via
 * `nextBroadcast()`, so there is no wall-clock polling anywhere in this file.
 */

beforeAll(async () => {
  if (process.platform === "win32") return; // bounded exec uses a POSIX shell
  await execFileP(process.execPath, [path.join(pkgRoot, "scripts/bundle-session.mjs"), "--outfile", artifact], {
    cwd: pkgRoot,
  });
}, 120_000);

afterAll(async () => {
  for (const m of managers.splice(0)) m.stop();
  for (const i of instances.splice(0)) await i.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(outDir, { recursive: true, force: true });
});

describe("owner-side join of a production-composed member (issue #1010)", () => {
  it("joins the member, projects it, and runs one granted exec", { skip: process.platform === "win32" }, async () => {
    const memberDir = tempDir("omp-lite-owner-member-");
    const ownerDir = tempDir("omp-lite-owner-store-");
    const projectPath = tempDir("omp-lite-owner-proj-");

    // Seed the member's registry before boot (serve reloads it): enabled on a
    // free loopback port + a pre-granted Full rung for the owner, in the same
    // store shape the desktop member's ladder uses.
    const seeded = Registry.load(path.join(memberDir, "registry.json"));
    seeded.setSettings({
      remoteEnabled: true,
      remoteBind: "localhost",
      remotePort: await freePort(),
      fleetExecEnabled: true,
      fleetExecCeiling: "full",
      fleetGrants: { [OWNER_ID]: { rung: "full", label: OWNER_LABEL, updatedAt: "seed" } },
    });
    seeded.addProject(projectPath);

    // Production legs (exec/terminals/audit through the artifact) exactly as the CLI boots.
    const instance = await startLiteFleetMember({
      dataDir: memberDir,
      version: "9.9.9-proof",
      sessions: fakeSessions(),
      log: () => {},
      buildFleet: (ctx) => buildProductionFleetLegs({ ...ctx, bundlePath: artifact }),
    });
    instances.push(instance);

    // The REAL owner client: desktop's own store + manager classes.
    const store = new RemoteInstanceStore(path.join(ownerDir, "remote-instances.json"), storeCipher);
    const manager = new RemoteInstanceManager({
      store,
      localInstanceId: () => OWNER_ID,
      localVersion: "9.9.9-owner",
      send: () => {},
      sendToRenderers: () => {},
      broadcast: async () => {},
    });
    managers.push(manager);

    // add() awaits the full dial: connect → instance:identity → state:get →
    // status "joined". No wait primitive is needed — the awaited call IS the
    // join; reading summaries() right after observes the settled state.
    await manager.add({
      url: `http://127.0.0.1:${instance.remote.state.port}`,
      nickname: "",
      secret: { kind: "token", value: instance.registry.getSetting("remoteToken") },
    });

    const row = manager.summaries()[0];
    expect(row?.status).toBe("joined");
    const id = row!.id;

    // Gate-3 semantics #1 — the machines-list data: projects projected.
    expect(row!.projects.map((g) => g.project.path)).toContain(projectPath);
    expect(row!.version).toBe("9.9.9-proof");

    // Gate-3 semantics #2 — placement report over the proxy lane.
    const report = (await manager.request(id, CH.fleetHostReport, [])) as FleetHostReport;
    expect(report.label.length).toBeGreaterThan(0);
    expect(report.projects.some((p) => p.path === projectPath)).toBe(true);
    // The fake session bundle reports no provider anywhere → fail-closed flags.
    expect(report.projects.every((p) => p.providerReady === false)).toBe(true);

    // Gate-3 semantics #3 — one granted bounded exec through the member's ladder.
    const outcome = (await manager.request(id, CH.fleetExec, [
      { requester, command: "printf owner-ok", cwd: null, timeoutMs: 5_000 },
    ])) as FleetExecOutcome;
    expect(outcome).toMatchObject({ status: "accepted", exitCode: 0 });
    if (outcome.status === "accepted") expect(outcome.stdout).toBe("owner-ok");
  });
});
