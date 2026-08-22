// Pure renderer-safe MCP runtime wire contract. The generated extension owns
// raw omp events and publishes only this reduced, credential-free snapshot.

export const MCP_CONNECTION_STATUS_CHANNEL = "mcp:connection-status";
export const MCP_RUNTIME_STATUS_KEY = "omp-ui:mcp-runtime";
export const MCP_RUNTIME_STATUS_COMMAND = "omp-ui-mcp-runtime";

export type McpRuntimeFailureKind = "auth" | "connection";

export interface McpRuntimeFailure {
  serverName: string;
  kind: McpRuntimeFailureKind;
}

export interface McpRuntimeStatus {
  pendingServers: string[];
  connectedServers: string[];
  failedServers: McpRuntimeFailure[];
}

/** Parses the reduced MCP runtime snapshot; null when any member is malformed. */
export function parseMcpRuntimeStatus(text: string | undefined): McpRuntimeStatus | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  const { pendingServers, connectedServers, failedServers } = record;
  if (!isStringArray(pendingServers) || !isStringArray(connectedServers)) return null;
  if (!Array.isArray(failedServers) || !failedServers.every(isFailure)) return null;
  return {
    pendingServers: [...pendingServers],
    connectedServers: [...connectedServers],
    failedServers: failedServers.map(({ serverName, kind }) => ({ serverName, kind })),
  };
}

/** Hidden slash command used to bind rpc-ui's late-created UI context. */
export function mcpRuntimeStatusMessage(): string {
  return `/${MCP_RUNTIME_STATUS_COMMAND}`;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isFailure(value: unknown): value is McpRuntimeFailure {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return typeof record.serverName === "string" &&
    (record.kind === "auth" || record.kind === "connection");
}
