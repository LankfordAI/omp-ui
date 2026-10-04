import * as yaml from "js-yaml";
import { reviewerSlug } from "./review";

/**
 * The reviewer roster behind `/code-review` (issue #728, ADR-0047 as amended
 * by issue #738): roster truth lives in omp-ui app state — `ProjectRecord.reviewRoster`
 * per project and `RegistrySettings.reviewRoster` globally — not in REVIEW.yml.
 * This module owns the document shape, the YAML parser the one-time importer
 * uses, the semantic validator shared by Settings and spawn, and the pure
 * project → global → default resolution chain. File discovery and the
 * one-time import live in review-config-import.ts.
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

/** The default roster when neither scope names one: one reviewer, session model. */
export const DEFAULT_REVIEWER: ReviewReviewer = {
  name: "code-reviewer",
  model: null,
  instructions: null,
  targets: null,
  enabled: true,
};

/**
 * One roster save (issue #738): replaces the whole document at one scope in
 * app state. null document = clear that scope's override. `scopeCwd` is the
 * project for "project" scope (null there is a refusal); ignored for "user".
 */
export interface ReviewWriteRequest {
  readonly scopeCwd: string | null;
  readonly scope: "user" | "project";
  readonly document: ReviewDocument | null;
}

const MAX_STRING = 64 * 1024;
const MAX_REVIEWERS = 64;
const FILE_KEYS = ["instructions", "reviewers"];
const ENTRY_KEYS = ["name", "model", "instructions", "targets", "enabled"];
const TARGET_KINDS: readonly ReviewTargetKind[] = ["local", "commit", "pr"];

const hasText = (v: string | null): v is string => v !== null && v.trim() !== "";

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Structural guard for values crossing into registry state: a settings blob or
 * a project record parsed off disk, and the wire codec's output. Semantics
 * (slugs, duplicates, ceilings) are `validateReviewDocument`'s job at read
 * time; this only proves the shape cannot crash the resolver.
 */
export function isReviewDocument(value: unknown): value is ReviewDocument {
  if (!isPlain(value)) return false;
  if (value["instructions"] !== null && typeof value["instructions"] !== "string") return false;
  const reviewers = value["reviewers"];
  if (!Array.isArray(reviewers) || reviewers.length > MAX_REVIEWERS) return false;
  return reviewers.every(
    (item) =>
      isPlain(item) &&
      typeof item["name"] === "string" &&
      (item["model"] === null || typeof item["model"] === "string") &&
      (item["instructions"] === null || typeof item["instructions"] === "string") &&
      (item["targets"] === null ||
        (Array.isArray(item["targets"]) &&
          item["targets"].every((t) => (TARGET_KINDS as readonly string[]).includes(String(t))))) &&
      typeof item["enabled"] === "boolean",
  );
}

/** Parse a REVIEW.yml body (the one-time importer's reader, issue #738). */
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

/**
 * Semantic validation of a stored document (registry state, hand-edited or
 * imported): a bad entry is a warning naming `sourceLabel`, never a broken
 * launch — the same rule the file merger had. Entry order is preserved.
 */
export function validateReviewDocument(doc: ReviewDocument, sourceLabel: string): ReviewRosterResult {
  const warnings: string[] = [];
  const reviewers: ReviewReviewer[] = [];
  const seen = new Set<string>();
  const over = (s: string | null): boolean => s !== null && s.length > MAX_STRING;
  if (over(doc.instructions)) warnings.push(`${sourceLabel}: shared instructions over ${MAX_STRING} characters — dropped`);
  const instructions = over(doc.instructions) ? null : doc.instructions;
  const list = doc.reviewers.length > MAX_REVIEWERS ? doc.reviewers.slice(0, MAX_REVIEWERS) : doc.reviewers;
  if (doc.reviewers.length > MAX_REVIEWERS) {
    warnings.push(`${sourceLabel}: more than ${MAX_REVIEWERS} reviewers — the extras were dropped`);
  }
  for (const r of list) {
    const label = `${sourceLabel}: reviewer "${r.name}"`;
    const slug = reviewerSlug(r.name);
    if (slug === "" || !/^[a-z][a-z0-9-]*$/.test(slug)) {
      warnings.push(`${label}: name must slug to [a-z][a-z0-9-]* — entry dropped`);
      continue;
    }
    if (seen.has(slug)) {
      warnings.push(`${label}: duplicates another entry (slug "${slug}") — entry dropped`);
      continue;
    }
    seen.add(slug);
    if (over(r.instructions) || over(r.model) || over(r.name)) {
      warnings.push(`${label}: text over ${MAX_STRING} characters — entry dropped`);
      continue;
    }
    // isReviewDocument gates the shape; this belt-catches hand-edited state.
    const targets = (r.targets ?? []).filter((t) => (TARGET_KINDS as readonly string[]).includes(t));
    reviewers.push({
      name: slug,
      model: hasText(r.model) ? r.model : null,
      instructions: hasText(r.instructions) ? r.instructions : null,
      targets: r.targets === null ? null : [...new Set(targets)],
      enabled: r.enabled !== false,
    });
  }
  return { reviewers, instructions: hasText(instructions) ? instructions : null, configWarnings: warnings };
}

/** An effective entry remembers which scope's document won. */
export interface EffectiveReviewer extends ReviewReviewer {
  readonly sourceScope: "user" | "project";
}

export interface ReviewRosterView extends ReviewRosterResult {
  /** The global document (RegistrySettings.reviewRoster); null = unset. */
  readonly global: ReviewDocument | null;
  /** This project's document (ProjectRecord.reviewRoster); null = unset or no project. */
  readonly project: ReviewDocument | null;
  readonly effective: readonly EffectiveReviewer[];
}

export interface ReviewRosterSources {
  readonly global: ReviewDocument | null;
  readonly project: ReviewDocument | null;
}

/**
 * The resolution chain: the project document wins when one exists, then the
 * global document, then `DEFAULT_REVIEWER`. `projectPath === null` (the
 * global Settings card, no project context) ignores any project document.
 * `reviewers` holds the enabled entries only (the bridge's launch set);
 * `effective` keeps disabled entries for the settings card.
 */
export function resolveReviewRoster(
  projectPath: string | null,
  sources: ReviewRosterSources,
): ReviewRosterView {
  const useProject = projectPath !== null && sources.project !== null;
  const winner = useProject ? sources.project : sources.global;
  if (winner === null) {
    return {
      reviewers: DEFAULT_REVIEWER.enabled ? [{ ...DEFAULT_REVIEWER }] : [],
      instructions: null,
      configWarnings: [],
      global: sources.global,
      project: sources.project,
      effective: DEFAULT_REVIEWER.enabled ? [{ ...DEFAULT_REVIEWER, sourceScope: "user" }] : [],
    };
  }
  const validated = validateReviewDocument(winner, useProject ? "this project's roster" : "the global roster");
  const scope = useProject ? ("project" as const) : ("user" as const);
  return {
    reviewers: validated.reviewers.filter((r) => r.enabled),
    instructions: validated.instructions,
    configWarnings: validated.configWarnings,
    global: sources.global,
    project: sources.project,
    effective: validated.reviewers.map((r) => ({ ...r, sourceScope: scope })),
  };
}
