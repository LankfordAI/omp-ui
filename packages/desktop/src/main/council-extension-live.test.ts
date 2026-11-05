import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  COUNCIL_AGENT,
  COUNCIL_COMMAND,
  COUNCIL_LAUNCH_TYPE,
  RpcClient,
  SUBAGENT_MODEL_INHERIT,
  resolveOmpBinary,
  writeCouncilExtension,
  writeSubagentModelOverlay,
  type CouncilDocument,
} from "@omp-ui/core";
import { writeCouncilForSpawn } from "./spawn-config";

/**
 * The Council (ADR-0088, issues #1048/#1049) against the REAL
 * `omp --mode=rpc-ui`, spawned with exactly the artifacts main writes: the
 * umbrella subagent overlay (`task.agentModelOverrides: {task: "*"}`), the
 * council overlay and roster snapshot from `writeCouncilForSpawn`, and the
 * council extension package passed as a `-e` directory root.
 *
 * What it proves end to end:
 * - omp loads the package's declared entry (`/council` reaches
 *   `available_commands_update`) and discovers `agents/omp-ui-council.md`
 *   from the same directory root;
 * - `/council <request>` puts a launch message into the session naming the
 *   dedicated agent and the member's model;
 * - the council overlay's per-call grant lets a `task` call pin the member
 *   model on that agent: no `Per-call model` or `Unknown agent` preflight
 *   error, and the member model is actually asked;
 * - without the council overlay the identical call fails preflight with
 *   `Per-call model`, so the grant is what makes the first run pass.
 *
 * A scripted loopback provider (the async-jobs-live.test.ts pattern) serves
 * both models, so no real provider is ever billed: completion 0 emits the
 * member `task` call, every later completion replies `ok` and stops.
 */

const ompPath = resolveOmpBinary();

/** The member's model: deliberately not the session model, which grants itself. */
const MEMBER_MODEL = "probe/member";

const MODELS_YML = (baseUrl: string): string => `providers:
  probe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
      - id: member
        name: member
        contextWindow: 131072
        maxTokens: 128
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
`;

/** The global council app state would hold; main resolves it at spawn. */
const COUNCIL: CouncilDocument = {
  instructions: null,
  members: [{ name: "alpha", model: MEMBER_MODEL, instructions: null, enabled: true }],
};

/** The call the launch asks for, item by item as the bridge builds it. */
const TASK_CALL = {
  index: 0,
  id: "call_council",
  type: "function",
  function: {
    name: "task",
    arguments: JSON.stringify({
      i: "probe",
      context: "probe",
      tasks: [
        {
          name: "council-alpha",
          agent: COUNCIL_AGENT,
          model: MEMBER_MODEL,
          task: "Reply ok.",
          solutionSpace: "one fixed answer",
        },
      ],
    }),
  },
};

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  message?: { role?: string; customType?: string; content?: unknown };
  commands?: Array<{ name?: string }>;
  toolCallId?: string;
  isError?: boolean;
  result?: unknown;
}

interface Scope {
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

// Real timers throughout: the awaited actor is an OS process, so fake timers
// cannot drive it, and every wait polls an observed frame, never a guessed
// duration.
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number, what: string): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(25);
  }
}

function chunk(index: number, model: string, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: `councilprobe-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

interface ScriptedProvider {
  baseUrl: string;
  /** The `model` field of every completion request, in arrival order. */
  models: string[];
  close(): Promise<void>;
}

async function scriptedProvider(): Promise<ScriptedProvider> {
  const models: string[] = [];
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const index = models.length;
      let model = "";
      try {
        const body = JSON.parse(Buffer.concat(parts).toString("utf8")) as { model?: unknown };
        if (typeof body.model === "string") model = body.model;
      } catch {
        // An unparseable body is recorded as "" and still answered.
      }
      models.push(model);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        (index === 0
          ? chunk(index, model, { role: "assistant", tool_calls: [TASK_CALL] }, null) +
            chunk(index, model, {}, "tool_calls")
          : chunk(index, model, { role: "assistant", content: "ok" }, null) + chunk(index, model, {}, "stop")) +
          "data: [DONE]\n\n",
      );
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once("error", listening.reject);
  server.listen(0, "127.0.0.1", listening.resolve);
  await listening.promise;
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback provider port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models,
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}

const dirs: string[] = [];
let provider: ScriptedProvider | null = null;

afterEach(async () => {
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
  for (const dir of dirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

/**
 * A hermetic HOME, a seeded git checkout, and an omp spawned with the
 * extension package and the umbrella overlay; `withCouncilOverlay` adds the
 * council overlay after it, in main's push order.
 */
function spawnScope(baseUrl: string, withCouncilOverlay: boolean): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-council-live-"));
  dirs.push(base);
  const home = path.join(base, "home");
  const agent = path.join(home, ".omp", "agent");
  fs.mkdirSync(agent, { recursive: true });
  fs.writeFileSync(path.join(agent, "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(agent, "config.yml"), CONFIG_YML);
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "a.txt"), "hello\n");
  const git = (args: string[]): void => {
    execFileSync("git", args, { cwd: project, stdio: "pipe" });
  };
  git(["init", "-q"]);
  git(["add", "a.txt"]);
  git(["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "seed"]);

  const umbrella = writeSubagentModelOverlay(lineage, { task: SUBAGENT_MODEL_INHERIT });
  if (umbrella === null) throw new Error("the umbrella subagent overlay was not written");
  // Always run: it writes the roster snapshot the bridge launches from.
  const council = writeCouncilForSpawn(lineage, COUNCIL, null);
  if (council === null) throw new Error("the council overlay was not written");

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "probe/inert",
    configOverlays: withCouncilOverlay ? [umbrella, council] : [umbrella],
    extensions: [writeCouncilExtension(lineage)],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: { ...extra, ...env } });
      return {
        stdin: proc.stdin,
        stdout: proc.stdout,
        stderr: proc.stderr,
        kill: (signal) => void proc.kill(signal),
        onExit: (cb) => proc.on("exit", (code) => cb(code)),
        onSpawnError: (cb) => proc.on("error", cb),
      };
    },
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: (m) => process.stderr.write(`rpc error: ${m}\n`),
  });
  return { frames, client, exited };
}

async function stopScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
}

let requestSequence = 0;
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  const id = `council-live-${++requestSequence}`;
  scope.client.send({ ...command, id });
  return waitFor(
    () => scope.frames.find((frame) => frame.type === "response" && frame.id === id),
    30_000,
    `the response to ${JSON.stringify(command)}`,
  );
}

/** Boot finished and the council command registered from the package entry. */
async function councilLoaded(scope: Scope): Promise<void> {
  await waitFor(
    () => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
    60_000,
    "omp ready",
  );
  await waitFor(
    () =>
      scope.frames.find(
        (f) => f.type === "available_commands_update" && f.commands?.some((c) => c.name === COUNCIL_COMMAND),
      ),
    90_000,
    "the council command in available_commands_update",
  );
}

describe.skipIf(!ompPath)("council extension (real omp)", () => {
  it(
    "/council launches the dedicated agent and the granted member model runs",
    { timeout: 180_000 },
    async () => {
      const scripted = await scriptedProvider();
      provider = scripted;
      const scope = spawnScope(scripted.baseUrl, true);
      try {
        await councilLoaded(scope);

        const prompted = await request(scope, { type: "prompt", message: `/${COUNCIL_COMMAND} say ok` });
        expect(prompted.success, prompted.error).toBe(true);
        const launch = await waitFor(
          () => scope.frames.find((f) => f.type === "message_start" && f.message?.customType === COUNCIL_LAUNCH_TYPE),
          60_000,
          "the council launch message in the session",
        );
        const content = JSON.stringify(launch.message?.content);
        expect(content).toContain(COUNCIL_AGENT);
        expect(content).toContain(MEMBER_MODEL);

        const ended = await waitFor(
          () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === TASK_CALL.id),
          120_000,
          "the tool_execution_end for the council task call",
        );
        const result = JSON.stringify(ended.result ?? null);
        expect(ended.isError, result).toBeFalsy();
        expect(result).not.toContain("Per-call model");
        expect(result).not.toContain("Unknown agent");

        await waitFor(
          () => (scripted.models.includes("member") ? true : undefined),
          120_000,
          "a completion request for the member model",
        );
      } finally {
        await stopScope(scope);
      }
    },
  );

  it(
    "without the council overlay the same per-call model fails preflight",
    { timeout: 180_000 },
    async () => {
      const scripted = await scriptedProvider();
      provider = scripted;
      const scope = spawnScope(scripted.baseUrl, false);
      try {
        await councilLoaded(scope);

        const prompted = await request(scope, { type: "prompt", message: "go" });
        expect(prompted.success, prompted.error).toBe(true);

        const ended = await waitFor(
          () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === TASK_CALL.id),
          120_000,
          "the tool_execution_end for the council task call",
        );
        const result = JSON.stringify(ended.result ?? null);
        expect(ended.isError, result).toBe(true);
        expect(result).toContain("Per-call model");

        await waitFor(
          () => (scope.frames.some((f) => f.type === "agent_end") ? true : undefined),
          60_000,
          "the agent_end after the failed task call",
        );
        expect(scripted.models).not.toContain("member");
      } finally {
        await stopScope(scope);
      }
    },
  );
});
