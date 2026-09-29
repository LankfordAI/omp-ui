import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { writeTextAtomic } from "./atomic-write";
import { getOmpAgentDir } from "./omp-config";
import type {
  WatchdogAdvisorEntry,
  WatchdogDocument,
  WatchdogEffectiveAdvisor,
  WatchdogFileView,
  WatchdogRosterResult,
  WatchdogScope,
  WatchdogWriteRequest,
} from "./types";
import { advisorSlug, effectiveAdvisorTools, resolveWatchdogTool } from "./watchdog";

/**
 * omp's WATCHDOG.yml discovery, merge and writer (ADR-0039). Ports omp 18.4.2
 * `bCs` (discovery), `lCt` (merge), `uCt` (edit target), `zva`/`Tcn` (writer).
 */

const MAX_WALK = 64;
const MAX_STRING = 64 * 1024;
const MAX_ADVISORS = 64;
const FILE_NAMES = ["WATCHDOG.yml", "WATCHDOG.yaml"] as const;
const FILE_KEYS = ["instructions", "maxNotesPerUpdate", "advisors"];
const ENTRY_KEYS = ["name", "model", "tools", "instructions", "enabled", "maxNotesPerUpdate"];

interface Candidate {
  scope: WatchdogScope;
  file: string;
  depth: number;
}

const emptyDocument = (): WatchdogDocument => ({ instructions: null, maxNotesPerUpdate: null, advisors: [] });
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function vcsRootOf(cwd: string): string | null {
  let dir = path.resolve(cwd);
  for (let i = 0; i < MAX_WALK; i++) {
    if (fs.existsSync(path.join(dir, ".git"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** omp `bCs` + sort from `lCt`: user first, then project files farthest ancestor first. */
function discoverCandidates(cwd: string | null, agentDir: string, home: string): Candidate[] {
  const out: Candidate[] = [];
  for (const name of FILE_NAMES) {
    const file = path.join(agentDir, name);
    if (isFile(file)) out.push({ scope: "user", file, depth: 0 });
  }
  if (cwd !== null) {
    const start = path.resolve(cwd);
    const root = vcsRootOf(start);
    const stop = root ?? path.resolve(home);
    let dir = start;
    const projects: Candidate[] = [];
    for (let i = 0; i < MAX_WALK; i++) {
      const rel = path.relative(start, dir);
      const depth = rel === "" ? 0 : rel.split(path.sep).length;
      const inOmp = path.basename(dir) === ".omp";
      const dotDir = path.basename(dir).startsWith(".");
      const bases = [path.join(dir, ".omp"), dir];
      for (const base of bases) {
        const baseIsOmp = path.basename(base) === ".omp";
        if (!baseIsOmp && dotDir && !inOmp) continue;
        for (const name of FILE_NAMES) {
          const file = path.join(base, name);
          if (isFile(file)) projects.push({ scope: "project", file, depth });
        }
      }
      if (dir === stop) break;
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    projects.sort((a, b) => b.depth - a.depth);
    out.push(...projects);
  }
  return out;
}

/** omp `uCt`: `.yml` unless only `.yaml` exists. */
function editTarget(dir: string): string {
  const yml = path.join(dir, "WATCHDOG.yml");
  const yamlPath = path.join(dir, "WATCHDOG.yaml");
  return !fs.existsSync(yml) && fs.existsSync(yamlPath) ? yamlPath : yml;
}

function projectTargetDir(scopeCwd: string): string {
  return vcsRootOf(scopeCwd) ?? path.resolve(scopeCwd);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseWatchdogText(
  text: string,
  filePath: string,
): { document: WatchdogDocument; blocking: string[]; notices: string[] } {
  const blocking: string[] = [];
  const notices: string[] = [];
  const document = emptyDocument();
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    blocking.push(`${filePath}: YAML syntax error — ${(err as Error).message.split("\n")[0]}`);
    return { document, blocking, notices };
  }
  if (raw === undefined || raw === null) return { document, blocking, notices };
  if (!isPlain(raw)) {
    blocking.push(`${filePath}: top level is not a mapping`);
    return { document, blocking, notices };
  }
  if (text.split("\n").some((l) => l.trim().startsWith("#"))) notices.push("Comments are not preserved when saving.");
  if (text.includes("@")) notices.push("Instructions may import files with @path; the raw text is shown.");
  for (const k of Object.keys(raw)) if (!FILE_KEYS.includes(k)) blocking.push(`${filePath}: unknown key "${k}"`);
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions === "string") document.instructions = raw.instructions;
    else blocking.push(`${filePath}: instructions must be a string`);
  }
  if (raw.maxNotesPerUpdate !== undefined) {
    const n = raw.maxNotesPerUpdate;
    if (typeof n === "number" && Number.isFinite(n) && n >= 1) document.maxNotesPerUpdate = Math.trunc(n);
    else blocking.push(`${filePath}: maxNotesPerUpdate must be a number ≥ 1`);
  }
  if (raw.advisors !== undefined) {
    if (!Array.isArray(raw.advisors)) blocking.push(`${filePath}: advisors must be a list`);
    else {
      const seen = new Set<string>();
      raw.advisors.forEach((item, i) => {
        const label = `${filePath}: advisor #${i + 1}`;
        if (!isPlain(item)) return void blocking.push(`${label} is not a mapping`);
        for (const k of Object.keys(item)) if (!ENTRY_KEYS.includes(k)) blocking.push(`${label} has unknown key "${k}"`);
        if (typeof item.name !== "string" || item.name.trim() === "") return void blocking.push(`${label} needs a name`);
        const entry: WatchdogAdvisorEntry = {
          name: item.name, model: null, tools: null, instructions: null, enabled: null, maxNotesPerUpdate: null,
        };
        let ok = true;
        const bad = (msg: string): void => {
          ok = false;
          blocking.push(`${label} ("${item.name}") ${msg}`);
        };
        if (item.model !== undefined) {
          if (typeof item.model === "string") entry.model = item.model;
          else bad("model must be a string");
        }
        if (item.instructions !== undefined) {
          if (typeof item.instructions === "string") entry.instructions = item.instructions;
          else bad("instructions must be a string");
        }
        if (item.enabled !== undefined) {
          if (typeof item.enabled === "boolean") entry.enabled = item.enabled;
          else bad("enabled must be a boolean");
        }
        if (item.tools !== undefined) {
          if (Array.isArray(item.tools) && item.tools.every((t) => typeof t === "string")) entry.tools = item.tools as string[];
          else bad("tools must be a list of strings");
        }
        if (item.maxNotesPerUpdate !== undefined) {
          const n = item.maxNotesPerUpdate;
          if (typeof n === "number" && Number.isFinite(n) && n >= 1) entry.maxNotesPerUpdate = Math.trunc(n);
          else bad("maxNotesPerUpdate must be a number ≥ 1");
        }
        const slug = advisorSlug(entry.name);
        if (seen.has(slug)) bad(`duplicates another entry (slug "${slug}")`);
        seen.add(slug);
        if (ok) document.advisors.push(entry);
      });
    }
  }
  return { document, blocking, notices };
}

/** omp `Tcn`. */
function pushScalarBlock(lines: string[], indent: string, key: string, value: string): void {
  const hasIndentedLine = value.split("\n").some((l) => /^[ \t]/.test(l));
  if (!value.includes("\n") || hasIndentedLine) {
    lines.push(`${indent}${key}: ${scalar(value)}`);
    return;
  }
  const r = value.replaceAll("\r\n", "\n");
  let trailing = 0;
  for (let i = r.length - 1; i >= 0 && r[i] === "\n"; i--) trailing++;
  const header = trailing === 0 ? "|2-" : trailing === 1 ? "|2" : "|2+";
  const body = trailing === 0 ? r : r.slice(0, -trailing);
  lines.push(`${indent}${key}: ${header}`);
  for (const l of body.split("\n")) lines.push(`${indent}  ${l}`);
  for (let i = 1; i < trailing; i++) lines.push(`${indent}  `);
}

function scalar(value: string): string {
  const reserved = /^(true|false|null|yes|no|on|off|y|n|~)$/i;
  if (/^[A-Za-z_][A-Za-z0-9_./-]*$/.test(value) && !reserved.test(value)) return value;
  return JSON.stringify(value);
}

const hasText = (v: string | null): v is string => v !== null && v.trim() !== "";

/** omp `zva`; "" for an empty document. */
export function serializeWatchdog(doc: WatchdogDocument): string {
  const t: string[] = [];
  if (hasText(doc.instructions)) pushScalarBlock(t, "", "instructions", doc.instructions);
  if (doc.maxNotesPerUpdate !== null && Number.isFinite(doc.maxNotesPerUpdate) && doc.maxNotesPerUpdate >= 1) {
    t.push(`maxNotesPerUpdate: ${Math.trunc(doc.maxNotesPerUpdate)}`);
  }
  if (doc.advisors.length > 0) {
    t.push("advisors:");
    for (const a of doc.advisors) {
      t.push(`  - name: ${scalar(a.name)}`);
      if (hasText(a.model)) t.push(`    model: ${scalar(a.model)}`);
      if (a.tools !== null) {
        if (a.tools.length === 0) t.push("    tools: []");
        else {
          t.push("    tools:");
          for (const tool of a.tools) t.push(`      - ${scalar(tool)}`);
        }
      }
      if (hasText(a.instructions)) pushScalarBlock(t, "    ", "instructions", a.instructions);
      if (a.enabled !== null) t.push(`    enabled: ${a.enabled}`);
      if (a.maxNotesPerUpdate !== null && Number.isFinite(a.maxNotesPerUpdate) && a.maxNotesPerUpdate >= 1) {
        t.push(`    maxNotesPerUpdate: ${Math.trunc(a.maxNotesPerUpdate)}`);
      }
    }
  }
  return t.length === 0 ? "" : `${t.join("\n")}\n`;
}

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function fileView(scope: WatchdogScope, file: string): WatchdogFileView {
  const text = readText(file);
  if (text === null) {
    return { scope, path: file, exists: false, hash: null, document: emptyDocument(), blocking: [], notices: [] };
  }
  const parsed = parseWatchdogText(text, file);
  return { scope, path: file, exists: true, hash: sha1(text), ...parsed };
}

export async function getWatchdogRoster(
  scopeCwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<WatchdogRosterResult> {
  try {
    const agentDir = getOmpAgentDir(env);
    const userTarget = editTarget(agentDir);
    const projectTarget = scopeCwd === null ? null : editTarget(projectTargetDir(scopeCwd));
    const candidates = discoverCandidates(scopeCwd, agentDir, home);

    const merged = new Map<string, WatchdogEffectiveAdvisor>();
    const sharedInstructions: string[] = [];
    const warnings: string[] = [];
    for (const c of candidates) {
      const text = readText(c.file);
      if (text === null) continue;
      const parsed = parseWatchdogText(text, c.file);
      for (const b of parsed.blocking) warnings.push(b);
      if (hasText(parsed.document.instructions)) sharedInstructions.push(c.file);
      for (const a of parsed.document.advisors) {
        const slug = advisorSlug(a.name);
        merged.set(slug, {
          name: a.name,
          slug,
          sourcePath: c.file,
          sourceScope: c.scope,
          model: hasText(a.model) ? a.model : null,
          tools: effectiveAdvisorTools(a.tools),
          toolsExplicit: a.tools !== null,
          enabled: a.enabled !== false,
          instructions: a.instructions,
          maxNotesPerUpdate: a.maxNotesPerUpdate,
        });
      }
    }
    const targets = new Set([userTarget, projectTarget].filter((p): p is string => p !== null));
    return {
      status: "available",
      user: fileView("user", userTarget),
      project: projectTarget === null ? null : fileView("project", projectTarget),
      effective: [...merged.values()],
      sharedInstructions,
      otherFiles: candidates.map((c) => c.file).filter((f) => !targets.has(f)),
      warnings,
    };
  } catch (err) {
    return { status: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

function validateRequest(req: WatchdogWriteRequest): void {
  const doc = req.document;
  if (doc.advisors.length > MAX_ADVISORS) throw new Error(`at most ${MAX_ADVISORS} advisors`);
  const over = (s: string | null): boolean => s !== null && s.length > MAX_STRING;
  if (over(doc.instructions)) throw new Error("instructions too long");
  const num = (n: number | null, what: string): void => {
    if (n !== null && !(Number.isFinite(n) && n >= 1)) throw new Error(`${what}: maxNotesPerUpdate must be a number ≥ 1`);
  };
  num(doc.maxNotesPerUpdate, "file");
  const seen = new Set<string>();
  for (const a of doc.advisors) {
    if (a.name.trim() === "") throw new Error("advisor name must not be empty");
    const slug = advisorSlug(a.name);
    if (seen.has(slug)) throw new Error(`duplicate advisor name "${a.name}" (slug "${slug}")`);
    seen.add(slug);
    if (over(a.instructions) || over(a.model) || a.name.length > MAX_STRING) throw new Error(`advisor "${a.name}": text too long`);
    num(a.maxNotesPerUpdate, `advisor "${a.name}"`);
    for (const tool of a.tools ?? []) {
      if (resolveWatchdogTool(tool) === null) throw new Error(`advisor "${a.name}": unknown tool "${tool}"`);
    }
  }
}

export async function setWatchdogRoster(
  req: WatchdogWriteRequest,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<WatchdogRosterResult> {
  validateRequest(req);
  let target: string;
  if (req.scope === "user") target = editTarget(getOmpAgentDir(env));
  else {
    if (req.scopeCwd === null) throw new Error("project scope needs a project directory");
    target = editTarget(projectTargetDir(req.scopeCwd));
  }
  const current = readText(target);
  if ((current === null ? null : sha1(current)) !== req.baseHash) {
    throw new Error("WATCHDOG.yml changed on disk since it was loaded; reload and retry");
  }
  if (current !== null) {
    const { blocking } = parseWatchdogText(current, target);
    if (blocking.length > 0) throw new Error(`refusing to overwrite ${target}: ${blocking[0]}`);
  }
  const text = serializeWatchdog(req.document);
  if (text === "") fs.rmSync(target, { force: true });
  else writeTextAtomic(target, text);
  return getWatchdogRoster(req.scopeCwd, env, home);
}
