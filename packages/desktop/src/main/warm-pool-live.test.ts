import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CH,
  COUNCIL_AGENT,
  COUNCIL_COMMAND,
  COUNCIL_LAUNCH_TYPE,
  ProviderKeys,
  Registry,
  RpcClient,
  resolveOmpBinary,
  setHostToolsCommand,
  type CouncilDocument,
  type RpcChildProcess,
  type RpcFrame,
  type RpcSinks,
} from "@omp-ui/core";
import { SessionManager, type SessionManagerDependencies } from "./session-manager";
import { seedRegistry } from "./test/fixtures";
import { warmPlanKey, type WarmRpcPool, type WarmSlot } from "./warm-pool";
import type { BreadcrumbEntry } from "./breadcrumbs";

/**
 * End-to-end proof of the warm-pool deferral protocol against the REAL
 * `omp --mode=rpc-ui` binary (perf issue #908). The unit suites pin the
 * client mechanics with a fake child; these guard what only a real child
 * can answer:
 *
 * 1. a parked deferred boot that never negotiates stays ALIVE indefinitely —
 *    negotiating at warm boot is what killed idle children during development,
 *    so "zero wire bytes until arm()" is the load-bearing invariant;
 * 2. `arm()`-ing a parked child settles the real host-tools registration with
 *    a `response` for `omp-ui-host-tools-1` — adoption is protocol-viable,
 *    not just stream-viable.
 *
 * OMP 18.18.7 must be installed; missing setup fails instead of skipping.
 * All waits here are real-time on purpose: the awaited condition is a real OS
 * process, and a fake clock cannot make it live, speak, or exit — the
 * documented exception for platform-clock integration tests.
 */

const ompPath = resolveOmpBinary();

function requiredOmpPath(): string {
  if (ompPath === null) throw new Error("Warm Council live proofs require the installed OMP 18.18.7 binary; no live proof may skip.");
  return ompPath;
}

const COUNCIL: CouncilDocument = {
  instructions: "Original shared instructions.",
  members: [{ name: "alpha", model: "probe/member", instructions: "Original member instructions.", enabled: true }],
};

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
`;

function modelsYml(baseUrl: string): string {
  return `providers:
  probe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
${["inert", "member", "trial"].map((model) => `      - id: ${model}
        name: ${model}
        contextWindow: 131072
        maxTokens: 128`).join("\n")}
`;
}

function sleep(ms: number): Promise<void> {
  // Real process readiness and exit cannot advance under a fake clock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const bases: string[] = [];
const disposers: Array<() => Promise<void>> = [];

function scope(baseUrl = "http://127.0.0.1:9/v1"): { dir: string; lineage: string; home: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-warmlive-"));
  bases.push(dir);
  const home = path.join(dir, "home");
  const agent = path.join(home, ".omp", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "models.yml"), modelsYml(baseUrl));
  fs.writeFileSync(path.join(agent, "config.yml"), CONFIG_YML);
  return { dir, lineage: path.join(dir, "lin"), home };
}

/** Real child exit, escalating to SIGKILL — removing the scope while omp is
 *  still flushing the session file flakes with ENOTEMPTY (#123). */
function awaitExit(client: RpcClient, exited: Promise<void>): Promise<void> {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  const escalate = setTimeout(() => client.kill("SIGKILL"), 5_000);
  const abandon = setTimeout(resolve, 10_000);
  void exited.then(() => {
    clearTimeout(escalate);
    clearTimeout(abandon);
    resolve();
  });
  return promise;
}

interface Parked {
  client: RpcClient;
  ready: Promise<void>;
  stdinBytes: () => number;
}

function parkDeferred(dir: string, lineage: string, home: string): Parked {
  let markReady!: () => void;
  let markExited!: () => void;
  const ready = new Promise<void>((resolve) => { markReady = resolve; });
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  const stdinWrites: Buffer[] = [];
  const client = new RpcClient({
    cwd: dir,
    lineageDir: lineage,
    ompPath: requiredOmpPath(),
    model: "probe/inert",
    deferArm: true,
    onBootReady: markReady,
    // Inert while parked; arm() replaces these wholesale.
    onFrame: () => {},
    onExit: () => markExited(),
    onError: (m) => {
      throw new Error(`deferred boot errored: ${m}`);
    },
    // Real spawn, instrumented only on stdin to count wire bytes.
    spawnProcess: (cmd, args, env): RpcChildProcess => {
      const proc = spawn(cmd, args, {
        cwd: dir,
        env: {
          ...env,
          HOME: home,
          XDG_CONFIG_HOME: path.join(home, ".config"),
          XDG_DATA_HOME: path.join(home, ".local", "share"),
        },
        stdio: "pipe",
      });
      const stdin = proc.stdin!;
      const write = stdin.write.bind(stdin);
      stdin.write = ((chunk: Parameters<typeof write>[0], ...rest: unknown[]): boolean => {
        stdinWrites.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
        return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
      }) as typeof stdin.write;
      return {
        stdin,
        stdout: proc.stdout!,
        stderr: proc.stderr!,
        kill: (signal?: NodeJS.Signals) => {
          proc.kill(signal);
        },
        onExit: (cb) => {
          proc.on("exit", (code) => cb(code));
        },
        onSpawnError: (cb) => {
          proc.on("error", cb);
        },
      };
    },
  });
  disposers.push(async () => {
    client.kill();
    await awaitExit(client, exited);
  });
  return { client, ready, stdinBytes: () => stdinWrites.reduce((sum, b) => sum + b.length, 0) };
}

afterEach(async () => {
  for (const dispose of disposers.splice(0).reverse()) await dispose();
  vi.unstubAllEnvs();
  for (const dir of bases.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

interface CouncilFrame extends RpcFrame {
  message?: { customType?: string; content?: unknown };
}

async function councilProvider(withTrial: boolean): Promise<{ baseUrl: string; models: string[] }> {
  const models: string[] = [];
  let launched = false;
  const calls = (withTrial ? ["member", "trial"] : ["member"]).map((model, index) => ({
    index,
    id: `warm_${model}`,
    type: "function",
    function: {
      name: "task",
      arguments: JSON.stringify({
        i: "Warm Council probe",
        context: "Answer independently, read-only.",
        tasks: [{
          name: model === "member" ? "council-alpha" : "council-nova",
          agent: COUNCIL_AGENT,
          model: `probe/${model}`,
          task: "Reply ok.",
          solutionSpace: "one fixed answer",
        }],
      }),
    },
  }));
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const bodyText = Buffer.concat(parts).toString("utf8");
      const body = JSON.parse(bodyText) as { model: string };
      models.push(body.model);
      const launch = !launched && body.model === "inert" && bodyText.includes("warm-council-probe");
      if (launch) launched = true;
      const chunk = (delta: Record<string, unknown>, finishReason: string | null): string =>
        `data: ${JSON.stringify({
          id: `warm-${models.length}`,
          object: "chat.completion.chunk",
          created: 0,
          model: body.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
          ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
        })}\n\n`;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        chunk(launch ? { role: "assistant", tool_calls: calls } : { role: "assistant", content: "ok" }, null) +
        chunk({}, launch ? "tool_calls" : "stop") + "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("No hermetic provider port");
  disposers.push(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close((error) => error ? reject(error) : resolve());
  }));
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, models };
}

/** Inspect actual process identity and the pool, never replace either implementation. */
type ManagerRuntime = {
  warmPool: WarmRpcPool;
  live: Map<string, { kind: string; rpc: RpcClient | null }>;
};

function councilManager(baseUrl: string): {
  manager: SessionManager;
  registry: Registry;
  frames: Map<string, CouncilFrame[]>;
  crumbs: BreadcrumbEntry[];
  spawn(): Promise<{ tabId: string }>;
  parked(): Promise<WarmSlot>;
  processFor(tabId: string): RpcClient;
} {
  requiredOmpPath();
  const s = scope(baseUrl);
  vi.stubEnv("HOME", s.home);
  vi.stubEnv("XDG_CONFIG_HOME", path.join(s.home, ".config"));
  vi.stubEnv("XDG_DATA_HOME", path.join(s.home, ".local", "share"));
  const project = path.join(s.dir, "project");
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, "seed.txt"), "hello\n");
  for (const args of [
    ["init", "-q"],
    ["add", "seed.txt"],
    ["-c", "user.email=live@test", "-c", "user.name=live", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"],
  ]) execFileSync("git", args, { cwd: project, stdio: "pipe" });
  const registryFile = path.join(s.dir, "registry.json");
  seedRegistry(registryFile, { settings: {
    defaultAgentMode: "build",
    defaultAutoThinking: true,
    councilEnabled: true,
    councilRoster: COUNCIL,
  } });
  const registry = Registry.load(registryFile);
  registry.addProject(project);
  registry.setProjectDefaultModel(project, "probe/inert");
  const frames = new Map<string, CouncilFrame[]>();
  const crumbs: BreadcrumbEntry[] = [];
  const deps: SessionManagerDependencies = {
    registry,
    registryFile,
    providerKeys: new ProviderKeys(path.join(s.dir, "keys.json"), {
      available: true,
      backend: "live-test",
      encrypt: (plain) => Buffer.from(plain),
      decrypt: (blob) => blob.toString("utf8"),
    }, {}),
    hasConfiguredModelsFileProvider: () => true,
    getOmpPath: requiredOmpPath,
    getSessionsRoot: () => path.join(s.dir, "sessions"),
    getArchiveRoot: () => path.join(s.dir, "archive"),
    getWorktreesRoot: () => path.join(s.dir, "worktrees"),
    getChatsRoot: () => path.join(s.dir, "chats"),
    broadcast: async () => {},
    send: (channel, ...args) => {
      if (channel !== CH.onRpcFrame || typeof args[0] !== "string") return;
      const tabFrames = frames.get(args[0]) ?? [];
      tabFrames.push(args[1] as CouncilFrame);
      frames.set(args[0], tabFrames);
    },
    breadcrumb: {
      record: (kind, fields = {}) => { crumbs.push({ at: new Date().toISOString(), seq: crumbs.length + 1, kind, ...fields }); },
      entries: () => crumbs.slice(),
    },
    devicePane: {
      encodeJpeg: () => new Uint8Array(),
      agentDeviceBin: () => null,
      stateDir: () => path.join(s.dir, "devices"),
    },
    collabCli: { exec: async () => ({ stdout: "", stderr: "not used by RPC proof", code: 1 }) },
    forceWarmPool: true,
  };
  const manager = new SessionManager(deps);
  const runtime = manager as unknown as ManagerRuntime;
  const children = new Map<RpcClient, Promise<void>>();
  const track = (client: RpcClient): RpcClient => {
    if (!children.has(client)) children.set(client, new Promise<void>((resolve) => { client.onDeath(() => resolve()); }));
    return client;
  };
  disposers.push(async () => {
    manager.killAll();
    await Promise.all([...children].map(([client, exited]) => awaitExit(client, exited)));
  });
  const processFor = (tabId: string): RpcClient => {
    const client = runtime.live.get(tabId)?.rpc;
    if (client == null) throw new Error(`No real RPC process for ${tabId}`);
    return track(client);
  };
  return {
    manager,
    registry,
    frames,
    crumbs,
    processFor,
    spawn: async () => {
      const result = await manager.spawn({ origin: "new", projectCwd: project, mode: "rpc-ui", advisor: false, cols: 80, rows: 24, worktree: null });
      processFor(result.tabId);
      await waitFor(() => frames.get(result.tabId)?.find((frame) => frame.type === "ready"), 90_000, "the managed real child ready");
      return result;
    },
    parked: async () => {
      const key = warmPlanKey({ ompPath: requiredOmpPath(), projectCwd: project, advisor: false, thinking: "auto", advisorModel: null, autoresearchEnabled: false, councilEnabled: true });
      const slot = await waitFor(() => runtime.warmPool.reserve(key) ?? undefined, 90_000, "a ready real Council warm slot");
      track(slot.client);
      // Preserve this slot for the managed spawn but prevent an unobserved refill at teardown.
      runtime.warmPool.release(slot);
      deps.warmRpc = false;
      return slot;
    },
  };
}

describe("warm-pool deferral live (real omp)", () => {
  it("a parked boot consumes zero bytes and survives un-negotiated", { timeout: 120_000 }, async () => {
    const s = scope();
    const p = parkDeferred(s.dir, s.lineage, s.home);
    await p.ready;
    // The idle window a warm slot realistically waits in the app; if omp
    // ever watchdogs an un-negotiated rpc-ui child, this dies first. No fake
    // timer can substitute — survival is a property of the real child.
    await sleep(15_000);
    expect(p.client.dead).toBe(false);
    expect(p.stdinBytes()).toBe(0);
  });

  it("adopting a parked child settles the real host-tools registration", { timeout: 120_000 }, async () => {
    const s = scope();
    const p = parkDeferred(s.dir, s.lineage, s.home);
    await p.ready;
    // Let boot-time extension_ui_requests (if any) park before adoption.
    await sleep(1_000);
    expect(p.stdinBytes()).toBe(0);
    const frames: RpcFrame[] = [];
    const settled = (): true | undefined =>
      frames.some((f) => f.type === "response" && f.id === "omp-ui-host-tools-1") ? true : undefined;
    const sinks: RpcSinks = {
      // Answer parked boot-time UI requests exactly like the adoption path.
      onInputFrame: (frame) => {
        if (frame.type === "extension_ui_request" && typeof frame.id === "string") {
          p.client.send({ type: "extension_ui_response", id: frame.id, cancelled: true });
        }
      },
      onFrame: (frame) => frames.push(frame),
      onExit: () => {},
      onError: () => {},
    };
    p.client.arm(sinks, [setHostToolsCommand()]);
    // The settle contract the bench measures: a response for the rail tail.
    await waitFor(settled, 60_000, "host-tools settle");
    expect(p.client.armed).toBe(true);
  });
});

describe("prepared Council warm adoption (real omp)", () => {
  const cases: Array<{ name: string; council: CouncilDocument; adopted: boolean; trial: boolean }> = [
    { name: "unchanged preparation adopts and launches the original member", council: COUNCIL, adopted: true, trial: false },
    { name: "shared-instructions-only change rejects stale adoption", council: { ...COUNCIL, instructions: "New shared instructions." }, adopted: false, trial: false },
    { name: "member-instructions-only change rejects stale adoption", council: {
      ...COUNCIL,
      members: [{ ...COUNCIL.members[0]!, instructions: "New member instructions." }],
    }, adopted: false, trial: false },
    { name: "trial change rejects stale adoption", council: {
      ...COUNCIL,
      trial: { name: "nova", model: "probe/trial", instructions: "Trial instructions.", enabled: true },
    }, adopted: false, trial: true },
  ];

  it.each(cases)("$name", { timeout: 300_000 }, async ({ council, adopted, trial }) => {
    const provider = await councilProvider(trial);
    const h = councilManager(provider.baseUrl);
    await h.spawn();
    const slot = await h.parked();
    let slotExited = false;
    slot.client.onDeath(() => { slotExited = true; });
    expect(slot.client.armed).toBe(false);
    expect(slot.client.dead).toBe(false);
    h.registry.setSetting("councilRoster", council);
    const { tabId } = await h.spawn();
    const process = h.processFor(tabId);
    expect(h.registry.sessions.find((session) => session.tabId === tabId)?.lineageDir).toBe(slot.dirName);
    expect(h.crumbs.filter((crumb) => crumb.tabId === tabId && crumb.kind.startsWith("warm")).map((crumb) => crumb.kind))
      .toEqual([adopted ? "warm-adopt" : "warm-miss"]);
    if (adopted) {
      expect(process).toBe(slot.client);
      expect(slot.client.armed).toBe(true);
      expect(slot.client.dead).toBe(false);
      expect(slotExited).toBe(false);
    } else {
      expect(process).not.toBe(slot.client);
      expect(slot.client.armed).toBe(false);
      await waitFor(() => slotExited ? true : undefined, 30_000, "the rejected parked process exit edge");
    }
    await waitFor(
      () => h.frames.get(tabId)?.find((frame) => frame.type === "available_commands_update" &&
        Array.isArray(frame.commands) && frame.commands.some((command: { name?: string }) => command.name === COUNCIL_COMMAND)),
      90_000,
      "the managed Council command registration",
    );
    h.manager.rpcSend(tabId, { type: "prompt", id: "warm-council-prompt", message: `/${COUNCIL_COMMAND} warm-council-probe: say ok` });
    const accepted = await waitFor(
      () => h.frames.get(tabId)?.find((frame) => frame.type === "response" && frame.id === "warm-council-prompt"),
      30_000,
      "the managed Council prompt acknowledgement",
    );
    expect(accepted.success, String(accepted.error ?? "")).toBe(true);
    const launch = await waitFor(
      () => h.frames.get(tabId)?.find((frame) => frame.type === "message_start" && frame.message?.customType === COUNCIL_LAUNCH_TYPE),
      60_000,
      "the adopted or cold Council launch",
    );
    const content = JSON.stringify(launch.message?.content);
    expect(content).toContain("alpha");
    expect(content).toContain("probe/member");
    expect(content).toContain(council.instructions);
    expect(content).toContain(council.members[0]!.instructions);
    expect(content.includes("probe/trial")).toBe(trial);
    for (const model of trial ? ["member", "trial"] : ["member"]) {
      const ended = await waitFor(
        () => h.frames.get(tabId)?.find((frame) => frame.type === "tool_execution_end" && frame.toolCallId === `warm_${model}`),
        120_000,
        `the ${model} task outcome after warm adoption decision`,
      );
      expect(ended.isError, JSON.stringify(ended.result ?? null)).toBeFalsy();
      await waitFor(() => provider.models.includes(model) ? true : undefined, 120_000, `the actual ${model} provider completion`);
    }
    expect(h.manager.isLive(tabId)).toBe(true);
  });
});
