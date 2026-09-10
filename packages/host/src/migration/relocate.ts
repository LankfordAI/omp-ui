import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextDurably, type BreadcrumbSink, type BuildFlavor } from "@omp-ui/core";
import { MigrationConflict, type ItemEvidence, type MigrationJournal } from "./journal";

/**
 * Moves the authority stores from Electron's userData dir into the host data
 * root (issue #442 §5.4). Runs once per data root, before anything
 * else in the host writes into it: a destination that exists without journal
 * evidence is treated as someone else's and stops the migration.
 */

export const RELOCATED_ITEMS = [
  "registry.json",
  "provider-keys.json",
  "remote-instances.json",
  "oauth-login",
  "worktrees",
  "logs",
] as const;

export type RelocatedItem = (typeof RELOCATED_ITEMS)[number];

const STEP = "relocate-authority-stores-v1";

const LEGACY_USER_DATA_NAME: Readonly<Record<BuildFlavor, string>> = {
  installed: "@omp-ui/desktop",
  dev: "@omp-ui/desktop-dev",
  "dev-server": "@omp-ui/desktop-dev-server",
};

/** Electron's pinned userData dir for the flavor (desktop main/index.ts). */
export function legacyUserDataDir(flavor: BuildFlavor, appData: string): string {
  return path.join(appData, LEGACY_USER_DATA_NAME[flavor]);
}

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RelocateOptions {
  legacyUserData: string;
  dataRoot: string;
  journal: MigrationJournal;
  git: (args: string[], cwd: string) => Promise<GitResult>;
  breadcrumbs: BreadcrumbSink;
  /** Test seam for the cross-device path; defaults to `fs.renameSync`. */
  rename?: (from: string, to: string) => void;
}

const HASH_CHUNK = 1024 * 1024;

function sha256File(file: string): string {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(HASH_CHUNK);
    for (;;) {
      const read = fs.readSync(fd, buffer, 0, HASH_CHUNK, null);
      if (read === 0) break;
      hash.update(buffer.subarray(0, read));
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest("hex");
}

/**
 * A content fingerprint of a file, symlink, or directory tree: relative
 * paths with type, size, and SHA-256 (files) or link target (symlinks).
 * Equal fingerprints mean byte-equal trees.
 */
function fingerprint(root: string): string {
  const lines: string[] = [];
  const visit = (abs: string, rel: string): void => {
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) {
      lines.push(`L ${rel} ${fs.readlinkSync(abs)}`);
    } else if (st.isDirectory()) {
      lines.push(`D ${rel}`);
      for (const name of fs.readdirSync(abs).sort()) visit(path.join(abs, name), `${rel}/${name}`);
    } else {
      lines.push(`F ${rel} ${st.size} ${sha256File(abs)}`);
    }
  };
  visit(root, ".");
  return lines.join("\n");
}

/** Recursive copy preserving symlinks, modes, and mtimes; never follows links. */
function copyTree(from: string, to: string): void {
  const st = fs.lstatSync(from);
  if (st.isSymbolicLink()) {
    fs.symlinkSync(fs.readlinkSync(from), to);
    return;
  }
  if (st.isDirectory()) {
    fs.mkdirSync(to, { mode: st.mode & 0o777 });
    for (const name of fs.readdirSync(from)) copyTree(path.join(from, name), path.join(to, name));
    fs.utimesSync(to, st.atime, st.mtime);
    return;
  }
  fs.copyFileSync(from, to);
  fs.chmodSync(to, st.mode & 0o777);
  fs.utimesSync(to, st.atime, st.mtime);
}

/** fsync one file or directory (a directory entry rename is durable only after this). */
function fsyncPath(p: string, isDirectory: boolean): void {
  let fd: number;
  try {
    fd = fs.openSync(p, "r");
  } catch (error) {
    // NTFS has no directory fsync; files still sync.
    if (process.platform === "win32" && isDirectory) return;
    throw error;
  }
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** fsync every regular file and directory under `root` (symlinks have no content). */
function fsyncTree(root: string): void {
  const st = fs.lstatSync(root);
  if (st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    for (const name of fs.readdirSync(root)) fsyncTree(path.join(root, name));
  }
  fsyncPath(root, st.isDirectory());
}

function identityMatches(source: string, evidence: ItemEvidence): boolean {
  const st = fs.lstatSync(source);
  return (
    st.dev === evidence.dev &&
    st.ino === evidence.ino &&
    st.size === evidence.size &&
    st.mtimeMs === evidence.mtimeMs
  );
}

function evidenceFor(name: string, source: string, destination: string, status: ItemEvidence["status"]): ItemEvidence {
  const st = fs.lstatSync(source);
  return {
    name,
    source,
    destination,
    mode: st.mode,
    size: st.size,
    mtimeMs: st.mtimeMs,
    dev: st.dev,
    ino: st.ino,
    status,
  };
}

function exists(p: string): boolean {
  try {
    fs.lstatSync(p);
    return true;
  } catch {
    return false;
  }
}

/** Source and destination hold identical bytes and the source is the file the evidence saw. */
function dedupeAllowed(evidence: ItemEvidence): boolean {
  return identityMatches(evidence.source, evidence) && fingerprint(evidence.source) === fingerprint(evidence.destination);
}

interface Mover {
  journal: MigrationJournal;
  rename: (from: string, to: string) => void;
  breadcrumbs: BreadcrumbSink;
}

/** Copy path: stage beside the destination, verify, publish, verify again, drop the source. */
function copyAcrossDevices(evidence: ItemEvidence, mover: Mover): void {
  const staging = `${evidence.destination}.tmp-migrate`;
  fs.rmSync(staging, { recursive: true, force: true });
  copyTree(evidence.source, staging);
  if (fingerprint(evidence.source) !== fingerprint(staging)) {
    fs.rmSync(staging, { recursive: true, force: true });
    throw new MigrationConflict(`copy of ${evidence.source} to ${staging} did not verify`);
  }
  fsyncTree(staging);
  fs.renameSync(staging, evidence.destination);
  fsyncPath(path.dirname(evidence.destination), true);
  mover.journal.updateItem(STEP, { ...evidence, status: "moved" });
  if (fingerprint(evidence.source) !== fingerprint(evidence.destination)) {
    throw new MigrationConflict(`${evidence.destination} does not match ${evidence.source} after publish`);
  }
  mover.journal.updateItem(STEP, { ...evidence, status: "verified" });
  fs.rmSync(evidence.source, { recursive: true, force: true });
  mover.journal.updateItem(STEP, { ...evidence, status: "done" });
}

/** Same device: one atomic rename, then evidence. */
function moveItem(evidence: ItemEvidence, dataRoot: string, mover: Mover): void {
  const sameDevice = fs.lstatSync(evidence.source).dev === fs.statSync(dataRoot).dev;
  if (sameDevice) {
    try {
      mover.rename(evidence.source, evidence.destination);
      fsyncPath(path.dirname(evidence.destination), true);
      mover.journal.updateItem(STEP, { ...evidence, status: "done" });
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    }
  }
  mover.breadcrumbs.record("authority", { detail: `migration: copying ${evidence.name} across devices` });
  copyAcrossDevices(evidence, mover);
}

function relocateItem(name: RelocatedItem, opts: RelocateOptions, mover: Mover): void {
  const source = path.join(opts.legacyUserData, name);
  const destination = path.join(opts.dataRoot, name);
  const step = opts.journal.step(STEP);
  const evidence = step?.items.find((item) => item.name === name) ?? null;
  const sourceExists = exists(source);
  const destinationExists = exists(destination);

  if (!evidence) {
    if (!sourceExists && !destinationExists) {
      opts.journal.updateItem(STEP, {
        name,
        source,
        destination,
        mode: 0,
        size: 0,
        mtimeMs: 0,
        dev: 0,
        ino: 0,
        status: "skipped",
      });
      return;
    }
    if (destinationExists) {
      throw new MigrationConflict(
        `${destination} exists but the migration journal never moved ${name}; refusing to overwrite`,
      );
    }
    const fresh = evidenceFor(name, source, destination, "pending");
    opts.journal.updateItem(STEP, fresh);
    moveItem(fresh, opts.dataRoot, mover);
    return;
  }

  if (evidence.status === "done" || evidence.status === "skipped") return;
  if (!sourceExists && !destinationExists) {
    throw new MigrationConflict(`${name} was recorded at ${source} but is now at neither ${source} nor ${destination}`);
  }
  if (sourceExists && !destinationExists) {
    // Nothing reached the destination: redo from the source as it is now.
    const fresh = evidenceFor(name, source, destination, "pending");
    opts.journal.updateItem(STEP, fresh);
    moveItem(fresh, opts.dataRoot, mover);
    return;
  }
  if (!sourceExists) {
    opts.journal.updateItem(STEP, { ...evidence, status: "done" });
    return;
  }
  if (!dedupeAllowed(evidence)) {
    throw new MigrationConflict(
      `${name} exists at both ${source} and ${destination} and they are not the same bytes the journal recorded`,
    );
  }
  opts.journal.updateItem(STEP, { ...evidence, status: "verified" });
  fs.rmSync(source, { recursive: true, force: true });
  opts.journal.updateItem(STEP, { ...evidence, status: "done" });
}

function isWithin(root: string, candidate: string): boolean {
  const rel = path.relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

/** The registry fields the repair reads and rewrites; everything else passes through untouched. */
interface WorktreeRef {
  path: string;
  resumeUnavailable?: boolean;
}

function isWorktreeRef(value: unknown): value is WorktreeRef {
  return value !== null && typeof value === "object" && "path" in value && typeof value.path === "string";
}

/**
 * Re-links every registered worktree checkout that moved with `worktrees/`.
 * The registry is parsed leniently and rewritten in place: only
 * `worktree.path` (and `worktree.resumeUnavailable` on failure) change.
 */
async function repairWorktrees(opts: RelocateOptions): Promise<void> {
  const registryFile = path.join(opts.dataRoot, "registry.json");
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(registryFile, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    opts.breadcrumbs.record("authority", {
      detail: `migration: registry unreadable, worktrees not repaired: ${(error as Error).message}`,
    });
    return;
  }
  if (raw === null || typeof raw !== "object" || !("sessions" in raw) || !Array.isArray(raw.sessions)) return;
  const oldRoot = path.join(opts.legacyUserData, "worktrees");
  const newRoot = path.join(opts.dataRoot, "worktrees");
  let changed = false;
  for (const session of raw.sessions as unknown[]) {
    if (session === null || typeof session !== "object" || !("worktree" in session)) continue;
    const wt = session.worktree;
    if (!isWorktreeRef(wt) || !isWithin(oldRoot, wt.path)) continue;
    const projectCwd = "projectCwd" in session ? session.projectCwd : undefined;
    const newPath = path.join(newRoot, path.relative(oldRoot, wt.path));
    let repaired: GitResult;
    if (typeof projectCwd === "string") {
      try {
        repaired = await opts.git(["worktree", "repair", newPath], projectCwd);
      } catch (error) {
        repaired = { code: -1, stdout: "", stderr: (error as Error).message };
      }
    } else {
      repaired = { code: -1, stdout: "", stderr: "session has no projectCwd" };
    }
    wt.path = newPath;
    if (repaired.code === 0) {
      delete wt.resumeUnavailable;
    } else {
      wt.resumeUnavailable = true;
      opts.breadcrumbs.record("authority", {
        detail: `migration: git worktree repair failed for ${newPath}: ${repaired.stderr.trim() || `exit ${repaired.code}`}`,
      });
    }
    changed = true;
  }
  if (changed) writeTextDurably(registryFile, `${JSON.stringify(raw, null, 2)}\n`);
}

/**
 * Moves every {@link RELOCATED_ITEMS} entry from `legacyUserData` to
 * `dataRoot`, journaled per item, then repairs worktree links and commits the
 * step. Idempotent: a committed step returns immediately; an open step
 * replays each item from its evidence.
 */
export async function relocateAuthorityStores(opts: RelocateOptions): Promise<void> {
  if (opts.journal.step(STEP)?.status === "committed") return;
  fs.mkdirSync(opts.dataRoot, { recursive: true });
  opts.journal.begin(STEP);
  const mover: Mover = {
    journal: opts.journal,
    rename: opts.rename ?? fs.renameSync,
    breadcrumbs: opts.breadcrumbs,
  };
  for (const name of RELOCATED_ITEMS) relocateItem(name, opts, mover);
  await repairWorktrees(opts);
  opts.journal.commit(STEP);
  opts.breadcrumbs.record("authority", { detail: `migration: relocated authority stores into ${opts.dataRoot}` });
}
