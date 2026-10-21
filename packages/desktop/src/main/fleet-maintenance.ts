/**
 * Fleet maintenance owner (fleet remote version update): the member-side
 * registry of in-flight self-updates — an omp binary download into the
 * managed path, or omp-ui staging through the app's own updater. Not a
 * FleetDetachedExecs clone by convenience: a detached exec owns a shell
 * handle it can tree-kill, while a maintenance job is an in-process promise
 * (downloadOmp, electron-updater's downloadUpdate) with no killable child
 * and nothing useful to abort — downloadFileAtomically renames only on
 * success, so there is no cancelled state here. Cap, retention, ownership,
 * and the long-poll discipline follow fleet-detached-exec.ts.
 */
import { randomUUID } from "node:crypto";
import {
  FLEET_EXEC_POLL_WAIT_MAX_MS,
  FLEET_MAINTENANCE_RETAINED,
  FLEET_MAINTENANCE_TIMEOUT_MS,
  type FleetMaintenanceProgress,
  type FleetMaintenanceState,
  type FleetRequester,
  type FleetRung,
  type FleetUpdatePollOutcome,
} from "@omp-ui/core";

export interface FleetMaintenanceRunResult {
  /** What changed, e.g. "omp 18.12.0 → 18.13.1 at ~/.local/share/omp-ui/bin/omp". */
  detail: string;
}

/** What the registry hands the running work: quiet progress + the commit guard. */
export interface FleetMaintenanceContext {
  /** Publish a phase/percentage; shows in every poll and broadcast. */
  report(progress: FleetMaintenanceProgress): void;
  /**
   * Checked by the caller immediately before its irreversible step (the
   * atomic rename). Throws once the job is revoked — the temp file is then
   * abandoned and the previous binary stays in place. Note plainly: a
   * rename that already completed cannot be unwound; this guard only stops
   * work that has not committed yet.
   */
  shouldCommit(): void;
}

export interface FleetMaintenanceDeps {
  now?: () => number;
  uuid?: () => string;
  /** Test seam; defaults to FLEET_MAINTENANCE_TIMEOUT_MS. */
  capMs?: number;
  /** Every state transition wakes this machine's own renderers. */
  broadcast?: () => void;
  /** Called once per job end (succeeded/failed/revoked); FleetServer audits it. */
  onFinish: (rec: FleetMaintenanceRecord) => void;
}

export interface FleetMaintenanceRecord {
  jobId: string;
  requester: FleetRequester;
  rung: FleetRung;
  kind: "omp" | "app";
  state: FleetMaintenanceState;
  progress: FleetMaintenanceProgress | null;
  detail: string | null;
  startedAt: number;
  finishedAt: number | null;
}

export type FleetMaintenanceStartOutcome =
  | { status: "accepted"; jobId: string }
  | { status: "refused"; reason: string };

interface MaintenanceJob {
  rec: FleetMaintenanceRecord;
  timer: NodeJS.Timeout;
  settled: Promise<void>;
  markSettled: () => void;
}

export class FleetMaintenance {
  readonly #deps: FleetMaintenanceDeps;
  readonly #now: () => number;
  readonly #uuid: () => string;
  readonly #capMs: number;
  readonly #jobs = new Map<string, MaintenanceJob>();
  /** Finished jobIds, oldest first (the eviction order). */
  readonly #finished: string[] = [];

  constructor(deps: FleetMaintenanceDeps) {
    this.#deps = deps;
    this.#now = deps.now ?? Date.now;
    this.#uuid = deps.uuid ?? randomUUID;
    this.#capMs = deps.capMs ?? FLEET_MAINTENANCE_TIMEOUT_MS;
  }

  /**
   * Refuses at one running job: replacing a binary concurrently with itself
   * is meaningless, and two dispatchers both get an ordinary refusal that is
   * audited on the verb path. Ownership stamps the starter's instanceId.
   */
  start(
    requester: FleetRequester,
    rung: FleetRung,
    kind: "omp" | "app",
    run: (ctx: FleetMaintenanceContext) => Promise<FleetMaintenanceRunResult>,
  ): FleetMaintenanceStartOutcome {
    for (const job of this.#jobs.values()) {
      if (job.rec.finishedAt === null) {
        return { status: "refused", reason: "a Fleet update is already running on this machine; wait for it to finish" };
      }
    }
    const jobId = this.#uuid();
    const { promise: settled, resolve: markSettled } = Promise.withResolvers<void>();
    const job: MaintenanceJob = {
      rec: {
        jobId,
        requester,
        rung,
        kind,
        state: "running",
        progress: null,
        detail: null,
        startedAt: this.#now(),
        finishedAt: null,
      },
      timer: setTimeout(() => this.#fail(job, `timed out after ${Math.round(this.#capMs / 1000)} s`), this.#capMs),
      settled,
      markSettled,
    };
    this.#jobs.set(jobId, job);
    const ctx: FleetMaintenanceContext = {
      report: (progress) => {
        if (job.rec.finishedAt !== null) return;
        job.rec.progress = progress;
        this.#deps.broadcast?.();
      },
      shouldCommit: () => {
        if (job.rec.state !== "running") {
          throw new Error(`the Fleet update was ${job.rec.state}; nothing was installed`);
        }
      },
    };
    void Promise.resolve()
      .then(run)
      .then(
        (result) => this.#close(job, "succeeded", result.detail),
        (err: unknown) => this.#close(job, "failed", err instanceof Error ? err.message : String(err)),
      );
    return { status: "accepted", jobId };
  }

  /** Same ownership + wait discipline as FleetDetachedExecs.poll. */
  async poll(requester: FleetRequester, jobId: string, waitMs: number): Promise<FleetUpdatePollOutcome> {
    const job = this.#jobs.get(jobId);
    if (job === undefined || job.rec.requester.instanceId !== requester.instanceId) {
      return { status: "refused", reason: `no Fleet update job ${jobId} from ${requester.label} on this machine` };
    }
    const wait = Number.isFinite(waitMs) ? Math.min(FLEET_EXEC_POLL_WAIT_MAX_MS, Math.max(0, Math.floor(waitMs))) : 0;
    if (job.rec.finishedAt === null && wait > 0) {
      const { promise: wake, resolve } = Promise.withResolvers<void>();
      const timer = setTimeout(resolve, wait);
      void job.settled.then(() => {
        clearTimeout(timer);
        resolve();
      });
      await wake;
    }
    const { rec } = job;
    return {
      status: "accepted",
      jobId,
      state: rec.state,
      progress: rec.progress,
      detail: rec.detail,
      elapsedMs: (rec.finishedAt ?? this.#now()) - rec.startedAt,
    };
  }

  /**
   * Ladder dropped below Full control, or the master switch flipped off:
   * every running job becomes "revoked" and stops being reported. There is
   * no child process to signal — the effect of the running work is instead
   * suppressed at its irreversible step via the ctx.shouldCommit guard (the
   * omp install checks it immediately before fs.rename and abandons the
   * temp file; an already-completed rename cannot be unwound, and the app
   * path can never apply anything because apply is a separate gated
   * request).
   */
  revokeWhere(stillAllowed: (requesterId: string) => boolean): void {
    for (const job of this.#jobs.values()) {
      if (job.rec.state === "running" && !stillAllowed(job.rec.requester.instanceId)) {
        this.#close(job, "revoked", "revoked by this machine's owner");
      }
    }
  }

  /** Quit path: mark running jobs revoked; never complete an install on the way out. */
  dispose(): void {
    for (const job of this.#jobs.values()) this.#close(job, "revoked", "the machine quit before the update finished");
  }

  #fail(job: MaintenanceJob, detail: string): void {
    if (job.rec.finishedAt !== null) return;
    // The download promise cannot be aborted (no abort seam in core/download);
    // its late completion is swallowed because the job is already final and
    // shouldCommit() now throws for anything that had not renamed yet.
    this.#close(job, "failed", detail);
  }

  #close(job: MaintenanceJob, state: Exclude<FleetMaintenanceState, "running">, detail: string): void {
    if (job.rec.finishedAt !== null) return;
    clearTimeout(job.timer);
    job.rec.state = state;
    job.rec.detail = detail;
    job.rec.finishedAt = this.#now();
    this.#finished.push(job.rec.jobId);
    while (this.#finished.length > FLEET_MAINTENANCE_RETAINED) this.#jobs.delete(this.#finished.shift()!);
    job.markSettled();
    this.#deps.broadcast?.();
    this.#deps.onFinish({ ...job.rec });
  }
}
