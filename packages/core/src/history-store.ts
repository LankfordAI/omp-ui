import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { resolveProfile } from "./paths";

// Direct SQLite reads of omp's history database (issue #1034) — the same
// family as stats-store.ts and memory-store.ts: omp owns history.db, omp-ui
// only reads it. Every connection is read-only, opened per call and closed in
// finally — omp's own sessions write this file concurrently; omp-ui never
// holds a handle and never writes. The schema is a verified port of the
// omp 18.15.0-era db plus upstream v18.16.0's session-index.ts (the DDL for
// `session_titles` is byte-stable from v18.3.0 to main); concurrent reads of
// the store became officially safe in 18.16, where SQLite holds its POSIX
// locks through OFD descriptors upstream-side (oh-my-pi PR #17833).
//
// `session_titles` maps session id → last-known title, backfilled by omp's
// picker scans. A row is NOT proof of a live session: there are no
// tombstones, rows for deleted or terminal-omp (foreign) sessions outlive
// their files until `omp gc` reaps them — consumers must re-check liveness.
// Title strings may carry omp title cards (`${icon} ${CODE}: ${title}`); they
// pass through RAW here — split with title-card.ts at display time only.
// Absent, unreadable, or unrecognized databases all read as the same zeroed
// state ({ titles: {}, error: "…" }): the caller falls back to its jsonl scan.

/** Cap on one titles read; the picker never needs more than this many rows. */
export const HISTORY_TITLE_SCAN_LIMIT = 5_000;

/** One indexed session title: the raw title string and its unix-seconds stamp. */
export interface SessionTitleEntry {
  title: string;
  updatedAt: number;
}

/** Result of a titles read: zeroed `titles` whenever `error` is non-null. */
export interface SessionTitlesRead {
  titles: Record<string, SessionTitleEntry>;
  error: string | null;
}

/**
 * omp's history.db candidates, most likely first. Per upstream dirs.ts
 * `getHistoryDbPath`, history.db
 * lives in the AGENT dir (`~/.omp[/profiles/<p>]/agent/history.db`, name from
 * `PI_CONFIG_DIR`) unless the XDG migration moved it: an existence-gated
 * `$XDG_DATA_HOME/omp[/profiles/<p>]` base (Linux/macOS, default profile only)
 * FLATTENS the agent/ prefix to `$XDG_DATA_HOME/omp/history.db`.
 * `PI_CODING_AGENT_DIR` is a wholesale OVERRIDE, not an extra candidate: omp's
 * agentDir resolution replaces the home-derived path — and disables the XDG
 * branch — so with it set the ONLY candidate is
 * `<PI_CODING_AGENT_DIR>/history.db`. Default profile only; a named profile
 * ignores it. Call lazily: the XDG branch is existence-gated and can flip
 * while the app runs. Never throws.
 */
export function historyDbCandidates(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string[] {
  const pathApi = platform === "win32" ? path.win32 : path;
  const profile = resolveProfile(env);
  // PI_CODING_AGENT_DIR applies only to the DEFAULT profile (ignored when a
  // named profile is active), and then replaces every other candidate —
  // mirroring omp's agentDir special case, so an injected agent dir never
  // silently falls through to the developer's real ~/.omp.
  if (!profile && env.PI_CODING_AGENT_DIR) {
    return [pathApi.join(pathApi.resolve(env.PI_CODING_AGENT_DIR), "history.db")];
  }
  const configName = env.PI_CONFIG_DIR || ".omp"; // directory NAME under $HOME
  const candidates: string[] = [];
  if (platform === "linux" || platform === "darwin") {
    const xdg = env.XDG_DATA_HOME;
    if (xdg) {
      // Like getSessionsRoot: the XDG base only counts when it ALREADY EXISTS,
      // and XDG flattens the agent/ prefix ($XDG_DATA_HOME/omp/history.db).
      const dir = profile
        ? pathApi.join(xdg, "omp", "profiles", profile)
        : pathApi.join(xdg, "omp");
      try {
        if (fs.existsSync(dir)) candidates.push(pathApi.join(dir, "history.db"));
      } catch {
        // fall through to the config root
      }
    }
  }
  const configRoot = profile
    ? pathApi.join(home, configName, "profiles", profile)
    : pathApi.join(home, configName);
  candidates.push(pathApi.join(configRoot, "agent", "history.db"));
  return [...new Set(candidates)];
}

/** Numeric column → number; sqlite hands back a bigint for integers past 2^53. */
function int(value: SQLOutputValue | undefined): number | null {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  return null;
}

/** Text column → string; anything else (blob, NULL, damage) reads as null. */
function text(value: SQLOutputValue | undefined): string | null {
  return typeof value === "string" ? value : null;
}

/** The store's one required table; a file without it is a state, not a throw. */
const SCHEMA_PROBE_SQL =
  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'session_titles' LIMIT 1";

/** Newest-first titles read, capped — same ORDER BY key omp's salvage uses. */
const TITLES_SQL =
  "SELECT session_id, title, updated_at FROM session_titles ORDER BY updated_at DESC LIMIT ?";

/**
 * Reads omp's session-title index keyed by session id. Opened read-only per
 * call, closed in finally; NEVER throws — a missing file, a foreign schema,
 * or a corrupt store all land in `.error` with empty `titles`, and malformed
 * rows drop without failing the list (a damaged page can decode foreign
 * bytes into these columns; upstream guards them the same way). Callers
 * treat an error state as "fall back to the jsonl scan".
 */
export function readSessionTitles(env: NodeJS.ProcessEnv = process.env): SessionTitlesRead {
  let dbPath: string | null = null;
  for (const candidate of historyDbCandidates(env)) {
    try {
      if (fs.existsSync(candidate)) {
        dbPath = candidate;
        break;
      }
    } catch {
      // keep probing
    }
  }
  if (dbPath === null) return { titles: {}, error: "omp history database not found" };
  let db: DatabaseSync | undefined;
  try {
    const opened = new DatabaseSync(dbPath, { readOnly: true });
    db = opened;
    if (opened.prepare(SCHEMA_PROBE_SQL).get() === undefined) {
      return { titles: {}, error: "not an omp history database" };
    }
    // Read integers as bigint: the default number path THROWS on any integer
    // past 2^53, which would zero the whole list; `int` narrows them back.
    const titlesStmt = opened.prepare(TITLES_SQL);
    titlesStmt.setReadBigInts(true);
    const rows = titlesStmt.all(HISTORY_TITLE_SCAN_LIMIT) as Record<string, SQLOutputValue>[];
    const titles: Record<string, SessionTitleEntry> = {};
    for (const row of rows) {
      const sessionId = text(row.session_id);
      const title = text(row.title);
      // typeof guards first: non-string keys/titles are damage, drop cheaply.
      // "__proto__" would re-point the plain object's prototype on assign.
      if (sessionId === null || title === null || sessionId === "__proto__") continue;
      if (Object.hasOwn(titles, sessionId)) continue; // newest already kept
      titles[sessionId] = { title, updatedAt: int(row.updated_at) ?? 0 };
    }
    return { titles, error: null };
  } catch (error) {
    return { titles: {}, error: error instanceof Error ? error.message : String(error) };
  } finally {
    db?.close();
  }
}
