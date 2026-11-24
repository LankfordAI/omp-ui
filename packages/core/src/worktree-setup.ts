import * as fs from "node:fs";
import * as path from "node:path";
import { minimatch } from "minimatch";
import { git } from "./git";
import type { ProjectWorktreeSetup } from "./types";

export const WORKTREE_SETUP_MAX_PATHS = 64;
export const WORKTREE_SETUP_MAX_PATH_LENGTH = 260;
export const WORKTREE_SETUP_MAX_COMMAND_LENGTH = 2_000;
const GIT_TIMEOUT_MS = 10_000;
const MAX_FOLDER_FILES = 256;

function normalizeRelPattern(raw: string): string {
  const trimmed = raw.trim().replace(/\\/g, "/").replace(/\/+$/, "");
  return trimmed.startsWith("./") ? trimmed.slice(2) : trimmed;
}

function hasControlChar(value: string, allowWhitespace = false): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x7f) return true;
    if (code < 0x20) {
      if (allowWhitespace && (code === 0x09 || code === 0x0a || code === 0x0d)) continue;
      return true;
    }
  }
  return false;
}

/**
 * Validates one repo-relative path or glob pattern for worktree setup:
 * rejects empty strings, absolute paths, drive prefixes, `..` traversal,
 * `.git` / `.omp` targets, NUL/control characters, and excessive length.
 */
export function isSafeWorktreeSetupPattern(raw: string): boolean {
  const pattern = normalizeRelPattern(raw);
  if (pattern === "" || pattern.length > WORKTREE_SETUP_MAX_PATH_LENGTH) return false;
  if (hasControlChar(pattern)) return false;
  if (pattern.startsWith("/") || /^[A-Za-z]:/.test(pattern)) return false;
  const segments = pattern.split("/");
  if (segments.some((seg) => seg === "" || seg === "." || seg === "..")) return false;
  const first = segments[0]!.toLowerCase();
  if (first === ".git" || first === ".omp") return false;
  return true;
}

/**
 * Validates and normalizes a `ProjectWorktreeSetup` payload; returns null when
 * input is null or completely empty (no copyPaths and no postCreateCommand).
 * Throws a user-facing Error on invalid fields so IPC handlers reject cleanly.
 */
export function validateWorktreeSetup(
  input: ProjectWorktreeSetup | null,
): ProjectWorktreeSetup | null {
  if (input === null) return null;
  if (!Array.isArray(input.copyPaths)) {
    throw new Error("worktree setup copyPaths must be a list of repo-relative paths");
  }
  if (input.copyMode !== "copy" && input.copyMode !== "symlink") {
    throw new Error('worktree setup copyMode must be "copy" or "symlink"');
  }
  if (input.postCreateCommand !== null && typeof input.postCreateCommand !== "string") {
    throw new Error("worktree setup postCreateCommand must be a string or null");
  }
  const seen = new Set<string>();
  const copyPaths: string[] = [];
  for (const entry of input.copyPaths) {
    if (typeof entry !== "string") {
      throw new Error("worktree setup paths must be strings");
    }
    const normalized = normalizeRelPattern(entry);
    if (normalized === "") continue;
    if (!isSafeWorktreeSetupPattern(normalized)) {
      throw new Error(`unsafe worktree setup path: ${entry}`);
    }
    if (!seen.has(normalized)) {
      seen.add(normalized);
      copyPaths.push(normalized);
    }
  }
  if (copyPaths.length > WORKTREE_SETUP_MAX_PATHS) {
    throw new Error(`worktree setup supports at most ${WORKTREE_SETUP_MAX_PATHS} paths`);
  }
  const rawCmd = input.postCreateCommand === null ? null : input.postCreateCommand.trim();
  const postCreateCommand = rawCmd === null || rawCmd === "" ? null : rawCmd;
  if (postCreateCommand !== null) {
    if (postCreateCommand.length > WORKTREE_SETUP_MAX_COMMAND_LENGTH) {
      throw new Error(
        `worktree setup post-create command must be at most ${WORKTREE_SETUP_MAX_COMMAND_LENGTH} characters`,
      );
    }
    if (hasControlChar(postCreateCommand, true)) {
      throw new Error("worktree setup post-create command contains invalid control characters");
    }
  }
  if (copyPaths.length === 0 && postCreateCommand === null) return null;
  return {
    copyPaths,
    copyMode: input.copyMode,
    postCreateCommand,
  };
}

/** Lenient registry-load normalizer: returns validated setup or null without throwing. */
export function parseWorktreeSetup(value: unknown): ProjectWorktreeSetup | null {
  if (value === null || value === undefined || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  try {
    return validateWorktreeSetup({
      copyPaths: Array.isArray(candidate["copyPaths"])
        ? (candidate["copyPaths"] as string[])
        : [],
      copyMode: candidate["copyMode"] === "symlink" ? "symlink" : "copy",
      postCreateCommand:
        typeof candidate["postCreateCommand"] === "string"
          ? candidate["postCreateCommand"]
          : null,
    });
  } catch {
    return null;
  }
}

function collectIgnoredFolderFiles(root: string, relDir: string): string[] {
  const out: string[] = [];
  const stack = [relDir.replace(/\/$/, "")];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(path.join(root, ...dir.split("/")), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name !== ".git" && entry.name !== ".omp") stack.push(child);
        continue;
      }
      out.push(child);
      if (out.length >= MAX_FOLDER_FILES) return out;
    }
  }
  return out;
}

/**
 * Lists gitignored paths in `projectCwd` using ADR-0076's `--ignored=matching`
 * scan discipline. Returns repo-relative forward-slash paths.
 */
async function listGitignoredPaths(projectCwd: string): Promise<string[]> {
  const status = await git(
    projectCwd,
    ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"],
    { timeoutMs: GIT_TIMEOUT_MS },
  );
  const paths: string[] = [];
  for (const record of status.split("\0")) {
    if (!record.startsWith("!! ")) continue;
    const rel = record.slice(3);
    if (rel === "" || rel.startsWith(".git/") || rel === ".git" || rel.startsWith(".omp/") || rel === ".omp") {
      continue;
    }
    if (rel.endsWith("/")) {
      paths.push(rel.slice(0, -1));
      paths.push(...collectIgnoredFolderFiles(projectCwd, rel));
    } else {
      paths.push(rel);
    }
  }
  return [...new Set(paths)].sort();
}

export interface ApplyWorktreeFilesResult {
  applied: string[];
  skipped: Array<{ path: string; reason: string }>;
}

/**
 * Copies or symlinks allowlisted gitignored files from `projectCwd` into
 * `worktreePath`. Patterns expand ONLY against gitignored entries in
 * `projectCwd`, and existing files in `worktreePath` (such as tracked files)
 * are never overwritten.
 */
export async function applyWorktreeFiles(
  projectCwd: string,
  worktreePath: string,
  setup: ProjectWorktreeSetup,
): Promise<ApplyWorktreeFilesResult> {
  const validated = validateWorktreeSetup(setup);
  if (validated === null || validated.copyPaths.length === 0) {
    return { applied: [], skipped: [] };
  }
  let ignored: string[];
  try {
    ignored = await listGitignoredPaths(projectCwd);
  } catch (err) {
    return {
      applied: [],
      skipped: [{ path: "*", reason: err instanceof Error ? err.message : String(err) }],
    };
  }

  const matched = new Set<string>();
  const ignoredSet = new Set(ignored);
  for (const pattern of validated.copyPaths) {
    for (const candidate of ignored) {
      if (candidate === pattern || minimatch(candidate, pattern, { dot: true })) {
        matched.add(candidate);
      }
    }
    // A bare folder name (e.g. "cache") should carry gitignored files beneath
    // it in copy mode, and in symlink mode when the folder itself is not a
    // single gitignored directory that can be symlinked as a unit.
    if (validated.copyMode === "copy" || !ignoredSet.has(pattern)) {
      const prefix = `${pattern}/`;
      for (const candidate of ignored) {
        if (candidate.startsWith(prefix)) matched.add(candidate);
      }
    }
  }
  // In copy mode, also expand any matched directory (including glob matches
  // like "cach*") to its collected gitignored descendants so bare/globbed
  // directory entries are never silently dropped when directories are skipped.
  if (validated.copyMode === "copy") {
    for (const entry of [...matched]) {
      const prefix = `${entry}/`;
      for (const candidate of ignored) {
        if (candidate.startsWith(prefix)) matched.add(candidate);
      }
    }
  }

  const applied: string[] = [];
  const skipped: Array<{ path: string; reason: string }> = [];
  const sorted = [...matched].sort();

  for (const rel of sorted) {
    if (!isSafeWorktreeSetupPattern(rel)) {
      skipped.push({ path: rel, reason: "unsafe-path" });
      continue;
    }
    const src = path.join(projectCwd, ...rel.split("/"));
    const dest = path.join(worktreePath, ...rel.split("/"));
    let srcStat: fs.Stats;
    try {
      srcStat = await fs.promises.lstat(src);
    } catch {
      skipped.push({ path: rel, reason: "missing-source" });
      continue;
    }
    // Only link directories when symlink mode explicitly matched the dir entry;
    // in copy mode skip directory entries because their files are matched individually.
    if (srcStat.isDirectory() && validated.copyMode === "copy") {
      continue;
    }
    if (srcStat.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "source-symlink" });
      continue;
    }
    // Never overwrite existing tracked or pre-populated files in the worktree.
    try {
      await fs.promises.lstat(dest);
      skipped.push({ path: rel, reason: "already-exists" });
      continue;
    } catch {
      // ENOENT expected: safe to create.
    }
    try {
      await fs.promises.mkdir(path.dirname(dest), { recursive: true });
      if (validated.copyMode === "symlink") {
        const linkType = srcStat.isDirectory() ? "junction" : "file";
        await fs.promises.symlink(src, dest, linkType);
      } else {
        await fs.promises.copyFile(src, dest, fs.constants.COPYFILE_EXCL);
      }
      applied.push(rel);
    } catch (err) {
      skipped.push({
        path: rel,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { applied, skipped };
}
