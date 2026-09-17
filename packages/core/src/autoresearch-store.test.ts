import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  autoresearchCandidateKeys,
  autoresearchDbPath,
  autoresearchProjectKey,
  autoresearchStateDir,
  readCheckoutExperiments,
  readExperimentLogPath,
  readExperimentRuns,
} from "./autoresearch-store";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-ar-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// omp v18.2.4's DDL, verbatim.
const DDL = [
  "CREATE TABLE sessions(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, goal TEXT, primary_metric TEXT NOT NULL, metric_unit TEXT NOT NULL DEFAULT '', direction TEXT NOT NULL DEFAULT 'lower', preferred_command TEXT, branch TEXT, baseline_commit TEXT, current_segment INTEGER NOT NULL DEFAULT 1, max_iterations INTEGER, scope_paths_json TEXT NOT NULL DEFAULT '[]', off_limits_json TEXT NOT NULL DEFAULT '[]', constraints_json TEXT NOT NULL DEFAULT '[]', secondary_metrics_json TEXT NOT NULL DEFAULT '[]', notes TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, closed_at INTEGER)",
  "CREATE TABLE runs(id INTEGER PRIMARY KEY AUTOINCREMENT, session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE, segment INTEGER NOT NULL DEFAULT 1, command TEXT NOT NULL, started_at INTEGER NOT NULL, completed_at INTEGER, duration_ms INTEGER, exit_code INTEGER, timed_out INTEGER NOT NULL DEFAULT 0, parsed_primary REAL, parsed_metrics_json TEXT, parsed_asi_json TEXT, pre_run_dirty_paths_json TEXT, log_path TEXT, status TEXT, description TEXT, metric REAL, metrics_json TEXT, asi_json TEXT, commit_hash TEXT, confidence TEXT, modified_paths_json TEXT, scope_deviations_json TEXT, justification TEXT, flagged INTEGER NOT NULL DEFAULT 0, flagged_reason TEXT, logged_at INTEGER, abandoned_at INTEGER)",
  "CREATE INDEX runs_pending_idx ON runs(session_id, status, abandoned_at)",
];

interface RunSeed {
  session: number;
  segment: number;
  startedAt: number;
  status?: string | null;
  metric?: number | null;
  flagged?: boolean;
  loggedAt?: number | null;
  abandonedAt?: number | null;
  logPath?: string | null;
}

function seedDb(dbPath: string, runs: readonly RunSeed[]): void {
  const db = new DatabaseSync(dbPath);
  try {
    for (const statement of DDL) db.exec(statement);
    const session = db.prepare(
      "INSERT INTO sessions(id, name, goal, primary_metric, metric_unit, direction, preferred_command, branch, current_segment, max_iterations, scope_paths_json, notes, created_at, closed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    );
    session.run(1, "latency", "cut p95", "p95_ms", "ms", "lower", "./bench.sh", "autoresearch/latency/ab12", 2, 20, '["src"]', "ideas", 1000, null);
    session.run(2, "throughput", null, "rps", "", "higher", null, null, 1, null, "not json", "", 2000, 2500);
    session.run(3, "sideways", null, "x", "", "sideways", null, null, 1, null, "[]", "", 1500, null);
    const run = db.prepare(
      "INSERT INTO runs(session_id, segment, command, started_at, status, metric, flagged, logged_at, abandoned_at, log_path) VALUES (?, ?, 'bench', ?, ?, ?, ?, ?, ?, ?)",
    );
    for (const r of runs) {
      run.run(
        r.session,
        r.segment,
        r.startedAt,
        r.status ?? null,
        r.metric ?? null,
        r.flagged ? 1 : 0,
        r.loggedAt ?? null,
        r.abandonedAt ?? null,
        r.logPath ?? null,
      );
    }
  } finally {
    db.close();
  }
}

// Session 1 (lower is better) has moved on to segment 2; its segment-1 run (id 1)
// must not leak into segment-2 aggregates. Session 2 (higher) is on segment 1.
// The last row is a second unlogged run of session 1 (id 14): omp reports the
// newest pending run, so it must win over id 8.
const RUNS: readonly RunSeed[] = [
  { session: 1, segment: 1, startedAt: 10, status: "keep", metric: 100, loggedAt: 11, logPath: "/logs/1.log" },
  { session: 1, segment: 2, startedAt: 20, status: "keep", metric: 50, loggedAt: 21 },
  { session: 1, segment: 2, startedAt: 30, status: "discard", metric: 60, loggedAt: 31 },
  { session: 1, segment: 2, startedAt: 40, status: "keep", metric: 40, flagged: true, loggedAt: 41 },
  { session: 1, segment: 2, startedAt: 50, status: "crash", loggedAt: 51 },
  { session: 1, segment: 2, startedAt: 60, status: "keep", metric: 45, loggedAt: 61 },
  { session: 1, segment: 2, startedAt: 70, abandonedAt: 71 },
  { session: 1, segment: 2, startedAt: 80, logPath: "" },
  { session: 1, segment: 2, startedAt: 85, status: "checks_failed", metric: 55, loggedAt: 90 },
  { session: 2, segment: 1, startedAt: 100, status: "keep", metric: 1, loggedAt: 101 },
  { session: 2, segment: 1, startedAt: 110, status: "keep", metric: 3, loggedAt: 111 },
  { session: 2, segment: 1, startedAt: 120, status: "discard", metric: 5, loggedAt: 121 },
  { session: 2, segment: 1, startedAt: 130, status: "keep", metric: 2, loggedAt: 131 },
  { session: 1, segment: 2, startedAt: 95 },
];

/** A checkout dir plus the env that points its DB at `dbDir`; the DB path omp would use. */
function checkout(): { cwd: string; env: NodeJS.ProcessEnv; dbPath: string } {
  const cwd = tmpDir();
  const dbDir = tmpDir();
  const env = { OMP_AUTORESEARCH_DB_DIR: dbDir };
  return { cwd, env, dbPath: path.join(dbDir, `${autoresearchProjectKey(cwd)}.db`) };
}

describe("autoresearchProjectKey", () => {
  it("wraps the root in -- with every separator flattened (omp's own derivation)", () => {
    expect(autoresearchProjectKey("/home/u/repo")).toBe("--home-u-repo--");
    // The drive colon and the backslash each become a dash; only a LEADING slash is dropped.
    expect(autoresearchProjectKey("C:\\w\\r")).toBe("--C--w-r--");
  });
});

describe("autoresearchStateDir", () => {
  it("uses $XDG_STATE_HOME/omp only when that dir already exists", () => {
    const xdg = tmpDir();
    const home = "/home/u";
    expect(autoresearchStateDir({ XDG_STATE_HOME: xdg }, "linux", home)).toBe(
      path.join(home, ".omp"),
    );
    fs.mkdirSync(path.join(xdg, "omp"));
    expect(autoresearchStateDir({ XDG_STATE_HOME: xdg }, "linux", home)).toBe(
      path.join(xdg, "omp"),
    );
  });

  it("gates the profile subdir itself and nests profiles under the fallback too", () => {
    const xdg = tmpDir();
    fs.mkdirSync(path.join(xdg, "omp"));
    const env = { XDG_STATE_HOME: xdg, OMP_PROFILE: "work" };
    expect(autoresearchStateDir(env, "darwin", "/Users/u")).toBe("/Users/u/.omp/profiles/work");
    fs.mkdirSync(path.join(xdg, "omp", "profiles", "work"), { recursive: true });
    expect(autoresearchStateDir(env, "darwin", "/Users/u")).toBe(
      path.join(xdg, "omp", "profiles", "work"),
    );
  });

  it("ignores XDG off linux and macOS", () => {
    const xdg = tmpDir();
    fs.mkdirSync(path.join(xdg, "omp"));
    expect(autoresearchStateDir({ XDG_STATE_HOME: xdg }, "win32", "C:\\Users\\u")).toBe(
      path.join("C:\\Users\\u", ".omp"),
    );
  });
});

describe("autoresearchDbPath", () => {
  it("honours OMP_AUTORESEARCH_DB_DIR over the state dir", () => {
    expect(autoresearchDbPath("--k--", { OMP_AUTORESEARCH_DB_DIR: "/override" })).toBe(
      path.join("/override", "--k--.db"),
    );
    expect(autoresearchDbPath("--k--", {})).toBe(
      path.join(autoresearchStateDir({}), "autoresearch", "--k--.db"),
    );
  });
});

describe("autoresearchCandidateKeys", () => {
  it("offers only the cwd key outside a repository", async () => {
    const cwd = tmpDir();
    expect(await autoresearchCandidateKeys(cwd)).toEqual([autoresearchProjectKey(cwd)]);
  });
});

describe("readCheckoutExperiments", () => {
  it("reports no source when no candidate DB exists", async () => {
    const { cwd, env } = checkout();
    expect(await readCheckoutExperiments(cwd, env)).toEqual({
      source: null,
      experiments: [],
      error: null,
    });
  });

  it("refuses a database with neither omp table", async () => {
    const { cwd, env, dbPath } = checkout();
    const db = new DatabaseSync(dbPath);
    db.exec("CREATE TABLE other(id INTEGER)");
    db.close();
    const result = await readCheckoutExperiments(cwd, env);
    expect(result.source?.dbPath).toBe(dbPath);
    expect(result.experiments).toEqual([]);
    expect(result.error).toBe("not an autoresearch database");
  });

  it("lists experiments newest first with current-segment progress per direction", async () => {
    const { cwd, env, dbPath } = checkout();
    seedDb(dbPath, RUNS);
    const result = await readCheckoutExperiments(cwd, env);
    expect(result.error).toBeNull();
    expect(result.source).toEqual({ cwd, key: autoresearchProjectKey(cwd), dbPath });
    expect(result.experiments.map((e) => e.id)).toEqual([2, 3, 1]);

    const [throughput, sideways, latency] = result.experiments;
    expect(latency).toMatchObject({
      name: "latency",
      goal: "cut p95",
      primaryMetric: "p95_ms",
      metricUnit: "ms",
      direction: "lower",
      preferredCommand: "./bench.sh",
      branch: "autoresearch/latency/ab12",
      currentSegment: 2,
      maxIterations: 20,
      scopePaths: ["src"],
      notes: "ideas",
      createdAt: 1000,
      closedAt: null,
    });
    // Segment-1 run id 1 (metric 100) is excluded; the flagged keep (id 4, 40)
    // counts as kept but never as baseline, best, or a series point. Progress
    // counts logged runs only (omp's "Progress: n/max"), so the abandoned run
    // (7) and the two pending runs (8, 14) are not among the six; the newest
    // pending run (14) is the one omp would resume.
    expect(latency?.progress).toEqual({
      segmentRuns: 6,
      kept: 3,
      discarded: 1,
      crashed: 1,
      checksFailed: 1,
      baseline: { runId: 2, metric: 50 },
      best: { runId: 6, metric: 45 },
      pendingRunId: 14,
      lastActivityAt: 95,
      metricSeries: [
        { runId: 2, metric: 50, kept: true },
        { runId: 3, metric: 60, kept: false },
        { runId: 6, metric: 45, kept: true },
        { runId: 9, metric: 55, kept: false },
      ],
    });

    expect(throughput).toMatchObject({
      direction: "higher",
      goal: null,
      scopePaths: [],
      closedAt: 2500,
    });
    expect(throughput?.progress).toMatchObject({
      segmentRuns: 4,
      kept: 3,
      discarded: 1,
      baseline: { runId: 10, metric: 1 },
      best: { runId: 11, metric: 3 },
      pendingRunId: null,
      lastActivityAt: 131,
    });

    expect(sideways).toMatchObject({ direction: "lower", progress: { segmentRuns: 0, baseline: null } });
  });
});

describe("readExperimentRuns", () => {
  it("maps status, abandonment and log presence per row", () => {
    const dbPath = path.join(tmpDir(), "x.db");
    seedDb(dbPath, RUNS);
    const runs = readExperimentRuns(dbPath, 1);
    expect(runs.map((r) => r.id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 14]);
    expect(runs[0]).toMatchObject({ segment: 1, status: "keep", metric: 100, hasLog: true, abandoned: false });
    expect(runs[3]).toMatchObject({ flagged: true, status: "keep" });
    expect(runs[4]).toMatchObject({ status: "crash", metric: null });
    expect(runs[6]).toMatchObject({ status: null, abandoned: true, hasLog: false });
    expect(runs[7]).toMatchObject({ status: null, abandoned: false, hasLog: false });
    expect(readExperimentRuns(dbPath, 3)).toEqual([]);
  });

  it("throws on a missing database so the caller can report it", () => {
    expect(() => readExperimentRuns(path.join(tmpDir(), "missing.db"), 1)).toThrow();
  });
});

describe("readExperimentLogPath", () => {
  it("returns the recorded path, null for empty, unknown, or unreadable", () => {
    const dbPath = path.join(tmpDir(), "x.db");
    seedDb(dbPath, RUNS);
    expect(readExperimentLogPath(dbPath, 1)).toBe("/logs/1.log");
    expect(readExperimentLogPath(dbPath, 8)).toBeNull();
    expect(readExperimentLogPath(dbPath, 2)).toBeNull();
    expect(readExperimentLogPath(dbPath, 999)).toBeNull();
    expect(readExperimentLogPath(path.join(tmpDir(), "missing.db"), 1)).toBeNull();
  });
});
