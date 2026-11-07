import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { ompChildEnv } from "./omp-process";
import { resolveStatsSource } from "./stats-source";
import type { StatsSourceInfo, StatsSyncMode, StatsSyncRun, StatsSyncState } from "./types";

export interface StatsCollectorDependencies {
  getOmpPath(): string | null;
  getEnv(): NodeJS.ProcessEnv;
  /** The same neutral host cwd used by overview source resolution. */
  cwd: string;
  spawn?: typeof spawn;
  now?: () => number;
  resolveSource?: (env: NodeJS.ProcessEnv, cwd: string) => StatsSourceInfo;
}

const STALE_MS = 60_000;
const DEADLINE_MS = 10 * 60_000;
const TERM_GRACE_MS = 3_000;
const KILL_GRACE_MS = 2_000;
const STDERR_BYTES = 32 * 1024;

interface ActiveSync {
  run: StatsSyncRun;
  source: StatsSourceInfo;
  env: NodeJS.ProcessEnv;
  child: ChildProcess | null;
  stopping: "failed" | "cancelled" | null;
  closed: boolean;
  deadline?: NodeJS.Timeout;
  killTimer?: NodeJS.Timeout;
  reapTimer?: NodeJS.Timeout;
  stderr: Buffer;
  stderrLength: number;
  settlement: Promise<void>;
  settle(): void;
}

/** One host-owned, bounded, noninteractive OMP writer shared by every client. */
export class StatsCollector {
  private state: StatsSyncState = {
    source: null,
    sourceError: null,
    run: null,
    lastSuccessfulSyncAt: null,
  };
  private active: ActiveSync | null = null;
  private lastAttemptAt: number | null = null;
  private disposed = false;
  private readonly now: () => number;

  constructor(private readonly deps: StatsCollectorDependencies) {
    this.now = deps.now ?? Date.now;
  }

  private snapshot(): StatsSyncState {
    return {
      ...this.state,
      source: this.state.source ? { ...this.state.source } : null,
      run: this.state.run ? { ...this.state.run } : null,
    };
  }

  private refreshSource(): NodeJS.ProcessEnv | null {
    try {
      const env = { ...this.deps.getEnv() };
      const source = this.deps.resolveSource
        ? this.deps.resolveSource(env, this.deps.cwd)
        : resolveStatsSource({ env, cwd: this.deps.cwd });
      const previous = this.state.source;
      if (
        !previous || previous.profile !== source.profile ||
        previous.databasePath !== source.databasePath ||
        previous.sessionsRoot !== source.sessionsRoot || previous.archiveRoot !== source.archiveRoot
      ) {
        this.state.run = null;
        this.state.lastSuccessfulSyncAt = null;
        this.lastAttemptAt = null;
      }
      this.state.source = { ...source };
      this.state.sourceError = null;
      return env;
    } catch {
      if (this.state.source !== null) {
        this.state.run = null;
        this.state.lastSuccessfulSyncAt = null;
        this.lastAttemptAt = null;
      }
      this.state.source = null;
      this.state.sourceError = "The OMP stats source is invalid.";
      return null;
    }
  }

  status(): StatsSyncState {
    if (!this.active && !this.disposed) this.refreshSource();
    return this.snapshot();
  }

  start(mode: StatsSyncMode): StatsSyncState {
    if (this.active || this.disposed) return this.snapshot();
    const env = this.refreshSource();
    if (!env || !this.state.source) return this.snapshot();
    const startedAt = this.now();
    if (mode === "if-stale" && this.lastAttemptAt !== null && startedAt - this.lastAttemptAt < STALE_MS) {
      return this.snapshot();
    }
    this.lastAttemptAt = startedAt;
    const run: StatsSyncRun = {
      id: randomUUID(), phase: "running", startedAt, finishedAt: null, error: null, exitCode: null,
    };
    let settle!: () => void;
    // Executor form: core's ES2022 lib predates Promise.withResolvers.
    const settlement = new Promise<void>((resolve) => { settle = resolve; });
    const active: ActiveSync = {
      run, source: { ...this.state.source }, env, child: null, stopping: null, closed: false,
      stderr: Buffer.alloc(STDERR_BYTES), stderrLength: 0, settlement, settle,
    };
    // Reserve synchronously, before binary lookup/spawn or any deferred work.
    this.state.run = run;
    this.active = active;
    queueMicrotask(() => this.launch(active));
    return this.snapshot();
  }

  private launch(active: ActiveSync): void {
    if (this.active !== active || active.closed) return;
    try {
      const ompPath = this.deps.getOmpPath();
      if (!ompPath) {
        this.finish(active, "failed", "OMP is not installed.", null);
        return;
      }
      const env = ompChildEnv(ompPath, active.env);
      env.NO_COLOR = "1";
      env.FORCE_COLOR = "0";
      const child = (this.deps.spawn ?? spawn)(ompPath, ["stats", "--summary"], {
        cwd: this.deps.cwd, env, shell: false, windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      active.child = child;
      child.stdout?.on("error", () => this.stop(active, "failed", "OMP stats sync output could not be read."));
      child.stderr?.on("error", () => this.stop(active, "failed", "OMP stats sync output could not be read."));
      child.stdout?.resume();
      child.stderr?.on("data", (chunk: Buffer | string) => {
        const remaining = STDERR_BYTES - active.stderrLength;
        if (remaining <= 0) return;
        const bytes = typeof chunk === "string" ? Buffer.from(chunk.slice(0, remaining)) : chunk;
        active.stderrLength += bytes.copy(active.stderr, active.stderrLength, 0, remaining);
      });
      child.on("error", () => {
        this.stop(active, "failed", "OMP stats sync could not run.");
      });
      child.once("close", (code: number | null, signal: NodeJS.Signals | null) => {
        if (active.closed) return;
        if (active.stopping) {
          this.finish(active, active.stopping, active.run.error, code);
        } else if (code !== 0 || signal !== null) {
          this.finish(active, "failed", "OMP stats sync exited unsuccessfully.", code);
        } else {
          this.probeAndFinish(active);
        }
      });
      active.deadline = setTimeout(() => {
        this.stop(active, "failed", "OMP stats sync timed out.");
      }, DEADLINE_MS);
    } catch {
      if (active.child) this.stop(active, "failed", "OMP stats sync could not run.");
      else this.finish(active, "failed", "OMP stats sync could not start.", null);
    }
  }

  private probeAndFinish(active: ActiveSync): void {
    let db: DatabaseSync | undefined;
    let compatible = false;
    try {
      db = new DatabaseSync(active.source.databasePath, { readOnly: true });
      const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get();
      if (table) {
        db.prepare(`SELECT session_file, entry_id, folder, model, provider, timestamp,
          stop_reason, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          total_tokens, cost_total FROM messages LIMIT 0`).all();
        compatible = true;
      }
    } catch { /* Foreign, absent, locked, and corrupt targets all fail safely. */ }
    finally {
      try { db?.close(); } catch { compatible = false; }
    }
    this.finish(active, compatible ? "succeeded" : "failed",
      compatible ? null : "OMP stats sync did not produce a readable stats database.", 0);
  }

  private stop(active: ActiveSync, outcome: "failed" | "cancelled", error: string): void {
    if (active.closed || active.stopping) return;
    active.stopping = outcome;
    active.run.phase = "stopping";
    active.run.error = error;
    clearTimeout(active.deadline);
    if (!active.child) {
      this.finish(active, outcome, error, null);
      return;
    }
    // Cancellation is synchronous; callers need not await disposal to send TERM.
    try { active.child.kill("SIGTERM"); } catch { /* still require close */ }
    if (active.closed) return;
    active.killTimer = setTimeout(() => {
      try { active.child?.kill("SIGKILL"); } catch { /* still require close */ }
      if (active.closed) return;
      active.reapTimer = setTimeout(() => {
        // Do not free the slot without close. A late close remains failure or
        // cancellation, never a successful run, even if it reports code zero.
        active.run.error = "OMP stats sync has not closed after stopping.";
        active.settle();
      }, KILL_GRACE_MS);
    }, TERM_GRACE_MS);
  }

  private finish(
    active: ActiveSync,
    phase: "succeeded" | "failed" | "cancelled",
    error: string | null,
    exitCode: number | null,
  ): void {
    if (active.closed) return;
    active.closed = true;
    clearTimeout(active.deadline);
    clearTimeout(active.killTimer);
    clearTimeout(active.reapTimer);
    active.run.phase = phase;
    active.run.error = error;
    active.run.exitCode = exitCode;
    active.run.finishedAt = this.now();
    active.stderr.fill(0);
    if (phase === "succeeded") this.state.lastSuccessfulSyncAt = active.run.finishedAt;
    if (this.active === active) this.active = null;
    active.settle();
  }

  dispose(): Promise<void> {
    this.disposed = true;
    const active = this.active;
    if (!active) return Promise.resolve();
    this.stop(active, "cancelled", "OMP stats sync was cancelled.");
    return active.settlement;
  }
}
