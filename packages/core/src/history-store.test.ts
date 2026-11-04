import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  HISTORY_TITLE_SCAN_LIMIT,
  historyDbCandidates,
  readSessionTitles,
} from "./history-store";


const tmpDirs: string[] = [];
function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-ui-history-"));
  tmpDirs.push(dir);
  return dir;
}

// os.homedir() consults process.env.HOME on POSIX at call time, and
// historyDbCandidates' `home` default re-reads it per call — so a stubbed
// HOME keeps readSessionTitles() from ever consulting the developer's real
// ~/.omp through the config-root candidate.
let realHome: string | undefined;
let realUserProfile: string | undefined;
beforeEach(() => {
  realHome = process.env.HOME;
  realUserProfile = process.env.USERPROFILE;
  process.env.HOME = tmpDir();
  process.env.USERPROFILE = process.env.HOME;
});

afterEach(() => {
  if (realHome === undefined) delete process.env.HOME;
  else process.env.HOME = realHome;
  if (realUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = realUserProfile;
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** Synthetic env for a hermetic read: agent dir = dir, HOME = the stubbed tmp. */
function envWithAgent(agentDir: string): NodeJS.ProcessEnv {
  return { PI_CODING_AGENT_DIR: agentDir };
}

function withDb<T>(dbPath: string, fn: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(dbPath);
  try {
    return fn(db);
  } finally {
    db.close();
  }
}

// Port of the real ~/.omp/agent/history.db sqlite_master (verified against an
// omp 18.15.0-era db and upstream v18.16.0 session-index.ts /
// history-storage.ts, where this DDL is byte-stable from v18.3.0). Trimmed to
// nothing: the full shape, including the additively-altered `use_count`.
const FIXTURE_DDL = `CREATE TABLE history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  prompt TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER)),
  cwd TEXT,
  session_id TEXT,
  use_count INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_history_created_at ON history(created_at DESC);
CREATE VIRTUAL TABLE history_fts USING fts5(prompt, content='history', content_rowid='id');
CREATE TRIGGER history_ai AFTER INSERT ON history BEGIN
  INSERT INTO history_fts(rowid, prompt) VALUES (new.id, new.prompt);
END;
CREATE TABLE session_titles (
  session_id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  updated_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE TABLE session_recaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  cwd TEXT NOT NULL,
  recap TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s','now') AS INTEGER))
);
CREATE INDEX idx_session_recaps_session ON session_recaps(session_id, created_at);`;

// Constraint-free twin of `session_titles`: same table and column names but no
// declared types, so SQLite's column affinity stops rewriting damage — an
// integer session_id or numeric/NULL title survives exactly as a damaged page
// would hand it to the reader.
const CONSTRAINTLESS_TITLES_DDL = "CREATE TABLE session_titles (session_id, title, updated_at)";

/** Creates <agentDir>/history.db with the real DDL and returns its path. */
function createFixtureDb(agentDir: string): string {
  const dbPath = path.join(agentDir, "history.db");
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  withDb(dbPath, (db) => db.exec(FIXTURE_DDL));
  return dbPath;
}

function insertTitle(
  dbPath: string,
  sessionId: unknown,
  title: unknown,
  updatedAt: number | bigint,
): void {
  withDb(dbPath, (db) => {
    db.prepare("INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)").run(
      sessionId as never,
      title as never,
      updatedAt as never,
    );
  });
}

describe("readSessionTitles", () => {
  it("reads happy rows keyed by session id", () => {
    const agent = tmpDir();
    const dbPath = createFixtureDb(agent);
    // Also seed `history` so the FTS mirror's insert trigger fires — the full
    // upstream schema must read cleanly, not just the one table.
    withDb(dbPath, (db) => {
      db.prepare("INSERT INTO history (prompt, cwd, session_id) VALUES (?, ?, ?)").run(
        "fix the flaky test",
        "/repo",
        "s-1",
      );
    });
    insertTitle(dbPath, "s-1", "Fix flaky tests", 100);
    insertTitle(dbPath, "s-2", "🔧 OPS: Deploy pipeline", 200);

    const read = readSessionTitles(envWithAgent(agent));
    expect(read.error).toBeNull();
    expect(read.titles).toEqual({
      "s-1": { title: "Fix flaky tests", updatedAt: 100 },
      "s-2": { title: "🔧 OPS: Deploy pipeline", updatedAt: 200 },
    });
  });

  it("drops malformed rows without failing the list", () => {
    const agent = tmpDir();
    const dbPath = path.join(agent, "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    withDb(dbPath, (db) => db.exec(CONSTRAINTLESS_TITLES_DDL));
    insertTitle(dbPath, "good-1", "Kept", 30);
    insertTitle(dbPath, "bad-title-null", null, 40); // NULL title
    insertTitle(dbPath, "bad-title-num", 123, 50); // numeric title
    insertTitle(dbPath, 456, "integer key", 60); // integer session_id
    insertTitle(dbPath, "good-2", "Also kept", 70);

    const read = readSessionTitles(envWithAgent(agent));
    expect(read.error).toBeNull();
    expect(read.titles).toEqual({
      "good-1": { title: "Kept", updatedAt: 30 },
      "good-2": { title: "Also kept", updatedAt: 70 },
    });
  });

  it("keeps the newest row per session id and never re-points the object prototype", () => {
    const agent = tmpDir();
    const dbPath = path.join(agent, "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    withDb(dbPath, (db) => db.exec(CONSTRAINTLESS_TITLES_DDL));
    insertTitle(dbPath, "dup", "older", 10);
    insertTitle(dbPath, "dup", "newer", 20);
    insertTitle(dbPath, "__proto__", "polluted", 30);

    const read = readSessionTitles(envWithAgent(agent));
    expect(read.error).toBeNull();
    expect(read.titles.dup).toEqual({ title: "newer", updatedAt: 20 });
    expect(Object.keys(read.titles)).toEqual(["dup"]);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reports a db without session_titles as foreign, not a throw", () => {
    const agent = tmpDir();
    const dbPath = path.join(agent, "history.db");
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    withDb(dbPath, (db) => db.exec("CREATE TABLE unrelated (x INTEGER)"));

    const read = readSessionTitles(envWithAgent(agent));
    expect(read.titles).toEqual({});
    expect(read.error).toBe("not an omp history database");
  });

  it("reads an empty store as zero titles with no error", () => {
    const agent = tmpDir();
    createFixtureDb(agent);
    const read = readSessionTitles(envWithAgent(agent));
    expect(read).toEqual({ titles: {}, error: null });
  });

  it("reports an absent db without throwing", () => {
    const agent = tmpDir(); // exists, but holds no history.db
    const read = readSessionTitles(envWithAgent(agent));
    expect(read.titles).toEqual({});
    expect(read.error).toBe("omp history database not found");
  });

  it("survives a non-database file at the db path", () => {
    const agent = tmpDir();
    fs.writeFileSync(path.join(agent, "history.db"), "not sqlite at all");
    const read = readSessionTitles(envWithAgent(agent));
    expect(read.titles).toEqual({});
    expect(read.error).not.toBeNull();
  });

  it("coerces bigint updated_at to a JS number", () => {
    const agent = tmpDir();
    const dbPath = createFixtureDb(agent);
    const huge = 9_007_199_254_740_993n; // 2^53 + 1, past safe-integer
    insertTitle(dbPath, "s-big", "Ancient beyond counting", huge);
    const read = readSessionTitles(envWithAgent(agent));
    expect(read.error).toBeNull();
    const entry = read.titles["s-big"];
    expect(typeof entry.updatedAt).toBe("number");
    expect(entry.updatedAt).toBe(Number(huge));
  });

  it("caps the read at HISTORY_TITLE_SCAN_LIMIT newest rows", () => {
    const agent = tmpDir();
    const dbPath = createFixtureDb(agent);
    withDb(dbPath, (db) => {
      const stmt = db.prepare(
        "INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)",
      );
      // One transaction for the whole seed: autocommit would fsync per insert,
      // and 5k fsyncs take minutes on a slow CI disk — long enough to blow the
      // test timeout. The read under test is unaffected by how rows land.
      db.exec("BEGIN");
      try {
        for (let i = 1; i <= HISTORY_TITLE_SCAN_LIMIT + 5; i += 1) {
          stmt.run(`s-${i}`, `Title ${i}`, i);
        }
        db.exec("COMMIT");
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
    const read = readSessionTitles(envWithAgent(agent));
    expect(read.error).toBeNull();
    expect(Object.keys(read.titles)).toHaveLength(HISTORY_TITLE_SCAN_LIMIT);
    // Newest survive: the five oldest updated_at values are the ones cut.
    expect(read.titles[`s-${HISTORY_TITLE_SCAN_LIMIT + 5}`]).toEqual({
      title: `Title ${HISTORY_TITLE_SCAN_LIMIT + 5}`,
      updatedAt: HISTORY_TITLE_SCAN_LIMIT + 5,
    });
    expect(read.titles["s-5"]).toBeUndefined();
    expect(read.titles["s-6"]).toBeDefined();
  });
});

describe("historyDbCandidates", () => {
  it("orders and gates candidates by existence, profile, and env overrides", () => {
    const home = tmpDir();
    const xdg = tmpDir();
    const ompDir = path.join(xdg, "omp");
    fs.mkdirSync(ompDir, { recursive: true });

    expect(historyDbCandidates({}, "linux", home)).toEqual([
      path.join(home, ".omp", "agent", "history.db"),
    ]);

    // XDG flattens the agent/ prefix (upstream dirs.ts).
    expect(historyDbCandidates({ XDG_DATA_HOME: xdg }, "linux", home)).toEqual([
      path.join(ompDir, "history.db"),
      path.join(home, ".omp", "agent", "history.db"),
    ]);

    // An XDG base that does not exist contributes no candidate.
    expect(historyDbCandidates({ XDG_DATA_HOME: path.join(xdg, "nope") }, "linux", home)).toEqual([
      path.join(home, ".omp", "agent", "history.db"),
    ]);
    // Windows never consults XDG.
    expect(historyDbCandidates({ XDG_DATA_HOME: xdg }, "win32", home)).toEqual([
      path.win32.join(home, ".omp", "agent", "history.db"),
    ]);

    const profile = path.join(home, ".omp", "profiles", "work");
    expect(historyDbCandidates({ OMP_PROFILE: "work" }, "linux", home)).toEqual([
      path.join(profile, "agent", "history.db"),
    ]);
    fs.mkdirSync(path.join(ompDir, "profiles", "work"), { recursive: true });
    expect(historyDbCandidates({ OMP_PROFILE: "work", XDG_DATA_HOME: xdg }, "linux", home)).toEqual(
      [path.join(ompDir, "profiles", "work", "history.db"), path.join(profile, "agent", "history.db")],
    );

    expect(historyDbCandidates({ PI_CONFIG_DIR: ".cfg" }, "linux", home)).toEqual([
      path.join(home, ".cfg", "agent", "history.db"),
    ]);

    // PI_CODING_AGENT_DIR is a wholesale override: the ONLY candidate, so an
    // injected agent dir never falls through to the real ~/.omp.
    const agent = path.join(home, "agentdir");
    expect(historyDbCandidates({ PI_CODING_AGENT_DIR: agent }, "linux", home)).toEqual([
      path.join(agent, "history.db"),
    ]);
    // The override also kills the XDG branch — exactly like upstream's
    // dirs.ts, where a non-default agentDir disables #agentDirs.
    expect(
      historyDbCandidates({ PI_CODING_AGENT_DIR: agent, XDG_DATA_HOME: xdg }, "linux", home),
    ).toEqual([path.join(agent, "history.db")]);
    // A named profile ignores PI_CODING_AGENT_DIR, exactly like omp.
    expect(
      historyDbCandidates({ PI_CODING_AGENT_DIR: agent, OMP_PROFILE: "work" }, "linux", home),
    ).toEqual([path.join(profile, "agent", "history.db")]);
    // An override equal to the default agent dir collapses to one candidate.
    expect(
      historyDbCandidates({ PI_CODING_AGENT_DIR: path.join(home, ".omp", "agent") }, "linux", home),
    ).toEqual([path.join(home, ".omp", "agent", "history.db")]);
  });

  // The XDG branch is POSIX-only in production (upstream dirs.ts), pinned by
  // the win32 candidate-shape assertion above — on Windows the ONLY candidate
  // is the config-root one, so an XDG-seeded store can never resolve there
  // and this first-hit fixture cannot exist (#1040). The Windows lane skips
  // it; the Linux/macOS lanes run it unchanged.
  const posixOnly = process.platform !== "win32";
  it.runIf(posixOnly)("prefers the first existing candidate when reading", () => {
    const xdg = tmpDir();
    const ompDir = path.join(xdg, "omp");
    fs.mkdirSync(ompDir, { recursive: true });
    // Only the XDG-candidate store has data; the config-root candidate (via
    // the stubbed HOME) does not exist, so the XDG row wins the first-hit loop.
    const dbPath = path.join(ompDir, "history.db");
    withDb(dbPath, (db) => {
      db.exec(FIXTURE_DDL);
      db.prepare("INSERT INTO session_titles (session_id, title, updated_at) VALUES (?, ?, ?)").run(
        "xdg-only",
        "From XDG",
        1,
      );
    });
    const read = readSessionTitles({ XDG_DATA_HOME: xdg });
    expect(read.error).toBeNull();
    expect(read.titles["xdg-only"]).toEqual({ title: "From XDG", updatedAt: 1 });
  });
});
