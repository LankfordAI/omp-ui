import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  RpcClient,
  SUBAGENT_MODEL_INHERIT,
  compareVersions,
  readInstalledOmpVersion,
  resolveOmpBinary,
  writeAsyncJobsExtension,
  writeSessionSpendExtension,
  writeSubagentModelOverlay,
} from "@omp-ui/core";
import {
  ASYNC_JOBS_STATUS_KEY,
  asyncJobsArmMessage,
  asyncJobsKillMessage,
  buildAsyncJobRows,
  parseAsyncJobsSnapshot,
  type AsyncJob,
  type AsyncJobsKillResult,
  type AsyncJobsSnapshot,
} from "@omp-ui/core/async-jobs";
import {
  SESSION_SPEND_STATUS_KEY,
  parseSessionSpendSnapshot,
  sessionSpendArmMessage,
  type SessionSpendSnapshot,
  type SpendTotals,
} from "@omp-ui/core/session-spend";

/**
 * The bridges across omp 18.17's worker-thread subagents (issue #1070),
 * against the REAL `omp --mode=rpc-ui`. omp runs up to 8 concurrent
 * subagents on the main thread; at 9 one worker joins (the managed binary's
 * own `task.workerThreads` description). The async-jobs, session-spend, and
 * subagent-frame surfaces all hook main-thread session internals, so this
 * test drives one 10-way `task` fan-out twice from one scripted loopback
 * provider (no real provider is billed):
 *
 * - the worker arm: omp's default `task.workerThreads` (4);
 * - the control arm: the same scenario with `task.workerThreads: 0`, every
 *   subagent on the main thread.
 *
 * Every subagent starts one async `sleep` bash job, then its next completion
 * is held open so all ten stay live. A probe `-e` extension notes
 * `isMainThread` per session prompt: it is the placement oracle that proves
 * the worker arm really hosted subagents off the main thread and the control
 * arm did not, so neither arm can pass vacuously.
 *
 * Each arm asserts the bridges see every subagent's jobs, the `/jobs` tree
 * layout, the roster, spend, frames, and cancel + settle of the
 * worker-hosted subagents; then the two arms' normalized bridge output must
 * be equal. What omp/18.17.0 showed when this was written:
 * - the -e factories run once per session, and worker-hosted sessions run
 *   them inside the worker with that thread's own module state; only the
 *   main-thread root instance ever publishes, and the job manager a worker
 *   session registers into is a proxy to the main thread's, so the root's
 *   getAsyncJobTree already lists worker-owned jobs;
 * - a kill aimed at a subagent's own bash job SUCCEEDS in BOTH arms through
 *   the bridge's owner-scoped cancel (issue #1077): it cancels exactly that one
 *   job, and the owning task row keeps running until its own kill. Cancelling
 *   the owning task job still reaps whatever nested jobs remain. The test
 *   compares the nested result across arms after normalizing the racing bg id;
 * - `bg_N` ids and the order of one subagent's events race in BOTH arms, so
 *   the comparison keys bash jobs by owner and compares event-type sets.
 *
 * Skips without an omp binary, and below omp 18.17.0, where worker-thread
 * subagents landed.
 */

const ompPath = resolveOmpBinary();
/** The first omp that hosts subagents on worker threads. */
const WORKER_THREADS_FLOOR = "18.17.0";
/** Past the 9-subagent worker threshold, so at least one subagent is worker-hosted. */
const FANOUT = 10;
const ROOT_PROMPT = "ROOT-FANOUT";
const AGENT_MARK = "PROBE-AGENT-";

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
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
`;

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: { subagents?: Array<{ id?: unknown; agent?: unknown; status?: unknown }> };
  statusKey?: string;
  statusText?: string;
  payload?: { id?: unknown; status?: unknown; event?: { type?: unknown } };
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
  placementLog: string;
}

/** One normalized arm: everything the cross-arm comparison reads. */
interface Arm {
  workerHosted: string[];
  busy: unknown;
  rows: string[];
  roster: unknown;
  spend: unknown;
  nestedKill: AsyncJobsKillResult;
  taskKills: AsyncJobsKillResult[];
  allKill: AsyncJobsKillResult;
  lifecycle: Record<string, string[]>;
  events: Record<string, string[]>;
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
    await sleep(50);
  }
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: "workersprobe",
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

/** The root's one batch `task` call: FANOUT subagents, `ProbeK` ids. */
const TASK_CALL = {
  index: 0,
  id: "call_fanout",
  type: "function",
  function: {
    name: "task",
    arguments: JSON.stringify({
      i: "fan out",
      context: "Live worker-thread probe.",
      tasks: Array.from({ length: FANOUT }, (_, k) => ({
        name: `Probe${k}`,
        agent: "task",
        task: `${AGENT_MARK}${k}: start your background job.`,
        solutionSpace: "one fixed action",
      })),
    }),
  },
};

/** Subagent K's async bash call; the distinct sleep keeps every command unique. */
function bashCall(k: number): Record<string, unknown> {
  return {
    index: 0,
    id: `call_bash_${k}`,
    type: "function",
    function: {
      name: "bash",
      arguments: JSON.stringify({ command: `sleep ${6000 + k}`, async: true, i: "hold a background job" }),
    },
  };
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

interface ScriptedProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Routes on the opening (pre-assistant) messages of each completion:
 * - a subagent's first completion starts its async bash job;
 * - a subagent's later completion streams one word and is held open, so
 *   every subagent stays live until the bridge cancels it;
 * - the root's first completion emits the fan-out `task` call;
 * - anything else (the root's post-tool turn) answers `ok` and stops.
 */
async function scriptedProvider(): Promise<ScriptedProvider> {
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const parts: Buffer[] = [];
    request.on("data", (part: Buffer) => parts.push(part));
    request.on("end", () => {
      let messages: unknown[] = [];
      try {
        const body: unknown = JSON.parse(Buffer.concat(parts).toString("utf8"));
        if (body !== null && typeof body === "object" && "messages" in body && Array.isArray(body.messages)) {
          messages = body.messages;
        }
      } catch {
        // An unparseable body is answered like any non-probe completion.
      }
      const firstAssistant = messages.findIndex(
        (message) =>
          message !== null && typeof message === "object" && "role" in message && message.role === "assistant",
      );
      const opening = (firstAssistant < 0 ? messages : messages.slice(0, firstAssistant))
        .map((message) =>
          message !== null && typeof message === "object" && "content" in message ? messageText(message.content) : "",
        )
        .join("\n");
      const agent = new RegExp(`${AGENT_MARK}(\\d+)`).exec(opening);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (agent !== null && firstAssistant >= 0) {
        response.write(chunk({ role: "assistant", content: "working" }, null));
        return;
      }
      if (agent !== null) {
        response.end(
          chunk({ role: "assistant", tool_calls: [bashCall(Number(agent[1]))] }, null) +
            chunk({}, "tool_calls") +
            "data: [DONE]\n\n",
        );
        return;
      }
      if (firstAssistant < 0 && opening.includes(ROOT_PROMPT)) {
        response.end(
          chunk({ role: "assistant", tool_calls: [TASK_CALL] }, null) + chunk({}, "tool_calls") + "data: [DONE]\n\n",
        );
        return;
      }
      response.end(chunk({ role: "assistant", content: "ok" }, null) + chunk({}, "stop") + "data: [DONE]\n\n");
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
    close: () => {
      const closed = Promise.withResolvers<void>();
      server.closeAllConnections();
      server.close((error) => (error ? closed.reject(error) : closed.resolve()));
      return closed.promise;
    },
  };
}

/**
 * The placement oracle: one JSON line per AgentSession.prompt with the
 * thread it ran on and the session's own file. omp runs -e factories once
 * per session, inside whichever thread hosts that session.
 */
const PLACEMENT_EXTENSION = (logFile: string): string => `import * as nodeFs from "node:fs";
import { isMainThread } from "node:worker_threads";
const LOG = ${JSON.stringify(logFile)};
interface ProbeSession {
  sessionManager?: { getSessionFile?: () => unknown };
  getAsyncJobTree?: (options: { recentLimit: number }) => unknown;
}
export default function (pi: {
  pi?: { AgentSession?: { prototype?: Record<string, unknown> } };
  registerCommand: (name: string, command: { handler: () => void }) => void;
}) {
  let root: ProbeSession | undefined;
  pi.registerCommand("omp-ui-worker-terminal-jobs", {
    handler: () => {
      if (root?.getAsyncJobTree === undefined) throw new Error("worker job oracle has no root");
      nodeFs.writeFileSync(LOG + ".jobs", JSON.stringify(root.getAsyncJobTree({ recentLimit: ${FANOUT * 2} })));
    },
  });
  const prototype = pi.pi?.AgentSession?.prototype;
  const original = prototype?.prompt;
  if (prototype === undefined || typeof original !== "function") return;
  const call = original as (this: unknown, ...args: unknown[]) => unknown;
  prototype.prompt = function (this: ProbeSession, ...args: unknown[]): unknown {
    root ??= this;
    try {
      const file = this.sessionManager?.getSessionFile?.() ?? null;
      nodeFs.appendFileSync(LOG, JSON.stringify({ main: isMainThread, file }) + "\\n");
    } catch {
      /* a probe write never breaks the session */
    }
    return call.apply(this, args);
  };
}
`;

/** Preserve the runtime environment, but never let a caller select real user config. */
function workerEnvironment(home: string, inherited: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  for (const key of ["HOMEDRIVE", "HOMEPATH", "OMP_PROFILE", "PI_PROFILE", "PI_CONFIG_DIR", "PI_CODING_AGENT_DIR"]) {
    delete env[key];
  }
  return env;
}

function spawnScope(baseUrl: string, mainThreadOnly: boolean): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-workers-live-"));
  const home = path.join(base, "home");
  const agentDir = path.join(home, ".omp", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(agentDir, "config.yml"), CONFIG_YML);
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });

  // The umbrella overlay main writes for inherit-by-default: subagents run
  // the session model, so every completion reaches the loopback provider.
  const umbrella = writeSubagentModelOverlay(lineage, { task: SUBAGENT_MODEL_INHERIT });
  if (umbrella === null) throw new Error("the umbrella subagent overlay was not written");
  const overlays = [umbrella];
  if (mainThreadOnly) {
    const pin = path.join(lineage, "omp-ui-worker-threads.yml");
    fs.writeFileSync(pin, "task:\n  workerThreads: 0\n");
    overlays.push(pin);
  }
  const placementLog = path.join(base, "placement.jsonl");
  const placement = path.join(lineage, "omp-ui-placement-probe.ts");
  fs.writeFileSync(placement, PLACEMENT_EXTENSION(placementLog));

  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "probe/inert",
    configOverlays: overlays,
    extensions: [writeAsyncJobsExtension(lineage), writeSessionSpendExtension(lineage), placement],
    spawnProcess: (bin, args, extra) => {
      // RpcClient's extra environment already includes the caller's profile
      // overrides: strip them after that merge, not before it.
      const proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"], env: workerEnvironment(home, extra) });
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
  return { base, frames, client, exited, placementLog };
}

async function stopScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let requestSequence = 0;
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  const id = `workers-live-${++requestSequence}`;
  scope.client.send({ ...command, id });
  return waitFor(
    () => scope.frames.find((frame) => frame.type === "response" && frame.id === id),
    30_000,
    `the response to ${String(command.type)}`,
  );
}

/** The newest parsed snapshot published on `key` at or after frame `from`. */
function latest<T>(scope: Scope, key: string, parse: (text: string | undefined) => T | null, from = 0): T | undefined {
  for (let i = scope.frames.length - 1; i >= from; i--) {
    const frame = scope.frames[i]!;
    if (frame.type !== "extension_ui_request" || frame.statusKey !== key) continue;
    const parsed = parse(frame.statusText);
    if (parsed !== null) return parsed;
  }
  return undefined;
}

async function kill(
  scope: Scope,
  processKey: string,
  requestId: string,
  job: AsyncJob | null,
): Promise<AsyncJobsSnapshot> {
  const from = scope.frames.length;
  scope.client.send({
    type: "prompt",
    message: asyncJobsKillMessage({ requestId, processKey, jobId: job?.id ?? null, startTime: job?.startTime ?? null }),
  });
  return waitFor(
    () => {
      for (let i = from; i < scope.frames.length; i++) {
        const frame = scope.frames[i]!;
        if (frame.type !== "extension_ui_request" || frame.statusKey !== ASYNC_JOBS_STATUS_KEY) continue;
        const snapshot = parseAsyncJobsSnapshot(frame.statusText);
        if (snapshot?.result?.requestId === requestId) return snapshot;
      }
      return undefined;
    },
    30_000,
    `the result of kill ${requestId}`,
  );
}

/** The kill result with its cancelled ids sorted: running-list order is not a contract. */
function killResult(snapshot: AsyncJobsSnapshot): AsyncJobsKillResult {
  const result = snapshot.result!;
  return { ...result, cancelled: [...result.cancelled].sort() };
}

/**
 * A job's stable identity: a bash job is `bash:<owner>`, because omp hands
 * out `bg_N` in registration order and ten concurrent subagents race for it
 * on either thread layout (observed on omp/18.17.0 in both arms).
 */
function jobKey(job: AsyncJob): string {
  return job.type === "bash" ? `bash:${job.ownerId}` : job.id;
}

/** Placement-independent job fields; the scope's temp root becomes `<scope>`. */
function normalizeJob(job: AsyncJob, base: string): Record<string, unknown> {
  return {
    key: jobKey(job),
    type: job.type,
    status: job.status,
    label: job.label,
    intent: job.intent,
    caption: job.caption,
    command: job.command,
    cwd: job.cwd === null ? null : job.cwd.replace(base, "<scope>"),
    agentId: job.agentId,
    ownerId: job.ownerId,
    exitCode: job.exitCode,
    widget: job.widget,
    completionPercent: job.completionPercent,
    stage: job.stage,
  };
}

/** `child@depth<parent` per row: the tree shape, independent of sibling start order. */
function rowShape(snapshot: AsyncJobsSnapshot): string[] {
  const rows = buildAsyncJobRows(snapshot.running, snapshot.recent, snapshot.agents, snapshot.rootId);
  const parents: string[] = [];
  return rows
    .map(({ job, depth }) => {
      parents[depth] = jobKey(job);
      return `${jobKey(job)}@${depth}<${depth === 0 ? "root" : parents[depth - 1]}`;
    })
    .sort();
}

/** Thread placement per subagent id, from the oracle log. */
function placementOf(scope: Scope): Map<string, boolean> {
  const placed = new Map<string, boolean>();
  if (!fs.existsSync(scope.placementLog)) return placed;
  for (const line of fs.readFileSync(scope.placementLog, "utf8").split("\n")) {
    if (line === "") continue;
    const entry: unknown = JSON.parse(line);
    if (entry === null || typeof entry !== "object" || !("file" in entry) || !("main" in entry)) continue;
    if (typeof entry.file !== "string" || typeof entry.main !== "boolean") continue;
    const id = path.basename(entry.file, ".jsonl");
    if (/^Probe\d+$/.test(id)) placed.set(id, (placed.get(id) ?? true) && entry.main);
  }
  return placed;
}

const AGENT_IDS = Array.from({ length: FANOUT }, (_, k) => `Probe${k}`);

/**
 * One arm end to end. `targets` are the subagents whose cancel and settle the
 * arm proves individually: the worker arm passes null and targets the
 * subagents the oracle saw off the main thread; the control arm targets the
 * same ids, all of which then run on main.
 */
async function runArm(baseUrl: string, mainThreadOnly: boolean, targets: string[] | null): Promise<Arm> {
  const scope = spawnScope(baseUrl, mainThreadOnly);
  try {
    await waitFor(() => (scope.frames.some((f) => f.type === "ready") ? true : undefined), 60_000, "omp ready");
    // "events" is the Agents detail-view level: it streams subagent_event frames.
    const subscribed = await request(scope, { type: "set_subagent_subscription", level: "events" });
    expect(subscribed.success, subscribed.error).toBe(true);
    const armFrom = scope.frames.length;
    expect((await request(scope, { type: "prompt", message: asyncJobsArmMessage() })).success).toBe(true);
    expect((await request(scope, { type: "prompt", message: sessionSpendArmMessage() })).success).toBe(true);
    const armed = await waitFor(
      () => latest(scope, ASYNC_JOBS_STATUS_KEY, parseAsyncJobsSnapshot, armFrom),
      30_000,
      "the jobs arm publish",
    );
    expect(armed.available, `jobs bridge unavailable: ${armed.unavailable}`).toBe(true);
    expect(armed.canCancel).toBe(true);
    expect(armed.rootId).toBeTypeOf("string");
    const rootId = armed.rootId!;

    scope.client.send({ type: "prompt", message: ROOT_PROMPT });

    // 1. Enumerate: every subagent's task job and its own bash job are live
    // on the root's tree, whichever thread hosts the subagent.
    const busy = await waitFor(
      () => {
        const snapshot = latest(scope, ASYNC_JOBS_STATUS_KEY, parseAsyncJobsSnapshot, armFrom);
        if (snapshot === undefined) return undefined;
        const tasks = snapshot.running.filter((job) => job.type === "task");
        const bashes = snapshot.running.filter((job) => job.type === "bash");
        return tasks.length === FANOUT && bashes.length === FANOUT ? snapshot : undefined;
      },
      180_000,
      `${FANOUT} running task jobs and ${FANOUT} running bash jobs`,
    );
    const tasks = busy.running.filter((job) => job.type === "task");
    const bashes = busy.running.filter((job) => job.type === "bash");
    expect(tasks.map((job) => job.id).sort()).toEqual([...AGENT_IDS].sort());
    for (const job of tasks) {
      expect(job.agentId).toBe(job.id);
      expect(job.ownerId).toBe(rootId);
    }
    expect(bashes.map((job) => job.ownerId).sort()).toEqual([...AGENT_IDS].sort());
    const bashOf = new Map(bashes.map((job) => [job.ownerId!, job]));
    expect([...busy.agents].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...AGENT_IDS].sort().map((id) => ({ id, parentId: rootId })),
    );
    // The /jobs port nests each subagent's bash job one level under its task row.
    const rows = rowShape(busy);
    expect(rows).toEqual(
      [...AGENT_IDS.map((id) => `${id}@0<root`), ...AGENT_IDS.map((id) => `bash:${id}@1<${id}`)].sort(),
    );

    // 2. Placement: the worker arm really hosted subagents off the main
    // thread; the control arm hosted none there.
    const placed = await waitFor(
      () => {
        const map = placementOf(scope);
        return AGENT_IDS.every((id) => map.has(id)) ? map : undefined;
      },
      30_000,
      "a placement record for every subagent",
    );
    const workerHosted = AGENT_IDS.filter((id) => placed.get(id) === false);
    if (!mainThreadOnly) expect(workerHosted.length, "no subagent ran off the main thread").toBeGreaterThan(0);
    console.info(
      `[#1070] task.workerThreads ${mainThreadOnly ? "0" : "default"}: ${workerHosted.length}/${FANOUT} subagents worker-hosted` +
        (workerHosted.length === 0 ? "" : ` (${workerHosted.join(", ")})`),
    );

    // 3. Spend: every subagent transcript counts, worker-hosted ones included.
    const spend = await waitFor(
      () => {
        const snapshot = latest(scope, SESSION_SPEND_STATUS_KEY, parseSessionSpendSnapshot, armFrom);
        return snapshot !== undefined && snapshot.transcripts === FANOUT && snapshot.subagents.requests === FANOUT
          ? snapshot
          : undefined;
      },
      60_000,
      `spend over ${FANOUT} subagent transcripts`,
    );
    expect(spend.available, `spend bridge unavailable: ${spend.unavailable}`).toBe(true);
    const artifactsDir = spend.sessionFile!.slice(0, -".jsonl".length);
    for (const id of workerHosted) {
      const transcript = fs.readFileSync(path.join(artifactsDir, `${id}.jsonl`), "utf8");
      expect(transcript, `worker-hosted ${id} wrote no counted usage`).toContain('"usage"');
    }

    // 4. Roster and frames: every subagent is on get_subagents and streamed
    // its lifecycle start plus at least one event.
    const roster = (await request(scope, { type: "get_subagents" })).data?.subagents ?? [];
    const rosterRows = roster
      .map((row) => ({ id: row.id, agent: row.agent, status: row.status }))
      .sort((a, b) => String(a.id).localeCompare(String(b.id)));
    expect(rosterRows).toEqual([...AGENT_IDS].sort().map((id) => ({ id, agent: "task", status: "running" })));
    const framesOf = (id: string, type: string): Frame[] =>
      scope.frames.filter((frame) => frame.type === type && frame.payload?.id === id);
    for (const id of AGENT_IDS) {
      expect(framesOf(id, "subagent_lifecycle").map((f) => f.payload?.status)).toEqual(["started"]);
      expect(framesOf(id, "subagent_event").length, `${id} streamed no subagent_event`).toBeGreaterThan(0);
    }

    // 5. Cancel and settle (issue #1077). A kill aimed straight at a
    // subagent's own bash job cancels exactly that one job through the
    // bridge's owner-scoped route: the owning task row is still running when
    // the result lands, and its own kill reaps what remains. bg ids race
    // across arms, so cancelled ids normalize to `bash:<owner>`.
    const chosen = targets ?? workerHosted;
    const processKey = busy.processKey;
    const bashOwner = new Map(bashes.map((job) => [job.id, job.ownerId!]));
    const normalizeCancelled = (result: AsyncJobsKillResult): string[] =>
      [...result.cancelled].map((id) => (bashOwner.has(id) ? `bash:${bashOwner.get(id)}` : id)).sort();
    const nestedTarget = bashOf.get(chosen[0]!)!;
    const nestedAnswered = await kill(scope, processKey, "nested", nestedTarget);
    const nestedRaw = killResult(nestedAnswered);
    expect(nestedRaw.ok, `nested kill failed: ${nestedRaw.text}`).toBe(true);
    expect(normalizeCancelled(nestedRaw)).toEqual([`bash:${chosen[0]}`]);
    // The owner-directed kill must never take the owning task with it.
    expect(
      nestedAnswered.running.some((job) => job.id === chosen[0]),
      "the owning task job died with its nested bash job",
    ).toBe(true);
    const nestedKill = { ...nestedRaw, cancelled: normalizeCancelled(nestedRaw), text: nestedRaw.text.replaceAll(nestedTarget.id, "<bash job>") };
    const taskKills: AsyncJobsKillResult[] = [];
    for (const id of chosen) {
      const answered = await kill(scope, processKey, `task-${id}`, tasks.find((job) => job.id === id)!);
      const result = killResult(answered);
      expect(result.ok, result.text).toBe(true);
      expect(result.cancelled).toEqual([id]);
      taskKills.push(result);
      const settledIds = [id, bashOf.get(id)!.id];
      await waitFor(
        () => {
          const snapshot = latest(scope, ASYNC_JOBS_STATUS_KEY, parseAsyncJobsSnapshot);
          if (snapshot === undefined) return undefined;
          const recent = snapshot.recent.filter((job) => settledIds.includes(job.id));
          return recent.length === 2 &&
            recent.every((job) => job.status === "cancelled") &&
            !snapshot.running.some((job) => settledIds.includes(job.id))
            ? recent
            : undefined;
        },
        60_000,
        `${id} and its bash job settled as cancelled`,
      );
    }
    const allKillRaw = killResult(await kill(scope, processKey, "all", null));
    expect(allKillRaw.ok, allKillRaw.text).toBe(true);
    // Kill-all now cancels every running row on its own — each still-running
    // subagent's task AND its bash job report their own cancellation, children
    // before owners (issue #1077).
    const remaining = AGENT_IDS.filter((id) => !chosen.includes(id));
    expect(normalizeCancelled(allKillRaw)).toEqual(remaining.flatMap((id) => [id, `bash:${id}`]).sort());
    const allKill = { ...allKillRaw, cancelled: normalizeCancelled(allKillRaw) };
    const settled = await waitFor(
      () => {
        const snapshot = latest(scope, ASYNC_JOBS_STATUS_KEY, parseAsyncJobsSnapshot);
        return snapshot !== undefined && snapshot.running.length === 0 ? snapshot : undefined;
      },
      60_000,
      "no running jobs after kill all",
    );
    expect(settled.recent.filter((job) => job.status !== "cancelled")).toEqual([]);
    // OMP sorts recent jobs by startTime, not endTime, before taking ten.
    // Verify every original terminal status via the same public tree API
    // with a fixture-only larger read; production bridge retention stays ten.
    await request(scope, { type: "prompt", message: "/omp-ui-worker-terminal-jobs" });
    const terminal = JSON.parse(fs.readFileSync(`${scope.placementLog}.jobs`, "utf8")) as {
      running: Array<{ id: string; status: string }>;
      recent: Array<{ id: string; status: string }>;
    };
    expect(terminal.running).toEqual([]);
    expect(terminal.recent.map(({ id, status }) => ({ id, status })).sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      busy.running.map(({ id }) => ({ id, status: "cancelled" })).sort((a, b) => a.id.localeCompare(b.id)),
    );
    await waitFor(
      () => (AGENT_IDS.every((id) => framesOf(id, "subagent_lifecycle").length === 2) ? true : undefined),
      60_000,
      "a closing lifecycle frame for every subagent",
    );
    // The old snapshot alone cannot prove polling survived cancellation. Add
    // a separate valid transcript only after settlement, then require a NEW
    // spend frame and the exact usage delta; do not re-arm the bridge.
    const beforeProbe = latest(scope, SESSION_SPEND_STATUS_KEY, parseSessionSpendSnapshot)!;
    expect(beforeProbe.transcripts).toBe(FANOUT);
    expect(beforeProbe.subagents.totalTokens).toBe(spend.subagents.totalTokens);
    const addedSpend: SpendTotals = {
      cost: 0.125,
      input: 17,
      output: 7,
      reasoning: 3,
      cacheRead: 5,
      cacheWrite: 2,
      totalTokens: 31,
      premiumRequests: 1,
      requests: 1,
    };
    const timestamp = "2026-01-01T00:00:00.000Z";
    const spendProbeFrom = scope.frames.length;
    const spendProbeFile = path.join(artifactsDir, "PostCancelSpend.jsonl");
    fs.writeFileSync(
      spendProbeFile,
      `${JSON.stringify({
        type: "session",
        version: 3,
        id: "post-cancel-spend",
        timestamp,
        cwd: path.join(scope.base, "proj"),
      })}\n`,
      { flag: "wx" },
    );
    // First observe the new header, so the baseline has polled all settled
    // transcripts too (aborted turns may persist zero-token usage records).
    const probeBaseline = await waitFor(
      () => {
        const snapshot = latest(scope, SESSION_SPEND_STATUS_KEY, parseSessionSpendSnapshot, spendProbeFrom);
        return snapshot !== undefined && snapshot.revision > beforeProbe.revision && snapshot.transcripts === FANOUT + 1
          ? snapshot
          : undefined;
      },
      60_000,
      "a new spend frame discovering the post-cancellation transcript",
    );
    expect(probeBaseline.subagents.totalTokens).toBe(spend.subagents.totalTokens);
    const spendUsageFrom = scope.frames.length;
    fs.appendFileSync(
      spendProbeFile,
      `${JSON.stringify({
        type: "message",
        id: "post-cancel-usage",
        parentId: null,
        timestamp,
        message: {
          role: "assistant",
          content: [],
          usage: {
            input: addedSpend.input,
            output: addedSpend.output,
            cacheRead: addedSpend.cacheRead,
            cacheWrite: addedSpend.cacheWrite,
            totalTokens: addedSpend.totalTokens,
            reasoningTokens: addedSpend.reasoning,
            premiumRequests: addedSpend.premiumRequests,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: addedSpend.cost },
          },
        },
      })}\n`,
    );
    const spendAfter = await waitFor(
      () => {
        const snapshot = latest(scope, SESSION_SPEND_STATUS_KEY, parseSessionSpendSnapshot, spendUsageFrom);
        return snapshot !== undefined &&
          snapshot.revision > probeBaseline.revision &&
          snapshot.transcripts === FANOUT + 1 &&
          snapshot.subagents.requests === probeBaseline.subagents.requests + addedSpend.requests
          ? snapshot
          : undefined;
      },
      60_000,
      "a new spend frame counting the post-cancellation transcript and usage",
    );
    expect(spendAfter.available, `spend bridge unavailable after cancellation: ${spendAfter.unavailable}`).toBe(true);
    expect(spendAfter.sessionFile).toBe(spend.sessionFile);
    for (const key of Object.keys(addedSpend) as Array<keyof SpendTotals>) {
      expect(spendAfter.subagents[key] - probeBaseline.subagents[key], `post-cancellation ${key} delta`).toBe(addedSpend[key]);
      expect(spendAfter.total[key]).toBe(spendAfter.main[key] + spendAfter.subagents[key]);
    }

    // Per subagent: its lifecycle in order, and the set of event types it
    // streamed. Event ORDER is not compared: a bash job's
    // tool_execution_update races the subagent's next turn stream on the main
    // thread too (observed on omp/18.17.0 for a main-hosted subagent).
    const events: Record<string, string[]> = {};
    const lifecycle: Record<string, string[]> = {};
    for (const id of AGENT_IDS) {
      lifecycle[id] = framesOf(id, "subagent_lifecycle").map((f) => String(f.payload?.status));
      events[id] = [...new Set(framesOf(id, "subagent_event").map((f) => String(f.payload?.event?.type)))].sort();
    }
    const sorted = busy.running.map((job) => normalizeJob(job, scope.base)).sort((a, b) =>
      String(a.key).localeCompare(String(b.key)),
    );
    return {
      workerHosted,
      busy: {
        available: busy.available,
        unavailable: busy.unavailable,
        canInspect: busy.canInspect,
        canCancel: busy.canCancel,
        rootId: busy.rootId,
        agents: [...busy.agents].sort((a, b) => a.id.localeCompare(b.id)),
        running: sorted,
      },
      rows,
      roster: rosterRows,
      spend: { subagents: spend.subagents, transcripts: spend.transcripts } satisfies Partial<SessionSpendSnapshot>,
      nestedKill,
      taskKills,
      allKill,
      lifecycle,
      events,
    };
  } finally {
    await stopScope(scope);
  }
}

let provider: ScriptedProvider | null = null;
afterEach(async () => {
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
});

describe("worker live-test environment", () => {
  it("pins both home variables and clears profile overrides after inheriting the runtime environment", () => {
    const home = path.resolve("fixture-home");
    const inherited = {
      HOME: path.resolve("real-home"),
      USERPROFILE: path.resolve("real-home"),
      HOMEDRIVE: "Z:",
      HOMEPATH: "\\real-home",
      OMP_PROFILE: "work",
      PI_PROFILE: "legacy",
      PI_CONFIG_DIR: ".custom-omp",
      PI_CODING_AGENT_DIR: path.resolve("real-agent"),
      XDG_CONFIG_HOME: path.resolve("real-config"),
      XDG_DATA_HOME: path.resolve("real-data"),
      PATH: path.resolve("runtime", "bin"),
    };
    expect(workerEnvironment(home, inherited)).toEqual({
      HOME: home,
      USERPROFILE: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
      PATH: inherited.PATH,
    });
    expect(inherited.OMP_PROFILE).toBe("work");
  });
});

describe.skipIf(ompPath === null)("bridges across worker-thread subagents (real omp)", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });

  it(
    "a 10-way fan-out yields the same jobs tree, cancels, spend, and frames on workers as on main",
    { timeout: 420_000 },
    async (ctx) => {
      if (version === null || compareVersions(version, WORKER_THREADS_FLOOR) < 0) {
        ctx.skip(`omp ${version ?? "unknown"} predates worker-thread subagents (${WORKER_THREADS_FLOOR})`);
      }
      provider = await scriptedProvider();
      const workers = await runArm(provider.baseUrl, false, null);
      expect(workers.workerHosted.length, "no subagent ran off the main thread").toBeGreaterThan(0);
      const main = await runArm(provider.baseUrl, true, workers.workerHosted);
      expect(main.workerHosted, "task.workerThreads: 0 still placed subagents on a worker").toEqual([]);

      const { workerHosted: _workers, ...workerOutput } = workers;
      const { workerHosted: _main, ...mainOutput } = main;
      expect(workerOutput).toEqual(mainOutput);
    },
  );
});
