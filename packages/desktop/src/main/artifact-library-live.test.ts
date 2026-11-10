import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { createServer } from "node:http";
import { Writable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import {
  ArtifactError,
  ARTIFACT_CAPTURE_TOOL_NAME,
  HTML_ARTIFACT_TOOL_NAME,
  isObject,
  resolveOmpBinary,
  RpcClient,
  setHostUriSchemesCommand,
  withArtifactReferenceContext,
  withArtifactRefreshContext,
  type ArtifactPartResult,
  type RpcFrame,
  type RpcSinks,
} from "@omp-ui/core";
import { ArtifactHostTools } from "./artifact-host-tools";
import { artifactSourceHash } from "./artifact-source";
import { ArtifactService } from "./artifact-service";
import { HostBridge } from "./host-bridge";
import { createRpcLiveEntry, wireRpc, type RpcLiveEntry } from "./live-entry";
import { ownedSessionRecord } from "./test/fixtures";

/**
 * Real-OMP proof for issue #1121. The control rails never start a model turn.
 * Authoring and reads use a scripted loopback OpenAI-compatible provider, not
 * credentials or an external model. The serial live config owns process
 * scheduling; real timers wait only on observed frames or process exit.
 */
const ompPath = resolveOmpBinary();
const TAB = "artifact-live";
const OWNER = "11111111-1111-4111-8111-111111111111";
const CONFIG = "startup:\n  checkUpdate: false\nretry:\n  enabled: false\ntools:\n  approvalMode: yolo\n";

type PlannedCall = { id: string; name: string; args: Record<string, unknown> };
interface Provider {
  baseUrl: string;
  requests: Record<string, unknown>[];
  respond: (request: Record<string, unknown>) => PlannedCall | null;
  close(): Promise<void>;
}
interface Scope {
  base: string;
  lineage: string;
  frames: RpcFrame[];
  input: RpcFrame[];
  transcript: { path: string | null };
  sent: RpcFrame[];
  wire: RpcFrame[];
  errors: string[];
  client: RpcClient;
  entry: RpcLiveEntry;
  controller: ArtifactHostTools;
  artifacts: ArtifactService;
  provider: Provider;
  gate: { enabled: boolean; reject: boolean };
  bootReady: Promise<void>;
  factoryCalls: () => number;
  arm(): void;
  stop(): Promise<void>;
}

function sleep(ms: number): Promise<void> {
  // An OS child and loopback HTTP server cannot be advanced by fake timers.
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor<T>(probe: () => T | undefined, what: string, timeoutMs = 30_000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const result = probe();
    if (result !== undefined) return result;
    if (Date.now() - start >= timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "artifact-fixture",
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

async function scriptedProvider(): Promise<Provider> {
  const requests: Record<string, unknown>[] = [];
  const provider: Provider = {
    baseUrl: "",
    requests,
    respond: () => null,
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => error ? reject(error) : resolve());
      return promise;
    },
  };
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      try {
        const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (!isObject(body)) throw new Error("expected a completion request object");
        requests.push(body);
        // Chat Completions simulation of the reported OpenRouter Responses
        // root-schema restriction, not an actual OpenRouter integration.
        const rejectsRootSchema = Array.isArray(body.tools) && body.tools.some((tool: unknown) => {
          if (!isObject(tool) || !isObject(tool.function)) return false;
          const definition = tool.function;
          const parameters = definition.parameters;
          return typeof definition.name === "string" && definition.name.startsWith("omp-ui_")
            && isObject(parameters)
            && ["oneOf", "anyOf", "allOf"].some((keyword) => Object.hasOwn(parameters, keyword));
        });
        if (rejectsRootSchema) {
          response.writeHead(400, { "Content-Type": "application/json" }).end(JSON.stringify({
            error: { type: "invalid_request_error", message: "Root tool schema combinators are not supported by this fixture." },
          }));
          return;
        }
        const call = provider.respond(body);
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
        if (call !== null) {
          response.end(chunk({ role: "assistant", tool_calls: [{
            index: 0, id: call.id, type: "function",
            function: { name: call.name, arguments: JSON.stringify(call.args) },
          }] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n");
        } else {
          response.end(chunk({ role: "assistant", content: "Fixture complete." }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
        }
      } catch (error) {
        response.writeHead(500).end(String(error));
      }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("missing artifact fixture provider port");
  provider.baseUrl = `http://127.0.0.1:${address.port}/v1`;
  return provider;
}

const scopes: Scope[] = [];
async function spawnScope(deferred = false): Promise<Scope> {
  const provider = await scriptedProvider();
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-artifact-live-"));
  const lineage = path.join(base, "lineage");
  const home = path.join(base, "home");
  const agent = path.join(home, ".omp", "agent");
  const project = path.join(base, "project");
  fs.mkdirSync(agent, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(agent, "config.yml"), CONFIG);
  fs.writeFileSync(path.join(agent, "models.yml"), `providers:
  artifactprobe:
    baseUrl: ${provider.baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 262144
        maxTokens: 131072
`);
  const frames: RpcFrame[] = [];
  const sent: RpcFrame[] = [];
  const wire: RpcFrame[] = [];
  const errors: string[] = [];
  const gate = { enabled: true, reject: false };
  const input: RpcFrame[] = [];
  const transcript = { path: null as string | null };
  const entry = createRpcLiveEntry(ownedSessionRecord({ tabId: TAB, mode: "rpc-ui", projectCwd: project, lineageDir: "lineage", sessionId: null }), "setting-off");
  let current: RpcLiveEntry | null = entry;
  const controller = new ArtifactHostTools({ enabled: () => gate.enabled, current: () => current, error: (_tabId, message) => errors.push(message) });
  const artifacts = new ArtifactService({
    registryFile: path.join(base, "registry.json"),
    ownerInstanceId: () => OWNER,
    enabled: () => gate.enabled,
    resolveTarget: (tabId) => tabId === TAB && current !== null ? {
      ownerInstanceId: OWNER, lineageDir: lineage, sessionId: entry.record.sessionId,
      runtimeKey: entry.runtimeKey, native: true, artifactsAvailable: entry.artifactAuthoringError === null,
      originContext: { kind: "project" as const, label: "Artifact live fixture", path: project },
    } : null,
    sourcePath: async () => transcript.path,
  });
  const bridge = new HostBridge({
    readPlanFile: async () => ({ ok: false, reason: "unreadable" }),
    planSnapshot: () => null, planRoot: () => lineage, notify: () => "posted",
    capabilitySessionId: () => entry.record.sessionId, log: () => {}, artifacts,
  });
  const { promise: bootReady, resolve: resolveBoot } = Promise.withResolvers<void>();
  let factoryCalls = 0;
  const rail = (): object[] => {
    factoryCalls++;
    if (gate.reject) throw new ArtifactError("disabled", "Artifact admission changed before the ready rail");
    return [setHostUriSchemesCommand(), controller.initial(entry, { vault: false, fleet: false, device: false, artifacts: gate.enabled })];
  };
  const sinks: RpcSinks = {
    onInputFrame: (frame) => {
      input.push(frame);
      controller.observe(entry, frame);
      bridge.route(TAB, frame, (answer) => { sent.push(answer); client.send(answer); });
    },
    onFrame: (frame) => {
      bridge.noteFrame(TAB, frame);
      frames.push(frame);
      if (frame.type === "ready") controller.ready(entry);
    },
    onExit: () => {},
    onError: (message) => errors.push(message),
  };
  const client = new RpcClient({
    cwd: project, lineageDir: lineage, ompPath: ompPath!, model: "artifactprobe/inert",
    deferArm: deferred, initialCommands: rail, onBootReady: resolveBoot, ...sinks,
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: {
        ...extra, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: path.join(home, ".local", "share"),
      } });
      const stdin = new Writable({ write: (bytes: Buffer, _encoding, callback) => {
        for (const line of bytes.toString("utf8").trimEnd().split("\n")) wire.push(JSON.parse(line) as RpcFrame);
        proc.stdin.write(bytes, callback);
      } });
      return {
        stdin, stdout: proc.stdout, stderr: proc.stderr, kill: (signal) => { proc.kill(signal); },
        onExit: (callback) => proc.on("exit", (code) => {
          current = null; controller.forget(entry); bridge.forget(TAB); entry.markExited(); callback(code);
        }),
        onSpawnError: (callback) => proc.on("error", callback),
      };
    },
  });
  wireRpc(entry, client);
  let stopped = false;
  const scope: Scope = {
    base, lineage, frames, input, transcript, sent, wire, errors, client, entry, controller, artifacts, provider, gate, bootReady,
    factoryCalls: () => factoryCalls,
    arm: () => client.arm(sinks, rail),
    stop: async () => {
      if (stopped) return;
      stopped = true;
      controller.close();
      client.kill();
      let exited = false;
      void entry.exited.then(() => { exited = true; });
      try { await waitFor(() => exited ? true : undefined, "artifact fixture exit", 8_000); }
      catch { client.kill("SIGKILL"); await waitFor(() => exited ? true : undefined, "artifact fixture SIGKILL exit", 8_000); }
      artifacts.close();
      await provider.close();
      fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
  scopes.push(scope);
  return scope;
}

afterEach(async () => {
  for (const scope of scopes.splice(0).reverse()) await scope.stop();
});

let commandSequence = 0;
async function request(scope: Scope, command: RpcFrame): Promise<RpcFrame> {
  const id = `artifact-live-command-${++commandSequence}`;
  scope.client.send({ ...command, id });
  const response = await waitFor(() => scope.frames.find((frame) => frame.type === "response" && frame.id === id), String(command.type));
  expect(response.success, String(response.error ?? command.type)).toBe(true);
  return response;
}

async function registration(scope: Scope, index: number, enabled: boolean): Promise<void> {
  const command = await waitFor(() => scope.wire.filter((frame) => frame.type === "set_host_tools")[index], "host-tools wire command");
  expect(Array.isArray(command.tools)).toBe(true);
  const tools = command.tools as Array<{ name: string; parameters: { properties: Record<string, unknown> } }>;
  const render = tools.find((tool) => tool.name === HTML_ARTIFACT_TOOL_NAME)!;
  expect(render).toBeDefined();
  expect(Object.hasOwn(render.parameters.properties, "artifact")).toBe(enabled);
  expect(Object.hasOwn(render.parameters.properties, "managed")).toBe(false);
  expect(tools.some((tool) => tool.name === ARTIFACT_CAPTURE_TOOL_NAME)).toBe(enabled);
  const response = await waitFor(() => scope.frames.find((frame) => frame.type === "response" && frame.id === command.id), "correlated host-tools acknowledgement");
  expect(response).toMatchObject({ success: true, data: { toolNames: tools.map((tool) => tool.name) } });
  expect(scope.entry.artifactAuthoringError).toBeNull();
}

function expectNoModelTurn(scope: Scope): void {
  expect(scope.provider.requests).toEqual([]);
  expect(scope.frames.filter((frame) => frame.type === "agent_start" || (frame.type === "message_start" && isObject(frame.message) && frame.message.role === "user"))).toEqual([]);
}

async function prompt(scope: Scope, message: string): Promise<void> {
  const before = scope.frames.length;
  await request(scope, { type: "prompt", message });
  await waitFor(() => scope.frames.slice(before).find((frame) => frame.type === "agent_end"), "the scripted artifact turn end", 60_000);
  expect(scope.errors).toEqual([]);
}

function persistedToolResult(scope: Scope, toolCallId: string): Record<string, unknown> | undefined {
  const files = fs.readdirSync(scope.lineage).flatMap((name) => {
    const file = path.join(scope.lineage, name);
    return fs.statSync(file).isDirectory() ? fs.readdirSync(file).map((child) => path.join(file, child)) : [file];
  }).filter((file) => file.endsWith(".jsonl"));
  for (const file of files) for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    if (!line.includes('"toolResult"')) continue;
    let entry: unknown;
    try { entry = JSON.parse(line); }
    catch { continue; } // A lazy transcript flush can leave its last line incomplete.
    if (!isObject(entry)) continue;
    const message = isObject(entry.message) ? entry.message : entry;
    if (message.role === "toolResult" && message.toolCallId === toolCallId) return message;
  }
  return undefined;
}

function toolDetails(scope: Scope, toolCallId: string): Record<string, unknown> {
  const call = scope.frames.find((frame) => frame.type === "host_tool_call" && frame.toolCallId === toolCallId);
  expect(call, `native host call ${toolCallId}`).toBeDefined();
  const result = scope.sent.find((frame) => frame.type === "host_tool_result" && frame.id === call!.id);
  expect(result?.isError).not.toBe(true);
  expect(isObject(result?.result)).toBe(true);
  const body = result!.result as Record<string, unknown>;
  expect(isObject(body.details)).toBe(true);
  return body.details as Record<string, unknown>;
}

function assistantCalls(frame: RpcFrame): Record<string, unknown>[] {
  if ((frame.type === "message_start" || frame.type === "message_end") && isObject(frame.message) && frame.message.role === "assistant") {
    return Array.isArray(frame.message.content) ? frame.message.content.filter(isObject) : [];
  }
  if (frame.type !== "message_update" || !isObject(frame.assistantMessageEvent)) return [];
  const event = frame.assistantMessageEvent;
  const partial = isObject(event.partial) ? event.partial : null;
  const content = Array.isArray(partial?.content) ? partial.content : [];
  const block = event.type === "toolcall_end" ? event.toolCall
    : content[typeof event.contentIndex === "number" ? event.contentIndex : -1] ?? event.block;
  return isObject(block) ? [block] : [];
}

function expectAssistantBeforeHost(scope: Scope, toolCallId: string, toolName: string): void {
  const hostIndex = scope.input.findIndex((frame) => frame.type === "host_tool_call" && frame.toolCallId === toolCallId);
  expect(hostIndex).toBeGreaterThan(-1);
  const assistantIndex = scope.input.findIndex((frame) => assistantCalls(frame).some((block) =>
    block.type === "toolCall" && block.id === toolCallId && block.name === toolName));
  expect(assistantIndex).toBeGreaterThan(-1);
  expect(assistantIndex).toBeLessThan(hostIndex);
}

function libraryRows(scope: Scope): { drafts: number; sources: number; captures: number } {
  const file = path.join(scope.base, "artifacts", "library.sqlite");
  if (!fs.existsSync(file)) return { drafts: 0, sources: 0, captures: 0 };
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return {
      drafts: Number(db.prepare("SELECT COUNT(*) AS count FROM drafts").get()!.count),
      sources: Number(db.prepare("SELECT COUNT(*) AS count FROM sources").get()!.count),
      captures: Number(db.prepare("SELECT COUNT(*) AS count FROM captures").get()!.count),
    };
  } finally { db.close(); }
}

async function nestedRefusal(scope: Scope, toolName: string, args: Record<string, unknown>, id: string): Promise<void> {
  const before = libraryRows(scope);
  const from = scope.input.length;
  const calls: PlannedCall[] = [{ id, name: "eval", args: {
    language: "js", code: `print(await tool[${JSON.stringify(toolName)}](${JSON.stringify(args)}));`,
    title: "Exercise nested artifact admission",
  } }];
  scope.provider.respond = () => calls.shift() ?? null;
  await prompt(scope, "Invoke the scripted nested artifact call.");
  const hosts = scope.input.slice(from).filter((frame) => frame.type === "host_tool_call" && frame.toolName === toolName);
  expect(hosts).toHaveLength(1);
  const host = hosts[0]!;
  expect(typeof host.toolCallId).toBe("string");
  expect(scope.input.slice(from).flatMap(assistantCalls).some((block) => block.id === host.toolCallId)).toBe(false);
  const answers = scope.sent.filter((frame) => frame.type === "host_tool_result" && frame.id === host.id);
  expect(answers).toHaveLength(1);
  expect(answers[0]).toMatchObject({ isError: true });
  expect(JSON.stringify(answers[0])).toContain("directly");
  expect(JSON.stringify(answers[0])).not.toContain("artifactDraft");
  expect(JSON.stringify(answers[0])).not.toContain("artifactCapture");
  expect(libraryRows(scope)).toEqual(before);
}

describe.skipIf(ompPath === null)("artifact library rails on the real runtime", () => {
  it.each(["cold", "warm-ready", "warm-pending"] as const)("reads the latest gate exactly once on the %s factory rail", async (mode) => {
    const scope = await spawnScope(mode !== "cold");
    if (mode === "warm-ready") await scope.bootReady;
    expect(scope.factoryCalls()).toBe(0);
    expect(scope.wire).toEqual([]);
    if (mode === "warm-pending") scope.arm();
    scope.gate.enabled = false;
    if (mode === "warm-ready") scope.arm();
    await registration(scope, 0, false);
    expect(scope.factoryCalls()).toBe(1);
    expect(scope.wire[0]).toEqual({ type: "negotiate_protocol", protocolVersion: 2 });
    expect(scope.wire.filter((frame) => frame.type === "set_host_tools")).toHaveLength(1);
    expectNoModelTurn(scope);
  });

  it.each(["cold", "warm-ready", "warm-pending"] as const)("makes a throwing %s factory fatal without a prompt or uncaught exception", async (mode) => {
    const scope = await spawnScope(mode !== "cold");
    if (mode === "warm-ready") await scope.bootReady;
    scope.gate.reject = true;
    if (mode !== "cold") expect(() => scope.arm()).not.toThrow();
    await waitFor(() => scope.errors.length > 0 ? true : undefined, "factory error reporting");
    expect(scope.errors).toEqual(["failed to prepare initial rpc-ui commands: Artifact admission changed before the ready rail"]);
    expect(scope.factoryCalls()).toBe(1);
    expect(scope.client.dead).toBe(true);
    expect(scope.wire).toEqual([{ type: "negotiate_protocol", protocolVersion: 2 }]);
    expect(scope.frames.some((frame) => frame.type === "ready")).toBe(false);
    expectNoModelTurn(scope);
  });

  it("replaces managed render schema and capture membership through coalesced hot flips without a model", async () => {
    const scope = await spawnScope();
    await registration(scope, 0, true);
    scope.gate.enabled = false;
    const off = scope.controller.sync(false);
    scope.gate.enabled = true;
    const on = scope.controller.sync(true);
    scope.gate.enabled = false;
    const final = scope.controller.sync(false);
    await Promise.all([off, on, final]);
    await registration(scope, 1, false);
    expect(scope.wire.filter((frame) => frame.type === "set_host_tools")).toHaveLength(2);
    scope.gate.enabled = true;
    await scope.controller.sync(true);
    await registration(scope, 2, true);
    expect(scope.entry.artifactHostToolsEpoch).toBe(scope.controller.currentEpoch);
    expect(scope.errors).toEqual([]);
    expectNoModelTurn(scope);
  });

  it("settles a pending hot update when its real child exits and never retries a dead process", async () => {
    const scope = await spawnScope();
    await registration(scope, 0, true);
    scope.gate.enabled = false;
    const update = scope.controller.sync(false);
    scope.client.kill();
    await scope.entry.exited;
    await update;
    const count = scope.wire.length;
    await scope.controller.sync(true);
    expect(scope.wire).toHaveLength(count);
    expect(scope.errors).toEqual([]);
    expectNoModelTurn(scope);
  });

  it("completes a greeting with artifact tools against a root-schema-rejecting provider", async () => {
    const scope = await spawnScope();
    await registration(scope, 0, true);
    await prompt(scope, "hi");
    expect(scope.provider.requests.some((body) => Array.isArray(body.tools) && body.tools.some((tool: unknown) =>
      isObject(tool) && isObject(tool.function) && tool.function.name === ARTIFACT_CAPTURE_TOOL_NAME,
    ))).toBe(true);
    const assistantEnd = scope.frames.find((frame) =>
      frame.type === "message_end" && isObject(frame.message) && frame.message.role === "assistant",
    );
    expect(assistantEnd).toBeDefined();
    expect(assistantEnd!.message).toMatchObject({
      role: "assistant",
      content: expect.arrayContaining([{ type: "text", text: "Fixture complete." }]),
      stopReason: "stop",
    });
  });

  it("persists native render/capture details, keeps human authority, and pages consented Unicode data through real read calls", async () => {
    const scope = await spawnScope();
    await registration(scope, 0, true);
    const state = await request(scope, { type: "get_state" });
    expect(isObject(state.data) && typeof state.data.sessionId === "string").toBe(true);
    scope.entry.record.sessionId = (state.data as Record<string, unknown>).sessionId as string;
    expect(isObject(state.data) && typeof state.data.sessionFile === "string").toBe(true);
    scope.transcript.path = (state.data as Record<string, unknown>).sessionFile as string;
    expect(path.dirname(scope.transcript.path)).toBe(scope.lineage);
    expect(scope.transcript.path.endsWith(`_${scope.entry.record.sessionId}.jsonl`)).toBe(true);
    const value = "한글😀".repeat(9_000);
    const dataset = {
      id: "rows", title: "Working rows", schema: "rows-v1", value,
      provenance: {
        source: { kind: "manual", label: "Hermetic live fixture" },
        method: { kind: "manual", description: "Deterministic fixture data" },
        capturedAt: "2026-11-09T00:00:00.000Z",
        refresh: { kind: "session", instructions: "Read the fixture again", requiredSources: ["Hermetic live fixture"] },
      },
    };
    const renderArgs = {
      title: "Fixture chart", html: "<!doctype html><h1>Fixture chart</h1>",
      artifact: { protocolVersion: 1, stateSchema: "chart-v1", initialState: { selected: 1 }, datasets: [dataset] },
    };
    await nestedRefusal(scope, HTML_ARTIFACT_TOOL_NAME, renderArgs, "nested-managed-eval");
    await nestedRefusal(scope, HTML_ARTIFACT_TOOL_NAME, { title: "Plain nested fixture", html: "<p>No card</p>" }, "nested-plain-eval");
    const { value: _inlineValue, ...fileDataset } = dataset;
    const fileArgs = { ...renderArgs, artifact: { ...renderArgs.artifact, datasets: [{ ...fileDataset, valueFile: "local://fixture-rows.json" }] } };
    const calls: PlannedCall[] = [
      { id: "native-dataset-write", name: "write", args: { path: "local://fixture-rows.json", content: JSON.stringify(value) } },
      { id: "native-render-call", name: HTML_ARTIFACT_TOOL_NAME, args: fileArgs },
    ];
    scope.provider.respond = () => calls.shift() ?? null;
    await prompt(scope, "Author the deterministic fixture artifact.");
    expectAssistantBeforeHost(scope, "native-render-call", HTML_ARTIFACT_TOOL_NAME);
    const localFile = path.join(scope.transcript.path.slice(0, -".jsonl".length), "local", "fixture-rows.json");
    expect(JSON.parse(fs.readFileSync(localFile, "utf8"))).toBe(value);
    expect(libraryRows(scope)).toEqual({ drafts: 1, sources: 1, captures: 0 });
    const nativeRender = scope.input.find((frame) => frame.type === "host_tool_call" && frame.toolCallId === "native-render-call")!;
    expect(nativeRender.arguments).toEqual(fileArgs);
    const details = toolDetails(scope, "native-render-call");
    expect(details).toMatchObject({ artifactDraft: { version: 1, draftId: expect.any(String), sourceHash: expect.stringMatching(/^[a-f0-9]{64}$/) } });
    expect((details.artifactDraft as Record<string, unknown>).sourceHash).toBe(artifactSourceHash(fileArgs));
    expect(artifactSourceHash(fileArgs)).not.toBe(artifactSourceHash(renderArgs));
    const persisted = await waitFor(() => persistedToolResult(scope, "native-render-call"), "persisted native render details");
    expect(persisted.details).toEqual(details);
    expect(scope.artifacts.list().artifacts).toEqual([]);
    const draft = details.artifactDraft as Record<string, unknown>;
    expect(scope.artifacts.resolveSurface({ draftId: draft.draftId as string }).datasets.rows!.value).toBe(value);
    fs.unlinkSync(localFile);
    expect(scope.artifacts.resolveSurface({ draftId: draft.draftId as string }).datasets.rows!.value).toBe(value);
    const kept = scope.artifacts.keep({ draftId: draft.draftId as string, title: "Kept fixture chart" });
    expect(kept.origin.toolCallId).toBe("native-render-call");
    expect(kept.origin.sessionId).toBe(scope.entry.record.sessionId);
    expect(kept.originContext).toEqual({ kind: "project", label: "Artifact live fixture", path: scope.entry.record.projectCwd });
    const selector = { targetTabId: TAB, artifactId: kept.artifactId, codeRevisionId: kept.currentCodeRevisionId, dataSnapshotId: kept.currentDataSnapshotId };
    const beforeReference = scope.wire.length;
    const definitionOnly = scope.artifacts.reference({ ...selector, includeData: false });
    expect(scope.wire).toHaveLength(beforeReference);
    const deniedWire = withArtifactReferenceContext("Read the data only if consent permits.", [definitionOnly]);
    scope.artifacts.admitPrompt({ tabId: TAB, text: deniedWire });
    const deniedCalls: PlannedCall[] = [{ id: "native-denied-read", name: "read", args: { path: `omp-ui://artifacts/reference/${definitionOnly.referenceId}/dataset/rows` } }];
    scope.provider.respond = () => deniedCalls.shift() ?? null;
    const deniedFrom = scope.sent.length;
    await prompt(scope, deniedWire);
    expect(scope.sent.slice(deniedFrom).find((frame) => frame.type === "host_uri_result")).toMatchObject({ isError: true });
    const reference = scope.artifacts.reference({ ...selector, includeData: true });
    const wire = withArtifactReferenceContext("Read every page of the exact accepted data.", [reference]);
    expect(wire).not.toContain(value);
    scope.artifacts.admitPrompt({ tabId: TAB, text: wire });
    const manifest = JSON.parse(scope.artifacts.readHostUri({ tabId: TAB, url: reference.manifestUri })) as ArtifactPartResult;
    expect(manifest.text).not.toContain(value);
    expect(manifest.text).not.toContain("Read the fixture again");
    const pagesFrom = scope.sent.length;
    let pageCalls = 0;
    scope.provider.respond = () => {
      const results = scope.sent.slice(pagesFrom).filter((frame) => frame.type === "host_uri_result");
      const previous = results.at(-1);
      const page = previous === undefined ? null : JSON.parse(String(previous.content)) as ArtifactPartResult;
      if (page?.nextOffset === null) return null;
      return { id: `native-page-${++pageCalls}`, name: "read", args: { path: `omp-ui://artifacts/reference/${reference.referenceId}/dataset/rows?offset=${page?.nextOffset ?? 0}&limit=65536` } };
    };
    await prompt(scope, wire);
    const pages = scope.sent.slice(pagesFrom).filter((frame) => frame.type === "host_uri_result").map((frame) => {
      expect(frame.isError).not.toBe(true);
      return JSON.parse(String(frame.content)) as ArtifactPartResult;
    });
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]!.offset).toBe(0);
    let offset = 0;
    for (const page of pages) {
      expect(page.offset).toBe(offset);
      expect(page.text).not.toContain("\uFFFD");
      offset += Buffer.byteLength(page.text, "utf8");
      expect(page.nextOffset).toBe(offset === page.totalBytes ? null : offset);
    }
    expect(JSON.parse(pages.map((page) => page.text).join(""))).toBe(value);
    const refresh = scope.artifacts.prepareRefresh({ ...selector, datasetIds: ["rows"] });
    const refreshWire = withArtifactRefreshContext(withArtifactReferenceContext("Refresh the accepted rows.", [refresh.reference]), [{ version: 1 as const, refreshRequestId: refresh.request.refreshRequestId, artifactId: refresh.request.artifactId, title: "T", datasetIds: ["rows"] }]);
    scope.artifacts.admitPrompt({ tabId: TAB, text: refreshWire });
    await nestedRefusal(scope, ARTIFACT_CAPTURE_TOOL_NAME, {
      status: "captured", refreshRequestId: refresh.request.refreshRequestId, datasets: [{ ...dataset, value: "nested must not stage" }],
    }, "nested-capture-eval");
    const captures: PlannedCall[] = [{ id: "native-capture-call", name: ARTIFACT_CAPTURE_TOOL_NAME, args: {
      status: "captured", refreshRequestId: refresh.request.refreshRequestId, datasets: [{ ...dataset, value: "fresh fixture data" }],
    } }];
    scope.provider.respond = () => captures.shift() ?? null;
    await prompt(scope, refreshWire);
    expectAssistantBeforeHost(scope, "native-capture-call", ARTIFACT_CAPTURE_TOOL_NAME);
    const captureDetails = toolDetails(scope, "native-capture-call");
    expect(captureDetails).toMatchObject({ artifactCapture: { version: 1, captureId: expect.any(String), refreshRequestId: refresh.request.refreshRequestId } });
    const savedCapture = await waitFor(() => persistedToolResult(scope, "native-capture-call"), "persisted native capture details");
    expect(savedCapture.details).toEqual(captureDetails);
    expect(scope.artifacts.describe({ artifactId: kept.artifactId }).artifact.currentDataSnapshotId).toBe(kept.currentDataSnapshotId);
    const capture = captureDetails.artifactCapture as Record<string, unknown>;
    const applied = scope.artifacts.applyCapture({ captureId: capture.captureId as string, expectedCodeRevisionId: kept.currentCodeRevisionId, expectedDatasetHeads: refresh.request.expectedDatasetHeads });
    expect(applied.currentCodeRevisionId).toBe(kept.currentCodeRevisionId);
    expect(applied.currentDataSnapshotId).not.toBe(kept.currentDataSnapshotId);
    expect(scope.errors).toEqual([]);
  }, 180_000);
});
