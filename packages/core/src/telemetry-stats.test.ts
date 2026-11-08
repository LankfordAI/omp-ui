import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StatsReadContext } from "./stats-attribution";
import { readTelemetryModelUsage } from "./telemetry-stats";
import type { OwnedSessionRecord, ProjectRecord } from "./types";
import { telemetryModelDimensions } from "./telemetry-models";

const HOUR = 3_600_000;
const DAY = 86_400_000;
const START = Date.UTC(2026, 10, 7);
const LINEAGE = "omp-ui--project--11111111-2222-3333-4444-555555555555";
const temporaryRoots: string[] = [];
const databases: DatabaseSync[] = [];

// The same required raw-message shape as stats-store's OMP fixtures. Optional
// rollups and tool tables are absent: this reader counts only recorded requests.
const MESSAGES = `CREATE TABLE messages (
  session_file TEXT NOT NULL, entry_id TEXT NOT NULL, folder TEXT NOT NULL,
  model TEXT NOT NULL, provider TEXT NOT NULL, timestamp INTEGER NOT NULL,
  duration INTEGER, stop_reason TEXT NOT NULL DEFAULT 'stop',
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0, cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0, cost_total REAL NOT NULL DEFAULT 0,
  UNIQUE(session_file, entry_id)
)`;

function fixture(): { root: string; db: DatabaseSync; context: StatsReadContext; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-telemetry-stats-"));
  temporaryRoots.push(root);
  const project: ProjectRecord = {
    path: path.join(root, "project"), name: "Private Project", addedAt: "2026-01-01", lastModel: null,
    lastThinkingLevel: null, lastAdvisor: null, lastAdvisorModel: null, defaultModel: null,
    defaultAdvisorModel: null, browserClock: false, councilRoster: null, knowledgeHome: null,
    repositoryKey: null, icon: null,
  };
  const session: OwnedSessionRecord = {
    tabId: "tab", sessionId: "root", lineageDir: LINEAGE, projectCwd: project.path, worktree: null,
    planImplementationSource: null, experiment: null, launchedAt: "2026-01-01", mode: "pty",
    agentMode: "build", compactionMethod: null, approvalMode: null, serviceTier: null,
    model: "selected-but-never-requested", thinkingLevel: null, advisor: false, advisorModel: null,
    subagentModels: null, proposedPlans: [], private: false, chat: false, askSource: null,
    fleet: null, autoTitled: false, snoozed: false, snoozedUntilMs: null, pinnedAtMs: null,
    heldPrompt: null, scheduledPrompt: null, pullRequests: [], autoSettleOnMerge: null,
    cachedTitle: "Private title", cachedModified: null,
  };
  const sessionsRoot = path.join(root, "sessions");
  const archiveRoot = path.join(root, "archive");
  const databasePath = path.join(root, "stats.db");
  const context: StatsReadContext = {
    source: { profile: null, databasePath, sessionsRoot, archiveRoot },
    projects: [project], sessions: [session], ownedSessionsRoot: sessionsRoot, ownedArchiveRoot: archiveRoot,
  };
  const db = new DatabaseSync(databasePath);
  databases.push(db);
  db.exec(MESSAGES);
  return { root, db, context, file: path.join(sessionsRoot, LINEAGE, "root.jsonl") };
}

function message(db: DatabaseSync, file: string, id: string, timestamp = START, provider = "openai", model = "gpt-4o"): void {
  db.prepare("INSERT INTO messages (session_file, entry_id, folder, model, provider, timestamp) VALUES (?, ?, ?, ?, ?, ?)")
    .run(file, id, "/private/stored/folder", model, provider, timestamp);
}

function close(db: DatabaseSync): void {
  db.close();
  databases.splice(databases.indexOf(db), 1);
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const db of databases.splice(0)) db.close();
  for (const root of temporaryRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("readTelemetryModelUsage", () => {
  it("counts recorded messages at inclusive/exclusive absolute bounds and groups by UTC hour", async () => {
    const { db, context, file } = fixture();
    message(db, file, "before", START - 1);
    message(db, file, "at-since", START);
    message(db, file, "end-of-day", START + DAY - 1);
    message(db, file, "offset", Date.parse("2026-11-07T23:30:00-07:00"));
    message(db, file, "at-last-ms", START + 2 * DAY - 1);
    message(db, file, "at-until", START + 2 * DAY);
    // Zero token/cost rows and errors are still recorded request COUNT(*),
    // not selected defaults, token sums, tools, or successful-turn counts.
    db.prepare("UPDATE messages SET stop_reason = 'error' WHERE entry_id = 'at-since'").run();
    message(db, file, "other-route", START, "anthropic", "private-deployment");
    expect(await readTelemetryModelUsage(context, START, START + 2 * DAY)).toEqual([
      { hour: "2026-11-07T00:00:00.000Z", provider: "anthropic", model: "private-deployment", requests: 1 },
      { hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
      { hour: "2026-11-07T23:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
      { hour: "2026-11-08T06:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
      { hour: "2026-11-08T23:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
    ]);
    expect(await readTelemetryModelUsage(context, START, START)).toEqual([]);
  });

  it("uses UTC hour boundaries on either side of the Unix epoch", async () => {
    const { db, context, file } = fixture();
    message(db, file, "negative", -1);
    message(db, file, "epoch", 0);
    expect(await readTelemetryModelUsage(context, -1, 1)).toEqual([
      { hour: "1969-12-31T23:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
      { hour: "1970-01-01T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
    ]);
  });

  it("keeps adjacent same-day hours separate across a multi-hour catch-up window", async () => {
    const { db, context, file } = fixture();
    message(db, file, "first", START);
    message(db, file, "first-last-ms", START + HOUR - 1);
    message(db, file, "second", START + HOUR);
    message(db, `${LINEAGE}/root/subagents/worker.jsonl`, "second-worker", START + HOUR + 1);
    message(db, file, "third", START + 2 * HOUR);
    message(db, file, "next-window", START + 3 * HOUR);
    message(db, path.join(context.ownedSessionsRoot, `${LINEAGE}-unrelated`, "root.jsonl"), "foreign", START + HOUR);
    expect(await readTelemetryModelUsage(context, START, START + 3 * HOUR)).toEqual([
      { hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 2 },
      { hour: "2026-11-07T01:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 2 },
      { hour: "2026-11-07T02:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
    ]);
  });

  it("excludes requests before consent and at the upper boundary within the same hour", async () => {
    const { db, context, file } = fixture();
    const since = START + 20 * 60_000;
    const until = START + 40 * 60_000;
    message(db, file, "before-consent", since - 1);
    message(db, file, "at-consent", since);
    message(db, file, "last-consented-ms", until - 1);
    message(db, file, "at-until", until);
    expect(await readTelemetryModelUsage(context, since, until)).toEqual([
      { hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 2 },
    ]);
  });

  it("admits exact registered active/archive lineages and nested subagents, not project or lookalike files", async () => {
    const { root, db, context, file } = fixture();
    // The stats source is independent of omp-ui ownership. Absolute stored keys
    // in owned roots still qualify, but the same lineage under the source does not.
    context.source = { ...context.source, sessionsRoot: path.join(root, "omp-sessions") };
    const accepted = [
      file,
      path.join(context.ownedSessionsRoot, LINEAGE, "root", "subagents", "worker", "nested.jsonl"),
      path.join(context.ownedSessionsRoot, LINEAGE, "fork.jsonl"),
      path.join(context.ownedArchiveRoot, LINEAGE, "archived.jsonl.gz"),
      path.join(context.ownedArchiveRoot, LINEAGE, "archived", "subagents", "worker.jsonl.gz"),
    ];
    const rejected = [
      path.join(context.source.sessionsRoot, LINEAGE, "same-lineage.jsonl"),
      path.join(context.ownedSessionsRoot, "terminal", "session.jsonl"),
      path.join(context.ownedSessionsRoot, `${LINEAGE}-lookalike`, "session.jsonl"),
      path.join(`${context.ownedSessionsRoot}-lookalike`, LINEAGE, "session.jsonl"),
      path.join(context.ownedArchiveRoot, `${LINEAGE}-lookalike`, "session.jsonl.gz"),
      path.join(context.projects[0]!.path, "session.jsonl"),
      path.join(context.ownedSessionsRoot, LINEAGE),
      `../sessions/${LINEAGE}/escape.jsonl`,
      `${file}\0private`,
    ];
    for (const [index, key] of accepted.entries()) message(db, key, `owned-${index}`);
    for (const [index, key] of rejected.entries()) message(db, key, `foreign-${index}`);
    const terminal = rejected[1]!;
    fs.mkdirSync(path.dirname(terminal), { recursive: true });
    fs.writeFileSync(terminal, `${JSON.stringify({ type: "session", cwd: context.projects[0]!.path })}\n`);
    // Accepted transcripts deliberately never exist: registry ownership survives
    // archive/missing files and does not fall back to reading a matching cwd.
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toEqual([
      { hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: accepted.length },
    ]);
  });

  it("supports confined relative source keys and aggregates the same dimensions across owned files", async () => {
    const { db, context, file } = fixture();
    message(db, `${LINEAGE}/root/subagents/worker.jsonl`, "relative");
    message(db, file, "absolute");
    message(db, `../sessions-lookalike/${LINEAGE}/session.jsonl`, "escape");
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toEqual([
      { hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 2 },
    ]);
  });

  it("never mistakes NUL-bearing private identifiers for their public model or provider prefixes", async () => {
    const { db, context, file } = fixture();
    message(db, file, "private-model", START, "openai", "gpt-4o\0private-deployment");
    message(db, file, "private-provider", START, "openai\0private-route", "gpt-4o");
    message(db, file, "public", START, "openai", "gpt-4o");
    const rows = await readTelemetryModelUsage(context, START, START + DAY);
    expect(rows?.map((row) => ({ ...telemetryModelDimensions(row.provider, row.model), requests: row.requests }))).toEqual([
      { provider: "custom/other", model: "custom/other", requests: 1 },
      { provider: "openai", model: "custom/other", requests: 1 },
      { provider: "openai", model: "gpt-4o", requests: 1 },
    ]);
  });

  it("reads schema and counts in one consistent WAL snapshot", async () => {
    const { db, context, file } = fixture();
    db.exec("PRAGMA journal_mode = WAL");
    message(db, file, "before");
    const original = DatabaseSync.prototype.prepare;
    let wrote = false;
    vi.spyOn(DatabaseSync.prototype, "prepare").mockImplementation(function (this: DatabaseSync, sql: string) {
      if (!wrote && sql.startsWith("SELECT session_file, strftime")) {
        wrote = true;
        message(db, file, "after");
      }
      return original.call(this, sql);
    });
    const result = await readTelemetryModelUsage(context, START, START + DAY);
    vi.restoreAllMocks();
    expect(wrote).toBe(true);
    expect(result).toEqual([{ hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 }]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(2);
  });

  it("does not change database bytes, schema, or an existing writer transaction", async () => {
    const { db, context, file } = fixture();
    message(db, file, "committed");
    const bytes = fs.readFileSync(context.source.databasePath);
    const schema = db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all();
    db.exec("BEGIN IMMEDIATE");
    message(db, file, "uncommitted");
    try {
      expect(await readTelemetryModelUsage(context, START, START + DAY)).toEqual([
        { hour: "2026-11-07T00:00:00.000Z", provider: "openai", model: "gpt-4o", requests: 1 },
      ]);
      expect(db.prepare("SELECT sql FROM sqlite_master ORDER BY name").all()).toEqual(schema);
      expect(fs.readFileSync(context.source.databasePath)).toEqual(bytes);
      expect(db.prepare("SELECT COUNT(*) AS count FROM messages").get()?.count).toBe(2);
    } finally {
      db.exec("ROLLBACK");
    }
  });

  it("returns empty only for missing or successfully read empty data, not foreign/corrupt/unavailable stores", async () => {
    const { db, context } = fixture();
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toEqual([]);
    db.exec("DROP TABLE messages; CREATE TABLE unrelated (id INTEGER)");
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toBeNull();
    db.exec("CREATE TABLE messages (session_file TEXT, model TEXT, provider TEXT, timestamp INTEGER)");
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toBeNull();
    close(db);
    fs.writeFileSync(context.source.databasePath, "not a SQLite database");
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toBeNull();
    fs.writeFileSync(context.source.databasePath, Buffer.concat([Buffer.from("SQLite format 3\0"), Buffer.alloc(100)]));
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toBeNull();
    fs.unlinkSync(context.source.databasePath);
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toEqual([]);
    expect(fs.existsSync(context.source.databasePath)).toBe(false);
    fs.mkdirSync(context.source.databasePath);
    expect(await readTelemetryModelUsage(context, START, START + DAY)).toBeNull();
  });

  it("does not report zero when the intended database is exclusively locked", async () => {
    const { db, context } = fixture();
    db.exec("BEGIN EXCLUSIVE");
    try {
      expect(await readTelemetryModelUsage(context, START, START + DAY)).toBeNull();
    } finally {
      db.exec("ROLLBACK");
    }
  });

  it.each([[NaN, START], [START, Infinity], [START + 1, START]])("rejects invalid bounds without reporting zero", async (since, until) => {
    const { context } = fixture();
    expect(await readTelemetryModelUsage(context, since, until)).toBeNull();
  });
});
