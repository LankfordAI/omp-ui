import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary } from "@omp-ui/core";

/**
 * Live proof for omp's spend-cap stop (issue #952) against the real
 * `omp --mode=rpc-ui` binary. Same skip-when-no-binary discipline and temp
 * HOME/XDG scope as hidden-context-live.test.ts. Model-free: the resumed
 * transcript already spent $1.00, the `--config` overlay caps the session at
 * $0.50, so omp refuses the prompt before any model request.
 *
 * The contract omp-ui reads: omp's own `cost-gate` error notice arrives
 * first, then a `prompt_result` with `error.code: "cost_cap"` (not
 * retryable), and no agent turn starts.
 *
 * Real timers throughout: the awaited actor is an OS process speaking NDJSON.
 */

const ompPath = resolveOmpBinary();
const PROMPT_ID = "capped";
const SESSION_ID = "019faa64-fdcd-7000-acfd-0123456789c1";

interface Frame {
  type: string;
  id?: string;
  level?: string;
  source?: string;
  message?: unknown;
  status?: string;
  agentInvoked?: boolean;
  error?: { message?: string; code?: string; retryable?: boolean };
}

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

interface Scope {
  base: string;
  frames: Frame[];
  client: RpcClient;
  exited: Promise<void>;
}

/** A v3 omp transcript entry list, written where `--session-dir` + `--resume` find it. */
function seedTranscript(lineage: string, sessionId: string, entries: object[]): void {
  const ts = "2026-10-20T12:00:00.000Z";
  const header = { type: "session", version: 3, id: sessionId, timestamp: ts, cwd: lineage };
  const lines = [header, ...entries.map((entry) => ({ timestamp: ts, ...entry }))];
  fs.writeFileSync(
    path.join(lineage, `2026-10-20T12-00-00-000Z_${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
  );
}

function userEntry(id: string, parentId: string | null, text: string): object {
  return {
    type: "message",
    id,
    parentId,
    message: { role: "user", content: [{ type: "text", text }], attribution: "user", timestamp: 1_792_500_000_000 },
  };
}

/** An assistant reply that already cost the session `total` USD. */
function assistantEntry(id: string, parentId: string, text: string, total: number): object {
  return {
    type: "message",
    id,
    parentId,
    message: {
      role: "assistant",
      content: [{ type: "text", text }],
      api: "openai-completions",
      provider: "openai",
      model: "gpt-4o-mini",
      usage: {
        input: 10,
        output: 5,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 15,
        cost: { input: total / 2, output: total / 2, cacheRead: 0, cacheWrite: 0, total },
      },
      stopReason: "stop",
      timestamp: 1_792_500_001_000,
    },
  };
}

function spawnScope(): Scope {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-costcaplive-"));
  const project = path.join(base, "proj");
  const lineage = path.join(base, "lin");
  const home = path.join(base, "home");
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(lineage, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  seedTranscript(lineage, SESSION_ID, [
    userEntry("a1b2c3d4", null, "hello"),
    assistantEntry("e5f6a7b8", "a1b2c3d4", "hi there", 1),
  ]);
  const overlay = path.join(base, "cap.yml");
  fs.writeFileSync(overlay, "session:\n  maxCost: 0.5\n");
  const frames: Frame[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
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
    resumeSessionId: SESSION_ID,
    configOverlays: [overlay],
    initialCommands: [{ type: "prompt", message: "one more", id: PROMPT_ID }],
    spawnProcess: (bin, args, extra) => {
      const proc = spawn(bin, args, {
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

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
});

function track(scope: Scope): Scope {
  disposers.push(async () => {
    scope.client.kill();
    const exitedNow = await Promise.race([scope.exited.then(() => true), sleep(8_000).then(() => false)]);
    if (!exitedNow) scope.client.kill("SIGKILL");
    await sleep(150);
    fs.rmSync(scope.base, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  return scope;
}

describe.skipIf(ompPath === null)("session spend cap on the real runtime", () => {
  it("a prompt past maxCost stops with a cost-gate notice and a cost_cap result", { timeout: 120_000 }, async () => {
    const scope = track(spawnScope());
    const result = await waitFor(
      () => scope.frames.find((f) => f.type === "prompt_result" && f.id === PROMPT_ID),
      60_000,
      "the capped prompt's prompt_result",
    );
    expect(result).toMatchObject({
      status: "error",
      agentInvoked: true,
      error: { code: "cost_cap", retryable: false },
    });

    const noticeIndex = scope.frames.findIndex(
      (f) => f.type === "notice" && f.level === "error" && f.source === "cost-gate",
    );
    expect(noticeIndex).toBeGreaterThanOrEqual(0);
    // The transcript notice lands before the result that arms the HUD.
    expect(noticeIndex).toBeLessThan(scope.frames.indexOf(result));
    // Refused before any model request: no agent turn.
    expect(scope.frames.filter((f) => f.type === "agent_start")).toEqual([]);
  });
});
