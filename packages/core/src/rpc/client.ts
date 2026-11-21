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
  /**
   * Spawn-scoped environment pins merged OVER the sanitized base env at
   * spawn (#1094). Used by private sessions to pin `HINDSIGHT_AUTO_RETAIN`
   * off for this child only — upstream's env-backed setting handle outranks
   * every `--config` layer, so the overlay alone loses to an exported true.
   * Never a mutation of omp-ui's own `process.env`; ordinary spawns pass
   * nothing and keep the user's value.
   */
  childEnv?: NodeJS.ProcessEnv;
  /**
   * Provider-credential overlay (`providerKeyEnv`), merged over the sanitized
   * base env at spawn. `ompChildEnv` strips credentials from inheritance, so
   * this is the only delivery path to the omp child (finding 9, ADR-0010).
   */
  providerEnv?: NodeJS.ProcessEnv;
  /** Extra `-e` extensions — the plan-mode driver (see plan-extension.ts). */
  extensions?: string[];
  /** Commands resolved once on the command rail, after negotiation and before ready is forwarded. */
  initialCommands?: object[] | (() => object[]);
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
/**
 * OMP ≥19 retries a transiently unreachable auth broker during startup for a
 * bounded window before it gives up and exits 1 (upstream
 * `INITIAL_SNAPSHOT_RETRY_BUDGET_MS`, packages/ai/src/auth-broker/discover.ts
 * at v19.0.0). Used only when the child's wait notice omits a parseable
 * budget; the notice states the window, so a changed upstream budget rides
 * through without a repin here.
 */
const AUTH_BROKER_RETRY_BUDGET_MS = 30_000;
/** Slack over the stated budget: boot time before discovery starts, and the child's exit after it spends the window. */
const AUTH_BROKER_WAIT_MARGIN_MS = 15_000;
/**
 * Ceiling for one extended wait, measured from spawn. Deliberately below the
 * renderer's 60 s boot-stall panel (RpcTab BOOT_STALL_MS): the client must
 * render its own verdict — ready or a timeout with the stderr tail — before
 * the panel latches its coarser error.
 */
const AUTH_BROKER_WAIT_CEILING_MS = 55_000;
/** Upstream's once-per-startup stderr notice that the initial broker snapshot is retrying (v19 `authBrokerWaitNotice`). */
const AUTH_BROKER_WAIT_NOTICE = /Waiting for auth broker at\b/;
/** The budget the notice states: `retrying for up to 30s...`. */
const AUTH_BROKER_STATED_BUDGET = /retrying for up to (\d+(?:\.\d+)?)s/;
/**
 * Upstream's startup watchdog names the still-running phase every 10 s
 * (`Still starting after Ns — phase: discoverAuthStorage`). This closes the
 * gap where a black-holed broker delays the FIRST retry failure — and with it
 * the wait notice — past the base deadline: the marker lands at 10 s of boot
 * and proves the child is inside auth discovery, not silently hung.
 */
const AUTH_BROKER_PHASE_MARKER = /Still starting after \d+s .*phase: discoverAuthStorage/;
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

function isReadyFrame(
  frame: unknown,
): frame is { maxFrameBytes?: unknown; supportsBashExcludeFromContext?: unknown } {
  return frame !== null && typeof frame === "object" && "type" in frame && frame.type === "ready";
}

/**
 * Speaks NDJSON with `omp --mode=rpc-ui` over plain pipes (no PTY). Owns the
 * handshake (negotiate v2 on ready, 10 s ready timeout — extended to at most
 * 55 s only while the child's stderr proves an OMP ≥19 auth-broker startup
 * retry (#1230) — a bad --mode value hangs silently otherwise), the 1 MiB
 * frame cap (manual line splitting —
 * readline would buffer a delimiter-less line unboundedly), rpc_chunk
 * reassembly, and a drained 8 KiB stderr tail for diagnostics.
 */
export class RpcClient {
  readonly #opts: RpcClientOpts;
  readonly #proc: RpcChildProcess;
  readonly #reassembler: RpcChunkReassembler;
  /** The live observer set; `arm()` swaps the inert warm-boot one for it. */
  #sinks: RpcSinks;
  /** Non-null until both adopted and ready: boot frames replay only after the command rail. */
  #deferred: RpcFrame[] | null;
  #armed: boolean;
  /** Cold or adopted commands; factories stay unevaluated until ready and armed. */
  #initialCommands: RpcClientOpts["initialCommands"];
  /** Exit-edge observers that fire regardless of arm state (warm-pool invalidation). */
  readonly #deathWatchers: Array<(code: number | null) => void> = [];
  /** stderr line observers; registration replays every complete line still in the tail. */
  readonly #stderrWatchers: Array<(line: string) => void> = [];
  /** The unterminated stderr remainder awaiting its newline. */
  #stderrPartial = "";
  #maxFrameBytes = DEFAULT_MAX_FRAME_BYTES;
  /** True only when the ready frame advertised `supportsBashExcludeFromContext` (issue #1200). */
  #supportsBashExcludeFromContext = false;
  #pending: Buffer = Buffer.alloc(0);
  #stderrTail = "";
  #readyTimer!: NodeJS.Timeout;
  /** Spawn-relative instant the ready wait expires; extended only on broker-retry evidence (#1230). */
  #readyDeadlineMs = READY_TIMEOUT_MS;
  readonly #spawnedAt = Date.now();
  #readySeen = false;
  #dead = false;

  constructor(opts: RpcClientOpts) {
    // The lineage dir must exist before the child starts and before the
    // caller's lineage watcher does (ADR-0003) — the same guarantee
    // spawnOmp makes (pty.ts).
    fs.mkdirSync(opts.lineageDir, { recursive: true });
    this.#opts = opts;
    this.#initialCommands = opts.initialCommands;
    this.#armed = !opts.deferArm;
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
    if (opts.providerEnv !== undefined) Object.assign(env, opts.providerEnv);
    if (opts.childEnv !== undefined) Object.assign(env, opts.childEnv);
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
    this.#armReadyTimer(READY_TIMEOUT_MS);
  }

  /** (Re)arm the ready watchdog for `ms` from now; the timeout reads `#readyDeadlineMs` for its verdict text. */
  #armReadyTimer(ms: number): void {
    clearTimeout(this.#readyTimer);
    this.#readyTimer = setTimeout(() => {
      if (!this.#readySeen) {
        const seconds = Math.round(this.#readyDeadlineMs / 1000);
        this.#fatal(
          `omp did not speak rpc-ui (no ready frame in ${seconds} s); stderr: ${this.#stderrTail.trim() || "(empty)"}`,
        );
      }
    }, ms);
  }

  /**
   * One complete stderr line, before watchers see it: OMP ≥19 prints a
   * once-per-startup `Waiting for auth broker at …; retrying for up to Ns...`
   * notice (and a `Still starting after Ns — phase: discoverAuthStorage`
   * watchdog marker) while its initial snapshot retries. Each is proof the
   * child is waiting on a bounded upstream window, not hung, so push the
   * ready deadline out to cover that window plus margin — capped at
   * {@link AUTH_BROKER_WAIT_CEILING_MS} from spawn so a later-lying stderr
   * (or a repinned bigger budget) can never hold a tab open for long.
   */
  #considerBrokerWaitExtension(line: string): void {
    if (this.#readySeen || this.#dead) return;
    const notice = AUTH_BROKER_WAIT_NOTICE.test(line);
    if (!notice && !AUTH_BROKER_PHASE_MARKER.test(line)) return;
    const stated = AUTH_BROKER_STATED_BUDGET.exec(line);
    const statedMs = stated !== null ? Number(stated[1]) * 1000 : undefined;
    const budgetMs = statedMs !== undefined && statedMs > 0 ? statedMs : AUTH_BROKER_RETRY_BUDGET_MS;
    const elapsed = Date.now() - this.#spawnedAt;
    const candidate = Math.min(elapsed + budgetMs + AUTH_BROKER_WAIT_MARGIN_MS, AUTH_BROKER_WAIT_CEILING_MS);
    if (candidate <= this.#readyDeadlineMs) return;
    this.#readyDeadlineMs = candidate;
    this.#armReadyTimer(candidate - elapsed);
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
    return this.#armed;
  }

  get dead(): boolean {
    return this.#dead;
  }

  /**
   * True only after a ready frame carried `supportsBashExcludeFromContext:
   * true` (omp ≥18.18.1). Send `excludeFromContext` on a bash command only
   * when this is true; older runtimes ignore the field and share the output
   * with model context (issue #1200).
   */
  get supportsBashExcludeFromContext(): boolean {
    return this.#supportsBashExcludeFromContext;
  }

  /** Fires on the exit edge regardless of arm state; may fire more than once, idempotent consumers only. */
  onDeath(cb: (code: number | null) => void): void {
    this.#deathWatchers.push(cb);
  }

  /**
   * Fires once per complete stderr line. Registration first replays the
   * complete lines still held in the stderr tail, so a warm-booted client
   * adopted after its boot warnings were printed (issue #970) still reports
   * them; the tail is bounded, which boot-time output never outgrows.
   */
  onStderrLine(cb: (line: string) => void): void {
    const done = this.#stderrTail.slice(0, this.#stderrTail.length - this.#stderrPartial.length);
    for (const line of done.split("\n")) if (line !== "") cb(line);
    this.#stderrWatchers.push(cb);
  }

  /**
   * Completes a deferred warm boot: swap in the session's observer set and
   * resolve its command rail after negotiation, then replay parked frames
   * (boot-time `extension_ui_request`s included — they still need an answer).
   * Arming before ready holds the rail until ready; factories observe the
   * latest state at that edge. Callers must install identity fences first.
   */
  arm(sinks: RpcSinks, initialCommands?: RpcClientOpts["initialCommands"]): void {
    if (this.#dead) throw new Error("cannot arm a dead rpc-ui client");
    if (this.#armed) throw new Error("rpc-ui client is already armed");
    this.#sinks = sinks;
    this.#initialCommands = initialCommands;
    this.#armed = true;
    if (this.#readySeen) this.#flushDeferred();
  }

  #flushDeferred(): boolean {
    const parked = this.#deferred!;
    this.#deferred = null;
    if (!this.#startCommandRail()) return false;
    // Replay keeps the input-order contract: the answerer sees every parked
    // frame (boot-time extension_ui_requests need answers) before it forwards.
    for (const frame of parked) {
      this.#sinks.onInputFrame?.(frame);
      this.#deliver(frame);
    }
    return true;
  }

  #startCommandRail(): boolean {
    this.send({ type: "negotiate_protocol", protocolVersion: 2 });
    const initialCommands = this.#initialCommands;
    this.#initialCommands = undefined;
    try {
      const commands = typeof initialCommands === "function" ? initialCommands() : initialCommands;
      for (const command of commands ?? []) this.send(command);
      return !this.#dead;
    } catch (err: unknown) {
      this.#fatal(`failed to prepare initial rpc-ui commands: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  #onFrame(frame: RpcFrame): void {
    const parked = this.#deferred;
    if (parked !== null) {
      // Even an adopted child stays parked until ready: boot-time request
      // answerers must not write ahead of negotiation and the command rail.
      parked.push(frame);
      if (parked.length > MAX_PARKED_FRAMES) {
        this.#fatal("deferred rpc-ui client parked too many frames");
        return;
      }
    } else {
      // Input hooks run before forwarding, including for the ready frame.
      this.#sinks.onInputFrame?.(frame);
    }
    if (!this.#readySeen && isReadyFrame(frame)) {
      this.#readySeen = true;
      clearTimeout(this.#readyTimer);
      const max = frame.maxFrameBytes;
      if (typeof max === "number" && Number.isInteger(max) && max > 0) this.#maxFrameBytes = max;
      // Exact `true` only: an absent or non-boolean field means an older omp
      // would silently share excluded output (issue #1200).
      this.#supportsBashExcludeFromContext = frame.supportsBashExcludeFromContext === true;
      if (this.#armed) {
        if (parked !== null ? !this.#flushDeferred() : !this.#startCommandRail()) return;
      }
      this.#opts.onBootReady?.();
      if (this.#dead) return;
    }
    // arm() may have replayed this very frame from onBootReady; a frame
    // that entered the parked queue never also takes the live delivery tail.
    if (parked === null) this.#deliver(frame);
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
    const text = chunk.toString("utf8");
    this.#stderrTail = (this.#stderrTail + text).slice(-STDERR_TAIL_BYTES);
    const lines = (this.#stderrPartial + text).split("\n");
    this.#stderrPartial = lines.pop()!.slice(-STDERR_TAIL_BYTES);
    for (const line of lines) {
      if (line === "") continue;
      this.#considerBrokerWaitExtension(line);
      for (const cb of this.#stderrWatchers) cb(line);
    }
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
