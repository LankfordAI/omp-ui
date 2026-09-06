import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import ts from "typescript";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CAPABILITIES_COMMAND,
  CAPABILITIES_STATUS_KEY,
  CAPABILITIES_TOOL_ARG_PREFIX,
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

/** The fake root's full surface: read probes plus the tool-control methods. */
interface FakeSession {
  id: string;
  version: string;
  promptCalls: number;
  promptValue: unknown;
  promptError: unknown;
  disposeCalls: number;
  sessionManager: { getSessionId?: () => unknown } | undefined;
  skills: unknown[] | undefined;
  skillsSettings: { enableSkillCommands?: unknown } | undefined;
  toolInfos: Record<string, unknown>[];
  toolByName: Map<string, unknown>;
  enabledNames: string[];
  activeNames: string[];
  xdevNames: string[];
  evalBridgeNames: string[];
  setterCalls: { enabled: string[]; mounted: string[]; force: unknown }[];
  setterError: unknown;
  setterApplies: boolean;
  setterGate: Promise<void> | null;
  queueRuns: number;
  planMode: { enabled?: boolean } | undefined;
  getAllToolInfos(): Record<string, unknown>[];
  getEnabledToolNames(): string[];
  getActiveToolNames(): string[];
  getMountedXdevToolNames(): string[];
  getEvalBridgeToolNames(): string[];
  getPlanModeState(): { enabled?: boolean } | undefined;
  runToolRegistryMutation(work: () => Promise<unknown>): Promise<unknown>;
  setActiveToolPresentation(enabled: string[], mounted: string[], force?: boolean): Promise<void>;
  getToolByName(name: string): unknown;
  dispose(): void;
  prompt(...args: unknown[]): unknown;
}

interface CapabilitiesHarness {
  FakeAgentSession: new (id: string) => FakeSession;
  published: CapabilitySnapshot[];
  invoke: (args: string) => Promise<void>;
  arm: () => Promise<void>;
  latest: () => CapabilitySnapshot;
}

function executableExtension(): CapabilitiesHarness {
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
    setterCalls: { enabled: string[]; mounted: string[]; force: unknown }[] = [];
    setterError: unknown = null;
    setterApplies = true;
    setterGate: Promise<void> | null = null;
    queueRuns = 0;
    planMode: { enabled?: boolean } | undefined = undefined;

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

    getPlanModeState(): { enabled?: boolean } | undefined {
      return this.planMode;
    }

    runToolRegistryMutation(work: () => Promise<unknown>): Promise<unknown> {
      this.queueRuns += 1;
      return work();
    }

    async setActiveToolPresentation(
      enabled: string[],
      mounted: string[],
      force?: boolean,
    ): Promise<void> {
      this.setterCalls.push({ enabled: [...enabled], mounted: [...mounted], force });
      if (this.setterError !== null) throw this.setterError;
      if (this.setterGate !== null) await this.setterGate;
      if (this.setterApplies) {
        this.enabledNames = [...enabled];
        this.xdevNames = [...mounted];
      }
    }

    getToolByName(name: string): unknown {
      return this.toolByName.get(name) ?? null;
    }

    dispose(): void {
      this.disposeCalls += 1;
    }

    prompt(...args: unknown[]): unknown {
      void args;
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

  const invoke = async (args: string): Promise<void> => {
    if (!handler) throw new Error("generated extension did not register its command");
    await handler(args, {
      ui: {
        setStatus: (key, text): void => {
          expect(key).toBe(CAPABILITIES_STATUS_KEY);
          const snapshot = parseCapabilitySnapshot(text);
          if (!snapshot) throw new Error("published a snapshot the shared wire parser rejects");
          published.push(snapshot);
        },
      },
    });
  };

  return {
    FakeAgentSession,
    published,
    invoke,
    arm: (): Promise<void> => invoke(""),
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

/** Binds a two-tool root (alpha enabled, beta inactive) and arms the bridge. */
async function armRoot(harness: CapabilitiesHarness, id = "root-a"): Promise<FakeSession> {
  const root = new harness.FakeAgentSession(id);
  root.toolInfos = [
    { name: "alpha", description: "alpha", source: "builtin", sourcePath: "/pkg/alpha.ts" },
    { name: "beta", description: "beta", source: "builtin", sourcePath: "/pkg/beta.ts" },
  ];
  root.enabledNames = ["alpha"];
  await root.prompt();
  await harness.arm();
  return root;
}

function mutationArgs(input: {
  processKey: string;
  sessionId: string | null;
  name: string;
  enabled: boolean;
  id?: string;
  expiresAt?: number;
}): string {
  return (
    CAPABILITIES_TOOL_ARG_PREFIX +
    JSON.stringify({
      id: input.id ?? "mut-1",
      processKey: input.processKey,
      sessionId: input.sessionId,
      name: input.name,
      enabled: input.enabled,
      expiresAt: input.expiresAt ?? Date.now() + 30_000,
    })
  );
}

function sendMutation(
  harness: CapabilitiesHarness,
  root: { id: string },
  name: string,
  enabled: boolean,
  overrides: { id?: string; expiresAt?: number; sessionId?: string } = {},
): Promise<void> {
  return harness.invoke(
    mutationArgs({
      processKey: harness.latest().processKey,
      sessionId: overrides.sessionId ?? root.id,
      name,
      enabled,
      id: overrides.id,
      expiresAt: overrides.expiresAt,
    }),
  );
}

/** Flushes the pure-microtask await chain from the handler down to the setter. */
async function settleMicrotasks(times = 64): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve();
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

describe("generated capabilities extension: tool mutation", () => {
  it("enables and disables a tool through the setter, preserving unrelated selections", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    root.toolInfos.push({ name: "gamma", description: "g", source: "sdk", sourcePath: null });
    root.enabledNames = ["alpha", "gamma"];
    root.xdevNames = ["gamma", "beta"];
    const frames = harness.published.length;

    await sendMutation(harness, root, "beta", true);
    expect(root.setterCalls[0]).toEqual({
      enabled: ["alpha", "gamma", "beta"],
      mounted: ["gamma", "beta"],
      force: false,
    });
    let snapshot = harness.latest();
    expect(snapshot.toolControl).toBe("available");
    expect(snapshot.toolMutation).toEqual({ id: "mut-1", name: "beta", enabled: true, status: "applied" });
    expect(publishedTools(snapshot).find((tool) => tool.name === "beta")?.enabled).toBe(true);

    await sendMutation(harness, root, "beta", false, { id: "mut-2" });
    expect(root.setterCalls[1]).toEqual({ enabled: ["alpha", "gamma"], mounted: ["gamma"], force: false });
    snapshot = harness.latest();
    expect(snapshot.toolMutation).toEqual({ id: "mut-2", name: "beta", enabled: false, status: "applied" });
    // Every publish after the first mutation carries the latest record.
    expect(harness.published.slice(frames).every((frame) => frame.toolMutation !== null)).toBe(true);
  });

  it("round-trips exact registry names with spaces and punctuation", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    const name = "web search (v2)!";
    root.toolInfos.push({ name, description: "w", source: "sdk", sourcePath: null });
    await sendMutation(harness, root, name, true);
    expect(root.setterCalls[0]?.enabled).toEqual(["alpha", name]);
    expect(harness.latest().toolMutation).toEqual({ id: "mut-1", name, enabled: true, status: "applied" });
  });

  it("throws on malformed or unknown args without arming or mutating", async () => {
    vi.useFakeTimers();
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    await root.prompt();
    const good = {
      id: "m",
      processKey: "pk",
      sessionId: "root-a",
      name: "beta",
      enabled: true,
      expiresAt: Date.now() + 1_000,
    };
    const bad = [
      "tool beta alpha",
      "tool",
      "tool " + JSON.stringify([good]),
      "tool " + JSON.stringify({ ...good, extra: true }),
      "tool " + JSON.stringify({ ...good, enabled: "yes" }),
      "tool " + JSON.stringify({ id: "m", processKey: "pk", name: "beta", enabled: true, expiresAt: 1 }),
      "tool not-json",
      "read beta",
    ];
    for (const args of bad) await expect(harness.invoke(args)).rejects.toThrow();
    expect(root.setterCalls).toHaveLength(0);
    // A failed verb never arms the poll either: timers advancing publish nothing.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(harness.published).toHaveLength(0);
  });

  it("refuses a second concurrent mutation and queues later root prompts", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    let releaseGate!: () => void;
    root.setterGate = new Promise<void>((resolve) => {
      releaseGate = resolve;
    });

    const first = sendMutation(harness, root, "beta", true);
    await settleMicrotasks();
    expect(root.setterCalls).toHaveLength(1);

    const callsBefore = root.promptCalls;
    const deferred = root.prompt("ship it");
    expect(root.promptCalls).toBe(callsBefore);

    await sendMutation(harness, root, "alpha", false, { id: "mut-2" });
    expect(harness.latest().toolMutation).toEqual({
      id: "mut-2",
      name: "alpha",
      enabled: false,
      status: "busy",
    });

    releaseGate();
    await first;
    await deferred;
    expect(root.promptCalls).toBe(callsBefore + 1);
    expect(root.setterCalls).toHaveLength(1);
    expect(harness.latest().toolMutation).toEqual({ id: "mut-1", name: "beta", enabled: true, status: "applied" });
  });

  it("keeps rosters available when control APIs are missing and settles mutations unsupported", async () => {
    const harness = executableExtension();
    const root = new harness.FakeAgentSession("root-a");
    Object.assign(root, { setActiveToolPresentation: undefined });
    root.enabledNames = ["alpha"];
    await root.prompt();
    await harness.arm();
    expect(harness.latest().tools.status).toBe("available");
    expect(harness.latest().toolControl).toBe("unsupported");

    await sendMutation(harness, root, "beta", true);
    const snapshot = harness.latest();
    expect(snapshot.toolMutation).toEqual({ id: "mut-1", name: "beta", enabled: true, status: "unsupported" });
    expect(snapshot.tools.status).toBe("available");
    expect(snapshot.toolControl).toBe("unsupported");
  });

  it("applies directly when the runtime exposes no registry queue", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    Object.assign(root, { runToolRegistryMutation: undefined });
    await sendMutation(harness, root, "beta", true);
    expect(root.queueRuns).toBe(0);
    expect(root.setterCalls).toHaveLength(1);
    expect(harness.latest().toolControl).toBe("available");
    expect(harness.latest().toolMutation?.status).toBe("applied");
  });

  it("settles setter failures, unconfirmed readback, and past deadlines into published statuses", async () => {
    const failing = executableExtension();
    const rootA = await armRoot(failing);
    rootA.setterError = new Error("registry refused");
    await sendMutation(failing, rootA, "beta", true);
    expect(failing.latest().toolMutation).toEqual({
      id: "mut-1",
      name: "beta",
      enabled: true,
      status: "apply-failed",
    });

    const stalled = executableExtension();
    const rootB = await armRoot(stalled);
    rootB.setterApplies = false;
    await sendMutation(stalled, rootB, "beta", true);
    expect(stalled.latest().toolMutation?.status).toBe("not-applied");

    const late = executableExtension();
    const rootC = await armRoot(late);
    await sendMutation(late, rootC, "beta", true, { expiresAt: Date.now() - 1 });
    expect(late.latest().toolMutation?.status).toBe("expired");
    expect(rootC.setterCalls).toHaveLength(0);
  });

  it("refuses to disable write while plan mode is on and still enables it", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    root.toolInfos.push({ name: "write", description: "w", source: "builtin", sourcePath: null });
    root.planMode = { enabled: true };
    root.enabledNames = ["alpha", "write"];
    await sendMutation(harness, root, "write", false);
    expect(harness.latest().toolMutation).toEqual({
      id: "mut-1",
      name: "write",
      enabled: false,
      status: "mode-required",
    });
    expect(root.setterCalls).toHaveLength(0);

    root.enabledNames = ["alpha"];
    await sendMutation(harness, root, "write", true, { id: "mut-2" });
    expect(harness.latest().toolMutation?.status).toBe("applied");
    expect(root.setterCalls).toHaveLength(1);
  });

  it("answers already-satisfied requests as applied without touching the setter", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    await sendMutation(harness, root, "alpha", true);
    expect(harness.latest().toolMutation).toEqual({ id: "mut-1", name: "alpha", enabled: true, status: "applied" });
    await sendMutation(harness, root, "beta", false, { id: "mut-2" });
    expect(harness.latest().toolMutation?.status).toBe("applied");
    expect(root.setterCalls).toHaveLength(0);
    expect(harness.published).toHaveLength(3);
  });

  it("force-publishes refused completions and reports busy while the runtime is occupied", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    const frames = harness.published.length;

    // Identity mismatch (a stale session id) refuses before anything else.
    await sendMutation(harness, root, "beta", true, { sessionId: "root-zombie" });
    expect(harness.published).toHaveLength(frames + 1);
    expect(harness.latest().toolMutation?.status).toBe("stale");
    expect(root.setterCalls).toHaveLength(0);

    // A non-capability root prompt in flight is busy — the barrier's guard.
    let releasePrompt!: () => void;
    root.promptValue = new Promise<void>((resolve) => {
      releasePrompt = resolve;
    });
    const inFlight = root.prompt("working");
    root.promptValue = undefined;
    await settleMicrotasks();
    await sendMutation(harness, root, "beta", true, { id: "mut-2" });
    expect(harness.latest().toolMutation?.status).toBe("busy");
    expect(root.setterCalls).toHaveLength(0);
    releasePrompt();
    await inFlight;

    // A present-and-busy streaming getter refuses too.
    Object.assign(root, { isStreaming: true });
    await sendMutation(harness, root, "beta", true, { id: "mut-3" });
    expect(harness.latest().toolMutation?.status).toBe("busy");
    expect(root.setterCalls).toHaveLength(0);
  });

  it("clears the retained mutation when the root session id changes like /new", async () => {
    const harness = executableExtension();
    const root = await armRoot(harness);
    await sendMutation(harness, root, "beta", true);
    expect(harness.latest().toolMutation?.status).toBe("applied");

    root.id = "root-b";
    await root.prompt();
    const snapshot = harness.latest();
    expect(snapshot.sessionId).toBe("root-b");
    expect(snapshot.toolMutation).toBeNull();
    expect(snapshot.toolControl).toBe("available");
  });
});
