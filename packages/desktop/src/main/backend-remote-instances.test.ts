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
