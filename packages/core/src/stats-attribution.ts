import * as fs from "node:fs";
import * as path from "node:path";
import { createGunzip } from "node:zlib";
import { parseSessionPrefix, readSessionHead, type SessionHead } from "./session-file";
import type {
  OwnedSessionRecord,
  ProjectRecord,
  StatsProjectIdentity,
  StatsSourceInfo,
} from "./types";

export interface StatsReadContext {
  source: StatsSourceInfo;
  projects: readonly ProjectRecord[];
  sessions: readonly OwnedSessionRecord[];
  ownedSessionsRoot: string;
  ownedArchiveRoot: string;
}

export interface StatsAttribution {
  identity: StatsProjectIdentity;
  title: string | null;
}

const HEADER_BYTES = 4096;
// Gzip metadata/empty members can consume input without yielding a prefix.
const ARCHIVE_INPUT_BYTES = 64 * 1024;
const HEADER_CONCURRENCY = 8;

function windowsPath(value: string): boolean {
  return process.platform === "win32" || /^[a-z]:[\\/]/i.test(value) || /^[\\/]{2}[^\\/]/.test(value);
}

function pathApi(value: string): typeof path.posix {
  return windowsPath(value) ? path.win32 : path.posix;
}

function canonicalPath(value: string): string {
  const api = pathApi(value);
  let normalized = api.resolve(value);
  if (api === path.win32) normalized = normalized.toLowerCase();
  return normalized;
}

function absolutePath(value: string): boolean {
  // Drive-relative and root-relative Windows paths depend on process state.
  if (/^[a-z]:/i.test(value)) return /^[a-z]:[\\/]/i.test(value);
  if (pathApi(value) === path.win32) return /^(?:\\\\|\/\/)[^\\/]+[\\/][^\\/]+/.test(value);
  return path.posix.isAbsolute(value);
}

function relativeWithin(root: string, file: string): string | null {
  const api = pathApi(root);
  if (api !== pathApi(file)) return null;
  const relative = api.relative(root, file);
  if (relative === "" || relative === ".." || relative.startsWith(`..${api.sep}`) || api.isAbsolute(relative)) return null;
  return relative;
}

/** Shared by attribution and the zero-use registered Project facets. */
export function statsProjectIdentity(project: ProjectRecord): StatsProjectIdentity {
  const projectPath = canonicalPath(project.path);
  return { key: `project:${projectPath}`, kind: "project", path: projectPath, name: project.name };
}

function ownedIdentity(session: OwnedSessionRecord, context: StatsReadContext): StatsProjectIdentity {
  if (session.chat) return { key: "chat", kind: "chat" };
  const cwd = canonicalPath(session.projectCwd);
  const project = context.projects.find((candidate) => canonicalPath(candidate.path) === cwd);
  return project ? statsProjectIdentity(project) : { key: `unregistered:${cwd}`, kind: "unregistered", cwd };
}

function storedPath(sessionFile: string, context: StatsReadContext): string | null {
  if (!sessionFile || sessionFile.includes("\0")) return null;
  if (absolutePath(sessionFile)) return canonicalPath(sessionFile);
  if (/^[a-z]:/i.test(sessionFile) || /^[\\/]/.test(sessionFile)) return null;
  const root = canonicalPath(context.source.sessionsRoot);
  const resolved = canonicalPath(pathApi(root).resolve(root, sessionFile));
  return relativeWithin(root, resolved) === null ? null : resolved;
}

/** Registry evidence needs neither a surviving transcript nor a surviving worktree.
 * This fallback is deliberately filesystem-free for keys first seen in a SQL snapshot. */
export function resolveOwnedStatsAttribution(
  sessionFile: string,
  context: StatsReadContext,
): StatsAttribution | null {
  const file = storedPath(sessionFile, context);
  if (file === null) return null;
  for (const rawRoot of [context.ownedSessionsRoot, context.ownedArchiveRoot]) {
    const root = canonicalPath(rawRoot);
    const relative = relativeWithin(root, file);
    if (relative === null) continue;
    const parts = relative.split(pathApi(root).sep);
    if (parts.length < 2) continue;
    const session = context.sessions.find((candidate) =>
      (pathApi(root) === path.win32 ? candidate.lineageDir.toLowerCase() : candidate.lineageDir) === parts[0],
    );
    if (session) return { identity: ownedIdentity(session, context), title: session.cachedTitle ?? null };
  }
  return null;
}

function headerIdentity(cwd: string | undefined, context: StatsReadContext): StatsProjectIdentity {
  if (!cwd || !absolutePath(cwd)) return { key: "unattributed", kind: "unattributed" };
  const normalized = canonicalPath(cwd);
  const worktree = context.sessions.find((session) =>
    session.worktree !== null && canonicalPath(session.worktree.path) === normalized,
  );
  if (worktree) return ownedIdentity(worktree, context);
  let match: ProjectRecord | undefined;
  let matchLength = -1;
  for (const project of context.projects) {
    const projectPath = canonicalPath(project.path);
    if ((normalized === projectPath || relativeWithin(projectPath, normalized) !== null) && projectPath.length > matchLength) {
      match = project;
      matchLength = projectPath.length;
    }
  }
  return match ? statsProjectIdentity(match) : { key: `unregistered:${normalized}`, kind: "unregistered", cwd: normalized };
}

interface HeaderLocation {
  root: string;
  file: string;
  archived: { root: string; file: string } | null;
}

function headerLocation(file: string, context: StatsReadContext): HeaderLocation | null {
  const roots = [
    { active: context.source.sessionsRoot, archive: context.source.archiveRoot },
    { active: context.ownedSessionsRoot, archive: context.ownedArchiveRoot },
  ].flatMap((pair) => [
    { root: canonicalPath(pair.active), archive: canonicalPath(pair.archive) },
    { root: canonicalPath(pair.archive), archive: null },
  ]).sort((left, right) => right.root.length - left.root.length);
  for (const candidate of roots) {
    const relative = relativeWithin(candidate.root, file);
    if (relative === null) continue;
    const api = pathApi(candidate.root);
    const parts = relative.split(api.sep);
    // Artifacts live beside <root-session>.jsonl in its extensionless directory.
    // A nested subagent's cwd is not evidence for the containing session's Project.
    const headerRelative = parts.length > 2
      ? api.join(parts[0]!, `${parts[1]!}.jsonl${candidate.archive === null ? ".gz" : ""}`)
      : relative;
    if (!headerRelative.endsWith(".jsonl") && !headerRelative.endsWith(".jsonl.gz")) return null;
    const headerFile = api.join(candidate.root, headerRelative);
    return {
      root: candidate.root,
      file: headerFile,
      archived: candidate.archive !== null && headerRelative.endsWith(".jsonl")
        ? { root: candidate.archive, file: api.join(candidate.archive, `${headerRelative}.gz`) }
        : null,
    };
  }
  return null;
}

function missing(error: unknown): boolean {
  return error !== null && typeof error === "object" && "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR");
}

async function gzipPrefix(file: string): Promise<string> {
  const input = fs.createReadStream(file, { highWaterMark: HEADER_BYTES, start: 0, end: ARCHIVE_INPUT_BYTES - 1 });
  const gunzip = createGunzip({ chunkSize: HEADER_BYTES });
  input.on("error", (error) => gunzip.destroy(error));
  input.pipe(gunzip);
  const prefix = Buffer.alloc(HEADER_BYTES);
  let length = 0;
  try {
    for await (const chunk of gunzip) {
      const buffer = chunk as Buffer;
      length += buffer.copy(prefix, length, 0, HEADER_BYTES - length);
      if (length === HEADER_BYTES) break;
    }
    return prefix.toString("utf8", 0, length);
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

/** Null means absent (eligible for its archive companion); {} means unreadable,
 * malformed or outside the real root (never follow an escaping symlink). */
async function confinedHeader(root: string, file: string): Promise<SessionHead | null> {
  try {
    const [realRoot, realFile] = await Promise.all([fs.promises.realpath(root), fs.promises.realpath(file)]);
    if (relativeWithin(canonicalPath(realRoot), canonicalPath(realFile)) === null) return {};
    if (!(await fs.promises.stat(realFile)).isFile()) return {};
    const prefix = file.endsWith(".gz") ? await gzipPrefix(realFile) : await readSessionHead(realFile, HEADER_BYTES);
    return parseSessionPrefix(prefix);
  } catch (error) {
    return missing(error) ? null : {};
  }
}

/** All header I/O is bounded, deduplicated and completed before SQL aggregation. */
export async function resolveStatsAttributions(
  sessionFiles: readonly string[],
  context: StatsReadContext,
): Promise<Map<string, StatsAttribution>> {
  const result = new Map<string, StatsAttribution>();
  const groups = new Map<string, { location: HeaderLocation; sessionFiles: string[] }>();
  for (const sessionFile of sessionFiles) {
    if (result.has(sessionFile)) continue;
    const owned = resolveOwnedStatsAttribution(sessionFile, context);
    if (owned) {
      result.set(sessionFile, owned);
      continue;
    }
    result.set(sessionFile, { identity: { key: "unattributed", kind: "unattributed" }, title: null });
    const file = storedPath(sessionFile, context);
    const location = file === null ? null : headerLocation(file, context);
    if (location === null) continue;
    const group = groups.get(location.file);
    if (group) group.sessionFiles.push(sessionFile);
    else groups.set(location.file, { location, sessionFiles: [sessionFile] });
  }
  const headers = new Map<string, Promise<SessionHead | null>>();
  function readHeader(root: string, file: string): Promise<SessionHead | null> {
    let head = headers.get(file);
    if (head === undefined) {
      head = confinedHeader(root, file);
      headers.set(file, head);
    }
    return head;
  }
  const pending = [...groups.values()];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(HEADER_CONCURRENCY, pending.length) }, async () => {
    while (next < pending.length) {
      const group = pending[next++]!;
      let head = await readHeader(group.location.root, group.location.file);
      if (head === null && group.location.archived !== null) {
        head = await readHeader(group.location.archived.root, group.location.archived.file);
      }
      const attribution = { identity: headerIdentity(head?.cwd, context), title: head?.title ?? null };
      for (const sessionFile of group.sessionFiles) result.set(sessionFile, attribution);
    }
  }));
  return result;
}
