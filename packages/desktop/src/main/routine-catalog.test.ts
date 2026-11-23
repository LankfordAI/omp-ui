import { describe, expect, it, vi } from "vitest";
import type { CapabilitySnapshot, CapabilityTool, McpServersResult } from "@omp-ui/core";
import {
  ROUTINE_CATALOG_CACHE_TTL_MS,
  ROUTINE_CATALOG_PROBE_TIMEOUT_MS,
  RoutineCatalogService,
  inferMcpServerFromKey,
} from "./routine-catalog";

function capTool(overrides: Partial<CapabilityTool> & { name: string }): CapabilityTool {
  return {
    description: `${overrides.name} desc`,
    descriptionTruncated: false,
    source: "builtin",
    sourcePath: null,
    enabled: true,
    direct: true,
    mounted: false,
    evalBridge: false,
    mcpServerName: null,
    mcpToolName: null,
    ...overrides,
  };
}

function capSnapshot(items: CapabilityTool[]): CapabilitySnapshot {
  return {
    version: 1,
    processKey: "proc-1",
    sessionId: "sess-1",
    revision: 1,
    updatedAt: 1000,
    ompVersion: "19.0.1",
    skillCommandsEnabled: true,
    skills: { status: "available", items: [] },
    tools: { status: "available", items },
    magicKeywords: { status: "available", items: [] },
    toolControl: "available",
    toolMutation: null,
  };
}

function mcpServers(names: Array<{ name: string; enabled?: boolean; endpoint?: string }>): McpServersResult {
  return {
    servers: names.map((s) => ({
      name: s.name,
      transport: "stdio" as const,
      endpoint: s.endpoint ?? `cmd:${s.name}`,
      source: "native" as const,
      scope: "project" as const,
      sourcePath: "/proj/.omp/mcp.json",
      effective: true,
      state: s.enabled === false ? ("disabled" as const) : ("enabled" as const),
      writable: true,
    })),
    errors: [],
  };
}

describe("RoutineCatalogService", () => {
  it("combines static built-ins, active vault tools, and live session CapabilitySnapshot without spawning probe", async () => {
    const runProbe = vi.fn();
    const liveSnap = capSnapshot([
      capTool({ name: "read", source: "builtin", description: "Live read desc" }),
      capTool({
        name: "mcp__gmail-work_list_messages",
        source: "mcp",
        mcpServerName: "gmail-work",
        mcpToolName: "list_messages",
        description: "List Gmail messages",
      }),
      // Excluded outside-sender host tools must not enter the routine catalog
      capTool({ name: "omp-ui_fleet_dispatch", source: "extension" }),
      capTool({ name: "omp-ui_theme_save", source: "extension" }),
    ]);

    const svc = new RoutineCatalogService({
      hasVaults: () => true,
      liveCapabilities: () => liveSnap,
      resolveMcp: async () => mcpServers([{ name: "gmail-work" }]),
      runProbe,
    });

    const cat = await svc.list("/proj");
    expect(runProbe).not.toHaveBeenCalled();
    expect(cat.enumerationError).toBeNull();
    expect(cat.staleServers).toEqual([]);
    expect(cat.tools.find((t) => t.key === "read")?.description).toBe("Live read desc");
    expect(cat.tools.some((t) => t.key === "bash" && t.source === "builtin")).toBe(true);
    expect(cat.tools.some((t) => t.key === "omp-ui_vault_create" && t.source === "host-vault")).toBe(true);
    expect(cat.tools.find((t) => t.key === "mcp__gmail-work_list_messages")).toEqual({
      key: "mcp__gmail-work_list_messages",
      source: "mcp",
      group: "mcp:gmail-work",
      groupLabel: "gmail-work",
      description: "List Gmail messages",
    });
    expect(cat.tools.some((t) => t.key === "omp-ui_fleet_dispatch")).toBe(false);
    expect(cat.tools.some((t) => t.key === "omp-ui_theme_save")).toBe(false);
  });

  it("omits omp-ui_vault_* tools when no vault is registered", async () => {
    const svc = new RoutineCatalogService({
      hasVaults: () => false,
      liveCapabilities: () => capSnapshot([]),
      resolveMcp: async () => mcpServers([]),
      runProbe: vi.fn(),
    });
    const cat = await svc.list("/proj");
    expect(cat.tools.some((t) => t.source === "host-vault")).toBe(false);
  });

  it("caches one-shot probe by (projectCwd, mcpConfigFingerprint) for 60 s and invalidates on fingerprint or TTL change", async () => {
    let now = 1_000_000;
    let endpoint = "cmd:jira-v1";
    const runProbe = vi.fn(async (cwd: string, timeoutMs: number, expected: readonly string[]) => {
      expect(cwd).toBe("/proj");
      expect(timeoutMs).toBe(ROUTINE_CATALOG_PROBE_TIMEOUT_MS);
      // omp mounts MCP tools after its first snapshot: the probe must know which servers to wait for.
      expect(expected).toEqual(["jira"]);
      return capSnapshot([
        capTool({
          name: "mcp__jira_search",
          source: "mcp",
          mcpServerName: "jira",
          mcpToolName: "search",
        }),
      ]);
    });

    const svc = new RoutineCatalogService({
      hasVaults: () => false,
      liveCapabilities: () => null,
      resolveMcp: async () => mcpServers([{ name: "jira", endpoint }]),
      runProbe,
      now: () => now,
    });

    const first = await svc.list("/proj");
    expect(runProbe).toHaveBeenCalledTimes(1);
    expect(first.tools.some((t) => t.key === "mcp__jira_search")).toBe(true);

    // Within 60 s TTL -> cache hit
    now += ROUTINE_CATALOG_CACHE_TTL_MS - 1;
    await svc.list("/proj");
    expect(runProbe).toHaveBeenCalledTimes(1);

    // MCP config fingerprint changes -> cache miss even inside TTL
    endpoint = "cmd:jira-v2";
    await svc.list("/proj");
    expect(runProbe).toHaveBeenCalledTimes(2);

    // Past 60 s TTL -> re-probe
    now += ROUTINE_CATALOG_CACHE_TTL_MS + 1;
    await svc.list("/proj");
    expect(runProbe).toHaveBeenCalledTimes(3);
  });

  it("falls back to last-known cached tools and routine reviewedCatalog with stale-server warnings when probe fails", async () => {
    let now = 1_000_000;
    let fail = false;
    const runProbe = vi.fn(async () => {
      if (fail) throw new Error("probe timed out");
      return capSnapshot([
        capTool({
          name: "mcp__jira_search",
          source: "mcp",
          mcpServerName: "jira",
          mcpToolName: "search",
        }),
      ]);
    });

    const svc = new RoutineCatalogService({
      hasVaults: () => false,
      liveCapabilities: () => null,
      resolveMcp: async () => mcpServers([{ name: "jira" }, { name: "gmail" }]),
      runProbe,
      now: () => now,
    });

    // First probe succeeds for jira, but gmail is configured and offline -> staleServers includes gmail
    const first = await svc.list("/proj", {
      fallbackReviewedKeys: ["mcp__gmail_list_messages"],
    });
    expect(first.staleServers).toEqual(["gmail"]);
    expect(first.tools.some((t) => t.key === "mcp__jira_search")).toBe(true);
    expect(first.tools.some((t) => t.key === "mcp__gmail_list_messages")).toBe(true);

    // Expire TTL and fail probe -> falls back to last-known jira + reviewedCatalog gmail with enumerationError
    now += ROUTINE_CATALOG_CACHE_TTL_MS + 5_000;
    fail = true;
    const second = await svc.list("/proj", {
      fallbackReviewedKeys: ["mcp__gmail_list_messages"],
    });
    expect(second.enumerationError).toContain("probe timed out");
    expect(second.staleServers).toEqual(["gmail", "jira"]);
    expect(second.tools.some((t) => t.key === "mcp__jira_search")).toBe(true);
    expect(second.tools.some((t) => t.key === "mcp__gmail_list_messages")).toBe(true);
    expect(second.tools.some((t) => t.key === "read" && t.source === "builtin")).toBe(true);
  });

  it("infers MCP server names from flat mcp__ keys cleanly", () => {
    expect(inferMcpServerFromKey("mcp__gmail-work_send_message")).toBe("gmail-work");
    expect(inferMcpServerFromKey("mcp__jira_search")).toBe("jira");
  });
});
