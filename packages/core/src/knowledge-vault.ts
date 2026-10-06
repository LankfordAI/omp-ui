import * as fs from "node:fs/promises";
import * as syncFs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import * as yaml from "js-yaml";
import { isWithin } from "./worktree";
import { writeTextAtomic } from "./atomic-write";
import { lineDiff } from "./line-diff";
import type { VaultRegistryEntry } from "./types";
import { obsidianReplyLink, type VaultAction, type VaultToolDetails } from "./vault-shared";
import { scanSecrets } from "./vault-secret-shapes";
export { scanSecrets } from "./vault-secret-shapes";

/** The roots a vault may never be, or sit inside (#758, U1). */
export interface RootGuard { home: string; userData: string; agentDir: string; sessionsRoot: string; archiveRoot: string }
export type VaultRootCheck =
  | { ok: true; real: string }
  | { ok: false; code: "unreachable" | "refused"; reason: string };

async function realOrResolved(p: string): Promise<string> {
  try { return await fs.realpath(p); } catch { return path.resolve(p); }
}
const insideOrEqual = (root: string, candidate: string): boolean => candidate === root || isWithin(root, candidate);

/** Rechecked for every operation. A missing .obsidian/ is fine. */
export async function validateVaultRoot(absPath: string, guard: RootGuard): Promise<VaultRootCheck> {
  let real: string;
  try {
    real = await fs.realpath(absPath);
    if (!(await fs.stat(real)).isDirectory()) return { ok: false, code: "unreachable", reason: "vault folder is unreachable" };
  } catch { return { ok: false, code: "unreachable", reason: "vault folder is unreachable" }; }
  const refuse = (what: string): VaultRootCheck =>
    ({ ok: false, code: "refused", reason: `omp-ui cannot use ${real} as a vault: it is ${what}` });
  if (real === (await realOrResolved(guard.home))) return refuse("your home directory");
  if (path.parse(real).root === real) return refuse("the filesystem root");
  const roots: Array<[string, string]> = [
    ["inside omp-ui's data folder", guard.userData],
    ["inside omp's agent folder", guard.agentDir],
    ["inside omp's sessions folder", guard.sessionsRoot],
    ["inside omp's session archive", guard.archiveRoot],
  ];
  for (const [what, root] of roots) {
    if (insideOrEqual(await realOrResolved(root), real)) return refuse(what);
  }
  return { ok: true, real };
}

type Resolved = { ok: true; abs: string; rel: string } | { ok: false; reason: string };
function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code : "filesystem error";
}
function lexicalPath(rel: string): { ok: true; segments: string[]; rel: string } | { ok: false; reason: string } {
  if (rel.trim() === "") return { ok: false, reason: "empty path" };
  if (/^[/\\]/.test(rel) || path.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    return { ok: false, reason: `absolute paths are refused: ${rel}` };
  }
  const segments = rel.split(/[/\\]/).filter((s) => s !== "");
  if (segments.some((s) => s === "..")) return { ok: false, reason: `".." segments are refused: ${rel}` };
  if (segments.some((s) => s.startsWith("."))) return { ok: false, reason: `hidden segments (starting with ".") are refused: ${rel}` };
  if (segments.some((s) => s.includes("\0"))) return { ok: false, reason: "path contains a null character" };
  return { ok: true, segments, rel: segments.join("/") };
}

/**
 * Nearest existing ancestor plus its unresolved suffix, not just the ancestor.
 * Every realpath here is the native one, as fs.promises.realpath is: the JS
 * realpathSync keeps Windows 8.3 short names (RUNNER~1), so a long root would
 * never contain a short candidate (#773).
 */
function prospectiveReal(abs: string): string {
  try { return syncFs.realpathSync.native(abs); }
  catch (error) {
    if (errorCode(error) !== "ENOENT") throw error;
    // A dangling symlink is not a missing destination that we may create.
    try { syncFs.lstatSync(abs); throw new Error("dangling symlink", { cause: error }); }
    catch (leafError) { if (errorCode(leafError) !== "ENOENT") throw leafError; }
    const parent = path.dirname(abs);
    if (parent === abs) throw error;
    const parentReal = prospectiveReal(parent);
    // Windows reports a path through a file as ENOENT, not ENOTDIR; a file is never a missing ancestor.
    const parentStat = syncFs.statSync(parentReal, { throwIfNoEntry: false });
    if (parentStat !== undefined && !parentStat.isDirectory()) throw Object.assign(new Error("not a directory"), { code: "ENOTDIR" });
    return path.join(parentReal, path.basename(abs));
  }
}
function resolveSync(rootReal: string, rel: string): Resolved {
  const lexical = lexicalPath(rel);
  if (!lexical.ok) return lexical;
  let root: string;
  try { root = syncFs.realpathSync.native(rootReal); }
  catch { return { ok: false, reason: "vault folder is unreachable" }; }
  try {
    // Check every alias prefix, so an intermediate hidden real target cannot
    // disappear again through a second symlink later in the path.
    for (let i = 1; i <= lexical.segments.length; i++) {
      const real = prospectiveReal(path.join(root, ...lexical.segments.slice(0, i)));
      if (!insideOrEqual(root, real)) return { ok: false, reason: `path leaves the vault: ${rel}` };
      if (path.relative(root, real).split(path.sep).some((segment) => segment.startsWith("."))) return { ok: false, reason: `hidden real targets are refused: ${rel}` };
    }
    return { ok: true, abs: path.join(root, ...lexical.segments), rel: lexical.rel };
  } catch (error) {
    return { ok: false, reason: `cannot resolve ${lexical.rel}: ${errorCode(error)}` };
  }
}

/** Explicit paths can follow confined, nonhidden aliases; missing ancestors are ENOENT only. */
export async function resolveVaultPath(rootReal: string, rel: string): Promise<Resolved> {
  return resolveSync(rootReal, rel);
}

export interface VaultCallContext {
  entry: VaultRegistryEntry;
  obsidianId: string | null;
  projectFolder: string | null;
  projectName: string | null;
  lineage: string;
  appVersion: string;
  now: () => Date;
  guard: RootGuard;
}
export interface VaultOutcome {
  ok: boolean;
  text: string;
  details: VaultToolDetails;
  image?: { data: string; mimeType: string };
}
export const SEARCH_TEXT_CAP = 24_000;
export const NOTE_BYTE_CAP = 2 * 1024 * 1024;
const IMAGE_BYTE_CAP = 1024 * 1024;
const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};
const FRONTMATTER_REFUSAL = "omp-ui writes the frontmatter; send the body only";
const ILLEGAL_TITLE = 'title must not contain / \\ : * ? " < > | # ^ [ ], start with a dot, or be a reserved Windows name';
const SMALL_TITLE_WORDS: Readonly<Record<string, true>> = { a: true, an: true, and: true, as: true, at: true, but: true, by: true, for: true, in: true, of: true, on: true, or: true, the: true, to: true, vs: true, via: true };

export function normalizeTitle(raw: string): { ok: true; title: string } | { ok: false; reason: string } {
  const title = raw.trim().replace(/\s+/g, " ");
  if (title.length < 1 || title.length > 120) return { ok: false, reason: "title must be 1-to-120 characters" };
  if (/[/\\:*?"<>|#^[\]]/.test(title) || title.startsWith(".") || title.endsWith(".") || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(title)) {
    return { ok: false, reason: ILLEGAL_TITLE };
  }
  return { ok: true, title: title.split(" ").map((word, i) => /^[a-z]+$/.test(word) && (i === 0 || SMALL_TITLE_WORDS[word] !== true) ? word[0]!.toUpperCase() + word.slice(1) : word).join(" ") };
}
function titleOf(rel: string): string { return path.posix.basename(rel).replace(/\.md$/i, ""); }
function hash(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function splitFrontmatter(text: string): { prefix: string; yaml: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)^---[ \t]*(?:\r?\n|$)/m.exec(text);
  if (match?.index !== 0) return { prefix: "", yaml: "", body: text };
  return { prefix: match[0], yaml: match[1]!, body: text.slice(match[0].length) };
}
function ownership(text: string): boolean { return /^omp-ui: true\r?$/m.test(splitFrontmatter(text).yaml); }
function hasFrontmatter(text: string): boolean { return /^\s*---(?:\r?\n|$)/.test(text); }
function details(ctx: VaultCallContext, action: VaultAction, rel: string | null): VaultToolDetails {
  return { vaultName: ctx.entry.name, vaultId: ctx.obsidianId, path: rel, action, createdByOmpUi: null };
}
function fail(ctx: VaultCallContext, action: VaultAction, rel: string | null, reason: string): VaultOutcome {
  return { ok: false, text: `Vault ${ctx.entry.name}${rel === null ? "" : ` · ${rel}`}\n\n${reason}`, details: details(ctx, action, rel) };
}
function resultPath(raw: string): string | null {
  const checked = lexicalPath(withExtension(raw));
  return checked.ok ? checked.rel : null;
}
async function operation(ctx: VaultCallContext, action: VaultAction, work: (root: string) => Promise<VaultOutcome> | VaultOutcome): Promise<VaultOutcome> {
  const root = await validateVaultRoot(ctx.entry.path, ctx.guard);
  if (!root.ok) {
    const reason = root.code === "unreachable" ? `vault ${ctx.entry.name} is unreachable` : `omp-ui cannot use this vault: it is ${root.reason.split(": it is ")[1] ?? "a protected folder"}`;
    return fail(ctx, action, null, reason);
  }
  try { return await work(root.real); }
  catch (error) { return fail(ctx, action, null, `omp-ui could not complete the vault call (${errorCode(error)})`); }
}
function withExtension(raw: string): string {
  const rel = raw.trim();
  return path.posix.extname(rel.replace(/\\/g, "/")) === "" ? `${rel}.md` : rel;
}
function statOrMissing(abs: string): syncFs.Stats | null {
  try { return syncFs.statSync(abs); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
}
interface WalkEntry { rel: string }
/** Sorted prototype traversal, with no dot entries or symlinks at any depth. */
function walkNotes(root: string, folder = "", images = false): WalkEntry[] {
  const found: WalkEntry[] = [];
  const walk = (dir: string): void => {
    if (dir !== "") {
      const checked = resolveSync(root, dir);
      if (!checked.ok || syncFs.lstatSync(checked.abs).isSymbolicLink()) return;
    }
    const entries = syncFs.readdirSync(path.join(root, dir), { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        try { walk(rel); } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      } else if (entry.isFile() && (/\.md$/i.test(entry.name) || (images && IMAGE_MIME[path.extname(entry.name).toLowerCase()] !== undefined))) {
        found.push({ rel });
      }
    }
  };
  walk(folder);
  return found.sort((a, b) => a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0);
}
function titleMatches(root: string, wanted: string, images = false): WalkEntry[] {
  const lower = wanted.toLowerCase();
  return walkNotes(root, "", images).filter((file) => (images ? path.posix.basename(file.rel) : titleOf(file.rel)).toLowerCase() === lower)
    .sort((a, b) => a.rel.length - b.rel.length || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
}
function resolveExisting(root: string, raw: string, fallback: boolean, images = false): Resolved {
  const input = raw.trim();
  const checked = resolveSync(root, withExtension(input));
  if (!checked.ok) return checked;
  if (statOrMissing(checked.abs) !== null) return checked;
  if (fallback && !/[/\\]/.test(input)) {
    const image = images && IMAGE_MIME[path.extname(input).toLowerCase()] !== undefined;
    const match = titleMatches(root, image ? input : input.replace(/\.md$/i, ""), image)[0];
    if (match !== undefined) return resolveSync(root, match.rel);
  }
  return { ok: false, reason: `note not found: ${checked.rel}` };
}
function regularMarkdown(root: string, raw: string): Resolved {
  const checked = resolveExisting(root, raw, false);
  if (!checked.ok) return checked;
  if (!/\.md$/i.test(checked.rel) || !syncFs.statSync(checked.abs).isFile()) return { ok: false, reason: `existing markdown note required: ${checked.rel}` };
  return checked;
}
function writePath(ctx: VaultCallContext, root: string, rel: string, create: boolean): Resolved {
  const checked = resolveSync(root, rel);
  if (!checked.ok) return checked;
  if (!create && ctx.entry.allowWritesOutsideHome) return checked;
  const home = ctx.entry.homeFolder.replace(/\/$/, "");
  const homeResolved = resolveSync(root, home);
  if (!homeResolved.ok) return homeResolved;
  const outside = (): Resolved => ({ ok: false, reason: `omp-ui writes only inside ${ctx.entry.homeFolder} in vault ${ctx.entry.name}; ${checked.rel} is outside it` });
  if (checked.rel !== home && !checked.rel.startsWith(`${home}/`)) return outside();
  const homeReal = prospectiveReal(homeResolved.abs);
  // A home alias to a sibling must not turn that sibling into the write home.
  if (!insideOrEqual(homeResolved.abs, homeReal) || !insideOrEqual(homeReal, prospectiveReal(checked.abs))) return outside();
  return checked;
}
function contentRefusal(text: string): string | null {
  const shape = scanSecrets(text);
  if (shape !== null) return `refused: the text matches the ${shape} secret shape; omp-ui never writes keys or tokens to a vault`;
  return null;
}
function sizeRefusal(textOrBytes: string | number): string | null {
  const bytes = typeof textOrBytes === "number" ? textOrBytes : Buffer.byteLength(textOrBytes, "utf8");
  return bytes > NOTE_BYTE_CAP ? `the resulting note would exceed ${NOTE_BYTE_CAP} UTF-8 bytes (2 MiB)` : null;
}
function appended(before: string, addition: string): string {
  return `${before.endsWith("\n") ? "" : "\n"}\n${addition.trimEnd()}\n`;
}
function writeExclusive(abs: string, text: string): void {
  const fd = syncFs.openSync(abs, "wx");
  try { syncFs.writeFileSync(fd, text, "utf8"); } finally { syncFs.closeSync(fd); }
}
function boundedRows(header: (count: number) => string, rows: string[], total: number): { text: string; count: number } {
  let count = 0;
  let body = "";
  const tail = (n: number): string => n < total ? `\n\n… truncated; showing ${n} of ${total} notes.` : "";
  for (const row of rows) {
    const next = body + `\n${row}`;
    if (header(count + 1).length + next.length + tail(count + 1).length > SEARCH_TEXT_CAP) break;
    count++;
    body = next;
  }
  return { text: header(count) + body + tail(count), count };
}
function yamlValues(source: string): string {
  try {
    const value: unknown = yaml.load(source, { schema: yaml.FAILSAFE_SCHEMA });
    const seen = new Set<object>();
    const values: string[] = [];
    const visit = (item: unknown): void => {
      if (typeof item === "string" || typeof item === "number" || typeof item === "boolean") values.push(String(item));
      else if (item !== null && typeof item === "object" && !seen.has(item)) {
        seen.add(item);
        for (const child of Object.values(item)) visit(child);
      }
    };
    visit(value);
    return values.join("\n");
  } catch { return ""; }
}

export async function vaultSearch(ctx: VaultCallContext, query: string, limit: number | undefined): Promise<VaultOutcome> {
  return operation(ctx, "search", async (root) => {
    if (typeof query !== "string" || query.trim() === "") return fail(ctx, "search", null, "query must be a nonblank string");
    if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 50)) return fail(ctx, "search", null, "limit must be an integer from 1 to 50");
    const terms = query.trim().toLowerCase().split(/\s+/);
    const files = walkNotes(root);
    const hits: Array<{ rel: string; title: string; score: number; snippets: string[] }> = [];
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(64, files.length) }, async () => {
      while (next < files.length) {
        const file = files[next++]!;
        try {
          const checked = resolveSync(root, file.rel);
          if (!checked.ok || syncFs.lstatSync(checked.abs).isSymbolicLink() || syncFs.statSync(checked.abs).size > NOTE_BYTE_CAP) continue;
          const bytes = await fs.readFile(checked.abs);
          if (bytes.length > NOTE_BYTE_CAP) continue;
          const full = bytes.toString("utf8");
          const split = splitFrontmatter(full);
          const title = titleOf(file.rel);
          const haystack = `${title}\n${split.body}\n${yamlValues(split.yaml)}`.toLowerCase();
          if (!terms.every((term) => haystack.includes(term))) continue;
          let score = terms.every((term) => title.toLowerCase().includes(term)) ? 10 : 0;
          const snippets: string[] = [];
          const offset = split.prefix.split("\n").length - 1;
          const lines = split.body.split("\n");
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i]!;
            if (!terms.some((term) => line.toLowerCase().includes(term))) continue;
            score++;
            if (snippets.length < 3) {
              const trimmed = line.trim();
              snippets.push(`  L${offset + i + 1}: ${trimmed.slice(0, 200)}${trimmed.length > 200 ? "…" : ""}`);
            }
          }
          hits.push({ rel: file.rel, title, score, snippets });
        } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      }
    }));
    hits.sort((a, b) => b.score - a.score || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0));
    const shownQuery = query.length > SEARCH_TEXT_CAP - 500 ? `${query.slice(0, SEARCH_TEXT_CAP - 501)}…` : query;
    const rows = hits.slice(0, limit ?? 10).map((hit) => `- ${obsidianReplyLink(ctx.entry.name, hit.rel, hit.title)} · \`${hit.rel}\`${hit.snippets.length ? `\n${hit.snippets.join("\n")}` : ""}`);
    const rendered = boundedRows((count) => `Vault ${ctx.entry.name}: ${hits.length} notes match "${shownQuery}" (showing ${count}).`, rows, hits.length);
    return { ok: true, text: rendered.text, details: { ...details(ctx, "search", null), matchedFiles: hits.length, returnedFiles: rendered.count, truncated: rendered.count < hits.length } };
  });
}

export async function vaultRead(ctx: VaultCallContext, rawPath: string): Promise<VaultOutcome> {
  return operation(ctx, "read", (root) => {
    if (typeof rawPath !== "string" || rawPath.trim() === "") return fail(ctx, "read", null, "path must be a nonblank string");
    const checked = resolveExisting(root, rawPath, true, true);
    if (!checked.ok) return fail(ctx, "read", resultPath(rawPath), checked.reason);
    const again = resolveSync(root, checked.rel);
    if (!again.ok) return fail(ctx, "read", checked.rel, again.reason);
    const stat = syncFs.statSync(again.abs);
    if (!stat.isFile()) return fail(ctx, "read", checked.rel, `regular file required: ${checked.rel}`);
    const ext = path.extname(checked.rel).toLowerCase();
    if (ext !== ".md" && IMAGE_MIME[ext] === undefined) return fail(ctx, "read", checked.rel, `unsupported file type: ${checked.rel}`);
    if (ext !== ".md" && stat.size > IMAGE_BYTE_CAP) return fail(ctx, "read", checked.rel, "images must be at most 1 MiB");
    const bytes = syncFs.readFileSync(again.abs);
    const baseHash = hash(bytes);
    const header = `Vault ${ctx.entry.name} · ${checked.rel} · baseHash ${baseHash}`;
    const common = { ...details(ctx, "read", checked.rel), title: titleOf(checked.rel), baseHash };
    if (ext !== ".md") {
      if (bytes.length > IMAGE_BYTE_CAP) return fail(ctx, "read", checked.rel, "images must be at most 1 MiB");
      return { ok: true, text: header, details: common, image: { data: bytes.toString("base64"), mimeType: IMAGE_MIME[ext]! } };
    }
    const text = bytes.toString("utf8");
    return { ok: true, text: `${header}\nReply link: ${obsidianReplyLink(ctx.entry.name, checked.rel, titleOf(checked.rel))}\n\n${text}`, details: { ...common, createdByOmpUi: ownership(text) } };
  });
}

export async function vaultList(ctx: VaultCallContext, folder: string | undefined): Promise<VaultOutcome> {
  return operation(ctx, "list", (root) => {
    if (folder !== undefined && typeof folder !== "string") return fail(ctx, "list", null, "folder must be a string");
    const checked = resolveSync(root, (folder ?? ctx.entry.homeFolder).trim());
    if (!checked.ok) return fail(ctx, "list", null, checked.reason);
    if (statOrMissing(checked.abs)?.isDirectory() !== true) return fail(ctx, "list", checked.rel, `folder not found: ${checked.rel}`);
    const files = walkNotes(root, checked.rel);
    const rows = files.map((file) => `- ${obsidianReplyLink(ctx.entry.name, file.rel, titleOf(file.rel))} · \`${file.rel}\``);
    const rendered = boundedRows(() => `Vault ${ctx.entry.name} · ${checked.rel}: ${files.length} notes`, rows, files.length);
    return { ok: true, text: rendered.text, details: { ...details(ctx, "list", checked.rel), matchedFiles: files.length, returnedFiles: rendered.count, truncated: rendered.count < files.length } };
  });
}
function stamp(ctx: VaultCallContext, tags: string[], now: Date): string {
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const lines = ["---", "omp-ui: true"];
  if (ctx.projectFolder !== null && ctx.projectName !== null) lines.push(`project: ${JSON.stringify(ctx.projectName)}`);
  lines.push(`lineage: ${JSON.stringify(ctx.lineage.slice(-36))}`, `date: ${date}`, `tool: ${JSON.stringify(`omp-ui ${ctx.appVersion}`)}`);
  const nonempty = tags.filter((tag) => tag.trim() !== "");
  if (nonempty.length > 0) lines.push("tags:", ...nonempty.map((tag) => `  - ${JSON.stringify(tag)}`));
  return [...lines, "---", ""].join("\n");
}
function stripTitleHeading(body: string, title: string): string {
  const lines = body.split(/\r?\n/);
  const first = lines.findIndex((line) => line.trim() !== "");
  if (first >= 0 && lines[first]!.trim().toLowerCase() === `# ${title}`.toLowerCase()) {
    lines.splice(first, 1);
    return lines.join("\n");
  }
  return body;
}
function windowsPathRefusal(abs: string, rel: string): string | null {
  return process.platform === "win32" && abs.length > 259 ? `the note path would be longer than Windows allows (260 characters): ${rel}` : null;
}
function existingRefusal(rel: string): string { return `note exists: ${rel}; use omp-ui_vault_append or omp-ui_vault_edit, or pick another title`; }

export async function vaultCreate(ctx: VaultCallContext, args: { title: string; body: string; tags?: string[] }): Promise<VaultOutcome> {
  return operation(ctx, "create", (root) => {
    if (typeof args.title !== "string" || typeof args.body !== "string" || (args.tags !== undefined && (!Array.isArray(args.tags) || !args.tags.every((tag) => typeof tag === "string")))) return fail(ctx, "create", null, "create requires title and body strings and optional string tags");
    const normalized = normalizeTitle(args.title);
    if (!normalized.ok) return fail(ctx, "create", null, normalized.reason);
    const title = normalized.title;
    const folder = `${ctx.entry.homeFolder}${ctx.projectFolder === null ? "" : `${ctx.projectFolder}/`}`;
    const rel = `${folder}${title}.md`;
    const note = writePath(ctx, root, rel, true);
    if (!note.ok) return fail(ctx, "create", rel, note.reason);
    const indexRel = ctx.projectFolder === null ? null : `${folder}${ctx.projectFolder} Index.md`;
    const index = indexRel === null ? null : writePath(ctx, root, indexRel, true);
    if (index !== null && !index.ok) return fail(ctx, "create", rel, index.reason);
    if (indexRel !== null && rel.toLowerCase() === indexRel.toLowerCase()) return fail(ctx, "create", rel, "the note destination is the project's Index note; pick another title");
    const winReason = windowsPathRefusal(note.abs, rel) ?? (index !== null && index.ok && statOrMissing(index.abs) === null ? windowsPathRefusal(index.abs, index.rel) : null);
    if (winReason !== null) return fail(ctx, "create", rel, winReason);
    if (hasFrontmatter(args.body)) return fail(ctx, "create", rel, FRONTMATTER_REFUSAL);
    if (statOrMissing(note.abs) !== null) return fail(ctx, "create", rel, existingRefusal(rel));
    const createdAt = ctx.now();
    const noteStamp = stamp(ctx, args.tags ?? [], createdAt);
    const body = stripTitleHeading(args.body, title).trimEnd();
    const text = `${noteStamp}${body}\n`;
    const linkLine = `- [[${rel.replace(/\.md$/i, "")}|${title}]]\n`;
    let indexBefore: Buffer | null = null;
    let indexBeforeHash: string | null = null;
    let indexText: string | null = null;
    let indexAddition = "";
    let indexBytes: number | null = null;
    if (index !== null && index.ok) {
      const stat = statOrMissing(index.abs);
      if (stat !== null && !stat.isFile()) return fail(ctx, "create", rel, `existing markdown note required: ${index.rel}`);
      indexBefore = stat === null ? null : syncFs.readFileSync(index.abs);
      indexBeforeHash = indexBefore === null ? null : hash(indexBefore);
      const prefix = indexBefore?.toString("utf8") ?? `${stamp(ctx, ["index"], createdAt)}# ${ctx.projectFolder} Index\n`;
      indexAddition = `${prefix.endsWith("\n") ? "" : "\n"}${linkLine}`;
      indexText = prefix + indexAddition;
      indexBytes = (indexBefore?.length ?? Buffer.byteLength(prefix, "utf8")) + Buffer.byteLength(indexAddition, "utf8");
    }
    const secret = contentRefusal(text) ?? (indexText === null ? null : contentRefusal(indexText));
    if (secret !== null) return fail(ctx, "create", rel, secret);
    const size = sizeRefusal(text) ?? (indexBytes === null ? null : sizeRefusal(indexBytes));
    if (size !== null) return fail(ctx, "create", rel, size);
    const collisions = titleMatches(root, title).filter((file) => file.rel !== rel).map((file) => file.rel).sort();
    // No await from the final preflight through both mutations. This is not a
    // cross-process lock: an Index failure after creation is reported explicitly.
    try {
      const beforeMkdir = writePath(ctx, root, rel, true);
      const indexBeforeMkdir = indexRel === null ? null : writePath(ctx, root, indexRel, true);
      if (!beforeMkdir.ok) return fail(ctx, "create", rel, beforeMkdir.reason);
      if (indexBeforeMkdir !== null && !indexBeforeMkdir.ok) return fail(ctx, "create", rel, indexBeforeMkdir.reason);
      if (statOrMissing(note.abs) !== null) return fail(ctx, "create", rel, existingRefusal(rel));
      if (index !== null && index.ok) {
        const current = statOrMissing(index.abs) === null ? null : syncFs.readFileSync(index.abs);
        if ((current === null ? null : hash(current)) !== indexBeforeHash) return fail(ctx, "create", rel, `Index changed before creation: ${index.rel}; try again`);
      }
      syncFs.mkdirSync(path.dirname(note.abs), { recursive: true });
      const finalNote = writePath(ctx, root, rel, true);
      const finalIndex = indexRel === null ? null : writePath(ctx, root, indexRel, true);
      if (!finalNote.ok) return fail(ctx, "create", rel, finalNote.reason);
      if (finalIndex !== null && !finalIndex.ok) return fail(ctx, "create", rel, finalIndex.reason);
      if (finalIndex !== null && finalIndex.ok) {
        const stat = statOrMissing(finalIndex.abs);
        if (stat !== null && !stat.isFile()) return fail(ctx, "create", rel, `existing markdown note required: ${finalIndex.rel}`);
        const current = stat === null ? null : syncFs.readFileSync(finalIndex.abs);
        if ((current === null ? null : hash(current)) !== indexBeforeHash) return fail(ctx, "create", rel, `Index changed before creation: ${finalIndex.rel}; try again`);
      }
      const finalSize = sizeRefusal(text) ?? (indexBytes === null ? null : sizeRefusal(indexBytes));
      if (finalSize !== null) return fail(ctx, "create", rel, finalSize);
      writeExclusive(finalNote.abs, text);
      if (finalIndex !== null && finalIndex.ok && indexText !== null) {
        try {
          if (indexBefore === null) writeExclusive(finalIndex.abs, indexText);
          else syncFs.appendFileSync(finalIndex.abs, indexAddition, "utf8");
        } catch (error) {
          return { ...fail(ctx, "create", rel, `note created: ${rel}; Index update failed: ${finalIndex.rel} (${errorCode(error)})`), details: { ...details(ctx, "create", rel), createdByOmpUi: true, title, baseHash: hash(text), indexNotePath: finalIndex.rel } };
        }
      }
    } catch (error) {
      if (errorCode(error) === "EEXIST") return fail(ctx, "create", rel, existingRefusal(rel));
      return fail(ctx, "create", rel, `could not write ${rel}: ${errorCode(error)}`);
    }
    const replyLink = obsidianReplyLink(ctx.entry.name, rel, title);
    const wikilink = `[[${rel.replace(/\.md$/i, "")}|${title}]]`;
    const collisionText = collisions.map((other) => `A note named ${title} also exists at ${other}. Use the full path for this note to avoid basename ambiguity.\nReply link: ${obsidianReplyLink(ctx.entry.name, other, titleOf(other))}\nWikilink for vault notes: [[${other.replace(/\.md$/i, "")}|${titleOf(other)}]]`).join("\n");
    return {
      ok: true,
      text: `Created ${rel} in vault ${ctx.entry.name}${indexRel === null ? "." : `; linked from ${obsidianReplyLink(ctx.entry.name, indexRel, titleOf(indexRel))}.`}\nReply link: ${replyLink}\nWikilink for vault notes: ${wikilink}${collisionText ? `\n${collisionText}` : ""}`,
      details: { ...details(ctx, "create", rel), createdByOmpUi: true, title, stamp: noteStamp.split("\n").slice(1, -2), preview: `${body}\n`, collisions, baseHash: hash(text), ...(indexRel === null ? {} : { indexNotePath: indexRel }) },
    };
  });
}

function mutateExisting(ctx: VaultCallContext, root: string, action: "append" | "edit" | "link", raw: string, supplied: string, expectedHash?: string): VaultOutcome {
  const checked = writePath(ctx, root, withExtension(raw), false);
  if (!checked.ok) return fail(ctx, action, resultPath(raw), checked.reason);
  const note = regularMarkdown(root, checked.rel);
  if (!note.ok) return fail(ctx, action, checked.rel, note.reason);
  const beforeBytes = syncFs.readFileSync(note.abs);
  const beforeHash = hash(beforeBytes);
  const before = beforeBytes.toString("utf8");
  if (action !== "append" && beforeHash !== expectedHash) return fail(ctx, action, note.rel, `${note.rel} changed since you read it; read it again before editing`);
  if (action === "edit" && hasFrontmatter(supplied)) return fail(ctx, action, note.rel, FRONTMATTER_REFUSAL);
  const addition = action === "edit" ? null : appended(before, supplied);
  const after = action === "edit" ? splitFrontmatter(before).prefix + supplied : before + addition;
  const resultingBytes = action === "edit" ? Buffer.byteLength(after, "utf8") : beforeBytes.length + Buffer.byteLength(addition!, "utf8");
  const secret = contentRefusal(after);
  if (secret !== null) return fail(ctx, action, note.rel, secret);
  const size = sizeRefusal(resultingBytes);
  if (size !== null) return fail(ctx, action, note.rel, size);
  try {
    const finalPath = writePath(ctx, root, note.rel, false);
    if (!finalPath.ok) return fail(ctx, action, note.rel, finalPath.reason);
    const finalNote = regularMarkdown(root, note.rel);
    if (!finalNote.ok) return fail(ctx, action, note.rel, finalNote.reason);
    const current = syncFs.readFileSync(finalNote.abs);
    if (hash(current) !== beforeHash) return fail(ctx, action, note.rel, `${note.rel} changed since you read it; read it again before editing`);
    const finalSize = sizeRefusal(resultingBytes);
    if (finalSize !== null) return fail(ctx, action, note.rel, finalSize);
    // Atomic replacement follows a permitted alias to its real target instead
    // of replacing the alias itself; append always appends only the new bytes.
    if (action === "edit") {
      const real = syncFs.realpathSync.native(finalNote.abs);
      const temporary = `${real}.tmp-${process.pid}`;
      const tempRel = path.relative(root, temporary).split(path.sep).join("/");
      const tempPath = writePath(ctx, root, tempRel, false);
      if (!tempPath.ok) return fail(ctx, action, note.rel, tempPath.reason);
      try {
        if (syncFs.lstatSync(temporary).isSymbolicLink()) return fail(ctx, action, note.rel, `temporary file is a symlink: ${tempRel}`);
      } catch (error) { if (errorCode(error) !== "ENOENT") throw error; }
      writeTextAtomic(real, after);
    } else syncFs.appendFileSync(finalNote.abs, addition!, "utf8");
  } catch (error) { return fail(ctx, action, note.rel, `could not write ${note.rel}: ${errorCode(error)}`); }
  return {
    ok: true,
    text: `Vault ${ctx.entry.name} · ${note.rel}\n\n${action === "edit" ? "Edited" : action === "link" ? "Linked from" : "Appended to"} ${note.rel}.\nReply link: ${obsidianReplyLink(ctx.entry.name, note.rel, titleOf(note.rel))}`,
    details: { ...details(ctx, action, note.rel), title: titleOf(note.rel), createdByOmpUi: ownership(before), baseHash: action === "edit" ? hash(after) : createHash("sha256").update(beforeBytes).update(addition!, "utf8").digest("hex"), ...(action === "append" ? { preview: supplied.trimEnd() } : { diff: lineDiff(before, after) }) },
  };
}
export async function vaultAppend(ctx: VaultCallContext, rawPath: string, text: string): Promise<VaultOutcome> {
  return operation(ctx, "append", (root) => {
    if (typeof rawPath !== "string" || rawPath.trim() === "" || typeof text !== "string") return fail(ctx, "append", null, "append requires a nonblank path and text string");
    return mutateExisting(ctx, root, "append", rawPath, text);
  });
}
export async function vaultEdit(ctx: VaultCallContext, rawPath: string, content: string, expectedHash: string): Promise<VaultOutcome> {
  return operation(ctx, "edit", (root) => {
    if (typeof rawPath !== "string" || rawPath.trim() === "" || typeof content !== "string" || typeof expectedHash !== "string") return fail(ctx, "edit", null, "edit requires a nonblank path, content string and expectedHash string");
    return mutateExisting(ctx, root, "edit", rawPath, content, expectedHash);
  });
}
export async function vaultLink(ctx: VaultCallContext, rawPath: string, to: string, expectedHash: string): Promise<VaultOutcome> {
  return operation(ctx, "link", (root) => {
    if (typeof rawPath !== "string" || rawPath.trim() === "" || typeof to !== "string" || to.trim() === "" || typeof expectedHash !== "string") return fail(ctx, "link", null, "link requires nonblank path and to strings and an expectedHash string");
    const source = writePath(ctx, root, withExtension(rawPath), false);
    if (!source.ok) return fail(ctx, "link", resultPath(rawPath), source.reason);
    const sourceNote = regularMarkdown(root, source.rel);
    if (!sourceNote.ok) return fail(ctx, "link", source.rel, sourceNote.reason);
    if (hash(syncFs.readFileSync(sourceNote.abs)) !== expectedHash) return fail(ctx, "link", source.rel, `${source.rel} changed since you read it; read it again before editing`);
    const target = resolveExisting(root, to, true);
    if (!target.ok) {
      if (target.reason.startsWith("note not found:")) return fail(ctx, "link", source.rel, `link target not found: ${to}`);
      return fail(ctx, "link", source.rel, target.reason);
    }
    const again = resolveSync(root, target.rel);
    if (!again.ok) return fail(ctx, "link", source.rel, again.reason);
    if (!/\.md$/i.test(target.rel) || !syncFs.statSync(again.abs).isFile()) return fail(ctx, "link", source.rel, `link target not found: ${to}`);
    const targetText = syncFs.readFileSync(again.abs, "utf8");
    const title = titleOf(target.rel);
    const pathAlias = ownership(targetText) || titleMatches(root, title).length > 1;
    const line = pathAlias ? `- [[${target.rel.replace(/\.md$/i, "")}|${title}]]` : `- [[${title}]]`;
    return mutateExisting(ctx, root, "link", source.rel, line, expectedHash);
  });
}
