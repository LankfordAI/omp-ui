import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES_COMMAND,
  CAPABILITIES_STATUS_KEY,
  parseCapabilitySnapshot,
  type CapabilitySnapshot,
} from "./capabilities";
import { capabilitiesExtensionPath, writeCapabilitiesExtension } from "./capabilities-extension";

const dirs: string[] = [];

function tempLineage(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-capabilities-"));
  dirs.push(dir);
  return dir;
}

function transpile(source: string, module: ts.ModuleKind): ts.TranspileOutput {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module },
    reportDiagnostics: true,
  });
}

function errorText(result: ts.TranspileOutput): string[] {
  return (result.diagnostics ?? [])
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => ts.flattenDiagnosticMessageText(d.messageText, " "));
}

function executableExtension() {
  class FakeAgentSession {
    id: string;
    version = "18.1.10";
    promptCalls = 0;
    promptValue: unknown = undefined;
    promptError: unknown = null;
    disposeCalls = 0;
    sessionManager: { getSessionId?: () => unknown } | undefined;
    skills: unknown[] | undefined = [];
    skillsSettings: { enableSkillCommands?: unknown } | undefined = { enableSkillCommands: true };
    toolInfos: Record<string, unknown>[] = [
      { name: "alpha", description: "base tool", source: "builtin", sourcePath: "/pkg/alpha.ts" },
    ];
    toolByName = new Map<string, unknown>();
    enabledNames: string[] = [];
    activeNames: string[] = [];
    xdevNames: string[] = [];
    evalBridgeNames: string[] = [];

    constructor(id: string) {
      this.id = id;
      this.sessionManager = { getSessionId: (): string => this.id };
    }

    getAllToolInfos(): Record<string, unknown>[] {
      return this.toolInfos;
    }

    getEnabledToolNames(): string[] {
      return this.enabledNames;
    }

    getActiveToolNames(): string[] {
      return this.activeNames;
    }

    getMountedXdevToolNames(): string[] {
      return this.xdevNames;
    }

    getEvalBridgeToolNames(): string[] {
      return this.evalBridgeNames;
    }

    getToolByName(name: string): unknown {
      return this.toolByName.get(name) ?? null;
    }

    dispose(): void {
      this.disposeCalls += 1;
    }

    prompt(): unknown {
      this.promptCalls += 1;
      if (this.promptError !== null) throw this.promptError;
      return this.promptValue !== undefined ? this.promptValue : Promise.resolve();
    }
  }

  const source = fs.readFileSync(writeCapabilitiesExtension(tempLineage()), "utf8");
  const output = transpile(source, ts.ModuleKind.CommonJS).outputText;
  const loaded = { exports: {} as { default?: (api: unknown) => void } };
  Function("module", "exports", output)(loaded, loaded.exports);
  const factory = loaded.exports.default;
  if (!factory) throw new Error("generated extension has no default factory");

  let handler:
    | ((args: string, ctx: { ui: { setStatus: (key: string, text: string | undefined) => void } }) => Promise<void>)
    | undefined;
  const published: CapabilitySnapshot[] = [];
  factory({
    pi: { AgentSession: FakeAgentSession },
    registerCommand: (name: string, options: { handler: typeof handler }): void => {
      expect(name).toBe(CAPABILITIES_COMMAND);
      handler = options.handler;
    },
  });

  return {
    FakeAgentSession,
    published,
    arm: async (): Promise<void> => {
      if (!handler) throw new Error("generated extension did not register its command");
      await handler("", {
        ui: {
          setStatus: (key, text): void => {
            expect(key).toBe(CAPABILITIES_STATUS_KEY);
            const snapshot = parseCapabilitySnapshot(text);
            if (!snapshot) throw new Error("published a snapshot the shared wire parser rejects");
            published.push(snapshot);
          },
        },
      });
    },
    latest: (): CapabilitySnapshot => {
      const value = published.at(-1);
      if (!value) throw new Error("generated extension published no snapshot");
      return value;
    },
  };
}

function publishedTools(snapshot: CapabilitySnapshot) {
  return snapshot.tools.status === "available" ? snapshot.tools.items : [];
}

function publishedSkills(snapshot: CapabilitySnapshot) {
  return snapshot.skills.status === "available" ? snapshot.skills.items : [];
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("writeCapabilitiesExtension", () => {
  it("writes the extension into the lineage dir, creating it when absent", () => {
    const lineage = path.join(tempLineage(), "nested");
    const file = writeCapabilitiesExtension(lineage);
    expect(file).toBe(capabilitiesExtensionPath(lineage));
    expect(fs.existsSync(file)).toBe(true);
  });

  it("is rewritten on every spawn, so a stale build cannot outvote the contract", () => {
    const lineage = tempLineage();
    const file = writeCapabilitiesExtension(lineage);
    fs.writeFileSync(file, "// stale from an older omp-ui\n", "utf8");
    writeCapabilitiesExtension(lineage);
    const output = transpile(fs.readFileSync(file, "utf8"), ts.ModuleKind.CommonJS).outputText;
    const loaded = { exports: {} as { default?: unknown } };
    Function("module", "exports", output)(loaded, loaded.exports);
    expect(typeof loaded.exports.default).toBe("function");
  });

  it("writes a syntactically valid TS extension omp can transpile", () => {
    const source = fs.readFileSync(writeCapabilitiesExtension(tempLineage()), "utf8");
    // Substring checks can't catch a broken template; the file omp loads must
    // actually be valid TypeScript, or every session would reject the -e arg.
    expect(errorText(transpile(source, ts.ModuleKind.ESNext))).toEqual([]);
  });
});

describe("generated capabilities extension", () => {
  it("publishes both sections missing-api when no session has ever prompted", async () => {
    const harness = executableExtension();
    await harness.arm();
    const snapshot = harness.latest();
    expect(snapshot.sessionId).toBeNull();
    expect(snapshot.skillCommandsEnabled).toBeNull();
    expect(snapshot.skills).toEqual({ status: "unavailable", reason: "missing-api" });
    expect(snapshot.tools).toEqual({ status: "unavailable", reason: "missing-api" });
  });

  it("lists hidden skills and keeps identifiers verbatim while sanitizing descriptions", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    root.skills = [
      {
        name: "deep\u0001skill",
        description: "uses\u0000control chars",
        filePath: "/skills/deep/SKILL.md",
        source: "curated",
        _source: { level: "user" },
        hide: true,
      },
      { name: "temp", description: "t", filePath: "/tmp/SKILL.md", _source: { level: "temporary" } },
    ];
    await root.prompt();
    await harness.arm();
    const snapshot = harness.latest();
    expect(publishedSkills(snapshot)).toEqual([
      {
        name: "deep\u0001skill",
        description: "uses control chars",
        descriptionTruncated: false,
        filePath: "/skills/deep/SKILL.md",
        source: "curated",
        scope: "user",
        hidden: true,
      },
      {
        name: "temp",
        description: "t",
        descriptionTruncated: false,
        filePath: "/tmp/SKILL.md",
        source: null,
        scope: null,
        hidden: null,
      },
    ]);
    expect(snapshot.sessionId).toBe("root-a");
    expect(snapshot.ompVersion).toBe("18.1.10");
    expect(snapshot.skillCommandsEnabled).toBe(true);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.processKey.length).toBeGreaterThan(0);
  });

  it("reports exact access booleans and only probe-backed MCP ownership", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    root.toolInfos = [
      { name: "beta", description: "indirect", source: "extension", sourcePath: "/pkgs/beta.ts" },
      { name: "mcp__ghost__x", description: "name looks mcp", source: "unknown", sourcePath: null },
      { name: "drive.upload", description: "real mcp", source: "mcp", sourcePath: "/synth", scope: "temporary" },
      { name: "odd", description: "o", source: "plugin", sourcePath: "/p/odd.js" },
    ];
    root.toolByName.set("drive.upload", { name: "drive.upload", mcpServerName: "drive", mcpToolName: "upload" });
    root.enabledNames = ["beta", "drive.upload"];
    root.activeNames = ["drive.upload"];
    root.evalBridgeNames = ["beta"];
    await root.prompt();
    await harness.arm();
    const byName = new Map(publishedTools(harness.latest()).map((t) => [t.name, t]));
    expect(byName.get("beta")).toMatchObject({ enabled: true, direct: false, xdev: false, evalBridge: true });
    expect(byName.get("mcp__ghost__x")).toMatchObject({ source: "unknown", mcpServerName: null, mcpToolName: null });
    expect(byName.get("drive.upload")).toMatchObject({
      source: "mcp",
      sourcePath: null,
      mcpServerName: "drive",
      mcpToolName: "upload",
    });
    expect(byName.get("odd")).toMatchObject({ source: "unknown", sourcePath: "/p/odd.js" });
  });

  it("maps origin from sourceInfo scalars and treats synthesis markers as no path", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    root.toolInfos = [
      { name: "sourced", description: "real omp row", parameters: {}, sourceInfo: { kind: "Builtin" } },
      { name: "bare", description: "no sourceInfo at all", parameters: {} },
      {
        name: "ephemeral",
        description: "synthesized path",
        parameters: {},
        sourcePath: "/runtime/synth.ts",
        sourceInfo: { kind: "extension", scope: "temporary-runtime" },
      },
    ];
    await root.prompt();
    await harness.arm();
    const byName = new Map(publishedTools(harness.latest()).map((t) => [t.name, t]));
    expect(byName.get("sourced")).toMatchObject({ source: "builtin" });
    expect(byName.get("bare")).toMatchObject({ source: "unknown", sourcePath: null });
    expect(byName.get("ephemeral")).toMatchObject({ source: "extension", sourcePath: null });
  });

  it("yields null access fields per missing or throwing method without touching the others", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    root.enabledNames = ["alpha"];
    root.activeNames = ["alpha"];
    Object.assign(root, { getEnabledToolNames: undefined });
    Object.assign(root, {
      getMountedXdevToolNames: (): never => {
        throw new Error("disposed");
      },
    });
    await root.prompt();
    await harness.arm();
    expect(publishedTools(harness.latest())[0]).toMatchObject({
      enabled: null,
      direct: true,
      xdev: null,
      evalBridge: false,
    });
  });

  it("replaces metadata under an unchanged name and stops publishing once settled", async () => {
    vi.useFakeTimers();
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    root.skills = [{ name: "s", description: "d", filePath: "/s/SKILL.md", hide: true }];
    await root.prompt();
    await harness.arm();
    expect(harness.published).toHaveLength(1);

    root.toolInfos[0].description = "edited in place";
    (root.skills[0] as { hide?: boolean }).hide = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.published).toHaveLength(2);
    const snapshot = harness.latest();
    expect(snapshot.revision).toBe(2);
    expect(snapshot.processKey).toBe(harness.published[0].processKey);
    expect(publishedTools(snapshot)[0].description).toBe("edited in place");
    expect(publishedSkills(snapshot)[0].hidden).toBe(false);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(harness.published).toHaveLength(2);
  });

  it("never lets a descendant prompt call replace the captured root", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    const child = new harness.FakeAgentSession("child");
    child.toolInfos = [{ name: "child-tool", description: "c", source: "sdk", sourcePath: null }];

    await root.prompt();
    await harness.arm();
    await child.prompt();
    expect(harness.published).toHaveLength(1);

    await root.prompt();
    expect(publishedTools(harness.latest()).map((t) => t.name)).toEqual(["alpha"]);
    expect(harness.published.every((frame) => publishedTools(frame).every((t) => t.name !== "child-tool"))).toBe(true);
  });

  it("passes the prompt result through, including thrown and rejected originals", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    await root.prompt();
    await harness.arm();

    root.promptValue = "sentinel";
    expect(root.prompt()).toBe("sentinel");
    root.promptValue = undefined;

    const boom = new Error("boom");
    root.promptError = boom;
    let caught: unknown;
    try {
      root.prompt();
    } catch (error) {
      caught = error;
    }
    expect(caught).toBe(boom);
    root.promptError = null;

    const later = new Error("later");
    root.promptValue = Promise.reject(later);
    const pending = root.prompt();
    root.promptValue = undefined;
    await expect(pending).rejects.toBe(later);
    expect(root.promptCalls).toBe(4);
  });

  it("replaces the whole inventory when the root session id changes like /new", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    await root.prompt();
    await harness.arm();

    root.id = "root-b";
    root.toolInfos = [{ name: "fresh", description: "n", source: "builtin", sourcePath: null }];
    await root.prompt();
    const snapshot = harness.latest();
    expect(snapshot.sessionId).toBe("root-b");
    expect(publishedTools(snapshot).map((t) => t.name)).toEqual(["fresh"]);
    expect(snapshot.revision).toBe(2);
  });

  it("drops both rosters to payload-too-large instead of publishing a partial inventory", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    root.toolInfos = Array.from({ length: 200 }, (_unused, index) => ({
      name: "tool-" + index,
      description: "x".repeat(2_000),
      source: "builtin",
      sourcePath: "/pkg/tool.ts",
    }));
    await root.prompt();
    await harness.arm();
    const snapshot = harness.latest();
    expect(snapshot.version).toBe(1);
    expect(snapshot.skills).toEqual({ status: "unavailable", reason: "payload-too-large" });
    expect(snapshot.tools).toEqual({ status: "unavailable", reason: "payload-too-large" });
  });

  it("stops polling only when the root session shuts down", async () => {
    vi.useFakeTimers();
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    await root.prompt();
    await harness.arm();
    const child = new harness.FakeAgentSession("child");
    await child.prompt();
    child.dispose();

    root.toolInfos[0].description = "landed after a child shutdown";
    await vi.advanceTimersByTimeAsync(2_000);
    expect(harness.published).toHaveLength(2);

    root.dispose();
    root.toolInfos[0].description = "landed after the root shutdown";
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.published).toHaveLength(2);
    expect(root.disposeCalls).toBe(1);
  });
});
