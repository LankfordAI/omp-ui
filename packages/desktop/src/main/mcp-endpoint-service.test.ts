import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LOCAL_MACHINE_KEY,
  MCP_GLOBAL_PER_HOUR,
  McpCallLog,
  McpClientStore,
  type FleetDispatchRequest,
  type FleetMachine,
  type FleetToolSendArgs,
  type SessionSummary,
} from "@omp-ui/core";
import { McpEndpointService, type FleetSessionRow } from "./mcp-endpoint-service";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const LOCAL: FleetMachine = {
  key: LOCAL_MACHINE_KEY,
  nickname: null,
  status: "ready",
  error: null,
  preference: "normal",
  receivedAt: 0,
  grantRung: null,
  address: null,
  sshReachable: null,
  maintenance: null,
  report: {
    instanceId: "me",
    label: "desk",
    version: "1.0.0",
    platform: "linux",
    arch: "x64",
    cpuCount: 8,
    cpuUtilization: 0.1,
    totalMemoryBytes: 100,
    availableMemoryBytes: 80,
    liveSessions: 0,
    runningTurns: 0,
    sampledAt: 0,
    projects: [
      { path: "/work/app", name: "app", repositoryKey: "github.com/acme/app", headCommit: null, providerReady: true, advisor: false, advisorModel: null },
    ],
    user: null,
    projectRoots: null,
    os: null,
    packageManagers: null,
    ompVersion: null,
    ompPath: null,
    ompPinned: false,
    ompBelowMinimum: false,
    packageFormat: null,
    appLatestVersion: null,
    appUpdateStaged: false,
    modelFavorites: [],
  },
};

/** Only the fields the endpoint reads; the rest of SessionSummary is irrelevant to it. */
function row(tabId: string, patch: Partial<SessionSummary> = {}): FleetSessionRow {
  const summary = {
    tabId,
    title: `title ${tabId}`,
    projectCwd: "/work/app",
    launchedAt: "2026-10-30T10:00:00Z",
    cachedModified: null,
    live: "dormant",
    pendingPlan: null,
    private: false,
    chat: false,
    fleet: null,
    ...patch,
  } as SessionSummary;
  return { machineKey: LOCAL_MACHINE_KEY, nickname: null, summary };
}

function mcpChild(tabId: string, clientId: string, dispatchId: string): FleetSessionRow {
  return row(tabId, {
    fleet: {
      dispatchId,
      batchId: null,
      dispatchedAt: "2026-10-30T10:00:00Z",
      requestedBy: { instanceId: "me", label: "desk", kind: "mcp", sourceTabId: clientId },
    },
  });
}

function make(sessions: FleetSessionRow[] = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mcp-endpoint-"));
  dirs.push(dir);
  const dispatched: Array<{ clientId: string; req: FleetDispatchRequest }> = [];
  const sent: Array<{ clientId: string; args: FleetToolSendArgs }> = [];
  const clock = { now: Date.parse("2026-10-30T12:00:00Z") };
  const service = new McpEndpointService({
    store: new McpClientStore(path.join(dir, "mcp-clients.json")),
    log: new McpCallLog(path.join(dir, "mcp-calls.json")),
    enabled: () => true,
    setEnabled: () => {},
    instanceId: () => "me",
    machines: async () => [LOCAL],
    sessions: async () => sessions,
    summary: async (_machine, tabId) => `# ${tabId}\n\n## Where it landed\n\ndone`,
    dispatch: async (clientId, req) => {
      dispatched.push({ clientId, req });
      return {
        batchId: null,
        outcomes: [{ dispatchId: "d-new", machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app", status: "started", tabId: "tab-new", choice: null }],
      };
    },
    send: async (clientId, args) => {
      sent.push({ clientId, args });
      return { status: "delivered" };
    },
    publish: () => {},
    now: () => clock.now,
  });
  return { service, dispatched, sent, clock, dir };
}

const META = { remoteAddress: "127.0.0.1" };

describe("McpEndpointService", () => {
  it("stores only the token's hash and authenticates by the token alone", () => {
    const { service, dir } = make();
    const { client, token } = service.create({ name: "Claude", scope: "read", enabled: true, ratePerHour: 6 });
    expect(fs.readFileSync(path.join(dir, "mcp-clients.json"), "utf8")).not.toContain(token);
    expect(service.authenticate(token)).toEqual({ clientId: client.id, scope: "read" });
    expect(service.authenticate(`${token}x`)).toBeNull();
    service.update(client.id, { enabled: false });
    expect(service.authenticate(token)).toBeNull();
  });

  it("rotating invalidates the old token at once", () => {
    const { service } = make();
    const { client, token } = service.create({ name: "Claude", scope: "read", enabled: true, ratePerHour: 6 });
    const rotated = service.rotate(client.id);
    expect(service.authenticate(token)).toBeNull();
    expect(service.authenticate(rotated.token)).toEqual({ clientId: client.id, scope: "read" });
  });

  it("refuses a tool above the client's scope, re-reading the scope at call time", async () => {
    const { service, dispatched } = make();
    const { client, token } = service.create({ name: "Bot", scope: "dispatch", enabled: true, ratePerHour: 6 });
    const caller = service.authenticate(token)!;
    service.update(client.id, { scope: "read" });
    const result = await service.callTool(caller, "start_session", { prompt: "hi", project: "/work/app" }, META);
    expect(result.isError).toBe(true);
    expect(dispatched).toHaveLength(0);
    expect(service.state().calls.at(-1)).toMatchObject({ tool: "start_session", outcome: "forbidden" });
  });

  it("starts sessions in Plan mode by default under the client's own requester id, and never audits the prompt", async () => {
    const { service, dispatched } = make();
    const { client, token } = service.create({ name: "Bot", scope: "dispatch", enabled: true, ratePerHour: 6 });
    const result = await service.callTool(service.authenticate(token)!, "start_session", { prompt: "SECRET PLAN TEXT", project: "/work/app" }, META);
    expect(result).toMatchObject({ isError: false });
    expect(result.text).toContain("tab-new");
    expect(dispatched).toEqual([
      {
        clientId: client.id,
        req: expect.objectContaining({ planMode: true, workspace: "worktree", targets: { kind: "explicit", picks: [{ machineKey: LOCAL_MACHINE_KEY, projectCwd: "/work/app" }] } }),
      },
    ]);
    expect(JSON.stringify(service.state().calls)).not.toContain("SECRET PLAN TEXT");
  });

  it("sends only to sessions this client started; another client's session reads as not found", async () => {
    const sessions: FleetSessionRow[] = [];
    const { service, sent } = make(sessions);
    const mine = service.create({ name: "A", scope: "send", enabled: true, ratePerHour: 6 });
    const other = service.create({ name: "B", scope: "send", enabled: true, ratePerHour: 6 });
    sessions.push(mcpChild("tab-a", mine.client.id, "d-a"));

    const refused = await service.callTool(service.authenticate(other.token)!, "send_to_session", { session: "tab-a", message: "hi" }, META);
    expect(refused.isError).toBe(true);
    expect(sent).toHaveLength(0);

    const ok = await service.callTool(service.authenticate(mine.token)!, "send_to_session", { session: "tab-a", message: "hi", mode: "steer" }, META);
    expect(ok).toEqual({ text: "delivered to session tab-a", isError: false });
    expect(sent).toEqual([{ clientId: mine.client.id, args: { dispatchId: "d-a", message: "hi", mode: "steer" } }]);
  });

  it("never lists or reads private sessions or chats", async () => {
    const { service } = make([row("tab-public"), row("tab-private", { private: true }), row("tab-chat", { chat: true })]);
    const { token } = service.create({ name: "Reader", scope: "read", enabled: true, ratePerHour: 6 });
    const caller = service.authenticate(token)!;
    const list = await service.callTool(caller, "list_sessions", {}, META);
    expect(list.text).toContain("tab-public");
    expect(list.text).not.toContain("tab-private");
    expect(list.text).not.toContain("tab-chat");
    expect((await service.callTool(caller, "session_status", { session: "tab-private" }, META)).isError).toBe(true);
  });

  it("caps starts per client per hour and app-wide, until the hour rolls", async () => {
    const { service, dispatched, clock } = make();
    const { token } = service.create({ name: "Bot", scope: "dispatch", enabled: true, ratePerHour: 1 });
    const caller = service.authenticate(token)!;
    const start = () => service.callTool(caller, "start_session", { prompt: "go", project: "/work/app" }, META);
    expect((await start()).isError).toBe(false);
    expect((await start()).isError).toBe(true);
    expect(service.state().calls.at(-1)).toMatchObject({ outcome: "rate-limited" });
    clock.now += 3_600_000;
    expect((await start()).isError).toBe(false);
    expect(dispatched).toHaveLength(2);

    const { service: wide, dispatched: wideDispatched } = make();
    const unlimited = wide.authenticate(wide.create({ name: "Wide", scope: "dispatch", enabled: true, ratePerHour: null }).token)!;
    for (let i = 0; i < MCP_GLOBAL_PER_HOUR; i++) await wide.callTool(unlimited, "start_session", { prompt: "go", project: "/work/app" }, META);
    expect((await wide.callTool(unlimited, "start_session", { prompt: "go", project: "/work/app" }, META)).isError).toBe(true);
    expect(wideDispatched).toHaveLength(MCP_GLOBAL_PER_HOUR);
  });
});
