import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { resolveProfile } from "./paths";
import type {
  StatsModelRow,
  StatsOverview,
  StatsProjectRow,
  StatsSessionRow,
  StatsTotals,
} from "./types";

// Direct SQLite reads of omp's stats database — the Stats view's source
// (ADR-0037, issue #668), like memory-store.ts and
// autoresearch-store.ts read their stores: read-only connections opened per
// call and closed in finally, because omp's sessions write the DB
// concurrently. Paths, DDL column lists and reader queries are a verified
// port of omp v18.4.0 (packages/stats/src/db.ts, rollup.ts), trimmed to the
// aggregates this surface renders; omp-ui never writes the DB and never
// re-implements the schema.

/** omp's bucket constants (rollup.ts): the hour rollup and the day grouping. */
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

/** The `meta.rollup_version` value omp 18.4.0's rollup layout carries. */
const ROLLUP_VERSION = "3";

/**
 * omp's stats.db candidates, most likely first; existence-gated like
 * getSessionsRoot. Port of omp's `rootSubdir("stats.db", "data")` resolution:
 * an existence-gated `$XDG_DATA_HOME/omp[/profiles/<p>]` base falling back to
 * the config root (`~/.omp[/profiles/<p>]`, name from `PI_CONFIG_DIR`), plus
 * a `<agentDir>/stats.db` variant when `PI_CODING_AGENT_DIR` is set (default
 * profile only — omp's own special case). Call lazily: the XDG branch is
 * existence-gated and can flip while the app runs. Never throws.
 */
export function statsDbCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path;
  const profile = resolveProfile(env);
  const configName = env.PI_CONFIG_DIR || ".omp"; // directory NAME under $HOME
  const candidates: string[] = [];
  if (platform === "linux" || platform === "darwin") {
    const xdg = env.XDG_DATA_HOME;
    if (xdg) {
      // Like getSessionsRoot: the XDG base only counts when it ALREADY EXISTS.
      const dir = profile
        ? pathApi.join(xdg, "omp", "profiles", profile)
        : pathApi.join(xdg, "omp");
      try {
        if (fs.existsSync(dir)) candidates.push(pathApi.join(dir, "stats.db"));
      } catch {
        // fall through to the config root
      }
    }
  }
  const configRoot = profile
    ? pathApi.join(home, configName, "profiles", profile)
    : pathApi.join(home, configName);
  candidates.push(pathApi.join(configRoot, "stats.db"));
  // PI_CODING_AGENT_DIR applies only to the DEFAULT profile (ignored when a
  // named profile is active), mirroring omp's agentDir special case.
  if (!profile && env.PI_CODING_AGENT_DIR) {
    candidates.push(pathApi.join(pathApi.resolve(env.PI_CODING_AGENT_DIR), "stats.db"));
  }
  return [...new Set(candidates)];
}

/** First existing candidate; null when omp has not recorded stats yet. Never throws. */
export function statsDbPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string | null {
  for (const candidate of statsDbCandidates(env, platform, home)) {
    try {
      if (fs.existsSync(candidate)) return candidate;
    } catch {
      // keep probing
    }
  }
  return null;
}

/** Numeric column → number; sqlite hands back a bigint for integers past 2^53. */
function int(value: SQLOutputValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/** A sum aggregate over a possibly-empty range: NULL reads back as zero. */
function num(value: SQLOutputValue | undefined): number {
  return int(value) ?? 0;
}

function text(value: SQLOutputValue | undefined): string {
  return typeof value === "string" ? value : "";
}

/** omp's schema probe: a file without `messages` is a state, not a throw. */
const SCHEMA_PROBE_SQL =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'messages' LIMIT 1";

const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table'";
const COLUMNS_SQL = "PRAGMA table_info(messages)";
const ROLLUP_VERSION_SQL = "SELECT value FROM meta WHERE key = 'rollup_version'";

/** The aggregate names every message-side arm emits, in UNION order. */
const ROLLUP_COLUMNS = [
  "bucket",
  "model",
  "provider",
  "folder",
  "agent_type",
  "requests",
  "failed",
  "input_tokens",
  "output_tokens",
  "cache_read_tokens",
  "cache_write_tokens",
  "total_tokens",
  "premium_requests",
  "cost_total",
  "unpriced",
  "first_ts",
  "last_ts",
];

/**
 * The unpriced-request case, omp's `mPt`: a request with tokens but zero cost
 * that could not be priced. `cost_unpriced` is 18.4+; on older DBs only the
 * xai-oauth subscription rule remains, exactly as omp reads them.
 */
function unpricedCase(e: string, cols: Set<string>): string {
  const priced = cols.has("cost_unpriced")
    ? `${e}provider = 'xai-oauth' OR COALESCE(${e}cost_unpriced, 0) = 1`
    : `${e}provider = 'xai-oauth'`;
  return `CASE WHEN ${e}total_tokens > 0 AND ${e}cost_total = 0 AND (${priced}) THEN 1 ELSE 0 END`;
}

/** The `agent_type` dimension select entry; 18.3+ only, else omp's own default. */
function agentTypeSelect(e: string, cols: Set<string>): string {
  return cols.has("agent_type") ? `${e}agent_type` : `'main' AS agent_type`;
}

/**
 * The trimmed port of omp's raw aggregate template (`cPt`). Column names are
 * identical to the rollup row's so one outer template serves both arms.
 * `TOTAL()` — NULL-tolerant, 0 on empty sets — on every REAL aggregate, as
 * in omp; `premium_requests` is 18.3+, literal 0 below it.
 */
function rawAgg(e: string, cols: Set<string>): string {
  const premium = cols.has("premium_requests") ? `TOTAL(${e}premium_requests)` : "0";
  return [
    "COUNT(*) AS requests",
    `SUM(CASE WHEN ${e}stop_reason = 'error' THEN 1 ELSE 0 END) AS failed`,
    `SUM(${e}input_tokens) AS input_tokens`,
    `SUM(${e}output_tokens) AS output_tokens`,
    `SUM(${e}cache_read_tokens) AS cache_read_tokens`,
    `SUM(${e}cache_write_tokens) AS cache_write_tokens`,
    `SUM(${e}total_tokens) AS total_tokens`,
    `${premium} AS premium_requests`,
    `TOTAL(${e}cost_total) AS cost_total`,
    `SUM(${unpricedCase(e, cols)}) AS unpriced`,
    `MIN(${e}timestamp) AS first_ts`,
    `MAX(${e}timestamp) AS last_ts`,
  ].join(", ");
}

/** The GROUP BY tail for a raw scan arm; without the column, 'main' groups whole. */
function rawGroupBy(e: string, cols: Set<string>): string {
  const agent = cols.has("agent_type") ? `, ${e}agent_type` : "";
  return ` GROUP BY 1, ${e}model, ${e}provider, ${e}folder${agent}`;
}

interface InnerQuery {
  sql: string;
  params: number[];
}

/**
 * The message side of omp's reader (`sP`): a UNION ALL of clean rollup rows,
 * dirty buckets recomputed live from messages, and — when a cutoff falls
 * inside a still-dirty bucket — the un-ingested tail rows within that bucket
 * (omp's ceil rule). Rollups off collapses to one raw scan, which is exact
 * whatever omp's ingest has drained.
 */
function messageInner(cols: Set<string>, rollups: boolean, cutoff: number | null): InnerQuery {
  if (!rollups) {
    const where = cutoff === null ? "" : ` WHERE timestamp >= ?`;
    return {
      sql: `SELECT (timestamp / ${HOUR_MS}) * ${HOUR_MS} AS bucket, ` +
        `model, provider, folder, ${agentTypeSelect("", cols)}, ${rawAgg("", cols)} ` +
        `FROM messages${where}${rawGroupBy("", cols)}`,
      params: cutoff === null ? [] : [cutoff],
    };
  }
  const arms = [
    `SELECT ${ROLLUP_COLUMNS.join(", ")} FROM message_rollup WHERE bucket NOT IN (SELECT bucket FROM rollup_dirty)` +
      (cutoff === null ? "" : " AND bucket >= ?"),
    `SELECT (m.timestamp / ${HOUR_MS}) * ${HOUR_MS} AS bucket, ` +
      `m.model, m.provider, m.folder, ${agentTypeSelect("m.", cols)}, ${rawAgg("m.", cols)} ` +
      `FROM rollup_dirty d JOIN messages m ON m.timestamp >= d.bucket AND m.timestamp < d.bucket + ${HOUR_MS}` +
      (cutoff === null ? "" : " WHERE d.bucket >= ?") +
      rawGroupBy("m.", cols),
  ];
  const params = cutoff === null ? [] : [cutoff, cutoff];
  if (cutoff !== null) {
    // sP's ceil rule: rows at/after the cutoff within the bucket that holds
    // it — clean-rollup arm A misses them only if the bucket is dirty, and
    // arm B's bucket filter would too when the cutoff is mid-bucket.
    const tailEnd = Math.ceil(cutoff / HOUR_MS) * HOUR_MS;
    arms.push(
      `SELECT (timestamp / ${HOUR_MS}) * ${HOUR_MS} AS bucket, ` +
        `model, provider, folder, ${agentTypeSelect("", cols)}, ${rawAgg("", cols)} ` +
        `FROM messages WHERE timestamp >= ? AND timestamp < ?` +
        rawGroupBy("", cols),
    );
    params.push(cutoff, tailEnd);
  }
  return { sql: arms.join(" UNION ALL "), params };
}

/** Outer select over `FROM (<message inner>) f`, omp's reader shapes. */
function outerSelect(columns: string, groupBy: string, inner: string): string {
  return `SELECT ${columns} FROM (${inner}) f${groupBy}`;
}

function totalsSql(inner: string): string {
  return outerSelect(
    "SUM(f.requests) AS requests, SUM(f.failed) AS failed, SUM(f.input_tokens) AS input_tokens, " +
      "SUM(f.output_tokens) AS output_tokens, SUM(f.cache_read_tokens) AS cache_read_tokens, " +
      "SUM(f.cache_write_tokens) AS cache_write_tokens, SUM(f.total_tokens) AS total_tokens, " +
      "TOTAL(f.premium_requests) AS premium_requests, TOTAL(f.cost_total) AS cost_total, " +
      "SUM(f.unpriced) AS unpriced, MIN(f.first_ts) AS first_ts, MAX(f.last_ts) AS last_ts",
    "",
    inner,
  );
}

function daysSql(inner: string): string {
  return outerSelect(
    `(f.bucket / ${DAY_MS}) * ${DAY_MS} AS ts, SUM(f.requests) AS requests, SUM(f.failed) AS failed, ` +
      "SUM(f.total_tokens) AS total_tokens, TOTAL(f.cost_total) AS cost",
    " GROUP BY 1 ORDER BY 1",
    inner,
  );
}

function modelsSql(inner: string): string {
  return outerSelect(
    "f.model AS model, f.provider AS provider, SUM(f.requests) AS requests, SUM(f.failed) AS failed, " +
      "SUM(f.total_tokens) AS total_tokens, TOTAL(f.premium_requests) AS premium_requests, " +
      "TOTAL(f.cost_total) AS cost",
    " GROUP BY f.model, f.provider ORDER BY requests DESC",
    inner,
  );
}

function projectsSql(inner: string): string {
  return outerSelect(
    "f.folder AS folder, SUM(f.requests) AS requests, SUM(f.total_tokens) AS total_tokens, " +
      "TOTAL(f.cost_total) AS cost",
    " GROUP BY f.folder ORDER BY requests DESC",
    inner,
  );
}

/**
 * The session side of the port: whole-life rows, clean `session_rollup` rows
 * UNION dirty files recomputed live; raw mode is one messages scan. The
 * cutoff filters on `ended_at` — sessions are whole-range rows.
 */
function sessionsQuery(
  cols: Set<string>,
  tables: Set<string>,
  rollups: boolean,
  cutoff: number | null,
): InnerQuery {
  const toolCalls = (e: string): string =>
    tables.has("tool_calls")
      ? `(SELECT COUNT(*) FROM tool_calls tc WHERE tc.session_file = ${e}session_file) AS tool_calls`
      : "0 AS tool_calls";
  const scan = (e: string): string =>
    `${e}session_file, COUNT(*) AS requests, MIN(${e}timestamp) AS started_at, ` +
    `MAX(${e}timestamp + COALESCE(${e}duration, 0)) AS ended_at, ` +
    `SUM(${e}total_tokens) AS total_tokens, TOTAL(${e}cost_total) AS cost_total, ` +
    `SUM(${unpricedCase(e, cols)}) AS unpriced, GROUP_CONCAT(DISTINCT ${e}model) AS models, ` +
    toolCalls(e);
  let sql: string;
  if (rollups) {
    sql =
      "SELECT session_file, requests, started_at, ended_at, total_tokens, cost_total, unpriced, models, tool_calls " +
      "FROM session_rollup WHERE session_file NOT IN (SELECT session_file FROM session_dirty)" +
      " UNION ALL " +
      `SELECT ${scan("m.")} FROM session_dirty d JOIN messages m ON m.session_file = d.session_file` +
      " GROUP BY m.session_file";
  } else {
    // The correlation needs the table name: a bare session_file would resolve
    // to the subquery's own tc.session_file and count every row.
    sql = `SELECT ${scan("messages.")} FROM messages GROUP BY messages.session_file`;
  }
  const where = cutoff === null ? "" : " WHERE f.ended_at >= ?";
  return {
    sql: `SELECT f.session_file, f.requests, f.started_at, f.ended_at, f.total_tokens, f.cost_total, ` +
      `f.unpriced, f.models, f.tool_calls FROM (${sql}) f${where} ORDER BY f.ended_at DESC`,
    params: cutoff === null ? [] : [cutoff],
  };
}

function emptyTotals(): StatsTotals {
  return {
    requests: 0,
    failed: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    premiumRequests: 0,
    cost: 0,
    unpricedRequests: 0,
    firstTs: null,
    lastTs: null,
  };
}

function emptyOverview(dbPath: string | null, error: string | null): StatsOverview {
  return {
    dbPath,
    error,
    rollups: false,
    totals: emptyTotals(),
    days: [],
    models: [],
    projects: [],
    sessions: [],
  };
}

function toTotals(row: Record<string, SQLOutputValue> | undefined): StatsTotals {
  const totals = emptyTotals();
  if (row === undefined) return totals;
  totals.requests = num(row.requests);
  totals.failed = num(row.failed);
  totals.inputTokens = num(row.input_tokens);
  totals.outputTokens = num(row.output_tokens);
  totals.cacheReadTokens = num(row.cache_read_tokens);
  totals.cacheWriteTokens = num(row.cache_write_tokens);
  totals.totalTokens = num(row.total_tokens);
  totals.premiumRequests = num(row.premium_requests);
  totals.cost = num(row.cost_total);
  totals.unpricedRequests = num(row.unpriced);
  totals.firstTs = int(row.first_ts);
  totals.lastTs = int(row.last_ts);
  return totals;
}

function toSessionRow(row: Record<string, SQLOutputValue>): StatsSessionRow {
  const models = text(row.models);
  return {
    sessionFile: text(row.session_file),
    requests: num(row.requests),
    startedAt: num(row.started_at),
    endedAt: num(row.ended_at),
    totalTokens: num(row.total_tokens),
    cost: num(row.cost_total),
    unpricedRequests: num(row.unpriced),
    models: models === "" ? [] : models.split(",").filter((model) => model !== ""),
    toolCalls: num(row.tool_calls),
  };
}

/**
 * The cross-session Stats view payload for one range; `rangeDays` null = all
 * time. NEVER throws: no DB → `dbPath: null`; a foreign or unreadable file
 * lands in `error` with empty sections (like readCheckoutExperiments).
 * `dbPathOverride` exists for tests only.
 */
export async function readStatsOverview(
  rangeDays: number | null,
  env: NodeJS.ProcessEnv = process.env,
  dbPathOverride?: string | null,
): Promise<StatsOverview> {
  const cutoff =
    rangeDays === null
      ? null
      : Math.floor((Date.now() - rangeDays * DAY_MS) / HOUR_MS) * HOUR_MS;
  const dbPath = dbPathOverride === undefined ? statsDbPath(env) : dbPathOverride;
  if (dbPath === null) return emptyOverview(null, null);
  let db: DatabaseSync | undefined;
  try {
    const opened = new DatabaseSync(dbPath, { readOnly: true });
    db = opened;
    if (opened.prepare(SCHEMA_PROBE_SQL).get() === undefined) {
      return emptyOverview(dbPath, "not an omp stats database");
    }
    const tables = new Set(
      (opened.prepare(TABLES_SQL).all() as Record<string, SQLOutputValue>[]).map((row) =>
        text(row.name),
      ),
    );
    const cols = new Set(
      (opened.prepare(COLUMNS_SQL).all() as Record<string, SQLOutputValue>[]).map((row) =>
        text(row.name),
      ),
    );
    const rollups =
      ["message_rollup", "rollup_dirty", "session_rollup", "session_dirty"].every((name) =>
        tables.has(name),
      ) &&
      tables.has("meta") &&
      text((opened.prepare(ROLLUP_VERSION_SQL).get() as Record<string, SQLOutputValue> | undefined)?.value) ===
        ROLLUP_VERSION;
    const messages = messageInner(cols, rollups, cutoff);
    const overview = emptyOverview(dbPath, null);
    overview.rollups = rollups;
    overview.totals = toTotals(
      opened.prepare(totalsSql(messages.sql)).get(...messages.params) as
        | Record<string, SQLOutputValue>
        | undefined,
    );
    const all = (sql: string, params: number[]): Record<string, SQLOutputValue>[] =>
      opened.prepare(sql).all(...params) as Record<string, SQLOutputValue>[];
    overview.days = all(daysSql(messages.sql), messages.params).map((row) => ({
      ts: num(row.ts),
      requests: num(row.requests),
      failed: num(row.failed),
      totalTokens: num(row.total_tokens),
      cost: num(row.cost),
    }));
    overview.models = all(modelsSql(messages.sql), messages.params).map(
      (row): StatsModelRow => ({
        model: text(row.model),
        provider: text(row.provider),
        requests: num(row.requests),
        failed: num(row.failed),
        totalTokens: num(row.total_tokens),
        premiumRequests: num(row.premium_requests),
        cost: num(row.cost),
      }),
    );
    overview.projects = all(projectsSql(messages.sql), messages.params).map(
      (row): StatsProjectRow => ({
        folder: text(row.folder),
        requests: num(row.requests),
        totalTokens: num(row.total_tokens),
        cost: num(row.cost),
      }),
    );
    const sessions = sessionsQuery(cols, tables, rollups, cutoff);
    overview.sessions = all(sessions.sql, sessions.params).map(toSessionRow);
    return overview;
  } catch (error) {
    return emptyOverview(dbPath, error instanceof Error ? error.message : String(error));
  } finally {
    db?.close();
  }
}
