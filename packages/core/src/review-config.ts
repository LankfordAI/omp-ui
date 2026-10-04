import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as yaml from "js-yaml";
import { writeTextAtomic } from "./atomic-write";
import { getOmpAgentDir } from "./omp-config";
import { reviewerSlug } from "./review";

/**
 * REVIEW.yml discovery, merge and writer (issue #728, ADR-0047): the
 * reviewer roster behind `/code-review`. A restricted port of
 * watchdog-config.ts (ADR-0039) — same candidate walk (user scope first,
 * then project files farthest-ancestor-first, VCS-root stop, MAX_WALK), same
 * whole-file atomic writer with parse-error and stale-baseHash refusal, same
 * "a bad row is a warning, never a broken session" rule. The schema is the
 * roster only: `instructions` and `reviewers[]`; no side-files, no per-field
 * ceilings beyond the string cap.
 */

export type ReviewTargetKind = "local" | "commit" | "pr";

export interface ReviewReviewer {
  readonly name: string;
  readonly model: string | null;
  readonly instructions: string | null;
  readonly targets: readonly ReviewTargetKind[] | null;
  readonly enabled: boolean;
}

export interface ReviewDocument {
  readonly instructions: string | null;
  readonly reviewers: readonly ReviewReviewer[];
}

export interface ReviewRosterResult {
  readonly reviewers: readonly ReviewReviewer[];
  readonly instructions: string | null;
  readonly configWarnings: readonly string[];
}

export const REVIEW_FILE_NAMES = ["REVIEW.yml", "REVIEW.yaml"] as const;

/** The default roster when no file exists anywhere: one reviewer, session model. */
export const DEFAULT_REVIEWER: ReviewReviewer = {
  name: "code-reviewer",
  model: null,
  instructions: null,
  targets: null,
  enabled: true,
};

const MAX_WALK = 64;
const MAX_STRING = 64 * 1024;
const MAX_REVIEWERS = 64;
const FILE_KEYS = ["instructions", "reviewers"];
const ENTRY_KEYS = ["name", "model", "instructions", "targets", "enabled"];
const TARGET_KINDS: readonly ReviewTargetKind[] = ["local", "commit", "pr"];

const emptyDocument = (): ReviewDocument => ({ instructions: null, reviewers: [] });
const sha1 = (text: string): string => createHash("sha1").update(text).digest("hex");
const hasText = (v: string | null): v is string => v !== null && v.trim() !== "";

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

interface Candidate {
  scope: "user" | "project";
  file: string;
  depth: number;
}

/** Same walk as watchdog-config's `discoverCandidates`, minus the .md sweep. */
function discoverCandidates(
  cwd: string | null,
  agentDir: string,
  home: string,
  names: readonly string[],
): Candidate[] {
  const out: Candidate[] = [];
  for (const name of names) {
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
        for (const name of names) {
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

function editTarget(dir: string): string {
  const yml = path.join(dir, REVIEW_FILE_NAMES[0]);
  const yamlPath = path.join(dir, REVIEW_FILE_NAMES[1]);
  return !fs.existsSync(yml) && fs.existsSync(yamlPath) ? yamlPath : yml;
}

function projectTargetDir(scopeCwd: string): string {
  return vcsRootOf(scopeCwd) ?? path.resolve(scopeCwd);
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function parseReviewDocument(
  text: string,
  filePath: string,
): { document: ReviewDocument; blocking: string[] } {
  const blocking: string[] = [];
  let topInstructions: string | null = null;
  const reviewers: ReviewReviewer[] = [];
  let raw: unknown;
  try {
    raw = yaml.load(text);
  } catch (err) {
    blocking.push(`${filePath}: YAML syntax error — ${(err as Error).message.split("\n")[0]}`);
    return { document: { instructions: null, reviewers: [] }, blocking };
  }
  if (raw === undefined || raw === null) return { document: { instructions: null, reviewers: [] }, blocking };
  if (!isPlain(raw)) {
    blocking.push(`${filePath}: top level is not a mapping`);
    return { document: { instructions: null, reviewers: [] }, blocking };
  }
  for (const k of Object.keys(raw)) if (!FILE_KEYS.includes(k)) blocking.push(`${filePath}: unknown key "${k}"`);
  if (raw.instructions !== undefined) {
    if (typeof raw.instructions === "string") topInstructions = raw.instructions;
    else blocking.push(`${filePath}: instructions must be a string`);
  }
  if (raw.reviewers !== undefined) {
    if (!Array.isArray(raw.reviewers)) blocking.push(`${filePath}: reviewers must be a list`);
    else {
      const seen = new Set<string>();
      raw.reviewers.forEach((item, i) => {
        const label = `${filePath}: reviewer #${i + 1}`;
        if (!isPlain(item)) return void blocking.push(`${label} is not a mapping`);
        for (const k of Object.keys(item)) if (!ENTRY_KEYS.includes(k)) blocking.push(`${label} has unknown key "${k}"`);
        if (typeof item.name !== "string" || reviewerSlug(item.name) === "") {
          return void blocking.push(`${label} needs a name slugging to [a-z][a-z0-9-]*`);
        }
        if (!/^[a-z][a-z0-9-]*$/.test(reviewerSlug(item.name))) {
          return void blocking.push(`${label} name "${item.name}" must slug to [a-z][a-z0-9-]*`);
        }
        const slug = reviewerSlug(item.name);
        if (seen.has(slug)) return void blocking.push(`${label} duplicates another entry (slug "${slug}")`);
        seen.add(slug);
        let ok = true;
        const bad = (msg: string): void => {
          ok = false;
          blocking.push(`${label} ("${item.name}") ${msg}`);
        };
        let model: string | null = null;
        let instructions: string | null = null;
        let targets: ReviewTargetKind[] | null = null;
        let enabled = true;
        if (item.model !== undefined) {
          if (item.model === null) model = null;
          else if (typeof item.model === "string") model = item.model;
          else bad("model must be a string or null");
        }
        if (item.instructions !== undefined) {
          if (typeof item.instructions === "string") instructions = item.instructions;
          else bad("instructions must be a string");
        }
        if (item.targets !== undefined) {
          if (item.targets === null) targets = null;
          else if (Array.isArray(item.targets) && item.targets.every((t) => typeof t === "string")) {
            const kinds = item.targets.map((t) =>
              (TARGET_KINDS as readonly string[]).includes(t) ? (t as ReviewTargetKind) : null,
            );
            if (kinds.some((k) => k === null)) bad("targets must name local, commit, or pr");
            else targets = [...new Set(kinds as ReviewTargetKind[])];
          } else bad("targets must be a list of strings or null");
        }
        if (item.enabled !== undefined) {
          if (typeof item.enabled === "boolean") enabled = item.enabled;
          else bad("enabled must be a boolean");
        }
        if (ok) {
          reviewers.push({ name: reviewerSlug(item.name), model, instructions, targets, enabled });
        }
      });
    }
  }
  return { document: { instructions: topInstructions, reviewers }, blocking };
}

/** omp `Tcn` shape: plain scalar when safe, literal block otherwise. */
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

/** "" for an empty document, so the writer deletes instead of truncating. */
export function serializeReviewDocument(doc: ReviewDocument): string {
  const t: string[] = [];
  if (hasText(doc.instructions)) pushScalarBlock(t, "", "instructions", doc.instructions);
  if (doc.reviewers.length > 0) {
    t.push("reviewers:");
    for (const r of doc.reviewers) {
      t.push(`  - name: ${scalar(r.name)}`);
      if (hasText(r.model)) t.push(`    model: ${scalar(r.model)}`);
      if (r.targets !== null) {
        if (r.targets.length === 0) t.push("    targets: []");
        else {
          t.push("    targets:");
          for (const k of r.targets) t.push(`      - ${scalar(k)}`);
        }
      }
      if (hasText(r.instructions)) pushScalarBlock(t, "    ", "instructions", r.instructions);
      if (!r.enabled) t.push("    enabled: false");
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

export interface ReviewFileView {
  readonly scope: "user" | "project";
  readonly path: string;
  readonly exists: boolean;
  readonly hash: string | null;
  readonly document: ReviewDocument;
  readonly blocking: readonly string[];
}

function fileView(scope: "user" | "project", file: string): ReviewFileView {
  const text = readText(file);
  if (text === null) {
    return { scope, path: file, exists: false, hash: null, document: emptyDocument(), blocking: [] };
  }
  const parsed = parseReviewDocument(text, file);
  return { scope, path: file, exists: true, hash: sha1(text), ...parsed };
}

/** An effective entry remembers which file won and at which scope. */
export interface EffectiveReviewer extends ReviewReviewer {
  readonly sourcePath: string;
  readonly sourceScope: "user" | "project";
}

export interface ReviewRosterView extends ReviewRosterResult {
  readonly user: ReviewFileView;
  readonly project: ReviewFileView | null;
  readonly effective: readonly EffectiveReviewer[];
}

/**
 * Merged roster. `enabled` entries only in `reviewers` (the extension's
 * launch set); `effective` keeps disabled entries for the settings card.
 * With no file anywhere the default roster keeps the command useful.
 */
export async function readReviewRoster(
  scopeCwd: string | null,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<ReviewRosterView> {
  const agentDir = getOmpAgentDir(env);
  const userTarget = editTarget(agentDir);
  const projectTarget = scopeCwd === null ? null : editTarget(projectTargetDir(scopeCwd));
  const candidates = discoverCandidates(scopeCwd, agentDir, home, REVIEW_FILE_NAMES);
  const merged = new Map<string, EffectiveReviewer>();
  let instructions: string | null = null;
  const warnings: string[] = [];
  let sawFile = false;
  for (const c of candidates) {
    const text = readText(c.file);
    if (text === null) continue;
    sawFile = true;
    const parsed = parseReviewDocument(text, c.file);
    for (const b of parsed.blocking) warnings.push(b);
    if (hasText(parsed.document.instructions)) instructions = parsed.document.instructions;
    for (const r of parsed.document.reviewers) {
      merged.set(r.name, { ...r, sourcePath: c.file, sourceScope: c.scope });
    }
  }
  if (!sawFile && merged.size === 0) merged.set(DEFAULT_REVIEWER.name, { ...DEFAULT_REVIEWER, sourcePath: userTarget, sourceScope: "user" });
  const effective = [...merged.values()];
  return {
    reviewers: effective.filter((r) => r.enabled),
    instructions,
    configWarnings: warnings,
    user: fileView("user", userTarget),
    project: projectTarget === null ? null : fileView("project", projectTarget),
    effective,
  };
}

function validateRequest(req: ReviewWriteRequest): void {
  const doc = req.document;
  if (doc.reviewers.length > MAX_REVIEWERS) throw new Error(`at most ${MAX_REVIEWERS} reviewers`);
  const over = (s: string | null): boolean => s !== null && s.length > MAX_STRING;
  if (over(doc.instructions)) throw new Error("instructions too long");
  const seen = new Set<string>();
  for (const r of doc.reviewers) {
    if (reviewerSlug(r.name) === "") throw new Error("reviewer name must not be empty");
    const slug = reviewerSlug(r.name);
    if (seen.has(slug)) throw new Error(`duplicate reviewer name "${r.name}" (slug "${slug}")`);
    seen.add(slug);
    if (over(r.instructions) || over(r.model) || r.name.length > MAX_STRING) throw new Error(`reviewer "${r.name}": text too long`);
    for (const t of r.targets ?? []) {
      if (!(TARGET_KINDS as readonly string[]).includes(t)) throw new Error(`reviewer "${r.name}": unknown target "${t}"`);
    }
  }
}

export interface ReviewWriteRequest {
  readonly scopeCwd: string | null;
  readonly scope: "user" | "project";
  readonly baseHash: string | null;
  readonly document: ReviewDocument;
}

export async function setReviewRoster(
  req: ReviewWriteRequest,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): Promise<ReviewRosterView> {
  validateRequest(req);
  let target: string;
  if (req.scope === "user") target = editTarget(getOmpAgentDir(env));
  else {
    if (req.scopeCwd === null) throw new Error("project scope needs a project directory");
    target = editTarget(projectTargetDir(req.scopeCwd));
  }
  const current = readText(target);
  if ((current === null ? null : sha1(current)) !== req.baseHash) {
    throw new Error("REVIEW.yml changed on disk since it was loaded; reload and retry");
  }
  if (current !== null) {
    const { blocking } = parseReviewDocument(current, target);
    if (blocking.length > 0) throw new Error(`refusing to overwrite ${target}: ${blocking[0]}`);
  }
  const text = serializeReviewDocument(req.document);
  if (text === "") fs.rmSync(target, { force: true });
  else writeTextAtomic(target, text);
  return readReviewRoster(req.scopeCwd, env, home);
}
