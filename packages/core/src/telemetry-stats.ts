import * as fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { resolveOwnedStatsAttribution, type StatsReadContext } from "./stats-attribution";

export interface TelemetryModelUsageRow {
  date: string;
  provider: string;
  model: string;
  requests: number;
}

// Match the raw-message compatibility boundary of stats-store.ts. Optional
// rollup/tool tables and newer cost/agent columns are deliberately irrelevant.
const REQUIRED_MESSAGES = [
  "session_file", "model", "provider", "folder", "timestamp", "duration", "stop_reason",
  "input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "total_tokens", "cost_total",
];
const SQLITE_HEADER = Buffer.from("SQLite format 3\0", "ascii");

/** Only a fixed-size database header is read; no transcript/header attribution. */
async function databaseHeader(databasePath: string): Promise<"ready" | "missing" | "unavailable"> {
  try {
    if (!(await fs.promises.stat(databasePath)).isFile()) return "unavailable";
    const file = await fs.promises.open(databasePath, "r");
    try {
      const header = Buffer.alloc(SQLITE_HEADER.length);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      return bytesRead === header.length && header.equals(SQLITE_HEADER) ? "ready" : "unavailable";
    } finally {
      await file.close();
    }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unavailable";
  }
}

/**
 * Local-only recorded request counts, not telemetry-ready identifiers. The host
 * must sanitize dimensions before transport. This never collects or launches OMP.
 *
 * Registry ownership is the sole admission rule, including archived/nested keys
 * even after transcripts disappear. Project/folder/header resemblance is not
 * ownership. Like Stats, coverage is limited to history OMP actually indexed:
 * never-indexed gzip archives are absent, and fork deduplication/attribution
 * follows OMP's retained first-writer record (ADR-0037), not complete provenance.
 */
export async function readTelemetryModelUsage(
  context: StatsReadContext,
  sinceMs: number,
  untilMs: number,
): Promise<TelemetryModelUsageRow[] | null> {
  if (!Number.isFinite(sinceMs) || !Number.isFinite(untilMs) || sinceMs > untilMs) return null;
  const header = await databaseHeader(context.source.databasePath);
  if (header === "missing") return [];
  if (header !== "ready") return null;

  let db: DatabaseSync | undefined;
  let transaction = false;
  try {
    db = new DatabaseSync(context.source.databasePath, { readOnly: true });
    db.exec("BEGIN");
    transaction = true;
    if (!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'messages'").get()) return null;
    const columns = new Set(db.prepare("PRAGMA table_info(messages)").all().map((row) => row.name));
    if (!REQUIRED_MESSAGES.every((column) => columns.has(column))) return null;

    // Raw grouping preserves each source key for strict ownership, unlike
    // rollups which discard that dimension. SQL applies both absolute bounds;
    // unixepoch without 'localtime' groups UTC, including pre-epoch timestamps.
    const groups = db.prepare(
      "SELECT session_file, strftime('%Y-%m-%d', timestamp / 1000.0, 'unixepoch') AS date, " +
      "CASE WHEN instr(provider, char(0)) = 0 THEN provider ELSE '' END AS provider, " +
      "CASE WHEN instr(model, char(0)) = 0 THEN model ELSE '' END AS model, COUNT(*) AS requests FROM messages " +
      // node:sqlite decodes TEXT through a NUL-terminated boundary. Reject bad
      // file keys and bucket malformed dimensions before decoding public prefixes.
      "WHERE timestamp >= ? AND timestamp < ? AND instr(session_file, char(0)) = 0 " +
      "GROUP BY session_file, date, provider, model",
    ).iterate(sinceMs, untilMs);
    const owned = new Map<string, boolean>();
    const totals = new Map<string, TelemetryModelUsageRow>();
    for (const group of groups) {
      if (typeof group.session_file !== "string") return null;
      let include = owned.get(group.session_file);
      if (include === undefined) {
        include = resolveOwnedStatsAttribution(group.session_file, context) !== null;
        owned.set(group.session_file, include);
      }
      if (!include) continue;
      if (typeof group.date !== "string" || typeof group.provider !== "string" ||
        typeof group.model !== "string" || typeof group.requests !== "number" ||
        !Number.isSafeInteger(group.requests) || group.requests < 1) return null;
      const key = JSON.stringify([group.date, group.provider, group.model]);
      const existing = totals.get(key);
      if (existing) {
        existing.requests += group.requests;
        if (!Number.isSafeInteger(existing.requests)) return null;
      } else {
        totals.set(key, {
          date: group.date, provider: group.provider, model: group.model, requests: group.requests,
        });
      }
    }
    return [...totals.values()].sort((a, b) =>
      a.date.localeCompare(b.date) || a.provider.localeCompare(b.provider) || a.model.localeCompare(b.model),
    );
  } catch {
    // Locked, incompatible, corrupt and unavailable must never look like zero use.
    return null;
  } finally {
    try { if (transaction) db?.exec("ROLLBACK"); } catch { /* Connection still closes below. */ }
    try { db?.close(); } catch { /* No ownership of the writer or its lifecycle. */ }
  }
}
