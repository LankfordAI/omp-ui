import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync, type SQLInputValue, type SQLOutputValue } from "node:sqlite";
import {
  resolveOwnedStatsAttribution,
  resolveStatsAttributions,
  statsProjectIdentity,
  type StatsAttribution,
  type StatsReadContext,
} from "./stats-attribution";
import type {
  StatsAgentRow,
  StatsDataState,
  StatsModelRow,
  StatsOverview,
  StatsProjectIdentity,
  StatsProjectRow,
  StatsQuery,
  StatsSessionRow,
  StatsSourceInfo,
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

const TABLES_SQL = "SELECT name FROM sqlite_master WHERE type = 'table'";
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

/** Missing historical dimensions remain unknown, never guessed as main. */
function agentTypeSelect(e: string, cols: Set<string>): string {
  return `${agentExpression(e, cols)} AS agent_type`;
}

function agentExpression(e: string, cols: Set<string>): string {
  return cols.has("agent_type") ? `COALESCE(NULLIF(${e}agent_type, ''), 'unknown')` : "'unknown'";
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
  params: SQLInputValue[];
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

type Row = Record<string, SQLOutputValue>;
const UNATTRIBUTED: StatsAttribution = { identity: { key: "unattributed", kind: "unattributed" }, title: null };
const REQUIRED_MESSAGES = [
  "session_file", "model", "provider", "folder", "timestamp", "duration", "stop_reason",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens", "cost_total",
];
const REQUIRED_TOOLS = ["session_file", "tool_name", "model", "provider", "timestamp"];

function all(db: DatabaseSync, sql: string, params: SQLInputValue[] = []): Row[] {
  return db.prepare(sql).all(...params) as Row[];
}

function columns(db: DatabaseSync, table: string): Set<string> {
  // Table names are internal constants, never query input.
  return new Set(all(db, `PRAGMA table_info(${table})`).map((row) => text(row.name)));
}

function hasColumns(cols: Set<string>, required: readonly string[]): boolean {
  return required.every((column) => cols.has(column));
}

function emptyTotals(): StatsTotals {
  return {
    requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, totalTokens: 0, premiumRequests: 0, cost: 0,
    unpricedRequests: 0, firstTs: null, lastTs: null, toolCalls: null,
  };
}

export function emptyStatsOverview(
  query: StatsQuery,
  source: StatsSourceInfo | null,
  error: string | null,
  dataState: StatsDataState = "missing",
): StatsOverview {
  return {
    query: { ...query, model: query.model === null ? null : { ...query.model } },
    snapshotAt: Date.now(), source: source === null ? null : { ...source },
    databasePresent: false, dataState, dbPath: source?.databasePath ?? null, error,
    rollups: false, totals: emptyTotals(), days: [], models: [], projects: [], sessions: [],
    tools: [], agents: [], capabilities: { tools: false, toolOutcomes: false, agentTypes: false },
    facets: { projects: [], providers: [], models: [], agentTypes: [] },
    coverage: {
      latestRequestAt: null, indexedFiles: null, sourceRootMismatch: false,
      ownedSessionsRoot: "", archiveOnlyFiles: null, warnings: [],
    },
  };
}

function toTotals(row: Row | undefined): StatsTotals {
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

function canonicalPath(value: string): string {
  const api = /^[a-z]:[\\/]|^\\\\/i.test(value) ? path.win32 : path;
  const normalized = api.resolve(value);
  const root = api.parse(normalized).root;
  const trimmed = normalized.length > root.length ? normalized.replace(/[\\/]+$/, "") : normalized;
  return api === path.win32 ? trimmed.toLowerCase() : trimmed;
}

/** Root transcripts only: artifact subtrees are not independent sessions. */
async function archiveActiveFiles(context: StatsReadContext): Promise<string[] | null> {
  try {
    const root = context.source.archiveRoot;
    if (!root || !context.source.sessionsRoot) return null;
    if (!(await fs.promises.stat(context.source.sessionsRoot)).isDirectory()) return null;
    const dirs = await fs.promises.readdir(root, { withFileTypes: true });
    const files: string[] = [];
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue;
      const entries = await fs.promises.readdir(path.join(root, dir.name), { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith(".jsonl.gz")) {
          files.push(canonicalPath(path.join(context.source.sessionsRoot, dir.name, entry.name.slice(0, -3))));
        }
      }
    }
    return files;
  } catch {
    return null;
  }
}

function sessionFiles(db: DatabaseSync, tools: boolean): string[] {
  return all(db, "SELECT DISTINCT session_file FROM messages" +
    (tools ? " UNION SELECT DISTINCT session_file FROM tool_calls" : ""))
    .map((row) => text(row.session_file));
}

/** Only key discovery precedes filesystem work; none of these rows is returned as usage. */
function preparationFiles(databasePath: string): string[] {
  const db = new DatabaseSync(databasePath, { readOnly: true });
  try {
    try {
      return sessionFiles(db, true);
    } catch (error) {
      // Optional tool storage can be absent or lack its historical key column.
      // Capability/schema decisions are made again inside the actual snapshot.
      if (!/no such table: tool_calls|no such column: session_file/i.test(error instanceof Error ? error.message : String(error))) throw error;
      return sessionFiles(db, false);
    }
  } finally {
    db.close();
  }
}

/** Identical predicates apply independently to requests and invocations. */
function rowFilter(
  query: StatsQuery,
  cols: Set<string>,
  cutoff: number | null,
  selectedFiles: string[] | null,
): InnerQuery {
  const clauses: string[] = [];
  const params: SQLInputValue[] = [];
  if (cutoff !== null) { clauses.push("timestamp >= ?"); params.push(cutoff); }
  if (query.provider !== null) { clauses.push("provider = ?"); params.push(query.provider); }
  if (query.model !== null) {
    clauses.push("provider = ? AND model = ?");
    params.push(query.model.provider, query.model.id);
  }
  if (query.agentType !== null) { clauses.push(`${agentExpression("", cols)} = ?`); params.push(query.agentType); }
  if (selectedFiles !== null) {
    clauses.push("session_file IN (SELECT value FROM json_each(?))");
    params.push(JSON.stringify(selectedFiles));
  }
  return { sql: clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`, params };
}

function filteredMessages(cols: Set<string>, rollups: boolean, cutoff: number | null, query: StatsQuery, filter: InnerQuery): InnerQuery {
  if (query.projectKey !== null) {
    return {
      sql: `SELECT (timestamp / ${HOUR_MS}) * ${HOUR_MS} AS bucket, model, provider, folder, ` +
        `${agentTypeSelect("", cols)}, ${rawAgg("", cols)} FROM messages${filter.sql}${rawGroupBy("", cols)}`,
      params: filter.params,
    };
  }
  const inner = messageInner(cols, rollups, cutoff);
  const dimensions = rowFilter(query, cols, null, null);
  return { sql: `SELECT * FROM (${inner.sql}) f${dimensions.sql}`, params: [...inner.params, ...dimensions.params] };
}

function sqliteDataState(error: unknown): StatsDataState {
  const detail = error instanceof Error ? error.message : String(error);
  if (/locked|busy/i.test(detail)) return "locked";
  if (/malformed|not a database|corrupt/i.test(detail)) return "corrupt";
  if (/no such (table|column)/i.test(detail)) return "incompatible";
  return "error";
}

/**
 * Transcript/header I/O finishes before BEGIN. Every returned SQL value, including
 * schema capabilities and global facets, then comes from one read-only snapshot.
 * New writer keys discovered there use only the synchronous owned-registry resolver.
 */
export async function readStatsOverview(query: StatsQuery, context: StatsReadContext): Promise<StatsOverview> {
  const snapshotAt = Date.now();
  const cutoff = query.rangeDays === null ? null : Math.floor((snapshotAt - query.rangeDays * DAY_MS) / HOUR_MS) * HOUR_MS;
  const overview = emptyStatsOverview(query, context.source, null);
  overview.snapshotAt = snapshotAt;
  overview.coverage.ownedSessionsRoot = context.ownedSessionsRoot;
  overview.coverage.sourceRootMismatch = canonicalPath(context.source.sessionsRoot) !== canonicalPath(context.ownedSessionsRoot);
  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    try {
      await fs.promises.stat(context.source.databasePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return overview;
      throw error;
    }
    overview.databasePresent = true;
    const files = preparationFiles(context.source.databasePath);
    const [attributions, archives] = await Promise.all([
      resolveStatsAttributions(files, context), archiveActiveFiles(context),
    ]);
    db = new DatabaseSync(context.source.databasePath, { readOnly: true });
    db.exec("BEGIN");
    transaction = true;
    const tables = new Set(all(db, TABLES_SQL).map((row) => text(row.name)));
    const cols = columns(db, "messages");
    if (!tables.has("messages") || !hasColumns(cols, REQUIRED_MESSAGES)) {
      overview.dataState = "incompatible";
      overview.error = "not a compatible omp stats database";
      return overview;
    }
    const toolCols = tables.has("tool_calls") ? columns(db, "tool_calls") : new Set<string>();
    const tools = hasColumns(toolCols, REQUIRED_TOOLS);
    const outcomes = tools && hasColumns(toolCols, ["result_chars", "is_error"]);
    overview.capabilities = { tools, toolOutcomes: outcomes, agentTypes: cols.has("agent_type") || (tools && toolCols.has("agent_type")) };
    if (!tools) overview.coverage.warnings.push("tools-unavailable");
    else if (!outcomes) overview.coverage.warnings.push("tool-outcomes-unavailable");
    const snapshotFiles = sessionFiles(db, tools);
    for (const file of snapshotFiles) {
      if (!attributions.has(file)) attributions.set(file, resolveOwnedStatsAttribution(file, context) ?? UNATTRIBUTED);
    }
    const identities = new Map<string, StatsProjectIdentity>();
    for (const project of context.projects) {
      const identity = statsProjectIdentity(project);
      identities.set(identity.key, identity);
    }
    for (const file of snapshotFiles) {
      const attribution = attributions.get(file) ?? UNATTRIBUTED;
      identities.set(attribution.identity.key, attribution.identity);
    }
    overview.facets.projects = [...identities.values()].sort((a, b) => a.key.localeCompare(b.key));
    const selectedFiles = query.projectKey === null ? null : snapshotFiles.filter((file) => attributions.get(file)?.identity.key === query.projectKey);
    const messageFilter = rowFilter(query, cols, cutoff, selectedFiles);
    const toolFilter = rowFilter(query, toolCols, cutoff, selectedFiles);
    // Keep the supported v3 message layout guarded; actual v2 writers scan raw.
    overview.rollups = query.projectKey === null && cols.has("agent_type") &&
      ["message_rollup", "rollup_dirty", "session_rollup", "session_dirty", "meta"].every((table) => tables.has(table)) &&
      text((db.prepare(ROLLUP_VERSION_SQL).get() as Row | undefined)?.value) === ROLLUP_VERSION &&
      hasColumns(columns(db, "message_rollup"), ROLLUP_COLUMNS) && columns(db, "rollup_dirty").has("bucket");
    const messages = filteredMessages(cols, overview.rollups, cutoff, query, messageFilter);
    overview.totals = toTotals(db.prepare(totalsSql(messages.sql)).get(...messages.params) as Row | undefined);
    overview.days = all(db, daysSql(messages.sql), messages.params).map((row) => ({
      ts: num(row.ts), requests: num(row.requests), failed: num(row.failed), totalTokens: num(row.total_tokens), cost: num(row.cost),
    }));
    overview.models = all(db, modelsSql(messages.sql), messages.params).map((row): StatsModelRow => ({
      model: text(row.model), provider: text(row.provider), requests: num(row.requests), failed: num(row.failed),
      totalTokens: num(row.total_tokens), premiumRequests: num(row.premium_requests), cost: num(row.cost),
    }));
    const sessions = new Map<string, StatsSessionRow>();
    const session = (file: string): StatsSessionRow => {
      let value = sessions.get(file);
      if (value === undefined) {
        const attribution = attributions.get(file) ?? UNATTRIBUTED;
        value = { sessionFile: file, ...attribution, requests: 0, startedAt: 0, endedAt: 0,
          totalTokens: 0, cost: 0, unpricedRequests: 0, models: [], toolCalls: tools ? 0 : null };
        sessions.set(file, value);
      }
      return value;
    };
    for (const row of all(db,
      `SELECT session_file, COUNT(*) AS requests, MIN(timestamp) AS started_at, ` +
      `MAX(timestamp + COALESCE(duration, 0)) AS ended_at, SUM(total_tokens) AS total_tokens, ` +
      `TOTAL(cost_total) AS cost_total, SUM(${unpricedCase("", cols)}) AS unpriced, ` +
      `json_group_array(DISTINCT model) AS models FROM messages${messageFilter.sql} GROUP BY session_file`, messageFilter.params)) {
      Object.assign(session(text(row.session_file)), {
        requests: num(row.requests), startedAt: num(row.started_at), endedAt: num(row.ended_at),
        totalTokens: num(row.total_tokens), cost: num(row.cost_total), unpricedRequests: num(row.unpriced),
        models: JSON.parse(text(row.models)) as string[],
      });
    }
    const agents = new Map<string, StatsAgentRow>();
    const agent = (name: string): StatsAgentRow => {
      let value = agents.get(name);
      if (value === undefined) {
        value = { agentType: name, requests: 0, totalTokens: 0, cost: 0, toolCalls: tools ? 0 : null };
        agents.set(name, value);
      }
      return value;
    };
    for (const row of all(db, outerSelect(
      "COALESCE(NULLIF(f.agent_type, ''), 'unknown') AS agent_type, SUM(requests) AS requests, SUM(total_tokens) AS total_tokens, TOTAL(cost_total) AS cost",
      " GROUP BY 1", messages.sql), messages.params)) {
      Object.assign(agent(text(row.agent_type)), { requests: num(row.requests), totalTokens: num(row.total_tokens), cost: num(row.cost) });
    }
    if (tools) {
      const completed = outcomes ? "result_chars IS NOT NULL AND is_error IN (0, 1)" : "0";
      overview.tools = all(db, `SELECT tool_name, COUNT(*) AS calls, ` +
        `SUM(CASE WHEN ${completed} THEN 1 ELSE 0 END) AS completed, ` +
        `SUM(CASE WHEN ${outcomes ? `(${completed}) AND is_error = 1` : "0"} THEN 1 ELSE 0 END) AS errors ` +
        `FROM tool_calls${toolFilter.sql} GROUP BY tool_name ORDER BY calls DESC, tool_name`, toolFilter.params).map((row) => {
        const calls = num(row.calls), done = num(row.completed), errors = num(row.errors);
        return { name: text(row.tool_name), calls, completed: done, errors, noRecordedOutcome: calls - done, errorRate: done === 0 ? null : errors / done };
      });
      overview.totals.toolCalls = overview.tools.reduce((sum, tool) => sum + tool.calls, 0);
      for (const row of all(db, `SELECT session_file, COUNT(*) AS calls, MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts ` +
        `FROM tool_calls${toolFilter.sql} GROUP BY session_file`, toolFilter.params)) {
        const value = session(text(row.session_file));
        value.toolCalls = num(row.calls);
        value.startedAt = value.requests === 0 ? num(row.first_ts) : Math.min(value.startedAt, num(row.first_ts));
        value.endedAt = Math.max(value.endedAt, num(row.last_ts));
      }
      for (const row of all(db, `SELECT ${agentTypeSelect("", toolCols)}, COUNT(*) AS calls FROM tool_calls${toolFilter.sql} GROUP BY 1`, toolFilter.params)) {
        agent(text(row.agent_type)).toolCalls = num(row.calls);
      }
    }
    overview.sessions = [...sessions.values()].sort((a, b) => b.endedAt - a.endedAt || a.sessionFile.localeCompare(b.sessionFile));
    overview.agents = [...agents.values()].sort((a, b) => b.requests - a.requests || a.agentType.localeCompare(b.agentType));
    const projects = new Map<string, StatsProjectRow>();
    for (const value of overview.sessions) {
      let project = projects.get(value.identity.key);
      if (project === undefined) {
        project = { identity: value.identity, requests: 0, totalTokens: 0, cost: 0, toolCalls: tools ? 0 : null };
        projects.set(value.identity.key, project);
      }
      project.requests += value.requests;
      project.totalTokens += value.totalTokens;
      project.cost += value.cost;
      if (project.toolCalls !== null) project.toolCalls += value.toolCalls ?? 0;
    }
    overview.projects = [...projects.values()].sort((a, b) => b.requests - a.requests || a.identity.key.localeCompare(b.identity.key));
    const dimensions = all(db, `SELECT DISTINCT provider, model, ${agentTypeSelect("", cols)} FROM messages` +
      (tools ? ` UNION SELECT DISTINCT provider, model, ${agentTypeSelect("", toolCols)} FROM tool_calls` : ""));
    overview.facets.providers = [...new Set(dimensions.map((row) => text(row.provider)))].sort();
    const models = new Map<string, { provider: string; id: string }>();
    for (const row of dimensions) {
      const model = { provider: text(row.provider), id: text(row.model) };
      models.set(JSON.stringify([model.provider, model.id]), model);
    }
    overview.facets.models = [...models.values()].sort((a, b) => a.provider.localeCompare(b.provider) || a.id.localeCompare(b.id));
    overview.facets.agentTypes = [...new Set(dimensions.map((row) => text(row.agent_type)))].sort();
    overview.coverage.latestRequestAt = int((db.prepare("SELECT MAX(timestamp) AS latest FROM messages").get() as Row).latest);
    if (tables.has("file_offsets") && columns(db, "file_offsets").has("session_file")) {
      const indexed = all(db, "SELECT session_file FROM file_offsets");
      overview.coverage.indexedFiles = indexed.length;
      const active = new Set(indexed.map((row) => {
        const file = text(row.session_file);
        return canonicalPath(path.isAbsolute(file) || path.win32.isAbsolute(file) ? file : path.join(context.source.sessionsRoot, file));
      }));
      if (archives !== null) overview.coverage.archiveOnlyFiles = archives.filter((file) => !active.has(file)).length;
    }
    if (overview.coverage.indexedFiles === null) overview.coverage.warnings.push("indexed-files-unavailable");
    if (overview.coverage.archiveOnlyFiles === null) overview.coverage.warnings.push("archive-coverage-unknown");
    overview.dataState = "ready";
    return overview;
  } catch (error) {
    const failed = emptyStatsOverview(query, context.source, error instanceof Error ? error.message : String(error), sqliteDataState(error));
    failed.snapshotAt = snapshotAt;
    failed.databasePresent = overview.databasePresent;
    failed.coverage = overview.coverage;
    return failed;
  } finally {
    try {
      if (transaction) db?.exec("ROLLBACK");
    } finally {
      db?.close();
    }
  }
}
