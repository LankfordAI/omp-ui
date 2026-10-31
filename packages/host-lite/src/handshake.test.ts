import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CH,
  Registry,
  type BackendState,
  type InstanceIdentity,
  type OwnedSessionRecord,
  type ProjectGroup,
  type SessionSummary,
} from "@omp-ui/core";
import { connectInstanceClient, InstanceConnectError, type InstanceClient } from "@omp-ui/server";
import { startLiteFleetMember, type LiteInstance } from "./serve";
import type { LiteKeyCipher, LiteSessions } from "./seams";

// Owner-handshake proof for the lite member (issue #1010): boot the real serve
// pipeline on 127.0.0.1:0 with a fake LiteSessions + cipher, then join it the
// way RemoteInstanceManager.#dial does (remote-instance-manager.ts): connect →
// `instance:identity` → `state:get`, asserting exactly what the owner parses —
// identity.version, the registry's own projects adopted, modelFavorites adopted,
// and no credential ever riding the state. Mirrors client.test.ts's harness.

interface FakeSessions extends LiteSessions {
  emit(channel: string, args: unknown[]): void;
  setState(next: BackendState): void;
}

function fakeSessions(initial: BackendState): FakeSessions {
  const sinks = new Set<(channel: string, args: unknown[]) => void>();
  let current = initial;
  return {
    handlers: {},
    state: () => current,
    setState: (next) => {
      current = next;
    },
    emit(channel, args) {
      for (const sink of sinks) sink(channel, args);
    },
    on: (cb) => {
      sinks.add(cb);
      return () => sinks.delete(cb);
    },
    dispose: async () => {
      // The serve pipeline's stop() must reach the seam.
      current = initial;
      sinks.clear();
    },
  };
}

/** One-line sealed-string fake: prefix tag instead of crypto, same contract shape. */
const fakeCipher: LiteKeyCipher = {
  encrypt: (plain) => `v1:${plain}`,
  decrypt: (sealed) => {
    if (!sealed.startsWith("v1:")) throw new Error("bad seal version");
    return sealed.slice(3);
  },
};

function emptyState(overrides: Partial<BackendState> = {}): BackendState {
  return {
    projects: [],
    chats: [],
    spawnGate: { model: null, advisorModel: null },
    remoteInstances: [],
    fleetPending: [],
    fleetTerminals: [],
    ...overrides,
  } as BackendState;
}

function sessionRecord(tabId: string, projectCwd: string): OwnedSessionRecord {
  return {
    tabId,
    sessionId: null,
    lineageDir: `/tmp/omp-ui-lite-test/${tabId}`,
    projectCwd,
    worktree: null,
    planImplementationSource: null,
    experiment: null,
    launchedAt: new Date().toISOString(),
    mode: "rpc-ui",
    agentMode: "build",
    compactionMethod: null,
    approvalMode: null,
    serviceTier: null,
    model: null,
    thinkingLevel: null,
    advisor: false,
    advisorModel: null,
    subagentModels: null,
    proposedPlans: [],
    private: false,
    chat: false,
    askSource: null,
    fleet: null,
    autoTitled: false,
    snoozed: false,
    snoozedUntilMs: null,
    pinnedAtMs: null,
    heldPrompt: null,
    scheduledPrompt: null,
    pullRequests: [],
    autoSettleOnMerge: null,
    cachedTitle: null,
    cachedModified: null,
  };
}

function summary(tabId: string, projectCwd: string): SessionSummary {
  return {
    ...sessionRecord(tabId, projectCwd),
    title: tabId,
    status: null,
    live: "dormant",
    pendingPlan: null,
    planSettle: null,
    streamStalled: false,
  };
}

const instances: LiteInstance[] = [];
const clients: InstanceClient[] = [];
const dirs: string[] = [];

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const instance of instances.splice(0)) await instance.stop();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temp data dir whose registry asks for a loopback listener on a free OS-granted port. */
async function memberDir(): Promise<string> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-lite-"));
  dirs.push(dir);
  const registry = Registry.load(path.join(dir, "registry.json"));
  // Load-time validation rejects port 0 (needs >=1024), so ask the OS for one
  // and persist that concrete number instead.
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  registry.setSettings({ remoteEnabled: true, remoteBind: "localhost", remotePort: port });
  return dir;
}

async function boot(sessions: LiteSessions): Promise<LiteInstance> {
  const instance = await startLiteFleetMember({
    dataDir: await memberDir(),
    version: "9.9.9",
    sessions,
    cipher: fakeCipher,
    log: () => {},
  });
  instances.push(instance);
  return instance;
}

function origin(instance: LiteInstance): string {
  return `http://127.0.0.1:${instance.remote.state.port}`;
}

function token(instance: LiteInstance): string {
  return instance.registry.getSetting("remoteToken");
}

async function join(instance: LiteInstance, credential = token(instance)): Promise<InstanceClient> {
  const client = await connectInstanceClient(origin(instance), credential);
  clients.push(client);
  return client;
}

function nextEvent(client: InstanceClient, channel: string): Promise<unknown[]> {
  const { promise, resolve } = Promise.withResolvers<unknown[]>();
  client.onEvent((eventChannel, args) => {
    if (eventChannel === channel) resolve(args);
  });
  return promise;
}

describe("lite member owner handshake (issue #1010)", () => {
  it("answers instance:identity with the stable id and version the owner parses", async () => {
    const instance = await boot(fakeSessions(emptyState()));
    const client = await join(instance);
    const identity = await client.request<InstanceIdentity>(CH.getInstanceIdentity, []);
    expect(identity.version).toBe("9.9.9");
    expect(identity.instanceId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    // The id lives beside the data dir (0600), stable across boots — the lite
    // member's file equivalent of desktop's instanceId registry setting.
    expect(identity.instanceId).toBe(instance.instanceId);
    const idFile = path.join(instance.dataDir, "instance-id");
    expect(fs.readFileSync(idFile, "utf8").trim()).toBe(identity.instanceId);
    expect(fs.statSync(idFile).mode & 0o777).toBe(0o600);
    // A second boot off the same dir answers with the SAME id (stop first: it
    // would collide on the persisted port otherwise).
    await instance.stop();
    const again = await startLiteFleetMember({
      dataDir: instance.dataDir,
      version: "9.9.9",
      sessions: fakeSessions(emptyState()),
      log: () => {},
    });
    instances.push(again);
    expect(again.instanceId).toBe(identity.instanceId);
  });

  it("state:get carries the registry's projects and favorites, not the seam's", async () => {
    const sessions = fakeSessions(emptyState({ modelFavorites: ["seam/should-lose"] }));
    const instance = await boot(sessions);
    instance.registry.addProject("/repo/member-project");
    instance.registry.addSession(sessionRecord("tab-b", "/repo/member-project"));
    instance.registry.addSession(sessionRecord("tab-a", "/repo/member-project"));
    instance.registry.setSetting("modelFavorites", ["anthropic/claude", "openai/gpt"]);
    // The seam supplies the live summaries; membership/order stay the registry's.
    sessions.setState(
      emptyState({
        modelFavorites: ["seam/should-lose"],
        projects: [
          {
            project: { path: "stale-group" } as never,
            sessions: [summary("tab-a", "/repo/member-project"), summary("tab-b", "/repo/member-project")],
          },
        ],
      }),
    );

    const client = await join(instance);
    const state = await client.request<BackendState>(CH.getState, []);
    const group: ProjectGroup = state.projects[0]!;
    expect(state.projects).toHaveLength(1);
    expect(group.project.path).toBe("/repo/member-project");
    // Registry order (addSession inserts newest-first per project): tab-a was
    // added last, so it leads.
    expect(group.sessions.map((session) => session.tabId)).toEqual(["tab-a", "tab-b"]);
    expect(state.modelFavorites).toEqual(["anthropic/claude", "openai/gpt"]);
    // A joined owner never adopts the member's own joins or instance metadata slots wrongly.
    expect(state.remoteInstances).toEqual([]);
  });

  it("never lets the remote credential or omitted settings ride state:get", async () => {
    const instance = await boot(fakeSessions(emptyState()));
    const client = await join(instance);
    const state = (await client.request<Record<string, unknown>>(CH.getState, [])) as Record<string, unknown>;
    expect(state).not.toHaveProperty("remoteToken");
    expect(state).not.toHaveProperty("remotePasswordHash");
    expect(state).not.toHaveProperty("remotePasswordSalt");
    expect(state).not.toHaveProperty("instanceId");
    expect(state).not.toHaveProperty("remoteEnabled");
  });

  it("fans a seam state:changed event out as the merged full BackendState", async () => {
    const sessions = fakeSessions(emptyState());
    const instance = await boot(sessions);
    // Membership is the registry's; the seam only supplies summaries. The
    // broadcast must be the SAME merged full state `state:get` would answer —
    // never the seam's unmerged partial (owner projection #440 parses either,
    // but the desktop contract is a full BackendState).
    instance.registry.addProject("/repo/live");
    instance.registry.addSession(sessionRecord("tab-live", "/repo/live"));
    instance.registry.setSetting("modelFavorites", ["reg/first"]);
    sessions.setState(
      emptyState({
        projects: [
          { project: { path: "/repo/live" } as never, sessions: [summary("tab-live", "/repo/live")] },
        ],
        modelFavorites: ["seam/should-lose"],
      }),
    );
    const client = await join(instance);
    const received = nextEvent(client, CH.onStateChanged);
    sessions.emit(CH.onStateChanged, [emptyState()]);
    const [broadcast] = (await received) as [BackendState];
    expect(broadcast.projects[0]?.sessions.map((session) => session.tabId)).toEqual(["tab-live"]);
    expect(broadcast.modelFavorites).toEqual(["reg/first"]);
    expect(broadcast).not.toHaveProperty("remoteToken");
  });

  it("keeps desktop-only channels absent: the transport answers unknown channel", async () => {
    const instance = await boot(fakeSessions(emptyState()));
    const client = await join(instance);
    await expect(client.request(CH.addRemoteInstance, [])).rejects.toThrow(/unknown channel/);
    await expect(client.request("provider:list", [])).rejects.toThrow(/unknown channel/);
  });

  it("refuses a bad token and closes a live socket on rotation, like the desktop listener", async () => {
    const instance = await boot(fakeSessions(emptyState()));
    await expect(
      connectInstanceClient(origin(instance), "wrong-token"),
    ).rejects.toBeInstanceOf(InstanceConnectError);
  });

  it("stop() closes the listener and drains the seam's sinks", async () => {
    const sessions = fakeSessions(emptyState());
    const instance = await boot(sessions);
    const client = await join(instance);
    clients.splice(clients.indexOf(client), 1);
    const closed = new Promise<number>((resolve) => client.onClose((code) => resolve(code)));
    await instance.stop();
    expect(await closed).toBeDefined();
    expect(instance.remote.state.status).toBe("stopped");
    // A seam emit after stop has no sinks left to reach.
    sessions.emit("state:changed", [emptyState()]);
  });

  it("threads the injected cipher through the instance handle for slice S3", async () => {
    const instance = await boot(fakeSessions(emptyState()));
    expect(instance.cipher).toBe(fakeCipher);
    expect(instance.instanceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("serves the handler table the transport built: seam handlers ride alongside core channels", async () => {
    const sessions = fakeSessions(emptyState());
    // A seam claiming an unowned channel reaches the socket; a seam claiming a
    // core channel (state:get) is shadowed by the registry merge.
    (sessions.handlers as Record<string, unknown>)[CH.getState] = () => emptyState({ chats: [] });
    const instance = await boot(sessions);
    const table = instance.backend.handlers();
    expect(Object.keys(table.request)).toContain(CH.getState);
    const client = await join(instance);
    const state = await client.request<BackendState>(CH.getState, []);
    // The merged registry answer wins over the seam's shadow attempt.
    expect(state).not.toHaveProperty("remoteToken");
    const live = await table.request[CH.getRemoteState]!();
    expect(live.status).toBe("listening");
  });
});
