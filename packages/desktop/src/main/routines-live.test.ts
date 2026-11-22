import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEVICE_TOOL_NAME,
  FLEET_TOOLS,
  HINDSIGHT_AUTO_RETAIN_ENV,
  ISSUE_DRAFT_TOOL_NAME,
  ISSUE_FILE_TOOL_NAME,
  PRIVATE_DISABLED_TOOLS,
  ROUTINE_CREATE_TOOL_NAME,
  RpcClient,
  THEME_TOOL_NAME,
  capabilitiesMessage,
  fleetToolAccess,
  fleetToolsRegistered,
  approvalReply,
  isOutsideSenderKind,
  parseApprovalPrompt,
  privateChildEnv,
  privateGuardArmMessage,
  resolveOmpBinary,
  routineGuardArmMessage,
  setHostToolsCommand,
  writeApprovalOverlay,
  writeCapabilitiesExtension,
  writePrivateGuardExtension,
  type ApprovalPrompt,
  writePrivateOverlay,
  writeRoutineGuardExtension,
  writeSpendOverlay,
} from "@omp-ui/core";
import {
  CAPABILITIES_STATUS_KEY,
  parseCapabilitySnapshot,
  type CapabilitySnapshot,
} from "@omp-ui/core/capabilities";
import {
  compileRoutineToolPolicy,
  type RoutineCatalogSnapshot,
  type RoutineCatalogTool,
  type RoutineToolPolicy,
} from "@omp-ui/core/routine";

/**
 * Tier L live proofs (L1–L6, #1257, #1262, ADR-0100) against the REAL
 * `omp --mode=rpc-ui` binary. Zero external API keys: driven by a deterministic
 * scripted loopback OpenAI-compatible provider and a throwaway stdio MCP server
 * (`probe_routines`) logging every server-side tool invocation to `mcp-calls.jsonl`.
 *
 * - L1: Core claim — `probe_read` (allow) runs unprompted; `probe_write` (prompt)
 *   emits an Approval card parsed by `parseApprovalPrompt`, and replying "Deny"
 *   leaves `mcp-calls.jsonl` with 0 `probe_write` executions.
 * - L2: Inherited project/user `allow` cannot leak past the total compiled routine
 *   overlay (`mcp__probe_routines_probe_write: prompt`).
 * - L3: `xd://` and `eval` leak closure — both consult the inner MCP per-tool
 *   entry (`prompt` and `deny`), and `eval: prompt` gates before inner execution.
 * - L4: Subagent (`task`) leak closure — both `deny` (L4a) and the gating #1252
 *   `prompt` probe (L4b) prove a yolo-resolving child cannot execute `probe_write`
 *   unprompted (with a positive `allow` control proving the child otherwise runs).
 * - L5: Catalog drift between save and fire — a tool added to `probe_routines`
 *   after save (`probe_added_later`) compiles to `prompt` at fire time and waits
 *   on an Approval card.
 * - L6: Built-in roster removal (`omp-ui-routine-guard.ts`) + Private pin
 *   (`omp-ui-private.yml` + `HINDSIGHT_AUTO_RETAIN=false` + `/omp-ui-private`) +
 *   Spend cap (`omp-ui-spend.yml`) + Outside-sender host-tool exclusions vs a
 *   human control session.
 */

const ompPath = resolveOmpBinary();

function binaryPublishesHindsightAutoRetain(): boolean {
  if (ompPath === null) return false;
  try {
    const out = execFileSync(ompPath, ["config", "list", "--json"], {
      timeout: 15_000,
      maxBuffer: 4 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return Object.keys(JSON.parse(out) as Record<string, unknown>).includes("hindsight.autoRetain");
  } catch {
    return false;
  }
}

const hindsightKeysLive = binaryPublishesHindsightAutoRetain();

const MCP_SERVER_SOURCE = `
import * as fs from "node:fs";
import * as readline from "node:readline";

const logFile = process.argv[2];
const exposeAddedLater = process.argv[3] === "1";
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\\n");
}

rl.on("line", (line) => {
  if (!line.trim()) return;
  let req;
  try { req = JSON.parse(line); } catch { return; }
  const { id, method, params } = req;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "probe_routines", version: "1.0.0" },
      },
    });
  } else if (method === "notifications/initialized") {
    // no-op notification
  } else if (method === "tools/list") {
    const tools = [
      {
        name: "probe_read",
        description: "Read-only probe tool",
        inputSchema: { type: "object", properties: {} },
        annotations: { readOnlyHint: true },
      },
      {
        name: "probe_write",
        description: "Mutating probe tool",
        inputSchema: { type: "object", properties: { note: { type: "string" } } },
      },
    ];
    if (exposeAddedLater) {
      tools.push({
        name: "probe_added_later",
        description: "Tool added after routine policy was saved",
        inputSchema: { type: "object", properties: { note: { type: "string" } } },
      });
    }
    send({ jsonrpc: "2.0", id, result: { tools } });
  } else if (method === "tools/call") {
    const toolName = params?.name ?? "unknown";
    fs.appendFileSync(
      logFile,
      JSON.stringify({ tool: toolName, args: params?.arguments ?? null }) + "\\n",
    );
    send({
      jsonrpc: "2.0",
      id,
      result: { content: [{ type: "text", text: "executed:" + toolName }] },
    });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, result: {} });
  }
});
`;

const CONFIG_PROBE_EXT = `
let lookup = null;
// @ts-expect-error -- literal specifier resolved by omp's extension loader (ADR-0036)
void import("@oh-my-pi/pi-coding-agent/config/registry").then(
  (mod) => { lookup = mod?.lookup ?? null; },
  () => undefined,
);
let root = null;
export default function (pi) {
  try {
    const proto = pi.pi?.AgentSession?.prototype;
    const original = proto?.prompt;
    if (proto && typeof original === "function") {
      proto.prompt = function () {
        if (root === null) root = this;
        return original.apply(this, arguments);
      };
    }
  } catch { /* unreadable */ }
  pi.registerCommand("routine-config-probe", {
    description: "publish effective memory settings",
    handler: async (_args, ctx) => {
      const settings = root?.settings ?? {};
      const read = (id) => {
        if (lookup === null) return "unreadable";
        try {
          const s = lookup(id);
          return String(s?.get?.(settings) ?? "unset");
        } catch {
          return "error";
        }
      };
      ctx.ui.setStatus("routine-config-probe", JSON.stringify({
        autolearn: read("autolearn.enabled"),
        retain: read("mnemopi.autoRetain"),
        recall: read("mnemopi.autoRecall"),
        hindsightAutoRetain: read("hindsight.autoRetain"),
        hindsightAutoRecall: read("hindsight.autoRecall"),
      }));
    },
  });
}
`;

const MODELS_YML = (baseUrl: string): string => `providers:
  probe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 256
        reasoning: false
`;

const BASE_CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
`;

interface Frame {
  type: string;
  id?: string;
  method?: string;
  title?: string;
  options?: unknown;
  isTerminal?: boolean;
  statusKey?: string;
  statusText?: string;
  command?: string;
  success?: boolean;
  level?: string;
  source?: string;
  status?: string;
  agentInvoked?: boolean;
  error?: { code?: string; retryable?: boolean };
  data?: Record<string, unknown>;
}

interface ProviderToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

type ProviderHandler = (ctx: {
  messages: Array<{ role?: string; content?: unknown }>;
  opening: string;
  assistantTurns: number;
  toolMessages: string[];
  requestIndex: number;
}) => { toolCalls?: ProviderToolCall[]; text?: string };

interface ScriptedProvider {
  baseUrl: string;
  requests: number;
  close(): Promise<void>;
}

// Real timers throughout: the awaited actor is a real `omp` OS process speaking
// NDJSON over stdio; fake clocks cannot drive it and every wait polls an
// observed frame condition.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(40);
  }
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part: unknown) =>
      part !== null && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "",
    )
    .join("\n");
}

function sseChunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "routines-live",
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

async function startScriptedProvider(handler: ProviderHandler): Promise<ScriptedProvider> {
  const state = { requests: 0 };
  const server: Server = createServer((req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      state.requests += 1;
      let messages: Array<{ role?: string; content?: unknown }> = [];
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role?: string; content?: unknown }>;
        };
        if (Array.isArray(body.messages)) messages = body.messages;
      } catch {
        // handled as empty messages
      }
      const firstAssistant = messages.findIndex((m) => m.role === "assistant");
      const opening = (firstAssistant < 0 ? messages : messages.slice(0, firstAssistant))
        .map((m) => messageText(m.content))
        .join("\n");
      const assistantTurns = messages.filter((m) => m.role === "assistant").length;
      const toolMessages = messages.filter((m) => m.role === "tool").map((m) => messageText(m.content));

      const reply = handler({
        messages,
        opening,
        assistantTurns,
        toolMessages,
        requestIndex: state.requests,
      });

      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (reply.toolCalls && reply.toolCalls.length > 0) {
        res.write(
          sseChunk(
            {
              role: "assistant",
              tool_calls: reply.toolCalls.map((call, index) => ({
                index,
                id: call.id,
                type: "function",
                function: { name: call.name, arguments: JSON.stringify(call.args) },
              })),
            },
            null,
          ),
        );
        res.write(sseChunk({}, "tool_calls"));
      } else {
        res.write(sseChunk({ role: "assistant", content: reply.text ?? "done" }, null));
        res.write(sseChunk({}, "stop"));
      }
      res.write("data: [DONE]\n\n");
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("failed to bind loopback provider");
  const baseUrl = `http://127.0.0.1:${addr.port}/v1`;
  return {
    baseUrl,
    get requests() {
      return state.requests;
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

function catalogTool(key: string, source: RoutineCatalogTool["source"] = "mcp"): RoutineCatalogTool {
  return {
    key,
    source,
    group: source === "builtin" ? "builtin" : "mcp:probe_routines",
    groupLabel: source === "builtin" ? "Built-in tools" : "probe_routines",
    description: key,
  };
}

function baseCatalog(includeAddedLater = false): RoutineCatalogSnapshot {
  const tools: RoutineCatalogTool[] = [
    catalogTool("read", "builtin"),
    catalogTool("write", "builtin"),
    catalogTool("bash", "builtin"),
    catalogTool("eval", "builtin"),
    catalogTool("task", "builtin"),
    catalogTool("mcp__probe_routines_probe_read", "mcp"),
    catalogTool("mcp__probe_routines_probe_write", "mcp"),
  ];
  if (includeAddedLater) {
    tools.push(catalogTool("mcp__probe_routines_probe_added_later", "mcp"));
  }
  return {
    tools,
    staleServers: [],
    enumerationError: null,
    capturedAt: "2026-11-22T00:00:00.000Z",
  };
}

interface LiveScope {
  base: string;
  project: string;
  lineage: string;
  home: string;
  mcpLog: string;
  frames: Frame[];
  approvalPrompts: Array<{ frame: Frame; parsed: ApprovalPrompt }>;
  client: RpcClient;
  exited: Promise<void>;
  diagnostics(): string;
  readMcpCalls(): Array<{ tool: string; args: unknown }>;
}

const disposers: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dispose of disposers.splice(0)) await dispose();
});

function trackProvider(provider: ScriptedProvider): ScriptedProvider {
  disposers.push(() => provider.close());
  return provider;
}

function spawnLiveScope(opts: {
  baseUrl: string;
  approvalEntries?: Record<string, "allow" | "prompt" | "deny">;
  approvalMode?: "always-ask" | null;
  projectConfigYml?: string;
  globalConfigYml?: string;
  exposeAddedLater?: boolean;
  privateSession?: boolean;
  exportedAutoRetain?: boolean;
  deniedBuiltins?: string[];
  spendCap?: { warnUsd: number; maxUsd: number };
  resumeSessionId?: string;
  seedCostUsd?: number;
  extraExtensions?: Array<(lineage: string) => string>;
  initialCommands?: object[];
  autoAnswer?: "Deny" | "Approve" | null;
}): LiveScope {
  if (opts.exportedAutoRetain === true) vi.stubEnv(HINDSIGHT_AUTO_RETAIN_ENV, "true");
  else vi.unstubAllEnvs();

  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-routines-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });

  const mcpScript = path.join(base, "probe-mcp.mjs");
  const mcpLog = path.join(base, "mcp-calls.jsonl");
  fs.writeFileSync(mcpScript, MCP_SERVER_SOURCE);
  fs.writeFileSync(mcpLog, "");

  fs.writeFileSync(
    path.join(project, ".omp", "mcp.json"),
    JSON.stringify({
      mcpServers: {
        probe_routines: {
          command: "node",
          args: [mcpScript, mcpLog, opts.exposeAddedLater ? "1" : "0"],
        },
      },
    }),
  );

  if (opts.projectConfigYml !== undefined) {
    fs.writeFileSync(path.join(project, ".omp", "config.yml"), opts.projectConfigYml);
  }

  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(opts.baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), opts.globalConfigYml ?? BASE_CONFIG_YML);

  if (opts.resumeSessionId !== undefined && opts.seedCostUsd !== undefined) {
    const ts = "2026-11-22T08:00:00.000Z";
    const entries = [
      { type: "session", version: 3, id: opts.resumeSessionId, timestamp: ts, cwd: project },
      {
        type: "message",
        id: "u1",
        parentId: null,
        timestamp: ts,
        message: { role: "user", content: [{ type: "text", text: "previous turn" }], attribution: "user", timestamp: 1_795_000_000_000 },
      },
      {
        type: "message",
        id: "a1",
        parentId: "u1",
        timestamp: ts,
        message: {
          role: "assistant",
          content: [{ type: "text", text: "previous answer" }],
          api: "openai-completions",
          provider: "probe",
          model: "inert",
          usage: {
            input: 10,
            output: 5,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 15,
            cost: { input: opts.seedCostUsd / 2, output: opts.seedCostUsd / 2, cacheRead: 0, cacheWrite: 0, total: opts.seedCostUsd },
          },
          stopReason: "stop",
          timestamp: 1_795_000_001_000,
        },
      },
    ];
    fs.writeFileSync(
      path.join(lineage, `2026-11-22T08-00-00-000Z_${opts.resumeSessionId}.jsonl`),
      entries.map((e) => JSON.stringify(e)).join("\n") + "\n",
    );
  }

  const configOverlays: string[] = [];
  if (opts.approvalMode !== undefined || opts.approvalEntries !== undefined) {
    const approvalOverlay = writeApprovalOverlay(
      lineage,
      opts.approvalMode === undefined ? "always-ask" : opts.approvalMode,
      opts.approvalEntries,
    );
    if (approvalOverlay !== null) configOverlays.push(approvalOverlay);
  }
  if (opts.privateSession !== undefined) {
    const privateOverlay = writePrivateOverlay(lineage, opts.privateSession);
    if (privateOverlay !== null) configOverlays.push(privateOverlay);
  }
  if (opts.spendCap !== undefined) {
    const spendOverlay = writeSpendOverlay(lineage, opts.spendCap.warnUsd, opts.spendCap.maxUsd);
    if (spendOverlay !== null) configOverlays.push(spendOverlay);
  }

  const extensions: string[] = [];
  const initialCommands: object[] = [];
  if (opts.privateSession) {
    extensions.push(writePrivateGuardExtension(lineage));
    initialCommands.push({ type: "prompt", message: privateGuardArmMessage() });
  }
  if (opts.deniedBuiltins && opts.deniedBuiltins.length > 0) {
    extensions.push(writeRoutineGuardExtension(lineage, opts.deniedBuiltins));
    initialCommands.push({ type: "prompt", message: routineGuardArmMessage() });
  }
  for (const makeExt of opts.extraExtensions ?? []) {
    extensions.push(makeExt(lineage));
  }
  if (opts.initialCommands) {
    initialCommands.push(...opts.initialCommands);
  }

  const frames: Frame[] = [];
  const approvalPrompts: LiveScope["approvalPrompts"] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  let stderr = "";
  let clientError: string | null = null;

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  delete env[HINDSIGHT_AUTO_RETAIN_ENV];

  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    ...(opts.resumeSessionId === undefined ? { model: "probe/inert" } : { resumeSessionId: opts.resumeSessionId }),
    configOverlays,
    extensions,
    childEnv: privateChildEnv(opts.privateSession === true),
    ...(initialCommands.length > 0 ? { initialCommands } : {}),
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
        cwd: project,
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
      });
      proc.stderr.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal) => void proc.kill(signal),
        onExit: (cb) => proc.on("exit", (code) => cb(code)),
        onSpawnError: (cb) => proc.on("error", cb),
      };
    },
    onFrame: (raw) => {
      const frame = raw as Frame;
      frames.push(frame);
      if (frame.type === "extension_ui_request" && frame.method === "select" && typeof frame.id === "string") {
        const parsed = parseApprovalPrompt(frame.title, frame.options);
        if (parsed !== null) {
          approvalPrompts.push({ frame, parsed });
          if (opts.autoAnswer !== null) {
            const answer = approvalReply(parsed, opts.autoAnswer === "Approve" ? "once" : "deny");
            client.send({ type: "extension_ui_response", id: frame.id, value: answer });
          }
        }
      }
    },
    onExit: () => markExited(),
    onError: (msg) => {
      clientError = msg;
    },
  });

  const scope: LiveScope = {
    base,
    project,
    lineage,
    home,
    mcpLog,
    frames,
    approvalPrompts,
    client,
    diagnostics: () => `error=${String(clientError)} frames=[${frames.map((f) => f.type).join(",")}] stderr=${stderr.slice(-500)}`,
    exited,
    readMcpCalls: () =>
      fs
        .readFileSync(mcpLog, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { tool: string; args: unknown }),
  };

  disposers.push(async () => {
    client.kill();
    const exitedNow = await Promise.race([exited.then(() => true), sleep(8_000).then(() => false)]);
    if (!exitedNow) client.kill("SIGKILL");
    await sleep(150);
    fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  return scope;
}

async function waitForReady(scope: LiveScope): Promise<void> {
  await waitFor(
    () => scope.frames.find((f) => f.type === "ready"),
    30_000,
    `rpc-ui ready frame (${scope.diagnostics()})`,
  );
}

async function runTurn(scope: LiveScope, message: string): Promise<void> {
  const before = scope.frames.filter((f) => f.type === "agent_end" && f.isTerminal !== false).length;
  scope.client.send({ type: "prompt", message });
  await waitFor(
    () =>
      scope.frames.filter((f) => f.type === "agent_end" && f.isTerminal !== false).length > before
        ? true
        : undefined,
    60_000,
    `terminal agent_end for "${message}"`,
  );
}

async function readCapabilities(scope: LiveScope): Promise<CapabilitySnapshot> {
  const from = scope.frames.length;
  scope.client.send({ type: "prompt", message: capabilitiesMessage() });
  const frame = await waitFor(
    () =>
      scope.frames
        .slice(from)
        .find((f) => f.type === "extension_ui_request" && f.statusKey === CAPABILITIES_STATUS_KEY),
    30_000,
    "capabilities snapshot frame",
  );
  const parsed = parseCapabilitySnapshot(frame.statusText);
  if (parsed === null) throw new Error(`unparseable capabilities snapshot: ${String(frame.statusText)}`);
  return parsed;
}

describe.skipIf(ompPath === null)("Routines compiled tool policy & guardrails on real omp (Tier L, ADR-0100)", () => {
  it("L1: allowed read runs unprompted; prompted write raises Approval card and Deny leaves server untouched", async () => {
    const toolOutputs: string[] = [];
    const provider = trackProvider(
      await startScriptedProvider(({ assistantTurns, toolMessages }) => {
        if (assistantTurns === 0) {
          return {
            toolCalls: [{ id: "call_read", name: "mcp__probe_routines_probe_read", args: {} }],
          };
        }
        if (assistantTurns === 1) {
          toolOutputs.push(...toolMessages);
          return {
            toolCalls: [{ id: "call_write", name: "mcp__probe_routines_probe_write", args: { note: "send-it" } }],
          };
        }
        toolOutputs.push(...toolMessages);
        return { text: "finished L1" };
      }),
    );

    const policy: RoutineToolPolicy = {
      allow: ["mcp__probe_routines_probe_read"],
      deny: [],
      lastReviewedAt: "2026-11-22T00:00:00.000Z",
      reviewedCatalog: ["mcp__probe_routines_probe_read", "mcp__probe_routines_probe_write"],
    };
    const compiled = compileRoutineToolPolicy(policy, baseCatalog());

    const scope = spawnLiveScope({
      baseUrl: provider.baseUrl,
      approvalEntries: compiled.overlayEntries,
      autoAnswer: "Deny",
    });
    await waitForReady(scope);
    await runTurn(scope, "Run L1 probe.");

    expect(scope.approvalPrompts).toHaveLength(1);
    expect(scope.approvalPrompts[0]!.parsed.toolName).toBe("mcp__probe_routines_probe_write");

    const calls = scope.readMcpCalls();
    expect(calls).toEqual([{ tool: "probe_read", args: {} }]);
    expect(toolOutputs.some((t) => /denied|rejected|cancel/i.test(t))).toBe(true);
  });

  it("L2: inherited project/user allow cannot leak past total compiled routine overlay", async () => {
    const provider = trackProvider(
      await startScriptedProvider(({ assistantTurns }) => {
        if (assistantTurns === 0) {
          return {
            toolCalls: [{ id: "call_write", name: "mcp__probe_routines_probe_write", args: { note: "leak-check" } }],
          };
        }
        return { text: "finished L2" };
      }),
    );

    const compiled = compileRoutineToolPolicy(
      {
        allow: ["mcp__probe_routines_probe_read"],
        deny: [],
        lastReviewedAt: "2026-11-22T00:00:00.000Z",
        reviewedCatalog: ["mcp__probe_routines_probe_read", "mcp__probe_routines_probe_write"],
      },
      baseCatalog(),
    );

    const scope = spawnLiveScope({
      baseUrl: provider.baseUrl,
      projectConfigYml: `tools:\n  approvalMode: yolo\n  approval:\n    "mcp__probe_routines_probe_write": allow\n`,
      globalConfigYml: `${BASE_CONFIG_YML}tools:\n  approvalMode: yolo\n  approval:\n    "mcp__probe_routines_probe_write": allow\n`,
      approvalEntries: compiled.overlayEntries,
      autoAnswer: "Deny",
    });
    await waitForReady(scope);
    await runTurn(scope, "Run L2 probe.");

    expect(scope.approvalPrompts).toHaveLength(1);
    expect(scope.approvalPrompts[0]!.parsed.toolName).toBe("mcp__probe_routines_probe_write");
    expect(scope.readMcpCalls()).toEqual([]);
  });

  it("L3: xd:// and eval routes consult inner MCP per-tool policy (prompt and deny)", async () => {
    // L3a: write: allow targeting xd://mcp__probe_routines_probe_write under prompt and deny
    const runXd = async (decision: "prompt" | "deny") => {
      const seenTools: string[] = [];
      const provider = trackProvider(
        await startScriptedProvider(({ assistantTurns, toolMessages }) => {
          if (assistantTurns === 0) {
            return {
              toolCalls: [
                {
                  id: "call_xd",
                  name: "write",
                  args: {
                    i: "Invoking MCP tool via xd://",
                    path: "xd://mcp__probe_routines_probe_write",
                    content: JSON.stringify({ note: `via-xd-${decision}` }),
                  },
                },
              ],
            };
          }
          seenTools.push(...toolMessages);
          return { text: "done xd" };
        }),
      );
      const scope = spawnLiveScope({
        baseUrl: provider.baseUrl,
        approvalEntries: {
          write: "allow",
          mcp__probe_routines_probe_write: decision,
        },
        autoAnswer: "Deny",
      });
      await waitForReady(scope);
      await runTurn(scope, `Run L3a ${decision}`);
      return { scope, seenTools };
    };

    const xdPrompt = await runXd("prompt");
    expect(xdPrompt.scope.approvalPrompts.length).toBeGreaterThanOrEqual(1);
    expect(xdPrompt.scope.readMcpCalls()).toEqual([]);

    const xdDeny = await runXd("deny");
    expect(xdDeny.scope.approvalPrompts).toHaveLength(0);
    expect(xdDeny.scope.readMcpCalls()).toEqual([]);
    expect(xdDeny.seenTools.some((t) => /blocked by user policy/i.test(t))).toBe(true);

    // L3b: eval calling await tool.mcp__probe_routines_probe_write({})
    const runEval = async (evalDecision: "prompt" | "allow", mcpDecision: "prompt" | "deny") => {
      const seenTools: string[] = [];
      const provider = trackProvider(
        await startScriptedProvider(({ assistantTurns, toolMessages }) => {
          if (assistantTurns === 0) {
            return {
              toolCalls: [
                {
                  id: "call_eval",
                  name: "eval",
                  args: {
                    language: "js",
                    title: "Calling MCP tool from eval",
                    code: "await tool.mcp__probe_routines_probe_write({ note: 'via-eval' });",
                    timeout: 30,
                    reset: false,
                  },
                },
              ],
            };
          }
          seenTools.push(...toolMessages);
          return { text: "done eval" };
        }),
      );
      const scope = spawnLiveScope({
        baseUrl: provider.baseUrl,
        approvalEntries: {
          eval: evalDecision,
          mcp__probe_routines_probe_write: mcpDecision,
        },
        autoAnswer: "Deny",
      });
      await waitForReady(scope);
      await runTurn(scope, `Run L3b eval=${evalDecision} mcp=${mcpDecision}`);
      return { scope, seenTools };
    };

    // eval: prompt raises Allow tool: eval; Deny -> 0 server writes
    const evalPrompt = await runEval("prompt", "prompt");
    expect(evalPrompt.scope.approvalPrompts).toHaveLength(1);
    expect(evalPrompt.scope.approvalPrompts[0]!.parsed.toolName).toBe("eval");
    expect(evalPrompt.scope.readMcpCalls()).toEqual([]);

    // eval: allow + mcp: prompt -> inner MCP tool still prompts; Deny -> 0 server writes
    const evalAllowMcpPrompt = await runEval("allow", "prompt");
    expect(evalAllowMcpPrompt.scope.approvalPrompts).toHaveLength(1);
    expect(evalAllowMcpPrompt.scope.approvalPrompts[0]!.parsed.toolName).toBe("mcp__probe_routines_probe_write");
    expect(evalAllowMcpPrompt.scope.readMcpCalls()).toEqual([]);

    // eval: allow + mcp: deny -> inner MCP tool blocked with policy error; 0 server writes
    const evalAllowMcpDeny = await runEval("allow", "deny");
    expect(evalAllowMcpDeny.scope.approvalPrompts).toHaveLength(0);
    expect(evalAllowMcpDeny.scope.readMcpCalls()).toEqual([]);
    expect(evalAllowMcpDeny.seenTools.some((t) => /blocked by user policy/i.test(t))).toBe(true);
  });

  it("L4: task subagent honors both deny (L4a) and gating prompt (L4b) without executing probe_write unprompted", async () => {
    const runSubagent = async (decision: "allow" | "prompt" | "deny") => {
      const subagentResults: string[] = [];
      const provider = trackProvider(
        await startScriptedProvider(({ opening, assistantTurns, toolMessages }) => {
          const isChild = opening.includes("L4-SUBAGENT-TARGET");
          if (isChild) {
            if (assistantTurns === 0) {
              return {
                toolCalls: [
                  {
                    id: "call_child_write",
                    name: "mcp__probe_routines_probe_write",
                    args: { note: `child-${decision}` },
                  },
                ],
              };
            }
            subagentResults.push(...toolMessages);
            return { text: "child done" };
          }
          if (assistantTurns === 0) {
            return {
              toolCalls: [
                {
                  id: "call_task",
                  name: "task",
                  args: {
                    i: "Spawning L4 child",
                    context: "L4 subagent MCP approval probe.",
                    tasks: [
                      {
                        name: "L4Child",
                        agent: "task",
                        task: "L4-SUBAGENT-TARGET: invoke mcp__probe_routines_probe_write.",
                        solutionSpace: "one fixed call",
                      },
                    ],
                  },
                },
              ],
            };
          }
          return { text: "root done" };
        }),
      );

      const scope = spawnLiveScope({
        baseUrl: provider.baseUrl,
        globalConfigYml: `${BASE_CONFIG_YML}tools:\n  approvalMode: yolo\n  approval:\n    "mcp__probe_routines_probe_write": allow\n`,
        approvalEntries: {
          task: "allow",
          mcp__probe_routines_probe_write: decision,
        },
        autoAnswer: "Deny",
      });
      await waitForReady(scope);
      await runTurn(scope, `Run L4 ${decision}`);
      return { scope, subagentResults };
    };

    // Positive control: with allow, the child genuinely executes probe_write.
    const control = await runSubagent("allow");
    expect(control.scope.readMcpCalls()).toEqual([{ tool: "probe_write", args: { note: "child-allow" } }]);

    // L4a: deny blocks the child with policy error and 0 server writes.
    const denied = await runSubagent("deny");
    expect(denied.scope.readMcpCalls()).toEqual([]);
    expect(denied.subagentResults.some((t) => /blocked by user policy/i.test(t))).toBe(true);

    // L4b (gating #1252 probe): prompt suppresses even global yolo + global allow
    // in the headless child (no interactive UI -> refusal, 0 server writes).
    const prompted = await runSubagent("prompt");
    expect(prompted.scope.readMcpCalls()).toEqual([]);
    expect(prompted.subagentResults.some((t) => /requires approval/i.test(t))).toBe(true);
  });

  it("L5: tool added to MCP server after routine save compiles to prompt and waits on Approval card", async () => {
    const provider = trackProvider(
      await startScriptedProvider(({ assistantTurns }) => {
        if (assistantTurns === 0) {
          return {
            toolCalls: [
              {
                id: "call_added",
                name: "mcp__probe_routines_probe_added_later",
                args: { note: "drift-check" },
              },
            ],
          };
        }
        return { text: "finished L5" };
      }),
    );

    // Policy saved when only probe_read and probe_write existed.
    const savedPolicy: RoutineToolPolicy = {
      allow: ["mcp__probe_routines_probe_read"],
      deny: [],
      lastReviewedAt: "2026-11-22T00:00:00.000Z",
      reviewedCatalog: ["mcp__probe_routines_probe_read", "mcp__probe_routines_probe_write"],
    };
    // At fire time, live catalog includes probe_added_later.
    const compiled = compileRoutineToolPolicy(savedPolicy, baseCatalog(true));
    expect(compiled.overlayEntries["mcp__probe_routines_probe_added_later"]).toBe("prompt");
    expect(compiled.addedLater).toContain("mcp__probe_routines_probe_added_later");

    const scope = spawnLiveScope({
      baseUrl: provider.baseUrl,
      exposeAddedLater: true,
      approvalEntries: compiled.overlayEntries,
      autoAnswer: "Deny",
    });
    await waitForReady(scope);
    await runTurn(scope, "Run L5 probe.");

    expect(scope.approvalPrompts).toHaveLength(1);
    expect(scope.approvalPrompts[0]!.parsed.toolName).toBe("mcp__probe_routines_probe_added_later");
    expect(scope.readMcpCalls()).toEqual([]);
  });

  it("L6: built-in routine guard, Private pin, spend cap, and outside-sender host-tool exclusions", async () => {
    // L6(a) + L6(b): Built-in roster removal (`bash: deny` + omp-ui-routine-guard.ts)
    // AND Private pin (`omp-ui-private.yml` + `HINDSIGHT_AUTO_RETAIN=false` + `/omp-ui-private`)
    const bashAttemptOutputs: string[] = [];
    const provider = trackProvider(
      await startScriptedProvider(({ assistantTurns, toolMessages }) => {
        if (assistantTurns === 0) {
          return {
            toolCalls: [{ id: "call_bash", name: "bash", args: { command: "echo should-not-run", i: "Probing denied bash" } }],
          };
        }
        bashAttemptOutputs.push(...toolMessages);
        return { text: "bash attempt finished" };
      }),
    );

    const projectMemoryOn =
      "autolearn:\n  enabled: true\nmnemopi:\n  autoRetain: true\nhindsight:\n  autoRetain: true\n";
    const writeProbeExt = (lineage: string): string => {
      const p = path.join(lineage, "routine-config-probe.ts");
      fs.writeFileSync(p, CONFIG_PROBE_EXT);
      return p;
    };

    const routineScope = spawnLiveScope({
      baseUrl: provider.baseUrl,
      projectConfigYml: projectMemoryOn,
      privateSession: true,
      exportedAutoRetain: true,
      approvalEntries: { bash: "deny", read: "allow" },
      deniedBuiltins: ["bash"],
      extraExtensions: [writeCapabilitiesExtension, writeProbeExt],
    });
    await waitForReady(routineScope);

    const routineCaps = await readCapabilities(routineScope);
    expect(routineCaps.tools.status).toBe("available");
    const enabledNames = new Set(
      routineCaps.tools.status === "available"
        ? routineCaps.tools.items.filter((t) => t.enabled).map((t) => t.name)
        : [],
    );
    expect(enabledNames.has("bash")).toBe(false);
    for (const writeTool of PRIVATE_DISABLED_TOOLS) {
      expect(enabledNames.has(writeTool)).toBe(false);
    }

    // Verify effective passive memory write settings are false while recall stays untouched.
    const fromConfig = routineScope.frames.length;
    routineScope.client.send({ type: "prompt", message: "/routine-config-probe" });
    const configFrame = await waitFor(
      () =>
        routineScope.frames
          .slice(fromConfig)
          .find((f) => f.type === "extension_ui_request" && f.statusKey === "routine-config-probe"),
      30_000,
      "routine-config-probe status frame",
    );
    const effective = JSON.parse(configFrame.statusText ?? "{}") as Record<string, string>;
    expect(effective.autolearn).toBe("false");
    expect(effective.retain).toBe("false");
    expect(effective.recall).toBe("true");
    if (hindsightKeysLive) {
      expect(effective.hindsightAutoRetain).toBe("false");
    }

    // Even if the model still invokes `bash` directly, the overlay blocks it.
    await runTurn(routineScope, "Try calling bash directly.");
    expect(bashAttemptOutputs.some((t) => /blocked by user policy|not found|not available|disabled/i.test(t))).toBe(true);

    // L6(c): Spend cap stops before contacting the provider.
    const capProvider = trackProvider(await startScriptedProvider(() => ({ text: "unreachable" })));
    const sessionId = "019faa64-fdcd-7000-acfd-0123456789c2";
    const promptId = "routine-capped-prompt";
    const capScope = spawnLiveScope({
      baseUrl: capProvider.baseUrl,
      resumeSessionId: sessionId,
      seedCostUsd: 1.0,
      spendCap: { warnUsd: 0.25, maxUsd: 0.5 },
      initialCommands: [{ type: "prompt", message: "one more turn", id: promptId }],
    });
    const capResult = await waitFor(
      () => capScope.frames.find((f) => f.type === "prompt_result" && f.id === promptId),
      60_000,
      "cost_cap prompt_result",
    );
    expect(capResult).toMatchObject({
      status: "error",
      agentInvoked: true,
      error: { code: "cost_cap", retryable: false },
    });
    const costNoticeIdx = capScope.frames.findIndex(
      (f) => f.type === "notice" && f.level === "error" && f.source === "cost-gate",
    );
    expect(costNoticeIdx).toBeGreaterThanOrEqual(0);
    expect(costNoticeIdx).toBeLessThan(capScope.frames.indexOf(capResult));
    expect(capProvider.requests).toBe(0);

    // L6(d): Outside-sender host-tool exclusions vs human control session.
    const registerHostTools = async (requestedByKind: "routine" | null) => {
      const access = fleetToolAccess({
        chat: false,
        agentDispatchEnabled: true,
        requestedByKind,
      });
      const hostCmd = setHostToolsCommand(
        {
          vault: true,
          fleet: fleetToolsRegistered(access),
          device: !isOutsideSenderKind(requestedByKind),
          theme: !isOutsideSenderKind(requestedByKind),
          issues: !isOutsideSenderKind(requestedByKind),
          artifacts: false,
          routines: !isOutsideSenderKind(requestedByKind),
        },
        "omp-ui-host-tools-l6d",
      );
      const s = spawnLiveScope({
        baseUrl: capProvider.baseUrl,
        initialCommands: [hostCmd],
      });
      const resp = await waitFor(
        () => s.frames.find((f) => f.type === "response" && f.id === "omp-ui-host-tools-l6d"),
        30_000,
        `set_host_tools response (${String(requestedByKind)})`,
      );
      expect(resp.success).toBe(true);
      const registered = ((resp.data?.toolNames as string[] | undefined) ?? []).slice();
      return registered;
    };

    const routineHostTools = await registerHostTools("routine");
    const humanHostTools = await registerHostTools(null);

    for (const fleetTool of FLEET_TOOLS) {
      expect(routineHostTools).not.toContain(fleetTool);
      expect(humanHostTools).toContain(fleetTool);
    }
    expect(routineHostTools).not.toContain(DEVICE_TOOL_NAME);
    expect(routineHostTools).not.toContain(THEME_TOOL_NAME);
    expect(routineHostTools).not.toContain(ISSUE_DRAFT_TOOL_NAME);
    expect(routineHostTools).not.toContain(ISSUE_FILE_TOOL_NAME);
    // ADR-0100 amendment: an ordinary session may author disabled routine
    // drafts; a routine's own run never gets the authoring tool back.
    expect(routineHostTools).not.toContain(ROUTINE_CREATE_TOOL_NAME);
    expect(humanHostTools).toContain(ROUTINE_CREATE_TOOL_NAME);
    expect(routineHostTools.some((t) => t.startsWith("omp-ui_vault_"))).toBe(true);

    expect(humanHostTools).toContain(DEVICE_TOOL_NAME);
    expect(humanHostTools).toContain(THEME_TOOL_NAME);
    expect(humanHostTools).toContain(ISSUE_DRAFT_TOOL_NAME);
    expect(humanHostTools).toContain(ISSUE_FILE_TOOL_NAME);
    expect(humanHostTools.some((t) => t.startsWith("omp-ui_vault_"))).toBe(true);
  });
});
