import { describe, expect, it } from "vitest";
import {
  compileRoutineToolPolicy,
  renderApprovalOverlayYaml,
  type RoutineCatalogSnapshot,
  type RoutineToolPolicy,
} from "./routine";

function sampleCatalog(overrides: Partial<RoutineCatalogSnapshot> = {}): RoutineCatalogSnapshot {
  return {
    tools: [
      { key: "read", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Read files" },
      { key: "bash", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Run shell" },
      { key: "eval", source: "builtin", group: "builtin", groupLabel: "Built-in tools", description: "Run eval" },
      {
        key: "omp-ui_vault_read",
        source: "host-vault",
        group: "vault",
        groupLabel: "Knowledge vault",
        description: "Read vault note",
      },
      {
        key: "mcp__gmail-work_list_messages",
        source: "mcp",
        group: "mcp:gmail-work",
        groupLabel: "gmail-work",
        description: "List messages",
      },
      {
        key: "mcp__gmail-work_send_message",
        source: "mcp",
        group: "mcp:gmail-work",
        groupLabel: "gmail-work",
        description: "Send message",
      },
    ],
    staleServers: [],
    enumerationError: null,
    capturedAt: "2026-11-21T00:00:00.000Z",
    ...overrides,
  };
}

describe("compileRoutineToolPolicy (U6)", () => {
  it("compiles total catalog coverage with allow/prompt/deny, built-in-only deniedBuiltins, and matching YAML", () => {
    const policy: RoutineToolPolicy = {
      allow: ["read", "mcp__gmail-work_list_messages"],
      deny: ["bash", "mcp__gmail-work_send_message"],
      lastReviewedAt: "2026-11-20T00:00:00.000Z",
      reviewedCatalog: ["read", "bash", "eval", "omp-ui_vault_read", "mcp__gmail-work_list_messages", "mcp__gmail-work_send_message"],
    };
    const compiled = compileRoutineToolPolicy(policy, sampleCatalog());

    expect(compiled.approvalMode).toBe("always-ask");
    expect(compiled.overlayEntries).toEqual({
      "bash": "deny",
      "eval": "prompt",
      "mcp__gmail-work_list_messages": "allow",
      "mcp__gmail-work_send_message": "deny",
      "omp-ui_vault_read": "prompt",
      "read": "allow",
    });
    expect(compiled.deniedBuiltins).toEqual(["bash"]);
    expect(compiled.addedLater).toEqual([]);
    expect(compiled.missingFromCatalog).toEqual([]);
    expect(compiled.cliBypassWarning).toBe(false);
    expect(compiled.overlayYamlPreview).toBe(renderApprovalOverlayYaml("always-ask", compiled.overlayEntries));
  });

  it("detects drift (addedLater), missingFromCatalog warnings, stale servers, and CLI-bypass warning", () => {
    const policy: RoutineToolPolicy = {
      allow: ["bash", "mcp__old_server_tool"],
      deny: [],
      lastReviewedAt: "2026-11-20T00:00:00.000Z",
      reviewedCatalog: ["read", "bash"],
    };
    const compiled = compileRoutineToolPolicy(
      policy,
      sampleCatalog({ staleServers: ["gmail-work"] }),
    );

    expect(compiled.addedLater).toEqual([
      "eval",
      "mcp__gmail-work_list_messages",
      "mcp__gmail-work_send_message",
      "omp-ui_vault_read",
    ]);
    expect(compiled.missingFromCatalog).toEqual(["mcp__old_server_tool"]);
    expect(compiled.overlayEntries["mcp__old_server_tool"]).toBe("allow");
    expect(compiled.cliBypassToolsAllowed).toEqual(["bash"]);
    expect(compiled.cliBypassWarning).toBe(true);
    expect(compiled.warnings.some((w) => w.includes("bash"))).toBe(true);
    expect(compiled.warnings.some((w) => w.includes("mcp__old_server_tool"))).toBe(true);
    expect(compiled.warnings.some((w) => w.includes("gmail-work"))).toBe(true);
  });

  it("supports empty allow list cleanly without mutating inputs (Dry run purity)", () => {
    const policy: RoutineToolPolicy = {
      allow: [],
      deny: [],
      lastReviewedAt: "2026-11-20T00:00:00.000Z",
      reviewedCatalog: [],
    };
    const catalog = sampleCatalog();
    const policySnapshot = structuredClone(policy);
    const catalogSnapshot = structuredClone(catalog);

    const compiled = compileRoutineToolPolicy(policy, catalog);
    expect(Object.values(compiled.overlayEntries).every((v) => v === "prompt")).toBe(true);
    expect(policy).toEqual(policySnapshot);
    expect(catalog).toEqual(catalogSnapshot);
  });
});
