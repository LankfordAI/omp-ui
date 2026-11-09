import * as fs from "node:fs";
import * as path from "node:path";
import { ARTIFACT_LIMITS, ArtifactError, isWithin, validateArtifactJson, validateArtifactValueFile, type ArtifactJson } from "@omp-ui/core";

/**
 * Main's confined reader for render-only `valueFile` datasets (ADR-0090).
 * The session's `local://` root is derived from its exact native transcript,
 * never from model text: `<lineage>/<stem>.jsonl` (active) or
 * `<archive lineage>/<stem>.jsonl.gz` (archived) owns `<stem>/local`. Nothing
 * here creates directories; a missing root is simply unavailable.
 */

const ACTIVE_SUFFIX = ".jsonl";
const ARCHIVE_SUFFIX = ".jsonl.gz";
const LOCAL_PREFIX = "local://";

export interface ArtifactLocalRootRequest {
  transcriptPath: string | null;
  sessionId: string | null;
  lineageDir: string;
  archiveLineageDir?: string;
}

export interface ArtifactDatasetFileContext {
  signal: AbortSignal;
  /** Re-checks caller authority; throws when revoked. Called around every IO step. */
  authorize(): void;
}

function missing(message: string): never { throw new ArtifactError("source-missing", message); }
function refuse(message: string): never { throw new ArtifactError("unsupported-contract", message); }

async function realpathOr(target: string, onMissing: () => never): Promise<string> {
  try { return await fs.promises.realpath(target); } catch { return onMissing(); }
}

async function lstatOr(target: string, onMissing: () => never): Promise<fs.BigIntStats> {
  try { return await fs.promises.lstat(target, { bigint: true }); } catch { return onMissing(); }
}

function sameNode(a: fs.BigIntStats, b: fs.BigIntStats): boolean { return a.dev === b.dev && a.ino === b.ino; }

/** A real directory (not a symlink) whose realpath is exactly `dir`. */
async function exactDirectory(dir: string, label: string): Promise<fs.BigIntStats> {
  const stat = await lstatOr(dir, () => missing(`${label} is unavailable`));
  if (stat.isSymbolicLink() || !stat.isDirectory()) refuse(`${label} is not a real directory`);
  if (await realpathOr(dir, () => missing(`${label} is unavailable`)) !== dir) refuse(`${label} is not a real directory`);
  return stat;
}

/**
 * Resolves the session's `local://` root from its known native transcript.
 * The transcript must be named exactly `<prefix>_<sessionId>.jsonl` inside the
 * active lineage or `<prefix>_<sessionId>.jsonl.gz` inside the archive
 * lineage; an unknown identity or a newest-file fallback is refused. The
 * session artifact dir and its `local` child must be real directories, so a
 * symlink cannot substitute another session's (or any other) directory.
 */
export async function resolveArtifactLocalRoot(request: ArtifactLocalRootRequest): Promise<string> {
  const { transcriptPath, sessionId } = request;
  if (transcriptPath === null || sessionId === null) missing("Dataset files require the known native session transcript");
  const name = path.basename(transcriptPath);
  const suffix = name.endsWith(ARCHIVE_SUFFIX) ? ARCHIVE_SUFFIX : name.endsWith(ACTIVE_SUFFIX) ? ACTIVE_SUFFIX : null;
  if (suffix === null) missing("Dataset files require the native session transcript");
  const stem = name.slice(0, -suffix.length);
  const needle = `_${sessionId}`;
  if (!stem.endsWith(needle) || stem.length === needle.length) missing("Transcript does not belong to the native session");
  const root = suffix === ACTIVE_SUFFIX ? request.lineageDir : request.archiveLineageDir;
  if (root === undefined) missing("Archived transcript has no archive lineage");
  const realRoot = await realpathOr(root, () => missing("Session lineage is unavailable"));
  const transcript = await lstatOr(transcriptPath, () => missing("Session transcript is unavailable"));
  if (transcript.isSymbolicLink() || !transcript.isFile()) missing("Session transcript is not a regular file");
  const realTranscript = await realpathOr(transcriptPath, () => missing("Session transcript is unavailable"));
  if (path.dirname(realTranscript) !== realRoot || path.basename(realTranscript) !== name) missing("Session transcript escaped its owning lineage");
  const artifactDir = path.join(realRoot, stem);
  await exactDirectory(artifactDir, "Session artifact directory");
  const localRoot = path.join(artifactDir, "local");
  await exactDirectory(localRoot, "Session local directory");
  return localRoot;
}

interface RootIdentity { artifactDir: fs.BigIntStats; local: fs.BigIntStats }

async function rootIdentity(localRoot: string): Promise<RootIdentity> {
  return { artifactDir: await exactDirectory(path.dirname(localRoot), "Session artifact directory"), local: await exactDirectory(localRoot, "Session local directory") };
}

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/**
 * Reads one `valueFile` dataset as an immutable snapshot. The target's
 * realpath must lie strictly inside the exact local root (a final symlink
 * resolving inside is allowed); it must be a regular file of at most
 * {@link ARTIFACT_LIMITS.datasetBytes} raw bytes. The open descriptor must be
 * the checked file, and growth, replacement or a swapped root during the read
 * is a conflict. Contents never appear in errors.
 */
export async function readArtifactDatasetFile(localRoot: string, valueFile: string, context: ArtifactDatasetFileContext): Promise<ArtifactJson> {
  const { signal, authorize } = context;
  validateArtifactValueFile(valueFile);
  signal.throwIfAborted(); authorize();
  const label = `Dataset file ${valueFile}`;
  const limit = ARTIFACT_LIMITS.datasetBytes;
  const before = await rootIdentity(localRoot);
  const target = path.join(localRoot, ...valueFile.slice(LOCAL_PREFIX.length).split("/"));
  const resolved = await realpathOr(target, () => missing(`${label} is unavailable`));
  if (!isWithin(localRoot, resolved)) refuse(`${label} escapes the session local directory`);
  const checked = await lstatOr(resolved, () => missing(`${label} is unavailable`));
  if (!checked.isFile()) refuse(`${label} is not a regular file`);
  if (checked.size > BigInt(limit)) throw new ArtifactError("over-limit", `${label} exceeds ${limit} bytes`);
  signal.throwIfAborted(); authorize();
  let handle: fs.promises.FileHandle;
  try { handle = await fs.promises.open(resolved, OPEN_FLAGS); } catch { return missing(`${label} could not be opened`); }
  let bytes: Buffer;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameNode(opened, checked)) throw new ArtifactError("conflict", `${label} changed while reading`);
    if (opened.size > BigInt(limit)) throw new ArtifactError("over-limit", `${label} exceeds ${limit} bytes`);
    signal.throwIfAborted(); authorize();
    // One spare byte detects growth past the checked size without reading unbounded input.
    const expected = Number(opened.size);
    const buffer = Buffer.allocUnsafe(expected + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(buffer, total, buffer.length - total, total);
      signal.throwIfAborted();
      if (bytesRead === 0) break;
      total += bytesRead;
    }
    authorize();
    if (total !== expected) throw new ArtifactError("conflict", `${label} changed while reading`);
    const after = await handle.stat({ bigint: true });
    if (!sameNode(after, opened) || after.size !== opened.size || after.mtimeNs !== opened.mtimeNs || after.ctimeNs !== opened.ctimeNs) {
      throw new ArtifactError("conflict", `${label} changed while reading`);
    }
    bytes = buffer.subarray(0, total);
  } finally {
    await handle.close().catch(() => {});
  }
  const changed = (): never => { throw new ArtifactError("conflict", `${label} changed while reading`); };
  const now = await rootIdentity(localRoot).catch(changed);
  if (!sameNode(now.artifactDir, before.artifactDir) || !sameNode(now.local, before.local)) changed();
  if (await realpathOr(target, changed) !== resolved || !sameNode(await lstatOr(resolved, changed), checked)) changed();
  signal.throwIfAborted(); authorize();
  let text: string;
  try { text = decoder.decode(bytes); } catch { return refuse(`${label} is not valid UTF-8`); }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return refuse(`${label} is not valid JSON`); }
  try { validateArtifactJson(value, limit); } catch (error) {
    if (error instanceof ArtifactError) throw new ArtifactError(error.code, `${label}: ${error.message}`);
    throw error;
  }
  return value;
}
