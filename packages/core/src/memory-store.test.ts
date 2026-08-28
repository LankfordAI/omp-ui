import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import {
  readMemoryOverview,
  resolveGlobalBank,
  resolveMemoryBase,
  resolveProjectBank,
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
// memory tables and both FTS mirrors with all six sync triggers.
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
  withDb(dbPath, (db) => db.exec(FIXTURE_DDL));
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
