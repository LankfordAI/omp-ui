import { councilMemberSlug, councilNameFromModel, MAX_COUNCIL_MEMBERS, MAX_COUNCIL_NAME } from "./council";
import { parseModelRole } from "./model-role";

/**
 * The Council roster behind `/council` (ADR-0088, issue #1049): roster truth
 * lives in omp-ui app state — `ProjectRecord.councilRoster` per project and
 * `RegistrySettings.councilRoster` globally. This module owns the document
 * shape, the structural guard and the one-time legacy `reviewRoster`
 * conversion used when the registry loads, the semantic validator shared by
 * Settings and spawn, and the pure project → global → empty resolution chain.
 * Nothing falls back to the session model: an empty chain launches no one.
 * Besides the council members, a document may carry one trial member: an extra
 * model that answers beside the council for comparison and never counts
 * toward its conclusions (issue #1140).
 */

export { MAX_COUNCIL_MEMBERS, MAX_COUNCIL_NAME } from "./council";

export interface CouncilMember {
  /** "" = follow the model (#1057): validation derives the entry name from
   *  `model` live, so switching models renames the member. A typed name pins. */
  readonly name: string;
  /** null only in migrated legacy data; such a member is never launched. */
  readonly model: string | null;
  readonly instructions: string | null;
  readonly enabled: boolean;
}

export interface CouncilDocument {
  readonly instructions: string | null;
  readonly members: readonly CouncilMember[];
  /**
   * The trial slot: one extra model that answers beside the council for
   * comparison and never counts toward its conclusions. Absent or null =
   * empty. The editor omits the key for an empty slot, so a document without
   * a trial member is byte-identical to one saved before the slot existed.
   */
  readonly trial?: CouncilMember | null;
}

export interface CouncilRosterResult {
  /** Launch set: enabled, model non-null, first MAX_COUNCIL_MEMBERS only. */
  readonly members: readonly CouncilMember[];
  /** The trial member launched beside `members`: enabled, with a model, and
   *  only when `members` is non-empty. */
  readonly trial: CouncilMember | null;
  readonly instructions: string | null;
  readonly configWarnings: readonly string[];
}

/** An effective entry remembers which scope's document won. */
export interface EffectiveCouncilMember extends CouncilMember {
  readonly sourceScope: "user" | "project";
}

export interface CouncilRosterView extends CouncilRosterResult {
  /** The global document (RegistrySettings.councilRoster); null = unset. */
  readonly global: CouncilDocument | null;
  /** This project's document (ProjectRecord.councilRoster); null = unset or no project. */
  readonly project: CouncilDocument | null;
  /** Every validated entry of the winning document, disabled and model-less ones too. */
  readonly effective: readonly EffectiveCouncilMember[];
  /** The winning document's validated trial entry, disabled or model-less
   *  included; null = none. */
  readonly effectiveTrial: EffectiveCouncilMember | null;
}

export interface CouncilRosterSources {
  readonly global: CouncilDocument | null;
  readonly project: CouncilDocument | null;
}

/**
 * One roster save: replaces the whole document at one scope in app state.
 * null document = clear that scope's override. `scopeCwd` is the project for
 * "project" scope (null there is a refusal); ignored for "user".
 */
export interface CouncilWriteRequest {
  readonly scopeCwd: string | null;
  readonly scope: "user" | "project";
  readonly document: CouncilDocument | null;
}

const MAX_STRING = 64 * 1024;
/** Storage ceiling, well above the launch cap, so legacy rosters still load. */
const MAX_STORED_MEMBERS = 64;
const SLUG_PATTERN = /^[a-z][a-z0-9-]*$/;

const hasText = (v: string | null): v is string => v !== null && v.trim() !== "";

function isPlain(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isStoredMember(item: unknown): boolean {
  return (
    isPlain(item) &&
    typeof item["name"] === "string" &&
    (item["model"] === null || typeof item["model"] === "string") &&
    (item["instructions"] === null || typeof item["instructions"] === "string") &&
    typeof item["enabled"] === "boolean"
  );
}

/**
 * Structural guard for values crossing into registry state: a settings blob or
 * a project record parsed off disk, and the wire codec's output. Semantics
 * (slugs, duplicates, ceilings, the launch set) are `validateCouncilDocument`'s
 * job at read time; this only proves the shape cannot crash the resolver.
 * Extra keys are tolerated.
 */
export function isCouncilDocument(value: unknown): value is CouncilDocument {
  if (!isPlain(value)) return false;
  if (value["instructions"] !== null && typeof value["instructions"] !== "string") return false;
  const trial = value["trial"];
  if (trial !== undefined && trial !== null && !isStoredMember(trial)) return false;
  const members = value["members"];
  if (!Array.isArray(members) || members.length > MAX_STORED_MEMBERS) return false;
  return members.every(isStoredMember);
}

/**
 * Convert a legacy `reviewRoster` document (`{ instructions, reviewers }`) to a
 * Council document, keeping each entry's name, model, instructions and enabled
 * flag and dropping `targets`. null when the value is not a legacy document or
 * the converted shape fails `isCouncilDocument`.
 */
export function councilDocumentFromLegacy(value: unknown): CouncilDocument | null {
  if (!isPlain(value)) return null;
  const reviewers = value["reviewers"];
  if (!Array.isArray(reviewers)) return null;
  const instructions = value["instructions"];
  const converted: unknown = {
    instructions: typeof instructions === "string" ? instructions : null,
    members: reviewers.map((r: unknown) =>
      isPlain(r) ? { name: r["name"], model: r["model"], instructions: r["instructions"], enabled: r["enabled"] } : r,
    ),
  };
  return isCouncilDocument(converted) ? converted : null;
}

interface ValidatedCouncil extends CouncilRosterResult {
  /** Every entry that survived validation, in order, before launch-set filtering. */
  readonly entries: readonly CouncilMember[];
  /** The winning document's validated trial entry, disabled or model-less
   *  included; null = none. */
  readonly trialEntry: CouncilMember | null;
}

const overLimit = (s: string | null): boolean => s !== null && s.length > MAX_STRING;

/** One entry through the name, duplicate and size rules; null = dropped, with its warning pushed. */
function validateMember(
  m: CouncilMember,
  label: string,
  seen: Set<string>,
  warnings: string[],
): CouncilMember | null {
  const explicit = m.name.trim() !== "";
  // Blank names derive from the current model here, never at save (#1057).
  let slug = explicit ? councilMemberSlug(m.name) : councilNameFromModel(m.model) ?? "";
  if (slug === "" || !SLUG_PATTERN.test(slug)) {
    warnings.push(`${label}: name must slug to [a-z][a-z0-9-]* — entry dropped`);
    return null;
  }
  if (slug.length > MAX_COUNCIL_NAME) {
    warnings.push(`${label}: name over ${MAX_COUNCIL_NAME} characters — entry dropped`);
    return null;
  }
  if (seen.has(slug)) {
    if (explicit) {
      warnings.push(`${label}: duplicates another entry (slug "${slug}") — entry dropped`);
      return null;
    }
    // A derived collision renames instead of dropping: the member still
    // means "follow my model", and only a hand-typed name can truly clash.
    const base = slug.slice(0, MAX_COUNCIL_NAME - 2);
    for (let n = 2; seen.has(slug); n++) slug = `${base}-${n}`;
  }
  seen.add(slug);
  if (overLimit(m.instructions) || overLimit(m.model) || overLimit(m.name)) {
    warnings.push(`${label}: text over ${MAX_STRING} characters — entry dropped`);
    return null;
  }
  return {
    name: slug,
    model: hasText(m.model) ? m.model : null,
    instructions: hasText(m.instructions) ? m.instructions : null,
    enabled: m.enabled !== false,
  };
}

/**
 * The shared validator: a bad entry is a warning naming `sourceLabel`, never a
 * broken launch. Entry order is preserved; the launch set takes the first
 * MAX_COUNCIL_MEMBERS enabled entries that have a model. A blank name derives
 * from the member's current model at this seam (#1057), so storage keeps it
 * blank and switching models renames the member; a derived collision suffixes
 * `-2` instead of dropping the entry. The trial slot is validated last,
 * sharing `seen` with every member so it cannot collide with one; it never
 * counts against MAX_COUNCIL_MEMBERS.
 */
function validateEntries(doc: CouncilDocument, sourceLabel: string): ValidatedCouncil {
  const warnings: string[] = [];
  const entries: CouncilMember[] = [];
  const seen = new Set<string>();
  if (overLimit(doc.instructions))
    warnings.push(`${sourceLabel}: shared instructions over ${MAX_STRING} characters — dropped`);
  const instructions = overLimit(doc.instructions) ? null : doc.instructions;
  const list = doc.members.length > MAX_STORED_MEMBERS ? doc.members.slice(0, MAX_STORED_MEMBERS) : doc.members;
  if (doc.members.length > MAX_STORED_MEMBERS) {
    warnings.push(`${sourceLabel}: more than ${MAX_STORED_MEMBERS} members — the extras were dropped`);
  }
  for (const m of list) {
    const entry = validateMember(m, `${sourceLabel}: member "${m.name}"`, seen, warnings);
    if (entry !== null) entries.push(entry);
  }
  const members: CouncilMember[] = [];
  for (const m of entries) {
    if (!m.enabled) continue;
    const label = `${sourceLabel}: member "${m.name}"`;
    if (m.model === null) warnings.push(`${label}: no model — skipped`);
    else if (members.length >= MAX_COUNCIL_MEMBERS) {
      warnings.push(`${label}: more than ${MAX_COUNCIL_MEMBERS} members — skipped`);
    } else members.push(m);
  }
  let trialEntry: CouncilMember | null = null;
  let trial: CouncilMember | null = null;
  const storedTrial = doc.trial ?? null;
  if (storedTrial !== null) {
    trialEntry = validateMember(storedTrial, `${sourceLabel}: trial member "${storedTrial.name}"`, seen, warnings);
    if (trialEntry !== null && trialEntry.enabled) {
      const label = `${sourceLabel}: trial member "${trialEntry.name}"`;
      if (trialEntry.model === null) warnings.push(`${label}: no model — skipped`);
      else if (members.length === 0) warnings.push(`${label}: no council member launches — skipped`);
      else trial = trialEntry;
    }
  }
  return {
    entries,
    members,
    trial,
    instructions: hasText(instructions) ? instructions : null,
    configWarnings: warnings,
    trialEntry,
  };
}

/**
 * Semantic validation of a stored document (registry state, hand-edited or
 * migrated). `members` is the launch set.
 */
export function validateCouncilDocument(doc: CouncilDocument, sourceLabel: string): CouncilRosterResult {
  const { members, trial, instructions, configWarnings } = validateEntries(doc, sourceLabel);
  return { members, trial, instructions, configWarnings };
}

/**
 * The resolution chain: the project document wins when one exists, then the
 * global document, then an empty Council. `projectPath === null` (the global
 * Settings card, no project context) ignores any project document. `members`
 * is the bridge's launch set; `effective` keeps every validated entry for the
 * settings card.
 */
export function resolveCouncilRoster(projectPath: string | null, sources: CouncilRosterSources): CouncilRosterView {
  const useProject = projectPath !== null && sources.project !== null;
  const winner = useProject ? sources.project : sources.global;
  if (winner === null) {
    return {
      members: [],
      trial: null,
      effective: [],
      effectiveTrial: null,
      instructions: null,
      configWarnings: [],
      global: sources.global,
      project: sources.project,
    };
  }
  const validated = validateEntries(winner, useProject ? "this project's council" : "the global council");
  const scope = useProject ? ("project" as const) : ("user" as const);
  return {
    members: validated.members,
    trial: validated.trial,
    instructions: validated.instructions,
    configWarnings: validated.configWarnings,
    global: sources.global,
    project: sources.project,
    effective: validated.entries.map((m) => ({ ...m, sourceScope: scope })),
    effectiveTrial: validated.trialEntry === null ? null : { ...validated.trialEntry, sourceScope: scope },
  };
}

/** One catalog row, structurally compatible with CatalogModelOption. */
export interface CouncilSuggestionModel {
  readonly provider: string;
  readonly id: string;
}

/**
 * The suggested roster for #1055: when the council is enabled and the global
 * document was never authored, main seeds one from the user's FAVORITE models
 * (#1058) — at boot while `councilEnabled` is on, and again when the enable
 * handler flips it on — matched on the bare `provider/id` after
 * `parseModelRole` strips any `:level`; a favorite absent from the discovered
 * catalog is skipped, since a member must be launchable. Favorites are
 * explicit picks, so they keep their order and may share a provider; at most
 * MAX_COUNCIL_MEMBERS seed, and an uncurated user gets no fallback — `/council`
 * points at settings instead of being charged to arbitrary catalog models.
 * A roster document that exists (even a deliberately saved empty one) is never
 * re-seeded. Every member is seeded with a blank name (#1057) so it keeps
 * following its model; the validator derives the display name.
 */
export function suggestCouncilMembers(
  models: readonly CouncilSuggestionModel[],
  favorites: readonly string[],
): CouncilMember[] {
  const key = (m: CouncilSuggestionModel): string => `${m.provider}/${m.id}`;
  const byModel = new Map<string, CouncilSuggestionModel>();
  for (const m of models) {
    const k = key(m);
    if (!byModel.has(k)) byModel.set(k, m);
  }
  // Favorites in favorites order, nothing else (#1058).
  const members: CouncilMember[] = [];
  const picked = new Set<string>();
  for (const fav of favorites) {
    if (members.length >= MAX_COUNCIL_MEMBERS) break;
    const role = parseModelRole(fav);
    if (role === null) continue;
    const m = byModel.get(role.model);
    if (m === undefined || picked.has(role.model)) continue;
    picked.add(role.model);
    members.push({
      name: "",
      model: key(m),
      instructions: null,
      enabled: true,
    });
  }
  return members;
}
