/* Fleet-visible join proof (issue #1010 gate 3, CI-safe half): a real member
   booted with its production composition (fake session bundle; the fleet legs
   built from the bundle artifact — the same wiring `omp-ui-lite serve` uses) is
   joined by the REAL owner-side RemoteInstanceManager client code. The owner
   sees it `joined`, projects projected, and gets a bounded exec through the
   member's ladder — the machines-list and exec semantics of gate 3 without an
   Electron window. The live dev:headless desktop-owner check stays a separate
   manual step per docs/development.md (#858 port-targeting). */
import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import { promisify } from "node:util";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  CH,
  ProviderKeys,
  Registry,
  RemoteInstanceStore,
  type FleetExecOutcome,
  type FleetFinishOutcome,
  type FleetHostReport,
  type FleetProjectManageOutcome,
  type FleetProviderKeysOutcome,
  type FleetSendOutcome,
  type FleetSettleOutcome,
  type FleetStopOutcome,
  type KeyCipher,
  type ModelCatalogSnapshot,
  type RoutineDryRunResult,
  type RoutineRecord,
  type RoutinesState,
  type SpawnAnswer,
  type SpawnRequest,
} from "@omp-ui/core";
import { connectInstanceClient } from "@omp-ui/server";
// The owner's actual join client — zero Electron imports, same code the desktop runs.
import { RemoteInstanceManager } from "../../desktop/src/main/remote-instance-manager";
import { loadSessionBundle } from "./bundle-artifact";
import { buildProductionFleetLegs } from "./production-legs";
import { withPlacementGates } from "./production-sessions";
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

  it("joins a real built session bundle with Routines enabled: CRUD, dryRun, models:readChat, live remote-routines:state, Run now with pinned model, and rejects setRoutinesEnabled", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const memberDir = tempDir("omp-lite-routines-member-");
    const ownerDir = tempDir("omp-lite-routines-owner-");
    const projectPath = tempDir("omp-lite-routines-proj-");

    const fakeOmp = path.join(memberDir, "fake-omp.mjs");
    fs.writeFileSync(
      fakeOmp,
      `#!${process.execPath}
import * as readline from "node:readline";
if (process.argv[2] === "config") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "ready" });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "set_host_tools" || msg.type === "set_event_filter" || msg.type === "set_ask_dialog" || msg.type === "set_host_uri_schemes") {
    emit({ type: "response", id: msg.id, command: msg.type, success: true });
    return;
  }
  if (msg.type === "prompt") {
    emit({ type: "response", id: msg.id, command: "prompt", success: true });
    if (typeof msg.id === "string" && msg.id.startsWith("omp-ui-fleet-prompt-")) {
      emit({ type: "agent_start" });
      emit({ type: "agent_end", messages: [{ role: "assistant", content: "Routine complete." }] });
    }
  }
});
`,
      { mode: 0o755 },
    );

    const seeded = Registry.load(path.join(memberDir, "registry.json"));
    seeded.setSettings({
      remoteEnabled: true,
      remoteBind: "localhost",
      remotePort: await freePort(),
      routinesEnabled: true,
    });
    seeded.addProject(projectPath);

    const bundleMod = await loadSessionBundle<{
      createSessionBundle(input: Record<string, unknown>): LiteSessions & {
        sessions: {
          isLive(tabId: string): boolean;
          isTurnRunning(tabId: string): boolean;
          modelProviderReady(cwd: string): boolean;
        };
      };
    }>(artifact);

    const instance = await startLiteFleetMember({
      dataDir: memberDir,
      version: "9.9.9-routines",
      log: () => {},
      buildSessions: async ({ registry, dataDir, version, instanceId }) => {
        const providerKeys = new ProviderKeys(path.join(dataDir, "provider-keys.json"), storeCipher, {
          OPENROUTER_API_KEY: "test-key",
        });
        const created = bundleMod.createSessionBundle({
          registry,
          registryFile: path.join(dataDir, "registry.json"),
          providerKeys,
          instanceId,
          getOmpPath: () => fakeOmp,
          getSessionsRoot: () => path.join(dataDir, "sessions"),
          getArchiveRoot: () => path.join(dataDir, "archive"),
          getWorktreesRoot: () => path.join(dataDir, "worktrees"),
          getChatsRoot: () => path.join(dataDir, "chats"),
          appVersion: version,
          routineCatalog: {
            list: async () => ({
              tools: [
                { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Read" },
                { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Bash" },
              ],
              staleServers: [],
              enumerationError: null,
              capturedAt: new Date().toISOString(),
            }),
          },
          readChatModels: async (): Promise<ModelCatalogSnapshot> => ({
            models: [
              {
                provider: "openrouter",
                id: "google/gemini-4-neon",
                name: "Gemini 4 Neon",
                thinking: { efforts: ["low", "medium", "high"] },
              },
            ],
            discovered: true,
            error: null,
          }),
          devicePane: {
            encodeJpeg: (): never => {
              throw new Error("no device pane");
            },
            agentDeviceBin: async () => null,
            stateDir: () => path.join(dataDir, "agent-device"),
          },
        });
        return withPlacementGates(created, registry);
      },
    });
    instances.push(instance);

    const relayedStates: RoutinesState[] = [];
    const runDone = Promise.withResolvers<RoutinesState>();
    let watchedRunId: string | null = null;

    const store = new RemoteInstanceStore(path.join(ownerDir, "remote-instances.json"), storeCipher);
    const manager = new RemoteInstanceManager({
      store,
      localInstanceId: () => OWNER_ID,
      localVersion: "9.9.9-owner",
      send: (channel, args) => {
        if (channel === CH.onRemoteRoutinesState) {
          const st = args[1] as RoutinesState;
          relayedStates.push(st);
          if (watchedRunId !== null && st.runs.some((r) => r.id === watchedRunId && r.outcome === "on-time")) {
            runDone.resolve(st);
          }
        }
      },
      sendToRenderers: () => {},
      broadcast: async () => {},
    });
    managers.push(manager);

    await manager.add({
      url: `http://127.0.0.1:${instance.remote.state.port}`,
      nickname: "homelab-lite",
      secret: { kind: "token", value: instance.registry.getSetting("remoteToken") },
    });

    const row = manager.summaries()[0];
    expect(row?.status).toBe("joined");
    expect(row?.routinesEnabled).toBe(true);
    const id = row!.id;

    // models:readChat returns the member's catalog through the proxy.
    const models = (await manager.request(id, CH.readChatModels, [])) as ModelCatalogSnapshot;
    expect(models.models.map((m) => `${m.provider}/${m.id}`)).toEqual(["openrouter/google/gemini-4-neon"]);
    // Create + dryRun + update + Run now with pinned model over the real owner join.
    const created = (await manager.request(id, CH.createRoutine, [
      {
        name: "Nightly audit",
        instructions: "Summarize repo status.",
        schedule: { kind: "cron", expr: "0 3 * * *" },
        timeZone: "UTC",
        destination: { projectCwd: projectPath, workspace: "checkout" },
        mode: "build",
        model: "openrouter/google/gemini-4-neon",
        thinkingLevel: "medium",
        spend: { warnUsd: null, maxUsd: null },
        toolPolicy: { allow: ["read"], deny: ["bash"], lastReviewedAt: "2026-11-25T00:00:00.000Z", reviewedCatalog: ["read", "bash"] },
        scripts: { pre: "", post: "" },
        timeoutMinutes: null,
        notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
        artifact: null,
        enabled: true,
      },
    ])) as RoutineRecord;
    expect(created.name).toBe("Nightly audit");

    const dry = (await manager.request(id, CH.dryRunRoutine, [{ kind: "saved", id: created.id }])) as RoutineDryRunResult;
    expect(dry.compiled.overlayEntries.read).toBe("allow");
    expect(dry.compiled.overlayEntries.bash).toBe("deny");

    const fired = (await manager.request(id, CH.runRoutineNow, [created.id])) as { tabId: string; runId: string };
    expect(fired.tabId).toBeTruthy();
    watchedRunId = fired.runId;

    // Check if already relayed before watchedRunId was set, otherwise await live relay.
    if (!relayedStates.some((st) => st.runs.some((r) => r.id === fired.runId && r.outcome === "on-time"))) {
      const finalState = await runDone.promise;
      expect(finalState.runs.find((r) => r.id === fired.runId)?.outcome).toBe("on-time");
    }
    expect(relayedStates.length).toBeGreaterThan(0);

    // Both the joiner proxy AND a direct authenticated WS client reject setRoutinesEnabled.
    await expect(manager.request(id, CH.setRoutinesEnabled, [false])).rejects.toThrow();
    const direct = await connectInstanceClient(
      `http://127.0.0.1:${instance.remote.state.port}`,
      instance.registry.getSetting("remoteToken"),
    );
    try {
      await expect(direct.request(CH.setRoutinesEnabled, [false])).rejects.toThrow(/unknown channel/);
      await expect(direct.request(CH.setRoutineSpendDefaults, [{ warnUsd: 1, maxUsd: 2 }])).rejects.toThrow(
        /unknown channel/,
      );
    } finally {
      direct.close();
    }
  });

  it("Tier 1 & Tier 2 multi-host parity proof: repo unification, fleet lifecycle, provider keys, git/branch relay, and project settings (#1374)", { skip: process.platform === "win32", timeout: 30_000 }, async () => {
    const memberDir = tempDir("omp-lite-parity-member-");
    const ownerDir = tempDir("omp-lite-parity-owner-");
    const rootsDir = tempDir("omp-lite-parity-roots-");
    const preSeededRepo = path.join(rootsDir, "preseeded-repo");
    const registeredRepo = path.join(rootsDir, "registered-repo");
    for (const repo of [preSeededRepo, registeredRepo]) {
      fs.mkdirSync(repo, { recursive: true });
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
      execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: repo });
      execFileSync("git", ["config", "user.name", "Test"], { cwd: repo });
      execFileSync("git", ["remote", "add", "origin", "https://github.com/acme/shared-repo.git"], { cwd: repo });
      fs.writeFileSync(path.join(repo, "app.ts"), "export const v = 1;\n");
      execFileSync("git", ["add", "."], { cwd: repo });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: repo });
    }

    const fakeOmp = path.join(memberDir, "fake-omp.mjs");
    fs.writeFileSync(
      fakeOmp,
      `#!${process.execPath}
import * as readline from "node:readline";
if (process.argv[2] === "config") {
  process.stdout.write("{}\\n");
  process.exit(0);
}
const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\\n");
emit({ type: "ready" });
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  if (msg.type === "set_host_tools" || msg.type === "set_event_filter" || msg.type === "set_ask_dialog" || msg.type === "set_host_uri_schemes") {
    emit({ type: "response", id: msg.id, command: msg.type, success: true });
    return;
  }
  if (msg.type === "prompt" || msg.type === "follow_up" || msg.type === "steer" || msg.type === "abort") {
    emit({ type: "response", id: msg.id, command: msg.type, success: true });
    if (msg.type === "prompt") {
      emit({ type: "agent_start" });
      emit({ type: "agent_end", messages: [{ role: "assistant", content: "Fleet reply ok." }] });
    }
  }
});
`,
      { mode: 0o755 },
    );

    const seeded = Registry.load(path.join(memberDir, "registry.json"));
    seeded.setSettings({
      remoteEnabled: true,
      remoteBind: "localhost",
      remotePort: await freePort(),
      fleetExecEnabled: true,
      fleetExecCeiling: "full",
      fleetProjectRoots: [rootsDir],
      fleetGrants: { [OWNER_ID]: { rung: "full", label: OWNER_LABEL, updatedAt: "seed" } },
    });
    // Pre-seeded checkout with repositoryKey: null → backfilled on boot.
    seeded.addProject(preSeededRepo);
    expect(seeded.projects[0]?.repositoryKey).toBeNull();

    const bundleMod = await loadSessionBundle<{
      createSessionBundle(input: Record<string, unknown>): LiteSessions & {
        sessions: {
          isLive(tabId: string): boolean;
          isTurnRunning(tabId: string): boolean;
          modelProviderReady(cwd: string): boolean;
          fleetSend(req: unknown): Promise<FleetSendOutcome>;
          fleetFinish(req: unknown): Promise<FleetFinishOutcome>;
          fleetStop(req: unknown): Promise<FleetStopOutcome>;
          fleetSettle(req: unknown): Promise<FleetSettleOutcome>;
        };
      };
    }>(artifact);

    let memberKeys!: ProviderKeys;
    const instance = await startLiteFleetMember({
      dataDir: memberDir,
      version: "9.9.9-parity",
      log: () => {},
      buildSessions: async ({ registry, dataDir, version, instanceId }) => {
        memberKeys = new ProviderKeys(path.join(dataDir, "provider-keys.json"), storeCipher, {
          OPENROUTER_API_KEY: "test-key",
        });
        const created = bundleMod.createSessionBundle({
          registry,
          registryFile: path.join(dataDir, "registry.json"),
          providerKeys: memberKeys,
          instanceId,
          getOmpPath: () => fakeOmp,
          getSessionsRoot: () => path.join(dataDir, "sessions"),
          getArchiveRoot: () => path.join(dataDir, "archive"),
          getWorktreesRoot: () => path.join(dataDir, "worktrees"),
          getChatsRoot: () => path.join(dataDir, "chats"),
          appVersion: version,
          pullRequestsEnabled: false,
          readChatModels: async (): Promise<ModelCatalogSnapshot> => ({
            models: [{ provider: "openrouter", id: "google/gemini-4-neon", name: "Gemini", thinking: { efforts: ["low"] } }],
            discovered: true,
            error: null,
          }),
          devicePane: {
            encodeJpeg: (): never => {
              throw new Error("no device pane");
            },
            agentDeviceBin: async () => null,
            stateDir: () => path.join(dataDir, "agent-device"),
          },
        });
        return withPlacementGates(created, registry, memberKeys);
      },
      buildFleet: (ctx) => buildProductionFleetLegs({ ...ctx, bundlePath: artifact }),
    });
    instances.push(instance);

    const rendererEvents: Array<{ channel: string; args: unknown[] }> = [];
    const branchChanged = Promise.withResolvers<unknown[]>();
    const repoRegistered = Promise.withResolvers<void>();
    const preSeededBackfilled = Promise.withResolvers<void>();

    const store = new RemoteInstanceStore(path.join(ownerDir, "remote-instances.json"), storeCipher);
    const checkSummaries = (): void => {
      const projects = manager.summaries()[0]?.projects ?? [];
      if (projects.some((g) => g.project.path === preSeededRepo && g.project.repositoryKey === "github.com/acme/shared-repo")) {
        preSeededBackfilled.resolve();
      }
      if (projects.some((g) => g.project.path === registeredRepo && g.project.repositoryKey === "github.com/acme/shared-repo")) {
        repoRegistered.resolve();
      }
    };
    const manager = new RemoteInstanceManager({
      store,
      localInstanceId: () => OWNER_ID,
      localVersion: "9.9.9-owner",
      send: () => {},
      sendToRenderers: (channel, args) => {
        rendererEvents.push({ channel, args });
        if (channel === CH.onBranchChanged) branchChanged.resolve(args);
      },
      broadcast: async () => {
        checkSummaries();
      },
    });
    managers.push(manager);

    await manager.add({
      url: `http://127.0.0.1:${instance.remote.state.port}`,
      nickname: "parity-lite",
      secret: { kind: "token", value: instance.registry.getSetting("remoteToken") },
    });
    checkSummaries();

    const row = manager.summaries()[0];
    expect(row?.status).toBe("joined");
    const id = row!.id;

    // 1. Pre-seeded project receives startup backfilled repositoryKey; hostReport.instanceId matches identity.
    await preSeededBackfilled.promise;
    const report = (await manager.request(id, CH.fleetHostReport, [])) as FleetHostReport;
    expect(report.instanceId).toBe(instance.instanceId);
    expect(report.instanceId.length).toBeGreaterThan(0);

    // 2. fleet:projectManage (register) runs unified addProject → repositoryKey + state:changed pushed to owner.
    const manageOutcome = (await manager.request(id, CH.fleetProjectManage, [
      { requester, verb: "register", path: registeredRepo },
    ])) as FleetProjectManageOutcome;
    expect(manageOutcome).toMatchObject({ status: "accepted", path: registeredRepo });
    await repoRegistered.promise;

    // 3. Provider key rollout lands sealed in the member's ProviderKeys store.
    const keyOutcome = (await manager.request(id, CH.fleetProviderKeys, [
      { requester, keys: [{ envName: "ANTHROPIC_API_KEY", value: "sk-ant-rolled-out" }] },
    ])) as FleetProviderKeysOutcome;
    expect(keyOutcome).toEqual({ status: "accepted", installed: ["ANTHROPIC_API_KEY"], failed: [] });
    expect(memberKeys.rolloutValue("ANTHROPIC_API_KEY")).toBe("sk-ant-rolled-out");

    // 4. Fleet dispatch lifecycle verbs are wired (structured refusal on unknown id, real success on dispatched session).
    const missingSend = (await manager.request(id, CH.fleetSend, [
      { requester, dispatchId: "unknown-dispatch", message: "ping", mode: "queue" },
    ])) as FleetSendOutcome;
    expect(missingSend.status).toBe("refused");
    const missingFinish = (await manager.request(id, CH.fleetFinish, [
      { requester, dispatchId: "unknown-dispatch" },
    ])) as FleetFinishOutcome;
    expect(missingFinish.status).toBe("refused");
    const missingStop = (await manager.request(id, CH.fleetStop, [
      { requester, dispatchId: "unknown-dispatch" },
    ])) as FleetStopOutcome;
    expect(missingStop.status).toBe("refused");
    const missingSettle = (await manager.request(id, CH.fleetSettle, [
      { requester, dispatchId: "unknown-dispatch" },
    ])) as FleetSettleOutcome;
    expect(missingSettle.status).toBe("refused");

    const agentRequester = { instanceId: OWNER_ID, label: OWNER_LABEL, kind: "agent", sourceTabId: "parent-tab-1" } as const;
    const dispatchId = "dispatch-parity-1";
    const spawnReq: SpawnRequest = {
      origin: "new",
      projectCwd: registeredRepo,
      mode: "rpc-ui",
      advisor: false,
      cols: 80,
      rows: 24,
      worktree: null,
      fleet: {
        dispatchId,
        batchId: "batch-parity-1",
        title: "Parity check",
        requestedBy: agentRequester,
        prompt: "Run parity check.",
      },
    };
    const spawned = (await manager.request(id, CH.spawnSession, [spawnReq])) as SpawnAnswer;
    const tabId = spawned.tabId;
    expect(typeof tabId).toBe("string");
    const sendOutcome = (await manager.request(id, CH.fleetSend, [
      { requester: agentRequester, dispatchId, message: "Follow up.", mode: "queue" },
    ])) as FleetSendOutcome;
    expect(sendOutcome.status).not.toBe("refused");
    const summaryText = (await manager.request(id, CH.fleetSessionSummary, [tabId])) as string;
    expect(typeof summaryText).toBe("string");
    expect(summaryText.length).toBeGreaterThan(0);
    const settleOutcome = (await manager.request(id, CH.fleetSettle, [
      { requester: agentRequester, dispatchId },
    ])) as FleetSettleOutcome;
    expect(settleOutcome.status).toBe("settled");

    // 5. Remote control parity over WebSocket proxy: branch:list/checkout (+ branch:changed relay), settings, files, catalog, council.
    const branches = (await manager.request(id, CH.listBranches, [registeredRepo])) as { current: string | null };
    expect(branches.current).toBe("main");
    await manager.request(id, CH.checkoutBranch, [registeredRepo, "feat-remote", { create: true }]);
    const branchEventArgs = await branchChanged.promise;
    expect(branchEventArgs).toEqual([registeredRepo, id]);

    await manager.request(id, CH.setProjectDefaultModel, [registeredRepo, "openrouter/google/gemini-4-neon"]);
    const files = (await manager.request(id, CH.listProjectFiles, [registeredRepo])) as { files: string[] };
    expect(files.files).toContain("app.ts");
    const catalog = (await manager.request(id, CH.readModelCatalog, [tabId])) as ModelCatalogSnapshot;
    expect(catalog.models[0]?.id).toBe("google/gemini-4-neon");
    const council = (await manager.request(id, CH.getCouncilRoster, [registeredRepo])) as {
      members: unknown[];
      project: unknown;
    };
    expect(Array.isArray(council.members)).toBe(true);
    expect(council.project).toBeNull();
    expect(rendererEvents.some((e) => e.channel === CH.onBranchChanged)).toBe(true);
  });
});
