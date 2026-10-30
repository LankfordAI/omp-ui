import { afterEach, describe, expect, it } from "vitest";
import type { ChannelTable } from "@omp-ui/core";
import type { McpScope, McpToolName } from "@omp-ui/core/mcp-endpoint";
import { startRemoteServer, type McpCaller, type McpIntake, type RemoteServerHandle } from "./index";
import { mintMcpToken } from "./mcp";
import { mintRemoteToken } from "./token";

const REMOTE_TOKEN = mintRemoteToken();
const CLIENT_TOKEN = mintMcpToken();

interface FakeIntake extends McpIntake {
  on: boolean;
  scope: McpScope;
  calls: Array<{ caller: McpCaller; name: McpToolName; args: unknown }>;
}

function fakeIntake(scope: McpScope = "read"): FakeIntake {
  const intake: FakeIntake = {
    on: true,
    scope,
    calls: [],
    enabled: () => intake.on,
    authenticate: (token) => (token === CLIENT_TOKEN ? { clientId: "client-1", scope: intake.scope } : null),
    callTool: async (caller, name, args) => {
      intake.calls.push({ caller, name, args });
      return { text: `ran ${name}`, isError: false };
    },
  };
  return intake;
}

const host = {
  handlers: () => ({ request: {}, notify: {} }) as unknown as ChannelTable,
  addSink: () => () => {},
};

const open: RemoteServerHandle[] = [];
afterEach(async () => {
  for (const h of open.splice(0)) await h.close();
});

async function serve(intake: FakeIntake): Promise<string> {
  const handle = await startRemoteServer({
    host,
    token: REMOTE_TOKEN,
    bind: "localhost",
    port: 0,
    webRoot: "/nonexistent-web-root",
    password: null,
    mcp: intake,
    version: "9.9.9",
  });
  open.push(handle);
  return `http://127.0.0.1:${handle.port}/mcp`;
}

function rpc(body: unknown, token: string | null = CLIENT_TOKEN, extra: Record<string, string> = {}): RequestInit {
  return {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
      ...extra,
    },
    body: JSON.stringify(body),
  };
}

describe("MCP endpoint route", () => {
  it("initializes with the client's protocol revision and lists only tools its scope allows", async () => {
    const intake = fakeIntake("read");
    const url = await serve(intake);
    const init = await fetch(url, rpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }));
    expect(init.status).toBe(200);
    expect(await init.json()).toMatchObject({ result: { protocolVersion: "2025-06-18", serverInfo: { name: "omp-ui", version: "9.9.9" } } });

    const tool = (name: string) => expect.objectContaining({ name });
    const list = await fetch(url, rpc({ jsonrpc: "2.0", id: 2, method: "tools/list" }));
    expect(await list.json()).toMatchObject({
      result: { tools: [tool("list_machines"), tool("list_projects"), tool("list_sessions"), tool("session_status")] },
    });

    intake.scope = "send";
    const all = await fetch(url, rpc({ jsonrpc: "2.0", id: 3, method: "tools/list" }));
    expect(await all.json()).toMatchObject({
      result: {
        tools: [
          tool("list_machines"),
          tool("list_projects"),
          tool("list_sessions"),
          tool("session_status"),
          tool("start_session"),
          tool("send_to_session"),
        ],
      },
    });
  });

  it("answers tools/call with the intake's text as MCP content", async () => {
    const intake = fakeIntake();
    const url = await serve(intake);
    const res = await fetch(url, rpc({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "list_sessions", arguments: { machine: "box" } } }));
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 7, result: { content: [{ type: "text", text: "ran list_sessions" }], isError: false } });
    expect(intake.calls).toEqual([{ caller: { clientId: "client-1", scope: "read" }, name: "list_sessions", args: { machine: "box" } }]);
  });

  it("never accepts the remote-access token, a token query, or a cookie in place of a client token", async () => {
    const intake = fakeIntake();
    const url = await serve(intake);
    const ping = { jsonrpc: "2.0", id: 1, method: "ping" };
    const asBearer = await fetch(url, rpc(ping, REMOTE_TOKEN));
    const asQuery = await fetch(`${url}?t=${encodeURIComponent(CLIENT_TOKEN)}`, rpc(ping, null));
    const asCookie = await fetch(url, rpc(ping, null, { Cookie: `omp_ui_token=${encodeURIComponent(REMOTE_TOKEN)}` }));
    const none = await fetch(url, rpc(ping, null));
    expect([asBearer.status, asQuery.status, asCookie.status, none.status]).toEqual([401, 401, 401, 401]);
    expect(intake.calls).toHaveLength(0);
  });

  it("refuses a cross-origin browser request even with a valid token", async () => {
    const url = await serve(fakeIntake());
    const res = await fetch(url, rpc({ jsonrpc: "2.0", id: 1, method: "ping" }, CLIENT_TOKEN, { Origin: "https://evil.example" }));
    expect(res.status).toBe(403);
  });

  it("is not a route while the switch is off: the remote auth wall answers, and a client token opens nothing", async () => {
    const intake = fakeIntake();
    intake.on = false;
    const url = await serve(intake);
    const res = await fetch(url, rpc({ jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(401);
    expect(await res.text()).toBe("unauthorized");
    const root = await fetch(url.replace(/\/mcp$/, "/healthz"), { headers: { Authorization: `Bearer ${CLIENT_TOKEN}` } });
    expect(root.status).toBe(401);
  });

  it("acknowledges notifications with 202 and refuses GET streams with 405", async () => {
    const url = await serve(fakeIntake());
    const note = await fetch(url, rpc({ jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(note.status).toBe(202);
    const stream = await fetch(url, { headers: { Authorization: `Bearer ${CLIENT_TOKEN}`, Accept: "text/event-stream" } });
    expect(stream.status).toBe(405);
  });
});
