import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import {
  MCP_CONNECTION_STATUS_CHANNEL,
  MCP_RUNTIME_STATUS_COMMAND,
  MCP_RUNTIME_STATUS_KEY,
  type McpRuntimeStatus,
} from "./mcp-status";
import { mcpStatusExtensionPath, writeMcpStatusExtension } from "./mcp-status-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mcp-status-"));
  dirs.push(dir);
  return dir;
}

function executableExtension(withEventBus = true) {
  const source = fs.readFileSync(writeMcpStatusExtension(tempLineage()), "utf8");
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", output)(loaded, loaded.exports);
  if (!loaded.exports.default) throw new Error("generated extension has no default factory");

  let receive: ((event: unknown) => void) | undefined;
  let command: ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>) | undefined;
  const published: McpRuntimeStatus[] = [];
  const api = {
    ...(withEventBus ? {
      events: {
        on: (channel: string, handler: (event: unknown) => void): void => {
          expect(channel).toBe(MCP_CONNECTION_STATUS_CHANNEL);
          receive = handler;
        },
      },
    } : {}),
    registerCommand: (name: string, options: { handler: typeof command }): void => {
      expect(name).toBe(MCP_RUNTIME_STATUS_COMMAND);
      command = options.handler;
    },
  };
  loaded.exports.default(api);

  return {
    emit: (event: unknown): void => {
      if (!receive) throw new Error("generated extension did not subscribe");
      receive(event);
    },
    arm: async (): Promise<void> => {
      if (!command) throw new Error("generated extension did not register its command");
      await command("", {
        ui: {
          setStatus: (key, text): void => {
            expect(key).toBe(MCP_RUNTIME_STATUS_KEY);
            if (text) published.push(JSON.parse(text) as McpRuntimeStatus);
          },
        },
      });
    },
    published,
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeMcpStatusExtension", () => {
  it("creates and replaces the per-lineage extension", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeMcpStatusExtension(lineage);
    expect(file).toBe(mcpStatusExtensionPath(lineage));
    fs.writeFileSync(file, "// stale\n", "utf8");
    writeMcpStatusExtension(lineage);
    const source = fs.readFileSync(file, "utf8");
    expect(source).toContain(JSON.stringify(MCP_RUNTIME_STATUS_KEY));
    expect(source).toContain(JSON.stringify(MCP_RUNTIME_STATUS_COMMAND));
  });

  it("writes TypeScript omp can transpile", () => {
    const source = fs.readFileSync(writeMcpStatusExtension(tempLineage()), "utf8");
    const { diagnostics } = ts.transpileModule(source, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
      reportDiagnostics: true,
    });
    expect((diagnostics ?? []).filter((d) => d.category === ts.DiagnosticCategory.Error)).toEqual([]);
  });
});

describe("generated MCP status extension", () => {
  it("buffers pre-command events and publishes the latest snapshot when armed", async () => {
    const harness = executableExtension();
    harness.emit({ type: "connecting", serverNames: ["first", "second"] });
    harness.emit({ type: "connected", serverName: "first" });
    expect(harness.published).toEqual([]);
    await harness.arm();
    expect(harness.published).toEqual([{
      pendingServers: ["second"],
      connectedServers: ["first"],
      failedServers: [],
    }]);
  });

  it("publishes transitions and reset semantics in event order", async () => {
    const harness = executableExtension();
    await harness.arm();
    harness.published.splice(0);
    harness.emit({ type: "connecting", serverNames: ["a", "b"] });
    harness.emit({ type: "failed", serverName: "a", error: "socket closed" });
    harness.emit({ type: "connected", serverName: "b" });
    harness.emit({ type: "connecting", serverNames: ["new"] });
    expect(harness.published.at(-1)).toEqual({
      pendingServers: ["new"],
      connectedServers: [],
      failedServers: [],
    });
  });

  it.each(["401", "403", "OAuth expired", "unauthorized", "forbidden", "authentication failed", "authorization failed", "credential missing", "token expired"])(
    "classifies %s as authentication without publishing the raw error",
    async (error) => {
      const harness = executableExtension();
      await harness.arm();
      harness.emit({ type: "failed", serverName: "remote", error, sourcePath: "/secret/mcp.json" });
      const json = JSON.stringify(harness.published.at(-1));
      expect(harness.published.at(-1)?.failedServers).toEqual([{ serverName: "remote", kind: "auth" }]);
      expect(json).not.toContain(error);
      expect(json).not.toContain("/secret/mcp.json");
    },
  );

  it("classifies unrelated failures as connection failures", async () => {
    const harness = executableExtension();
    await harness.arm();
    harness.emit({ type: "failed", serverName: "stdio", error: "spawn ENOENT" });
    expect(harness.published.at(-1)?.failedServers).toEqual([{ serverName: "stdio", kind: "connection" }]);
  });

  it("ignores malformed events and sanitizes the only crossing text", async () => {
    const harness = executableExtension();
    await harness.arm();
    harness.published.splice(0);
    harness.emit({ type: "connecting", serverNames: ["safe", 4] });
    harness.emit({ type: "failed", serverName: "bad", error: 401 });
    expect(harness.published).toEqual([]);
    const rawName = `oauth\nserver${"x".repeat(200)}`;
    harness.emit({ type: "failed", serverName: rawName, error: "401 secret=abc" });
    const name = harness.published.at(-1)?.failedServers[0]?.serverName;
    expect(name).toHaveLength(160);
    expect(name).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(JSON.stringify(harness.published.at(-1))).not.toContain("secret=abc");
  });

  it("publishes an empty snapshot when the omp event bus is absent", async () => {
    const harness = executableExtension(false);
    await harness.arm();
    expect(harness.published).toEqual([{
      pendingServers: [],
      connectedServers: [],
      failedServers: [],
    }]);
  });
});
