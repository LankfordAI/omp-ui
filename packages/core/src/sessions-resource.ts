/**
 * The `omp-ui://sessions` resources (#768): a day's index of omp-ui sessions
 * and a per-session "where it landed" summary. Node-only and read-only — the
 * transcript is read in place (an archived one is decompressed in memory),
 * nothing is written, unarchived, or created.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import * as zlib from "node:zlib";
import type { SessionLocation } from "./archive";
import { readSessionTail } from "./session-file";
import type { OwnedSessionRecord, ProjectRecord } from "./types";

export interface SessionsResourceDeps {
  records(): readonly OwnedSessionRecord[];
  projects(): readonly ProjectRecord[];
  locate(lineageDir: string, sessionId: string | null): Promise<SessionLocation>;
  now(): Date;
}

/** Most UTF-16 units of the landed text a summary carries before the ellipsis. */
export const SUMMARY_TAIL_CAP = 2_000;

const DAY_INDEX_CAP = 24_000;
const TAIL_WINDOW_BYTES = 1_048_576;
const DAY_REFUSAL = "day must be a calendar date in YYYY-MM-DD form, for example 2026-10-06";
const UNAVAILABLE = "Summary unavailable: the transcript could not be read.";
const gunzip = promisify(zlib.gunzip);

const pad2 = (n: number): string => String(n).padStart(2, "0");

function localDay(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function localTime(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** null for a null or unparseable cachedModified. */
function modifiedAt(record: OwnedSessionRecord): Date | null {
  if (record.cachedModified === null) return null;
  const at = new Date(record.cachedModified);
  return Number.isNaN(at.getTime()) ? null : at;
}

function titleOf(record: OwnedSessionRecord): string {
  return (record.cachedTitle ?? "").replace(/\s+/g, " ").trim() || "Untitled";
}

function projectName(cwd: string, projects: readonly ProjectRecord[]): string {
  return projects.find((p) => p.path === cwd)?.name ?? (path.basename(cwd) || cwd);
}

/** CONTEXT.md vocabulary: rpc-ui is a native session, pty a terminal session. */
function modeWord(record: OwnedSessionRecord): string {
  return record.mode === "rpc-ui" ? "native" : "terminal";
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

/** Absent means today in local time; otherwise a real calendar date in YYYY-MM-DD form. */
export function parseDayParam(
  raw: string | null,
  now: Date,
): { ok: true; day: string } | { ok: false; error: string } {
  if (raw === null) return { ok: true, day: localDay(now) };
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (match === null) return { ok: false, error: DAY_REFUSAL };
  const y = Number(match[1]);
  const m = Number(match[2]);
  const d = Number(match[3]);
  const date = new Date(y, m - 1, d);
  // Round-trip rejects 2026-02-30, month 13, and years 0-99 (Date maps them to 19xx).
  if (date.getFullYear() !== y || date.getMonth() !== m - 1 || date.getDate() !== d) {
    return { ok: false, error: DAY_REFUSAL };
  }
  return { ok: true, day: raw };
}

interface DayRow {
  record: OwnedSessionRecord;
  at: Date;
}

function rowLine({ record, at }: DayRow): string {
  const segments = [`**${titleOf(record)}**`, modeWord(record)];
  if (record.worktree !== null) segments.push(record.worktree.branch);
  segments.push(localTime(at), `omp-ui://sessions/${record.sessionId}/summary`);
  return `- ${segments.join(" · ")}`;
}

/**
 * Markdown index of the sessions last modified on `day` (local time), one row
 * per lineage (its newest record), grouped by project, newest first. Capped at
 * DAY_INDEX_CAP, cut only at a row boundary with a count of the rows left out.
 */
export function renderDayIndex(
  records: readonly OwnedSessionRecord[],
  projects: readonly ProjectRecord[],
  day: string,
): string {
  const lineages = new Map<string, DayRow>();
  for (const record of records) {
    if (record.sessionId === null) continue;
    const at = modifiedAt(record);
    if (at === null || localDay(at) !== day) continue;
    const held = lineages.get(record.lineageDir);
    if (held === undefined || at.getTime() > held.at.getTime()) {
      lineages.set(record.lineageDir, { record, at });
    }
  }
  if (lineages.size === 0) {
    return `# Sessions on ${day}\n\nNo omp-ui sessions were active on ${day}.\n`;
  }

  const byCwd = new Map<string, DayRow[]>();
  for (const row of lineages.values()) {
    const rows = byCwd.get(row.record.projectCwd);
    if (rows === undefined) byCwd.set(row.record.projectCwd, [row]);
    else rows.push(row);
  }
  const groups = [...byCwd.entries()].map(([cwd, rows]) => {
    rows.sort((a, b) => b.at.getTime() - a.at.getTime());
    return { name: projectName(cwd, projects), rows, newest: (rows[0] as DayRow).at.getTime() };
  });
  groups.sort((a, b) => b.newest - a.newest || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const total = lineages.size;
  let text = `# Sessions on ${day}\n\n${plural(total, "session")} across ${plural(groups.length, "project")}.\n`;
  const tail = (k: number): string =>
    `\n… ${k} more ${k === 1 ? "session" : "sessions"}; narrow the day or the query.\n`;
  let shown = 0;
  outer: for (const group of groups) {
    let heading = `\n## ${group.name}\n\n`;
    for (const row of group.rows) {
      const line = `${heading}${rowLine(row)}\n`;
      const after = total - shown - 1;
      if (text.length + line.length + (after > 0 ? tail(after).length : 0) > DAY_INDEX_CAP) break outer;
      text += line;
      heading = "";
      shown++;
    }
  }
  if (shown < total) text += tail(total - shown);
  return text;
}

/**
 * Last assistant message whose text blocks are non-empty and whose stopReason
 * is not error/aborted; text blocks joined by a blank line. Never reads role "user".
 */
export function lastAssistantText(jsonl: string): string | null {
  const lines = jsonl.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i] as string;
    if (line.charCodeAt(0) !== 123 || !line.includes('"assistant"')) continue;
    // A line opening with "{" parses to an object, never null or an array.
    let entry: { type?: unknown; message?: unknown };
    try {
      entry = JSON.parse(line);
    } catch {
      continue; // includes the partial first line of a tail window
    }
    if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) continue;
    const message = entry.message as { role?: unknown; stopReason?: unknown; content?: unknown };
    if (message.role !== "assistant") continue;
    if (message.stopReason === "error" || message.stopReason === "aborted") continue;
    if (!Array.isArray(message.content)) continue;
    const texts: string[] = [];
    for (const block of message.content as unknown[]) {
      if (typeof block !== "object" || block === null) continue;
      const { type, text } = block as { type?: unknown; text?: unknown };
      if (type !== "text" || typeof text !== "string") continue;
      const trimmed = text.trim();
      if (trimmed !== "") texts.push(trimmed);
    }
    if (texts.length > 0) return texts.join("\n\n");
  }
  return null;
}

/** Heading line plus the session's last landed assistant text. Never rejects. */
export async function renderSessionSummary(
  record: OwnedSessionRecord,
  projects: readonly ProjectRecord[],
  locate: SessionsResourceDeps["locate"],
): Promise<string> {
  const at = modifiedAt(record);
  const segments = [titleOf(record), projectName(record.projectCwd, projects), modeWord(record)];
  if (record.worktree !== null) segments.push(record.worktree.branch);
  if (at !== null) segments.push(`${localDay(at)} ${localTime(at)}`);
  const text = await readLastAssistantText(record, locate);
  return `# ${segments.join(" · ")}\n\n## Where it landed\n\n${text === null ? UNAVAILABLE : capSummary(text)}\n`;
}

async function readLastAssistantText(
  record: OwnedSessionRecord,
  locate: SessionsResourceDeps["locate"],
): Promise<string | null> {
  try {
    const location = await locate(record.lineageDir, record.sessionId);
    if (location.where === "missing") return null;
    if (location.where === "archived") {
      return lastAssistantText((await gunzip(await fs.promises.readFile(location.filePath))).toString("utf8"));
    }
    const fromTail = lastAssistantText(await readSessionTail(location.filePath, TAIL_WINDOW_BYTES));
    if (fromTail !== null) return fromTail;
    const { size } = await fs.promises.stat(location.filePath);
    return size > TAIL_WINDOW_BYTES ? lastAssistantText(await fs.promises.readFile(location.filePath, "utf8")) : null;
  } catch {
    return null; // ENOENT race, EACCES, corrupt gzip, a throwing locate: all the unavailable line
  }
}

function capSummary(text: string): string {
  if (text.length <= SUMMARY_TAIL_CAP) return text;
  let end = SUMMARY_TAIL_CAP;
  const code = text.charCodeAt(end - 1);
  if (code >= 0xd800 && code <= 0xdbff) end -= 1; // never leave a lone high surrogate
  return `${text.slice(0, end)}…`;
}
