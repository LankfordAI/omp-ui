// The background-jobs wire contract (issue #835, ADR-0054). Pure — zero
// runtime imports — because the renderer imports it directly via the
// @omp-ui/core/async-jobs subpath, exactly like vibe.ts. The generating half
// lives in async-jobs-extension.ts and interpolates these same constants, so
// the publisher and the parser can never drift.
//
// omp keeps background jobs in an in-process async job manager that no rpc
// frame carries (verified on omp/18.8.9: get_state only says
// hasPendingAsyncWork). The bridge reads AgentSession.getAsyncJobSnapshot /
// inspectAsyncJob and cancels through cancelAsyncJob — the same calls omp's
// own `/jobs` and `/jobs kill` make.

/** setStatus key the generated bridge publishes on. Routed, never rendered raw. */
export const ASYNC_JOBS_STATUS_KEY = "omp-ui:async-jobs";

/** Hidden slash command: bare = arm + force-publish; `kill <json>` = cancel. */
export const ASYNC_JOBS_COMMAND = "omp-ui-async-jobs";
export const ASYNC_JOBS_KILL_ARG = "kill";

/** Hard cap on the serialized snapshot (UTF-8 bytes). */
export const ASYNC_JOBS_STATUS_BYTE_LIMIT = 256 * 1024;
/** Poll cadence; a publish only leaves the process when the digest changed. */
export const ASYNC_JOBS_POLL_MS = 1_500;
/** Finished jobs requested from omp (omp's own /jobs asks for 5). */
export const ASYNC_JOBS_RECENT_LIMIT = 10;
/** Output tail per job, then the fallback rung when the snapshot is too big. */
export const ASYNC_JOBS_OUTPUT_TAIL_CHARS = 2_000;
export const ASYNC_JOBS_SHORT_TAIL_CHARS = 200;
export const ASYNC_JOBS_LABEL_CHAR_LIMIT = 512;
export const ASYNC_JOBS_COMMAND_CHAR_LIMIT = 1_024;

/** omp's AsyncJobManager statuses (register/cancel paths in omp/18.8.9). */
export const ASYNC_JOB_STATUSES = ["running", "completed", "failed", "cancelled"] as const;
export type AsyncJobStatus = (typeof ASYNC_JOB_STATUSES)[number];

export interface AsyncJob {
  /** omp's job id: `bg_N`, a task agent id, or a caller-chosen id. */
  id: string;
  /** omp's job type — "bash", "task", "eval", "advisor", "yield", … An open set. */
  type: string;
  status: AsyncJobStatus;
  label: string;
  command: string | null;
  cwd: string | null;
  /** Epoch ms. Doubles as the kill guard against omp's `bg_N` id reuse. */
  startTime: number;
  endTime: number | null;
  /** Set for task jobs: the subagent id the Agents roster uses. */
  agentId: string | null;
  /** Live process ids; empty once the job stopped running. */
  pids: number[];
  exitCode: number | null;
  /** Last ASYNC_JOBS_OUTPUT_TAIL_CHARS of captured output, control chars stripped. */
  outputTail: string;
  outputTruncated: boolean;
}

export interface AsyncJobsKillRequest {
  requestId: string;
  processKey: string;
  /** null = every running job (omp's `/jobs kill all`). */
  jobId: string | null;
  /** The targeted job's startTime; null exactly when jobId is null. */
  startTime: number | null;
}

export interface AsyncJobsKillResult {
  requestId: string;
  ok: boolean;
  cancelled: string[];
  text: string;
}

export interface AsyncJobsSnapshot {
  version: 1;
  processKey: string;
  revision: number;
  available: boolean;
  unavailable: string | null;
  /** inspectAsyncJob exists: command/cwd/pids/exit/output are populated. */
  canInspect: boolean;
  /** cancelAsyncJob exists: kill affordances may render. */
  canCancel: boolean;
  running: AsyncJob[];
  recent: AsyncJob[];
  /** Set only on the publish that answers a kill request. */
  result: AsyncJobsKillResult | null;
}

/** The bare arm prompt that binds the bridge and force-republishes. */
export function asyncJobsArmMessage(): string {
  return `/${ASYNC_JOBS_COMMAND}`;
}

/** The hidden kill prompt: `kill <json>` of an AsyncJobsKillRequest. */
export function asyncJobsKillMessage(request: AsyncJobsKillRequest): string {
  return `/${ASYNC_JOBS_COMMAND} ${ASYNC_JOBS_KILL_ARG} ${JSON.stringify(request)}`;
}

/** One wire job; null when any field is wrong. The wire is untrusted by definition. */
function readJob(value: unknown): AsyncJob | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const { id, type, status, label, command, cwd, startTime, endTime, agentId, pids, exitCode, outputTail, outputTruncated } =
    record;
  if (typeof id !== "string" || id === "") return null;
  if (typeof type !== "string" || type === "") return null;
  if (
    typeof status !== "string" ||
    !(ASYNC_JOB_STATUSES as readonly string[]).includes(status)
  ) {
    return null;
  }
  if (typeof label !== "string") return null;
  if (
    !(command === null || typeof command === "string") ||
    !(cwd === null || typeof cwd === "string") ||
    !(agentId === null || typeof agentId === "string")
  ) {
    return null;
  }
  if (typeof startTime !== "number" || !Number.isFinite(startTime)) return null;
  if (!(endTime === null || (typeof endTime === "number" && Number.isFinite(endTime)))) return null;
  if (!Array.isArray(pids) || !pids.every((pid) => Number.isInteger(pid))) return null;
  if (!(exitCode === null || (typeof exitCode === "number" && Number.isFinite(exitCode)))) return null;
  if (typeof outputTail !== "string" || typeof outputTruncated !== "boolean") return null;
  return {
    id,
    type,
    status: status as AsyncJobStatus,
    label,
    command: command as string | null,
    cwd: cwd as string | null,
    startTime,
    endTime: endTime as number | null,
    agentId: agentId as string | null,
    pids: pids as number[],
    exitCode: exitCode as number | null,
    outputTail,
    outputTruncated,
  };
}

/** One wire job list; null when the array or any member is wrong. */
function readJobs(value: unknown): AsyncJob[] | null {
  if (!Array.isArray(value)) return null;
  const jobs: AsyncJob[] = [];
  for (const raw of value) {
    const job = readJob(raw);
    if (job === null) return null;
    jobs.push(job);
  }
  return jobs;
}

/** null result is legal; a non-null value must be a complete result; undefined is malformed. */
function readResult(value: unknown): AsyncJobsKillResult | null | undefined {
  if (value === null) return null;
  if (value === undefined || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const { requestId, ok, cancelled, text } = record;
  if (typeof requestId !== "string" || requestId === "") return undefined;
  if (typeof ok !== "boolean" || typeof text !== "string") return undefined;
  if (!Array.isArray(cancelled) || !cancelled.every((id) => typeof id === "string")) return undefined;
  return { requestId, ok, cancelled: cancelled as string[], text };
}

/** Parses the JSON published on ASYNC_JOBS_STATUS_KEY; null when malformed in any part. */
export function parseAsyncJobsSnapshot(text: string | undefined): AsyncJobsSnapshot | null {
  if (!text) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const record = parsed as Record<string, unknown>;
  if (record.version !== 1) return null;
  const { processKey, revision, available, unavailable, canInspect, canCancel } = record;
  if (typeof processKey !== "string" || processKey === "") return null;
  if (typeof revision !== "number" || !Number.isInteger(revision) || revision < 1) return null;
  if (typeof available !== "boolean") return null;
  if (!(unavailable === null || typeof unavailable === "string")) return null;
  if (typeof canInspect !== "boolean" || typeof canCancel !== "boolean") return null;
  const running = readJobs(record.running);
  const recent = readJobs(record.recent);
  const result = readResult(record.result);
  if (running === null || recent === null || result === undefined) return null;
  return {
    version: 1,
    processKey,
    revision,
    available,
    unavailable: unavailable as string | null,
    canInspect,
    canCancel,
    running,
    recent,
    result,
  };
}
