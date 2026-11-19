import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary } from "@omp-ui/core";
import { isAsyncNotifyMessage, parseAsyncNotifyReports, type AsyncNotifyReport } from "@omp-ui/core/async-notify";

/**
 * Live drift guard for omp 19's matching-output notices (issue #1235) against
 * the REAL `omp --mode=rpc-ui` binary: a `bash` job started with `notify` must
 * deliver its matching lines as the `async-notify` custom message this repo's
 * parser reads — `{role: "custom", customType: "async-notify", details:
 * {reports: [{id, type, pattern, lines, omitted, running, stopped}]}}` —
 * arriving on both the message_start and message_end frame with one complete
 * message (verified against omp/19.0.0 when this file was written).
 *
 * Delivery rides the session's yield queue: while the agent streams, matches
 * only queue; the notice lands when the session goes idle. So the scripted
 * provider answers the tool call and immediately ends the turn, and the job —
 * still running for 30s more — produces its matches inside one batching
 * window. The same skip-when-no-binary discipline as async-jobs-live.test.ts;
 * a harness older than 19 never sends this customType and is skipped outright.
 */

const ompPath = resolveOmpBinary();

/** Major version of the pinned binary; 0 when it cannot be asked. */
function ompMajor(): number {
  if (ompPath === null) return 0;
  try {
    const match = /(\d+)\./.exec(execFileSync(ompPath, ["--version"], { encoding: "utf8", timeout: 15_000 }));
    return match === null ? 0 : Number.parseInt(match[1]!, 10);
  } catch {
    return 0;
  }
}

const MODELS_YML = (baseUrl: string): string => `providers:
  notifyprobe:
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

interface Frame {
  type: string;
  id?: string;
  message?: Record<string, unknown>;
}

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

// Real timers throughout: the awaited actor is an OS process whose notifier
// batches on a real 200 ms window; every wait polls an observed frame.
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
    id: `notifyprobe-${index}`,
    object: "chat.completion.chunk",
    created: 0,
    model: "inert",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    ...(finishReason === null ? {} : { usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
  })}\n\n`;
}

/** The async bash tool call with `notify`: the job prints its matches fast, then sleeps so it is still running when the notice is built. */
const TOOL_CALL = {
  index: 0,
  id: "call_notify_probe",
  type: "function",
  function: {
    name: "bash",
    arguments: JSON.stringify({
      command: "printf 'NOTIFYPROBE one\\nNOTIFYPROBE two\\n'; sleep 30",
      async: true,
      notify: "NOTIFYPROBE",
      i: "start a notify probe job",
    }),
  },
};

interface ScriptedProvider {
  baseUrl: string;
  close(): Promise<void>;
}

/** Completion 0 launches the notify job and ends itself; every later completion (the notice wake) answers one sentence and ends. */
async function scriptedProvider(): Promise<ScriptedProvider> {
  let index = 0;
  const server = createServer((request, response) => {
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") {
      response.writeHead(404).end();
      return;
    }
    request.resume();
    request.on("end", () => {
      const turn = index++;
      response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
      response.end(
        (turn === 0
          ? chunk(turn, { role: "assistant", tool_calls: [TOOL_CALL] }, null) + chunk(turn, {}, "tool_calls")
          : chunk(turn, { role: "assistant", content: "noted" }, null) + chunk(turn, {}, "stop")) +
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

function spawnScope(baseUrl: string): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-notify-live-"));
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
    model: "notifyprobe/inert",
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
  const id = `notify-live-${++requestSequence}`;
  scope.client.send({ ...command, id } as never);
  return waitFor(
    () => scope.frames.find((frame) => frame.type === "response" && frame.id === id),
    30_000,
    `the response to ${command.type}`,
  );
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

describe.skipIf(ompPath === null || ompMajor() < 19)("async-notify wire live (real omp ≥19)", () => {
  it(
    "delivers a running job's matching lines as the async-notify message our parser reads",
    { timeout: 180_000 },
    async () => {
      provider = await scriptedProvider();
      const scope = spawnScope(provider.baseUrl);
      disposers.push(async () => {
        scope.client.kill();
        await Promise.race([scope.exited, sleep(8_000)]);
        fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      });
      await waitFor(
        () => (scope.frames.some((frame) => frame.type === "response") ? true : undefined),
        60_000,
        "the first rpc response",
      );
      await request(scope, { type: "prompt", message: "probe" });

      // Both frames carry the complete message; wait for the settled end.
      const end = await waitFor(
        () => {
          const hit = scope.frames.find(
            (frame) => frame.type === "message_end" && isAsyncNotifyMessage(frame.message),
          );
          return hit === undefined ? undefined : hit;
        },
        60_000,
        "an async-notify message_end",
      );
      const reports = parseAsyncNotifyReports(end.message?.details);
      expect(reports, "message_end carried no parseable reports").not.toBeNull();
      const report = reports!.find((r) => r.lines.some((line) => line.includes("NOTIFYPROBE")));
      expect(report, `no report held the emitted lines: ${JSON.stringify(reports)}`).toBeDefined();
      const settled = report as AsyncNotifyReport;
      // The wire contract our renderer keys on, verbatim.
      expect(settled.type).toBe("bash");
      expect(settled.id).toMatch(/^bg_\d+$/);
      expect(settled.pattern).toBe("NOTIFYPROBE");
      expect(settled.lines).toContain("NOTIFYPROBE one");
      expect(settled.lines).toContain("NOTIFYPROBE two");
      expect(settled.running, "the notice was built while the job still ran").toBe(true);
      expect(settled.stopped).toBe(false);
      // The start frame pairs the same message (no delta stream between them).
      const start = scope.frames.find(
        (frame) => frame.type === "message_start" && isAsyncNotifyMessage(frame.message),
      );
      expect(start, "async-notify arrived without a message_start").toBeDefined();
      expect(JSON.stringify(start!.message?.details)).toBe(JSON.stringify(end.message?.details));
    },
  );
});
