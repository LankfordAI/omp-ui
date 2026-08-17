import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { readLayeredConfigScalar } from "./omp-config";
import { resolveProfile } from "./paths";
import type {
  MemoryBackendKind,
  MemoryBankInfo,
  MemoryEditResult,
  MemoryListOptions,
  MemoryOverview,
  MemoryPage,
  MemoryRow,
  MemoryScope,
  MemoryScoping,
} from "./types";

// Direct SQLite reads of mnemopi's banks — transport-agnostic Node, exactly
// like branch-diff.ts: the renderer never touches a database, it asks the main
// process for snapshots (ADR-0017, issue #206). omp exposes no runtime surface
// for memory, so every path, schema shape, and enum here is a verified port of
// mnemopi v17.3.5. Connections are opened per call and closed in finally —
// omp's own sessions write these files concurrently.

/** List responses clip content at this length; getMemory returns it whole. */
export const MEMORY_CLIP_CHARS = 600;
/** Cap on the bank-dir fallback scan during project-bank discovery. */
export const BANK_SCAN_LIMIT = 64;
/** Write connections wait this long on omp's own writers before failing. */
export const BUSY_TIMEOUT_MS = 2000;

/** A bank the pane can address: its name and the SQLite file behind it. */
export interface ResolvedBank {
  bank: string;
  dbPath: string;
}

/** The config-derived facts every bank resolution starts from. */
export interface MemoryBase {
  backend: MemoryBackendKind;
  scoping: MemoryScoping;
  baseDir: string;
  baseBank: string;
}

const BACKEND_KINDS: readonly MemoryBackendKind[] = ["off", "local", "hindsight", "mnemopi"];
const SCOPINGS: readonly MemoryScoping[] = ["global", "per-project", "per-project-tagged"];

/** Coerces one SQLite column to the nullable string the row types carry. */
function text(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/**
 * Port of mnemopi's sanitizeBankName: trim, collapse runs of anything outside
 * [a-zA-Z0-9_-] to a single `-`, strip leading/trailing `-`. Empty resolves to
 * undefined — the caller substitutes "default".
 */
function sanitizeBankName(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const cleaned = raw
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return cleaned === "" ? undefined : cleaned;
}

/**
 * mnemopi's memories dir: `<agentDir>/memories`, with pi-utils' XDG **state**
 * branch — ported the way {@link getSessionsRoot} ports the XDG_DATA_HOME
 * branch. Linux/macOS default profile only, and only when the `$XDG_STATE_HOME`
 * omp dir ALREADY EXISTS; the existence gate is on the omp dir candidate
 * itself, not the memories subdir.
 */
function memoriesDir(env: NodeJS.ProcessEnv): string {
  const profile = resolveProfile(env);
  const configName = env.PI_CONFIG_DIR || ".omp";
  const configRoot = profile
    ? path.join(os.homedir(), configName, "profiles", profile)
    : path.join(os.homedir(), configName);
  const defaultAgent = path.join(configRoot, "agent");
  // PI_CODING_AGENT_DIR applies only to the DEFAULT profile, as everywhere else.
  const agentDir =
    !profile && env.PI_CODING_AGENT_DIR ? path.resolve(env.PI_CODING_AGENT_DIR) : defaultAgent;
  const isDefault = agentDir === defaultAgent;
  if ((process.platform === "linux" || process.platform === "darwin") && isDefault) {
    const xdg = env.XDG_STATE_HOME;
    if (xdg) {
      const candidate = profile
        ? path.join(xdg, "omp", "profiles", profile)
        : path.join(xdg, "omp");
      try {
        if (fs.existsSync(candidate)) return path.join(candidate, "memories");
      } catch {
        // fall through to the default
      }
    }
  }
  return path.join(agentDir, "memories");
}

/**
 * Reads omp's effective memory config for `projectCwd`. Unrecognised backend
 * values degrade to "off" and unrecognised scoping to "per-project" — a config
 * typo should read as "nothing to show", never as a throw.
 */
export function resolveMemoryBase(
  projectCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryBase {
  const backendRaw = readLayeredConfigScalar(projectCwd, "memory", "backend", env);
  const backend = BACKEND_KINDS.find((kind) => kind === backendRaw) ?? "off";
  const scopingRaw = readLayeredConfigScalar(projectCwd, "mnemopi", "scoping", env);
  const scoping = SCOPINGS.find((kind) => kind === scopingRaw) ?? "per-project";
  const baseBank =
    sanitizeBankName(readLayeredConfigScalar(projectCwd, "mnemopi", "bank", env)) ?? "default";
  const dbPath = readLayeredConfigScalar(projectCwd, "mnemopi", "dbPath", env);
  const baseDir =
    dbPath !== undefined && dbPath !== ""
      ? path.dirname(path.resolve(dbPath))
      : path.join(memoriesDir(env), "mnemopi");
  return { backend, scoping, baseDir, baseBank };
}

/** The global bank: `<baseDir>/mnemopi.db` for "default", a banks/ subdir otherwise. */
export function resolveGlobalBank(base: MemoryBase): ResolvedBank {
  const dbPath =
    base.baseBank === "default"
      ? path.join(base.baseDir, "mnemopi.db")
      : path.join(base.baseDir, "banks", base.baseBank, "mnemopi.db");
  return { bank: base.baseBank, dbPath };
}

/** Escapes a literal for embedding in a RegExp source string. */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Read-only cwd probe of one candidate bank; null skips it (missing/corrupt/foreign). */
function probeBank(dbPath: string, cwdAbs: string): { cwdRows: number; lastWrite: string } | null {
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const counted = db
      .prepare(
        "SELECT COUNT(*) AS n FROM working_memory WHERE json_extract(metadata_json, '$.cwd') = ?",
      )
      .get(cwdAbs);
    const latest = db.prepare("SELECT MAX(created_at) AS last FROM working_memory").get();
    return {
      cwdRows: typeof counted?.n === "number" ? counted.n : 0,
      lastWrite: text(latest?.last) ?? "",
    };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

/**
 * Discovers the project's bank. mnemopi names project bank dirs
 * `[<baseBank>-]<sanitizedBasename(cwd)>-<base36 wyhash>` — wyhash is Bun-only,
 * so the suffix is never derived here. Instead: name-pattern candidates first,
 * confirmed by retained rows whose `metadata_json.$.cwd` matches; the most
 * recently written confirmed bank wins. A single unconfirmed pattern match is
 * trusted (a fresh bank has no rows yet). Null means no bank exists yet.
 */
export function resolveProjectBank(base: MemoryBase, projectCwd: string): ResolvedBank | null {
  const cwdAbs = path.resolve(projectCwd);
  const seg = sanitizeBankName(path.basename(cwdAbs)) ?? "default";
  const banksDir = path.join(base.baseDir, "banks");
  let dirents: fs.Dirent[];
  try {
    dirents = fs.readdirSync(banksDir, { withFileTypes: true });
  } catch {
    return null;
  }
  const prefix = base.baseBank !== "default" ? `(?:${escapeRegExp(base.baseBank)}-)?` : "";
  const candidateRe = new RegExp(`^${prefix}${escapeRegExp(seg)}-[0-9a-z]{1,13}$`);
  const bankDirs = dirents
    .filter((entry) => entry.isDirectory() && entry.name !== base.baseBank)
    .map((entry) => entry.name);
  const matched = bankDirs.filter((name) => candidateRe.test(name));
  const scanned = (matched.length > 0 ? matched : bankDirs).slice(0, BANK_SCAN_LIMIT);

  let winner: (ResolvedBank & { lastWrite: string }) | null = null;
  for (const name of scanned) {
    const dbPath = path.join(banksDir, name, "mnemopi.db");
    const probe = probeBank(dbPath, cwdAbs);
    if (probe === null || probe.cwdRows === 0) continue;
    if (winner === null || probe.lastWrite > winner.lastWrite) {
      winner = { bank: name, dbPath, lastWrite: probe.lastWrite };
    }
  }
  if (winner !== null) return { bank: winner.bank, dbPath: winner.dbPath };
  // No row-confirmed bank: a single pattern match is unambiguous (fresh bank).
  if (matched.length === 1) {
    return { bank: matched[0], dbPath: path.join(banksDir, matched[0], "mnemopi.db") };
  }
  return null;
}

/** `sqlite_master` probe — foreign or partial databases read as zeros, not errors. */
function tableExists(db: DatabaseSync, name: string): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type IN ('table', 'virtual table') AND name = ? LIMIT 1",
    )
    .get(name);
  return row !== undefined;
}

/** COUNT(*) AS n, coerced; any parameters ride along. */
function countRows(db: DatabaseSync, sql: string, ...params: string[]): number {
  const row = db.prepare(sql).get(...params);
  return typeof row?.n === "number" ? row.n : 0;
}

/** MAX(created_at) AS last, coerced to the nullable ISO string it stores. */
function lastCreatedAt(db: DatabaseSync, table: string): string | null {
  return text(db.prepare(`SELECT MAX(created_at) AS last FROM ${table}`).get()?.last);
}

function emptyBankInfo(): MemoryBankInfo {
  return {
    bank: "default",
    dbPath: "",
    exists: false,
    sizeBytes: 0,
    workingCount: 0,
    episodicCount: 0,
    lastWrite: null,
  };
}

function readBankInfo(bank: ResolvedBank): MemoryBankInfo {
  const info = { ...emptyBankInfo(), bank: bank.bank, dbPath: bank.dbPath };
  let stat: fs.Stats;
  try {
    stat = fs.statSync(bank.dbPath);
  } catch {
    return info;
  }
  info.exists = true;
  info.sizeBytes = stat.size;
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(bank.dbPath, { readOnly: true });
    const stamps: string[] = [];
    if (tableExists(db, "working_memory")) {
      info.workingCount = countRows(db, "SELECT COUNT(*) AS n FROM working_memory");
      const last = lastCreatedAt(db, "working_memory");
      if (last !== null) stamps.push(last);
    }
    if (tableExists(db, "episodic_memory")) {
      info.episodicCount = countRows(db, "SELECT COUNT(*) AS n FROM episodic_memory");
      const last = lastCreatedAt(db, "episodic_memory");
      if (last !== null) stamps.push(last);
    }
    // ISO-8601 strings sort chronologically, so the lexicographic max is the newest.
    if (stamps.length > 0) info.lastWrite = stamps.sort().at(-1) ?? null;
  } finally {
    db?.close();
  }
  return info;
}

/**
 * The pane's whole memory situation for a project. NEVER throws — any failure
 * lands in `.error` with zeroed banks, so the renderer always gets a state it
 * can draw.
 */
export function readMemoryOverview(
  projectCwd: string,
  env: NodeJS.ProcessEnv = process.env,
): MemoryOverview {
  try {
    const base = resolveMemoryBase(projectCwd, env);
    if (base.backend !== "mnemopi") {
      return {
        backend: base.backend,
        scoping: base.scoping,
        baseDir: base.baseDir,
        global: emptyBankInfo(),
        project: null,
        error: null,
      };
    }
    const globalInfo = readBankInfo(resolveGlobalBank(base));
    const projectBank = base.scoping === "global" ? null : resolveProjectBank(base, projectCwd);
    return {
      backend: base.backend,
      scoping: base.scoping,
      baseDir: base.baseDir,
      global: globalInfo,
      project: projectBank === null ? null : readBankInfo(projectBank),
      error: null,
    };
  } catch (error) {
    return {
      backend: "mnemopi",
      scoping: "per-project",
      baseDir: "",
      global: emptyBankInfo(),
      project: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** Maps one SELECT row (see the list/get SQL) into the wire shape, clipping when asked. */
function toMemoryRow(row: Record<string, SQLOutputValue>, clip: boolean): MemoryRow {
  const content = text(row.content) ?? "";
  const truncated = clip && content.length > MEMORY_CLIP_CHARS;
  return {
    id: text(row.id) ?? "",
    store: row.store === "episodic" ? "episodic" : "working",
    content: truncated ? content.slice(0, MEMORY_CLIP_CHARS) : content,
    truncated,
    source: text(row.source),
    timestamp: text(row.timestamp),
    createdAt: text(row.created_at),
    importance: typeof row.importance === "number" ? row.importance : null,
    memoryType: text(row.memory_type),
    veracity: text(row.veracity),
    sessionId: text(row.session_id),
  };
}

/**
 * FTS5 treats bare input as query syntax, so every token is quoted with inner
 * quotes doubled — a hostile `"a" OR (` searches for those words instead of
 * throwing. Empty after sanitizing reads as "no query".
 */
function sanitizeFtsQuery(raw: string | null): string | null {
  if (raw === null) return null;
  const tokens = raw.split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(" ");
}

// The unions are wrapped in a subquery: SQLite rejects a compound SELECT whose
// ORDER BY names an expression absent from the result columns.
const LIST_RECENT_SQL = `
SELECT * FROM (
  SELECT id, content, source, timestamp, session_id, importance,
         memory_type, veracity, created_at, 'working' AS store
  FROM working_memory  WHERE superseded_by IS NULL
  UNION ALL
  SELECT id, content, source, timestamp, session_id, importance,
         memory_type, veracity, created_at, 'episodic'
  FROM episodic_memory WHERE superseded_by IS NULL
)
ORDER BY COALESCE(timestamp, created_at) DESC
LIMIT ? OFFSET ?`;

// Ordered by recency, not rank: bm25 scores from two separate FTS tables are
// not comparable, so interleaving by score would be noise.
const LIST_SEARCH_SQL = `
SELECT * FROM (
  SELECT w.id, w.content, w.source, w.timestamp, w.session_id, w.importance,
         w.memory_type, w.veracity, w.created_at, 'working' AS store
  FROM fts_working f JOIN working_memory w ON w.id = f.id
  WHERE fts_working MATCH ?1 AND w.superseded_by IS NULL
  UNION ALL
  SELECT e.id, e.content, e.source, e.timestamp, e.session_id, e.importance,
         e.memory_type, e.veracity, e.created_at, 'episodic'
  FROM fts_episodes f JOIN episodic_memory e ON e.rowid = f.rowid
  WHERE fts_episodes MATCH ?1 AND e.superseded_by IS NULL
)
ORDER BY COALESCE(timestamp, created_at) DESC
LIMIT ?2 OFFSET ?3`;

/** One page of a bank's memories, newest first; FTS search when `opts.query` is set. */
export function listMemories(
  bank: ResolvedBank,
  scope: MemoryScope,
  opts: MemoryListOptions,
): MemoryPage {
  const limit = Math.min(200, Math.max(1, Math.trunc(opts.limit) || 1));
  const offset = Math.max(0, Math.trunc(opts.offset) || 0);
  const match = sanitizeFtsQuery(opts.query);
  const db = new DatabaseSync(bank.dbPath, { readOnly: true });
  try {
    let rows: Record<string, SQLOutputValue>[];
    let total: number;
    if (match === null) {
      rows = db.prepare(LIST_RECENT_SQL).all(limit, offset);
      total =
        countRows(db, "SELECT COUNT(*) AS n FROM working_memory WHERE superseded_by IS NULL") +
        countRows(db, "SELECT COUNT(*) AS n FROM episodic_memory WHERE superseded_by IS NULL");
    } else {
      rows = db.prepare(LIST_SEARCH_SQL).all(match, limit, offset);
      total =
        countRows(
          db,
          `SELECT COUNT(*) AS n FROM fts_working f JOIN working_memory w ON w.id = f.id
           WHERE fts_working MATCH ? AND w.superseded_by IS NULL`,
          match,
        ) +
        countRows(
          db,
          `SELECT COUNT(*) AS n FROM fts_episodes f JOIN episodic_memory e ON e.rowid = f.rowid
           WHERE fts_episodes MATCH ? AND e.superseded_by IS NULL`,
          match,
        );
    }
    return {
      scope,
      bank: bank.bank,
      rows: rows.map((row) => toMemoryRow(row, true)),
      total,
      offset,
      limit,
    };
  } finally {
    db.close();
  }
}

const GET_WORKING_SQL = `
SELECT id, content, source, timestamp, session_id, importance,
       memory_type, veracity, created_at, 'working' AS store
FROM working_memory WHERE id = ?`;

const GET_EPISODIC_SQL = `
SELECT id, content, source, timestamp, session_id, importance,
       memory_type, veracity, created_at, 'episodic' AS store
FROM episodic_memory WHERE id = ?`;

/** Point lookup by id, working store first. Full content — no clipping. */
export function getMemory(bank: ResolvedBank, id: string): MemoryRow | null {
  const db = new DatabaseSync(bank.dbPath, { readOnly: true });
  try {
    const row = db.prepare(GET_WORKING_SQL).get(id) ?? db.prepare(GET_EPISODIC_SQL).get(id);
    return row === undefined ? null : toMemoryRow(row, false);
  } finally {
    db.close();
  }
}

/** A write connection that waits out omp's own writers instead of failing fast. */
function openForWrite(dbPath: string): DatabaseSync {
  const db = new DatabaseSync(dbPath);
  db.exec(`PRAGMA busy_timeout=${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Inserts a durable user memory into the working store. `consolidated_at` is
 * set because mnemopi's TTL trim deletes unconsolidated, non-IMPORTED rows;
 * scope/veracity/trust_tier use mnemopi's own enums so recall treats the row
 * like one omp wrote itself. Project scope tags `metadata_json.$.cwd` the way
 * retained session rows carry it.
 */
export function addMemory(
  bank: ResolvedBank,
  scope: MemoryScope,
  projectCwd: string,
  content: string,
): MemoryRow {
  const trimmed = content.trim();
  if (trimmed === "") throw new Error("memory content is empty");
  const id = randomUUID();
  const now = new Date().toISOString();
  const metadata =
    scope === "project"
      ? JSON.stringify({ cwd: path.resolve(projectCwd), origin: "omp-ui" })
      : JSON.stringify({ origin: "omp-ui" });
  const db = openForWrite(bank.dbPath);
  try {
    db.prepare(
      `INSERT INTO working_memory
         (id, content, source, timestamp, session_id, importance,
          metadata_json, veracity, memory_type, consolidated_at, scope, trust_tier)
       VALUES (?, ?, 'omp-ui-user', ?, 'default', 0.8, ?, 'stated', 'semantic', ?, 'global', 'STATED')`,
    ).run(id, trimmed, now, metadata, now);
    const createdAt = text(
      db.prepare("SELECT created_at FROM working_memory WHERE id = ?").get(id)?.created_at,
    );
    return {
      id,
      store: "working",
      content: trimmed,
      truncated: false,
      source: "omp-ui-user",
      timestamp: now,
      createdAt,
      importance: 0.8,
      memoryType: "semantic",
      veracity: "stated",
      sessionId: "default",
    };
  } finally {
    db.close();
  }
}

/** Which store holds `id`; episodic rows are visible but never edited. */
function resolveEditable(db: DatabaseSync, id: string): "working" | "episodic" | null {
  if (db.prepare("SELECT 1 FROM working_memory WHERE id = ?").get(id) !== undefined) {
    return "working";
  }
  if (db.prepare("SELECT 1 FROM episodic_memory WHERE id = ?").get(id) !== undefined) {
    return "episodic";
  }
  return null;
}

/**
 * Patches a working row's content and/or importance. A content change also
 * drops the row's embedding — the stale vector would keep matching the old
 * text. Episodic rows report not_editable.
 */
export function updateMemory(
  bank: ResolvedBank,
  id: string,
  patch: { content?: string; importance?: number },
): MemoryEditResult {
  const db = openForWrite(bank.dbPath);
  try {
    const store = resolveEditable(db, id);
    if (store === null) return { status: "not_found" };
    if (store === "episodic") return { status: "not_editable" };
    const importance =
      patch.importance === undefined ? null : Math.min(1, Math.max(0, patch.importance));
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare(
        "UPDATE working_memory SET content = COALESCE(?, content), importance = COALESCE(?, importance) WHERE id = ?",
      ).run(patch.content ?? null, importance, id);
      if (patch.content !== undefined && tableExists(db, "memory_embeddings")) {
        db.prepare("DELETE FROM memory_embeddings WHERE memory_id = ?").run(id);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { status: "ok" };
  } finally {
    db.close();
  }
}

/** Sidecar tables forgetMemory cleans, keyed by their memory-id column. */
const FORGET_SIDECARS: ReadonlyArray<readonly [table: string, column: string]> = [
  ["annotations", "memory_id"],
  ["memory_embeddings", "memory_id"],
  ["memoria_facts", "source_memory_id"],
  ["memoria_instructions", "source_memory_id"],
  ["memoria_kg", "source_memory_id"],
  ["memoria_preferences", "source_memory_id"],
  ["memoria_timelines", "source_memory_id"],
  ["gists", "memory_id"],
];

/**
 * Deletes a working row and every sidecar artifact derived from it, in one
 * transaction. The wm_ad trigger cleans fts_working; everything else is
 * cascaded here because mnemopi declares no foreign keys. Episodic rows report
 * not_editable — omp owns that store's lifecycle.
 */
export function forgetMemory(bank: ResolvedBank, id: string): MemoryEditResult {
  const db = openForWrite(bank.dbPath);
  try {
    const store = resolveEditable(db, id);
    if (store === null) return { status: "not_found" };
    if (store === "episodic") return { status: "not_editable" };
    db.exec("BEGIN IMMEDIATE");
    try {
      const factIds: string[] = [];
      if (tableExists(db, "facts")) {
        for (const row of db.prepare("SELECT fact_id FROM facts WHERE source_msg_id = ?").all(id)) {
          const factId = text(row.fact_id);
          if (factId !== null) factIds.push(factId);
        }
        db.prepare("DELETE FROM facts WHERE source_msg_id = ?").run(id);
      }
      db.prepare("DELETE FROM working_memory WHERE id = ?").run(id);
      for (const [table, column] of FORGET_SIDECARS) {
        if (tableExists(db, table)) {
          db.prepare(`DELETE FROM ${table} WHERE ${column} = ?`).run(id);
        }
      }
      if (tableExists(db, "graph_edges")) {
        // gist edges are keyed `gist_<memory id>`; fact edges by their fact_id.
        const refs = [id, `gist_${id}`, ...factIds];
        const placeholders = refs.map(() => "?").join(", ");
        db.prepare(
          `DELETE FROM graph_edges WHERE source IN (${placeholders}) OR target IN (${placeholders})`,
        ).run(...refs, ...refs);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
    return { status: "ok" };
  } finally {
    db.close();
  }
}
