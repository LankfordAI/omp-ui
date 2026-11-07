import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as attribution from "./stats-attribution";
import type { StatsReadContext } from "./stats-attribution";
import { emptyStatsOverview, readStatsOverview } from "./stats-store";
import type { OwnedSessionRecord, ProjectRecord, StatsOverview, StatsQuery } from "./types";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stats-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// omp v18.4.0's DDL (packages/stats/src/db.ts), verbatim, trimmed to the
// tables this reader touches. The rollup tables ship with rollup_version 3.
const MESSAGES_184 = `CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  api TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  duration INTEGER,
  stop_reason TEXT NOT NULL,
  error_message TEXT,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens INTEGER NOT NULL,
  premium_requests REAL NOT NULL,
  cost_input REAL NOT NULL,
  cost_output REAL NOT NULL,
  cost_cache_read REAL NOT NULL,
  cost_cache_write REAL NOT NULL,
  cost_total REAL NOT NULL,
  cost_no_cache_input REAL,
  cost_unpriced INTEGER NOT NULL DEFAULT 0,
  agent_type TEXT NOT NULL DEFAULT 'main',
  UNIQUE(session_file, entry_id)
)`;

// The 18.3-era shape the dev box's live DB still has: no cost_no_cache_input,
// no cost_unpriced. Pass `legacyPremium` for the even older shape without
// premium_requests / agent_type either.
const MESSAGES_LEGACY = (legacyPremium: boolean): string =>
  MESSAGES_184
    .replace("  cost_no_cache_input REAL,\n  cost_unpriced INTEGER NOT NULL DEFAULT 0,\n", "")
    .replace(legacyPremium ? "  premium_requests REAL NOT NULL,\n" : "", "")
    .replace(legacyPremium ? "  agent_type TEXT NOT NULL DEFAULT 'main',\n" : "", "");

const TOOL_CALLS = `CREATE TABLE tool_calls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_file TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  tool_call_id TEXT NOT NULL,
  folder TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL,
  timestamp INTEGER NOT NULL,
  calls_in_turn INTEGER NOT NULL DEFAULT 1,
  agent_type TEXT NOT NULL DEFAULT 'main',
  result_chars INTEGER,
  is_error INTEGER
)`;

const META = "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)";

const ROLLUP_TABLES = [
  `CREATE TABLE message_rollup (
    bucket INTEGER NOT NULL,
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    folder TEXT NOT NULL,
    agent_type TEXT NOT NULL,
    requests INTEGER NOT NULL,
    failed INTEGER NOT NULL,
    input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL,
    cache_read_tokens INTEGER NOT NULL,
    cache_write_tokens INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    premium_requests REAL NOT NULL,
    cost_total REAL NOT NULL,
    cost_input REAL NOT NULL,
    cost_output REAL NOT NULL,
    cost_cache_read REAL NOT NULL,
    cost_cache_write REAL NOT NULL,
    unpriced INTEGER NOT NULL,
    cached_prompt_cost REAL NOT NULL,
    no_cache_input_cost REAL NOT NULL,
    duration_sum REAL NOT NULL,
    duration_n INTEGER NOT NULL,
    ttft_sum REAL NOT NULL,
    ttft_n INTEGER NOT NULL,
    tps_sum REAL NOT NULL,
    tps_n INTEGER NOT NULL,
    first_ts INTEGER NOT NULL,
    last_ts INTEGER NOT NULL,
    PRIMARY KEY (bucket, model, provider, folder, agent_type)
  ) WITHOUT ROWID`,
  "CREATE TABLE rollup_dirty (bucket INTEGER PRIMARY KEY) WITHOUT ROWID",
  `CREATE TABLE session_rollup (
    session_file TEXT PRIMARY KEY,
    requests INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER NOT NULL,
    total_tokens INTEGER NOT NULL,
    cost_total REAL NOT NULL,
    unpriced INTEGER NOT NULL,
    models TEXT,
    tool_calls INTEGER NOT NULL
  ) WITHOUT ROWID`,
  "CREATE TABLE session_dirty (session_file TEXT PRIMARY KEY) WITHOUT ROWID",
];

interface MessageSeed {
  sessionFile: string;
  entryId: string;
  folder: string;
  model: string;
  provider: string;
  timestamp: number;
  duration?: number | null;
  stopReason?: string;
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  premium?: number;
  cost?: number;
  unpriced?: boolean;
  agentType?: string;
}

interface SeedOptions {
  rollups?: boolean;
  legacy?: boolean;
  legacyPremium?: boolean;
}

function makeDb(dbPath: string, options: SeedOptions = {}): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(options.legacy ? MESSAGES_LEGACY(options.legacyPremium === true) : MESSAGES_184);
  db.exec(TOOL_CALLS);
  db.exec(META);
  if (options.rollups === true) for (const ddl of ROLLUP_TABLES) db.exec(ddl);
  return db;
}

function seedMessage(db: DatabaseSync, m: MessageSeed, options: SeedOptions = {}): void {
  const legacy = options.legacy === true;
  const legacyPremium = legacy && options.legacyPremium === true;
  const columns = [
    "session_file", "entry_id", "folder", "model", "provider", "api", "timestamp", "duration",
    "stop_reason", "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens",
    "total_tokens", ...(legacyPremium ? [] : ["premium_requests"]), "cost_input", "cost_output",
    "cost_cache_read", "cost_cache_write", "cost_total",
    ...(legacy ? [] : ["cost_unpriced"]), ...(legacyPremium ? [] : ["agent_type"]),
  ];
  const values: (string | number | null)[] = [
    m.sessionFile, m.entryId, m.folder, m.model, m.provider, "anthropic-messages", m.timestamp,
    m.duration ?? null, m.stopReason ?? "stop", m.input ?? 0, m.output ?? 0, m.cacheRead ?? 0,
    m.cacheWrite ?? 0, (m.input ?? 0) + (m.output ?? 0) + (m.cacheRead ?? 0) + (m.cacheWrite ?? 0),
    ...(legacyPremium ? [] : [m.premium ?? 0]), 0, 0, 0, 0, m.cost ?? 0,
    ...(legacy ? [] : [m.unpriced === true ? 1 : 0]), ...(legacyPremium ? [] : [m.agentType ?? "main"]),
  ];
  db.prepare(`INSERT INTO messages (${columns.join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`).run(...values);
}

/** Write the rollup rows for every message bucket, omp's own insert shape. */
function drainRollups(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT (timestamp / ${HOUR_MS}) * ${HOUR_MS} AS bucket, model, provider, folder, agent_type,
              COUNT(*) AS requests,
              SUM(CASE WHEN stop_reason = 'error' THEN 1 ELSE 0 END) AS failed,
              SUM(input_tokens) AS input_tokens, SUM(output_tokens) AS output_tokens,
              SUM(cache_read_tokens) AS cache_read_tokens, SUM(cache_write_tokens) AS cache_write_tokens,
              SUM(total_tokens) AS total_tokens, TOTAL(premium_requests) AS premium_requests,
              TOTAL(cost_total) AS cost_total,
              SUM(CASE WHEN total_tokens > 0 AND cost_total = 0 AND (provider = 'xai-oauth' OR cost_unpriced = 1) THEN 1 ELSE 0 END) AS unpriced,
              MIN(timestamp) AS first_ts, MAX(timestamp) AS last_ts
         FROM messages GROUP BY 1, model, provider, folder, agent_type`,
    )
    .all() as Record<string, SQLOutputValue>[];
  for (const r of rows) {
    db.prepare(
      `INSERT INTO message_rollup (bucket, model, provider, folder, agent_type, requests, failed,
        input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens,
        premium_requests, cost_total, cost_input, cost_output, cost_cache_read, cost_cache_write,
        unpriced, cached_prompt_cost, no_cache_input_cost, duration_sum, duration_n, ttft_sum, ttft_n,
        tps_sum, tps_n, first_ts, last_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, 0, 0, 0, 0, 0, 0, 0, 0, ?, ?)`,
    ).run(
      r.bucket as number, String(r.model), String(r.provider), String(r.folder), String(r.agent_type),
      r.requests as number, r.failed as number, r.input_tokens as number, r.output_tokens as number,
      r.cache_read_tokens as number, r.cache_write_tokens as number, r.total_tokens as number,
      r.premium_requests as number, r.cost_total as number, r.unpriced as number,
      r.first_ts as number, r.last_ts as number,
    );
  }
  db.prepare("INSERT INTO meta (key, value) VALUES ('rollup_version', '3')").run();
}

const NOW = Date.UTC(2026, 10, 7, 12, 34);
const B = NOW - HOUR_MS;
const QUERY: StatsQuery = { rangeDays: null, projectKey: null, provider: null, model: null, agentType: null };

function fixture(options: SeedOptions = {}): { db: DatabaseSync; context: StatsReadContext; files: string[] } {
  const root = tmpDir();
  const sessionsRoot = path.join(root, "sessions");
  const archiveRoot = path.join(root, "archive");
  fs.mkdirSync(sessionsRoot);
  fs.mkdirSync(archiveRoot);
  const projects = ["a", "b", "unused"].map((name) => ({
    path: path.join(root, name), name, addedAt: "2026-01-01", lastModel: null,
  }) as ProjectRecord);
  const sessions = ["a", "b"].map((name, index) => ({
    tabId: name, sessionId: null, lineageDir: `omp-ui--${name}-00000000-0000-0000-0000-00000000000${index}`, projectCwd: projects[index]!.path,
    worktree: null, chat: false, cachedTitle: `Title ${name}`,
  }) as OwnedSessionRecord);
  const files = sessions.map((session) => path.join(sessionsRoot, session.lineageDir, "session.jsonl"));
  for (const file of files) fs.mkdirSync(path.dirname(file), { recursive: true });
  const context: StatsReadContext = {
    source: { profile: null, databasePath: path.join(root, "stats.db"), sessionsRoot, archiveRoot },
    projects, sessions, ownedSessionsRoot: sessionsRoot, ownedArchiveRoot: archiveRoot,
  };
  return { db: makeDb(context.source.databasePath, options), context, files };
}

function message(db: DatabaseSync, file: string, entryId: string, overrides: Partial<MessageSeed> = {}, options: SeedOptions = {}): void {
  seedMessage(db, {
    sessionFile: file, entryId, folder: "/stored/folder-is-not-a-project", model: "same-model", provider: "p",
    timestamp: B, input: 10, output: 5, cost: 0.25, ...overrides,
  }, options);
}

function tool(db: DatabaseSync, file: string, id: string, options: {
  name?: string; provider?: string; model?: string; agent?: string; timestamp?: number;
  chars?: number | null; error?: number | null;
} = {}): void {
  db.prepare(`INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, tool_name, model, provider,
    timestamp, calls_in_turn, agent_type, result_chars, is_error) VALUES (?, ?, ?, '/wrong-folder', ?, ?, ?, ?, 17, ?, ?, ?)`).run(
    file, id, id, options.name ?? "read", options.model ?? "same-model", options.provider ?? "p",
    options.timestamp ?? B, options.agent ?? "main", options.chars ?? null, options.error ?? null,
  );
}

function conserved(stats: StatsOverview): void {
  for (const rows of [stats.days, stats.models, stats.projects, stats.sessions, stats.agents]) {
    expect(rows.reduce((sum, row) => sum + row.requests, 0)).toBe(stats.totals.requests);
    expect(rows.reduce((sum, row) => sum + row.totalTokens, 0)).toBe(stats.totals.totalTokens);
    expect(rows.reduce((sum, row) => sum + row.cost, 0)).toBeCloseTo(stats.totals.cost);
  }
  if (stats.totals.toolCalls !== null) {
    expect(stats.tools.reduce((sum, row) => sum + row.calls, 0)).toBe(stats.totals.toolCalls);
    for (const rows of [stats.projects, stats.sessions, stats.agents]) {
      expect(rows.reduce((sum, row) => sum + (row.toolCalls ?? 0), 0)).toBe(stats.totals.toolCalls);
    }
  }
}

describe("readStatsOverview", () => {
  it("independently merges request and invocation aggregates and preserves canonical ownership", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "m1");
    message(db, files[0]!, "m2", { input: 20 });
    message(db, files[1]!, "m3", { provider: "q", agentType: "advisor", cost: 0.5 });
    tool(db, files[0]!, "t1", { chars: 0, error: 0 });
    tool(db, files[0]!, "t2", { chars: 5, error: 1 });
    tool(db, files[0]!, "t3");
    tool(db, files[1]!, "t4", { provider: "q", agent: "advisor" });
    const toolOnly = path.join(context.ownedSessionsRoot, context.sessions[0]!.lineageDir, "tool-only.jsonl");
    tool(db, toolOnly, "t5", { name: "bash", chars: 0, error: 1 });
    db.close();
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.error).toBeNull();
    expect(stats.dataState).toBe("ready");
    expect(stats.totals).toMatchObject({ requests: 3, toolCalls: 5, totalTokens: 55, cost: 1 });
    expect(stats.sessions).toHaveLength(3);
    expect(stats.sessions.find((row) => row.sessionFile === toolOnly)).toMatchObject({ requests: 0, toolCalls: 1 });
    expect(stats.projects.find((row) => row.identity.key === attribution.statsProjectIdentity(context.projects[0]!).key))
      .toMatchObject({ requests: 2, toolCalls: 4, cost: 0.5 });
    expect(stats.sessions[0]!.title).toBe("Title a");
    expect(stats.tools.find((row) => row.name === "read"))
      .toMatchObject({ calls: 4, completed: 2, errors: 1, noRecordedOutcome: 2, errorRate: 0.5 });
    expect(stats.tools.find((row) => row.name === "bash"))
      .toMatchObject({ calls: 1, completed: 1, errors: 1, errorRate: 1 });
    expect(stats.facets.projects).toContainEqual(attribution.statsProjectIdentity(context.projects[2]!));
    expect(stats.facets.models).toEqual([{ provider: "p", id: "same-model" }, { provider: "q", id: "same-model" }]);
    conserved(stats);
  });

  it("uses the same inclusive hour-aligned window and every dimension for all sections", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { db, context, files } = fixture();
    const cutoff = Math.floor((NOW - 7 * DAY_MS) / HOUR_MS) * HOUR_MS;
    message(db, files[0]!, "old", { timestamp: cutoff - 1 });
    message(db, files[0]!, "keep", { timestamp: cutoff, agentType: "advisor", premium: 0.5 });
    message(db, files[0]!, "provider", { timestamp: cutoff, provider: "q", agentType: "advisor" });
    message(db, files[0]!, "model", { timestamp: cutoff, model: "other", agentType: "advisor" });
    message(db, files[0]!, "agent", { timestamp: cutoff, agentType: "main" });
    message(db, files[1]!, "project", { timestamp: cutoff, agentType: "advisor" });
    tool(db, files[0]!, "keep", { timestamp: cutoff, agent: "advisor", chars: 0, error: 0 });
    tool(db, files[0]!, "old", { timestamp: cutoff - 1, agent: "advisor" });
    tool(db, files[0]!, "provider", { timestamp: cutoff, provider: "q", agent: "advisor" });
    tool(db, files[0]!, "model", { timestamp: cutoff, model: "other", agent: "advisor" });
    tool(db, files[0]!, "agent", { timestamp: cutoff, agent: "main" });
    tool(db, files[1]!, "project", { timestamp: cutoff, agent: "advisor" });
    db.close();
    const query: StatsQuery = {
      rangeDays: 7, projectKey: attribution.statsProjectIdentity(context.projects[0]!).key,
      provider: "p", model: { provider: "p", id: "same-model" }, agentType: "advisor",
    };
    const stats = await readStatsOverview(query, context);
    expect(stats.query).toEqual(query);
    expect(stats.snapshotAt).toBe(NOW);
    expect(stats.totals).toMatchObject({ requests: 1, toolCalls: 1, firstTs: cutoff, premiumRequests: 0.5 });
    expect(stats.sessions[0]).toMatchObject({ requests: 1, startedAt: cutoff, endedAt: cutoff, toolCalls: 1 });
    expect(stats.days[0]!.ts).toBe(Math.floor(cutoff / DAY_MS) * DAY_MS);
    expect(stats.facets.providers).toEqual(["p", "q"]);
    expect(stats.facets.agentTypes).toEqual(["advisor", "main"]);
    conserved(stats);
    const unmatched = await readStatsOverview({ ...query, projectKey: "project:/not-registered" }, context);
    expect(unmatched.totals).toMatchObject({ requests: 0, toolCalls: 0 });
    expect(unmatched.sessions).toEqual([]);
    expect(unmatched.tools).toEqual([]);
    conserved(unmatched);
  });

  it("filters paired models even without provider selection, and does not guess unattributed files", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "p");
    message(db, files[1]!, "q", { provider: "q" });
    message(db, "/missing/transcript.jsonl", "unknown", { provider: "q" });
    tool(db, "/missing/transcript.jsonl", "unknown", { provider: "q" });
    db.close();
    const stats = await readStatsOverview({ ...QUERY, model: { provider: "q", id: "same-model" } }, context);
    expect(stats.totals.requests).toBe(2);
    expect(stats.projects.find((row) => row.identity.kind === "unattributed"))
      .toMatchObject({ requests: 1, toolCalls: 1 });
    conserved(stats);
    const unknown = await readStatsOverview({ ...QUERY, projectKey: "unattributed" }, context);
    expect(unknown.totals.requests).toBe(1);
    conserved(unknown);
  });

  it("handles thousands of project files via JSON membership rather than variable placeholders", async () => {
    const { db, context } = fixture();
    for (let index = 0; index < 1_100; index++) {
      message(db, path.join(context.ownedSessionsRoot, context.sessions[0]!.lineageDir, `nested-${index}.jsonl`), `entry-${index}`);
    }
    db.close();
    const stats = await readStatsOverview({ ...QUERY, projectKey: attribution.statsProjectIdentity(context.projects[0]!).key }, context);
    expect(stats.error).toBeNull();
    expect(stats.totals.requests).toBe(1_100);
    expect(stats.sessions).toHaveLength(1_100);
    conserved(stats);
  });

  it("matches raw and guarded clean/dirty rollup results under unscoped filters", async () => {
    vi.spyOn(Date, "now").mockReturnValue(NOW);
    const { db, context, files } = fixture({ rollups: true });
    const cutoff = Math.floor((NOW - 7 * DAY_MS) / HOUR_MS) * HOUR_MS;
    message(db, files[0]!, "old", { timestamp: cutoff - 1 });
    message(db, files[0]!, "boundary", { timestamp: cutoff, agentType: "advisor", input: 50, stopReason: "error" });
    message(db, files[0]!, "recent", { timestamp: cutoff + HOUR_MS, agentType: "advisor", cost: 0, unpriced: true });
    message(db, files[1]!, "other", { timestamp: cutoff + HOUR_MS, provider: "q" });
    drainRollups(db);
    db.prepare("UPDATE message_rollup SET requests = 999, total_tokens = 999 WHERE bucket = ?").run(cutoff + HOUR_MS);
    db.prepare("INSERT INTO rollup_dirty (bucket) VALUES (?)").run(cutoff + HOUR_MS);
    const query: StatsQuery = { ...QUERY, rangeDays: 7, provider: "p", model: { provider: "p", id: "same-model" }, agentType: "advisor" };
    const rolled = await readStatsOverview(query, context);
    expect(rolled.rollups).toBe(true);
    expect(rolled.totals).toMatchObject({ requests: 2, failed: 1, unpricedRequests: 1 });
    conserved(rolled);
    const projected = await readStatsOverview({ ...query, projectKey: attribution.statsProjectIdentity(context.projects[0]!).key }, context);
    expect(projected.rollups).toBe(false);
    expect(projected.totals).toEqual(rolled.totals);
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'rollup_version'").run();
    const raw = await readStatsOverview(query, context);
    db.close();
    expect(raw.rollups).toBe(false);
    expect({ ...raw, rollups: true }).toEqual(rolled);
  });

  it("falls back when a nominal v3 rollup has incomplete columns", async () => {
    const { db, context, files } = fixture({ rollups: true });
    message(db, files[0]!, "m");
    drainRollups(db);
    db.exec("ALTER TABLE message_rollup RENAME COLUMN requests TO unknown_requests");
    db.close();
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.error).toBeNull();
    expect(stats.rollups).toBe(false);
    expect(stats.totals.requests).toBe(1);
    conserved(stats);
  });

  it("retains pending, empty, partial and malformed outcomes honestly", async () => {
    const { db, context, files } = fixture();
    tool(db, files[0]!, "pending");
    tool(db, files[0]!, "empty", { chars: 0, error: 0 });
    tool(db, files[0]!, "error", { chars: 0, error: 1 });
    tool(db, files[0]!, "chars-only", { chars: 12 });
    tool(db, files[0]!, "error-only", { error: 1 });
    tool(db, files[0]!, "invalid", { chars: 12, error: 2 });
    db.close();
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.tools).toEqual([{ name: "read", calls: 6, completed: 2, errors: 1, noRecordedOutcome: 4, errorRate: 0.5 }]);
    conserved(stats);
  });

  it("reports absent tool data as unavailable rather than zero", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "m");
    db.exec("DROP TABLE tool_calls");
    db.close();
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.capabilities.tools).toBe(false);
    expect(stats.totals.toolCalls).toBeNull();
    expect(stats.sessions[0]!.toolCalls).toBeNull();
    expect(stats.projects[0]!.toolCalls).toBeNull();
    expect(stats.agents[0]!.toolCalls).toBeNull();
    expect(stats.tools).toEqual([]);
    conserved(stats);
  });

  it("retains invocation counts when optional outcome columns are absent", async () => {
    const { db, context, files } = fixture();
    tool(db, files[0]!, "t");
    db.exec("ALTER TABLE tool_calls DROP COLUMN result_chars; ALTER TABLE tool_calls DROP COLUMN is_error");
    db.close();
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.capabilities).toMatchObject({ tools: true, toolOutcomes: false });
    expect(stats.tools).toEqual([{ name: "read", calls: 1, completed: 0, errors: 0, noRecordedOutcome: 1, errorRate: null }]);
    expect(stats.totals.toolCalls).toBe(1);
    conserved(stats);
  });

  it("keeps tool-only dimensions in global facets and separates unknown tool agents", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "known", { agentType: "advisor" });
    tool(db, files[0]!, "unknown", { provider: "tool-provider", model: "tool-model" });
    db.exec("ALTER TABLE tool_calls DROP COLUMN agent_type");
    db.close();
    const all = await readStatsOverview(QUERY, context);
    expect(all.facets.models).toContainEqual({ provider: "tool-provider", id: "tool-model" });
    expect(all.facets.agentTypes).toEqual(["advisor", "unknown"]);
    expect(all.agents).toEqual([
      { agentType: "advisor", requests: 1, totalTokens: 15, cost: 0.25, toolCalls: 0 },
      { agentType: "unknown", requests: 0, totalTokens: 0, cost: 0, toolCalls: 1 },
    ]);
    conserved(all);
    const unknown = await readStatsOverview({ ...QUERY, agentType: "unknown" }, context);
    expect(unknown.totals).toMatchObject({ requests: 0, toolCalls: 1 });
    conserved(unknown);
    const advisor = await readStatsOverview({ ...QUERY, agentType: "advisor" }, context);
    expect(advisor.totals).toMatchObject({ requests: 1, toolCalls: 0 });
    conserved(advisor);
  });

  it("uses unknown legacy agents and existing unpriced and premium semantics", async () => {
    const options = { legacy: true, legacyPremium: true };
    const { db, context, files } = fixture(options);
    message(db, files[0]!, "xai", { provider: "xai-oauth", cost: 0, premium: 9 }, options);
    message(db, files[0]!, "other", { provider: "other", cost: 0 }, options);
    tool(db, files[0]!, "t");
    db.exec("ALTER TABLE tool_calls DROP COLUMN agent_type");
    db.close();
    const stats = await readStatsOverview({ ...QUERY, agentType: "unknown" }, context);
    expect(stats.capabilities.agentTypes).toBe(false);
    expect(stats.totals).toMatchObject({ requests: 2, premiumRequests: 0, unpricedRequests: 1, toolCalls: 1 });
    expect(stats.agents).toEqual([{ agentType: "unknown", requests: 2, totalTokens: 30, cost: 0, toolCalls: 1 }]);
    expect(stats.facets.agentTypes).toEqual(["unknown"]);
    conserved(stats);
    const main = await readStatsOverview({ ...QUERY, agentType: "main" }, context);
    expect(main.totals).toMatchObject({ requests: 0, toolCalls: 0 });
  });

  it("keeps global coverage and facets independent of filters and canonicalizes archive records", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "old", { timestamp: B });
    message(db, files[1]!, "latest", { timestamp: NOW });
    db.exec("CREATE TABLE file_offsets (session_file TEXT PRIMARY KEY, offset INTEGER, last_modified INTEGER)");
    const lineage = context.sessions[0]!.lineageDir;
    const dir = path.join(context.ownedArchiveRoot, lineage);
    fs.mkdirSync(path.join(dir, "artifact"), { recursive: true });
    for (const name of ["indexed.jsonl.gz", "unindexed.jsonl.gz"]) fs.writeFileSync(path.join(dir, name), "not read");
    fs.writeFileSync(path.join(dir, "artifact", "nested.jsonl.gz"), "not a root transcript");
    db.prepare("INSERT INTO file_offsets VALUES (?, 1, 1)").run(path.join(context.ownedSessionsRoot, lineage, "..", lineage, "indexed.jsonl"));
    db.close();
    const stats = await readStatsOverview({ ...QUERY, provider: "does-not-exist" }, context);
    expect(stats.totals.requests).toBe(0);
    expect(stats.facets.providers).toEqual(["p"]);
    expect(stats.coverage).toMatchObject({ latestRequestAt: NOW, indexedFiles: 1, archiveOnlyFiles: 1, sourceRootMismatch: false });
    const mismatch = await readStatsOverview(QUERY, { ...context, ownedSessionsRoot: path.join(tmpDir(), "elsewhere") });
    expect(mismatch.coverage.sourceRootMismatch).toBe(true);
    expect(mismatch.totals.requests).toBe(2);
    const selectedRoot = tmpDir();
    const selectedArchive = path.join(selectedRoot, "archive");
    fs.mkdirSync(selectedArchive);
    const selected = await readStatsOverview(QUERY, {
      ...context, source: { ...context.source, sessionsRoot: selectedRoot, archiveRoot: selectedArchive },
    });
    expect(selected.coverage).toMatchObject({ sourceRootMismatch: true, archiveOnlyFiles: 0 });
    fs.rmSync(selectedArchive, { recursive: true });
    const unavailable = await readStatsOverview(QUERY, {
      ...context, source: { ...context.source, sessionsRoot: selectedRoot, archiveRoot: selectedArchive },
    });
    expect(unavailable.coverage.archiveOnlyFiles).toBeNull();
  });

  it("preserves stored data after source roots disappear and reports coverage unknown", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "stored");
    db.close();
    fs.rmSync(context.ownedSessionsRoot, { recursive: true });
    fs.rmSync(context.ownedArchiveRoot, { recursive: true });
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.totals.requests).toBe(1);
    expect(stats.coverage).toMatchObject({ indexedFiles: null, archiveOnlyFiles: null });
    expect(stats.coverage.warnings).toEqual(["indexed-files-unavailable", "archive-coverage-unknown"]);
    conserved(stats);
  });

  it("resolves snapshot keys introduced during asynchronous preparation synchronously", async () => {
    const { db, context, files } = fixture();
    const resolve = attribution.resolveStatsAttributions;
    const synchronous = vi.spyOn(attribution, "resolveOwnedStatsAttribution");
    vi.spyOn(attribution, "resolveStatsAttributions").mockImplementationOnce(async (keys, ctx) => {
      const result = await resolve(keys, ctx);
      message(db, files[0]!, "late-key");
      tool(db, files[0]!, "late-tool");
      message(db, "/new-unowned/transcript.jsonl", "late-unowned");
      return result;
    });
    const stats = await readStatsOverview({ ...QUERY, projectKey: attribution.statsProjectIdentity(context.projects[0]!).key }, context);
    db.close();
    expect(stats.error).toBeNull();
    expect(stats.totals).toMatchObject({ requests: 1, toolCalls: 1 });
    expect(stats.sessions[0]!.identity.kind).toBe("project");
    expect(synchronous).toHaveBeenCalledWith(files[0], context);
    expect(synchronous).toHaveBeenCalledWith("/new-unowned/transcript.jsonl", context);
    conserved(stats);
  });

  it("reads one WAL snapshot despite a writer between aggregate and metadata queries", async () => {
    const { db, context, files } = fixture();
    db.exec("PRAGMA journal_mode = WAL");
    message(db, files[0]!, "before");
    const original = DatabaseSync.prototype.prepare;
    let wrote = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!wrote && sql === "SELECT MAX(timestamp) AS latest FROM messages") {
        wrote = true;
        message(db, files[1]!, "after", { timestamp: NOW, provider: "after" });
      }
      return original.call(this, sql);
    });
    const stats = await readStatsOverview(QUERY, context);
    vi.restoreAllMocks();
    expect(wrote).toBe(true);
    expect(stats.totals.requests).toBe(1);
    expect(stats.coverage.latestRequestAt).toBe(B);
    expect(stats.facets.providers).toEqual(["p"]);
    conserved(stats);
    expect((db.prepare("SELECT COUNT(*) AS count FROM messages").get() as Row).count).toBe(2);
    db.close();
  });

  it("leaves database bytes, schema and existing writer transaction unchanged", async () => {
    const { db, context, files } = fixture();
    message(db, files[0]!, "committed");
    const before = fs.readFileSync(context.source.databasePath);
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    db.exec("BEGIN IMMEDIATE");
    message(db, files[1]!, "not-committed");
    const stats = await readStatsOverview(QUERY, context);
    expect(stats.error).toBeNull();
    expect(stats.totals.requests).toBe(1);
    expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
    expect(fs.readFileSync(context.source.databasePath)).toEqual(before);
    db.exec("ROLLBACK");
    db.close();
  });

  it("returns distinct missing, incompatible, corrupt, and locked database states", async () => {
    const { db, context } = fixture();
    db.close();
    fs.unlinkSync(context.source.databasePath);
    const missing = await readStatsOverview(QUERY, context);
    expect(missing).toMatchObject({ dataState: "missing", databasePresent: false, error: null, dbPath: context.source.databasePath });
    const foreign = new DatabaseSync(context.source.databasePath);
    foreign.exec("CREATE TABLE other (id INTEGER)");
    foreign.close();
    expect(await readStatsOverview(QUERY, context)).toMatchObject({ dataState: "incompatible", databasePresent: true });
    fs.writeFileSync(context.source.databasePath, "definitely not sqlite");
    expect(await readStatsOverview(QUERY, context)).toMatchObject({ dataState: "corrupt", databasePresent: true });
    fs.unlinkSync(context.source.databasePath);
    const locked = makeDb(context.source.databasePath);
    locked.exec("BEGIN EXCLUSIVE");
    const result = await readStatsOverview(QUERY, context);
    locked.exec("ROLLBACK");
    locked.close();
    expect(result).toMatchObject({ dataState: "locked", databasePresent: true });
  });

  it("exports explicit invalid-source and zero database payloads without inventing capabilities", async () => {
    const invalid = emptyStatsOverview(QUERY, null, "invalid profile", "invalid-source");
    expect(invalid).toMatchObject({ dataState: "invalid-source", databasePresent: false, source: null, dbPath: null });
    expect(invalid.totals.toolCalls).toBeNull();
    const { db, context } = fixture();
    db.close();
    const zero = await readStatsOverview(QUERY, context);
    expect(zero.error).toBeNull();
    expect(zero.dataState).toBe("ready");
    expect(zero.totals).toMatchObject({ requests: 0, totalTokens: 0, cost: 0, firstTs: null, lastTs: null, toolCalls: 0 });
    expect(zero.facets.projects).toHaveLength(3);
    expect(zero.sessions).toEqual([]);
    conserved(zero);
  });
});

type Row = Record<string, SQLOutputValue>;
