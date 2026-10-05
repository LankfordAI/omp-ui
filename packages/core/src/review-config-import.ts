import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getOmpAgentDir } from "./omp-config";
import { parseReviewDocument, type ReviewDocument } from "./review-config";

/**
 * The one-time REVIEW.yml import (issue #738, ADR-0047 as amended): the first
 * time an omp-ui build boots with roster-in-app-state, it reads the REVIEW.yml
 * files the old code reviewed at every launch and copies what it finds into
 * registry state — the user-scope file into `RegistrySettings.reviewRoster`
 * (only when that is still unset), each project file into its project's
 * `ProjectRecord.reviewRoster` (only when that is still unset). Files on disk
 * are never modified or deleted; once the marker is set they are never read
 * again. A crash mid-pass just re-runs next boot: fills only null slots, so a
 * half-import converges.
 */

export const REVIEW_FILE_NAMES = ["REVIEW.yml", "REVIEW.yaml"] as const;

const MAX_WALK = 64;

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

function readText(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export interface FoundReviewFile {
  readonly file: string;
  readonly document: ReviewDocument;
  /** Parse complaints; the document carries the entries that parsed. */
  readonly blocking: readonly string[];
}

/** The user-scope file: omp's agent dir (`$PI_CODING_AGENT_DIR`/`.omp/agents`). */
function userFiles(agentDir: string): FoundReviewFile[] {
  const out: FoundReviewFile[] = [];
  for (const name of REVIEW_FILE_NAMES) {
    const file = path.join(agentDir, name);
    const text = readText(file);
    if (text === null) continue;
    const parsed = parseReviewDocument(text, file);
    out.push({ file, document: parsed.document, blocking: parsed.blocking });
  }
  return out;
}

/**
 * Every REVIEW.yml on the way up from a project directory (the old merge
 * walk), nearest-first: `.omp/`-nested and bare files at each level, hidden
 * directories skipped except `.omp`, stopping at the VCS root (or home).
 */
function projectFiles(cwd: string, home: string): FoundReviewFile[] {
  const start = path.resolve(cwd);
  const stop = vcsRootOf(start) ?? path.resolve(home);
  let dir = start;
  const found: FoundReviewFile[] = [];
  for (let i = 0; i < MAX_WALK; i++) {
    const inOmp = path.basename(dir) === ".omp";
    const dotDir = path.basename(dir).startsWith(".");
    const bases = [path.join(dir, ".omp"), dir];
    for (const base of bases) {
      const baseIsOmp = path.basename(base) === ".omp";
      if (!baseIsOmp && dotDir && !inOmp) continue;
      for (const name of REVIEW_FILE_NAMES) {
        const file = path.join(base, name);
        const text = readText(file);
        if (text === null) continue;
        const parsed = parseReviewDocument(text, file);
        found.push({ file, document: parsed.document, blocking: parsed.blocking });
      }
    }
    if (dir === stop) break;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return found;
}

export interface ReviewImportProject {
  readonly path: string;
  readonly reviewRoster: ReviewDocument | null;
}

export interface ReviewImportRegistry {
  getSetting(key: "reviewRoster"): ReviewDocument | null;
  setSetting(key: "reviewRoster", value: ReviewDocument): void;
  get projects(): readonly ReviewImportProject[];
  setProjectReviewRoster(projectPath: string, document: ReviewDocument | null): void;
}

export interface ReviewImportOutcome {
  /** Every slot was fillable-or-filled: the marker may be set. */
  readonly done: boolean;
  /** Files that contributed a document this pass (for the Settings hint). */
  readonly importedFiles: readonly string[];
}

/**
 * One import pass. A project file is attributed to a registered project when
 * it sits at the project directory, at the project's VCS root, or anywhere on
 * the walk between them (the old merge candidates); several candidate files
 * for one project take the nearest one, as the merge did. Unattributable
 * files — and any project already holding a roster — are skipped, not
 * blockers; only a failing write leaves `done` false and retries next boot.
 */
export function importReviewRosters(
  registry: ReviewImportRegistry,
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): ReviewImportOutcome {
  const imported: string[] = [];
  let done = true;

  if (registry.getSetting("reviewRoster") === null) {
    const files = userFiles(getOmpAgentDir(env));
    if (files.length > 0) {
      // The old merge applied the user file exactly once — it had one
      // candidate: take the first (.yml before .yaml).
      try {
        registry.setSetting("reviewRoster", files[0]!.document);
        imported.push(files[0]!.file);
      } catch {
        done = false;
      }
    }
  }

  for (const project of registry.projects) {
    if (project.reviewRoster !== null) continue;
    const files = projectFiles(project.path, home);
    // Nearest-first (the merge let the nearest file win per name). The first
    // file with any content takes the slot even with entry-level complaints —
    // those surface as warnings through validateReviewDocument on every read.
    const candidate = files.find((f) => f.document.reviewers.length > 0 || f.document.instructions !== null);
    const use = candidate ?? files[0];
    if (use === undefined) continue;
    try {
      registry.setProjectReviewRoster(project.path, use.document);
      imported.push(use.file);
    } catch {
      done = false;
    }
  }
  return { done, importedFiles: imported };
}
