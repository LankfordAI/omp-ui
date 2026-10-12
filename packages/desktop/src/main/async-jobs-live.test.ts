import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer, type ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, writeAsyncJobsExtension } from "@omp-ui/core";
import {
  ASYNC_JOBS_STATUS_KEY,
  asyncJobsArmMessage,
  asyncJobsKillMessage,
  parseAsyncJobsSnapshot,
  type AsyncJobsSnapshot,
} from "@omp-ui/core/async-jobs";

/**
 * Live drift guard for the background-jobs bridge (issue #835, ADR-0054)
 * against the REAL `omp --mode=rpc-ui` binary — the same skip-when-no-binary
 * discipline as limits-live.test.ts, with the controlled SSE provider of
 * magic-keywords-live.test.ts so no real provider is ever billed.
 *
 * The scripted provider's first completion emits one async bash tool call
 * (`sleep 30`, `async: true`); the second writes only its role delta and is
 * held open, so the agent is mid-turn while the job runs. What the test
 * proves end to end: the arm publishes a parseable snapshot; the job appears
 * running with its command; a kill prompt rides the hidden slash command
 * WITHOUT streamingBehavior while the turn streams; the result comes back on
 * the snapshot correlated by requestId; and the job leaves `running`.
 */

const ompPath = resolveOmpBinary();

const MODELS_YML = (baseUrl: string): string => `providers:
  jobsprobe:
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
  data?: { isStreaming?: boolean };
  statusKey?: string;
  statusText?: string;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

// Real timers throughout: the awaited actor is an OS process, and every wait
// polls an observed frame, never a guessed duration. Executor form because
// the node tsconfig lib predates Promise.withResolvers — the same exception
// limits-live.test.ts documents.
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

function chunk(index: number, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: `jobsprobe-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

/** The async bash tool call (plan §5): `async` spawns the job, `i` is omp's required intent arg. */
const TOOL_CALL = {
  index: 0,
  id: "call_probe",
  type: "function",
  function: {
    name: "bash",
    arguments: JSON.stringify({ command: "sleep 30", async: true, i: "start a probe job" }),
  },
};

interface ScriptedProvider {
  baseUrl: string;
  /** Releases held completion `index` with a final stop chunk. */
  complete(index: number): void;
  close(): Promise<void>;
}

/**
 * Completion 0 launches the async bash job and ends itself; completion 1
 * streams a short sentence and stays open until `complete` releases it —
 * holding it is what keeps the turn streaming during the mid-turn kill.
 * Any further completion (e.g. omp's async-result delivery wake after the
 * cancel) streams one sentence and ends itself, so a wake turn can't hang.
 */
async function scriptedProvider(): Promise<ScriptedProvider> {
  let held = 0;
  const responses = new Map<number, ServerResponse>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      const index = held++;
      responses.set(index, response);
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      if (index === 1) response.write(chunk(index, { role: "assistant", content: "working" }, null));
      else
        response.end(
          (index === 0
            ? chunk(index, { role: "assistant", tool_calls: [TOOL_CALL] }, null) + chunk(index, {}, "tool_calls")
            : chunk(index, { role: "assistant", content: "done" }, null) + chunk(index, {}, "stop")) +
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
    complete(index: number) {
      const response = responses.get(index);
      if (response === undefined || response.writableEnded) throw new Error(`no held request ${index}`);
      response.end(chunk(index, {}, "stop") + "data: [DONE]\n\n");
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function spawnScope(baseUrl: string, extension: string): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-jobs-live-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const env = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "jobsprobe/inert",
    extensions: [extension],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, [...args, "--tools=bash"], {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...extra, ...env },
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
    onFrame: (frame) => frames.push(frame as Frame),
    onExit: () => markExited(),
    onError: () => {},
  });
  return { base, frames, client, exited };
}

let requestSequence = 0;
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  const id = `jobs-live-${++requestSequence}`;
  scope.client.send({ ...command, id } as never);
  return waitFor(
    () => scope.frames.find((frame) => frame.type === "response" && frame.id === id),
    30_000,
    `the response to ${command.type}`,
  );
}

/** Parses every snapshot published at or after `from`, newest last. */
function snapshots(scope: Scope, from: number): AsyncJobsSnapshot[] {
  return scope.frames
    .slice(from)
    .filter((frame) => frame.type === "extension_ui_request" && frame.statusKey === ASYNC_JOBS_STATUS_KEY)
    .map((frame) => parseAsyncJobsSnapshot(frame.statusText))
    .filter((snapshot): snapshot is AsyncJobsSnapshot => snapshot !== null);
}

async function killScope(scope: Scope): Promise<void> {
  scope.client.kill();
  await Promise.race([scope.exited, sleep(8_000)]);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

const disposers: (() => Promise<void>)[] = [];
let provider: ScriptedProvider | null = null;

afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
});

describe.skipIf(ompPath === null)("async-jobs bridge live (real omp)", () => {
  it(
    "arms, surfaces an async bash job mid-turn, kills it by command, and the turn ends",
    { timeout: 180_000 },
    async () => {
      provider = await scriptedProvider();
      const extDir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-jobs-ext-"));
      const scope = spawnScope(provider.baseUrl, writeAsyncJobsExtension(extDir));
      disposers.push(async () => {
        await killScope(scope);
        fs.rmSync(extDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      await waitFor(
        () => (scope.frames.some((frame) => frame.type === "response") ? true : undefined),
        60_000,
        "the first rpc response",
      );

      // 1. The bare arm force-publishes a snapshot.
      const armFrom = scope.frames.length;
      const armed = await request(scope, { type: "prompt", message: asyncJobsArmMessage() });
      expect(armed.success).toBe(true);
      const first = await waitFor(
        () => snapshots(scope, armFrom).at(-1),
        30_000,
        "the arm's omp-ui:async-jobs publish",
      );
      expect(first.available, `bridge unavailable: ${first.unavailable}`).toBe(true);
      expect(first.canCancel, "cancelAsyncJob missing on this binary").toBe(true);
      const processKey = first.processKey;

      // 2. A prompt whose completion starts an async bash job; the provider
      // holds the post-tool completion so the turn stays streaming.
      const jobFrom = scope.frames.length;
      scope.client.send({ type: "prompt", message: "go" } as never);
      const running = await waitFor(
        () =>
          snapshots(scope, jobFrom)
            .flatMap((snapshot) => snapshot.running)
            .find((job) => job.command === "sleep 30"),
        60_000,
        "the running sleep 30 bash job in a snapshot",
      );
      expect(running.status).toBe("running");
      expect(running.type).toBe("bash");
      expect(running.startTime).toBeGreaterThan(0);

      const streaming = await request(scope, { type: "get_state" });
      expect(streaming.data?.isStreaming).toBe(true);

      // 3. The kill rides the hidden command mid-turn, no streamingBehavior.
      const killFrom = scope.frames.length;
      const requestId = `live-kill-${Date.now()}`;
      scope.client.send({
        type: "prompt",
        message: asyncJobsKillMessage({ requestId, processKey, jobId: running.id, startTime: running.startTime }),
      } as never);
      const answered = await waitFor(
        () => snapshots(scope, killFrom).find((snapshot) => snapshot.result?.requestId === requestId),
        30_000,
        "the kill's result on a snapshot",
      );
      expect(answered.result?.ok, `kill failed: ${answered.result?.text}`).toBe(true);
      expect(answered.result?.cancelled).toContain(running.id);
      expect(answered.running.some((job) => job.id === running.id)).toBe(false);

      // 4. Releasing the held completion ends the turn cleanly.
      provider.complete(1);
      await waitFor(
        () => (scope.frames.some((frame, i) => i >= jobFrom && frame.type === "agent_end") ? true : undefined),
        30_000,
        "the agent_end after the release",
      );
    },
  );
});
