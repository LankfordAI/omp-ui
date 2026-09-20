import * as fs from "node:fs";
import * as path from "node:path";
import {
  autoresearchStateDir,
  isWithin,
  readCheckoutExperiments,
  readExperimentLogPath,
  readExperimentRuns,
  type ExperimentDetail,
  type OwnedSessionRecord,
  type ProjectExperiments,
  type RunLogResult,
} from "@omp-ui/core";

/** Bytes of a run log served to the renderer; the rest is reported as truncated. */
const RUN_LOG_BYTE_LIMIT = 256 * 1024;

/**
 * A project's experiments across every checkout omp-ui knows for it: the
 * project root plus each owned worktree session's checkout (issue #559).
 * Read-only over omp's per-project autoresearch DBs (ADR-0030); a checkout
 * whose read fails reports the error in its own row instead of rejecting.
 */
export async function readProjectExperiments(
  sessions: readonly OwnedSessionRecord[],
  projectCwd: string,
): Promise<ProjectExperiments> {
  // A `.git` FILE counts: linked worktrees keep their gitdir pointer there.
  const repo: ProjectExperiments["repo"] = fs.existsSync(path.join(projectCwd, ".git"))
    ? "git"
    : fs.existsSync(path.join(projectCwd, ".jj"))
      ? "jj-only"
      : "none";
  const own = sessions.filter((record) => record.projectCwd === projectCwd);
  const targets: Array<{ cwd: string; tabId: string | null; branch: string | null }> = [
    { cwd: projectCwd, tabId: null, branch: null },
  ];
  for (const record of own) {
    if (record.worktree !== null) {
      targets.push({ cwd: record.worktree.path, tabId: record.tabId, branch: record.worktree.branch });
    }
  }
  const results = await Promise.all(targets.map((target) => readCheckoutExperiments(target.cwd)));
  // Two checkouts can key to one DB (a worktree whose toplevel resolves to
  // the project's); the first listing — the project checkout — keeps it.
  const seen = new Set<string>();
  const checkouts: ProjectExperiments["checkouts"] = [];
  for (let i = 0; i < targets.length; i += 1) {
    const result = results[i];
    const dbPath = result.source?.dbPath;
    if (dbPath !== undefined) {
      if (seen.has(dbPath)) continue;
      seen.add(dbPath);
    }
    checkouts.push({ ...targets[i], result });
  }
  const knownBranches = new Set<string>();
  for (const checkout of checkouts) {
    for (const experiment of checkout.result.experiments) {
      if (experiment.branch !== null) knownBranches.add(experiment.branch);
    }
  }
  const pendingLaunches: ProjectExperiments["pendingLaunches"] = [];
  for (const record of own) {
    if (record.experiment === null) continue;
    // A null branch never matches: the launch stays pending until a checkout
    // links it, since a detached checkout's row carries no branch to match on.
    const branch = record.worktree?.branch ?? record.experiment.launchedBranch;
    if (branch !== null && knownBranches.has(branch)) continue;
    pendingLaunches.push({ tabId: record.tabId, experiment: record.experiment });
  }
  return { projectCwd, repo, checkouts, pendingLaunches };
}

/** One experiment with its run history, from the checkout `tabId` names (null = the project checkout). */
export async function readExperimentDetail(
  sessions: readonly OwnedSessionRecord[],
  projectCwd: string,
  tabId: string | null,
  experimentId: number,
): Promise<ExperimentDetail> {
  const cwd = resolveCheckoutCwd(sessions, projectCwd, tabId);
  if (cwd === null) return { record: null, runs: [], error: "unknown session" };
  const checkout = await readCheckoutExperiments(cwd);
  const record = checkout.experiments.find((experiment) => experiment.id === experimentId);
  if (record === undefined || checkout.source === null) {
    return { record: null, runs: [], error: checkout.error ?? "unknown experiment" };
  }
  try {
    return { record, runs: readExperimentRuns(checkout.source.dbPath, experimentId), error: null };
  } catch (err) {
    return { record, runs: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * The head of one run's log. omp records absolute `log_path`s; only a path
 * inside omp's own autoresearch state (or the test-only DB dir override) is
 * served, so a hand-edited DB cannot turn the Lab into a file reader.
 */
export async function readRunLog(
  sessions: readonly OwnedSessionRecord[],
  projectCwd: string,
  tabId: string | null,
  experimentId: number,
  runId: number,
): Promise<RunLogResult> {
  const cwd = resolveCheckoutCwd(sessions, projectCwd, tabId);
  if (cwd === null) return { kind: "error", error: "unknown session" };
  const checkout = await readCheckoutExperiments(cwd);
  if (checkout.source === null) return { kind: "error", error: checkout.error ?? "unknown experiment" };
  if (!checkout.experiments.some((experiment) => experiment.id === experimentId)) {
    return { kind: "error", error: "unknown experiment" };
  }
  let logPath: string | null;
  try {
    logPath = readExperimentLogPath(checkout.source.dbPath, runId);
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
  if (logPath === null || logPath.length === 0) return { kind: "error", error: "no log for this run" };
  // omp writes `<stateRoot>/autoresearch/<key>/runs/<id>` (or under the DB dir
  // override); the wider state root holds sessions and credentials.
  const override = process.env.OMP_AUTORESEARCH_DB_DIR;
  const root = override !== undefined && override.length > 0
    ? override
    : path.join(autoresearchStateDir(), "autoresearch");
  if (!isWithin(root, logPath)) {
    return { kind: "error", error: "log is outside omp's autoresearch state dir" };
  }
  let fd: number;
  try {
    fd = fs.openSync(logPath, "r");
  } catch {
    return { kind: "error", error: "no log for this run" };
  }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile()) return { kind: "error", error: "no log for this run" };
    const length = Math.min(stat.size, RUN_LOG_BYTE_LIMIT);
    const buffer = Buffer.allocUnsafe(length);
    let read = 0;
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, read);
      if (n === 0) break;
      read += n;
    }
    return {
      kind: "ok",
      text: buffer.toString("utf8", 0, read),
      truncated: stat.size > RUN_LOG_BYTE_LIMIT,
    };
  } catch (err) {
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * The checkout a detail request names: the project root for a null tabId,
 * else the worktree of an owned session of this project. null when the tab
 * is unknown, belongs elsewhere, or has no worktree of its own.
 */
function resolveCheckoutCwd(
  sessions: readonly OwnedSessionRecord[],
  projectCwd: string,
  tabId: string | null,
): string | null {
  if (tabId === null) return projectCwd;
  const record = sessions.find((session) => session.tabId === tabId);
  if (record === undefined || record.projectCwd !== projectCwd || record.worktree === null) return null;
  return record.worktree.path;
}
