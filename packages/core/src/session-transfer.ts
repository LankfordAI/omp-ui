// The subprocess half of the cross-machine migration contract (issue #888):
// runs omp's own `session pack` / `session unpack` / `session moved` and
// `auth export` / `auth import` against the resolved binary. Main-process only
// (mirrors anonymize.ts) — the renderer never shells out, and packing,
// unpacking, and credential serialization stay entirely omp-side: omp-ui never
// re-implements them. What IS ours: the ADR-0003 relocation of an unpacked
// transcript into a minted lineage dir (adoptIntoLineage), and zero-then-unlink
// shredding of every bundle we stage on disk.
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { mintLineageDirName } from "./paths";

/** One CLI invocation outcome, captured without throwing on nonzero exit. */
export interface OmpCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/** Test seam: run the bundled omp with argv. Defaults to child_process.execFile. */
export type TransferCliExec = (ompPath: string, argv: readonly string[]) => Promise<OmpCliResult>;

export interface TransferCliDeps {
  /** Test seam replacing the subprocess. */
  exec?: TransferCliExec;
}

// Pack/unpack tar whole lineages (subagent transcripts, artifacts): 120 s.
// Auth bundles are a single small JSON: 30 s.
const SESSION_TIMEOUT_MS = 120_000;
const AUTH_TIMEOUT_MS = 30_000;

const defaultExec = (timeoutMs: number): TransferCliExec => {
  return (ompPath, argv) =>
    // Executor form (not Promise.withResolvers): core's tsconfig lib is ES2022.
    new Promise((resolve) => {
      execFile(
        ompPath,
        [...argv],
        // NO_COLOR/FORCE_COLOR=0 keep the refusal scrape plain text
        // (anonymize.ts:32-34): an inherited FORCE_COLOR would colorize stderr
        // past the "^error:" strip and surface escape codes verbatim.
        {
          timeout: timeoutMs,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
        },
        (err, stdout, stderr) => {
          // execFile errors carry the exit code (or a spawn failure as a
          // string); both are outcomes, not throws — the caller reads the
          // contract.
          const code = err === null ? 0 : typeof err.code === "number" ? err.code : null;
          resolve({ stdout, stderr, code });
        },
      );
    });
};

/** omp's failure contract: stderr minus the leading `error:` prefix (same
 * scrape as anonymize.ts), with a per-command generic fallback. */
function failureMessage(result: OmpCliResult, fallback: string): string {
  const text = result.stderr.trim().replace(/^error:\s*/i, "");
  return text.length > 0 ? text : fallback;
}

// `warning: N referenced blob(s) are missing…` — omp prints this on pack when
// the transcript references blobs GC already pruned; the images won't load
// after unpack, which is a warning, never a blocker.
const MISSING_BLOBS_RE = /warning:\s*(\d+)\s+referenced blob/i;

/**
 * `omp session pack <sessionFile> <outTar>`: bundles the transcript and its
 * referenced blobs into `outTar` (which must sit in caller-owned 0600 staging
 * — this module never stages). Success carries the missing-blob count so the
 * UI can warn that N images will not load after unpack.
 */
export async function packSessionFile(
  ompPath: string,
  sessionFile: string,
  outTar: string,
  deps: TransferCliDeps = {},
): Promise<{ ok: true; missingBlobs: number } | { ok: false; message: string }> {
  const result = await (deps.exec ?? defaultExec(SESSION_TIMEOUT_MS))(ompPath, [
    "session",
    "pack",
    sessionFile,
    outTar,
  ]);
  if (result.code !== 0) return { ok: false, message: failureMessage(result, "omp session pack failed") };
  const match = MISSING_BLOBS_RE.exec(result.stderr);
  return { ok: true, missingBlobs: match ? Number(match[1]) : 0 };
}

/**
 * `omp session unpack <archive> --cwd <cwd>`: restores the packed transcript
 * (the CLI exposes no `--session-dir` — verified against omp 18.12.2's
 * commands/session.ts), placing it under the default session dir scoped to
 * `cwd`. Success carries the placed transcript path from stdout (trimmed);
 * the caller relocates it via {@link adoptIntoLineage}.
 */
export async function unpackSessionArchive(
  ompPath: string,
  archive: string,
  cwd: string,
  deps: TransferCliDeps = {},
): Promise<{ ok: true; sessionFile: string } | { ok: false; message: string }> {
  const result = await (deps.exec ?? defaultExec(SESSION_TIMEOUT_MS))(ompPath, [
    "session",
    "unpack",
    archive,
    "--cwd",
    cwd,
  ]);
  if (result.code !== 0) return { ok: false, message: failureMessage(result, "omp session unpack failed") };
  const sessionFile = result.stdout.trim();
  if (sessionFile.length === 0) return { ok: false, message: "omp session unpack reported no file" };
  return { ok: true, sessionFile };
}

/**
 * `omp session moved <sessionFile> --to <label>`: marks the source copy as
 * relocated so omp's own fork-on-resume guard (forkIfMovedAway) forks instead
 * of silently continuing a stale copy.
 */
export async function markSessionMoved(
  ompPath: string,
  sessionFile: string,
  label: string,
  deps: TransferCliDeps = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await (deps.exec ?? defaultExec(AUTH_TIMEOUT_MS))(ompPath, [
    "session",
    "moved",
    sessionFile,
    "--to",
    label,
  ]);
  if (result.code === 0) return { ok: true };
  return { ok: false, message: failureMessage(result, "omp session moved failed") };
}

/**
 * `omp auth export` writes the credential bundle as JSON on stdout (docs
 * example: `omp auth export > credentials.json`; no file flag exists at omp
 * 18.12.2 — if one ever ships, switch the argv here only). Writes stdout to
 * `outFile`, which must be a caller-owned 0600 temp. NEVER log stdout or the
 * file contents: this is secret material (ADR-0028 credential discipline).
 */
export async function authExport(
  ompPath: string,
  outFile: string,
  deps: TransferCliDeps = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await (deps.exec ?? defaultExec(AUTH_TIMEOUT_MS))(ompPath, ["auth", "export"]);
  if (result.code !== 0) return { ok: false, message: failureMessage(result, "omp auth export failed") };
  await fs.promises.writeFile(outFile, result.stdout, { mode: 0o600 });
  return { ok: true };
}

/** `omp auth import <inFile>` — merge-imports (documented CLI behavior), so a
 * second carry is additive. Exit code only; stderr is the failure message.
 * NEVER log the file contents. */
export async function authImport(
  ompPath: string,
  inFile: string,
  deps: TransferCliDeps = {},
): Promise<{ ok: true } | { ok: false; message: string }> {
  const result = await (deps.exec ?? defaultExec(AUTH_TIMEOUT_MS))(ompPath, ["auth", "import", inFile]);
  if (result.code === 0) return { ok: true };
  return { ok: false, message: failureMessage(result, "omp auth import failed") };
}

/**
 * Overwrite with zeros at the same length, then unlink. Best-effort: an
 * unlink failure still propagates removal semantics to the caller's finally —
 * the bytes are gone either way; a dangling zero file is not a secret. An
 * open failure still attempts the unlink (the file may be unreadable but
 * removable).
 */
export async function shredFile(filePath: string): Promise<void> {
  try {
    const { size } = await fs.promises.stat(filePath);
    const handle = await fs.promises.open(filePath, "r+");
    try {
      if (size > 0) await handle.write(Buffer.alloc(size), 0, size, 0);
    } finally {
      await handle.close();
    }
  } catch {
    // Zero-fill is best-effort; fall through to the unlink anyway.
  }
  await fs.promises.rm(filePath, { force: true });
}

/**
 * Move an unpacked transcript (and its sibling artifacts dir, omp's
 * extension-less convention — cf. archive.ts:unarchiveSession) from wherever
 * `omp session unpack` landed it into a fresh ADR-0003 lineage dir directly
 * under `sessionsRoot`. Returns the minted dir NAME and the session id parsed
 * from the `<ts>_<id>.jsonl` suffix. Both renames stay inside one filesystem
 * (the default session dir and every lineage dir share sessionsRoot), so they
 * are EXDEV-free, keep GC reachability, and make isLineageDirName — which
 * gates cascade delete — pass.
 *
 * Resilient to the staging layout: if the transcript sits inside its own
 * subdirectory instead of loose in sessionsRoot, that directory's children
 * move too.
 */
export async function adoptIntoLineage(
  sessionsRoot: string,
  placedSessionFile: string,
  projectCwd: string,
): Promise<{ lineageDir: string; sessionId: string }> {
  const base = path.basename(placedSessionFile);
  const match = /^(.+)_(.+)\.jsonl$/.exec(base);
  if (!match) {
    throw new Error(`unpack placed ${base} outside the <ts>_<id>.jsonl convention`);
  }
  const [, stem, sessionId] = match;
  const lineageDir = mintLineageDirName(projectCwd);
  const dir = path.join(sessionsRoot, lineageDir);
  await fs.promises.mkdir(dir, { recursive: true });
  try {
    await fs.promises.rename(placedSessionFile, path.join(dir, base));
    // Sibling artifacts dir named `<ts>_<id>` next to the transcript.
    const sibling = path.join(path.dirname(placedSessionFile), stem);
    if (fs.existsSync(sibling) && fs.statSync(sibling).isDirectory()) {
      await fs.promises.rename(sibling, path.join(dir, stem));
    } else {
      // Unpack staging layout varies: the transcript may have landed inside
      // its own staging directory. Adopt that dir's remaining children too.
      const parent = path.dirname(placedSessionFile);
      if (path.resolve(parent) !== path.resolve(sessionsRoot) && fs.existsSync(parent)) {
        for (const entry of await fs.promises.readdir(parent)) {
          await fs.promises.rename(path.join(parent, entry), path.join(dir, entry));
        }
        await fs.promises.rm(parent, { recursive: true, force: true });
      }
    }
  } catch (err) {
    // Registration happens after this returns; a failed adopt must not leave
    // a half-minted dir behind.
    await fs.promises.rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { lineageDir, sessionId };
}
