import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CH, RpcClient, type BackendState, type InstanceIdentity } from "@omp-ui/core";
import { mintRemoteToken, startRemoteServer, type RemoteServerHandle } from "@omp-ui/server";
import { MainBackend } from "./backend";
import { ownedSessionRecord, seedRegistry } from "./test/fixtures";

// Only the child transport is replaced: preparation, process state, owner routing,
// request codecs and the joined-instance socket all use their real implementations.
vi.mock("@omp-ui/core", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    RpcClient: vi.fn(),
    resolveSessionLocation: vi.fn(async () => ({ where: "missing" })),
    watchLineageDir: vi.fn(() => () => {}),
    watchGitHead: vi.fn(async () => () => {}),
  };
});

// The real MainBackend imports electron; stub the surfaces it touches (backend-broadcast.test.ts's pattern).
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

const win = {
  isDestroyed: () => false,
  webContents: { mainFrame: {}, isDestroyed: () => false, isCrashed: () => false, send: () => {} },
};

let base: string;
let registryFile: string;
const backends: MainBackend[] = [];
const servers: RemoteServerHandle[] = [];

function boot(file = registryFile): MainBackend {
  handlers.clear();
  const be = new MainBackend(win as never, file, { appVersion: "1.2.3" });
  be.registerIpc();
  backends.push(be);
  return be;
}

function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`no handler registered for ${channel}`);
  return Promise.resolve().then(() => fn({sender: win.webContents, senderFrame: win.webContents.mainFrame}, ...args));
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-backend-ri-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  registryFile = path.join(base, "registry.json");
  vi.mocked(RpcClient).mockImplementation(function () {
    return { send: vi.fn(), kill: vi.fn() };
  } as unknown as typeof RpcClient);
});

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(backends.splice(0).map((be) => be.killAll()));
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

describe("remote instances wiring (issue #416)", () => {
  it("projects an empty remoteInstances list and answers instance:identity with a minted id", async () => {
    boot();
    const state = (await invoke(CH.getState)) as BackendState;
    expect(state.remoteInstances).toEqual([]);

    const identity = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    expect(identity.version).toBe("1.2.3");
    expect(identity.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("keeps the same instanceId across a reload", async () => {
    boot();
    const first = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    boot();
    const second = (await invoke(CH.getInstanceIdentity)) as InstanceIdentity;
    expect(second.instanceId).toBe(first.instanceId);
  });

  it("refuses the renderer proxy for an unknown instance", async () => {
    boot();
    await expect(invoke(CH.remoteInstanceRequest, "nope", CH.getState, [])).rejects.toThrow(
      "unknown instance nope",
    );
  });

  it("refuses a state refresh for an unknown instance", async () => {
    boot();
    await expect(invoke(CH.refreshRemoteInstanceState, "nope")).rejects.toThrow(
      "unknown instance nope",
    );
  });

  it("answers Council status from the owning process, not either host's current roster", async () => {
    const projectCwd = path.join(base, "project");
    fs.mkdirSync(projectCwd);
    const ompBin = path.join(base, "omp");
    fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
    vi.stubEnv("OMP_UI_OMP_PATH", ompBin);
    const populatedRoster = {
      instructions: null,
      members: [{ name: "critic", model: "openrouter/openai/gpt-6.1-sol", enabled: true, instructions: null }],
    };
    const ownerFile = path.join(base, "owner", "registry.json");
    const ownerSession = ownedSessionRecord({ tabId: "owner-tab", projectCwd });
    const project = { path: projectCwd, name: "project", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null };
    seedRegistry(ownerFile, {
      settings: { councilEnabled: true, councilRoster: null, instanceId: "owner-instance" },
      projects: [project],
      sessions: [ownerSession],
    });
    fs.mkdirSync(path.join(base, "agent", "sessions", ownerSession.lineageDir), { recursive: true });
    const owner = boot(ownerFile);
    const ownerRequests = owner.handlers().request;
    await ownerRequests[CH.spawnSession]({ origin: "resume", resumeTabId: "owner-tab", cols: 80, rows: 24 });
    expect(await ownerRequests[CH.getSessionCouncilStatus]("owner-tab")).toEqual({ status: "empty", configWarnings: [] });

    // A settings edit must not rewrite the already-running process's launch state.
    await ownerRequests[CH.setCouncilRoster]({ scope: "user", scopeCwd: null, document: populatedRoster });
    const token = mintRemoteToken();
    const server = await startRemoteServer({
      host: { handlers: () => owner.handlers(), addSink: (sink) => owner.addSink(sink) },
      token,
      bind: "localhost",
      port: 0,
      webRoot: "/nonexistent-web-root",
      password: null,
    });
    servers.push(server);

    const localSession = ownedSessionRecord({
      tabId: "local-tab",
      projectCwd,
      lineageDir: "omp-ui--local--aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    });
    fs.mkdirSync(path.join(base, "agent", "sessions", localSession.lineageDir), { recursive: true });
    seedRegistry(registryFile, {
      settings: { councilEnabled: false, councilRoster: populatedRoster, instanceId: "local-instance" },
      projects: [project],
      sessions: [localSession],
    });
    boot();
    await invoke(CH.spawnSession, { origin: "resume", resumeTabId: "local-tab", cols: 80, rows: 24 });
    await invoke(CH.addRemoteInstance, {
      url: `http://127.0.0.1:${server.port}`,
      nickname: "owner",
      secret: { kind: "token", value: token },
    });
    expect(await invoke(CH.getCouncilRoster, null)).toMatchObject({ members: populatedRoster.members });
    expect(await invoke(CH.getSessionCouncilStatus, "local-tab")).toEqual({ status: "disabled" });
    expect(await invoke(CH.getSessionCouncilStatus, "owner-tab")).toEqual({ status: "empty", configWarnings: [] });
  });
});

describe("routines across hosts (ADR-0100 §8 amendment, #1306)", () => {
  it("projects routinesEnabled, proxies routine CRUD and models:readChat to the owner, relays routines:state as remote-routines:state, and refuses settings:setRoutinesEnabled", async () => {
    const projectCwd = path.join(base, "project");
    fs.mkdirSync(projectCwd);
    const project = { path: projectCwd, name: "project", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null, browserClock: false, councilRoster: null, knowledgeHome: null, repositoryKey: null, icon: null };
    const routineMark = { id: "AAAAAAAAAAAAAAAAAAAAAA", name: "Inbox", approvalEntries: { read: "allow" as const }, deniedBuiltins: [], warnCostUsd: 2, maxCostUsd: 5 };
    const ownerFile = path.join(base, "owner", "registry.json");
    // Fresh activity: boot retention prunes dormant routine runs older than 30 days.
    const ownerSession = ownedSessionRecord({ tabId: "routine-run", projectCwd, routine: routineMark, launchedAt: new Date().toISOString() });
    seedRegistry(ownerFile, {
      settings: { instanceId: "owner-instance", routinesEnabled: true },
      projects: [project],
      sessions: [ownerSession],
    });
    fs.mkdirSync(path.join(base, "agent", "sessions", ownerSession.lineageDir), { recursive: true });
    // No omp anywhere while CRUD runs (the RpcClient is mocked): the catalog falls back without a probe.
    // Windows resolves managedOmpPath from LOCALAPPDATA and os.homedir() from USERPROFILE, not HOME.
    const fakeHome = path.join(base, "home");
    vi.stubEnv("PATH", "");
    vi.stubEnv("OMP_UI_OMP_PATH", "");
    vi.stubEnv("OMP_UI_INSTALL_DIR", path.join(fakeHome, "install"));
    vi.stubEnv("HOME", fakeHome);
    vi.stubEnv("USERPROFILE", fakeHome);
    vi.stubEnv("LOCALAPPDATA", path.join(fakeHome, "AppData", "Local"));
    const owner = boot(ownerFile);
    const token = mintRemoteToken();
    const server = await startRemoteServer({
      host: { handlers: () => owner.handlers("remote"), addSink: (sink) => owner.addSink(sink) },
      token,
      bind: "localhost",
      port: 0,
      webRoot: "/nonexistent-web-root",
      password: null,
    });
    servers.push(server);

    seedRegistry(registryFile, { settings: { instanceId: "joiner-instance" } });
    const joiner = boot();
    const remoteRoutineEvents: Array<{ instanceId: string; routineIds: string[] }> = [];
    joiner.addSink((channel, args) => {
      if (channel === CH.onRemoteRoutinesState) {
        const [instanceId, state] = args as [string, { routines: Array<{ id: string }> }];
        remoteRoutineEvents.push({ instanceId, routineIds: state.routines.map((r) => r.id) });
      }
    });

    await invoke(CH.addRemoteInstance, {
      url: `http://127.0.0.1:${server.port}`,
      nickname: "owner",
      secret: { kind: "token", value: token },
    });
    const merged = (await invoke(CH.getState)) as BackendState;
    const joined = merged.remoteInstances[0]!;
    expect(joined.status).toBe("joined");
    expect(joined.routinesEnabled).toBe(true);

    // Proxied routine CRUD from the joiner lands on the owner and relays remote-routines:state back into joiner sinks.
    const created = (await invoke(CH.remoteInstanceRequest, joined.id, CH.createRoutine, [
      {
        name: "Morning overview",
        instructions: "Summarize yesterday.",
        schedule: { kind: "cron", expr: "0 8 * * *" },
        timeZone: "UTC",
        destination: { projectCwd, workspace: "checkout" },
        mode: "build",
        model: null,
        thinkingLevel: null,
        spend: { warnUsd: null, maxUsd: null },
        toolPolicy: { allow: ["read"], deny: [], lastReviewedAt: "2026-11-22T00:00:00.000Z", reviewedCatalog: ["read"] },
        scripts: { pre: "", post: "" },
        timeoutMinutes: null,
        notifications: { onStart: false, onComplete: false, onFail: false, onApproval: false, agentMessage: false },
        artifact: null,
        enabled: false,
      },
    ])) as { id: string; name: string };
    const remoteState = (await invoke(CH.remoteInstanceRequest, joined.id, CH.getRoutinesState, [])) as {
      routines: Array<{ id: string; name: string }>;
    };
    expect(remoteState.routines.map((r) => r.id)).toEqual([created.id]);
    await invoke(CH.remoteInstanceRequest, joined.id, CH.updateRoutine, [created.id, { name: "Renamed" }]);
    const updatedState = (await invoke(CH.remoteInstanceRequest, joined.id, CH.getRoutinesState, [])) as {
      routines: Array<{ id: string; name: string }>;
    };
    expect(updatedState.routines[0]?.name).toBe("Renamed");
    expect(await invoke(CH.remoteInstanceRequest, joined.id, CH.removeRoutine, [created.id])).toEqual({
      releasedSessions: 0,
    });
    // models:readChat is proxied for the RoutineEditor model picker.
    const catalog = (await invoke(CH.remoteInstanceRequest, joined.id, CH.readChatModels, [])) as {
      models: unknown[];
    };
    expect(Array.isArray(catalog.models)).toBe(true);
    // Live remote-routines:state events were relayed into local sinks for the joined instance.
    expect(remoteRoutineEvents.some((e) => e.instanceId === joined.id && e.routineIds.includes(created.id))).toBe(true);
    // Routine settings stay strictly host-local (ADR-0028).
    for (const channel of [CH.setRoutinesEnabled, CH.setRoutineSpendDefaults]) {
      await expect(invoke(CH.remoteInstanceRequest, joined.id, channel, [])).rejects.toThrow(
        `channel ${channel} is not proxied`,
      );
    }

    // A live owner routine run publishes its routine metadata into the joiner's merged state.
    const ompBin = path.join(base, "omp");
    fs.writeFileSync(ompBin, "#!/bin/sh\n", { mode: 0o755 });
    vi.stubEnv("OMP_UI_OMP_PATH", ompBin);
    owner.refreshOmpPath();
    await owner.handlers().request[CH.spawnSession]({ origin: "resume", resumeTabId: "routine-run", cols: 80, rows: 24 });
    await vi.waitFor(async () => {
      const latest = (await invoke(CH.getState)) as BackendState;
      const run = latest.remoteInstances[0]?.projects.flatMap((g) => g.sessions).find((s) => s.tabId === "routine-run");
      expect(run?.routine).toMatchObject({ id: routineMark.id, name: "Inbox" });
    });
  });
});
