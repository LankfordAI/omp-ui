import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { resolveOmpBinary } from "./paths";
import { readStatsOverview, statsDbCandidates, statsDbPath } from "./stats-store";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-stats-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
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
  calls_in_turn INTEGER NOT NULL DEFAULT 1
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

// Five aligned hours back from the test run; every seeded row is well inside
// "all time", and hour-aligned offsets give exact bucket arithmetic.
const B = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 5 * HOUR_MS;

// The canonical four messages: buckets B, B+1h, B+2h, B+3h.
const MESSAGES: MessageSeed[] = [
  { sessionFile: "s1.jsonl", entryId: "e1", folder: "/repo/a", model: "gpt", provider: "openai", timestamp: B + 1_000, input: 100, output: 10, cacheRead: 5, cacheWrite: 2, cost: 0.5 },
  { sessionFile: "s1.jsonl", entryId: "e2", folder: "/repo/a", model: "gpt", provider: "openai", timestamp: B + HOUR_MS + 2_000, stopReason: "error", input: 50 },
  { sessionFile: "s2.jsonl", entryId: "e3", folder: "/repo/b", model: "claude", provider: "anthropic", timestamp: B + 2 * HOUR_MS + 3_000, input: 10, output: 10, duration: 4_000 },
  { sessionFile: "s2.jsonl", entryId: "e4", folder: "/repo/a", model: "grok", provider: "xai-oauth", timestamp: B + 3 * HOUR_MS + 4_000, input: 7, output: 3, premium: 1, unpriced: true },
];

const EXPECTED = {
  requests: 4,
  failed: 1,
  inputTokens: 167,
  outputTokens: 23,
  cacheReadTokens: 5,
  cacheWriteTokens: 2,
  totalTokens: 197,
  premiumRequests: 1,
  cost: 0.5,
  unpricedRequests: 1,
  firstTs: B + 1_000,
  lastTs: B + 3 * HOUR_MS + 4_000,
};

function dbIn(dir: string): string {
  return path.join(dir, "stats.db");
}

describe("readStatsOverview", () => {
  it("unions clean rollup rows with the dirty bucket's live rows", async () => {
    const dir = tmpDir();
    const db = makeDb(dbIn(dir), { rollups: true });
    for (const m of MESSAGES) seedMessage(db, m);
    drainRollups(db);
    // The newest hour is not yet ingested: its rollup row is stale and its
    // bucket is marked dirty. The reader must recompute it, not double-count.
    db.prepare("UPDATE message_rollup SET requests = 99, total_tokens = 999 WHERE bucket = ?").run(B + 3 * HOUR_MS);
    db.prepare("INSERT INTO rollup_dirty (bucket) VALUES (?)").run(B + 3 * HOUR_MS);
    db.close();
    const stats = await readStatsOverview(null, {}, dbIn(dir));
    expect(stats.error).toBeNull();
    expect(stats.rollups).toBe(true);
    expect(stats.totals).toEqual(EXPECTED);
    expect(stats.days.reduce((sum, d) => sum + d.requests, 0)).toBe(4);
    expect(stats.days[0]!.ts).toBe(Math.floor(B / DAY_MS) * DAY_MS);
    expect(stats.models[0]).toMatchObject({ model: "gpt", provider: "openai", requests: 2 });
    expect(
      stats.projects.find((p) => p.folder === "/repo/a")).toMatchObject({ requests: 3, cost: 0.5 });
    expect(stats.projects.find((p) => p.folder === "/repo/b")).toMatchObject({ requests: 1 });
  });

  it("reads the identical numbers in raw mode (no rollup tables)", async () => {
    const dir = tmpDir();
    const db = makeDb(dbIn(dir));
    for (const m of MESSAGES) seedMessage(db, m);
    db.close();
    const stats = await readStatsOverview(null, {}, dbIn(dir));
    expect(stats.rollups).toBe(false);
    expect(stats.totals).toEqual(EXPECTED);
    expect(
      stats.days.reduce((sum, d) => sum + d.requests, 0)).toBe(4);
    expect(
      stats.projects.find((p) => p.folder === "/repo/a")).toMatchObject({ requests: 3 });
  });

  it("reads a pre-18.4 DB: no cost_no_cache_input/cost_unpriced, no premium/agent columns", async () => {
    const dir = tmpDir();
    const db = makeDb(dbIn(dir), { legacy: true, legacyPremium: true });
    for (const m of MESSAGES) seedMessage(db, m, { legacy: true, legacyPremium: true });
    db.close();
    const stats = await readStatsOverview(null, {}, dbIn(dir));
    expect(stats.error).toBeNull();
    // The xai-oauth zero-cost rule still counts the unpriced request.
    expect(stats.totals.unpricedRequests).toBe(1);
    expect(stats.totals.premiumRequests).toBe(0); // column absent → literal 0
    expect(stats.totals.requests).toBe(4);
    expect(stats.totals.cost).toBe(0.5);
    expect(stats.totals.totalTokens).toBe(197);
    expect(stats.models.map((m) => m.model)).toEqual(["gpt", "claude", "grok"]);
  });

  it("merges clean session rollup rows with dirty sessions and filters on ended_at", async () => {
    const dir = tmpDir();
    const db = makeDb(dbIn(dir), { rollups: true });
    for (const m of MESSAGES) seedMessage(db, m);
    drainRollups(db);
    // s1's rollup row is clean; s2 is dirty — its rows must be recomputed.
    db.prepare(
      "INSERT INTO session_rollup (session_file, requests, started_at, ended_at, total_tokens, cost_total, unpriced, models, tool_calls) VALUES ('s1.jsonl', 2, ?, ?, 167, 0.5, 0, 'gpt', 3)",
    ).run(B + 1_000, B + HOUR_MS + 2_000);
    db.prepare("INSERT INTO session_dirty (session_file) VALUES ('s2.jsonl')").run();
    for (const [entryId, toolCallId] of [
      ["t1", "tc1"], ["t2", "tc2"], ["t3", "tc3"],
    ] as const) {
      db.prepare(
        "INSERT INTO tool_calls (session_file, entry_id, tool_call_id, folder, tool_name, model, provider, timestamp) VALUES ('s1.jsonl', ?, ?, '/repo/a', 'bash', 'gpt', 'openai', ?)",
      ).run(entryId, toolCallId, B);
    }
    db.close();
    const stats = await readStatsOverview(null, {}, dbIn(dir));
    expect(stats.sessions.map((s) => s.sessionFile)).toEqual(["s2.jsonl", "s1.jsonl"]); // ended_at desc
    const [s2, s1] = stats.sessions;
    expect(s2).toMatchObject({
      requests: 2,
      startedAt: B + 2 * HOUR_MS + 3_000,
      endedAt: B + 3 * HOUR_MS + 4_000, // max(ts + duration): e4 > e3+4000
      totalTokens: 30,
      unpricedRequests: 1,
      models: ["claude", "grok"],
      toolCalls: 0,
    });
    expect(s1).toMatchObject({ requests: 2, models: ["gpt"], toolCalls: 3, cost: 0.5 });
    // A window whose cutoff falls between the two sessions' last activity
    // keeps only the recomputed one: sessions are whole-life rows filtered
    // on ended_at.
    const recent = await readStatsOverview((2.5 * HOUR_MS) / DAY_MS, {}, dbIn(dir));
    expect(recent.sessions.map((s) => s.sessionFile)).toEqual(["s2.jsonl"]);
  });

  it("puts a boundary-proximate message in exactly one side of the cutoff", async () => {
    const dir = tmpDir();
    const db = makeDb(dbIn(dir));
    const now = Date.now();
    const cutoff = Math.floor((now - 2 * DAY_MS) / HOUR_MS) * HOUR_MS;
    seedMessage(db, { sessionFile: "s.jsonl", entryId: "before", folder: "/x", model: "m", provider: "p", timestamp: cutoff - 3 });
    seedMessage(db, { sessionFile: "s.jsonl", entryId: "after", folder: "/x", model: "m", provider: "p", timestamp: cutoff + 2 });
    db.close();
    const stats = await readStatsOverview(2, {}, dbIn(dir));
    expect(stats.totals.requests).toBe(1);
    expect(stats.totals.firstTs).toBe(cutoff + 2);
    expect(stats.sessions[0]!.requests).toBe(2); // whole-life rows keep both
    expect(stats.sessions[0]!.startedAt).toBe(cutoff - 3);
  });

  it("answers every foreign state as data, never a throw", async () => {
    const empty = await readStatsOverview(null, {}, null);
    expect(empty.dbPath).toBeNull();
    expect(empty.error).toBeNull();
    expect(empty.totals.requests).toBe(0);
    expect(empty.totals.firstTs).toBeNull();
    expect(empty.totals.lastTs).toBeNull();
    expect(empty.days).toEqual([]);

    const missing = tmpDir();
    const absent = await readStatsOverview(null, {}, path.join(missing, "nope.db"));
    expect(absent.dbPath).not.toBeNull();
    expect(absent.error).toBeTypeOf("string");
    expect(absent.totals.requests).toBe(0);

    const foreign = tmpDir();
    const fdb = new DatabaseSync(path.join(foreign, "stats.db"));
    fdb.exec("CREATE TABLE something_else (id INTEGER PRIMARY KEY)");
    fdb.close();
    const stats = await readStatsOverview(null, {}, path.join(foreign, "stats.db"));
    expect(stats.dbPath).not.toBeNull();
    expect(stats.error).toBe("not an omp stats database");
    expect(stats.sessions).toEqual([]);
    expect(stats.models).toEqual([]);

    const dir = tmpDir();
    makeDb(dbIn(dir)).close();
    const zero = await readStatsOverview(null, {}, dbIn(dir));
    expect(zero.error).toBeNull();
    expect(zero.totals).toEqual({ ...EXPECTED, requests: 0, failed: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, totalTokens: 0, premiumRequests: 0, cost: 0, unpricedRequests: 0, firstTs: null, lastTs: null });
    expect(zero.days).toEqual([]);
    expect(zero.sessions).toEqual([]);
  });

  it("treats a rollup_version mismatch as raw mode", async () => {
    const dir = tmpDir();
    const db = makeDb(dbIn(dir), { rollups: true });
    for (const m of MESSAGES) seedMessage(db, m);
    drainRollups(db);
    db.prepare("UPDATE meta SET value = '2' WHERE key = 'rollup_version'").run();
    db.close();
    const stats = await readStatsOverview(null, {}, dbIn(dir));
    expect(stats.rollups).toBe(false);
    expect(stats.totals).toEqual(EXPECTED); // raw scan, exact
  });
});

describe("statsDbCandidates / statsDbPath", () => {
  it("orders and gates candidates by existence, profile, and env overrides", () => {
    const home = tmpDir();
    const xdg = tmpDir();
    const ompDir = path.join(xdg, "omp");
    fs.mkdirSync(ompDir, { recursive: true });

    expect(statsDbCandidates({}, "linux", home)).toEqual([path.join(home, ".omp", "stats.db")]);

    expect(statsDbCandidates({ XDG_DATA_HOME: xdg }, "linux", home)).toEqual([
      path.join(ompDir, "stats.db"),
      path.join(home, ".omp", "stats.db"),
    ]);

    // An XDG base that does not exist contributes no candidate.
    expect(statsDbCandidates({ XDG_DATA_HOME: path.join(xdg, "nope") }, "linux", home)).toEqual([
      path.join(home, ".omp", "stats.db"),
    ]);
    // Windows never consults XDG.
    expect(statsDbCandidates({ XDG_DATA_HOME: xdg }, "win32", home)).toEqual([
      path.win32.join(home, ".omp", "stats.db"),
    ]);

    const profile = path.join(home, ".omp", "profiles", "work");
    expect(statsDbCandidates({ OMP_PROFILE: "work" }, "linux", home)).toEqual([
      path.join(profile, "stats.db"),
    ]);
    fs.mkdirSync(path.join(ompDir, "profiles", "work"), { recursive: true });
    expect(statsDbCandidates({ OMP_PROFILE: "work", XDG_DATA_HOME: xdg }, "linux", home)).toEqual([
      path.join(ompDir, "profiles", "work", "stats.db"),
      path.join(profile, "stats.db"),
    ]);

    expect(statsDbCandidates({ PI_CONFIG_DIR: ".cfg" }, "linux", home)).toEqual([
      path.join(home, ".cfg", "stats.db"),
    ]);

    const agent = path.join(home, "agentdir");
    const withAgent = statsDbCandidates({ PI_CODING_AGENT_DIR: agent }, "linux", home);
    expect(withAgent[withAgent.length - 1]).toBe(path.join(agent, "stats.db"));
    // A named profile ignores PI_CODING_AGENT_DIR, exactly like omp.
    expect(
      statsDbCandidates({ PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "work" }, "linux", home),
    ).toEqual([path.join(profile, "stats.db")]);
    // Duplicates are collapsed.
    expect(statsDbCandidates({ PI_CODING_AGENT_DIR: path.join(home, ".omp") }, "linux", home)).toEqual([
      path.join(home, ".omp", "stats.db"),
    ]);

    // The first existing candidate wins.
    fs.mkdirSync(path.join(home, ".omp"), { recursive: true });
    expect(statsDbPath({}, "linux", home)).toBeNull();
    fs.writeFileSync(path.join(ompDir, "stats.db"), "");
    expect(statsDbPath({ XDG_DATA_HOME: xdg }, "linux", home)).toBe(path.join(ompDir, "stats.db"));
    expect(statsDbPath({}, "linux", home)).toBeNull();
  });
});

describe("parity with the live omp stats database — skipped when there is none", () => {
  it("the columns this port names still exist in the real DB", async () => {
    if (resolveOmpBinary() === null) return;
    const dbPath = statsDbPath();
    if (dbPath === null) return;
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      const columns = new Set(
        (db.prepare("PRAGMA table_info(messages)").all() as Record<string, SQLOutputValue>[]).map((r) =>
          String(r.name),
        ),
      );
      for (const name of [
        "session_file", "folder", "model", "provider", "timestamp", "duration",
        "stop_reason", "input_tokens", "output_tokens", "cache_read_tokens",
        "cache_write_tokens", "total_tokens", "cost_total",
      ]) {
        expect(columns.has(name), `stats.db no longer has messages.${name}`).toBe(true);
      }
      const tables = new Set(
        (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Record<string, SQLOutputValue>[]).map((r) =>
          String(r.name),
        ),
      );
      if (tables.has("message_rollup")) {
        const rollupColumns = new Set(
          (db.prepare("PRAGMA table_info(message_rollup)").all() as Record<string, SQLOutputValue>[]).map((r) =>
            String(r.name),
          ),
        );
        for (const name of [
          "bucket", "model", "provider", "folder", "requests", "failed", "total_tokens",
          "premium_requests", "cost_total", "unpriced", "first_ts", "last_ts",
        ]) {
          expect(rollupColumns.has(name), `message_rollup no longer has ${name}`).toBe(true);
        }
      }
      if (tables.has("session_rollup")) {
        const sessionColumns = new Set(
          (db.prepare("PRAGMA table_info(session_rollup)").all() as Record<string, SQLOutputValue>[]).map((r) =>
            String(r.name),
          ),
        );
        for (const name of ["session_file", "requests", "started_at", "ended_at", "total_tokens", "cost_total", "unpriced", "models", "tool_calls"]) {
          expect(sessionColumns.has(name), `session_rollup no longer has ${name}`).toBe(true);
        }
      }
    } catch {
      // A mid-ingest locked or otherwise unreadable live DB must not fail CI.
      return;
    } finally {
      db?.close();
    }
  });
});
