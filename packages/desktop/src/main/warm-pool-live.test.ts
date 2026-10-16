import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  RpcClient,
  resolveOmpBinary,
  setHostToolsCommand,
  type RpcChildProcess,
  type RpcFrame,
  type RpcSinks,
} from "@omp-ui/core";

/**
 * End-to-end proof of the warm-pool deferral protocol against the REAL
 * `omp --mode=rpc-ui` binary (perf issue #908). The unit suites pin the
 * client mechanics with a fake child; these two guard what only a real child
 * can answer:
 *
 * 1. a parked deferred boot that never negotiates stays ALIVE indefinitely —
 *    negotiating at warm boot is what killed idle children during development,
 *    so "zero wire bytes until arm()" is the load-bearing invariant;
 * 2. `arm()`-ing a parked child settles the real host-tools registration with
 *    a `response` for `omp-ui-host-tools-1` — adoption is protocol-viable,
 *    not just stream-viable.
 *
 * Skips cleanly when no omp binary resolves (mirrors advisor-stats-live).
 * All waits here are real-time on purpose: the awaited condition is a real OS
 * process, and a fake clock cannot make it live, speak, or exit — the
 * documented exception for platform-clock integration tests.
 */

const ompPath = resolveOmpBinary();

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
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const bases: string[] = [];
const disposers: Array<() => Promise<void>> = [];

function scope(): { dir: string; lineage: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-warmlive-"));
  bases.push(dir);
  return { dir, lineage: path.join(dir, "lin") };
}

/** Real child exit, escalating to SIGKILL — removing the scope while omp is
 *  still flushing the session file flakes with ENOTEMPTY (#123). */
function awaitExit(client: RpcClient, exited: Promise<void>): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
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

function parkDeferred(dir: string, lineage: string): Parked {
  const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const stdinWrites: Buffer[] = [];
  const client = new RpcClient({
    cwd: dir,
    lineageDir: lineage,
    ompPath: ompPath!,
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
      const proc = spawn(cmd, args, { cwd: dir, env, stdio: "pipe" });
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
  for (const dispose of disposers.splice(0)) await dispose();
  for (const dir of bases.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

describe.skipIf(!ompPath)("warm-pool deferral live (real omp)", () => {
  it("a parked boot consumes zero bytes and survives un-negotiated", { timeout: 120_000 }, async () => {
    const s = scope();
    const p = parkDeferred(s.dir, s.lineage);
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
    const p = parkDeferred(s.dir, s.lineage);
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
