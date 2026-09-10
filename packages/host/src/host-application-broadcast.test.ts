import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import {
  CH,
  dispatchNotify,
  dispatchRequest,
  PLAN_EXECUTE,
  PLAN_REVIEW_SENTINEL,
  ProviderKeys,
  Registry,
  RpcClient,
  type BackendState,
  type HostStatus,
  type ChannelTable,
  type KeyCipher,
  type SpawnRequest,
} from "@omp-ui/core";
import type { EventScope } from "@omp-ui/server";
import { HostApplication, omitUnless } from "./host-application";
import { SessionManager } from "./session/session-manager";
import {
  DESKTOP_CONNECTION_ID,
  hostDeps,
  ownedSessionRecord,
  remoteConnection,
  seedRegistry,
  testAuthority,
  testHost,
  type BoundConnection,
} from "./test/fixtures";

const resolveSessionLocationMock = vi.hoisted(() => vi.fn());
const RpcClientMock = vi.mocked(RpcClient);

vi.mock("@omp-ui/core", async (importOriginal) => {
  const original = await importOriginal();
  return {
    ...(original as object),
    resolveSessionLocation: resolveSessionLocationMock,
    RpcClient: vi.fn(),
    watchLineageDir: vi.fn(() => () => {}),
  };
});

let ipc: BoundConnection;

let base = "";

interface FakeRpc {
  kill: Mock;
  send: Mock;
  exit: (code: number) => void;
  frame: (frame: unknown) => void;
}

const rpcInstances: FakeRpc[] = [];

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function broadcastStates(): {
  projects: { project: { path: string } }[];
  themeId: string;
  localeId: string;
}[] {
  return ipc.sent
    .filter((event) => event.channel === CH.onStateChanged)
    .map((event) => event.args[0] as {
      projects: { project: { path: string } }[];
      themeId: string;
      localeId: string;
    });
}

beforeEach(() => {
  base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-broadcast-"));
  process.env.PI_CODING_AGENT_DIR = path.join(base, "agent");
  delete process.env.XDG_DATA_HOME;
  delete process.env.OMP_PROFILE;
  delete process.env.PI_PROFILE;

  const registryFile = path.join(base, "registry.json");
  seedRegistry(registryFile, {
    projects: [
      {
        path: "/p/a",
        name: "A",
        addedAt: "2026-08-01T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
      {
        path: "/p/b",
        name: "B",
        addedAt: "2026-08-02T00:00:00.000Z",
        lastModel: null,
        lastThinkingLevel: null,
        lastAdvisor: null,
        lastAdvisorModel: null,
        defaultModel: null,
        defaultAdvisorModel: null,
      },
    ],
    sessions: [ownedSessionRecord({ projectCwd: "/p/a" })],
  });

  rpcInstances.length = 0;
  resolveSessionLocationMock.mockReset().mockResolvedValue({ where: "missing" });
  RpcClientMock.mockReset();
  RpcClientMock.mockImplementation(function (
    this: unknown,
    opts: { onExit: (code: number | null) => void; onFrame: (frame: unknown) => void },
  ) {
    const instance = {
      kill: vi.fn(),
      send: vi.fn(),
      exit: (code: number) => opts.onExit(code),
      frame: (frame: unknown) => opts.onFrame(frame),
    };
    rpcInstances.push(instance);
    return instance;
  } as unknown as typeof RpcClient);
  ipc = testHost(registryFile);
});

afterEach(() => {
  if (base) fs.rmSync(base, { recursive: true, force: true });
});

describe("spawn argument boundary (issue #358)", () => {
  const request: SpawnRequest = {
    origin: "new",
    mode: "rpc-ui",
    projectCwd: "/p/a",
    advisor: false,
    cols: 120,
    rows: 40,
    worktree: null,
  };

  it("rejects malformed input before SessionManager.spawn", async () => {
    const spawn = vi.fn().mockResolvedValue({ tabId: "tab-new" });
    ipc = testHost(path.join(base, "registry.json"), {
      sessions: { spawn } as unknown as SessionManager,
    });

    await expect(
      ipc.invoke(CH.spawnSession, { ...request, unexpected: "do-not-echo" }),
    ).rejects.toThrow(`invalid arguments for ${CH.spawnSession}: argument 0`);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("passes a parsed request to SessionManager.spawn", async () => {
    const spawn = vi.fn().mockResolvedValue({ tabId: "tab-new" });
    ipc = testHost(path.join(base, "registry.json"), {
      sessions: { spawn } as unknown as SessionManager,
    });

    await expect(ipc.invoke(CH.spawnSession, request)).resolves.toEqual({ tabId: "tab-new" });
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(request);
    expect(spawn.mock.calls[0]![0]).not.toBe(request);
  });
});
describe("settings:setLocaleId (issue #363)", () => {
  it("replies, writes the registry, and broadcasts once", async () => {
    await expect(ipc.invoke(CH.setLocaleId, "ko")).resolves.toBeUndefined();
    expect(
      Registry.loadUnlocked(path.join(base, "registry.json")).getSetting("localeId"),
    ).toBe("ko");
    expect(broadcastStates()).toHaveLength(1);
    expect(broadcastStates()[0]?.localeId).toBe("ko");
  });
});

describe("ordered backend broadcasts (issue #146)", () => {
  it("finishes an older state build and delivery before starting the next one", async () => {
    const firstReadStarted = deferred<void>();
    const releaseFirstRead = deferred<{ where: "missing" }>();
    resolveSessionLocationMock.mockImplementationOnce(() => {
      firstReadStarted.resolve(undefined);
      return releaseFirstRead.promise;
    });

    const first = ipc.invoke(CH.toggleFavorite, "model-a");
    await firstReadStarted.promise;

    const second = ipc.invoke(CH.moveProject, "/p/a", null);
    expect(resolveSessionLocationMock).toHaveBeenCalledTimes(1);
    expect(broadcastStates()).toEqual([]);

    releaseFirstRead.resolve({ where: "missing" });
    await Promise.all([first, second]);

    const orders = broadcastStates().map((state) =>
      state.projects.map((group) => group.project.path),
    );
    expect(orders).toEqual([
      ["/p/a", "/p/b"],
      ["/p/b", "/p/a"],
    ]);
    expect(orders.at(-1)).toEqual(["/p/b", "/p/a"]);
  });

  it("keeps the chain usable after returning a failed build to its caller", async () => {
    resolveSessionLocationMock.mockRejectedValueOnce(new Error("state read failed"));

    const failed = ipc.invoke(CH.toggleFavorite, "model-a");
    await expect(failed).rejects.toThrow("state read failed");

    await expect(ipc.invoke(CH.setThemeId, "nord")).resolves.toBeUndefined();
    expect(broadcastStates()).toHaveLength(1);
    expect(broadcastStates()[0]?.themeId).toBe("nord");
  });
});

describe("per-connection state (issue #442)", () => {
  interface Delivery {
    scope: EventScope;
    state: BackendState;
  }

  const withSink = (): { host: HostApplication; deliveries: Delivery[] } => {
    ipc = testHost(path.join(base, "registry.json"));
    const deliveries: Delivery[] = [];
    ipc.host.addSink((scope, channel, args) => {
      if (channel === CH.onStateChanged) deliveries.push({ scope, state: args[0] as BackendState });
    });
    return { host: ipc.host, deliveries };
  };

  const to = (deliveries: Delivery[], id: string): Delivery[] =>
    deliveries.filter((d) => d.scope.kind === "connection" && d.scope.id === id);

  it("addresses state:changed to each connection with its own self stamped", async () => {
    const { host, deliveries } = withSink();
    const ctx = remoteConnection();
    host.handlers(ctx);

    await ipc.invoke(CH.setThemeId, "nord");

    expect(deliveries.map((d) => d.scope)).toEqual([
      { kind: "connection", id: DESKTOP_CONNECTION_ID },
      { kind: "connection", id: ctx.id },
    ]);
    expect(deliveries[0]!.state.self).toEqual({ role: "desktop", local: true });
    expect(deliveries[1]!.state.self).toEqual({ role: "browser", local: false });
    // Everything but `self` is the one shared build.
    expect(deliveries[1]!.state.themeId).toBe("nord");
    expect(deliveries[1]!.state.hostVersion).toBe("0.0.0");
    expect(deliveries[1]!.state.hostProtocol).toBe(2);
    expect(deliveries[1]!.state.protocolRange).toEqual({ min: 1, max: 2 });
    // The window hears its own copy and nobody else's.
    expect(broadcastStates()).toHaveLength(1);
    const windowState = ipc.sent.find((e) => e.channel === CH.onStateChanged)!.args[0] as BackendState;
    expect(windowState.self).toEqual({ role: "desktop", local: true });
  });

  it("stamps self on a direct state:get through the connection's own table", async () => {
    const { host } = withSink();
    const table = host.handlers(remoteConnection({ id: "conn-2", role: "instance" }));
    const state = (await dispatchRequest(table, CH.getState, [])) as BackendState;
    expect(state.self).toEqual({ role: "instance", local: false });
    const own = (await ipc.invoke(CH.getState)) as BackendState;
    expect(own.self).toEqual({ role: "desktop", local: true });
  });

  it("stops addressing a connection once it is closed", async () => {
    const { host, deliveries } = withSink();
    const ctx = remoteConnection();
    host.handlers(ctx);
    await ipc.invoke(CH.setThemeId, "nord");
    expect(to(deliveries, ctx.id)).toHaveLength(1);

    host.connectionClosed(ctx.id);
    await ipc.invoke(CH.setThemeId, "graphite");
    expect(to(deliveries, ctx.id)).toHaveLength(1);
    expect(to(deliveries, DESKTOP_CONNECTION_ID)).toHaveLength(2);
  });
});

describe("control plane (issue #442 §10.4)", () => {
  const backend = () => new HostApplication(hostDeps(path.join(base, "registry.json")));

  it("hands the host:* channels only to a connection whose grant carries control", () => {
    const b = backend();
    const control = b.handlers(remoteConnection({ id: "ctl", control: true }));
    const browser = b.handlers(remoteConnection({ id: "web", control: false }));
    for (const ch of [CH.getHostStatus, CH.stopHost, CH.getHostPairing]) {
      expect(control.request).toHaveProperty(ch);
      expect(browser.request).not.toHaveProperty(ch);
    }
    // The host-update surface is not control-gated: every role sees its idle state.
    expect(browser.request).toHaveProperty(CH.getHostUpdateState);
    expect(ipc.table.request).not.toHaveProperty(CH.getHostStatus);
  });

  it("answers host:status with the P shape and the idle host-update state", async () => {
    const b = backend();
    const table = b.handlers(remoteConnection({ id: "ctl", control: true }));
    b.handlers(remoteConnection({ id: "web" }));
    const status = (await dispatchRequest(table, CH.getHostStatus, [])) as HostStatus;
    expect(status).toMatchObject({
      schemaVersion: 1,
      dataRoot: base,
      hostVersion: "0.0.0",
      hostProtocol: 2,
      protocolRange: { min: 1, max: 2 },
      pid: process.pid,
      incarnation: 0,
      liveSessions: 0,
      connections: 2,
      verifier: { state: "degraded" },
      hostUpdate: { status: "idle", currentVersion: "0.0.0", stagedVersion: null, deferrals: 0 },
    });
    expect(typeof status.credentialBackend).toBe("string");
    expect(status.startedAtMs).toBeLessThanOrEqual(Date.now());
    await expect(dispatchRequest(table, CH.applyHostUpdate, [])).rejects.toThrow("no host updater");
    const state = (await dispatchRequest(table, CH.getState, [])) as BackendState;
    expect(state.hostUpdate).toEqual(status.hostUpdate);
  });
});

describe("omitUnless", () => {
  const table = {
    request: { "a:one": () => 1, "a:two": () => 2 },
    notify: { "a:one": () => {}, "b:three": () => {} },
  } as unknown as ChannelTable;

  it("returns the table itself when the condition holds", () => {
    expect(omitUnless(true, table, ["a:one"])).toBe(table);
  });

  it("drops the keys from both maps when it does not, leaving the input untouched", async () => {
    const gated = omitUnless(false, table, ["a:one", "b:three"]);
    expect(Object.keys(gated.request)).toEqual(["a:two"]);
    expect(Object.keys(gated.notify)).toEqual([]);
    expect(Object.keys(table.request)).toEqual(["a:one", "a:two"]);
    // A dropped request channel is unknown to the dispatcher, not a silent no-op.
    await expect(dispatchRequest(gated, "a:one", [])).rejects.toThrow("unknown channel a:one");
  });
});

describe("plan-review gate on the wire (issue #215)", () => {
  const LINEAGE_A = "omp-ui--a--11111111-2222-3333-4444-555555555555";
  const LINEAGE_B = "omp-ui--b--aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  const TAB_A = "tab-a";
  const TAB_B = "tab-b";

  const proposalFrame = (id: string) => ({
    type: "extension_ui_request",
    id,
    method: "select",
    title: `${PLAN_REVIEW_SENTINEL}${JSON.stringify({
      title: "add auth",
      planFilePath: "local://auth-plan.md",
      planAbsPath: "/l/auth-plan.md",
    })}`,
  });

  // broadcast() is private in production; the injected manager must fan out
  // on the backend's own chain, so the test reaches it through one named view.
  const backendBroadcast = (
    target: HostApplication,
  ): (() => Promise<void>) =>
    (target as unknown as { broadcast(): Promise<void> }).broadcast.bind(target);

  /**
   * A HostApplication whose SessionManager is injected so the test drives the
   * fake RpcClient directly. Spawns the /p/a session before returning, and
   * the manager's gate mutations broadcast through the backend's own chain,
   * exactly like the default manager's.
   */
  const gateBackend = async (): Promise<{ manager: SessionManager; rpc: FakeRpc }> => {
    const registryFile = path.join(base, "registry.json");
    seedRegistry(registryFile, {
      projects: [
        { path: "/p/a", name: "A", addedAt: "2026-08-01T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
        { path: "/p/b", name: "B", addedAt: "2026-08-02T00:00:00.000Z", lastModel: null, lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null, defaultAdvisorModel: null },
      ],
      sessions: [
        ownedSessionRecord({ tabId: TAB_A, lineageDir: LINEAGE_A, projectCwd: "/p/a", mode: "rpc-ui" }),
        ownedSessionRecord({ tabId: TAB_B, lineageDir: LINEAGE_B, projectCwd: "/p/b", mode: "rpc-ui" }),
      ],
    });
    const sessionsRoot = path.join(base, "agent", "sessions");
    fs.mkdirSync(path.join(sessionsRoot, LINEAGE_A), { recursive: true });
    fs.mkdirSync(path.join(sessionsRoot, LINEAGE_B), { recursive: true });

    const cipher: KeyCipher = {
      available: true,
      backend: "test",
      encrypt: (plain) => Buffer.from(plain),
      decrypt: (blob) => blob.toString("utf8"),
    };
    const backendRef: { current: HostApplication | null } = { current: null };
    const manager = new SessionManager({
      registry: Registry.loadUnlocked(registryFile),
      authority: testAuthority(base),
      providerKeys: new ProviderKeys(
        path.join(base, "provider-keys.json"),
        cipher,
        { OPENROUTER_API_KEY: "test-key" },
      ),
      getOmpPath: () => path.join(base, "omp"),
      getSessionsRoot: () => sessionsRoot,
      getArchiveRoot: () => path.join(base, "archive"),
      getWorktreesRoot: () => path.join(base, "worktrees"),
      send: () => {},
      broadcast: () =>
        backendRef.current === null
          ? Promise.resolve()
          : backendBroadcast(backendRef.current)(),
      // The injected manager reports to the backend's own tracker, as the default one does.
      attention: {
        turnStarted: (tabId) => backendRef.current?.attention.turnStarted(tabId),
        turnEnded: (tabId) => backendRef.current?.attention.turnEnded(tabId),
        planProposed: (tabId, title) => backendRef.current?.attention.planProposed(tabId, title),
        planSettled: (tabId) => backendRef.current?.attention.planSettled(tabId),
        stallPaused: (tabId, paused) => backendRef.current?.attention.stallPaused(tabId, paused),
        sessionExit: (tabId) => backendRef.current?.attention.sessionExit(tabId),
      },
    });
    ipc = testHost(registryFile, { sessions: manager });
    backendRef.current = ipc.host;
    await ipc.invoke(CH.spawnSession, {
      origin: "resume",
      resumeTabId: TAB_A,
      cols: 80,
      rows: 24,
    });
    return { manager, rpc: rpcInstances[0]! };
  };

  const lastBroadcast = (): BackendState => {
    const event = ipc.sent.filter((e) => e.channel === CH.onStateChanged).at(-1);
    expect(event).toBeDefined();
    return event!.args[0] as BackendState;
  };

  const sessionsOf = (state: BackendState, projectPath: string) =>
    state.projects.find((group) => group.project.path === projectPath)!.sessions;

  it("carries the pending plan on the summary and to the window sink", async () => {
    const { manager, rpc } = await gateBackend();
    expect(manager.planGate(TAB_A)).toBeUndefined();

    rpc.frame(proposalFrame("p1"));
    // The gate's broadcast queued first; this state change lands behind it, so
    // awaiting it proves the gate's state already reached the sink.
    await ipc.invoke(CH.toggleFavorite, "model-a");

    const broadcasted = lastBroadcast();
    expect(sessionsOf(broadcasted, "/p/a")[0]!.pendingPlan).toEqual({
      title: "add auth",
      planFilePath: "local://auth-plan.md",
      planAbsPath: "/l/auth-plan.md",
      frameId: "p1",
      proposedAt: expect.any(String),
    });
    expect(sessionsOf(broadcasted, "/p/b")[0]!.pendingPlan).toBeNull();
    expect(sessionsOf(broadcasted, "/p/b")[0]!.planSettle).toBeNull();

    // A direct state read — what a late-joining renderer fetches — agrees.
    const state = (await ipc.invoke(CH.getState)) as BackendState;
    expect(sessionsOf(state, "/p/a")[0]!.pendingPlan?.frameId).toBe("p1");
    expect(sessionsOf(state, "/p/b")[0]!.pendingPlan).toBeNull();
  });

  it("settles on the verdict, and clears both fields once the process exits", async () => {
    const { manager, rpc } = await gateBackend();
    rpc.frame(proposalFrame("p1"));

    manager.rpcSend(TAB_A, {
      type: "extension_ui_response",
      id: "p1",
      value: PLAN_EXECUTE,
    });
    await ipc.invoke(CH.toggleFavorite, "model-b");
    let state = lastBroadcast();
    expect(sessionsOf(state, "/p/a")[0]!.pendingPlan).toBeNull();
    expect(sessionsOf(state, "/p/a")[0]!.planSettle).toEqual({
      frameId: "p1",
      verdict: "executed",
    });

    rpc.exit(0);
    await ipc.invoke(CH.toggleFavorite, "model-c");
    state = lastBroadcast();
    expect(sessionsOf(state, "/p/a")[0]!.pendingPlan).toBeNull();
    expect(sessionsOf(state, "/p/a")[0]!.planSettle).toBeNull();
  });

  it("the host's attention level rides the summary and attention:changed; every sink hears it (issue #442)", async () => {
    const { rpc } = await gateBackend();
    const heard: unknown[][] = [];
    ipc.host.addSink((scope, ch, args) => {
      if (ch === CH.onAttentionChanged && scope.kind === "broadcast") heard.push(args);
    });
    rpc.frame({ type: "agent_start" });
    rpc.frame({ type: "agent_end" });
    await ipc.invoke(CH.toggleFavorite, "model-a");

    const level = sessionsOf(lastBroadcast(), "/p/a")[0]!.attention;
    expect(level).toMatchObject({ kind: "turn-complete", planTitle: null });
    expect(sessionsOf(lastBroadcast(), "/p/b")[0]!.attention).toBeNull();
    expect(ipc.sent.filter((e) => e.channel === CH.onAttentionChanged).map((e) => e.args)).toEqual([
      [TAB_A, level],
    ]);
    expect(heard).toContainEqual([TAB_A, level]);

    // The plan gate outranks the finished turn; the exit clears everything.
    rpc.frame({ type: "agent_start" });
    rpc.frame(proposalFrame("p1"));
    rpc.frame({ type: "agent_end" });
    await ipc.invoke(CH.toggleFavorite, "model-b");
    expect(sessionsOf(lastBroadcast(), "/p/a")[0]!.attention).toMatchObject({
      kind: "plan-pending",
      planTitle: "add auth",
    });

    rpc.exit(0);
    await ipc.invoke(CH.toggleFavorite, "model-c");
    expect(sessionsOf(lastBroadcast(), "/p/a")[0]!.attention).toBeNull();
    expect(heard.at(-1)).toEqual([TAB_A, null]);
  });
});

describe("orphan worktree sweep on startup (issue #262)", () => {
  it("removes an unreferenced checkout dir under the worktrees root", async () => {
    // The default worktrees root sits beside the registry file.
    const orphan = path.join(base, "worktrees", "proj--deadbeef", "omp-ui-cafe");
    fs.mkdirSync(orphan, { recursive: true });

    ipc = testHost(path.join(base, "registry.json"));

    // The constructor fires the sweep without awaiting it.
    await vi.waitFor(() => {
      expect(fs.existsSync(orphan)).toBe(false);
    });
  });
});

describe("dispatch and state builds (issue #301)", () => {
  it("summarizes every session concurrently", async () => {
    seedRegistry(path.join(base, "registry.json"), {
      projects: [
        {
          path: "/p/a",
          name: "A",
          addedAt: "2026-08-01T00:00:00.000Z",
          lastModel: null,
          lastThinkingLevel: null,
          lastAdvisor: null,
          lastAdvisorModel: null,
          defaultModel: null,
          defaultAdvisorModel: null,
        },
      ],
      sessions: [
        ownedSessionRecord({ projectCwd: "/p/a" }),
        ownedSessionRecord({
          tabId: "tab-2",
          projectCwd: "/p/a",
          lineageDir: "omp-ui--proj--99999999-8888-7777-6666-555555555555",
        }),
      ],
    });
    const gate = deferred<void>();
    let locationReads = 0;
    resolveSessionLocationMock.mockImplementation(() => {
      locationReads += 1;
      return gate.promise.then(() => ({ where: "missing" as const }));
    });

    ipc = testHost(path.join(base, "registry.json"));
    const pending = ipc.invoke(CH.getState);

    // Both summarizes must have started before either resolved: a serial build
    // stalls at one outstanding location read.
    expect(locationReads).toBe(2);
    gate.resolve(undefined);
    const state = (await pending) as BackendState;
    expect(state.projects.map((group) => group.sessions.length)).toEqual([2]);
  });

  it("keys viewed reports by connection id and drops them when the connection closes (issue #442)", async () => {
    ipc = testHost(path.join(base, "registry.json"));
    const remote = ipc.host.handlers(remoteConnection({ id: "conn-phone" }));

    await ipc.invoke(CH.tabViewed, "tab-1");
    expect(ipc.host.sessions.isViewed("tab-1")).toBe(true);

    // A second connection's report is its own: it neither replaces nor clears the first.
    dispatchNotify(remote, CH.tabViewed, ["tab-2"]);
    expect(ipc.host.sessions.isViewed("tab-1")).toBe(true);
    expect(ipc.host.sessions.isViewed("tab-2")).toBe(true);

    ipc.host.connectionClosed("conn-phone");
    expect(ipc.host.sessions.isViewed("tab-2")).toBe(false);
    expect(ipc.host.sessions.isViewed("tab-1")).toBe(true);

    // The desktop's own connection re-reporting replaces its previous report.
    await ipc.invoke(CH.tabViewed, null);
    expect(ipc.host.sessions.isViewed("tab-1")).toBe(false);
  });
});
