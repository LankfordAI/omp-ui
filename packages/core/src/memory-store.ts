import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { readLayeredConfigScalar } from "./omp-config";
import { resolveProfile } from "./paths";
import type {
  MemoryBackendKind,
  MemoryBankInfo,
  MemoryOverview,
  MemoryScoping,
} from "./types";

// Direct SQLite reads of mnemopi's banks — transport-agnostic Node, exactly
// like branch-diff.ts: the renderer never touches a database, it asks the main
// process for snapshots (ADR-0017, issue #206). omp exposes no runtime surface
// for memory, so every path, schema shape, and enum here is a verified port of
// mnemopi v17.3.5. Every connection is read-only, opened per call and closed in
// finally — omp's own sessions write these files concurrently.

/** Cap on the bank-dir fallback scan during project-bank discovery. */
export const BANK_SCAN_LIMIT = 64;

/** A resolved bank: its name and the SQLite file behind it. */
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

/** Coerces one SQLite column to the nullable string the overview types carry. */
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
 * The resolved memory situation for a project. NEVER throws — any failure
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
