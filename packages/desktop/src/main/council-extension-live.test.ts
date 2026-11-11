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
  COUNCIL_TOOL,
  PLAN_STATUS_KEY,
  RpcClient,
  SUBAGENT_MODEL_INHERIT,
  councilRosterSnapshotPath,
  parsePlanStatus,
  planMessage,
  resolveOmpBinary,
  writeAsyncJobsExtension,
  writePlanExtension,
  writeSubagentModelOverlay,
  type CouncilDocument,
} from "@omp-ui/core";
import { ASYNC_JOBS_STATUS_KEY, asyncJobsArmMessage, parseAsyncJobsSnapshot } from "@omp-ui/core/async-jobs";
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
 *   `Per-call model`, so the grant is what makes the first run pass;
 * - with a trial member set, the `omp-ui-council-trial` role grants the trial
 *   model: a second task call pinned to it runs without a preflight error and
 *   the trial model is actually asked (issue #1140);
 * - a trial model no models.yml defines fails only its own call: the council
 *   call still completes, and the session never asks the unknown model;
 * - with omp-ui plan mode on, the planner can call the bridge tool with a plan
 *   artifact, launch the pinned member with `task`, and receive the member's
 *   answer while plan mode stays on (the council plan review).
 *
 * A scripted loopback provider (the async-jobs-live.test.ts pattern) serves
 * every probe model, so no real provider is ever billed: each scripted launch
 * emits `task` calls, every other completion replies `ok` and stops.
 */

const ompPath = resolveOmpBinary();

function requiredOmpPath(): string {
  if (ompPath === null) throw new Error("Live Council proofs require the installed OMP 18.18.7 binary; no live proof may skip.");
  return ompPath;
}

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
      - id: trial
        name: trial
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

/** The second batch the bridge builds when a trial member is set. */
const TRIAL_CALL = {
  index: 1,
  id: "call_trial",
  type: "function",
  function: {
    name: "task",
    arguments: JSON.stringify({
      i: "probe",
      context: "probe",
      tasks: [
        {
          name: "council-nova",
          agent: COUNCIL_AGENT,
          model: "probe/trial",
          task: "Reply ok.",
          solutionSpace: "one fixed answer",
        },
      ],
    }),
  },
};

/** The same second batch pinned to a model no models.yml defines. */
const GHOST_CALL = {
  ...TRIAL_CALL,
  function: {
    ...TRIAL_CALL.function,
    arguments: JSON.stringify({
      i: "probe",
      context: "probe",
      tasks: [
        {
          name: "council-nova",
          agent: COUNCIL_AGENT,
          model: "probe/ghost",
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
  statusKey?: string;
  statusText?: string;
}

interface Scope {
  frames: Frame[];
  lineage: string;
  client: RpcClient;
  exited: Promise<void>;
}

// Real timers throughout: the awaited actor is an OS process, so fake timers
// cannot drive it, and every wait polls an observed frame, never a guessed
// duration.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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

async function scriptedProvider(
  toolCalls: unknown[] = [TASK_CALL],
  launchMarkers: readonly string[] = [],
): Promise<ScriptedProvider> {
  const models: string[] = [];
  const launched = new Set<string>();
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
      let bodyText = "";
      try {
        bodyText = Buffer.concat(parts).toString("utf8");
        const body = JSON.parse(bodyText) as { model?: unknown };
        if (typeof body.model === "string") model = body.model;
      } catch {
        // An unparseable body is recorded as "" and still answered.
      }
      models.push(model);
      const marker = [...launchMarkers].reverse().find((value) => bodyText.includes(value));
      const shouldLaunch = launchMarkers.length === 0
        ? index === 0
        : model === "inert" && marker !== undefined && !launched.has(marker);
      if (shouldLaunch && marker !== undefined) launched.add(marker);
      const calls = marker === undefined ? toolCalls : [{ ...TASK_CALL, id: `${TASK_CALL.id}_${marker}` }];
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        (shouldLaunch
          ? chunk(index, model, { role: "assistant", tool_calls: calls }, null) +
            chunk(index, model, {}, "tool_calls")
          : chunk(index, model, { role: "assistant", content: "ok" }, null) + chunk(index, model, {}, "stop")) +
          "data: [DONE]\n\n",
      );
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback provider port");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    models,
    close: () => {
      return new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

/**
 * The plan-review script: the planner sends the plan to the council once,
 * then runs the launch's task batch once; the member reports no findings.
 */
async function planCouncilProvider(): Promise<ScriptedProvider & { bodies: Array<{ model: string; body: string }> }> {
  const models: string[] = [];
  const bodies: Array<{ model: string; body: string }> = [];
  let councilSent = false;
  let taskSent = false;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      const index = models.length;
      const body = Buffer.concat(parts).toString("utf8");
      let model = "";
      try {
        const parsed = JSON.parse(body) as { model?: unknown };
        if (typeof parsed.model === "string") model = parsed.model;
      } catch {
        // An unparseable body is recorded as "" and still answered.
      }
      models.push(model);
      bodies.push({ model, body });
      let calls: unknown[] | null = null;
      let text = "ok";
      if (model === "inert" && body.includes("PLANCOUNCIL") && !councilSent) {
        councilSent = true;
        calls = [{
          index: 0,
          id: "call_plan_council",
          type: "function",
          function: { name: COUNCIL_TOOL, arguments: JSON.stringify({ plan: "local://probe-plan.md" }) },
        }];
      } else if (model === "inert" && body.includes("to the council; the council has") && !taskSent) {
        taskSent = true;
        calls = [{ ...TASK_CALL, id: "call_plan_task" }];
      } else if (model === "member") {
        text = "no findings.";
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        (calls !== null
          ? chunk(index, model, { role: "assistant", tool_calls: calls }, null) + chunk(index, model, {}, "tool_calls")
          : chunk(index, model, { role: "assistant", content: text }, null) + chunk(index, model, {}, "stop")) +
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
    bodies,
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
function spawnScope(
  baseUrl: string,
  withCouncilOverlay: boolean,
  council: CouncilDocument = COUNCIL,
  observeJobs = false,
  withPlan = false,
): Scope {
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
  git(["-c", "user.email=t@t", "-c", "user.name=t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"]);

  const umbrella = writeSubagentModelOverlay(lineage, { task: SUBAGENT_MODEL_INHERIT });
  if (umbrella === null) throw new Error("the umbrella subagent overlay was not written");
  const prepared = writeCouncilForSpawn(lineage, true, council, null);
  if (prepared.status !== "ready" || prepared.overlayPath === null) {
    throw new Error(`Council preparation failed: ${JSON.stringify(prepared)}`);
  }

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => { markExited = resolve; });
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: requiredOmpPath(),
    model: "probe/inert",
    configOverlays: withCouncilOverlay ? [umbrella, prepared.overlayPath] : [umbrella],
    extensions: [
      prepared.extensionPath,
      ...(observeJobs ? [writeAsyncJobsExtension(lineage)] : []),
      ...(withPlan ? [writePlanExtension(lineage)] : []),
    ],
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
  return { lineage, frames, client, exited };
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

describe("council extension (real omp)", () => {
  it(
    "/council freezes the original member across manifest replacement, corruption, and deletion",
    { timeout: 420_000 },
    async () => {
      const markers = ["frozen-valid", "frozen-invalid", "frozen-deleted"];
      const scripted = await scriptedProvider([TASK_CALL], markers);
      provider = scripted;
      const scope = spawnScope(scripted.baseUrl, true);
      try {
        await councilLoaded(scope);

        const manifest = councilRosterSnapshotPath(scope.lineage);
        for (const [index, marker] of markers.entries()) {
          if (index === 0) {
            fs.writeFileSync(manifest, JSON.stringify({
              version: 2,
              instructions: "Use the replacement instead.",
              members: [{ name: "replacement", model: "probe/trial", instructions: null }],
              trial: null,
              configWarnings: [],
            }));
          } else if (index === 1) {
            fs.writeFileSync(manifest, "{invalid roster");
          } else {
            fs.unlinkSync(manifest);
          }
          const frameStart = scope.frames.length;
          const memberRequests = scripted.models.filter((model) => model === "member").length;
          const prompted = await request(scope, { type: "prompt", message: `/${COUNCIL_COMMAND} ${marker}: say ok` });
          expect(prompted.success, prompted.error).toBe(true);
          const launch = await waitFor(
            () => scope.frames.slice(frameStart).find((f) =>
              f.type === "message_start" && f.message?.customType === COUNCIL_LAUNCH_TYPE),
            60_000,
            `the ${marker} council launch`,
          );
          const content = JSON.stringify(launch.message?.content);
          expect(content).toContain("alpha");
          expect(content).toContain(COUNCIL_AGENT);
          expect(content).toContain(MEMBER_MODEL);
          expect(content).not.toContain("replacement");
          expect(content).not.toContain("probe/trial");
          const ended = await waitFor(
            () => scope.frames.slice(frameStart).find((f) =>
              f.type === "tool_execution_end" && f.toolCallId === `${TASK_CALL.id}_${marker}`),
            120_000,
            `the ${marker} task outcome`,
          );
          const result = JSON.stringify(ended.result ?? null);
          expect(ended.isError, result).toBeFalsy();
          expect(result).not.toContain("Per-call model");
          expect(result).not.toContain("Unknown agent");
          await waitFor(
            () => scripted.models.filter((model) => model === "member").length > memberRequests ? true : undefined,
            120_000,
            `the original member's ${marker} provider request`,
          );
          await waitFor(
            () => scope.frames.slice(frameStart).some((f) => f.type === "agent_end") ? true : undefined,
            60_000,
            `the ${marker} agent turn end`,
          );
        }
        expect(scripted.models).not.toContain("trial");
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

  it(
    "the trial role grants the trial model and both task calls run",
    { timeout: 180_000 },
    async () => {
      const scripted = await scriptedProvider([TASK_CALL, TRIAL_CALL]);
      provider = scripted;
      const scope = spawnScope(scripted.baseUrl, true, {
        ...COUNCIL,
        trial: { name: "nova", model: "probe/trial", instructions: null, enabled: true },
      });
      try {
        await councilLoaded(scope);

        const prompted = await request(scope, { type: "prompt", message: `/${COUNCIL_COMMAND} say ok` });
        expect(prompted.success, prompted.error).toBe(true);
        const launch = await waitFor(
          () => scope.frames.find((f) => f.type === "message_start" && f.message?.customType === COUNCIL_LAUNCH_TYPE),
          60_000,
          "the council launch message in the session",
        );
        expect(JSON.stringify(launch.message?.content)).toContain("probe/trial");

        for (const call of [TASK_CALL, TRIAL_CALL]) {
          const ended = await waitFor(
            () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === call.id),
            120_000,
            `the tool_execution_end for the ${call.id} task call`,
          );
          expect(ended.isError, JSON.stringify(ended.result ?? null)).toBeFalsy();
        }

        await waitFor(
          () => (scripted.models.includes("member") && scripted.models.includes("trial") ? true : undefined),
          120_000,
          "completion requests for the member model and the trial model",
        );
      } finally {
        await stopScope(scope);
      }
    },
  );

  it(
    "an unknown trial model never reaches the provider and never fails the council call",
    { timeout: 180_000 },
    async () => {
      const scripted = await scriptedProvider([TASK_CALL, GHOST_CALL]);
      provider = scripted;
      const scope = spawnScope(scripted.baseUrl, true, {
        ...COUNCIL,
        trial: { name: "nova", model: "probe/ghost", instructions: null, enabled: true },
      }, true);
      try {
        await councilLoaded(scope);
        const armed = await request(scope, { type: "prompt", message: asyncJobsArmMessage() });
        expect(armed.success, armed.error).toBe(true);

        const prompted = await request(scope, { type: "prompt", message: `/${COUNCIL_COMMAND} say ok` });
        expect(prompted.success, prompted.error).toBe(true);

        const ended = await waitFor(
          () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === TASK_CALL.id),
          120_000,
          "the tool_execution_end for the council task call",
        );
        expect(ended.isError, JSON.stringify(ended.result ?? null)).toBeFalsy();
        await waitFor(
          () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === GHOST_CALL.id),
          120_000,
          "the unavailable trial task outcome",
        );
        // task acknowledges background dispatch before model resolution finishes.
        // The terminal job, not that acknowledgement, owns the trial failure.
        const failedTrial = await waitFor(
          () => scope.frames
            .filter((frame) => frame.type === "extension_ui_request" && frame.statusKey === ASYNC_JOBS_STATUS_KEY)
            .flatMap((frame) => parseAsyncJobsSnapshot(frame.statusText)?.recent ?? [])
            .find((job) => job.id === "council-nova" && job.status === "failed"),
          120_000,
          "the trial model resolution failure after background dispatch",
        );
        expect(failedTrial.outputTail).toMatch(/ghost|model/i);

        await waitFor(
          () => (scripted.models.includes("member") ? true : undefined),
          120_000,
          "a completion request for the member model",
        );
        await waitFor(
          () => (scope.frames.some((f) => f.type === "agent_end") ? true : undefined),
          120_000,
          "the agent_end after both task calls settle",
        );
        expect(scripted.models).not.toContain("ghost");
      } finally {
        await stopScope(scope);
      }
    },
  );

  it(
    "a plan-mode planner runs the council plan review and receives the member's answer",
    { timeout: 240_000 },
    async () => {
      const scripted = await planCouncilProvider();
      provider = scripted;
      const scope = spawnScope(scripted.baseUrl, true, COUNCIL, false, true);
      const planStatuses = () =>
        scope.frames
          .filter((f) => f.type === "extension_ui_request" && f.statusKey === PLAN_STATUS_KEY)
          .map((f) => parsePlanStatus(f.statusText));
      try {
        await councilLoaded(scope);
        const armed = await request(scope, { type: "prompt", message: planMessage(true, "md") });
        expect(armed.success, armed.error).toBe(true);
        await waitFor(
          () => (planStatuses().some((s) => s?.enabled === true) ? true : undefined),
          60_000,
          "plan mode on",
        );

        const prompted = await request(scope, { type: "prompt", message: "PLANCOUNCIL review it" });
        expect(prompted.success, prompted.error).toBe(true);

        const council = await waitFor(
          () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === "call_plan_council"),
          120_000,
          "the plan-mode omp-ui_council call outcome",
        );
        // A plan-mode refusal here falsifies the design premise (plan §2).
        expect(council.isError, JSON.stringify(council.result ?? null)).toBeFalsy();

        const launch = await waitFor(
          () => scope.frames.find((f) => f.type === "message_start" && f.message?.customType === COUNCIL_LAUNCH_TYPE),
          60_000,
          "the council plan-review launch",
        );
        const content = JSON.stringify(launch.message?.content);
        expect(content).toContain("wait");
        expect(content).toContain("xd://propose");

        const task = await waitFor(
          () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === "call_plan_task"),
          120_000,
          "the plan-mode task call outcome",
        );
        const result = JSON.stringify(task.result ?? null);
        expect(task.isError, result).toBeFalsy();
        expect(result).not.toContain("Per-call model");
        expect(result).not.toContain("Unknown agent");

        await waitFor(
          () => (scripted.models.includes("member") ? true : undefined),
          120_000,
          "the member's provider request",
        );
        await waitFor(
          () => {
            const firstMember = scripted.bodies.findIndex((b) => b.model === "member");
            return scripted.bodies.slice(firstMember + 1).some((b) => b.model === "inert" && b.body.includes("no findings."))
              ? true
              : undefined;
          },
          120_000,
          "the member's answer reaching the plan-mode planner",
        );
        expect(planStatuses().at(-1)?.enabled).toBe(true);
      } finally {
        await stopScope(scope);
      }
    },
  );
});
