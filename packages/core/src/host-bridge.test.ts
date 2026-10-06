import { describe, expect, it } from "vitest";
import {
  HOST_NOTIFY_TOOL_NAME,
  HOST_URI_SCHEME,
  hostToolErrorResult,
  hostToolResult,
  hostToolTextResult,
  hostUriErrorResult,
  hostUriOkResult,
  hostUriReadResult,
  parseHostToolCall,
  parseHostToolCancel,
  parseHostUriCancel,
  parseHostUriRequest,
  parseHostUrl,
  RESERVED_HOST_URI_SCHEMES,
  setHostToolsCommand,
  setHostUriSchemesCommand,
  hostToolsDefinition,
  hostUriSchemeDefinition,
  type RpcHostToolDefinition,
} from "./host-bridge";

describe("host registration definitions", () => {
  it("registers omp-ui as a read-only immutable scheme outside the reserved set", () => {
    expect(HOST_URI_SCHEME).toBe("omp-ui");
    expect(RESERVED_HOST_URI_SCHEMES).not.toContain(HOST_URI_SCHEME);
    const definition = hostUriSchemeDefinition();
    expect(definition.scheme).toMatch(/^[a-z][a-z0-9+.-]*$/);
    expect(definition.writable).toBe(false);
    expect(definition.immutable).toBe(true);
  });

  it("registers one namespaced tool with an object parameter schema", () => {
    const tools = hostToolsDefinition();
    expect(tools).toHaveLength(1);
    const tool = tools[0];
    expect(tool.name).toBe(HOST_NOTIFY_TOOL_NAME);
    // omp rejects the WHOLE set_host_tools command on a name collision; the
    // namespace is what keeps that impossible against built-ins.
    expect(tool.name).toMatch(/^[a-z][a-z0-9._-]*$/);
    expect(tool.parameters.type).toBe("object");
  });

  it("builds registration commands with stable ids and unchanged notify parameters", () => {
    expect(setHostUriSchemesCommand()).toMatchObject({
      id: "omp-ui-host-uri-1",
      type: "set_host_uri_schemes",
      schemes: [{ scheme: "omp-ui", writable: false, immutable: true }],
    });
    expect(setHostUriSchemesCommand("uri-custom")).toMatchObject({ id: "uri-custom" });
    expect(setHostToolsCommand()).toMatchObject({
      id: "omp-ui-host-tools-1",
      type: "set_host_tools",
      tools: [{
        name: "omp-ui_notify",
        parameters: {
          type: "object",
          properties: { message: { type: "string" }, title: { type: "string" } },
          required: ["message"],
        },
      }],
    });
    expect(setHostToolsCommand({ vault: false }, "tools-custom")).toMatchObject({ id: "tools-custom" });
  });

  it("adds exactly seven essential vault tools after notify only when enabled", () => {
    expect(hostToolsDefinition({ vault: false }).map((tool) => tool.name)).toEqual(["omp-ui_notify"]);
    const command = setHostToolsCommand({ vault: true }, "vault-tools") as {
      id: string;
      type: string;
      tools: RpcHostToolDefinition[];
    };
    expect(command.id).toBe("vault-tools");
    expect(command.type).toBe("set_host_tools");
    expect(command.tools.map((tool) => tool.name)).toEqual([
      "omp-ui_notify",
      "omp-ui_vault_search",
      "omp-ui_vault_read",
      "omp-ui_vault_list",
      "omp-ui_vault_create",
      "omp-ui_vault_append",
      "omp-ui_vault_edit",
      "omp-ui_vault_link",
    ]);
    for (const tool of command.tools.slice(1)) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9._-]*$/);
      expect(tool.loadMode).toBe("essential");
      expect(tool.parameters.type).toBe("object");
      expect(tool.parameters.additionalProperties).toBe(false);
      expect(tool.parameters.properties).toMatchObject({ vault: { type: "string" } });
    }
  });

  it("advertises each tool's exact argument types, required fields and defaults", () => {
    const actual = hostToolsDefinition({ vault: true }).slice(1).map((tool) => {
      const properties = tool.parameters.properties as Record<string, Record<string, unknown>>;
      return {
        name: tool.name,
        required: tool.parameters.required,
        properties: Object.fromEntries(Object.entries(properties).map(([name, property]) => {
          const { description: _description, ...schema } = property;
          return [name, schema];
        })),
      };
    });
    expect(actual).toEqual([
      {
        name: "omp-ui_vault_search",
        required: ["query"],
        properties: {
          query: { type: "string" },
          vault: { type: "string" },
          limit: { type: "integer", minimum: 1, maximum: 50, default: 10 },
        },
      },
      {
        name: "omp-ui_vault_read",
        required: ["path"],
        properties: { path: { type: "string" }, vault: { type: "string" } },
      },
      {
        name: "omp-ui_vault_list",
        required: [],
        properties: { folder: { type: "string" }, vault: { type: "string" } },
      },
      {
        name: "omp-ui_vault_create",
        required: ["title", "body"],
        properties: {
          title: { type: "string" },
          body: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
          project: { type: "boolean", default: true },
          vault: { type: "string" },
        },
      },
      {
        name: "omp-ui_vault_append",
        required: ["path", "text"],
        properties: { path: { type: "string" }, text: { type: "string" }, vault: { type: "string" } },
      },
      {
        name: "omp-ui_vault_edit",
        required: ["path", "baseHash", "content"],
        properties: {
          path: { type: "string" },
          baseHash: { type: "string" },
          content: { type: "string" },
          vault: { type: "string" },
        },
      },
      {
        name: "omp-ui_vault_link",
        required: ["path", "to", "baseHash"],
        properties: {
          path: { type: "string" },
          to: { type: "string" },
          baseHash: { type: "string" },
          vault: { type: "string" },
        },
      },
    ]);
  });
});

describe("parseHostUrl", () => {
  it("splits scheme from resource, lowercase only", () => {
    expect(parseHostUrl("omp-ui://plan")).toEqual({ scheme: "omp-ui", resource: "plan" });
    expect(parseHostUrl("local://x/y.md")).toEqual({ scheme: "local", resource: "x/y.md" });
    expect(parseHostUrl("omp-ui://")).toEqual({ scheme: "omp-ui", resource: "" });
    expect(parseHostUrl("OMP-UI://plan")).toBeNull();
    expect(parseHostUrl("1omp://plan")).toBeNull();
    expect(parseHostUrl("plan")).toBeNull();
  });
});

describe("inbound frame parsers", () => {
  it("parses a well-formed host_tool_call", () => {
    expect(
      parseHostToolCall({
        type: "host_tool_call",
        id: "h1",
        toolCallId: "c1",
        toolName: "omp-ui_notify",
        arguments: { message: "hi" },
      }),
    ).toEqual({ id: "h1", toolCallId: "c1", toolName: "omp-ui_notify", args: { message: "hi" } });
  });

  it("tolerates missing optional fields instead of dropping the call", () => {
    expect(parseHostToolCall({ type: "host_tool_call", id: "h1", toolName: "t" })).toEqual({
      id: "h1",
      toolCallId: null,
      toolName: "t",
      args: undefined,
    });
  });

  it("rejects non-frames, wrong types, and non-string ids", () => {
    expect(parseHostToolCall(null)).toBeNull();
    expect(parseHostToolCall("x")).toBeNull();
    expect(parseHostToolCall({ type: "host_uri_request", id: "h1", operation: "read", url: "omp-ui://plan" })).toBeNull();
    expect(parseHostToolCall({ type: "host_tool_call", id: 7 })).toBeNull();
  });

  it("reads the cancel target id", () => {
    expect(parseHostToolCancel({ type: "host_tool_cancel", id: "c", targetId: "h1" })).toBe("h1");
    expect(parseHostToolCancel({ type: "host_uri_cancel", id: "c", targetId: "h1" })).toBeNull();
    expect(parseHostUriCancel({ type: "host_uri_cancel", id: "c", targetId: "h1" })).toBe("h1");
    expect(parseHostToolCancel({ type: "host_tool_cancel", id: "c" })).toBeNull();
    expect(parseHostUriCancel({ type: "host_uri_cancel", id: 3, targetId: "h1" })).toBeNull();
  });

  it("parses host_uri_request and pins operation to read|write", () => {
    expect(
      parseHostUriRequest({ type: "host_uri_request", id: "h1", operation: "read", url: "omp-ui://plan" }),
    ).toEqual({ id: "h1", operation: "read", url: "omp-ui://plan", content: undefined });
    expect(
      parseHostUriRequest({ type: "host_uri_request", id: "h1", operation: "write", url: "omp-ui://plan", content: "x" }),
    ).toEqual({ id: "h1", operation: "write", url: "omp-ui://plan", content: "x" });
    expect(parseHostUriRequest({ type: "host_uri_request", id: "h1", operation: "delete", url: "omp-ui://plan" })).toBeNull();
    expect(parseHostUriRequest({ type: "host_uri_request", id: "h1", operation: "read" })).toBeNull();
  });
});

describe("result builders", () => {
  it("every tool result carries result.content — omp drops a success frame without it", () => {
    for (const built of [
      hostToolTextResult("h1", "ok"),
      hostToolErrorResult("h1", "bad"),
      hostToolResult("h1", [{ type: "text", text: "note" }], { path: "Note.md" }),
      hostToolResult("h1", [], {}, true),
    ]) {
      const frame = built as Record<string, unknown>;
      expect(frame.type).toBe("host_tool_result");
      expect(frame.id).toBe("h1");
      expect(Array.isArray((frame.result as { content: unknown }).content)).toBe(true);
    }
    expect(hostToolErrorResult("h1", "bad")).toMatchObject({ isError: true });
  });

  it("carries vault details and text/image content without an error flag on success", () => {
    expect(hostToolResult("read-image", [
      { type: "text", text: "Vault Notes · Picture.png" },
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
    ], { vaultName: "Notes", path: "Picture.png", createdByOmpUi: null })).toEqual({
      type: "host_tool_result",
      id: "read-image",
      result: {
        content: [
          { type: "text", text: "Vault Notes · Picture.png" },
          { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
        ],
        details: { vaultName: "Notes", path: "Picture.png", createdByOmpUi: null },
      },
    });
  });

  it("marks refused vault calls as errors while preserving details and content", () => {
    expect(hostToolResult("edit", [{ type: "text", text: "read it again" }], {
      action: "edit", path: "Note.md",
    }, true)).toEqual({
      type: "host_tool_result",
      id: "edit",
      isError: true,
      result: {
        content: [{ type: "text", text: "read it again" }],
        details: { action: "edit", path: "Note.md" },
      },
    });
  });

  it("uri results carry content+contentType or the error text", () => {
    expect(hostUriReadResult("h1", "# plan", "text/markdown")).toEqual({
      type: "host_uri_result",
      id: "h1",
      content: "# plan",
      contentType: "text/markdown",
    });
    expect(hostUriOkResult("h1")).toEqual({ type: "host_uri_result", id: "h1" });
    expect(hostUriErrorResult("h1", "nope")).toEqual({
      type: "host_uri_result",
      id: "h1",
      isError: true,
      error: "nope",
    });
  });
});
