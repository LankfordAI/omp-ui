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
  advisor?: boolean;
  /** Extra `--config` overlays — the advisor-model pin (see advisor-overlay.ts). */
  configOverlays?: string[];
  /** Extra `-e` extensions — the plan-mode driver (see plan-extension.ts). */
  extensions?: string[];
  /** Commands sent once, immediately after protocol negotiation and before ready is forwarded. */
  initialCommands?: object[];
  /**
   * Credential errand, not a session: `--no-session` plus every discovery
   * switch off. Verified against omp v18.1.0 to still emit `ready` and
   * answer `login`.
   */
  bare?: boolean;
  onFrame: (frame: RpcFrame) => void;
  onExit: (code: number | null) => void;
  onError: (msg: string) => void;
  /** Test seam — defaults to child_process.spawn over pipes. */
  spawnProcess?: RpcSpawnFn;
}

const DEFAULT_MAX_FRAME_BYTES = 1_048_576;
const READY_TIMEOUT_MS = 10_000;
const STDERR_TAIL_BYTES = 8192;

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
    this.#reassembler = new RpcChunkReassembler(
      (frame) => this.#onFrame(frame),
      (msg) => this.#fatal(msg),
    );
    const args = ["--mode=rpc-ui", "--cwd", opts.cwd, "--session-dir", opts.lineageDir];
    if (opts.resumeSessionId) args.push(`--resume=${opts.resumeSessionId}`);
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
        this.#opts.onError(
          `omp exited with code ${code}; stderr: ${this.#stderrTail.trim() || "(empty)"}`,
        );
      }
      this.#opts.onExit(code);
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
    this.#proc.kill(signal);
  }

  #onFrame(frame: RpcFrame): void {
    if (!this.#readySeen && isReadyFrame(frame)) {
      this.#readySeen = true;
      clearTimeout(this.#readyTimer);
      const max = frame.maxFrameBytes;
      if (typeof max === "number" && Number.isInteger(max) && max > 0) this.#maxFrameBytes = max;
      // Transport concern — the renderer never sees this.
      this.send({ type: "negotiate_protocol", protocolVersion: 2 });
      for (const command of this.#opts.initialCommands ?? []) this.send(command);
    }
    // ready itself is forwarded too; the renderer ignores it.
    this.#opts.onFrame(frame);
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
    this.#opts.onError(msg);
  }
}
