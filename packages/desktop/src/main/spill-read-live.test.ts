import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { RpcClient, compareVersions, readInstalledOmpVersion, resolveOmpBinary } from "@omp-ui/core";
import { parseSpillReference, SPILL_READ_MIN_OMP } from "@omp-ui/core/spill";
import { readSpillFile } from "@omp-ui/core/spill-read";
import { spillRootForTranscript, transcriptSpillCapable } from "@omp-ui/core/spill-header";

/**
 * Real-OMP proof for issue #1236: on omp 19, a bash call whose output trips
 * the spill threshold (probed at 50 KB) lands `details.meta.truncation.
 * artifactId` on the `tool_execution_end` frame AND a plain `<N>.log` file at
 * the session transcript's sibling `local/` dir. The confined reader — the
 * exact one main dispatches for View raw output — resolves that id against the
 * transcript path and reads the full output back; omp 18's transcripts read as
 * legacy, which is what the card's unavailable state reports.
 *
 * Scripted loopback provider (the bash-minimized-live pattern): completion 0
 * emits the bash tool call, later completions close the turn. `seq 1 30000`
 * is deliberately the command the issue's probes used (~165 KB out).
 *
 * Skips without an omp binary and below 19.0.0 (run against 19 with
 * OMP_UI_OMP_PATH); older harnesses skip rather than fail.
 */
const ompPath = resolveOmpBinary();

const MODELS_YML = (baseUrl: string): string => `providers:
  spillprobe:
    baseUrl: ${baseUrl}
    api: openai-completions
    apiKey: none
    models:
      - id: inert
        name: inert
        contextWindow: 131072
        maxTokens: 128
        reasoning: false
`;

const CONFIG_YML = `startup:
  checkUpdate: false
retry:
  enabled: false
tools:
  approvalMode: yolo
`;

const TOOL_CALL = {
  index: 0,
  id: "call_spill",
  type: "function",
  function: { name: "bash", arguments: JSON.stringify({ command: "seq 1 30000" }) },
};

function sleep(ms: number): Promise<void> {
  // Real timers on purpose (as in bash-minimized-live.test.ts): the thing
  // waited on is an out-of-process agent, so fake clocks cannot advance it.
  // Promise.withResolvers needs ES2024; the node tsconfig lib predates it.
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(probe: () => Promise<T | undefined> | (T | undefined), timeoutMs: number, what: string): Promise<T> {
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
    id: `spillprobe-${index}`,
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

interface Frame {
  type: string;
  id?: string;
  success?: boolean;
  toolCallId?: string;
  result?: unknown;
}

interface Scope {
  base: string;
  lineage: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

function spawnScope(baseUrl: string): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-spill-live-"));
  const home = path.join(base, "home");
  fs.mkdirSync(path.join(home, ".omp", "agent"), { recursive: true });
  fs.writeFileSync(path.join(home, ".omp", "agent", "models.yml"), MODELS_YML(baseUrl));
  fs.writeFileSync(path.join(home, ".omp", "agent", "config.yml"), CONFIG_YML);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    XDG_CONFIG_HOME: path.join(home, ".config"),
    XDG_DATA_HOME: path.join(home, ".local", "share"),
  };
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
    model: "spillprobe/inert",
    configOverlays: [],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, [...args, "--tools=bash"], { stdio: ["pipe", "pipe", "pipe"], env: { ...extra, ...env } });
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
  const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
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
async function request(scope: Scope, command: Record<string, unknown>): Promise<Frame> {
  sequence += 1;
  const id = `spill-live-${sequence}`;
  scope.client.send({ ...command, id } as never);
  return pollUntil(() => scope.frames.find((f) => f.type === "response" && f.id === id), 30_000, `the response to ${JSON.stringify(command)}`);
}

async function ready(scope: Scope): Promise<void> {
  await pollUntil(() => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined), 60_000, "omp ready");
}

/** The session transcript under the lineage dir (session dirs nest one level). */
function findTranscript(scope: Scope): string | undefined {
  for (const name of fs.readdirSync(scope.lineage)) {
    const full = path.join(scope.lineage, name);
    if (fs.statSync(full).isDirectory()) continue;
    if (name.endsWith(".jsonl")) return full;
  }
  return undefined;
}

describe.skipIf(ompPath === null)("spill files on the real runtime (issue #1236)", () => {
  let version: string | null = null;
  beforeAll(async () => {
    version = await readInstalledOmpVersion(ompPath!);
  });

  it("names the spill on the frame and reads the full output back through the confined reader", async (ctx) => {
    if (version === null || compareVersions(version, SPILL_READ_MIN_OMP) < 0) {
      ctx.skip(`omp ${version ?? "unknown"} predates spill files (${SPILL_READ_MIN_OMP})`);
    }
    provider = await scriptedProvider();
    const scope = spawnScope(provider.baseUrl);
    scopes.push(scope);
    await ready(scope);
    const prompted = await request(scope, { type: "prompt", message: "go" });
    expect(prompted.success).toBe(true);

    const ended = await pollUntil(
      () => scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === TOOL_CALL.id),
      120_000,
      "the tool_execution_end for the bash call",
    );
    // The card's parser sees exactly one spill reference on the wire shape.
    const details = (ended.result as { details?: unknown } | undefined)?.details;
    const ref = parseSpillReference(details);
    if (ref === undefined) throw new Error(`bash tool_execution_end lacks a spill reference: ${JSON.stringify(ended.result)}`);
    expect(ref.sample).toBe(false);

    await pollUntil(() => (scope.frames.some((f) => f.type === "agent_end") ? true : undefined), 120_000, "the turn's agent_end");

    // The transcript flushes lazily; wait for it, then walk the exact path
    // main walks: transcript → capable probe → sibling local root → confined read.
    const transcript = await pollUntil(() => findTranscript(scope), 30_000, "the session transcript");
    expect(await transcriptSpillCapable(transcript)).toMatchObject({ version: version!, capable: true });
    const localRoot = spillRootForTranscript(transcript);
    expect(localRoot).not.toBe("");
    const result = await pollUntil(async () => {
      const read = await readSpillFile(localRoot, ref.id);
      return read.status === "ok" ? read : undefined;
    }, 30_000, `the spill file ${ref.id}.log`);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // seq 1 30000 in full: far past the 50 KB inline cap, head to tail.
    expect(result.text.startsWith("1\n2\n")).toBe(true);
    expect(result.text.trimEnd().endsWith("\n29999\n30000")).toBe(true);
    // A spill id that exists nowhere reports missing, never a wrong file.
    await expect(readSpillFile(localRoot, 987654)).resolves.toEqual({ status: "missing" });
  }, 240_000);
});
