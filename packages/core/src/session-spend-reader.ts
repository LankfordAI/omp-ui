import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as zlib from "node:zlib";
import type { SessionLocation } from "./archive";
import { addSpendTotals, emptySpendTotals, type SpendTotals } from "./session-spend";

const TRANSCRIPT_SUFFIX = ".jsonl";
const ARCHIVED_SUFFIX = ".jsonl.gz";
const ADVISOR_FILE = "__advisor.jsonl";
const ADVISOR_FILE_GZ = "__advisor.jsonl.gz";
const ADVISOR_PREFIX = "__advisor.";
const CHUNK_BYTES = 64 * 1024;
const HEADER_WINDOW_BYTES = 4096;

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function amount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Matches omp's advisor-transcript rule (omp/18.10.4), including gzipped copies. */
function isAdvisorTranscript(file: string): boolean {
  const base = path.basename(file);
  if (base === ADVISOR_FILE || base === ADVISOR_FILE_GZ) return true;
  if (!base.startsWith(ADVISOR_PREFIX)) return false;
  return base.endsWith(TRANSCRIPT_SUFFIX) || base.endsWith(ARCHIVED_SUFFIX);
}

/**
 * True when the line opens with a session-type header key, tolerant of the
 * spaced colon some writers emit. Matches `session-spend-extension.ts`.
 */
function isSessionHeaderLine(line: string): boolean {
  return /^\{\s*"type"\s*:\s*"session"/.test(line);
}

function addUsage(target: SpendTotals, usage: Record<string, unknown>): void {
  target.cost += amount(asRecord(usage.cost)?.total);
  target.input += amount(usage.input);
  target.output += amount(usage.output);
  target.reasoning += amount(usage.reasoningTokens);
  target.cacheRead += amount(usage.cacheRead);
  target.cacheWrite += amount(usage.cacheWrite);
  target.totalTokens += amount(usage.totalTokens);
  target.premiumRequests += amount(usage.premiumRequests);
  target.requests += 1;
}

interface TallyState {
  headerMs: number | null;
  ignored: boolean;
  remainder: string;
  bytesRead: number;
  totals: SpendTotals;
}

function countLine(tally: TallyState, line: string): void {
  if (line.indexOf('"usage"') < 0 && !isSessionHeaderLine(line)) return;
  let entry: Record<string, unknown> | null;
  try {
    entry = asRecord(JSON.parse(line));
  } catch {
    return;
  }
  if (entry === null) return;
  if (entry.type === "session") {
    if (tally.headerMs === null) {
      const ms = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
      tally.headerMs = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
    }
    return;
  }
  if (tally.headerMs === null) return;
  let usage: Record<string, unknown> | null = null;
  if (entry.type === "message") {
    const message = asRecord(entry.message);
    if (message !== null && message.role === "assistant") usage = asRecord(message.usage);
  } else if (entry.type === "model_usage") {
    usage = asRecord(entry.usage);
  }
  if (usage === null) return;
  // A fork copies its parent's entries with their original timestamps under a newer header.
  if (tally.headerMs !== Number.NEGATIVE_INFINITY) {
    const at = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : Number.NaN;
    if (Number.isFinite(at) && at < tally.headerMs) return;
  }
  addUsage(tally.totals, usage);
}

function consumeText(tally: TallyState, text: string): void {
  if (text.indexOf("\n") < 0) {
    tally.remainder += text;
    return;
  }
  const lines = (tally.remainder + text).split("\n");
  tally.remainder = lines.pop() ?? "";
  for (const line of lines) countLine(tally, line);
}

function finishText(tally: TallyState): void {
  if (tally.remainder.length > 0 && !tally.ignored) {
    countLine(tally, tally.remainder);
    tally.remainder = "";
  }
}

/**
 * Counts one `.jsonl` or `.jsonl.gz` transcript using the exact ADR-0056 rules.
 * Returns null if the file is foreign (no session header within HEADER_WINDOW_BYTES).
 */
async function readTranscriptTotals(filePath: string): Promise<SpendTotals | null> {
  const tally: TallyState = {
    headerMs: null,
    ignored: false,
    remainder: "",
    bytesRead: 0,
    totals: emptySpendTotals(),
  };
  if (filePath.endsWith(ARCHIVED_SUFFIX)) {
    const compressed = await fsp.readFile(filePath);
    const buf = zlib.gunzipSync(compressed);
    const decoder = new TextDecoder("utf-8");
    for (let offset = 0; offset < buf.length; offset += CHUNK_BYTES) {
      const end = Math.min(buf.length, offset + CHUNK_BYTES);
      const slice = buf.subarray(offset, end);
      consumeText(tally, decoder.decode(slice, { stream: end < buf.length }));
      tally.bytesRead += slice.length;
      if (
        tally.headerMs === null &&
        tally.bytesRead >= HEADER_WINDOW_BYTES &&
        !isSessionHeaderLine(tally.remainder)
      ) {
        return null;
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) consumeText(tally, tail);
    finishText(tally);
    return tally.headerMs === null ? null : tally.totals;
  }

  const handle = await fsp.open(filePath, "r");
  try {
    const buffer = Buffer.allocUnsafe(CHUNK_BYTES);
    const decoder = new TextDecoder("utf-8");
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, CHUNK_BYTES, tally.bytesRead);
      if (bytesRead <= 0) break;
      consumeText(tally, decoder.decode(buffer.subarray(0, bytesRead), { stream: true }));
      tally.bytesRead += bytesRead;
      if (
        tally.headerMs === null &&
        tally.bytesRead >= HEADER_WINDOW_BYTES &&
        !isSessionHeaderLine(tally.remainder)
      ) {
        return null;
      }
    }
    const tail = decoder.decode();
    if (tail.length > 0) consumeText(tally, tail);
    finishText(tally);
    return tally.headerMs === null ? null : tally.totals;
  } finally {
    await handle.close();
  }
}

function artifactsDirFor(loc: Extract<SessionLocation, { where: "active" | "archived" }>): string | null {
  if (loc.where === "active" && loc.filePath.endsWith(TRANSCRIPT_SUFFIX)) {
    return loc.filePath.slice(0, -TRANSCRIPT_SUFFIX.length);
  }
  if (loc.where === "archived" && loc.filePath.endsWith(ARCHIVED_SUFFIX)) {
    return loc.filePath.slice(0, -ARCHIVED_SUFFIX.length);
  }
  return null;
}

interface StatEntry {
  relPath: string;
  filePath: string;
  sig: string;
}

/** Lists non-advisor transcripts under an artifacts dir recursively with stat signatures. */
async function listArtifactTranscripts(
  artifactsDir: string,
  includeArchived: boolean,
): Promise<StatEntry[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(artifactsDir, { encoding: "utf8", recursive: true });
  } catch {
    return [];
  }
  const matches: string[] = [];
  for (const entry of entries) {
    const validExt =
      entry.endsWith(TRANSCRIPT_SUFFIX) || (includeArchived && entry.endsWith(ARCHIVED_SUFFIX));
    if (!validExt) continue;
    const filePath = path.join(artifactsDir, entry);
    if (!isAdvisorTranscript(filePath)) matches.push(entry);
  }
  if (matches.length === 0) return [];
  matches.sort();
  const stats = await Promise.all(
    matches.map(async (relPath) => {
      const filePath = path.join(artifactsDir, relPath);
      try {
        const st = await fsp.stat(filePath);
        if (!st.isFile()) return null;
        return { relPath, filePath, sig: `${relPath}:${st.ino}:${st.size}:${st.mtimeMs}` };
      } catch {
        return null;
      }
    }),
  );
  return stats.filter((item): item is StatEntry => item !== null);
}

async function computeLocationPlan(
  loc: Extract<SessionLocation, { where: "active" | "archived" }>,
): Promise<{ signature: string; subagentFiles: string[] } | null> {
  let rootStat: fs.Stats;
  try {
    rootStat = await fsp.stat(loc.filePath);
    if (!rootStat.isFile()) return null;
  } catch {
    return null;
  }
  const artifactsDir = artifactsDirFor(loc);
  const subagents =
    artifactsDir !== null
      ? await listArtifactTranscripts(artifactsDir, loc.where === "archived")
      : [];
  const rootSig = `${rootStat.ino}:${rootStat.size}:${rootStat.mtimeMs}`;
  const signature =
    subagents.length === 0 ? rootSig : `${rootSig}|${subagents.map((s) => s.sig).join("|")}`;
  return { signature, subagentFiles: subagents.map((s) => s.filePath) };
}

async function scanLocation(
  rootFilePath: string,
  subagentFiles: readonly string[],
): Promise<SpendTotals | null> {
  let rootTotals: SpendTotals | null;
  try {
    rootTotals = await readTranscriptTotals(rootFilePath);
  } catch {
    return null;
  }
  if (rootTotals === null) return null;
  const total = emptySpendTotals();
  addSpendTotals(total, rootTotals);
  for (const file of subagentFiles) {
    try {
      const sub = await readTranscriptTotals(file);
      if (sub !== null) addSpendTotals(total, sub);
    } catch {
      // A vanished or unreadable subagent transcript does not poison the root total.
    }
  }
  return total;
}

/**
 * Reads whole-session spend (root + non-advisor subagents) directly from disk
 * using the ADR-0056 counting rule. Supports active `.jsonl` and archived
 * `.jsonl.gz` lineages; returns `null` when missing or unreadable.
 */
export async function readSessionSpendFromDisk(loc: SessionLocation): Promise<SpendTotals | null> {
  if (loc.where === "missing") return null;
  const plan = await computeLocationPlan(loc);
  if (plan === null) return null;
  return scanLocation(loc.filePath, plan.subagentFiles);
}

/**
 * Mtime/inode/size-keyed in-memory cache over `readSessionSpendFromDisk`.
 * Avoids re-reading transcript bytes during `MainBackend.buildState()` when
 * dormant/archived sessions have not changed on disk.
 */
export class SessionSpendDiskCache {
  private readonly cache = new Map<string, { signature: string; totals: SpendTotals }>();

  async read(loc: SessionLocation): Promise<SpendTotals | null> {
    if (loc.where === "missing") return null;
    const plan = await computeLocationPlan(loc);
    if (plan === null) return null;
    const hit = this.cache.get(loc.filePath);
    if (hit !== undefined && hit.signature === plan.signature) {
      return hit.totals;
    }
    const totals = await scanLocation(loc.filePath, plan.subagentFiles);
    if (totals === null) return null;
    this.cache.set(loc.filePath, { signature: plan.signature, totals });
    return totals;
  }

  /** Drops entries whose file paths are no longer active in the current state build. */
  prune(validFiles: ReadonlySet<string>): void {
    for (const key of this.cache.keys()) {
      if (!validFiles.has(key)) this.cache.delete(key);
    }
  }

  evict(filePath: string): void {
    this.cache.delete(filePath);
  }
}
