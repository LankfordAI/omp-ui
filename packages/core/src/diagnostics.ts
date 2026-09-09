import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { git } from "./git";
import type { GitRunner } from "./branches";
import { projectSlug } from "./paths";
import { advisorOverlayPath } from "./advisor-overlay";
import { advisorStatsExtensionPath } from "./advisor-stats-extension";
import { capabilitiesExtensionPath } from "./capabilities-extension";
import { compactionMethodOverlayPath } from "./compaction-overlay";
import { goalExtensionPath } from "./goal-extension";
import { mcpStatusExtensionPath } from "./mcp-status-extension";
import { modelOverlayPath } from "./model-overlay";
import { planExtensionPath } from "./plan-extension";
import { buildZip } from "./zip-writer";
import type { RegistrySettings } from "./registry";
import type {
  DiagnosticsExportResult,
  DiagnosticsPreview,
  DiagnosticsSection,
  OwnedSessionRecord,
  ProjectRecord,
} from "./types";

/** Everything about this machine/app that a bundle reports verbatim. */
export interface DiagnosticsFacts {
  appVersion: string;
  ompVersion: string | null;
  ompPath: string | null;
  electronVersion: string | null;
  nodeVersion: string;
  chromeVersion: string | null;
  packaged: boolean;
  packageFormat: string;
  platform: string;
  arch: string;
  osRelease: string;
  totalMemBytes: number;
  freeMemBytes: number;
  cpuModels: string[];
  sessionsRoot: string;
  archiveRoot: string;
  agentDir: string;
  registryFile: string;
  logDir: string;
  windowStateFile: string;
}

/** One in-memory breadcrumb ring entry (structurally the desktop ring's type). */
export interface DiagnosticsBreadcrumbEntry {
  at: string;
  seq: number;
  kind: string;
  tabId?: string;
  mode?: string;
  detail?: string;
}

export interface DiagnosticsOptions {
  facts: DiagnosticsFacts;
  /** Raw settings; the three remote-secret fields are scrubbed HERE, never by callers. */
  settings: RegistrySettings;
  projects: readonly ProjectRecord[];
  sessions: readonly OwnedSessionRecord[];
  liveTabIds: string[];
  includeTranscripts: boolean;
  /** null → <dirname(registryFile)>/diagnostics/omp-ui-diagnostics-<stamp>.zip */
  destinationPath: string | null;
  /** Current-run breadcrumb ring entries, newest last. */
  breadcrumbs?: readonly DiagnosticsBreadcrumbEntry[];
  gitRunner?: GitRunner;
  transcriptCapBytes?: number;
  /** Stamp + dos-timestamped zip entries. */
  now?: () => Date;
}

const DEFAULT_TRANSCRIPT_CAP_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 5_000;
const GIT_MAX_LINES = 2_000;

/** The rotated main-process logs beside the live ones (each ≤ 1 MiB by rotation). */
const LOG_FILES = [
  "main.log",
  "main.log.old",
  "fd-watchdog.log",
  "fd-watchdog.log.old",
  "breadcrumbs.log",
  "breadcrumbs.log.old",
] as const;

/** The 8 generated per-session files (5 extensions + 3 overlays). */
const GENERATED_FILE_SOURCES: ReadonlyArray<(lineageDir: string) => string> = [
  planExtensionPath,
  goalExtensionPath,
  capabilitiesExtensionPath,
  advisorStatsExtensionPath,
  mcpStatusExtensionPath,
  advisorOverlayPath,
  modelOverlayPath,
  compactionMethodOverlayPath,
];

/** One planned file: either a source path to copy, or bytes built in memory. */
interface PlannedFile {
  name: string;
  source: { kind: "copy"; abs: string } | { kind: "bytes"; data: Uint8Array };
  sizeBytes: number;
}
interface PlannedSection {
  id: DiagnosticsSection["id"];
  prefix: string;
  included: boolean;
  files: PlannedFile[];
}

function jsonBytes(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value, null, 2) + "\n");
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function stampOf(now: Date): string {
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}` +
    `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
  );
}

function statSize(abs: string): number | null {
  try {
    return fs.statSync(abs).size;
  } catch {
    return null;
  }
}

function copyFile(name: string, abs: string): PlannedFile {
  return { name, source: { kind: "copy", abs }, sizeBytes: statSize(abs) ?? 0 };
}

function bytesFile(name: string, value: unknown): PlannedFile {
  const data = jsonBytes(value);
  return { name, source: { kind: "bytes", data }, sizeBytes: data.length };
}

/** Settings exactly as persisted, minus every credential field, plus presence booleans. */
export function scrubSettings(settings: RegistrySettings): Record<string, unknown> {
  const {
    remoteToken,
    remotePasswordHash,
    remotePasswordSalt,
    ...rest
  } = settings as RegistrySettings & Record<string, unknown>;
  void remoteToken;
  void remotePasswordHash;
  void remotePasswordSalt;
  return {
    ...rest,
    hasRemoteToken: typeof settings.remoteToken === "string" && settings.remoteToken !== "",
    hasRemotePassword:
      typeof settings.remotePasswordHash === "string" && settings.remotePasswordHash !== "",
  };
}

/** One entry per distinct effective working tree: every project path plus every
 *  session's worktree-or-project path, deduped by path.resolve, registry order first. */
function effectiveTrees(
  projects: readonly ProjectRecord[],
  sessions: readonly OwnedSessionRecord[],
): string[] {
  const seen = new Set<string>();
  const trees: string[] = [];
  const add = (p: string): void => {
    const key = path.resolve(p);
    if (seen.has(key)) return;
    seen.add(key);
    trees.push(key);
  };
  for (const project of projects) add(project.path);
  for (const session of sessions) add(session.worktree?.path ?? session.projectCwd);
  return trees;
}

async function gitStatusSection(
  o: DiagnosticsOptions,
  warnings: string[],
): Promise<PlannedSection> {
  const runner = o.gitRunner ?? git;
  const files: PlannedFile[] = [];
  const trees = effectiveTrees(o.projects, o.sessions);
  for (const [index, tree] of trees.entries()) {
    let text: string;
    try {
      const stdout = await runner(tree, ["status", "--porcelain"], {
        timeoutMs: GIT_TIMEOUT_MS,
      });
      const lines = stdout.split("\n");
      text =
        lines.length > GIT_MAX_LINES
          ? `${lines.slice(0, GIT_MAX_LINES).join("\n")}\n[truncated]\n`
          : stdout;
    } catch (err) {
      warnings.push(`git status failed for ${tree}: ${errorText(err)}`);
      text = `[error] ${errorText(err)}\n`;
    }
    const data = new TextEncoder().encode(text);
    files.push({
      name: `${index}-${projectSlug(tree)}.txt`,
      source: { kind: "bytes", data },
      sizeBytes: data.length,
    });
  }
  return { id: "git", prefix: "git/", included: files.length > 0, files };
}

/** Top-level file names + sizes of one lineage dir; null when the dir can't be listed. */
function listLineageFiles(dir: string): Array<{ name: string; sizeBytes: number }> | null {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  const files: Array<{ name: string; sizeBytes: number }> = [];
  for (const name of names.sort()) {
    try {
      const st = fs.statSync(path.join(dir, name));
      if (st.isFile()) files.push({ name, sizeBytes: st.size });
    } catch {
      // Vanished mid-list — the file simply isn't reported.
    }
  }
  return files;
}

function transcriptFileNames(dir: string): string[] {
  try {
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".jsonl") || name.endsWith(".jsonl.gz"))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Shared by preview and collect: plan every section's files. In preview mode,
 * copied files are stat-only (never read); in collect mode the plan is
 * identical, and content materialises later. Every filesystem failure appends
 * a warning and degrades the section — this never throws for disk reasons.
 */
async function buildSections(
  o: DiagnosticsOptions,
  warnings: string[],
): Promise<PlannedSection[]> {
  const liveTabIds = new Set(o.liveTabIds);
  const sections: PlannedSection[] = [];

  const versions = bytesFile("versions.json", {
    appVersion: o.facts.appVersion,
    ompVersion: o.facts.ompVersion,
    ompPath: o.facts.ompPath,
    electronVersion: o.facts.electronVersion,
    nodeVersion: o.facts.nodeVersion,
    chromeVersion: o.facts.chromeVersion,
    packaged: o.facts.packaged,
    packageFormat: o.facts.packageFormat,
  });
  sections.push({ id: "versions", prefix: "", included: true, files: [versions] });

  const platform = bytesFile("platform.json", {
    platform: o.facts.platform,
    arch: o.facts.arch,
    osRelease: o.facts.osRelease,
    totalMemBytes: o.facts.totalMemBytes,
    freeMemBytes: o.facts.freeMemBytes,
    cpuModels: o.facts.cpuModels,
    homedir: os.homedir(),
    sessionsRoot: o.facts.sessionsRoot,
    archiveRoot: o.facts.archiveRoot,
    agentDir: o.facts.agentDir,
    registryFile: o.facts.registryFile,
    logDir: o.facts.logDir,
  });
  sections.push({ id: "platform", prefix: "", included: true, files: [platform] });

  sections.push({
    id: "settings",
    prefix: "",
    included: true,
    files: [bytesFile("settings.json", scrubSettings(o.settings))],
  });

  sections.push({
    id: "registry",
    prefix: "",
    included: true,
    files: [
      bytesFile("registry.json", { projects: o.projects, sessions: o.sessions }),
    ],
  });

  sections.push(await gitStatusSection(o, warnings));

  const activeRows: Array<{
    lineageDir: string;
    live: boolean;
    files: Array<{ name: string; sizeBytes: number }>;
  }> = [];
  const archivedRows: typeof activeRows = [];
  const missingRoots = new Set<string>();
  const reportRoot = (root: string): void => {
    if (missingRoots.has(root)) return;
    missingRoots.add(root);
    warnings.push(`sessions root not listable: ${root}`);
  };
  // Per session: the active root wins over the archive root (archive moves
  // dirs, never copies), and a session absent from BOTH roots while it has a
  // materialized sessionId is a real anomaly — everything else is normal
  // (never-materialized sessions, sessions whose dir lives in the other root).
  for (const session of o.sessions) {
    const activeFiles = listLineageFiles(path.join(o.facts.sessionsRoot, session.lineageDir));
    if (activeFiles === null && !fs.existsSync(o.facts.sessionsRoot)) {
      reportRoot(o.facts.sessionsRoot);
    }
    let files = activeFiles;
    if (files === null) {
      files = listLineageFiles(path.join(o.facts.archiveRoot, session.lineageDir));
      if (files === null) {
        if (!fs.existsSync(o.facts.archiveRoot)) reportRoot(o.facts.archiveRoot);
        if (session.sessionId !== null) {
          warnings.push(`lineage dir missing in both roots: ${session.lineageDir}`);
        }
        continue;
      }
    }
    (activeFiles === null ? archivedRows : activeRows).push({
      lineageDir: session.lineageDir,
      live: liveTabIds.has(session.tabId),
      files,
    });
  }
  const lineages = bytesFile("lineages.json", [...activeRows, ...archivedRows]);
  sections.push({
    id: "lineages",
    prefix: "",
    included: true,
    files: [lineages],
  });

  const extensionFiles: PlannedFile[] = [];
  for (const session of o.sessions) {
    if (!liveTabIds.has(session.tabId)) continue;
    const dir = path.join(o.facts.sessionsRoot, session.lineageDir);
    for (const source of GENERATED_FILE_SOURCES) {
      const abs = source(dir);
      const size = statSize(abs);
      if (size === null) continue; // Missing generated files are silently skipped.
      extensionFiles.push({
        name: `${session.tabId}/${path.basename(abs)}`,
        source: { kind: "copy", abs },
        sizeBytes: size,
      });
    }
  }
  sections.push({
    id: "extensions",
    prefix: "extensions/",
    included: extensionFiles.length > 0,
    files: extensionFiles,
  });

  const logFiles: PlannedFile[] = [];
  let logDirMissing = true;
  for (const name of LOG_FILES) {
    const abs = path.join(o.facts.logDir, name);
    if (statSize(abs) === null) continue;
    logDirMissing = false;
    logFiles.push(copyFile(name, abs));
  }
  if (logDirMissing && !fs.existsSync(o.facts.logDir)) {
    warnings.push(`log dir missing: ${o.facts.logDir}`);
  }
  sections.push({ id: "logs", prefix: "logs/", included: logFiles.length > 0, files: logFiles });

  const breadcrumbs = bytesFile("breadcrumbs.json", [...(o.breadcrumbs ?? [])]);
  sections.push({ id: "breadcrumbs", prefix: "", included: true, files: [breadcrumbs] });

  const windowState: PlannedFile[] = [];
  const wsSize = statSize(o.facts.windowStateFile);
  if (wsSize !== null) windowState.push(copyFile("window-state.json", o.facts.windowStateFile));
  sections.push({
    id: "window-state",
    prefix: "",
    included: windowState.length > 0,
    files: windowState,
  });

  const transcriptFiles: PlannedFile[] = [];
  if (o.includeTranscripts) {
    const cap = o.transcriptCapBytes ?? DEFAULT_TRANSCRIPT_CAP_BYTES;
    let running = 0;
    let capped = false;
    for (const root of [o.facts.sessionsRoot, o.facts.archiveRoot]) {
      for (const session of o.sessions) {
        const dir = path.join(root, session.lineageDir);
        for (const name of transcriptFileNames(dir)) {
          const abs = path.join(dir, name);
          const size = statSize(abs);
          if (size === null) continue;
          if (running > cap) {
            if (!capped) {
              warnings.push(
                `transcripts skipped past cap of ${cap} bytes`,
              );
              capped = true;
            }
            continue;
          }
          running += size;
          transcriptFiles.push({
            name: `${session.lineageDir}/${name}`,
            source: { kind: "copy", abs },
            sizeBytes: size,
          });
        }
      }
    }
  }
  sections.push({
    id: "transcripts",
    prefix: "transcripts/",
    included: transcriptFiles.length > 0,
    files: transcriptFiles,
  });

  return sections;
}

function toSection(planned: PlannedSection): DiagnosticsSection {
  return {
    id: planned.id,
    prefix: planned.prefix,
    included: planned.included,
    files: planned.files.map((f) => ({ name: f.name, sizeBytes: f.sizeBytes })),
    totalBytes: planned.files.reduce((sum, f) => sum + f.sizeBytes, 0),
  };
}

function manifestBytes(
  o: DiagnosticsOptions,
  now: Date,
  sections: DiagnosticsSection[],
  warnings: string[],
): Uint8Array {
  return jsonBytes({
    generatedAt: now.toISOString(),
    appVersion: o.facts.appVersion,
    ompVersion: o.facts.ompVersion,
    electronVersion: o.facts.electronVersion,
    includeTranscripts: o.includeTranscripts,
    sections,
    redaction: [
      "provider-keys.json and all key material are never read",
      "remote-instances.json (joined-instance credentials) is never read",
      "remoteToken/remotePasswordHash/remotePasswordSalt replaced by hasRemoteToken/hasRemotePassword booleans",
      "<userData>/oauth-login/ is never walked",
      "plan bodies, transcripts (unless opted in), and project file contents are excluded",
    ],
    warnings,
  });
}

/** Manifest for the export dialog: sections + sizes; no file bodies are read. */
export async function previewDiagnosticsBundle(
  o: DiagnosticsOptions,
): Promise<DiagnosticsPreview> {
  const warnings: string[] = [];
  const planned = await buildSections(o, warnings);
  const sections = planned.map(toSection);
  // The manifest row describes the OTHER sections; its own body never lists
  // itself, so the byte count is computable without a fixed point.
  const manifest = manifestBytes(o, (o.now ?? (() => new Date()))(), sections, warnings);
  sections.unshift({
    id: "manifest",
    prefix: "",
    included: true,
    files: [{ name: "manifest.json", sizeBytes: manifest.length }],
    totalBytes: manifest.length,
  });
  return {
    sections,
    totalBytes: sections.reduce((sum, s) => sum + s.totalBytes, 0),
    warnings,
  };
}

function resolveDestination(o: DiagnosticsOptions, now: Date): string {
  if (o.destinationPath !== null) {
    const p = o.destinationPath;
    if (typeof p !== "string" || p === "" || p.includes("\0") || !path.isAbsolute(p)) {
      throw new Error("invalid destination path");
    }
    return path.resolve(p);
  }
  return path.join(
    path.dirname(o.facts.registryFile),
    "diagnostics",
    `omp-ui-diagnostics-${stampOf(now)}.zip`,
  );
}

/** Builds the zip and writes it atomically; rejects only for a bad destination or a failed final write. */
export async function collectDiagnosticsBundle(
  o: DiagnosticsOptions,
): Promise<DiagnosticsExportResult> {
  const now = (o.now ?? (() => new Date()))();
  const destination = resolveDestination(o, now);
  const warnings: string[] = [];
  const planned = await buildSections(o, warnings);

  const entries: Array<{ name: string; data: Uint8Array }> = [];
  const sections: DiagnosticsSection[] = [];
  for (const section of planned) {
    const files: DiagnosticsSection["files"] = [];
    let totalBytes = 0;
    for (const file of section.files) {
      let data: Uint8Array;
      if (file.source.kind === "bytes") {
        data = file.source.data;
      } else {
        try {
          data = new Uint8Array(await fs.promises.readFile(file.source.abs));
        } catch (err) {
          warnings.push(`read failed for ${file.source.abs}: ${errorText(err)}`);
          continue;
        }
      }
      entries.push({ name: section.prefix + file.name, data });
      files.push({ name: file.name, sizeBytes: data.length });
      totalBytes += data.length;
    }
    sections.push({
      id: section.id,
      prefix: section.prefix,
      included: section.included && files.length > 0,
      files,
      totalBytes,
    });
  }

  const manifest = manifestBytes(o, now, sections, warnings);
  entries.unshift({ name: "manifest.json", data: manifest });

  const zip = await buildZip(entries, now);

  const destDir = path.dirname(destination);
  await fs.promises.mkdir(destDir, { recursive: true });
  const tmp = path.join(destDir, `.${path.basename(destination)}.tmp-${crypto.randomUUID()}`);
  try {
    await fs.promises.writeFile(tmp, zip);
    await fs.promises.rename(tmp, destination);
  } catch (err) {
    await fs.promises.rm(tmp, { force: true }).catch(() => undefined);
    throw new Error(`failed to write ${destination}: ${errorText(err)}`, { cause: err });
  }
  return { path: destination, totalBytes: zip.length, warnings };
}
