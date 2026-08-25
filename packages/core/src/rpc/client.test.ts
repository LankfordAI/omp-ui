import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient, type RpcChildProcess } from "./client";

interface FakeProc {
  proc: RpcChildProcess;
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: () => boolean;
  exit: (code: number | null) => void;
}

function fakeProc(): FakeProc {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let killed = false;
  let exitCb: ((code: number | null) => void) | undefined;
  return {
    proc: {
      stdin,
      stdout,
      stderr,
      kill: () => {
        killed = true;
      },
      onExit: (cb) => {
        exitCb = cb;
      },
      onSpawnError: () => {},
    },
    stdin,
    stdout,
    stderr,
    killed: () => killed,
    exit: (code) => exitCb?.(code),
  };
}

interface Harness {
  client: RpcClient;
  fake: FakeProc;
  frames: unknown[];
  errors: string[];
  exits: (number | null)[];
  stdinText: () => string;
  spawnArgs: string[];
  spawnEnv: NodeJS.ProcessEnv;
  lineageDir: string;
}

const lineageDirs: string[] = [];
function harness(opts: { resumeSessionId?: string; ompPath?: string; initialCommands?: object[] } = {}): Harness {
  const fake = fakeProc();
  const frames: unknown[] = [];
  const errors: string[] = [];
  const exits: (number | null)[] = [];
  let spawnArgs: string[] = [];
  let spawnEnv: NodeJS.ProcessEnv = {};
  const lineageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-lineage-"));
  lineageDirs.push(lineageDir);
  const client = new RpcClient({
    cwd: "/proj",
    lineageDir,
    ompPath: opts.ompPath ?? "/opt/bun/bin/omp",
    resumeSessionId: opts.resumeSessionId,
    initialCommands: opts.initialCommands,
    onFrame: (f) => frames.push(f),
    onExit: (c) => exits.push(c),
    onError: (m) => errors.push(m),
    spawnProcess: (_cmd, args, env) => {
      spawnArgs = args;
      spawnEnv = env;
      return fake.proc;
    },
  });
  return {
    client,
    fake,
    frames,
    errors,
    exits,
    stdinText: () => fake.stdin.read()?.toString() ?? "",
    spawnArgs,
    spawnEnv,
    lineageDir,
  };
}

function readyFrame(maxFrameBytes = 1_048_576): string {
  return `${JSON.stringify({ type: "ready", protocolVersion: 1, supportedProtocolVersions: [1, 2], maxFrameBytes })}\n`;
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of lineageDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe("RpcClient spawn", () => {
  it("spawns with the rpc-ui args and shim-proofed PATH", () => {
    const h = harness({ ompPath: "/opt/bun/bin/omp" });
    expect(h.spawnArgs).toEqual([
      "--mode=rpc-ui",
      "--cwd",
      "/proj",
      "--session-dir",
      h.lineageDir,
    ]);
    expect(h.spawnEnv.PATH?.startsWith(`/opt/bun/bin`)).toBe(true);
  });

  it("appends --resume when a session id is given", () => {
    const h = harness({ resumeSessionId: "abc-123" });
    expect(h.spawnArgs.at(-1)).toBe("--resume=abc-123");
  });

  it("creates a missing lineage dir before spawning", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-lineage-"));
    lineageDirs.push(base);
    const lineageDir = path.join(base, "lineage", "omp-ui--x--11111111-2222-3333-4444-555555555555");
    const fake = fakeProc();
    new RpcClient({
      cwd: "/proj",
      lineageDir,
      ompPath: "/opt/bun/bin/omp",
      onFrame: () => {},
      onExit: () => {},
      onError: () => {},
      spawnProcess: () => fake.proc,
    });
    expect(fs.existsSync(lineageDir)).toBe(true);
  });
});

describe("RpcClient handshake", () => {
  it("answers ready with negotiate_protocol v2 and forwards ready", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame());
    await tick();
    expect(h.stdinText()).toBe('{"type":"negotiate_protocol","protocolVersion":2}\n');
    expect(h.frames).toEqual([
      expect.objectContaining({ type: "ready", protocolVersion: 1 }),
    ]);
  });

  it("sends initial commands after negotiation and before forwarding ready", async () => {
    const command = { type: "prompt", id: "initial-plan", message: "/omp-ui-plan on html" };
    const h = harness({ initialCommands: [command] });

    h.fake.stdout.write(readyFrame());
    await tick();

    expect(h.stdinText()).toBe(
      '{"type":"negotiate_protocol","protocolVersion":2}\n' + JSON.stringify(command) + "\n",
    );
    expect(h.frames).toHaveLength(1);
  });

  it("adopts maxFrameBytes from the ready frame", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame(64));
    await tick();
    h.fake.stdout.write(`${"x".repeat(65)}\n`);
    await tick();
    expect(h.errors[0]).toMatch(/over 1 MiB cap|over .* cap/);
    expect(h.fake.killed()).toBe(true);
  });

  it("times out without a ready frame and includes the stderr tail", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = harness();
    h.fake.stderr.write("some startup noise on stderr");
    await tick();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.errors[0]).toMatch(/no ready frame in 10 s/);
    expect(h.errors[0]).toMatch(/some startup noise/);
    expect(h.fake.killed()).toBe(true);
  });
});

describe("RpcClient framing", () => {
  it("reassembles rpc_chunks across split writes", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame());
    await tick();
    const payload = JSON.stringify({ type: "big", text: "z".repeat(200) });
    const bytes = Buffer.from(payload, "utf8");
    const half = Math.ceil(bytes.length / 2);
    const chunk = (index: number, part: Buffer) =>
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "c", index, count: 2, byteLength: bytes.length, data: part.toString("base64") })}\n`;
    // Split mid-line across two writes.
    const first = chunk(0, bytes.subarray(0, half));
    h.fake.stdout.write(first.slice(0, 10));
    await tick();
    expect(h.frames).toHaveLength(1); // only ready so far
    h.fake.stdout.write(first.slice(10));
    await tick();
    expect(h.frames).toHaveLength(1);
    h.fake.stdout.write(chunk(1, bytes.subarray(half)));
    await tick();
    expect(h.frames).toHaveLength(2);
    expect(h.frames[1]).toEqual(JSON.parse(payload));
  });

  it("kills on an out-of-order chunk index", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame());
    await tick();
    h.fake.stdout.write(
      `${JSON.stringify({ type: "rpc_chunk", chunkId: "c", index: 1, count: 2, byteLength: 4, data: "eA==" })}\n`,
    );
    await tick();
    expect(h.errors[0]).toMatch(/starts at index 1/);
    expect(h.fake.killed()).toBe(true);
  });

  it("kills when a line exceeds the frame cap", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame(32));
    await tick();
    h.fake.stdout.write(`${"y".repeat(40)}\n`);
    await tick();
    expect(h.errors[0]).toMatch(/cap/);
    expect(h.fake.killed()).toBe(true);
  });

  it("kills when the buffer grows past the cap with no newline", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame(32));
    await tick();
    h.fake.stdout.write("y".repeat(40)); // no newline
    await tick();
    expect(h.errors[0]).toMatch(/no newline/);
    expect(h.fake.killed()).toBe(true);
  });
});

describe("RpcClient lifecycle", () => {
  it("send writes one NDJSON line", async () => {
    const h = harness();
    h.fake.stdout.write(readyFrame());
    await tick();
    h.client.send({ type: "prompt", message: "hi", id: "1" });
    await tick();
    expect(h.stdinText()).toContain('{"type":"prompt","message":"hi","id":"1"}\n');
  });

  it("reports a non-zero exit with the stderr tail, then onExit", async () => {
    const h = harness();
    h.fake.stderr.write("boom happened");
    await tick();
    h.fake.exit(1);
    expect(h.errors[0]).toMatch(/exited with code 1/);
    expect(h.errors[0]).toMatch(/boom happened/);
    expect(h.exits).toEqual([1]);
  });

  it("does not error on a clean exit", () => {
    const h = harness();
    h.fake.exit(0);
    expect(h.errors).toEqual([]);
    expect(h.exits).toEqual([0]);
  });

  it("kill() stops the process without an error", () => {
    const h = harness();
    h.client.kill();
    expect(h.fake.killed()).toBe(true);
    expect(h.errors).toEqual([]);
  });
});
