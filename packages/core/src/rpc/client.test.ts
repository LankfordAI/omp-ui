import { PassThrough } from "node:stream";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setImmediate as tick } from "node:timers/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcClient, type RpcChildProcess, type RpcSinks } from "./client";

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
function harness(opts: { resumeSessionId?: string; ompPath?: string; initialCommands?: object[]; bare?: boolean; model?: string; thinking?: string; advisor?: boolean } = {}): Harness {
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
    model: opts.model,
    thinking: opts.thinking,
    advisor: opts.advisor,
    initialCommands: opts.initialCommands,
    bare: opts.bare,
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

  it("passes a model selector with --model between --resume and --advisor", () => {
    // The dev/test spawn gate's selector must reach omp for a resumed session
    // too — transcript model beats modelRoles.default, so --model is the only lever.
    const h = harness({ resumeSessionId: "abc-123", advisor: true, model: "p/m" });
    expect(h.spawnArgs).toEqual([
      "--mode=rpc-ui",
      "--cwd",
      "/proj",
      "--session-dir",
      h.lineageDir,
      "--resume=abc-123",
      "--model",
      "p/m",
      "--advisor",
    ]);
  });
  it("passes --thinking auto after --model and omits it when unset (#843)", () => {
    // The overlay's defaultThinkingLevel key loses to the model catalog default in
    // omp's resolver, so --thinking is the only lever that sets omp's auto flag.
    const h = harness({ model: "p/m", thinking: "auto", advisor: true });
    expect(h.spawnArgs).toEqual([
      "--mode=rpc-ui",
      "--cwd",
      "/proj",
      "--session-dir",
      h.lineageDir,
      "--model",
      "p/m",
      "--thinking",
      "auto",
      "--advisor",
    ]);
    // Unset thinking leaves argv byte-identical: every test above pins the full array.
  });

  it("appends the six bare flags in order for a credential errand", () => {
    const h = harness({ bare: true });
    expect(h.spawnArgs).toEqual([
      "--mode=rpc-ui",
      "--cwd",
      "/proj",
      "--session-dir",
      h.lineageDir,
      "--no-session",
      "--no-tools",
      "--no-extensions",
      "--no-lsp",
      "--no-skills",
      "--no-rules",
    ]);
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

  it("fires onInputFrame for every frame in input order, before forwarding (#688)", async () => {
    const fake = fakeProc();
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-lineage-"));
    lineageDirs.push(base);
    const seen: string[] = [];
    const typeOf = (f: unknown): string => String((f as { type?: unknown }).type);
    new RpcClient({
      cwd: "/proj",
      lineageDir: base,
      ompPath: "/opt/bun/bin/omp",
      onInputFrame: (f) => seen.push(`in:${typeOf(f)}`),
      onFrame: (f) => seen.push(`fwd:${typeOf(f)}`),
      onExit: () => {},
      onError: () => {},
      spawnProcess: () => fake.proc,
    });
    fake.stdout.write(readyFrame());
    await tick();
    fake.stdout.write(`${JSON.stringify({ type: "host_tool_call", id: "h1", toolName: "t", toolCallId: "c", arguments: {} })}\n`);
    await tick();
    // ready is intercepted for negotiation yet still reaches the input hook
    // first — an answerer must see every frame regardless of forwarding.
    expect(seen).toEqual([
      "in:ready",
      "fwd:ready",
      "in:host_tool_call",
      "fwd:host_tool_call",
    ]);
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

describe("RpcClient deferred arm (warm pool, issue #908)", () => {
  interface Deferred {
    client: RpcClient;
    fake: FakeProc;
    bootReady: () => number;
    deaths: (number | null)[];
    stdinText: () => string;
  }
  function deferredHarness(): Deferred {
    const fake = fakeProc();
    const lineageDir = fs.mkdtempSync(path.join(os.tmpdir(), "rpc-lineage-"));
    lineageDirs.push(lineageDir);
    let readyCount = 0;
    const deaths: (number | null)[] = [];
    const client = new RpcClient({
      cwd: "/proj",
      lineageDir,
      ompPath: "/opt/bun/bin/omp",
      deferArm: true,
      onBootReady: () => {
        readyCount += 1;
      },
      // Inert-while-parked sinks: the ctor swaps these for no-ops; arm()
      // replaces them wholesale, so nothing here may ever fire.
      onFrame: () => {
        throw new Error("deferred sink fired before arm");
      },
      onExit: () => {},
      onError: () => {},
      spawnProcess: () => fake.proc,
    });
    client.onDeath((code) => deaths.push(code));
    return {
      client,
      fake,
      bootReady: () => readyCount,
      deaths,
      stdinText: () => fake.stdin.read()?.toString() ?? "",
    };
  }
  const recorder = (): { sinks: RpcSinks; seen: string[] } => {
    const seen: string[] = [];
    const typeOf = (f: unknown): string => String((f as { type?: unknown }).type);
    return {
      seen,
      sinks: {
        onInputFrame: (f) => seen.push(`in:${typeOf(f)}`),
        onFrame: (f) => seen.push(`fwd:${typeOf(f)}`),
        onExit: () => {},
        onError: () => {},
      },
    };
  };

  it("parks a warm boot with zero wire bytes and zero forwarding", async () => {
    const d = deferredHarness();
    expect(d.client.armed).toBe(false);
    d.fake.stdout.write(readyFrame());
    d.fake.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "e1", extensionPath: "/x.ts", method: "capabilities", params: {} })}\n`,
    );
    await tick();
    // Boot reached ready, yet the child consumed nothing and the inert sinks
    // (which throw if touched) stayed untouched.
    expect(d.stdinText()).toBe("");
    expect(d.bootReady()).toBe(1);
    expect(d.client.armed).toBe(false);
  });

  it("arm negotiates, flushes the rail, then replays parked frames in input order", async () => {
    const d = deferredHarness();
    const command = { type: "prompt", id: "omp-ui-host-tools-1", message: "/tools" };
    d.fake.stdout.write(readyFrame());
    d.fake.stdout.write(
      `${JSON.stringify({ type: "extension_ui_request", id: "e1", extensionPath: "/x.ts", method: "capabilities", params: {} })}\n`,
    );
    await tick();
    const rec = recorder();
    d.client.arm(rec.sinks, [command]);
    // Exactly the cold-spawn write sequence: negotiate, then rail.
    expect(d.stdinText()).toBe(
      '{"type":"negotiate_protocol","protocolVersion":2}\n' + JSON.stringify(command) + "\n",
    );
    // Replay keeps the input-order contract: the answerer sees every parked
    // frame before forwarding — boot-time extension_ui_requests need answers.
    expect(rec.seen).toEqual(["in:ready", "fwd:ready", "in:extension_ui_request", "fwd:extension_ui_request"]);
    expect(d.client.armed).toBe(true);
  });

  it("forwards live frames to the armed sinks after replay", async () => {
    const d = deferredHarness();
    d.fake.stdout.write(readyFrame());
    await tick();
    const rec = recorder();
    d.client.arm(rec.sinks, []);
    rec.seen.length = 0;
    d.fake.stdout.write(`${JSON.stringify({ type: "message_start", role: "assistant" })}\n`);
    await tick();
    expect(rec.seen).toEqual(["in:message_start", "fwd:message_start"]);
  });

  it("refuses to arm twice or to arm the dead", () => {
    const d = deferredHarness();
    const rec = recorder();
    d.client.arm(rec.sinks, []);
    expect(() => d.client.arm(rec.sinks, [])).toThrow(/already armed/);
    const dead = deferredHarness();
    dead.fake.exit(0);
    expect(dead.client.dead).toBe(true);
    expect(() => dead.client.arm(recorder().sinks, [])).toThrow(/dead/);
  });

  it("a parked child that dies before adoption fires onDeath with its code", () => {
    const d = deferredHarness();
    d.fake.exit(137);
    expect(d.deaths).toEqual([137]);
    expect(d.client.dead).toBe(true);
  });

  it("a parked child that never speaks ready times out and dies", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const d = deferredHarness();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(d.fake.killed()).toBe(true);
    expect(d.deaths).toEqual([null]);
  });

  it("kill() while parked discards the queue and leaves nothing deliverable", async () => {
    const d = deferredHarness();
    d.fake.stdout.write(readyFrame());
    await tick();
    d.client.kill();
    expect(d.fake.killed()).toBe(true);
    expect(d.client.dead).toBe(true);
    expect(d.stdinText()).toBe("");
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

describe("stderr lines (issue #970)", () => {
  it("replays complete lines already printed, then reports each new line once across chunk splits", async () => {
    const h = harness();
    h.fake.stderr.write("Warning: Default model p/x not found. Using p/y\nConnec");
    await tick();
    const lines: string[] = [];
    // A warm-adopted client registers after boot: the printed warning still arrives, the partial line does not.
    h.client.onStderrLine((line) => lines.push(line));
    expect(lines).toEqual(["Warning: Default model p/x not found. Using p/y"]);
    h.fake.stderr.write("ted to MCP server: rea.\n\nlast");
    await tick();
    expect(lines).toEqual(["Warning: Default model p/x not found. Using p/y", "Connected to MCP server: rea."]);
    h.client.kill();
  });
});
