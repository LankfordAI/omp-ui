import { spawn } from "node:child_process";
import * as fs from "node:fs";
import type { Readable, Writable } from "node:stream";
import { ompChildEnv } from "../omp-process";
import { withFdSweep } from "../fd-sweep";
import { RpcChunkReassembler, type RpcFrame } from "./codec";

export interface RpcChildProcess {
  stdin: Writable;
  stdout: Readable;
  stderr: Readable;
  kill(signal?: NodeJS.Signals): void;
  onExit(cb: (code: number | null) => void): void;
  onSpawnError(cb: (err: Error) => void): void;
}

export type RpcSpawnFn = (
  ompPath: string,
  args: string[],
  env: NodeJS.ProcessEnv,
) => RpcChildProcess;

export interface RpcClientOpts {
  cwd: string;
  /** Absolute lineage dir (ADR-0003); created if missing, passed to omp as --session-dir. */
  lineageDir: string;
  ompPath: string;
  resumeSessionId?: string;
  /**
   * Exact per-process model selector (`provider/model[:level]`) passed to omp as
   * `--model`. The dev/test spawn gate and the issue #774 model-recovery
   * resume set it: it is the one mechanism that reaches a resumed session,
   * whose model otherwise comes from the transcript.
   */
  model?: string;
  /**
   * Thinking level passed to omp as `--thinking`. omp-ui sets `"auto"`
   * (#843): the overlay's `defaultThinkingLevel` key sits below the model
   * catalog's own default in omp's boot resolver and never sets omp's auto
   * flag, so only this param makes a catalog-default model boot auto.
   */
  thinking?: string;
  advisor?: boolean;
  /** Extra `--config` overlays — the advisor-model pin (see advisor-overlay.ts). */
  configOverlays?: string[];
  /** Extra `-e` extensions — the plan-mode driver (see plan-extension.ts). */
  extensions?: string[];
  /** Commands sent once, immediately after protocol negotiation and before ready is forwarded. */
  initialCommands?: object[];
  /**
   * Warm-pool boot mode (issue #908 perf): the child spawns but the client
   * consumes NOTHING on the wire — no `negotiate_protocol`, no
   * `initialCommands`; every sink stays inert and frames park until `arm()`
   * swaps in the real observer set and replays the cold-spawn byte sequence
   * (negotiate first, then the session's commands). A probe against omp
   * showed an idle child that was handed `negotiate_protocol` at boot never
   * answering later commands, while one handed negotiate+commands fresh
   * settles in ~2 ms — so a deferred client is a parked pipe until armed.
   */
  deferArm?: boolean;
  /**
   * Credential errand, not a session: `--no-session` plus every discovery
   * switch off. Verified against omp v18.1.0 to still emit `ready` and
   * answer `login`.
   */
  bare?: boolean;
  /**
   * Fires for EVERY reassembled frame in input order — before the ready
   * interception and before `onFrame` forwarding — so a main-process
   * answerer sees frames regardless of whether they were forwarded (the
   * renderer-race fence depends on seeing them first).
   */
  onInputFrame?: (frame: RpcFrame) => void;
  onFrame: (frame: RpcFrame) => void;
  onExit: (code: number | null) => void;
  onError: (msg: string) => void;
  /** Fires on the ready edge even while deferred — lets a warm pool await boot without owning the session sinks. */
  onBootReady?: () => void;
  /** Test seam — defaults to child_process.spawn over pipes. */
  spawnProcess?: RpcSpawnFn;
}

/** The live observer set; `arm()` swaps this whole holder for a warm-booted client. */
export interface RpcSinks {
  onInputFrame?: (frame: RpcFrame) => void;
  onFrame: (frame: RpcFrame) => void;
  onExit: (code: number | null) => void;
  onError: (msg: string) => void;
}

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const READY_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 8192;
/** Park ceiling for a deferred client: boot noise is a handful of frames; more means the pool forgot to arm or kill. */
const MAX_PARKED_FRAMES = 4096;

function defaultSpawn(ompPath: string, args: string[], env: NodeJS.ProcessEnv): RpcChildProcess {
  const cmd = withFdSweep(ompPath, args);
  const proc = spawn(cmd.file, cmd.args, {
    stdio: ["pipe", "pipe", "pipe"] as ["pipe", "pipe", "pipe"],
    env,
  });
  return {
    stdin: proc.stdin,
    stdout: proc.stdout,
    stderr: proc.stderr,
    kill: (signal) => proc.kill(signal),
    onExit: (cb) => proc.on("exit", (code) => cb(code)),
    onSpawnError: (cb) => proc.on("error", cb),
  };
}

function isReadyFrame(frame: unknown): frame is { maxFrameBytes?: unknown } {
  return frame !== null && typeof frame === "object" && "type" in frame && frame.type === "ready";
}

/**
 * Speaks NDJSON with `omp --mode=rpc-ui` over plain pipes (no PTY). Owns the
 * handshake (negotiate v2 on ready, 10 s ready timeout — a bad --mode value
 * hangs silently otherwise), the 1 MiB frame cap (manual line splitting —
 * readline would buffer a delimiter-less line unboundedly), rpc_chunk
 * reassembly, and a drained 8 KiB stderr tail for diagnostics.
 */
export class RpcClient {
  readonly #opts: RpcClientOpts;
  readonly #proc: RpcChildProcess;
  readonly #reassembler: RpcChunkReassembler;
  /** The live observer set; `arm()` swaps the inert warm-boot one for it. */
  #sinks: RpcSinks;
  /** Non-null while deferred: reassembled frames park here until `arm()` replays them. */
  #deferred: RpcFrame[] | null;
  /** Deferred boot saw ready: `arm()` must negotiate before the command rail. */
  #needsNegotiate = false;
  /** Exit-edge observers that fire regardless of arm state (warm-pool invalidation). */
  readonly #deathWatchers: Array<(code: number | null) => void> = [];
  #maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  #pending: Buffer = Buffer.alloc(0);
  #stderrTail = "";
  #readyTimer: NodeJS.Timeout;
  #readySeen = false;
  #dead = false;

  constructor(opts: RpcClientOpts) {
    // The lineage dir must exist before the child starts and before the
    // caller's lineage watcher does (ADR-0003) — the same guarantee
    // spawnOmp makes (pty.ts).
    fs.mkdirSync(opts.lineageDir, { recursive: true });
    this.#opts = opts;
    if (opts.deferArm) {
      this.#sinks = { onFrame: () => {}, onExit: () => {}, onError: () => {} };
      this.#deferred = [];
    } else {
      this.#sinks = {
        onInputFrame: opts.onInputFrame,
        onFrame: opts.onFrame,
        onExit: opts.onExit,
        onError: opts.onError,
      };
      this.#deferred = null;
    }
    this.#reassembler = new RpcChunkReassembler(
      (frame) => this.#onFrame(frame),
      (msg) => this.#fatal(msg),
    );
    const args = ["--mode=rpc-ui", "--cwd", opts.cwd, "--session-dir", opts.lineageDir];
    if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`);
    if (opts.model) args.push("--model", opts.model);
    if (opts.thinking) args.push("--thinking", opts.thinking);
    if (opts.advisor) args.push("--advisor");
    for (const overlay of opts.configOverlays ?? []) args.push("--config", overlay);
    for (const extension of opts.extensions ?? []) args.push("-e", extension);
    if (opts.bare) {
      args.push("--no-session", "--no-tools", "--no-extensions", "--no-lsp", "--no-skills", "--no-rules");
    }
    const env = ompChildEnv(opts.ompPath);
    const spawnProcess = opts.spawnProcess ?? defaultSpawn;
    this.#proc = spawnProcess(opts.ompPath, args, env);
    this.#proc.stdout.on("data", (chunk: Buffer) => this.#onStdout(chunk));
    this.#proc.stderr.on("data", (chunk: Buffer) => this.#onStderr(chunk));
    this.#proc.onSpawnError((err) => this.#fatal(`failed to spawn omp: ${err.message}`));
    this.#proc.onExit((code) => {
      const fatal = this.#dead;
      this.#dead = true;
      clearTimeout(this.#readyTimer);
      if (!fatal && code !== 0 && code !== null) {
        this.#sinks.onError(
          `omp exited with code ${code}; stderr: ${this.#stderrTail.trim() || "(empty)"}`,
        );
      }
      for (const cb of this.#deathWatchers) cb(code);
      this.#sinks.onExit(code);
    });
    this.#readyTimer = setTimeout(() => {
      if (!this.#readySeen) {
        this.#fatal(
          `omp did not speak rpc-ui (no ready frame in 10 s); stderr: ${this.#stderrTail.trim() || "(empty)"}`,
        );
      }
    }, READY_TIMEOUT_MS);
  }

  send(cmd: object): void {
    if (this.#dead) return;
    this.#proc.stdin.write(`${JSON.stringify(cmd)}\n`);
  }

  kill(signal?: NodeJS.Signals): void {
    this.#dead = true;
    clearTimeout(this.#readyTimer);
    this.#deferred = null;
    this.#proc.kill(signal);
  }

  /** True once `arm()` has swapped in real sinks (always true for non-deferred clients). */
  get armed(): boolean {
    return this.#deferred === null;
  }

  get dead(): boolean {
    return this.#dead;
  }

  /** Fires on the exit edge regardless of arm state; may fire more than once, idempotent consumers only. */
  onDeath(cb: (code: number | null) => void): void {
    this.#deathWatchers.push(cb);
  }

  /**
   * Completes a deferred warm boot: swap in the session's observer set, flush
   * every initial command, then replay the frames that parked between ready
   * and arming (boot-time `extension_ui_request`s included — they still need
   * an answer). Callers must have installed their identity fences first.
   */
  arm(sinks: RpcSinks, initialCommands?: object[]): void {
    if (this.#dead) throw new Error("cannot arm a dead rpc-ui client");
    if (this.#deferred === null) throw new Error("rpc-ui client is already armed");
    this.#sinks = sinks;
    if (this.#needsNegotiate) {
      this.#needsNegotiate = false;
      this.send({ type: "negotiate_protocol", protocolVersion: 2 });
    }
    for (const command of initialCommands ?? []) this.send(command);
    const parked = this.#deferred;
    this.#deferred = null;
    // Replay keeps the input-order contract: the answerer sees every parked
    // frame (boot-time extension_ui_requests need answers) before it forwards.
    for (const frame of parked) {
      this.#sinks.onInputFrame?.(frame);
      this.#deliver(frame);
    }
  }

  #onFrame(frame: RpcFrame): void {
    // The input-order hook fires before the ready interception and before
    // forwarding, so a main-process answerer sees every frame first.
    if (this.#deferred === null) this.#sinks.onInputFrame?.(frame);
    if (!this.#readySeen && isReadyFrame(frame)) {
      this.#readySeen = true;
      clearTimeout(this.#readyTimer);
      const max = frame.maxFrameBytes;
      if (typeof max === "number" && Number.isInteger(max) && max > 0) this.#maxFrameBytes = max;
      // Transport concern — the renderer never sees this. A live client
      // negotiates on the ready edge and rides its initialCommands; a
      // deferred warm boot consumes no bytes at all until `arm()` (see the
      // deferArm doc), so the adopted child replays the cold-spawn sequence.
      if (this.#deferred === null) {
        this.send({ type: "negotiate_protocol", protocolVersion: 2 });
        for (const command of this.#opts.initialCommands ?? []) this.send(command);
      } else {
        this.#needsNegotiate = true;
      }
      this.#opts.onBootReady?.();
    }
    if (this.#deferred !== null) {
      // Parked: a deferred client forwards nothing until armed. The ceiling
      // is hygiene only — the pool arms or kills long before this.
      this.#deferred.push(frame);
      if (this.#deferred.length > MAX_PARKED_FRAMES) {
        this.#fatal("deferred rpc-ui client parked too many frames");
      }
      return;
    }
    this.#deliver(frame);
  }

  /** The forwarding tail shared by live delivery and post-arm replay (ready itself is forwarded too; the renderer ignores it). */
  #deliver(frame: RpcFrame): void {
    this.#sinks.onFrame(frame);
  }

  #onStdout(chunk: Buffer): void {
    if (this.#dead) return;
    // Concat-per-chunk is fine at NDJSON rates.
    this.#pending = this.#pending.length ? Buffer.concat([this.#pending, chunk]) : chunk;
    let nl: number;
    while ((nl = this.#pending.indexOf(0x0a)) !== -1) {
      if (nl > this.#maxFrameBytes) return this.#fatal("rpc frame over 1 MiB cap");
      const line = this.#pending.subarray(0, nl).toString("utf8");
      this.#pending = this.#pending.subarray(nl + 1);
      this.#reassembler.pushLine(line);
      if (this.#dead) return;
    }
    if (this.#pending.length > this.#maxFrameBytes) {
      this.#fatal("rpc frame over 1 MiB cap (no newline)");
    }
  }

  #onStderr(chunk: Buffer): void {
    this.#stderrTail = (this.#stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_BYTES);
  }

  #fatal(msg: string): void {
    if (this.#dead) return;
    this.#dead = true;
    clearTimeout(this.#readyTimer);
    this.#proc.kill();
    for (const cb of this.#deathWatchers) cb(null);
    this.#sinks.onError(msg);
  }
}
