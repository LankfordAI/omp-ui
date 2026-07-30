import * as fs from "node:fs";
import * as path from "node:path";
import * as zlib from "node:zlib";
import { isLineageDirName } from "./paths";

export type SessionLocation =
  | { where: "active" | "archived"; filePath: string }
  | { where: "missing" };

/** `<timestamp>_<sessionId><suffix>` match, files only. */
async function findBySessionId(
  dir: string,
  sessionId: string,
  suffix: string,
): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  const needle = `_${sessionId}${suffix}`;
  const hit = entries.find((e) => e.isFile() && e.name.endsWith(needle));
  return hit ? path.join(dir, hit.name) : null;
}

/** Newest session file in a dir by mtime; null when the dir is missing/empty. */
export async function findNewestSessionFile(
  dir: string,
  suffix = ".jsonl",
): Promise<string | null> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  let newest: { filePath: string; mtimeMs: number } | null = null;
  for (const entry of entries) {
    // Skips *.bak orphans, the .draft-only-session marker, and artifact dirs.
    if (!entry.isFile() || !entry.name.endsWith(suffix) || entry.name.includes(`${suffix}.`))
      continue;
    const filePath = path.join(dir, entry.name);
    try {
      const { mtimeMs } = await fs.promises.stat(filePath);
      if (!newest || mtimeMs > newest.mtimeMs) newest = { filePath, mtimeMs };
    } catch {
      // vanished between readdir and stat — skip
    }
  }
  return newest?.filePath ?? null;
}

/**
 * Re-resolves a session's file on every call (omp gc relocates and gzips cold
 * sessions — cached absolute paths dangle; ADR-0003). Order: exact active →
 * exact archived → newest active (stale/absent id adopts that file's header
 * id) → newest archived → missing.
 */
export async function resolveSessionLocation(
  sessionsRoot: string,
  archiveRoot: string,
  lineageDir: string,
  sessionId: string | null,
): Promise<SessionLocation> {
  const activeDir = path.join(sessionsRoot, lineageDir);
  const archivedDir = path.join(archiveRoot, lineageDir);
  if (sessionId) {
    const active = await findBySessionId(activeDir, sessionId, ".jsonl");
    if (active) return { where: "active", filePath: active };
    const archived = await findBySessionId(archivedDir, sessionId, ".jsonl.gz");
    if (archived) return { where: "archived", filePath: archived };
  }
  const newestActive = await findNewestSessionFile(activeDir);
  if (newestActive) return { where: "active", filePath: newestActive };
  const newestArchived = await findNewestSessionFile(archivedDir, ".jsonl.gz");
  if (newestArchived) return { where: "archived", filePath: newestArchived };
  return { where: "missing" };
}

/**
 * Gunzips an archived session back into the active lineage dir (the single
 * unarchive rule from omp's gc-cli.ts): restore the .jsonl, delete the .gz,
 * and move the extension-less artifacts dir back when present. Errors throw —
 * the caller surfaces them and leaves the record archived.
 */
export async function unarchiveSession(
  sessionsRoot: string,
  archiveRoot: string,
  lineageDir: string,
  sessionId: string,
): Promise<string> {
  const archivedDir = path.join(archiveRoot, lineageDir);
  const gz = await findBySessionId(archivedDir, sessionId, ".jsonl.gz");
  if (!gz) throw new Error(`archived session ${sessionId} not found in ${archivedDir}`);

  const name = path.basename(gz, ".jsonl.gz"); // <timestamp>_<id>
  const activeDir = path.join(sessionsRoot, lineageDir);
  await fs.promises.mkdir(activeDir, { recursive: true });

  let raw: Buffer;
  try {
    raw = zlib.gunzipSync(await fs.promises.readFile(gz));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`corrupt gzip archive ${gz}: ${detail}`, { cause: err });
  }
  const restored = path.join(activeDir, `${name}.jsonl`);
  await fs.promises.writeFile(restored, raw);
  await fs.promises.unlink(gz);

  const archivedArtifacts = path.join(archivedDir, name);
  if (fs.existsSync(archivedArtifacts)) {
    await fs.promises.rename(archivedArtifacts, path.join(activeDir, name));
  }
  return restored;
}

/**
 * Irreversibly deletes a lineage's files from both roots: the `.jsonl`s, their
 * sibling artifacts dirs, and the archived `.gz`s. One record owns one lineage
 * dir (ADR-0003), so the dir *is* the delete unit — no per-file surgery.
 *
 * The name is validated first. It comes from the registry, a hand-editable JSON
 * file, and it feeds a recursive delete: a value containing a separator or `..`
 * would escape the roots. Rejected names throw rather than deleting anything.
 * Returns the dirs that actually existed and are now gone.
 */
export async function deleteSessionFiles(
  sessionsRoot: string,
  archiveRoot: string,
  lineageDir: string,
): Promise<string[]> {
  if (!isLineageDirName(lineageDir)) {
    throw new Error(`refusing to delete non-lineage dir name ${JSON.stringify(lineageDir)}`);
  }
  const removed: string[] = [];
  for (const root of [sessionsRoot, archiveRoot]) {
    const dir = path.join(root, lineageDir);
    // The name is separator-free, so this holds unless the check above lied.
    if (path.dirname(dir) !== root) throw new Error(`refusing to delete outside ${root}: ${dir}`);
    if (!fs.existsSync(dir)) continue;
    await fs.promises.rm(dir, { recursive: true, force: true });
    removed.push(dir);
  }
  return removed;
}
