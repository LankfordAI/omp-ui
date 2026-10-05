// PROTOTYPE (#754): throwaway.
// Pure filesystem logic for the vault host tools. Imports only node builtins
// and nothing relative, so `node` loads it straight from bench-search.mjs.
import { spawn } from "node:child_process";
import type { Dirent } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** The control fields this module reads; structurally a subset of Proto754Control. */
export interface VaultFsControl {
  vaultPath: string;
  vaultId: string;
  vaultName: string;
  homeFolder: string;
  planGuard: boolean;
  searchDelayMs: number;
  searchBackend: "fs" | "cli";
  readImages: boolean;
}

export interface VaultImage {
  data: string;
  mimeType: string;
  bytes: number;
}

export interface VaultResult {
  ok: boolean;
  text: string;
  details: Record<string, unknown>;
  image?: VaultImage;
}

export interface WriteContext {
  project: string;
  session: string;
  appVersion: string;
  planEnabled: boolean;
}

export const OBSIDIAN_CLI = "/home/alankford/.local/bin/obsidian";
const SEARCH_LARGE_BYTES = 2 * 1024 * 1024;
const SEARCH_TEXT_CAP = 24_000;
const READ_TEXT_CAP = 60_000;
const IMAGE_CAP_BYTES = 1024 * 1024;
const TITLE_FORBIDDEN = /[/\\:*?"<>|#^[\]]/;
const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
};

function fail(text: string, details: Record<string, unknown> = {}): VaultResult {
  return { ok: false, text, details };
}

function noteTitle(rel: string): string {
  return path.posix.basename(rel).replace(/\.md$/i, "");
}

function localDate(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function isInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

type Resolved = { ok: true; abs: string; rel: string } | { ok: false; reason: string };

/**
 * Lexical checks first (absolute, `..`, dot segments), then realpath
 * confinement against the nearest existing ancestor, so a symlinked folder
 * cannot carry a write or read outside the vault.
 */
export async function resolveInVault(vaultPath: string, rel: string): Promise<Resolved> {
  if (rel.trim() === "") return { ok: false, reason: "empty path" };
  if (rel.startsWith("/") || rel.startsWith("\\") || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return { ok: false, reason: `absolute paths are refused: ${rel}` };
  }
  const segments = rel.split(/[/\\]/).filter((s) => s !== "");
  if (segments.some((s) => s === "..")) return { ok: false, reason: `".." segments are refused: ${rel}` };
  if (segments.some((s) => s.startsWith("."))) {
    return { ok: false, reason: `hidden segments (starting with ".") are refused: ${rel}` };
  }
  const root = await fs.realpath(vaultPath);
  const normalized = segments.join("/");
  const abs = path.join(root, ...segments);
  let probe = abs;
  for (;;) {
    try {
      const real = await fs.realpath(probe);
      if (!isInside(root, real)) return { ok: false, reason: `path leaves the vault: ${rel}` };
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return { ok: false, reason: `path leaves the vault: ${rel}` };
      probe = parent;
    }
  }
  return { ok: true, abs, rel: normalized };
}

export interface WalkEntry {
  abs: string;
  rel: string;
}

/** Recurses the vault, skipping dot entries and never following symlinks. Yields `*.md` unless `all`. */
export async function* walkNotes(root: string, options: { all?: boolean } = {}): AsyncGenerator<WalkEntry> {
  const stack: string[] = [""];
  while (stack.length > 0) {
    const relDir = stack.pop() as string;
    let entries: Dirent[];
    try {
      entries = await fs.readdir(path.join(root, relDir), { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    const subdirs: string[] = [];
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const rel = relDir === "" ? entry.name : `${relDir}/${entry.name}`;
      if (entry.isDirectory()) subdirs.push(rel);
      else if (entry.isFile() && (options.all === true || entry.name.toLowerCase().endsWith(".md"))) {
        yield { abs: path.join(root, rel), rel };
      }
    }
    for (let i = subdirs.length - 1; i >= 0; i--) stack.push(subdirs[i] as string);
  }
}

interface SearchHit {
  rel: string;
  title: string;
  score: number;
  snippets: string[];
}

async function mapLimit<T>(items: T[], limit: number, work: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++] as T;
      await work(item);
    }
  });
  await Promise.all(runners);
}

function snippetLine(lineNo: number, line: string): string {
  const trimmed = line.trim();
  return `L${lineNo}: ${trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed}`;
}

async function searchFs(control: VaultFsControl, terms: string[]) {
  const files: WalkEntry[] = [];
  for await (const entry of walkNotes(control.vaultPath)) files.push(entry);
  let scannedFiles = 0;
  let scannedBytes = 0;
  let skippedLarge = 0;
  const hits: SearchHit[] = [];
  await mapLimit(files, 64, async (file) => {
    let text: string;
    try {
      const stat = await fs.stat(file.abs);
      if (stat.size > SEARCH_LARGE_BYTES) {
        skippedLarge++;
        return;
      }
      text = await fs.readFile(file.abs, "utf8");
      scannedFiles++;
      scannedBytes += stat.size;
    } catch {
      return;
    }
    const title = noteTitle(file.rel);
    const titleLower = title.toLowerCase();
    const haystack = `${titleLower}\n${text.toLowerCase()}`;
    if (!terms.every((t) => haystack.includes(t))) return;
    let score = terms.every((t) => titleLower.includes(t)) ? 10 : 0;
    const snippets: string[] = [];
    const lines = text.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const lower = (lines[i] as string).toLowerCase();
      if (!terms.some((t) => lower.includes(t))) continue;
      score++;
      if (snippets.length < 3) snippets.push(snippetLine(i + 1, lines[i] as string));
    }
    hits.push({ rel: file.rel, title, score, snippets });
  });
  hits.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
  return { hits, scannedFiles, scannedBytes, skippedLarge };
}

type CliRun = { code: number | null; stdout: string; stderr: string };

function runCli(args: string[], timeoutMs: number): Promise<CliRun> {
  const { promise, resolve, reject } = Promise.withResolvers<CliRun>();
  const child = spawn(OBSIDIAN_CLI, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  const timer = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
  child.on("error", (error) => {
    clearTimeout(timer);
    reject(error);
  });
  child.on("close", (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
  return promise;
}

async function searchCli(control: VaultFsControl, query: string, limit: number) {
  const run = await runCli(
    [`vault=${control.vaultName}`, "search:context", `query=${query}`, `limit=${limit}`, "format=json"],
    30_000,
  );
  const out = run.stdout.trim();
  if (run.code !== 0 && out === "") {
    throw new Error(`obsidian CLI exited ${run.code}: ${run.stderr.trim() || "no output"}`);
  }
  if (out === "No matches found." || out === "") return { hits: [] as SearchHit[] };
  const parsed = JSON.parse(out) as Array<{ file: string; matches?: Array<{ line: number; text: string }> }>;
  const hits: SearchHit[] = parsed.map((entry) => ({
    rel: entry.file,
    title: noteTitle(entry.file),
    score: entry.matches?.length ?? 0,
    snippets: (entry.matches ?? []).slice(0, 3).map((m) => snippetLine(m.line, m.text)),
  }));
  return { hits };
}

export async function searchVault(control: VaultFsControl, query: unknown, limit: unknown): Promise<VaultResult> {
  const started = performance.now();
  if (typeof query !== "string") return fail("query must be a string");
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t !== "");
  if (terms.length === 0) return fail("query is empty");
  const cap = typeof limit === "number" && Number.isFinite(limit) ? Math.max(1, Math.min(50, Math.floor(limit))) : 10;
  if (control.searchDelayMs > 0) {
    const { promise, resolve } = Promise.withResolvers<void>();
    setTimeout(resolve, control.searchDelayMs);
    await promise;
  }
  const base = { vaultId: control.vaultId, vaultName: control.vaultName, backend: control.searchBackend, query };
  let hits: SearchHit[];
  let scannedFiles: number | null = null;
  let scannedBytes: number | null = null;
  let skippedLarge: number | null = null;
  if (control.searchBackend === "cli") {
    ({ hits } = await searchCli(control, query, cap));
  } else {
    ({ hits, scannedFiles, scannedBytes, skippedLarge } = await searchFs(control, terms));
  }
  const matchedFiles = hits.length;
  const returned = hits.slice(0, cap);
  let text = "";
  let shown = 0;
  let truncated = false;
  for (const hit of returned) {
    const entry = [`- [[${hit.title}]] \`${hit.rel}\``, ...hit.snippets.map((s) => `  ${s}`)].join("\n") + "\n";
    if (text.length + entry.length > SEARCH_TEXT_CAP) {
      truncated = true;
      break;
    }
    text += entry;
    shown++;
  }
  if (truncated) text += `… ${returned.length - shown} more notes; narrow the query or raise limit\n`;
  if (returned.length === 0) text = `No notes in vault ${control.vaultName} match "${query}".`;
  text = text.trimEnd();
  return {
    ok: true,
    text,
    details: {
      ...base,
      scannedFiles,
      scannedBytes,
      matchedFiles,
      returnedFiles: shown,
      truncated,
      skippedLarge,
      elapsedMs: Math.round(performance.now() - started),
      resultChars: text.length,
    },
  };
}

/** True when the note's leading frontmatter block carries `omp-ui: true`; read and append share it. */
function createdByOmpUi(text: string): boolean {
  const fm = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text);
  return fm !== null && /^omp-ui:\s*true\s*$/m.test(fm[1] as string);
}

async function exists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

/** Wikilink-style title resolution: shortest vault path whose basename matches case-insensitively, ties alphabetical. */
async function resolveTitle(vaultPath: string, title: string, options: { all?: boolean } = {}): Promise<WalkEntry | null> {
  const wanted = title.toLowerCase();
  let best: WalkEntry | null = null;
  for await (const entry of walkNotes(vaultPath, options)) {
    const base = options.all === true ? path.posix.basename(entry.rel) : noteTitle(entry.rel);
    if (base.toLowerCase() !== wanted) continue;
    if (
      best === null ||
      entry.rel.length < best.rel.length ||
      (entry.rel.length === best.rel.length && entry.rel < best.rel)
    ) {
      best = entry;
    }
  }
  return best;
}

export async function readNote(control: VaultFsControl, rawPath: unknown): Promise<VaultResult> {
  if (typeof rawPath !== "string" || rawPath.trim() === "") return fail("path must be a non-empty string");
  const input = rawPath.trim();
  const withExt = /\.md$/i.test(input) ? input : `${input}.md`;
  const resolved = await resolveInVault(control.vaultPath, withExt);
  if (!resolved.ok) return fail(resolved.reason);
  let abs = resolved.abs;
  let rel = resolved.rel;
  if (!(await exists(abs))) {
    if (input.includes("/")) return fail(`no note at ${rel} in vault ${control.vaultName}`);
    const byTitle = await resolveTitle(control.vaultPath, input.replace(/\.md$/i, ""));
    if (byTitle === null) return fail(`no note titled "${input}" in vault ${control.vaultName}`);
    abs = byTitle.abs;
    rel = byTitle.rel;
  }
  const real = await fs.realpath(abs);
  if (!isInside(await fs.realpath(control.vaultPath), real)) return fail(`path leaves the vault: ${rel}`);
  const stat = await fs.stat(real);
  const full = await fs.readFile(real, "utf8");
  const truncated = full.length > READ_TEXT_CAP;
  const text = truncated
    ? `${full.slice(0, READ_TEXT_CAP)}\n\n… truncated at ${READ_TEXT_CAP} of ${full.length} characters`
    : full;
  let image: VaultImage | undefined;
  if (control.readImages) {
    const embed = /!\[\[([^\]|#]+?\.(png|jpe?g|gif|webp))(?:[|#][^\]]*)?\]\]/i.exec(full);
    if (embed !== null) {
      const name = path.posix.basename((embed[1] as string).trim());
      const found = await resolveTitle(control.vaultPath, name, { all: true });
      if (found !== null) {
        const imgStat = await fs.stat(found.abs);
        if (imgStat.size <= IMAGE_CAP_BYTES) {
          const ext = (embed[2] as string).toLowerCase();
          const data = await fs.readFile(found.abs);
          image = { data: data.toString("base64"), mimeType: IMAGE_MIME[ext] ?? "image/png", bytes: data.length };
        }
      }
    }
  }
  return {
    ok: true,
    text,
    image,
    details: {
      vaultId: control.vaultId,
      vaultName: control.vaultName,
      path: rel,
      bytes: stat.size,
      mtimeMs: stat.mtimeMs,
      createdByOmpUi: createdByOmpUi(full),
      truncated,
      imageAttached: image !== undefined,
    },
  };
}

function stamp(ctx: WriteContext, tags: string[], date: string): string {
  const lines = [
    "---",
    "omp-ui: true",
    `project: ${JSON.stringify(ctx.project)}`,
    `session: ${JSON.stringify(ctx.session)}`,
    `date: ${date}`,
    `omp-ui-version: ${JSON.stringify(ctx.appVersion)}`,
  ];
  if (tags.length > 0) {
    lines.push("tags:");
    for (const tag of tags) lines.push(`  - ${JSON.stringify(tag)}`);
  }
  lines.push("---", "");
  return lines.join("\n");
}

export async function writeNote(control: VaultFsControl, ctx: WriteContext, args: unknown): Promise<VaultResult> {
  const started = performance.now();
  if (control.planGuard && ctx.planEnabled) {
    return fail("Plan mode is on in omp-ui: vault writes are refused until the session leaves Plan mode.", {
      vaultId: control.vaultId,
      vaultName: control.vaultName,
      planRefused: true,
    });
  }
  const record = args !== null && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const mode = record.mode;
  if (mode !== "create" && mode !== "append") return fail('mode must be "create" or "append"');
  if (typeof record.title !== "string") return fail("title must be a string");
  if (typeof record.content !== "string") return fail("content must be a string");
  const tags = Array.isArray(record.tags) ? record.tags.filter((t): t is string => typeof t === "string") : [];
  const title = record.title.trim();
  if (title.length < 1 || title.length > 120) return fail("title must be 1 to 120 characters");
  if (TITLE_FORBIDDEN.test(title)) return fail('title must not contain any of / \\ : * ? " < > | # ^ [ ]');
  if (title.startsWith(".")) return fail('title must not start with "."');

  const home = control.homeFolder.replace(/\/+$/, "");
  const homeResolved = await resolveInVault(control.vaultPath, home);
  if (!homeResolved.ok) return fail(homeResolved.reason);
  const noteRel = `${home}/${title}.md`;
  const noteResolved = await resolveInVault(control.vaultPath, noteRel);
  if (!noteResolved.ok) return fail(noteResolved.reason);
  const indexTitle = `${ctx.project} Index`;
  const indexRel = `${home}/${indexTitle}.md`;
  const date = localDate();
  const link = `[[${home}/${title}|${title}]]`;
  const common = { vaultId: control.vaultId, vaultName: control.vaultName, action: mode, title, path: noteRel };

  if (mode === "append") {
    if (!(await exists(noteResolved.abs))) {
      const elsewhere = await resolveTitle(control.vaultPath, title);
      if (elsewhere !== null) return fail(`omp-ui writes only under ${home}/; ${title} is at ${elsewhere.rel}`, common);
      return fail(`${noteRel} does not exist; use mode "create"`, common);
    }
    const before = await fs.readFile(noteResolved.abs, "utf8");
    const addition = `\n\n${record.content}`;
    await fs.appendFile(noteResolved.abs, addition, "utf8");
    const bytesWritten = Buffer.byteLength(addition, "utf8");
    return {
      ok: true,
      text: `Appended ${record.content.length} characters to ${noteRel} in vault ${control.vaultName}. Link to it as ${link}.`,
      details: {
        ...common,
        preview: record.content,
        createdByOmpUi: createdByOmpUi(before),
        indexPath: indexRel,
        indexUpdated: false,
        collisions: [],
        agentFrontmatterDropped: false,
        bytesWritten,
        elapsedMs: Math.round(performance.now() - started),
      },
    };
  }

  if (await exists(noteResolved.abs)) {
    return fail(`${noteRel} already exists; use mode "append" or another title`, common);
  }
  const collisions: string[] = [];
  const lowerTitle = title.toLowerCase();
  for await (const entry of walkNotes(control.vaultPath)) {
    if (entry.rel !== noteRel && noteTitle(entry.rel).toLowerCase() === lowerTitle) collisions.push(entry.rel);
  }
  let body = record.content;
  let agentFrontmatterDropped = false;
  const fm = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(body);
  if (fm !== null) {
    body = body.slice(fm[0].length).replace(/^\s*\n/, "");
    agentFrontmatterDropped = true;
  }
  await fs.mkdir(homeResolved.abs, { recursive: true });
  const note = `${stamp(ctx, tags, date)}${body.trimEnd()}\n\nIndex: [[${home}/${indexTitle}|${indexTitle}]]\n`;
  await fs.writeFile(noteResolved.abs, note, { encoding: "utf8", flag: "wx" });
  let bytesWritten = Buffer.byteLength(note, "utf8");

  const indexAbs = path.join(homeResolved.abs, `${indexTitle}.md`);
  let indexUpdated = false;
  let indexText: string;
  if (await exists(indexAbs)) {
    indexText = await fs.readFile(indexAbs, "utf8");
  } else {
    indexText = `${stamp(ctx, ["index"], date)}# ${indexTitle}\n`;
    await fs.writeFile(indexAbs, indexText, { encoding: "utf8", flag: "wx" });
    bytesWritten += Buffer.byteLength(indexText, "utf8");
  }
  if (!indexText.includes(link)) {
    const line = `${indexText.endsWith("\n") ? "" : "\n"}- ${link} (${date})\n`;
    await fs.appendFile(indexAbs, line, "utf8");
    bytesWritten += Buffer.byteLength(line, "utf8");
    indexUpdated = true;
  }
  let text = `Created ${noteRel} in vault ${control.vaultName}; linked from [[${home}/${indexTitle}]]. Link to it as ${link}.`;
  for (const other of collisions) text += ` A note named ${title} also exists at ${other}; link this one as ${link}.`;
  return {
    ok: true,
    text,
    details: {
      ...common,
      preview: note,
      createdByOmpUi: true,
      indexPath: indexRel,
      indexUpdated,
      collisions,
      agentFrontmatterDropped,
      bytesWritten,
      elapsedMs: Math.round(performance.now() - started),
    },
  };
}
