/**
 * Project copy (issue #992): the source half, read in this app's main. Which
 * remote a member clones, and which gitignored files of the checkout may ride
 * along — names and sizes for the dialog, bytes only at copy time. Provider
 * keys never ride (ADR-0065): a file naming a Provider key variable is
 * skipped whole, whatever its format.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { listRemoteNames, type GitRunner } from "./branches";
import {
  PROJECT_COPY_FILE_MAX_BYTES,
  PROJECT_COPY_FILES_MAX,
  PROJECT_COPY_FOLDER_FILES_MAX,
  PROJECT_COPY_TOTAL_MAX_BYTES,
  projectCopyProviderKeyName,
  type FleetProjectFileEntry,
  type ProjectCopyFile,
  type ProjectCopyPreview,
  type ProjectCopyRead,
  type ProjectCopyRemote,
  type ProjectCopySkip,
} from "./fleet";
import { git } from "./git";
import { parseRemoteWebUrl } from "./pr-url";

const GIT_TIMEOUT_MS = 10_000;

/** The remote a member clones: `origin`, else the only remote; its https web URL and how the checkout reaches it. */
async function cloneRemote(root: string, runGit: GitRunner): Promise<{ repositoryUrl: string | null; remote: ProjectCopyRemote }> {
  const names = await listRemoteNames(root, runGit).catch((): string[] => []);
  const name = names.includes("origin") ? "origin" : names.length === 1 ? names[0]! : null;
  if (name === null) return { repositoryUrl: null, remote: "none" };
  const raw = (await runGit(root, ["remote", "get-url", name], { timeoutMs: GIT_TIMEOUT_MS }).catch(() => "")).trim();
  const web = parseRemoteWebUrl(raw);
  if (web === null) return { repositoryUrl: null, remote: "none" };
  return { repositoryUrl: web, remote: /^https?:\/\//i.test(raw) ? "https" : "ssh" };
}

/**
 * Every regular file under an ignored folder, `/`-separated and relative to
 * the checkout; null once the folder holds more than the folder cap (a
 * dependency or build tree, never worth carrying). Symlinks are not followed.
 */
function folderFiles(root: string, rel: string): string[] | null {
  const out: string[] = [];
  const stack = [rel.replace(/\/$/, "")];
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
        if (entry.name !== ".git") stack.push(child);
        continue;
      }
      out.push(child);
      if (out.length > PROJECT_COPY_FOLDER_FILES_MAX) return null;
    }
  }
  return out;
}

interface Candidate extends ProjectCopyFile {
  executable: boolean;
}

/** The checkout root plus every eligible gitignored file and every skip, in path order. */
async function scan(projectCwd: string, runGit: GitRunner): Promise<{ root: string; preview: ProjectCopyPreview; eligible: Candidate[] }> {
  let root: string;
  try {
    root = (await runGit(projectCwd, ["rev-parse", "--show-toplevel"], { timeoutMs: GIT_TIMEOUT_MS })).trim();
  } catch {
    throw new Error(`${projectCwd} is not a git checkout`);
  }
  const { repositoryUrl, remote } = await cloneRemote(root, runGit);
  // `matching` names the ignored path itself (a folder only when the folder
  // matched a pattern); NUL-separated, so no quoting.
  const status = await runGit(root, ["status", "--porcelain=v1", "-z", "--ignored=matching", "--untracked-files=all"], {
    timeoutMs: GIT_TIMEOUT_MS,
  });
  const skipped: ProjectCopySkip[] = [];
  const paths: string[] = [];
  for (const record of status.split("\0")) {
    if (!record.startsWith("!! ")) continue;
    const rel = record.slice(3);
    if (!rel.endsWith("/")) {
      paths.push(rel);
      continue;
    }
    const inner = folderFiles(root, rel);
    if (inner === null) skipped.push({ path: rel, reason: "folder-too-large", envName: null });
    else paths.push(...inner);
  }
  paths.sort();
  const eligible: Candidate[] = [];
  let total = 0;
  for (const rel of paths) {
    const abs = path.join(root, ...rel.split("/"));
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(abs);
    } catch {
      skipped.push({ path: rel, reason: "unreadable", envName: null });
      continue;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ path: rel, reason: "symlink", envName: null });
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.size > PROJECT_COPY_FILE_MAX_BYTES) {
      skipped.push({ path: rel, reason: "too-large", envName: null });
      continue;
    }
    let text: string;
    try {
      text = fs.readFileSync(abs, "utf8");
    } catch {
      skipped.push({ path: rel, reason: "unreadable", envName: null });
      continue;
    }
    const envName = projectCopyProviderKeyName(text);
    if (envName !== null) {
      skipped.push({ path: rel, reason: "provider-key", envName });
      continue;
    }
    if (eligible.length >= PROJECT_COPY_FILES_MAX) {
      skipped.push({ path: rel, reason: "too-many", envName: null });
      continue;
    }
    if (total + stat.size > PROJECT_COPY_TOTAL_MAX_BYTES) {
      skipped.push({ path: rel, reason: "over-total", envName: null });
      continue;
    }
    total += stat.size;
    eligible.push({ path: rel, bytes: stat.size, executable: (stat.mode & 0o111) !== 0 });
  }
  return {
    root,
    preview: { repositoryUrl, remote, files: eligible.map(({ path: p, bytes }) => ({ path: p, bytes })), skipped },
    eligible,
  };
}

/** What a Project copy of `projectCwd` would carry: names and sizes only. Rejects outside a git checkout. */
export async function previewProjectCopy(projectCwd: string, runGit: GitRunner = git): Promise<ProjectCopyPreview> {
  return (await scan(projectCwd, runGit)).preview;
}

/**
 * The chosen files' bytes for the member. The scan re-runs, so a file the
 * user picked that has since stopped being eligible (now names a Provider
 * key, grew past a cap, vanished) is reported as failed rather than sent, and
 * a name the scan never offered is refused the same way.
 */
export async function readProjectCopyFiles(projectCwd: string, picked: readonly string[], runGit: GitRunner = git): Promise<ProjectCopyRead> {
  const { root, preview, eligible } = await scan(projectCwd, runGit);
  const byPath = new Map(eligible.map((c) => [c.path, c]));
  const files: FleetProjectFileEntry[] = [];
  const failed: Array<{ path: string; reason: string }> = [];
  let total = 0;
  for (const rel of new Set(picked)) {
    const candidate = byPath.get(rel);
    if (candidate === undefined) {
      failed.push({ path: rel, reason: "no longer eligible to copy" });
      continue;
    }
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(path.join(root, ...rel.split("/")));
    } catch {
      failed.push({ path: rel, reason: "could not be read on this computer" });
      continue;
    }
    // The file can change between the scan and this read.
    if (bytes.length > PROJECT_COPY_FILE_MAX_BYTES || total + bytes.length > PROJECT_COPY_TOTAL_MAX_BYTES) {
      failed.push({ path: rel, reason: "grew past the size cap" });
      continue;
    }
    if (projectCopyProviderKeyName(bytes.toString("utf8")) !== null) {
      failed.push({ path: rel, reason: "now names a Provider key" });
      continue;
    }
    total += bytes.length;
    files.push({ path: rel, data: bytes.toString("base64"), executable: candidate.executable });
  }
  return { preview, files, failed };
}
