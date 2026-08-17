import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  addMemory,
  forgetMemory,
  getMemory,
  listMemories,
  readMemoryOverview,
  resolveGlobalBank,
  resolveMemoryBase,
  resolveProjectBank,
  updateMemory,
  type ResolvedBank,
} from "./memory-store";
import { readLayeredConfigScalar } from "./omp-config";

const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-mem-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

// Port of mnemopi's initBeam subset (verified against omp 17.3.5) — the two
// memory tables, both FTS mirrors with all six sync triggers, and the two
// sidecar tables the store touches on update/forget.
const FIXTURE_DDL = `
CREATE TABLE working_memory (
  id TEXT PRIMARY KEY, content TEXT NOT NULL, source TEXT, timestamp TEXT,
  session_id TEXT, importance REAL, metadata_json TEXT, veracity TEXT,
  memory_type TEXT, consolidated_at TEXT, scope TEXT, trust_tier TEXT,
  superseded_by TEXT, created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE episodic_memory (
  id TEXT UNIQUE, content TEXT NOT NULL, source TEXT, timestamp TEXT,
  session_id TEXT, importance REAL, metadata_json TEXT, veracity TEXT,
  memory_type TEXT, superseded_by TEXT,
  created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE VIRTUAL TABLE fts_working USING fts5(id UNINDEXED, content);
CREATE VIRTUAL TABLE fts_episodes USING fts5(content, content='episodic_memory', content_rowid='rowid');
CREATE TRIGGER wm_ai AFTER INSERT ON working_memory BEGIN
  INSERT INTO fts_working(id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER wm_au AFTER UPDATE OF content ON working_memory BEGIN
  DELETE FROM fts_working WHERE id = old.id;
  INSERT INTO fts_working(id, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER wm_ad AFTER DELETE ON working_memory BEGIN
  DELETE FROM fts_working WHERE id = old.id;
END;
CREATE TRIGGER em_ai AFTER INSERT ON episodic_memory BEGIN
  INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER em_au AFTER UPDATE OF content ON episodic_memory BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
  INSERT INTO fts_episodes(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER em_ad AFTER DELETE ON episodic_memory BEGIN
  INSERT INTO fts_episodes(fts_episodes, rowid, content) VALUES ('delete', old.rowid, old.content);
END;
`;

const SIDECAR_DDL = `
CREATE TABLE memory_embeddings (memory_id TEXT PRIMARY KEY, embedding BLOB);
CREATE TABLE memoria_facts (id INTEGER PRIMARY KEY, source_memory_id TEXT, body TEXT);
`;

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

function createFixtureBank(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  withDb(dbPath, (db) => db.exec(FIXTURE_DDL + SIDECAR_DDL));
}

/** A bank a foreign/older mnemopi wrote: no sidecar tables at all. */
function createMinimalBank(dbPath: string): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  withDb(dbPath, (db) => db.exec(FIXTURE_DDL));
}

/** Fresh fixture bank in its own tmp dir, addressed directly (no discovery). */
function fixtureBank(): ResolvedBank {
  const dbPath = path.join(tmpDir(), "mnemopi.db");
  createFixtureBank(dbPath);
  return { bank: "default", dbPath };
}

const NOW = "2026-08-16T12:00:00.000Z";

interface Seed {
  id: string;
  content: string;
  /** When set, metadata_json carries `$.cwd` the way retained rows do. */
  cwd?: string;
  timestamp?: string | null;
  createdAt?: string;
  supersededBy?: string;
  importance?: number;
  source?: string;
}

function insertWorking(dbPath: string, seed: Seed): void {
  withDb(dbPath, (db) =>
    db
      .prepare(
        `INSERT INTO working_memory
           (id, content, source, timestamp, session_id, importance, metadata_json,
            veracity, memory_type, consolidated_at, scope, trust_tier, superseded_by, created_at)
         VALUES (?, ?, ?, ?, 'default', ?, ?, 'stated', 'semantic', ?, 'global', 'STATED', ?, ?)`,
      )
      .run(
        seed.id,
        seed.content,
        seed.source ?? "test",
        seed.timestamp ?? null,
        seed.importance ?? 0.5,
        seed.cwd === undefined ? null : JSON.stringify({ cwd: seed.cwd }),
        seed.createdAt ?? NOW,
        seed.supersededBy ?? null,
        seed.createdAt ?? NOW,
      ),
  );
}

function insertEpisodic(dbPath: string, seed: Seed): void {
  withDb(dbPath, (db) =>
    db
      .prepare(
        `INSERT INTO episodic_memory
           (id, content, source, timestamp, session_id, importance, metadata_json,
            veracity, memory_type, superseded_by, created_at)
         VALUES (?, ?, ?, ?, 'default', ?, ?, 'stated', 'episode', ?, ?)`,
      )
      .run(
        seed.id,
        seed.content,
        seed.source ?? "test",
        seed.timestamp ?? null,
        seed.importance ?? 0.5,
        seed.cwd === undefined ? null : JSON.stringify({ cwd: seed.cwd }),
        seed.supersededBy ?? null,
        seed.createdAt ?? NOW,
      ),
  );
}

function count(dbPath: string, sql: string, ...params: Array<string | number>): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return Number(db.prepare(sql).get(...params)?.n);
  } finally {
    db.close();
  }
}

function getRow(
  dbPath: string,
  sql: string,
  ...params: Array<string | number>
): Record<string, SQLOutputValue> | undefined {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    return db.prepare(sql).get(...params);
  } finally {
    db.close();
  }
}

const MNEMOPI_CONFIG = "memory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n";

interface Setup {
  env: NodeJS.ProcessEnv;
  agentDir: string;
  baseDir: string;
  project: string;
  cwdAbs: string;
}

/**
 * Lays out an agent dir the way omp does and a project dir with a stable
 * basename ("alpha") so discovery's `<seg>-<hash>` regex is predictable.
 * PI_CODING_AGENT_DIR keeps every test away from the real ~/.omp; the env
 * object carries no XDG_STATE_HOME, so the state-dir branch never fires.
 */
function setup(config: string = MNEMOPI_CONFIG): Setup {
  const agentDir = path.join(tmpDir(), "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(path.join(agentDir, "config.yml"), config);
  const project = path.join(tmpDir(), "alpha");
  fs.mkdirSync(project, { recursive: true });
  return {
    env: { PI_CODING_AGENT_DIR: agentDir },
    agentDir,
    baseDir: path.join(agentDir, "memories", "mnemopi"),
    project,
    cwdAbs: path.resolve(project),
  };
}

/** Creates `<baseDir>/banks/<name>/mnemopi.db` as a fixture and returns its path. */
function makeBank(baseDir: string, name: string): string {
  const dbPath = path.join(baseDir, "banks", name, "mnemopi.db");
  createFixtureBank(dbPath);
  return dbPath;
}

const LIST = { query: null, offset: 0, limit: 50 } as const;

describe("resolveMemoryBase / resolveGlobalBank", () => {
  it("reads the mnemopi backend and puts the default bank at the base dir root", () => {
    const { env, baseDir, project } = setup();
    const base = resolveMemoryBase(project, env);
    expect(base.backend).toBe("mnemopi");
    expect(base.scoping).toBe("per-project-tagged");
    expect(base.baseDir).toBe(baseDir);
    expect(base.baseBank).toBe("default");
    expect(resolveGlobalBank(base)).toEqual({
      bank: "default",
      dbPath: path.join(baseDir, "mnemopi.db"),
    });
  });

  it("sanitizes a custom bank name and nests it under banks/", () => {
    const { env, baseDir, project } = setup(
      "memory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n  bank: team!!\n",
    );
    const base = resolveMemoryBase(project, env);
    expect(base.baseBank).toBe("team");
    expect(resolveGlobalBank(base)).toEqual({
      bank: "team",
      dbPath: path.join(baseDir, "banks", "team", "mnemopi.db"),
    });
  });

  it("treats an absent or unrecognized backend as off, with scoping defaulted", () => {
    const off = setup("symbolPreset: unicode\n");
    expect(resolveMemoryBase(off.project, off.env).backend).toBe("off");

    // backend present without mnemopi.scoping ⇒ per-project, not tagged.
    const plain = setup("memory:\n  backend: mnemopi\n");
    const base = resolveMemoryBase(plain.project, plain.env);
    expect(base.backend).toBe("mnemopi");
    expect(base.scoping).toBe("per-project");
  });
});

describe("readLayeredConfigScalar", () => {
  it("lets the project .omp/config.yml override the global layer", () => {
    const { env, project } = setup("memory:\n  backend: local\n");
    fs.mkdirSync(path.join(project, ".omp"), { recursive: true });
    fs.writeFileSync(path.join(project, ".omp", "config.yml"), "memory:\n  backend: mnemopi\n");
    expect(readLayeredConfigScalar(project, "memory", "backend", env)).toBe("mnemopi");
  });

  it("falls back to the global layer when the project says nothing", () => {
    const { env, project } = setup("memory:\n  backend: local\n");
    expect(readLayeredConfigScalar(project, "memory", "backend", env)).toBe("local");
    // Null projectCwd reads the global layer alone.
    expect(readLayeredConfigScalar(null, "memory", "backend", env)).toBe("local");
    expect(readLayeredConfigScalar(null, "memory", "missing", env)).toBeUndefined();
  });
});

describe("resolveProjectBank", () => {
  it("finds the prefix-matching bank whose rows carry the project cwd", () => {
    const { env, baseDir, project, cwdAbs } = setup();
    const dbPath = makeBank(baseDir, "alpha-3k2j9");
    insertWorking(dbPath, { id: "w1", content: "seeded", cwd: cwdAbs });

    const base = resolveMemoryBase(project, env);
    expect(resolveProjectBank(base, project)).toEqual({ bank: "alpha-3k2j9", dbPath });
  });

  it("prefers the cwd-confirmed bank with the newest created_at when two match", () => {
    const { env, baseDir, project, cwdAbs } = setup();
    const older = makeBank(baseDir, "alpha-aaa1");
    const newer = makeBank(baseDir, "alpha-bbb2");
    insertWorking(older, { id: "w1", content: "old", cwd: cwdAbs, createdAt: "2026-01-01T00:00:00.000Z" });
    insertWorking(newer, { id: "w2", content: "new", cwd: cwdAbs, createdAt: "2026-03-01T00:00:00.000Z" });

    const base = resolveMemoryBase(project, env);
    expect(resolveProjectBank(base, project)).toEqual({ bank: "alpha-bbb2", dbPath: newer });
  });

  it("takes a single fresh name match even before any row confirms the cwd", () => {
    const { env, baseDir, project } = setup();
    const dbPath = makeBank(baseDir, "alpha-ccc3"); // empty: no cwd rows yet
    const base = resolveMemoryBase(project, env);
    expect(resolveProjectBank(base, project)).toEqual({ bank: "alpha-ccc3", dbPath });
  });

  it("returns null when nothing matches by name or by cwd", () => {
    const { env, baseDir, project } = setup();
    // Foreign project's bank, no rows tagged with our cwd.
    insertWorking(makeBank(baseDir, "beta-zz9"), { id: "w1", content: "foreign", cwd: "/elsewhere" });
    const base = resolveMemoryBase(project, env);
    expect(resolveProjectBank(base, project)).toBeNull();

    // Missing banks/ dir entirely.
    const bare = setup();
    expect(resolveProjectBank(resolveMemoryBase(bare.project, bare.env), bare.project)).toBeNull();
  });

  it("skips a corrupt candidate db silently instead of throwing", () => {
    const { env, baseDir, project, cwdAbs } = setup();
    const corruptDir = path.join(baseDir, "banks", "alpha-dddd4");
    fs.mkdirSync(corruptDir, { recursive: true });
    fs.writeFileSync(path.join(corruptDir, "mnemopi.db"), "this is not a sqlite database");
    const good = makeBank(baseDir, "alpha-eee5");
    insertWorking(good, { id: "w1", content: "survivor", cwd: cwdAbs });

    const base = resolveMemoryBase(project, env);
    expect(resolveProjectBank(base, project)).toEqual({ bank: "alpha-eee5", dbPath: good });
  });

  it("matches base-bank-prefixed names when a custom bank is configured", () => {
    const { env, baseDir, project, cwdAbs } = setup(
      "memory:\n  backend: mnemopi\nmnemopi:\n  scoping: per-project-tagged\n  bank: team\n",
    );
    const dbPath = makeBank(baseDir, "team-alpha-ab12");
    insertWorking(dbPath, { id: "w1", content: "seeded", cwd: cwdAbs });

    const base = resolveMemoryBase(project, env);
    expect(resolveProjectBank(base, project)).toEqual({ bank: "team-alpha-ab12", dbPath });
  });
});

describe("listMemories / getMemory", () => {
  it("interleaves both stores newest-first and excludes superseded rows", () => {
    const bank = fixtureBank();
    insertWorking(bank.dbPath, { id: "w-old", content: "oldest", timestamp: "2026-01-01T00:00:00.000Z" });
    insertEpisodic(bank.dbPath, { id: "e-mid", content: "middle", timestamp: "2026-02-01T00:00:00.000Z" });
    insertWorking(bank.dbPath, { id: "w-new", content: "newest", timestamp: "2026-03-01T00:00:00.000Z" });
    insertWorking(bank.dbPath, {
      id: "w-gone",
      content: "replaced",
      timestamp: "2026-04-01T00:00:00.000Z",
      supersededBy: "w-new",
    });
    insertEpisodic(bank.dbPath, {
      id: "e-gone",
      content: "replaced too",
      timestamp: "2026-05-01T00:00:00.000Z",
      supersededBy: "e-mid",
    });

    const page = listMemories(bank, "global", { ...LIST });
    expect(page.rows.map((r) => r.id)).toEqual(["w-new", "e-mid", "w-old"]);
    expect(page.rows.map((r) => r.store)).toEqual(["working", "episodic", "working"]);
    expect(page.total).toBe(3);
    expect(page.scope).toBe("global");
    expect(page.bank).toBe(bank.bank);
  });

  it("finds rows in both FTS mirrors, still recency-ordered", () => {
    const bank = fixtureBank();
    insertWorking(bank.dbPath, { id: "w1", content: "the striped zebra sleeps", timestamp: "2026-01-01T00:00:00.000Z" });
    insertEpisodic(bank.dbPath, { id: "e1", content: "a zebra crossed the road", timestamp: "2026-02-01T00:00:00.000Z" });
    insertWorking(bank.dbPath, { id: "w2", content: "unrelated giraffe", timestamp: "2026-03-01T00:00:00.000Z" });
    insertWorking(bank.dbPath, {
      id: "w-gone",
      content: "zebra but superseded",
      timestamp: "2026-04-01T00:00:00.000Z",
      supersededBy: "w1",
    });

    const page = listMemories(bank, "global", { ...LIST, query: "zebra" });
    expect(page.rows.map((r) => r.id)).toEqual(["e1", "w1"]);
    expect(page.total).toBe(2);
  });

  it("survives a hostile FTS query instead of passing raw syntax through", () => {
    const bank = fixtureBank();
    insertWorking(bank.dbPath, { id: "w1", content: "anything" });
    expect(() => listMemories(bank, "global", { ...LIST, query: '"a" OR (' })).not.toThrow();
  });

  it("clips long content in lists while getMemory returns it whole", () => {
    const bank = fixtureBank();
    const long = "needle " + "x".repeat(700);
    insertWorking(bank.dbPath, { id: "w1", content: long });

    const listed = listMemories(bank, "global", { ...LIST }).rows[0]!;
    expect(listed.truncated).toBe(true);
    expect(listed.content.length).toBeLessThan(long.length);
    expect(listed.content.startsWith("needle")).toBe(true);

    const full = getMemory(bank, "w1");
    expect(full?.content).toBe(long);
    expect(full?.truncated).toBe(false);
    expect(full?.store).toBe("working");
  });

  it("looks up episodic rows by id and misses cleanly", () => {
    const bank = fixtureBank();
    insertEpisodic(bank.dbPath, { id: "e1", content: "short episode" });
    expect(getMemory(bank, "e1")?.store).toBe("episodic");
    expect(getMemory(bank, "nope")).toBeNull();
  });
});

describe("addMemory", () => {
  it("writes a consolidated STATED global-scope row that FTS finds immediately", () => {
    const bank = fixtureBank();
    const project = tmpDir();
    const row = addMemory(bank, "project", project, "  the capital of atlantis is poseidonia  ");

    expect(row.store).toBe("working");
    expect(row.content).toBe("the capital of atlantis is poseidonia");

    const raw = getRow(bank.dbPath, "SELECT * FROM working_memory WHERE id = ?", row.id)!;
    // consolidated_at guards the row from mnemopi's TTL trim; scope/trust/veracity
    // must be valid enums so recall treats it as a session-independent stated fact.
    expect(typeof raw.consolidated_at).toBe("string");
    expect(raw.scope).toBe("global");
    expect(raw.trust_tier).toBe("STATED");
    expect(raw.veracity).toBe("stated");
    expect(JSON.parse(String(raw.metadata_json))).toEqual({
      cwd: path.resolve(project),
      origin: "omp-ui",
    });

    const hits = listMemories(bank, "project", { ...LIST, query: "poseidonia" });
    expect(hits.rows.map((r) => r.id)).toContain(row.id);
  });

  it("omits the cwd tag for global-scope adds and rejects empty content", () => {
    const bank = fixtureBank();
    const row = addMemory(bank, "global", tmpDir(), "a global note");
    const raw = getRow(bank.dbPath, "SELECT metadata_json FROM working_memory WHERE id = ?", row.id)!;
    expect(JSON.parse(String(raw.metadata_json))).toEqual({ origin: "omp-ui" });

    expect(() => addMemory(bank, "global", tmpDir(), "   ")).toThrow();
  });
});

describe("updateMemory", () => {
  function seedEmbedded(bank: ResolvedBank, id: string, content: string): void {
    insertWorking(bank.dbPath, { id, content });
    withDb(bank.dbPath, (db) =>
      db.prepare("INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, NULL)").run(id),
    );
  }

  it("re-indexes FTS and drops the stale embedding on a content change", () => {
    const bank = fixtureBank();
    seedEmbedded(bank, "w1", "ancient zebra migration");

    expect(updateMemory(bank, "w1", { content: "modern quokka migration" })).toEqual({ status: "ok" });

    expect(listMemories(bank, "global", { ...LIST, query: "quokka" }).rows.map((r) => r.id)).toEqual(["w1"]);
    expect(listMemories(bank, "global", { ...LIST, query: "zebra" }).rows).toEqual([]);
    expect(count(bank.dbPath, "SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?", "w1")).toBe(0);
  });

  it("keeps the embedding on an importance-only change", () => {
    const bank = fixtureBank();
    seedEmbedded(bank, "w1", "stable content");

    expect(updateMemory(bank, "w1", { importance: 0.25 })).toEqual({ status: "ok" });

    const raw = getRow(bank.dbPath, "SELECT content, importance FROM working_memory WHERE id = ?", "w1")!;
    expect(raw.content).toBe("stable content");
    expect(raw.importance).toBe(0.25);
    expect(count(bank.dbPath, "SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?", "w1")).toBe(1);
  });

  it("clamps importance into [0, 1]", () => {
    const bank = fixtureBank();
    insertWorking(bank.dbPath, { id: "hi", content: "a" });
    insertWorking(bank.dbPath, { id: "lo", content: "b" });

    updateMemory(bank, "hi", { importance: 7 });
    updateMemory(bank, "lo", { importance: -2 });

    expect(getRow(bank.dbPath, "SELECT importance FROM working_memory WHERE id = ?", "hi")!.importance).toBe(1);
    expect(getRow(bank.dbPath, "SELECT importance FROM working_memory WHERE id = ?", "lo")!.importance).toBe(0);
  });

  it("refuses episodic rows and reports unknown ids", () => {
    const bank = fixtureBank();
    insertEpisodic(bank.dbPath, { id: "e1", content: "an episode" });
    expect(updateMemory(bank, "e1", { importance: 0.5 })).toEqual({ status: "not_editable" });
    expect(updateMemory(bank, "missing", { importance: 0.5 })).toEqual({ status: "not_found" });
  });
});

describe("forgetMemory", () => {
  it("removes the row plus its FTS, embedding, and memoria_facts residue", () => {
    const bank = fixtureBank();
    insertWorking(bank.dbPath, { id: "w1", content: "forget this zebra" });
    withDb(bank.dbPath, (db) => {
      db.prepare("INSERT INTO memory_embeddings (memory_id, embedding) VALUES (?, NULL)").run("w1");
      db.prepare("INSERT INTO memoria_facts (source_memory_id, body) VALUES (?, ?)").run("w1", "derived fact");
    });

    expect(forgetMemory(bank, "w1")).toEqual({ status: "ok" });

    expect(count(bank.dbPath, "SELECT COUNT(*) AS n FROM working_memory WHERE id = ?", "w1")).toBe(0);
    expect(count(bank.dbPath, "SELECT COUNT(*) AS n FROM fts_working WHERE id = ?", "w1")).toBe(0);
    expect(count(bank.dbPath, "SELECT COUNT(*) AS n FROM memory_embeddings WHERE memory_id = ?", "w1")).toBe(0);
    expect(count(bank.dbPath, "SELECT COUNT(*) AS n FROM memoria_facts WHERE source_memory_id = ?", "w1")).toBe(0);
  });

  it("tolerates a bank without any optional sidecar tables", () => {
    // Foreign banks predate some sidecars; every optional DELETE is
    // tableExists-guarded, so their absence must not abort the forget.
    const dbPath = path.join(tmpDir(), "mnemopi.db");
    createMinimalBank(dbPath);
    const bank: ResolvedBank = { bank: "default", dbPath };
    insertWorking(dbPath, { id: "w1", content: "bare bank row" });

    expect(() => forgetMemory(bank, "w1")).not.toThrow();
    expect(count(dbPath, "SELECT COUNT(*) AS n FROM working_memory WHERE id = ?", "w1")).toBe(0);
  });

  it("refuses episodic rows and reports unknown ids", () => {
    const bank = fixtureBank();
    insertEpisodic(bank.dbPath, { id: "e1", content: "an episode" });
    expect(forgetMemory(bank, "e1")).toEqual({ status: "not_editable" });
    expect(forgetMemory(bank, "missing")).toEqual({ status: "not_found" });
  });
});

describe("readMemoryOverview", () => {
  it("returns an off overview without touching disk when the backend is off", () => {
    const { env, project } = setup("symbolPreset: unicode\n");
    const overview = readMemoryOverview(project, env);
    expect(overview.backend).toBe("off");
    expect(overview.error).toBeNull();
    expect(overview.global.exists).toBe(false);
    expect(overview.global.workingCount).toBe(0);
    expect(overview.global.episodicCount).toBe(0);
  });

  it("reports a missing base dir as absent banks, not as an error", () => {
    const { env, baseDir, project } = setup();
    const overview = readMemoryOverview(project, env);
    expect(overview.backend).toBe("mnemopi");
    expect(overview.baseDir).toBe(baseDir);
    expect(overview.error).toBeNull();
    expect(overview.global).toMatchObject({
      exists: false,
      workingCount: 0,
      episodicCount: 0,
      lastWrite: null,
    });
    expect(overview.project).toBeNull();
  });

  it("counts both stores of an existing global bank", () => {
    const { env, baseDir, project } = setup();
    const dbPath = path.join(baseDir, "mnemopi.db");
    createFixtureBank(dbPath);
    insertWorking(dbPath, { id: "w1", content: "one" });
    insertWorking(dbPath, { id: "w2", content: "two" });
    insertEpisodic(dbPath, { id: "e1", content: "three" });

    const overview = readMemoryOverview(project, env);
    expect(overview.error).toBeNull();
    expect(overview.global.exists).toBe(true);
    expect(overview.global.workingCount).toBe(2);
    expect(overview.global.episodicCount).toBe(1);
    expect(overview.global.sizeBytes).toBeGreaterThan(0);
    expect(typeof overview.global.lastWrite).toBe("string");
  });
});
