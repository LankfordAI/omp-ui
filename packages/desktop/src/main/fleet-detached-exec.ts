/**
 * Detached exec owner (issue #905, ADR-0065): one command the member keeps
 * running past the call, under a fixed owner cap, polled by execId from the
 * dispatcher that started it. Same fixed shells and environment as the bounded
 * fleet exec; each stream keeps only its last FLEET_EXEC_OUTPUT_MAX bytes.
 */
import { randomUUID } from "node:crypto";
import * as os from "node:os";
import {
  FLEET_DETACHED_EXEC_TIMEOUT_MS,
  FLEET_DETACHED_EXECS_RETAINED,
  FLEET_DETACHED_EXECS_RUNNING_MAX,
  FLEET_EXEC_OUTPUT_MAX,
  FLEET_EXEC_POLL_TAIL,
  FLEET_EXEC_POLL_WAIT_MAX_MS,
  FLEET_EXEC_TIMEOUT_MIN_MS,
  type FleetDetachedExecStartOutcome,
  type FleetDetachedExecState,
  type FleetExecPollOutcome,
  type FleetRequester,
  type FleetRung,
} from "@omp-ui/core";
import {
  launchFleetShell,
  messageOf,
  resolveFleetCwd,
  type FleetCommandDeps,
  type FleetCommandSpec,
  type FleetShellHandle,
} from "./fleet-shell";

export interface DetachedExecDeps {
  commandDeps?: FleetCommandDeps;
  now?: () => number;
  uuid?: () => string;
  /** Test seam; defaults to FLEET_DETACHED_EXEC_TIMEOUT_MS. */
  capMs?: number;
  /** Called once per process end with its final record (FleetServer audits it). */
  onFinish: (rec: DetachedExecRecord) => void;
}

export interface DetachedExecRecord {
  execId: string;
  requester: FleetRequester;
  rung: FleetRung;
  command: string;
  state: FleetDetachedExecState;
  exitCode: number | null;
  startedAt: number;
  finishedAt: number | null;
}

/** The last FLEET_EXEC_OUTPUT_MAX bytes of one stream. */
interface StreamTail {
  chunks: Buffer[];
  length: number;
  droppedFront: boolean;
}

interface DetachedExec {
  rec: DetachedExecRecord;
  handle: FleetShellHandle;
  out: StreamTail;
  err: StreamTail;
  timer: NodeJS.Timeout;
  closed: Promise<void>;
}

function emptyTail(): StreamTail {
  return { chunks: [], length: 0, droppedFront: false };
}

function append(tail: StreamTail, chunk: Buffer): void {
  tail.chunks.push(chunk);
  tail.length += chunk.length;
  while (tail.length > FLEET_EXEC_OUTPUT_MAX) {
    tail.droppedFront = true;
    const excess = tail.length - FLEET_EXEC_OUTPUT_MAX;
    const first = tail.chunks[0]!;
    if (first.length <= excess) {
      tail.chunks.shift();
      tail.length -= first.length;
    } else {
      tail.chunks[0] = first.subarray(excess);
      tail.length -= excess;
    }
  }
}

/** The retained bytes, or only their last `limit` bytes. A split multibyte head decodes to U+FFFD. */
function decode(tail: StreamTail, limit: number): string {
  const all = Buffer.concat(tail.chunks, tail.length);
  return (all.length > limit ? all.subarray(all.length - limit) : all).toString("utf8");
}

export class FleetDetachedExecs {
  readonly #deps: DetachedExecDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #capMs: number;
  readonly #execs = new Map<string, DetachedExec>();
  /** Finished execIds, oldest first (the eviction order). */
  readonly #finished: string[] = [];

  constructor(deps: DetachedExecDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#uuid = deps.uuid ?? randomUUID;
    this.#capMs = deps.capMs ?? FLEET_DETACHED_EXEC_TIMEOUT_MS;
  }

  start(requester: FleetRequester, rung: FleetRung, spec: FleetCommandSpec): FleetDetachedExecStartOutcome {
    let running = 0;
    for (const exec of this.#execs.values()) if (exec.rec.finishedAt === null) running += 1;
    if (running >= FLEET_DETACHED_EXECS_RUNNING_MAX) {
      return {
        status: "refused",
        reason: `${FLEET_DETACHED_EXECS_RUNNING_MAX} detached execs are already running on this machine; poll or cancel one first`,
      };
    }
    const commandDeps = this.#deps.commandDeps ?? {};
    const resolved = resolveFleetCwd(spec.cwd, commandDeps.homeDir ?? os.homedir);
    if (!resolved.ok) return { status: "refused", reason: resolved.reason };
    const timeoutMs =
      spec.timeoutMs === null ? this.#capMs : Math.min(this.#capMs, Math.max(FLEET_EXEC_TIMEOUT_MIN_MS, Math.floor(spec.timeoutMs)));
    const execId = this.#uuid();
    const out = emptyTail();
    const err = emptyTail();
    const handle = launchFleetShell(spec.command, resolved.cwd, commandDeps, (stream, chunk) =>
      append(stream === "stdout" ? out : err, chunk),
    );
    const { promise: closed, resolve: markClosed } = Promise.withResolvers<void>();
    const exec: DetachedExec = {
      rec: {
        execId,
        requester,
        rung,
        command: spec.command,
        state: "running",
        exitCode: null,
        startedAt: this.#now(),
        finishedAt: null,
      },
      handle,
      out,
      err,
      timer: setTimeout(() => this.#stop(exec, "timed-out"), timeoutMs),
      closed,
    };
    this.#execs.set(execId, exec);
    handle.done.then(
      ({ exitCode, spawnError }) => this.#close(exec, exitCode, spawnError, markClosed),
      (e: unknown) => this.#close(exec, null, `could not start the shell: ${messageOf(e)}`, markClosed),
    );
    return { status: "accepted", execId };
  }

  async poll(requester: FleetRequester, execId: string, waitMs: number, cancel: boolean): Promise<FleetExecPollOutcome> {
    const exec = this.#execs.get(execId);
    if (exec === undefined || exec.rec.requester.instanceId !== requester.instanceId) {
      return { status: "refused", reason: `no detached exec ${execId} from ${requester.label} on this machine` };
    }
    if (cancel) this.#stop(exec, "cancelled");
    const wait = Number.isFinite(waitMs) ? Math.min(FLEET_EXEC_POLL_WAIT_MAX_MS, Math.max(0, Math.floor(waitMs))) : 0;
    if (exec.rec.finishedAt === null && wait > 0) {
      const { promise: settled, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, wait);
      void exec.closed.then(() => {
        clearTimeout(timer);
        resolve();
      });
      await settled;
    }
    const { rec, out, err } = exec;
    // Keyed on state, not on close: a cancelled, timed-out, or revoked exec
    // whose process has not closed yet answers as final, so it shows the whole
    // retained tail under the finished truncation rule, matching its state line.
    const running = rec.state === "running";
    const limit = running ? FLEET_EXEC_POLL_TAIL : FLEET_EXEC_OUTPUT_MAX;
    return {
      status: "accepted",
      execId,
      state: rec.state,
      exitCode: rec.exitCode,
      stdout: decode(out, limit),
      stderr: decode(err, limit),
      truncated: out.droppedFront || err.droppedFront || (running && (out.length > limit || err.length > limit)),
      elapsedMs: (rec.finishedAt ?? this.#now()) - rec.startedAt,
    };
  }

  /** Kill (state "revoked") every running exec whose requester instanceId fails `stillAllowed`. */
  revokeWhere(stillAllowed: (requesterId: string) => boolean): void {
    for (const exec of this.#execs.values()) {
      if (exec.rec.state === "running" && !stillAllowed(exec.rec.requester.instanceId)) this.#stop(exec, "revoked");
    }
  }

  /** Kill every running exec (state "cancelled"). Quit path. */
  dispose(): void {
    for (const exec of this.#execs.values()) this.#stop(exec, "cancelled");
  }

  /** The stop reason lands before the kill; a process already stopping keeps its first reason. */
  #stop(exec: DetachedExec, state: Exclude<FleetDetachedExecState, "running" | "exited">): void {
    if (exec.rec.state !== "running") return;
    exec.rec.state = state;
    exec.handle.kill();
  }

  #close(exec: DetachedExec, exitCode: number | null, spawnError: string | null, markClosed: () => void): void {
    clearTimeout(exec.timer);
    const { rec } = exec;
    if (rec.state === "running") rec.state = "exited";
    rec.exitCode = exitCode;
    rec.finishedAt = this.#now();
    if (spawnError !== null) {
      const text = Buffer.from(spawnError, "utf8");
      exec.err = { chunks: [text], length: text.length, droppedFront: false };
    }
    this.#finished.push(rec.execId);
    while (this.#finished.length > FLEET_DETACHED_EXECS_RETAINED) this.#execs.delete(this.#finished.shift()!);
    markClosed();
    this.#deps.onFinish({ ...rec });
  }
}
