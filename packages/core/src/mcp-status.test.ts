import { describe, expect, it } from "vitest";
import {
  MCP_RUNTIME_STATUS_COMMAND,
  mcpRuntimeStatusMessage,
  parseMcpRuntimeStatus,
} from "./mcp-status";

describe("parseMcpRuntimeStatus", () => {
  it("parses the complete reduced snapshot", () => {
    expect(parseMcpRuntimeStatus(JSON.stringify({
      pendingServers: ["pending"],
      connectedServers: ["ready"],
      failedServers: [
        { serverName: "oauth", kind: "auth" },
        { serverName: "offline", kind: "connection" },
      ],
    }))).toEqual({
      pendingServers: ["pending"],
      connectedServers: ["ready"],
      failedServers: [
        { serverName: "oauth", kind: "auth" },
        { serverName: "offline", kind: "connection" },
      ],
    });
  });

  it("rejects malformed JSON, containers, arrays, and members", () => {
    const malformed = [
      undefined,
      "",
      "not json",
      "[]",
      "{}",
      JSON.stringify({ pendingServers: [1], connectedServers: [], failedServers: [] }),
      JSON.stringify({ pendingServers: [], connectedServers: [null], failedServers: [] }),
      JSON.stringify({ pendingServers: [], connectedServers: [], failedServers: ["server"] }),
      JSON.stringify({ pendingServers: [], connectedServers: [], failedServers: [{ serverName: 1, kind: "auth" }] }),
      JSON.stringify({ pendingServers: [], connectedServers: [], failedServers: [{ serverName: "x", kind: "timeout" }] }),
    ];
    for (const value of malformed) expect(parseMcpRuntimeStatus(value)).toBeNull();
  });

  it("builds the startup command from the shared constant", () => {
    expect(mcpRuntimeStatusMessage()).toBe(`/${MCP_RUNTIME_STATUS_COMMAND}`);
  });
});
