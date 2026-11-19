import { execFileSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { RpcClient, resolveOmpBinary, type RpcChildProcess } from "@omp-ui/core";

/**
 * Live proof for the auth-broker startup wait (issue #1230) against a real
 * OMP ≥19 binary. v19 retries a transiently unreachable auth broker during
 * startup for a bounded window before it self-exits; the RpcClient ready
 * deadline extends on the child's stderr evidence so a broker that recovers
 * after the 10 s base deadline still reaches `ready`.
 *
 * The seams are the ones #1232's CI startup-regression proof reuses:
 * - `startBroker()` is a controllable auth-broker stand-in: it answers
 *   `/v1/snapshot` with 503 (upstream's retryable class) until `open()`, then
 *   serves a schema-valid empty snapshot (wire shape pinned to v19.0.0's
 *   snapshotResponseSchema).
 * - the binary comes from `resolveOmpBinary()` (so `OMP_UI_OMP_PATH=<v19>`
 *   selects it, and the suite skips when no binary resolves); the major
 *   version gate keeps 18.22.x harnesses on today's behavior by skipping.
 *
 * Real timers throughout: this is the integration exception — the awaited
 * actors are an OS process and a real HTTP broker, and the recovery point
 * sits deliberately beyond the 10 s base deadline, which only the child's
 * own stderr can move; every wait probes the observed condition, not a
 * guessed duration.
 */

const ompPath = resolveOmpBinary();

/** The v19 stderr notice (once per startup) that the initial snapshot is retrying. */
const BROKER_WAIT_NOTICE = /Waiting for auth broker at\b/;

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
    await sleep(100);
  }
}

interface Broker {
  url: string;
  /** Start answering `/v1/snapshot` with a valid (empty) snapshot. */
  open(): void;
  close(): Promise<void>;
}

async function startBroker(): Promise<Broker> {
  let open = false;
  const server = http.createServer((request, response) => {
    if (!request.url?.startsWith("/v1/snapshot")) {
      response.writeHead(404).end();
      return;
    }
    if (!open) {
      response.writeHead(503, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "broker starting" }));
      return;
    }
    // snapshotResponseSchema at v19.0.0: generation/generatedAt/serverNowMs/
    // refresher/credentials. An empty credential list boots a usable store.
    response.writeHead(200, { "Content-Type": "application/json", ETag: '"1"' });
    response.end(
      JSON.stringify({
        generation: 1,
        generatedAt: Date.now(),
        serverNowMs: Date.now(),
        refresher: { enabled: false, intervalMs: 60_000, skewMs: 5_000, nextSweepInMs: 60_000 },
        credentials: [],
      }),
    );
  });
  const { promise: listening, resolve: settled } = Promise.withResolvers<void>();
  const { promise: listenFailed, reject: listenRejected } = Promise.withResolvers<never>();
  server.once("error", listenRejected);
  server.listen(0, "127.0.0.1", settled);
  await Promise.race([listening, listenFailed]);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no loopback broker port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    open: () => {
      open = true;
    },
    close: () => {
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      server.close((err) => (err ? reject(err) : resolve()));
      return promise;
    },
  };
}

interface Dirs {
  base: string;
  project: string;
  lineage: string;
  home: string;
}

function makeDirs(): Dirs {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-brokerwait-"));
  const dirs = {
    base,
    project: path.join(base, "proj"),
    lineage: path.join(base, "lin"),
    home: path.join(base, "home"),
  };
  fs.mkdirSync(path.join(dirs.home, ".omp", "agent"), { recursive: true });
  fs.mkdirSync(dirs.lineage, { recursive: true });
  fs.mkdirSync(dirs.project, { recursive: true });
  fs.writeFileSync(
    path.join(dirs.home, ".omp", "agent", "config.yml"),
    "startup:\n  checkUpdate: false\nretry:\n  enabled: false\n",
  );
  return dirs;
}

interface Frame {
  type?: string;
}

interface Scope {
  dirs: Dirs;
  client: RpcClient;
  frames: Frame[];
  errors: string[];
  stderrLines: string[];
  exits: (number | null)[];
  exited: Promise<void>;
}

/** A real rpc-ui child pointed at the broker, with HOME/XDG/agent dirs isolated. */
function spawnScope(dirs: Dirs, brokerUrl: string): Scope {
  const frames: Frame[] = [];
  const errors: string[] = [];
  const stderrLines: string[] = [];
  const exits: (number | null)[] = [];
  const { promise: exited, resolve: markExited } = Promise.withResolvers<void>();
  const client = new RpcClient({
    cwd: dirs.project,
    lineageDir: dirs.lineage,
    ompPath: ompPath!,
    spawnProcess: (bin, args, baseEnv): RpcChildProcess => {
      const proc = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: {
          ...baseEnv,
          HOME: dirs.home,
          XDG_CONFIG_HOME: path.join(dirs.home, ".config"),
          XDG_DATA_HOME: path.join(dirs.home, ".local", "share"),
          OMP_AUTH_BROKER_URL: brokerUrl,
          OMP_AUTH_BROKER_TOKEN: "***",
        },
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
    onExit: (code) => {
      exits.push(code);
      markExited();
    },
    onError: (msg) => errors.push(msg),
  });
  client.onStderrLine((line) => stderrLines.push(line));
  return { dirs, client, frames, errors, stderrLines, exits, exited };
}

async function reap(scope: Scope): Promise<void> {
  scope.client.kill();
  const escalate = setTimeout(() => scope.client.kill("SIGKILL"), 8_000);
  await scope.exited;
  clearTimeout(escalate);
  fs.rmSync(scope.dirs.base, { recursive: true, force: true });
}

function ompMajor(): number | null {
  try {
    const match = /(\d+)\./.exec(execFileSync(ompPath!, ["--version"], { encoding: "utf8", timeout: 15_000 }));
    return match === null ? null : Number(match[1]);
  } catch {
    return null;
  }
}

const majors = ompPath === null ? null : ompMajor();
const v19 = ompPath !== null && majors !== null && majors >= 19;

describe.skipIf(!v19)("auth-broker startup wait live (real omp ≥19)", () => {
  let scope: Scope | null = null;
  let broker: Broker | null = null;

  afterEach(async () => {
    const s = scope;
    scope = null;
    const b = broker;
    broker = null;
    if (s !== null) await reap(s);
    if (b !== null) await b.close();
  });

  it(
    "reaches ready when the broker recovers after the 10 s base deadline",
    async () => {
      const startedAt = Date.now();
      broker = await startBroker();
      scope = spawnScope(makeDirs(), broker.url);

      // The child must first report the bounded retry (the evidence that
      // extends the ready deadline) rather than speak ready. A failure edge
      // surfaces immediately rather than at the probe's own deadline.
      await waitFor(
        () => {
          if (scope!.errors.length > 0) throw new Error(`child failed before waiting: ${scope!.errors[0]}`);
          return scope!.stderrLines.some((line) => BROKER_WAIT_NOTICE.test(line)) ? true : undefined;
        },
        30_000,
        "the broker wait notice",
      );

      // Open the broker only after the base ready deadline is history: an
      // unextended client would already have killed this child.
      await waitFor(() => (Date.now() - startedAt > 11_000 ? true : undefined), 15_000, "past the base deadline");
      broker.open();

      // v19's backoff puts the next attempt at ~15.5 s of boot.
      await waitFor(
        () => {
          if (scope!.errors.length > 0) throw new Error(`child failed while waiting: ${scope!.errors[0]}`);
          return scope!.frames.some((frame) => frame.type === "ready") ? true : undefined;
        },
        60_000,
        "the ready frame after the broker opened",
      );
      expect(scope.errors).toEqual([]);
      expect(Date.now() - startedAt).toBeGreaterThan(11_000);
    },
    90_000,
  );

  it(
    "surfaces the child's own exit and actionable stderr when the broker never recovers",
    async () => {
      broker = await startBroker();
      scope = spawnScope(makeDirs(), broker.url);
      // v19 self-exits with code 1 right after its 30 s retry window.
      await waitFor(() => (scope!.exits.length > 0 ? true : undefined), 60_000, "the child to give up on the broker");
      expect(scope.exits).toEqual([1]);
      expect(scope.errors[0]).toMatch(/omp exited with code 1/);
      expect(scope.errors[0]).toMatch(/retrying for up to 30s|unreachable/);
    },
    90_000,
  );
});
