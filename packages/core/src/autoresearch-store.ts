import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { git } from "./git";
import { resolveProfile } from "./paths";
import type {
  CheckoutExperiments,
  ExperimentProgress,
  ExperimentRecord,
  ExperimentRun,
  ExperimentSource,
} from "./types";

// Direct SQLite reads of omp's per-project autoresearch DB — the run-history
// half of the Lab (ADR-0030, issue #559), exactly like memory-store.ts reads
// mnemopi's banks: transport-agnostic Node, read-only connections opened per
// call and closed in finally because omp's own sessions write these files
// concurrently. Paths, key derivation, DDL and status enums are a verified
// port of omp v18.2.4; omp-ui never writes the DB and never re-implements the
// loop. Live mode/goal state rides the setStatus bridge instead
// (autoresearch.ts).

const SESSIONS_SQL =
  "SELECT id, name, goal, primary_metric, metric_unit, direction, preferred_command, branch, baseline_commit, current_segment, max_iterations, scope_paths_json, off_limits_json, constraints_json, secondary_metrics_json, notes, created_at, closed_at FROM sessions ORDER BY created_at DESC";

const RUNS_SQL =
  "SELECT id, segment, command, started_at, completed_at, duration_ms, exit_code, timed_out, parsed_primary, status, description, metric, commit_hash, modified_paths_json, scope_deviations_json, justification, flagged, flagged_reason, logged_at, abandoned_at, log_path FROM runs WHERE session_id = ? ORDER BY id";

const RUN_STATUSES: readonly NonNullable<ExperimentRun["status"]>[] = [
  "keep",
  "discard",
  "crash",
  "checks_failed",
];

/**
 * omp's state root: `$XDG_STATE_HOME/omp` on Linux/macOS when that dir (or its
 * profile subdir) ALREADY EXISTS, else `~/.omp` — the same existence gate
 * memory-store.ts ports for mnemopi, applied to the root itself. Profiles nest
 * under `profiles/<name>` in either branch.
 */
export function autoresearchStateDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const profile = resolveProfile(env);
  const tail = profile === undefined ? [] : ["profiles", profile];
  if ((platform === "linux" || platform === "darwin") && env.XDG_STATE_HOME) {
    const candidate = path.join(env.XDG_STATE_HOME, "omp", ...tail);
    if (fs.existsSync(candidate)) return candidate;
  }
  return path.join(home, ".omp", ...tail);
}

/**
 * `<dir>/<key>.db`, where dir is `$OMP_AUTORESEARCH_DB_DIR` (omp's own test
 * override) or `<stateDir>/autoresearch`.
 */
export function autoresearchDbPath(key: string, env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.OMP_AUTORESEARCH_DB_DIR || path.join(autoresearchStateDir(env), "autoresearch");
  return path.join(dir, `${key}.db`);
}

/** omp's DB file stem for a checkout root: `--home-u-repo--` for `/home/u/repo`. */
export function autoresearchProjectKey(root: string): string {
  return `--${root.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

/**
 * The keys a checkout's DB may live under, most likely first: omp keys by the
 * git toplevel, so that comes first when `cwd` is inside a repo; the cwd's own
 * key follows (and is the only candidate outside a repo). Deduplicated.
 */
export async function autoresearchCandidateKeys(cwd: string): Promise<string[]> {
  const keys: string[] = [];
  try {
    const toplevel = path.resolve((await git(cwd, ["rev-parse", "--show-toplevel"])).trim());
    keys.push(autoresearchProjectKey(toplevel));
  } catch {
    // not a repo: only the cwd key applies
  }
  const own = autoresearchProjectKey(cwd);
  if (!keys.includes(own)) keys.push(own);
  return keys;
}

/** Numeric column → number; sqlite hands back a bigint for integers past 2^53. */
function int(value: SQLOutputValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

function text(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** A `*_json` column: its string entries, or [] when absent or malformed. */
function stringList(value: SQLOutputValue | undefined): string[] {
  if (typeof value !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function isRunStatus(value: unknown): value is NonNullable<ExperimentRun["status"]> {
  return typeof value === "string" && (RUN_STATUSES as readonly string[]).includes(value);
}

function toRun(row: Record<string, SQLOutputValue>): ExperimentRun {
  const logPath = text(row.log_path);
  return {
    id: int(row.id) ?? 0,
    segment: int(row.segment) ?? 1,
    command: text(row.command) ?? "",
    startedAt: int(row.started_at) ?? 0,
    completedAt: int(row.completed_at),
    durationMs: int(row.duration_ms),
    exitCode: int(row.exit_code),
    timedOut: (int(row.timed_out) ?? 0) !== 0,
    parsedPrimary: int(row.parsed_primary),
    metric: int(row.metric),
    status: isRunStatus(row.status) ? row.status : null,
    abandoned: row.abandoned_at !== null,
    description: text(row.description),
    commitHash: text(row.commit_hash),
    modifiedPaths: stringList(row.modified_paths_json),
    scopeDeviations: stringList(row.scope_deviations_json),
    justification: text(row.justification),
    flagged: (int(row.flagged) ?? 0) !== 0,
    flaggedReason: text(row.flagged_reason),
    loggedAt: int(row.logged_at),
    hasLog: logPath !== null && logPath !== "",
  };
}

/**
 * Current-segment aggregates, following omp's own readers (v18.2.4): progress
 * counts logged runs (`status IS NOT NULL`), the pending run is the newest
 * unlogged, unabandoned one, baseline is the first kept unflagged run of the
 * segment and best is the kept unflagged extreme. `runs` is id-ordered, so
 * "first" is first seen and `best` keeps the first of tied metrics. Flagged
 * runs count toward the totals but never toward baseline, best, or the series.
 */
function progressOf(
  runs: readonly ExperimentRun[],
  segment: number,
  direction: ExperimentRecord["direction"],
): ExperimentProgress {
  const progress: ExperimentProgress = {
    segmentRuns: 0,
    kept: 0,
    discarded: 0,
    crashed: 0,
    checksFailed: 0,
    baseline: null,
    best: null,
    pendingRunId: null,
    lastActivityAt: null,
    metricSeries: [],
  };
  for (const run of runs) {
    if (run.segment !== segment) continue;
    switch (run.status) {
      case "keep":
        progress.kept += 1;
        break;
      case "discard":
        progress.discarded += 1;
        break;
      case "crash":
        progress.crashed += 1;
        break;
      case "checks_failed":
        progress.checksFailed += 1;
        break;
      case null:
        if (!run.abandoned) progress.pendingRunId = run.id;
        break;
    }
    if (run.status !== null) progress.segmentRuns += 1;
    for (const at of [run.startedAt, run.loggedAt]) {
      if (at !== null && (progress.lastActivityAt === null || at > progress.lastActivityAt)) {
        progress.lastActivityAt = at;
      }
    }
    if (run.flagged || run.metric === null) continue;
    const point = { runId: run.id, metric: run.metric };
    progress.metricSeries.push({ ...point, kept: run.status === "keep" });
    if (run.status !== "keep") continue;
    progress.baseline ??= point;
    if (
      progress.best === null ||
      (direction === "lower" ? run.metric < progress.best.metric : run.metric > progress.best.metric)
    ) {
      progress.best = point;
    }
  }
  return progress;
}

function toRecord(db: DatabaseSync, row: Record<string, SQLOutputValue>): ExperimentRecord {
  const id = int(row.id) ?? 0;
  const direction = row.direction === "higher" ? "higher" : "lower";
  const currentSegment = int(row.current_segment) ?? 1;
  return {
    id,
    name: text(row.name) ?? "",
    goal: text(row.goal),
    primaryMetric: text(row.primary_metric) ?? "",
    metricUnit: text(row.metric_unit) ?? "",
    direction,
    preferredCommand: text(row.preferred_command),
    branch: text(row.branch),
    baselineCommit: text(row.baseline_commit),
    currentSegment,
    maxIterations: int(row.max_iterations),
    scopePaths: stringList(row.scope_paths_json),
    offLimits: stringList(row.off_limits_json),
    constraints: stringList(row.constraints_json),
    secondaryMetrics: stringList(row.secondary_metrics_json),
    notes: text(row.notes) ?? "",
    createdAt: int(row.created_at) ?? 0,
    closedAt: int(row.closed_at),
    progress: progressOf(db.prepare(RUNS_SQL).all(id).map(toRun), currentSegment, direction),
  };
}

/** `sqlite_master` probe, as memory-store.ts: a foreign file is a state, not a throw. */
const SCHEMA_PROBE_SQL =
  "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name IN ('sessions', 'runs') LIMIT 1";

/**
 * Every experiment recorded for a checkout, newest first, read from the first
 * candidate DB that exists. NEVER throws: no DB → `source: null`; a file that
 * is neither omp's schema nor readable lands in `error` with no experiments.
 */
export async function readCheckoutExperiments(
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CheckoutExperiments> {
  let source: ExperimentSource | null = null;
  for (const key of await autoresearchCandidateKeys(cwd)) {
    const dbPath = autoresearchDbPath(key, env);
    if (fs.existsSync(dbPath)) {
      source = { cwd, key, dbPath };
      break;
    }
  }
  if (source === null) return { source: null, experiments: [], error: null };
  let db: DatabaseSync | undefined;
  try {
    const opened = new DatabaseSync(source.dbPath, { readOnly: true });
    db = opened;
    if (opened.prepare(SCHEMA_PROBE_SQL).get() === undefined) {
      return { source, experiments: [], error: "not an autoresearch database" };
    }
    const experiments = opened.prepare(SESSIONS_SQL).all().map((row) => toRecord(opened, row));
    return { source, experiments, error: null };
  } catch (error) {
    return { source, experiments: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}

/**
 * Every run of one experiment, id-ordered. Throws on any sqlite failure
 * (missing file, foreign schema): the channel handler wraps it into
 * `ExperimentDetail.error`.
 */
export function readExperimentRuns(dbPath: string, experimentId: number): ExperimentRun[] {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return db.prepare(RUNS_SQL).all(experimentId).map(toRun);
  } finally {
    db?.close();
  }
}

/** A run's `log_path` as omp recorded it, or null when unset, unknown, or unreadable. */
export function readExperimentLogPath(dbPath: string, runId: number): string | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const logPath = text(db.prepare("SELECT log_path FROM runs WHERE id = ?").get(runId)?.log_path);
    return logPath === "" ? null : logPath;
  } catch {
    return null;
  } finally {
    db?.close();
  }
}
