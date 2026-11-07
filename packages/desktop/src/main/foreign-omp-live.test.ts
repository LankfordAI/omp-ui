import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { CH, RpcClient, resolveOmpBinary, type RpcFrame } from "@omp-ui/core";
import { ForeignOmpTracker } from "./foreign-omp-tracker";

/**
 * Real-runtime proof for the foreign-omp tracker (issues #1022, #1075): each
 * scripted bash command runs as a REAL `omp` bash tool call inside a real
 * owned rpc-ui session — one command per prompt, because parallel tool calls
 * in one completion execute back-to-back and would race the silence checks.
 * Every command's own effect is asserted, so the words demonstrably reached
 * command position:
 *
 * - `omp --version` prints its version through the tool result; silent.
 * - `omp --model zzz/nope …` fails through real omp's model resolution in
 *   the tool output AND warns exactly once.
 * - A second launch under the same live process adds no second notice.
 * - A commit whose message says `omp` lands for real (the message comes back
 *   from `git log`); silent — #1075's largest false-positive group.
 * - `omp --model zzz/nope --system-prompt '--help' 'go'` exits 0 on the
 *   real binary — bash erased the quoting, omp took `--help` as its flag and
 *   never resolved the model, so no session ran; silent.
 *
 * A scripted loopback provider (the async-jobs-live.test.ts pattern) drives
 * the bash calls deterministically without billing a real model. Skips
 * without an omp binary.
 */

const ompPath = resolveOmpBinary();
const VERSION_MARK = "vprobe-mark";
const LAUNCH_MARK = "launchprobe";
const HELP_MARK = "helpprobe";
const COMMIT_MARK = "trackerprobe commit done";

interface Frame {
  type?: unknown;
  id?: unknown;
  success?: unknown;
  status?: unknown;
  toolCallId?: unknown;
  result?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollUntil<T>(
  probe: () => T | undefined,
  timeoutMs: number,
  what: string,
): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(50);
  }
}

function chunk(index: number, delta: Record<string, unknown>, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: `ompprobe-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

const MODELS_YML = (baseUrl: string): string => `providers:
  ompprobe:
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

/**
 * The provider answers each scripted prompt with that prompt's one bash tool
 * call (`tool_calls`) the first time it sees the prompt's sentinel as the
 * newest user message, and closes every other completion with one sentence
 * and `stop`, so each turn ends without being held open (the
 * async-jobs-live.test.ts shape). Keying on the message text — not a request
 * counter — keeps the mapping deterministic however many completions omp
 * happens to issue per turn.
 */
async function scriptedProvider(
  commands: { sentinel: string; command: string }[],
): Promise<{ baseUrl: string; close(): Promise<void> }> {
  // A sentinel fires at most once: the newest user message names the prompt,
  // and follow-up completions of the same turn close the turn instead.
  const fired = new Set<string>();
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    const body: Buffer[] = [];
    request.on("data", (part: Buffer) => body.push(part));
    request.on("end", () => {
      let messages: unknown = [];
      try {
        const parsed: unknown = JSON.parse(Buffer.concat(body).toString("utf8"));
        if (typeof parsed === "object" && parsed !== null && "messages" in parsed) {
          messages = (parsed as Record<string, unknown>)["messages"];
        }
      } catch {
        // Fall through to the closing reply below.
      }
      const rows = Array.isArray(messages) ? messages : [];
      let pending: { sentinel: string; command: string } | undefined;
      for (const row of [...rows].reverse()) {
        if (typeof row !== "object" || row === null) continue;
        const record = row as Record<string, unknown>;
        if (record["role"] !== "user") continue;
        const text = JSON.stringify(record["content"] ?? "");
        pending = commands.find(({ sentinel }) => !fired.has(sentinel) && text.includes(sentinel));
        break;
      }
      const index = rows.length;
      let body2: string;
      if (pending === undefined) {
        // Either no scripted command is due (a follow-up completion after the
        // tool result, which replays the same user row) or every command ran:
        // close the turn.
        body2 = chunk(index, { role: "assistant", content: "done" }, null) + chunk(index, {}, "stop");
      } else {
        fired.add(pending.sentinel);
        body2 =
          chunk(index, {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: `call_${pending.sentinel}`,
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: pending.command, i: "tracker probe" }) },
              },
            ],
          }, null) + chunk(index, {}, "tool_calls");
      }
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(body2 + "data: [DONE]\n\n");
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

function hermeticBase(baseUrl: string): { base: string; env: NodeJS.ProcessEnv } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-foreign-omp-live-"));
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
      // The scripted `omp` children must resolve the same binary the owned
      // session runs.
      PATH: `${path.dirname(ompPath!)}${path.delimiter}${process.env.PATH ?? ""}`,
      // A hermetic git identity so the scripted commit never needs config.
      GIT_AUTHOR_NAME: "probe",
      GIT_AUTHOR_EMAIL: "probe@example.invalid",
      GIT_COMMITTER_NAME: "probe",
      GIT_COMMITTER_EMAIL: "probe@example.invalid",
    },
  };
}

interface Scope {
  base: string;
  frames: Frame[];
  notices: RpcFrame[];
  client: RpcClient;
  exited: Promise<void>;
}

function spawnScope(base: string, env: NodeJS.ProcessEnv): Scope {
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  const frames: Frame[] = [];
  const notices: RpcFrame[] = [];
  // The observer under proof, fed exactly what the owning main process feeds
  // it: every parsed rpc frame of this live session.
  const tracker = new ForeignOmpTracker({
    send: (channel, ...args) => {
      if (channel === CH.onRpcFrame) notices.push(args[1] as RpcFrame);
    },
  });
  let markExited!: () => void;
  const exited = new Promise<void>((resolve) => {
    markExited = resolve;
  });
  const client = new RpcClient({
    cwd: project,
    lineageDir: lineage,
    ompPath: ompPath!,
    model: "ompprobe/inert",
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
    onFrame: (frame) => {
      frames.push(frame as Frame);
      tracker.onFrame("live-tab", frame);
    },
    onExit: () => {
      tracker.onExit("live-tab");
      markExited();
    },
    onError: () => {},
  });
  return { base, frames, notices, client, exited };
}

const scopes: Scope[] = [];
let provider: { baseUrl: string; close(): Promise<void> } | null = null;
afterEach(async () => {
  for (const scope of scopes.splice(0)) {
    scope.client.kill();
    const exitedNow = await Promise.race([
      scope.exited.then(() => true),
      sleep(8_000).then(() => false),
    ]);
    if (!exitedNow) scope.client.kill("SIGKILL");
    await sleep(150);
    fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  if (provider !== null) {
    await provider.close();
    provider = null;
  }
});

let sequence = 0;
/**
 * Sends one prompt and waits for the owning TURN to complete: first the
 * ack `response` (emitted at acceptance, before the agent even starts),
 * then the correlated `prompt_result` — omp's real turn boundary. Sending
 * the next scripted prompt after only the ack races the prior turn and omp
 * answers busy (`success: false`); awaiting the settled result makes the
 * sequence deterministic. Failures keep both frames' payloads in the
 * message so a regression reads as omp's own rejection, not a bare false.
 */
async function prompt(scope: Scope, message: string): Promise<void> {
  sequence += 1;
  const id = `foreign-omp-live-${sequence}`;
  scope.client.send({ type: "prompt", message, id } as never);
  const response = await pollUntil(
    () => scope.frames.find((f) => f.type === "response" && f.id === id),
    30_000,
    `the ack response to prompt ${id}`,
  );
  expect(response.success, `ack response for ${id}: ${JSON.stringify(response)}`).toBe(true);
  const settled = await pollUntil(
    () => scope.frames.find((f) => f.type === "prompt_result" && f.id === id),
    120_000,
    `the prompt_result completing turn ${id}`,
  );
  expect(settled.status, `prompt_result for ${id}: ${JSON.stringify(settled)}`).toBe("completed");
}

async function ready(scope: Scope): Promise<void> {
  await pollUntil(
    () => (scope.frames.some((f) => f.type === "ready" || f.type === "response") ? true : undefined),
    60_000,
    "omp ready",
  );
}

/** The bash tool result's concatenated text for one sentinel's tool call. */
function toolOutput(scope: Scope, sentinel: string): string | undefined {
  const ended = scope.frames.find((f) => f.type === "tool_execution_end" && f.toolCallId === `call_${sentinel}`);
  if (ended === undefined || typeof ended.result !== "object" || ended.result === null) return undefined;
  const content = (ended.result as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part !== "object" || part === null) return "";
      const text = (part as Record<string, unknown>)["text"];
      return typeof text === "string" ? text : "";
    })
    .join("\n");
}

/** Waits for one sentinel's bash result and returns its text. */
function awaitToolOutput(scope: Scope, sentinel: string): Promise<string> {
  return pollUntil(
    () => toolOutput(scope, sentinel),
    120_000,
    `the bash result for sentinel ${sentinel}`,
  );
}

const foreignNotices = (scope: Scope): RpcFrame[] => scope.notices.filter((n) => n["reason"] === "foreign-omp-launch");

describe.skipIf(ompPath === null)("foreign omp tracker on the real runtime (#1075)", () => {
  it(
    "real probe stays silent, real launch warns once, second launch adds none",
    async () => {
      provider = await scriptedProvider([
        { sentinel: "check-the-version", command: `echo ${VERSION_MARK}; omp --version` },
        { sentinel: "run-a-child-agent", command: `omp --model zzz/nope 'go' 2>&1; echo ${LAUNCH_MARK} $?` },
        { sentinel: "run-it-again", command: `omp --model zzz/nope 'again' 2>&1; echo ${LAUNCH_MARK}2 $?` },
      ]);
      const { base, env } = hermeticBase(provider.baseUrl);
      const scope = spawnScope(base, env);
      scopes.push(scope);
      await ready(scope);

      // Probe. Real omp answers --version through the tool result; on the
      // REAL frames (not a fixture) no notice fires.
      await prompt(scope, "check-the-version");
      const probeOut = await awaitToolOutput(scope, "check-the-version");
      expect(probeOut).toContain(VERSION_MARK);
      expect(probeOut).toMatch(/omp\/\d+\.\d+\.\d+/);
      expect(foreignNotices(scope)).toHaveLength(0);

      // Launch. Real omp refuses the bogus model, so the word reached
      // command position and a session run started; the tracker saw that
      // same real tool_execution_start and warned exactly once. No poll or
      // sleep: the observer runs synchronously per frame, so the completed
      // turn's frames already passed through it.
      await prompt(scope, "run-a-child-agent");
      const launchOut = await awaitToolOutput(scope, "run-a-child-agent");
      expect(launchOut).toContain("zzz/nope");
      expect(launchOut).toContain(LAUNCH_MARK);
      const notices = foreignNotices(scope);
      expect(notices).toHaveLength(1);
      expect(notices[0]).toMatchObject({ type: "omp_ui_notice", level: "warn" });

      // A second launch under the SAME live process, started only after the
      // first turn's prompt_result settled: once per live process still
      // holds on real frames.
      await prompt(scope, "run-it-again");
      const secondOut = await awaitToolOutput(scope, "run-it-again");
      expect(secondOut).toContain(`${LAUNCH_MARK}2`);
      expect(foreignNotices(scope)).toHaveLength(1);
    },
    240_000,
  );

  it(
    "a real commit whose message says `omp` lands and stays silent",
    async () => {
      provider = await scriptedProvider([
        {
          sentinel: "commit-it",
          command: `git init -q . && git commit -q --allow-empty -m '${COMMIT_MARK}: bump to omp 18.17 behavior' && git log -1 --format=%s`,
        },
      ]);
      const { base, env } = hermeticBase(provider.baseUrl);
      const scope = spawnScope(base, env);
      scopes.push(scope);
      await ready(scope);

      // The commit lands for real — `git log` returns the message that only
      // quoted prose in the command text contains. The tracker stays silent.
      await prompt(scope, "commit-it");
      const out = await awaitToolOutput(scope, "commit-it");
      expect(out).toContain(COMMIT_MARK);
      expect(foreignNotices(scope)).toHaveLength(0);
    },
    240_000,
  );

  it(
    "a quoted help word behind a flag prints help on the real binary and stays silent",
    async () => {
      provider = await scriptedProvider([
        {
          sentinel: "quoted-help",
          command: `omp --model zzz/nope --system-prompt '--help' 'go' > /dev/null 2>&1; echo ${HELP_MARK} $?`,
        },
      ]);
      const { base, env } = hermeticBase(provider.baseUrl);
      const scope = spawnScope(base, env);
      scopes.push(scope);
      await ready(scope);

      // Bash erases the quoting before argv, so the real omp takes `--help`
      // as its flag: exit 0 without ever resolving the bogus model — no
      // session ran, and the tracker says nothing.
      await prompt(scope, "quoted-help");
      const out = await awaitToolOutput(scope, "quoted-help");
      expect(out).toContain(`${HELP_MARK} 0`);
      expect(foreignNotices(scope)).toHaveLength(0);
    },
    240_000,
  );
});
