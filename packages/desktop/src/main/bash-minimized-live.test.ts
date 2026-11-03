import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, compareVersions, readInstalledOmpVersion, resolveOmpBinary } from "@omp-ui/core";
import { parseBashMinimized, type BashMinimized } from "@omp-ui/core/bash-minimized";

/**
 * Pins omp's bash output-minimizer provenance (issue #1028) against the REAL
 * `omp --mode=rpc-ui`: when a model-invoked bash call trips the output
 * minimizer, its `tool_execution_end` frame must carry
 * `result.details.meta.minimized` with a string `filter` and numeric byte
 * counts where `inputBytes > outputBytes >= 0`, and the session `.jsonl`'s
 * toolResult entry must record the same provenance. Older omp never writes
 * the field, so requiring it needs 18.16.
 *
 * A scripted loopback provider (the async-jobs-live.test.ts pattern) makes
 * the bash call deterministic without billing a real model: completion 0
 * emits one bash tool call whose command prints ~240 KB of repetitive lines,
 * completion 0's follow-up streams a closing sentence and ends the turn.
 *
 * Skips without an omp binary, and per test below omp 18.16.0.
 */

const ompPath = resolveOmpBinary();
/** The first omp that stamps `details.meta.minimized` on minimized bash results. */
const MINIMIZED_FLOOR = "18.16.0";

const MODELS_YML = (baseUrl: string): string => `providers:
  minprobe:
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

/** ~240 KB of repetitive lines, enough for any minimizer threshold. */
const MARKER = "minimize-probe repetitive filler line for the bash output minimizer";
const TOOL_CALL = {
  index: 0,
  id: "call_minimize",
  type: "function",
  function: {
    name: "bash",
    arguments: JSON.stringify({ command: `yes ${MARKER} | head -n 4000`, i: "emit a huge repetitive output" }),
  },
};

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  error?: string;
  data?: Record<string, unknown>;
  toolCallId?: string;
  toolName?: string;
  result?: unknown;
}

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function sleep(ms: number): Promise<void> {
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  // A real process is the thing waited on, so a real timer is the only clock.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  probe: () => Promise<T | undefined> | (T | undefined),
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function chunk(index: number, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: `minprobe-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

interface ScriptedProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/**
 * Completion 0 emits the huge-output bash tool call and ends with
 * `tool_calls`; every later completion streams one sentence and stops, so
 * the post-tool turn closes without being held open.
 */
async function scriptedProvider(): Promise<ScriptedProvider> {
  let held = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      const index = held++;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
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
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

/** A temp base holding a hermetic HOME (scripted model, yolo bash) and its env. */
function hermeticBase(baseUrl: string): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-bash-minimized-live-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  return {
    base,
    env: {
      ...process.env,
      HOME: home,
      XDG_CONFIG_HOME: path.join(home, ".config"),
      XDG_DATA_HOME: path.join(home, ".local", "share"),
    },
  };
}

/** Spawns on the hermetic base returned by `hermeticBase`, sharing its `base`. */
function spawnScope(base: string, env: NodeJS.ProcessEnv): Scope {
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const frames: Frame[] = [];
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "minprobe/inert",
    configOverlays: [],
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
  return { base, lineage, frames, client, exited };
}

const scopes: Scope[] = [];
async function killScope(scope: Scope): Promise<void> {
  scope.client.kill();
  const exitedNow = await Promise.race([
    scope.exited.then(() => true),
    sleep(8_000).then(() => false),
  ]);
  if (!exitedNow) scope.client.kill("SIGKILL");
  await sleep(150);
  fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

let provider: ScriptedProvider | null = null;
afterEach(async () => {
  for (const scope of scopes.splice(0)) await killScope(scope);
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
});

let sequence = 0;
/** Sends one command and waits for its correlated response. */
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  sequence += 1;
  const id = `bash-min-live-${sequence}`;
  scope.client.send({ ...command, id } as never);
  return pollUntil(
    () => scope.frames.find((f) => f.type === "response" && f.id === id),
    30_000,
    `the response to ${JSON.stringify(command)}`,
  );
}

async function ready(scope: Scope): Promise<void> {
  await pollUntil(
    () => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
    60_000,
    "omp ready",
  );
}

/** Every jsonl under the lineage dir (session dirs nest one level). */
function transcripts(scope: Scope): string {
  return fs
    .readdirSync(scope.lineage)
    .flatMap((name) => {
      const full = path.join(scope.lineage, name);
      return fs.statSync(full).isDirectory()
        ? fs.readdirSync(full).map((child) => path.join(full, child))
        : [full];
    })
    .filter((file) => file.endsWith(".jsonl"))
    .map((file) => fs.readFileSync(file, "utf8"))
    .join("\n");
}

/** The session file's toolResult entry for `toolCallId`, or undefined. */
function sessionToolResult(scope: Scope, toolCallId: string): { details?: unknown } | undefined {
  for (const line of transcripts(scope).split("\n")) {
    if (!line.includes('"toolResult"')) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    const message = (entry.message ?? entry) as Record<string, unknown>;
    if (message.role === "toolResult" && message.toolCallId === toolCallId) return message as { details?: unknown };
  }
  return undefined;
}

describe.skipIf(ompPath === null)("bash minimizer provenance on the real runtime", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });
  const needsMinimizedProvenance = (ctx: { skip: (note?: string) => void }): void => {
    if (version === null || compareVersions(version, MINIMIZED_FLOOR) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates bash minimizer provenance (${MINIMIZED_FLOOR})`);
    }
  };

  it("stamps details.meta.minimized on a minimized bash tool_execution_end and the session file", async (ctx) => {
    needsMinimizedProvenance(ctx);
    provider = await scriptedProvider();
    const { base, env } = hermeticBase(provider.baseUrl);
    const scope = spawnScope(base, env);
    scopes.push(scope);
    await ready(scope);

    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);

    // The frame assertion: the bash call's end carries the provenance.
    const ended = await pollUntil(
      () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === TOOL_CALL.id),
      120_000,
      "the tool_execution_end for the bash call",
    );
    const details = (ended.result as { details?: unknown } | undefined)?.details;
    const minimized = parseBashMinimized(details);
    if (minimized === undefined)
      throw new Error(`bash tool_execution_end lacks details.meta.minimized: ${JSON.stringify(ended.result)}`);
    expect(typeof minimized.filter).toBe("string");
    expect(minimized.filter).not.toBe("");
    expect(typeof minimized.inputBytes).toBe("number");
    expect(typeof minimized.outputBytes).toBe("number");
    expect(minimized.inputBytes).toBeGreaterThan(minimized.outputBytes);
    expect(minimized.outputBytes).toBeGreaterThanOrEqual(0);

    // The turn closes; omp flushes the session file after the agent ends.
    await pollUntil(
      () => (scope.frames.some((f) => f.type === "agent_end") ? true : undefined),
      120_000,
      "the turn's agent_end",
    );

    // The same provenance rides the session file's toolResult entry. omp
    // flushes lazily, so poll the jsonl rather than read it once.
    const recorded = await pollUntil(
      () => {
        const entry = sessionToolResult(scope, TOOL_CALL.id);
        return entry === undefined ? undefined : parseBashMinimized(entry.details);
      },
      30_000,
      "the session file's minimized toolResult entry",
    );
    expect(recorded).toEqual<BashMinimized>(minimized);
  }, 240_000);
});
