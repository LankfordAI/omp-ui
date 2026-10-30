import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  MCP_BODY_MAX_BYTES,
  MCP_PROTOCOL_VERSIONS,
  MCP_TOKEN_PREFIX,
  MCP_TOOLS,
  mcpScopeAllows,
  type McpScope,
  type McpToolName,
} from "@omp-ui/core/mcp-endpoint";

/**
 * omp-ui's MCP endpoint transport (issue #996, ADR-0080): MCP streamable HTTP,
 * stateless, JSON responses only. One POST carries one JSON-RPC message; there
 * is no server-initiated stream (GET answers 405, which the spec allows) and
 * no Mcp-Session-Id. Authentication is the client's own bearer token, checked
 * by the intake; the remote-access credential never opens this route.
 */

/** 128 random bits, base64url: an address, not a credential. */
export function mintMcpClientId(): string {
  return randomBytes(16).toString("base64url");
}

/** 256 random bits, base64url, behind a recognizable prefix. */
export function mintMcpToken(): string {
  return `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

/** Who a token belongs to; never the token itself. */
export interface McpCaller {
  clientId: string;
  scope: McpScope;
}

/** Request facts handed to the intake; never the headers, never a credential. */
export interface McpRequestMeta {
  remoteAddress: string;
}

export interface McpToolResult {
  text: string;
  isError: boolean;
}

/** Main's side of the MCP route; the server owns HTTP, JSON-RPC, and the tool listing. */
export interface McpIntake {
  enabled(): boolean;
  /** The enabled client a bearer token belongs to, or null. */
  authenticate(token: string): McpCaller | null;
  /** One tools/call on a catalog tool; the intake checks the caller's scope and audits every call. */
  callTool(caller: McpCaller, name: McpToolName, args: unknown, meta: McpRequestMeta): Promise<McpToolResult>;
}

const JSONRPC_PARSE_ERROR = -32700;
const JSONRPC_INVALID_REQUEST = -32600;
const JSONRPC_METHOD_NOT_FOUND = -32601;
const JSONRPC_INVALID_PARAMS = -32602;
const JSONRPC_INTERNAL_ERROR = -32603;

type RpcId = string | number;

function json(res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(text), ...extra });
  res.end(text);
}

function rpcError(res: ServerResponse, id: RpcId | null, code: number, message: string, status = 200): void {
  json(res, status, { jsonrpc: "2.0", id, error: { code, message } });
}

/**
 * True when the request carries no Origin, or one naming the same host it was
 * sent to. A browser page on another origin cannot drive the endpoint even if
 * it learned a token (the spec's DNS-rebinding guard).
 */
function originAllowed(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function bearer(req: IncomingMessage): string | null {
  const value = req.headers.authorization;
  if (typeof value !== "string") return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value);
  return match === null ? null : match[1]!;
}

function toolsFor(scope: McpScope): Array<Record<string, unknown>> {
  return MCP_TOOLS.filter((t) => mcpScopeAllows(scope, t.scope)).map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema,
    annotations: { readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
  }));
}

/** Handles one request to MCP_PATH. The caller has already checked that the intake is enabled. */
export function handleMcpRequest(req: IncomingMessage, res: ServerResponse, intake: McpIntake, serverVersion: string): void {
  if (!originAllowed(req)) {
    json(res, 403, { error: "origin not allowed" });
    return;
  }
  const token = bearer(req);
  const caller = token === null ? null : intake.authenticate(token);
  if (caller === null) {
    // Unknown, disabled, and absent tokens look the same; nothing is audited (ADR-0080).
    json(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": 'Bearer realm="omp-ui"' });
    return;
  }
  if (req.method === "GET" || req.method === "DELETE") {
    // No server-initiated stream and no session to end.
    json(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    return;
  }
  if (req.method !== "POST") {
    json(res, 405, { error: "method not allowed" }, { Allow: "POST" });
    return;
  }
  const version = req.headers["mcp-protocol-version"];
  if (typeof version === "string" && !(MCP_PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    json(res, 400, { error: `unsupported MCP-Protocol-Version ${version}` });
    return;
  }
  const declared = Number(req.headers["content-length"] ?? "0");
  if (Number.isFinite(declared) && declared > MCP_BODY_MAX_BYTES) {
    res.once("finish", () => req.destroy());
    json(res, 413, { error: `body exceeds ${MCP_BODY_MAX_BYTES} bytes` }, { Connection: "close" });
    return;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  let aborted = false;
  req.on("data", (chunk: Buffer) => {
    if (aborted) return;
    size += chunk.length;
    if (size > MCP_BODY_MAX_BYTES) {
      aborted = true;
      res.once("finish", () => req.destroy());
      json(res, 413, { error: `body exceeds ${MCP_BODY_MAX_BYTES} bytes` }, { Connection: "close" });
      return;
    }
    chunks.push(chunk);
  });
  req.on("end", () => {
    if (aborted) return;
    let message: unknown;
    try {
      message = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      rpcError(res, null, JSONRPC_PARSE_ERROR, "parse error", 400);
      return;
    }
    void answer(res, message, caller, intake, serverVersion, { remoteAddress: req.socket.remoteAddress ?? "?" });
  });
}

async function answer(
  res: ServerResponse,
  message: unknown,
  caller: McpCaller,
  intake: McpIntake,
  serverVersion: string,
  meta: McpRequestMeta,
): Promise<void> {
  // Batches left the protocol in 2025-06-18; one message per POST.
  if (message === null || typeof message !== "object" || Array.isArray(message)) {
    rpcError(res, null, JSONRPC_INVALID_REQUEST, "expected one JSON-RPC message", 400);
    return;
  }
  const m = message as { jsonrpc?: unknown; id?: unknown; method?: unknown; params?: unknown };
  const hasId = typeof m.id === "string" || typeof m.id === "number";
  if (m.jsonrpc !== "2.0") {
    rpcError(res, hasId ? (m.id as RpcId) : null, JSONRPC_INVALID_REQUEST, "jsonrpc must be 2.0", 400);
    return;
  }
  if (typeof m.method !== "string") {
    // A response or a stray object: this server never sends requests, so nothing awaits it.
    res.writeHead(202).end();
    return;
  }
  if (!hasId) {
    // Notifications (notifications/initialized, cancelled, …) need no answer.
    res.writeHead(202).end();
    return;
  }
  const id = m.id as RpcId;
  const params = m.params !== null && typeof m.params === "object" && !Array.isArray(m.params) ? (m.params as Record<string, unknown>) : {};
  const ok = (result: unknown): void => json(res, 200, { jsonrpc: "2.0", id, result });
  switch (m.method) {
    case "initialize": {
      const asked = params.protocolVersion;
      const protocolVersion =
        typeof asked === "string" && (MCP_PROTOCOL_VERSIONS as readonly string[]).includes(asked) ? asked : MCP_PROTOCOL_VERSIONS[0];
      ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "omp-ui", version: serverVersion },
        instructions:
          "omp-ui runs omp coding-agent sessions on this computer and its joined fleet machines. List machines, projects, and sessions; start a session with a prompt; follow it with session_status. Sessions start in read-only Plan mode unless planMode is false.",
      });
      return;
    }
    case "ping":
      ok({});
      return;
    case "tools/list":
      ok({ tools: toolsFor(caller.scope) });
      return;
    case "tools/call": {
      const name = params.name;
      const tool = typeof name === "string" ? MCP_TOOLS.find((t) => t.name === name) : undefined;
      if (tool === undefined) {
        rpcError(res, id, JSONRPC_INVALID_PARAMS, `unknown tool ${typeof name === "string" ? name : ""}`.trim());
        return;
      }
      try {
        const result = await intake.callTool(caller, tool.name, params.arguments, meta);
        ok({ content: [{ type: "text", text: result.text }], isError: result.isError });
      } catch (err) {
        console.warn("[remote] MCP tool call failed:", err instanceof Error ? err.message : String(err));
        rpcError(res, id, JSONRPC_INTERNAL_ERROR, "internal error");
      }
      return;
    }
    default:
      rpcError(res, id, JSONRPC_METHOD_NOT_FOUND, `method not found: ${m.method}`);
  }
}
