import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextAtomic } from "./atomic-write";
import { isReviewDocument, type ReviewDocument } from "./review-config";
import { isSubagentModelMap, type SubagentModelMap } from "./subagent-model";
import { parseProposedPlans } from "./plan";
import { normalizeSidebarGroupName, SIDEBAR_GROUP_NAME_MAX_LENGTH } from "./sidebar-groups";
import { parseVaultRegistry } from "./vault-registry";
import { isKnowledgeHome } from "./vault-shared";
import type {
  AgentMode,
  ApprovalMode,
  GlassChrome,
  KnowledgeHome,
  OwnedSessionRecord,
  PlanFormat,
  PlanImplementationSource,
  SessionExperiment,
  ProjectRecord,
  RemoteBind,
  SessionMode,
  SidebarGroup,
  ServiceTier,
  UpdateTrain,
  TranscriptWidth,
  VaultNoteVoice,
  VaultRegistry,
} from "./types";

export interface RegistrySettings {
  defaultMode: SessionMode;
  /** Initial Plan/Build posture for newly created native sessions. */
  defaultAgentMode: AgentMode;
  /** Preferred first compaction method captured by fresh native sessions; null defers to omp. */
  defaultCompactionMethod: string | null;
  /** How the agent authors plans for review (see core/plan-extension.ts). */
  planFormat: PlanFormat;
  /** Idle window before an rpc-ui session's process is hibernated; 0 disables. */
  hibernateIdleMinutes: number;
  /** Silence window before a running turn is aborted as stream-stalled (issue #248); 0 disables. */
  streamStallAbortSeconds: number;
  /** Auto-answer a late advisor review (issue #111); app-level, default on. */
  advisorAutoReply: boolean;
  /** Bounded auto-continue after a turn dies to a stream stall (issue #251); app-level, default on. */
  stallAutoContinue: boolean;
  /** OS notifications for background-session attention states (issue #271); default on. */
  desktopNotifications: boolean;
  /** Seeds the advisor on/off for new sessions (issue #174); default off. */
  defaultAdvisor: boolean;
  /** Seeds omp's auto thinking selector for new sessions with no
   *  per-project thinking memory; default on. */
  defaultAutoThinking: boolean;
  modelFavorites: string[];
  /** Session-scope umbrella: subagents with no explicit choice run on the
   *  session's own model (ADR-0031); default on. */
  subagentModelInheritByDefault: boolean;
  /** Agent names from the last roster refresh (unpack + agent dirs). */
  agentRoster: string[];
  skipDeleteConfirmation: boolean;
  /** Global feature flag for the Experiments Lab + autoresearch bridge (issue #571); default off. */
  experimentsEnabled: boolean;
  /** Global mic button in every composer (issue #647); default off. */
  voiceInputEnabled: boolean;
  /** omp STT selector used app-wide; null = pick the preferred callable model. */
  sttModel: string | null;
  /** One-time migration marker (#274): the sessions array order is explicit; load never re-sorts it. */
  sessionOrderFrozen: boolean;
  /** One-time seed marker (issue #570): memory defaults were applied to omp's global layer once. */
  memoryDefaultsSeeded: boolean;
  /** One-time migration marker: legacy registries persisted the old off
   *  default; the first load on a new build flips it to on once. */
  autoThinkingDefaultSeeded: boolean;
  /**
   * App-wide reviewer roster for /code-review (issue #738): null = unset, so
   * projects fall through to the default reviewer. Replaces the user-scope
   * REVIEW.yml; the one-time import fills it from that file when first set.
   */
  reviewRoster: ReviewDocument | null;
  /** One-time import marker (issue #738): REVIEW.yml rosters were copied into app state once. */
  reviewRosterImported: boolean;
  /** First-run checklist dismissed; fresh installs open it once on the desktop shell. */
  gettingStartedSeen: boolean;
  /** Release version whose update card the user dismissed ("Later"). */
  dismissedAppUpdateVersion: string | null;
  /** omp version whose update/install card the user dismissed ("Later"). */
  dismissedOmpUpdateVersion: string | null;
  /** Active theme id (see renderer lib/themes.ts). */
  themeId: string;
  /** Active font family id (see renderer lib/font-families.ts). */
  fontFamilyId: string;
  /** Transcript column width step (see renderer lib/transcript-width.ts); default wide (issue #391). */
  transcriptWidth: TranscriptWidth;
  /** Chrome translucency step (see renderer lib/glass-chrome.ts); default subtle (issue #393). */
  glassChrome: GlassChrome;
  /** Active UI locale id; the renderer resolves it against its own locale table. */
  localeId: string;
  /** Check for a newer omp-ui release at launch. */
  appUpdateCheckOnLaunch: boolean;
  /** Release train for omp-ui's own update check (issue #493); default stable. */
  appUpdateTrain: UpdateTrain;
  /** Knowledge vault registry (CONTEXT.md "Vault registry", #764). */
  vaultRegistry: VaultRegistry;
  /** Voice the agent uses for vault note bodies (#793); default user. */
  vaultNoteVoice: VaultNoteVoice;
  /** Check for a newer omp binary at launch. */
  ompUpdateCheckOnLaunch: boolean;
  /** Embedded remote-access server: off by default (issue #37). */
  remoteEnabled: boolean;
  /** "localhost" binds 127.0.0.1; "lan" binds 0.0.0.0 and is an explicit, warned choice. */
  remoteBind: RemoteBind;
  remotePort: number;
  /** Bearer token; "" until first minted. */
  remoteToken: string;
  /** Salted scrypt hash (hex) of the remote sign-in password; "" = password auth off. */
  remotePasswordHash: string;
  /** Hex salt used for remotePasswordHash; "" = password auth off. */
  remotePasswordSalt: string;
  /** This app's stable identity for remote-instance joins (issue #416); "" until first minted. */
  instanceId: string;
}

interface RegistryData {
  schemaVersion: 1;
  settings: RegistrySettings;
  projects: ProjectRecord[];
  sessions: OwnedSessionRecord[];
  /** Sidebar groups in display order (CONTEXT.md "Sidebar group"); absent on legacy files. */
  sidebarGroups: SidebarGroup[];
}

interface SettingDescriptor<T> {
  fallback: () => T;
  parse: (value: unknown) => T;
}

type SettingDescriptors = {
  [K in keyof RegistrySettings]: SettingDescriptor<RegistrySettings[K]>;
};

export type SettingKey = keyof RegistrySettings;

function validatedSetting<T>(
  fallback: () => T,
  valid: (value: unknown) => value is T,
): SettingDescriptor<T> {
  return { fallback, parse: (value) => (valid(value) ? value : fallback()) };
}

/** Bundled omp v18.2.4 agents: the fresh-registry umbrella must work before
 *  the first on-demand `omp agents unpack` refresh. Unknown/new names join on
 *  refresh; stale names are harmless inert override keys. */
const DEFAULT_AGENT_ROSTER = ["reviewer", "scout", "security-reviewer", "sonic", "task"];

export const SETTINGS: SettingDescriptors = {
  // The native transcript is the primary mode (the sidebar's mode toggle
  // went away with #10); pty stays an explicit per-spawn menu choice.
  defaultMode: validatedSetting<SessionMode>(() => "rpc-ui", isSessionMode),
  defaultAgentMode: validatedSetting<AgentMode>(
    () => "plan",
    (value): value is AgentMode => value === "build",
  ),
  defaultCompactionMethod: validatedSetting<string | null>(
    () => null,
    (value): value is string | null =>
      value === null || (typeof value === "string" && value.length > 0),
  ),
  // HTML is the default review rendition (issue #109); the canonical
  // markdown plan is written either way.
  planFormat: validatedSetting<PlanFormat>(
    () => "html",
    (value): value is PlanFormat => value === "md",
  ),
  hibernateIdleMinutes: validatedSetting(
    () => 30,
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1440,
  ),
  streamStallAbortSeconds: validatedSetting(
    () => 180,
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 3600,
  ),
  advisorAutoReply: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  stallAutoContinue: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  desktopNotifications: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  // The app default is off (issue #174): omp config may say on, but a booted
  // app's preference wins for new sessions with no per-project memory.
  defaultAdvisor: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  // App default on (issue follow-up to #743): a fresh session with no
  // per-project thinking memory starts on omp's automatic selector.
  // Registries that persisted the old off default are flipped once at
  // load — see seedAutoThinkingDefault.
  defaultAutoThinking: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  modelFavorites: (() => {
    const fallback = (): string[] => [];
    return {
      fallback,
      parse: (value: unknown) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : fallback(),
    };
  })(),
  subagentModelInheritByDefault: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  agentRoster: (() => {
    const fallback = (): string[] => [...DEFAULT_AGENT_ROSTER];
    return {
      fallback,
      parse: (value: unknown) =>
        Array.isArray(value)
          ? value.filter((item): item is string => typeof item === "string")
          : fallback(),
    };
  })(),
  skipDeleteConfirmation: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  experimentsEnabled: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  voiceInputEnabled: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  sttModel: validatedSetting<string | null>(
    () => null,
    (value): value is string | null =>
      value === null || (typeof value === "string" && value.length > 0),
  ),
  sessionOrderFrozen: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  memoryDefaultsSeeded: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  autoThinkingDefaultSeeded: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  reviewRoster: validatedSetting<ReviewDocument | null>(
    () => null,
    (value): value is ReviewDocument | null => value === null || isReviewDocument(value),
  ),
  reviewRosterImported: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  gettingStartedSeen: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  dismissedAppUpdateVersion: validatedSetting<string | null>(
    () => null,
    (value): value is string => typeof value === "string",
  ),
  dismissedOmpUpdateVersion: validatedSetting<string | null>(
    () => null,
    (value): value is string => typeof value === "string",
  ),
  // Any non-empty string is kept as-is: theme ids are validated by the
  // renderer's own table, so registries written by newer builds remain intact.
  themeId: validatedSetting(
    () => "graphite",
    (value): value is string => typeof value === "string" && value !== "",
  ),
  // Any non-empty string is kept as-is: font family ids are validated by the
  // renderer's own table, so registries written by newer builds remain intact.
  fontFamilyId: validatedSetting(
    () => "default",
    (value): value is string => typeof value === "string" && value !== "",
  ),
  transcriptWidth: validatedSetting<TranscriptWidth>(
    () => "wide",
    (value): value is TranscriptWidth => value === "comfortable" || value === "full",
  ),
  glassChrome: validatedSetting<GlassChrome>(
    () => "subtle",
    (value): value is GlassChrome => value === "off" || value === "frosted",
  ),
  // Any non-empty string is kept as-is: locale ids are validated by the
  // renderer's own table, so registries written by newer builds remain intact.
  localeId: validatedSetting(
    () => "en",
    (value): value is string => typeof value === "string" && value !== "",
  ),
  appUpdateCheckOnLaunch: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  appUpdateTrain: validatedSetting<UpdateTrain>(
    () => "stable",
    (value): value is UpdateTrain => value === "nightly",
  ),
  vaultRegistry: { fallback: () => ({ vaults: [], defaultWriteVault: null }), parse: parseVaultRegistry },
  vaultNoteVoice: validatedSetting<VaultNoteVoice>(
    () => "user",
    (value): value is VaultNoteVoice => value === "assistant",
  ),
  ompUpdateCheckOnLaunch: validatedSetting(
    () => true,
    (value): value is boolean => typeof value === "boolean",
  ),
  remoteEnabled: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  remoteBind: validatedSetting<RemoteBind>(
    () => "localhost",
    (value): value is RemoteBind => value === "lan",
  ),
  remotePort: validatedSetting(
    () => 4677,
    (value): value is number =>
      typeof value === "number" && Number.isInteger(value) && value >= 1024 && value <= 65535,
  ),
  remoteToken: validatedSetting(
    () => "",
    (value): value is string => typeof value === "string",
  ),
  remotePasswordHash: validatedSetting(
    () => "",
    (value): value is string => typeof value === "string",
  ),
  remotePasswordSalt: validatedSetting(
    () => "",
    (value): value is string => typeof value === "string",
  ),
  instanceId: validatedSetting(
    () => "",
    (value): value is string => typeof value === "string",
  ),
};

const SETTING_KEYS = Object.keys(SETTINGS) as SettingKey[];

function buildSettings(
  valueFor: <K extends SettingKey>(key: K) => RegistrySettings[K],
): RegistrySettings {
  // Object.fromEntries loses the mapped key/value correlation even though the
  // exhaustive descriptor type and generic callback preserve it above.
  return Object.fromEntries(
    SETTING_KEYS.map((key) => [key, valueFor(key)]),
  ) as unknown as RegistrySettings;
}

function parseSettings(raw: object | undefined): RegistrySettings {
  const values = raw as Record<string, unknown> | undefined;
  return buildSettings((key) => SETTINGS[key].parse(values?.[key]));
}

function emptyRegistry(): RegistryData {
  // A fresh registry is born seeded: the on fallback already applies, and
  // persisting the marker keeps a later explicit off from being re-flipped.
  return {
    schemaVersion: 1,
    settings: {
      ...buildSettings((key) => SETTINGS[key].fallback()),
      autoThinkingDefaultSeeded: true,
    },
    projects: [],
    sessions: [],
    sidebarGroups: [],
  };
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === "pty" || value === "rpc-ui";
}

function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "always-ask" || value === "write" || value === "yolo";
}

function isServiceTier(value: unknown): value is ServiceTier {
  return value === "priority" || value === "ultrafast";
}

/**
 * Absent, or the present value passes `check`. For the rare field that
 * rejects null (agentMode) — everything else wants `optNullable`.
 */
function optional(value: object, key: string, check: (v: unknown) => boolean): boolean {
  return !(key in value) || check((value as Record<string, unknown>)[key]);
}

/** Absent, null, or the present value passes `check`. The legacy-field standard. */
function optNullable(value: object, key: string, check: (v: unknown) => boolean): boolean {
  return optional(value, key, (v) => v === null || check(v));
}

const isStr = (v: unknown): boolean => typeof v === "string";

function isProjectRecord(value: unknown): value is ProjectRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "path" in value &&
    typeof value.path === "string" &&
    "name" in value &&
    typeof value.name === "string" &&
    "addedAt" in value &&
    typeof value.addedAt === "string" &&
    // Preference fields post-date the first schema-1 records. Missing values
    // are legal and normalized to null by `parseRegistryData`.
    optNullable(value, "lastModel", isStr) &&
    optNullable(value, "lastThinkingLevel", isStr) &&
    optNullable(value, "lastAdvisor", (v) => typeof v === "boolean") &&
    optNullable(value, "lastAdvisorModel", isStr) &&
    optNullable(value, "defaultModel", isStr) &&
    optNullable(value, "defaultAdvisorModel", isStr) &&
    optNullable(value, "browserClock", (v) => typeof v === "boolean")
  );
}

function isPlanImplementationSource(value: unknown): value is PlanImplementationSource {
  return (
    value !== null &&
    typeof value === "object" &&
    "sourceTabId" in value &&
    typeof value.sourceTabId === "string" &&
    value.sourceTabId !== "" &&
    "planTitle" in value &&
    typeof value.planTitle === "string" &&
    value.planTitle !== "" &&
    "planFilePath" in value &&
    typeof value.planFilePath === "string" &&
    value.planFilePath !== ""
  );
}

/**
 * Experiment provenance (issue #559). Complete or dropped: `launchedBranch`
 * must be PRESENT (null = detached / not a repo), since a missing key would
 * silently unlink the session from its DB row.
 */
function isSessionExperiment(value: unknown): value is SessionExperiment {
  return (
    value !== null &&
    typeof value === "object" &&
    "goal" in value &&
    typeof value.goal === "string" &&
    "metric" in value &&
    typeof value.metric === "string" &&
    "unit" in value &&
    typeof value.unit === "string" &&
    "direction" in value &&
    (value.direction === "lower" || value.direction === "higher") &&
    "launchedBranch" in value &&
    (typeof value.launchedBranch === "string" || value.launchedBranch === null) &&
    "launchedAt" in value &&
    typeof value.launchedAt === "string"
  );
}

function isWorktreeShape(v: unknown): boolean {
  return (
    typeof v === "object" &&
    v !== null &&
    "path" in v &&
    typeof v.path === "string" &&
    "branch" in v &&
    typeof v.branch === "string" &&
    // base post-dates the first worktree records: absent is legal and
    // normalized to null on load; a present value must be a string.
    optNullable(v, "base", isStr)
  );
}

function isOwnedSessionRecord(value: unknown): value is OwnedSessionRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "tabId" in value &&
    typeof value.tabId === "string" &&
    // Required-nullable: absence drops the record; only null means "none yet".
    "sessionId" in value &&
    (typeof value.sessionId === "string" || value.sessionId === null) &&
    "lineageDir" in value &&
    typeof value.lineageDir === "string" &&
    "projectCwd" in value &&
    typeof value.projectCwd === "string" &&
    // Worktree post-dates the first schema-1 records: absent or null is legal
    // and normalized to null by `parseRegistryData` — a present value must
    // carry both the checkout path and its branch, not just one.
    optNullable(value, "worktree", isWorktreeShape) &&
    // Handoff provenance also post-dates the first schema-1 records. When
    // present it must be complete: partial metadata cannot identify a plan.
    optNullable(value, "planImplementationSource", isPlanImplementationSource) &&
    // Experiment provenance post-dates schema-1 too; same completeness rule.
    optNullable(value, "experiment", isSessionExperiment) &&
    "launchedAt" in value &&
    typeof value.launchedAt === "string" &&
    "mode" in value &&
    isSessionMode(value.mode) &&
    // agentMode post-dates existing records and normalizes to "build". A
    // PRESENT null must still drop the record, so this is `optional`, not
    // `optNullable` (the parser would have coerced it, but this filter runs
    // first).
    optional(value, "agentMode", (v) => v === "plan" || v === "build") &&
    optNullable(value, "compactionMethod", isStr) &&
    // approvalMode post-dates schema-1 records; absent loads as null (inherit).
    optNullable(value, "approvalMode", isApprovalMode) &&
    // serviceTier post-dates schema-1 records like approvalMode; absent
    // loads as null — no omp-ui-side selection (issue #719).
    optNullable(value, "serviceTier", isServiceTier) &&
    optNullable(value, "model", isStr) &&
    optNullable(value, "thinkingLevel", isStr) &&
    // advisorModel post-dates the first schema-1 records: requiring it here
    // would silently drop every session written before the advisor picker
    // shipped.
    optNullable(value, "advisorModel", isStr) &&
    optional(value, "advisor", (advisor) => typeof advisor === "boolean") &&
    // subagentModels post-dates the advisor picker records too; absent loads
    // as null, which is also the umbrella-applies state (ADR-0031).
    optNullable(value, "subagentModels", isSubagentModelMap) &&
    // Required-nullable pair: absence drops; null is the legal empty value.
    "cachedTitle" in value &&
    (typeof value.cachedTitle === "string" || value.cachedTitle === null) &&
    "cachedModified" in value &&
    (typeof value.cachedModified === "string" || value.cachedModified === null)
  );
}

/**
 * Validated parse. null → caller runs the quarantine recovery (unparseable
 * JSON, unknown schemaVersion, wrong-typed top-level arrays). Individual
 * malformed elements are dropped, not fatal — one hand-edited record must
 * not wipe the whole registry.
 */
function parseRegistryData(raw: unknown): RegistryData | null {
  if (raw === null || typeof raw !== "object") return null;
  if (!("schemaVersion" in raw) || raw.schemaVersion !== 1) return null;
  const projectsValue = "projects" in raw ? raw.projects : [];
  const sessionsValue = "sessions" in raw ? raw.sessions : [];
  if (!Array.isArray(projectsValue) || !Array.isArray(sessionsValue)) return null;
  // These maps are what keeps old on-disk registries loadable: the guards
  // deliberately accept absent optional fields, so the spread alone cannot
  // guarantee the now-required keys exist. Do not "simplify" them away.
  // (Issue #294 flipped the record types to required-with-null.)
  const projects = projectsValue
    .filter(isProjectRecord)
    .map((p) => ({
      ...p,
      lastModel: p.lastModel ?? null,
      lastThinkingLevel: p.lastThinkingLevel ?? null,
      lastAdvisor: p.lastAdvisor ?? null,
      lastAdvisorModel: p.lastAdvisorModel ?? null,
      defaultModel: p.defaultModel ?? null,
      defaultAdvisorModel: p.defaultAdvisorModel ?? null,
      browserClock: p.browserClock === true,
      // Never a validity gate (the proposedPlans rule): a malformed roster
      // normalizes to null here so the record always survives.
      reviewRoster: isReviewDocument(p.reviewRoster) ? p.reviewRoster : null,
      // Like reviewRoster, malformed preferences do not invalidate the project.
      knowledgeHome: isKnowledgeHome(p.knowledgeHome) ? p.knowledgeHome : null,
    }));
  const sessions = sessionsValue
    .filter(isOwnedSessionRecord)
    .map((s) => ({
      ...s,
      advisor: s.advisor === true,
      model: s.model ?? null,
      thinkingLevel: s.thinkingLevel ?? null,
      advisorModel: s.advisorModel ?? null,
      compactionMethod: s.compactionMethod ?? null,
      approvalMode: s.approvalMode ?? null,
      serviceTier: s.serviceTier ?? null,
      subagentModels: s.subagentModels ?? null,
      agentMode: s.agentMode ?? "build",
      worktree: s.worktree
        ? { path: s.worktree.path, branch: s.worktree.branch, base: s.worktree.base ?? null }
        : null,
      planImplementationSource: s.planImplementationSource ?? null,
      experiment: s.experiment ?? null,
      // Never a validity gate: a malformed history row drops only itself, so
      // the session record (and its transcript link) always survives.
      proposedPlans: parseProposedPlans(s.proposedPlans),
    }));
  const settingsValue =
    "settings" in raw && raw.settings !== null && typeof raw.settings === "object"
      ? raw.settings
      : undefined;
  const settings = parseSettings(settingsValue);
  const sidebarGroups = parseSidebarGroups(
    "sidebarGroups" in raw ? raw.sidebarGroups : undefined,
    projects,
  );
  return { schemaVersion: 1, settings, projects, sessions, sidebarGroups };
}

/**
 * Lenient sidebar-group parse: never a quarantine trigger. Malformed groups
 * (no id, duplicate id, unusable name) drop; paths keep only registered
 * projects not claimed by an earlier group (first group wins). Same-named
 * groups both survive — only create/rename enforce uniqueness.
 */
function parseSidebarGroups(raw: unknown, projects: readonly ProjectRecord[]): SidebarGroup[] {
  if (!Array.isArray(raw)) return [];
  const registered = new Set(projects.map((p) => p.path));
  const claimed = new Set<string>();
  const seenIds = new Set<string>();
  const groups: SidebarGroup[] = [];
  for (const value of raw) {
    if (value === null || typeof value !== "object") continue;
    const entry = value as Record<string, unknown>;
    const { id } = entry;
    if (typeof id !== "string" || id.length === 0 || seenIds.has(id)) continue;
    const name = typeof entry.name === "string" ? normalizeSidebarGroupName(entry.name) : null;
    if (name === null) continue;
    seenIds.add(id);
    const projectPaths: string[] = [];
    if (Array.isArray(entry.projectPaths)) {
      for (const p of entry.projectPaths) {
        if (typeof p !== "string" || !registered.has(p) || claimed.has(p)) continue;
        claimed.add(p);
        projectPaths.push(p);
      }
    }
    groups.push({ id, name, collapsed: entry.collapsed === true, projectPaths });
  }
  return groups;
}

/**
 * Normalized group name for create/rename, or a user-facing throw: bad length,
 * or a case-insensitive duplicate of any group other than `exceptId`.
 */
function assertGroupName(draft: RegistryData, raw: string, exceptId: string | null): string {
  const name = normalizeSidebarGroupName(raw);
  if (name === null) {
    throw new Error(`Group names must be 1–${SIDEBAR_GROUP_NAME_MAX_LENGTH} characters.`);
  }
  const lower = name.toLocaleLowerCase();
  const clash = draft.sidebarGroups.some(
    (group) => group.id !== exceptId && group.name.toLocaleLowerCase() === lower,
  );
  if (clash) throw new Error(`A group named “${name}” already exists.`);
  return name;
}

const GROUP_GONE = "That group no longer exists.";

/**
 * Exclusive membership change: `projectPath` leaves every group, joins
 * `groupId` (null = ungrouped), and moves to the end of `projects` so it sits
 * last in its new segment. false (no mutation) when the project is
 * unregistered or already in that segment. The caller checks `groupId` exists.
 */
function placeProject(draft: RegistryData, projectPath: string, groupId: string | null): boolean {
  if (!draft.projects.some((p) => p.path === projectPath)) return false;
  const current = draft.sidebarGroups.find((g) => g.projectPaths.includes(projectPath))?.id ?? null;
  if (current === groupId) return false;
  for (const group of draft.sidebarGroups) {
    group.projectPaths = group.projectPaths.filter((p) => p !== projectPath);
  }
  if (groupId !== null) {
    draft.sidebarGroups.find((g) => g.id === groupId)?.projectPaths.push(projectPath);
  }
  moveBefore(draft.projects, (p) => p.path, projectPath, null);
  return true;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}

function writeRegistry(file: string, data: RegistryData): void {
  writeTextAtomic(file, `${JSON.stringify(data, null, 2)}\n`);
}

/**
 * Splices `key`'s element to sit immediately before `beforeKey`'s; a null or
 * vanished `beforeKey` moves it to the end. "Before itself" is the caller's
 * "leave it put": handled here because the splice would hide the element from
 * the beforeKey lookup and the miss would append it. Returns whether the
 * array changed (unknown source key: false, no mutation).
 */
function moveBefore<T>(
  list: T[],
  keyOf: (item: T) => string,
  key: string,
  beforeKey: string | null,
): boolean {
  if (beforeKey === key) return false;
  const from = list.findIndex((item) => keyOf(item) === key);
  if (from === -1) return false;
  const before = beforeKey === null ? -1 : list.findIndex((item) => keyOf(item) === beforeKey);
  const appends = beforeKey === null || before === -1;
  if ((appends && from === list.length - 1) || before === from + 1) return false;
  const [moved] = list.splice(from, 1);
  // `to` is looked up after the splice, so indices have already shifted —
  // "insert before the removed element's neighbour" stays correct.
  if (!appends) {
    const to = list.findIndex((item) => keyOf(item) === beforeKey);
    list.splice(to, 0, moved);
  } else {
    list.push(moved);
  }
  return true;
}

/**
 * One-time freeze (#274): legacy registries ordered `sessions` by insertion,
 * and buildState re-sorted by recency. Before the first ordered write, rewrite
 * the persisted array to that same recency order and mark it frozen, so the
 * upgrade is invisible and no later load ever re-sorts a user's arrangement.
 */
function seedSessionOrder(file: string, data: RegistryData): void {
  if (data.settings.sessionOrderFrozen || data.sessions.length === 0) return;
  const recencyDesc = (a: OwnedSessionRecord, b: OwnedSessionRecord): number =>
    (b.cachedModified ?? b.launchedAt).localeCompare(a.cachedModified ?? a.launchedAt);
  const ordered: OwnedSessionRecord[] = [];
  for (const project of data.projects) {
    // Array.prototype.sort is stable, so equal timestamps keep file order.
    ordered.push(...data.sessions.filter((s) => s.projectCwd === project.path).sort(recencyDesc));
  }
  // Records naming an unregistered project (hand-edited registries) keep
  // their slots too, recency-ordered, after the registered buckets.
  const known = new Set(data.projects.map((p) => p.path));
  ordered.push(...data.sessions.filter((s) => !known.has(s.projectCwd)).sort(recencyDesc));
  data.sessions = ordered;
  data.settings.sessionOrderFrozen = true;
  writeRegistry(file, data);
}

/**
 * One-time default flip: legacy registries persisted the old off default for
 * `defaultAutoThinking` (the settings object is always written in full), so a
 * bare `false` cannot be told apart from the old default. Flip it to on once
 * and mark the registry seeded; later explicit off values persist the marker
 * and are never revisited.
 */
function seedAutoThinkingDefault(file: string, data: RegistryData): void {
  if (data.settings.autoThinkingDefaultSeeded) return;
  data.settings.autoThinkingDefaultSeeded = true;
  data.settings.defaultAutoThinking = true;
  writeRegistry(file, data);
}

/**
 * omp-ui's own state (projects + owned sessions), persisted as JSON.
 * Records are per lineage (one per spawned process); `sessionId: null` is
 * valid at every layer — a session can live minutes or forever without a file.
 */
export class Registry {
  readonly #file: string;
  #data: RegistryData;

  private constructor(file: string, data: RegistryData) {
    this.#file = file;
    this.#data = data;
  }

  static load(file: string): Registry {
    let raw: string;
    try {
      raw = fs.readFileSync(file, "utf8");
    } catch {
      return new Registry(file, emptyRegistry());
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      parsed = undefined;
    }
    const data = parseRegistryData(parsed);
    if (data) {
      seedSessionOrder(file, data);
      seedAutoThinkingDefault(file, data);
      return new Registry(file, data);
    }
    // Corrupt (or unknown schemaVersion): quarantine and start empty.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // best effort — starting empty either way
    }
    return new Registry(file, emptyRegistry());
  }

  #transaction(mutate: (draft: RegistryData) => boolean): boolean {
    const draft = structuredClone(this.#data);
    if (!mutate(draft)) return false;
    writeRegistry(this.#file, draft);
    this.#data = draft;
    return true;
  }

  /**
   * Reads a persisted preference. `modelFavorites`, `reviewRoster` and
   * `vaultRegistry` are reference-typed; callers replace, never mutate. This
   * hands out the live internal value — favorites access must go through
   * `getFavorites()`/`toggleFavorite()`. Cloning every read was rejected: hot
   * paths (the hibernate timer arms read `hibernateIdleMinutes` per event)
   * would allocate for nothing.
   */
  getSetting<K extends SettingKey>(key: K): RegistrySettings[K] {
    return this.#data.settings[key];
  }

  /**
   * A snapshot of every setting in one object — same validated values the
   * renderer reads field-by-field via getSetting, for whole-state consumers
   * (the diagnostics bundle). Not live; re-read per use.
   */
  settingsSnapshot(): RegistrySettings {
    return buildSettings((key) => this.#data.settings[key]);
  }

  /**
   * Writes a persisted preference and saves. An Object.is-equal value is a
   * no-op: nothing is written.
   */
  setSetting<K extends SettingKey>(key: K, value: RegistrySettings[K]): void {
    this.#transaction((draft) => {
      if (Object.is(draft.settings[key], value)) return false;
      draft.settings[key] = value;
      return true;
    });
  }

  /** Writes a set of preferences as one persisted transaction. */
  setSettings(patch: Partial<RegistrySettings>): void {
    this.#transaction((draft) => {
      const changed = SETTING_KEYS.some(
        (key) => key in patch && !Object.is(draft.settings[key], patch[key]),
      );
      if (!changed) return false;
      Object.assign(draft.settings, patch);
      return true;
    });
  }

  get projects(): readonly ProjectRecord[] {
    return deepFreeze(structuredClone(this.#data.projects));
  }

  get sidebarGroups(): readonly SidebarGroup[] {
    return deepFreeze(structuredClone(this.#data.sidebarGroups));
  }

  get sessions(): readonly OwnedSessionRecord[] {
    return deepFreeze(structuredClone(this.#data.sessions));
  }


  addProject(projectPath: string): ProjectRecord {
    const existing = this.#data.projects.find((project) => project.path === projectPath);
    if (existing) return structuredClone(existing);
    const record: ProjectRecord = {
      path: projectPath,
      name: path.basename(projectPath),
      addedAt: new Date().toISOString(),
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
      defaultModel: null,
      defaultAdvisorModel: null,
      browserClock: false,
      reviewRoster: null,
      knowledgeHome: null,
    };
    this.#transaction((draft) => {
      draft.projects.push(record);
      return true;
    });
    return structuredClone(record);
  }

  /**
   * Cascades to the project's session records and prunes it from its sidebar
   * group; files on disk are never touched.
   */
  removeProject(projectPath: string): void {
    this.#transaction((draft) => {
      const projectCount = draft.projects.length;
      const sessionCount = draft.sessions.length;
      draft.projects = draft.projects.filter((project) => project.path !== projectPath);
      draft.sessions = draft.sessions.filter((session) => session.projectCwd !== projectPath);
      let grouped = false;
      for (const group of draft.sidebarGroups) {
        const before = group.projectPaths.length;
        group.projectPaths = group.projectPaths.filter((p) => p !== projectPath);
        grouped ||= group.projectPaths.length !== before;
      }
      return (
        grouped ||
        draft.projects.length !== projectCount ||
        draft.sessions.length !== sessionCount
      );
    });
  }

  /**
   * Moves `projectPath` to sit immediately before `beforePath` in the sidebar
   * order; a null `beforePath` (or one that is not registered) appends the
   * project to the end. The order is the persisted registry array order, so the
   * change survives a restart. An unknown `projectPath`, and a `beforePath`
   * equal to it, are no-ops (no save).
   */
  moveProject(projectPath: string, beforePath: string | null): void {
    this.#transaction((draft) =>
      moveBefore(draft.projects, (project) => project.path, projectPath, beforePath),
    );
  }

  /**
   * Appends a new sidebar group; a registered `projectPath` moves into it
   * (last). An unregistered path still creates the group, empty. Throws a
   * user-facing message for a bad or duplicate name (nothing written).
   */
  createSidebarGroup(name: string, projectPath: string | null): SidebarGroup {
    let created!: SidebarGroup;
    this.#transaction((draft) => {
      created = {
        id: randomUUID(),
        name: assertGroupName(draft, name, null),
        collapsed: false,
        projectPaths: [],
      };
      draft.sidebarGroups.push(created);
      if (projectPath !== null) placeProject(draft, projectPath, created.id);
      return true;
    });
    return structuredClone(created);
  }

  /** Unknown id throws "That group no longer exists."; the same normalized name writes nothing. */
  renameSidebarGroup(groupId: string, name: string): void {
    this.#transaction((draft) => {
      const group = draft.sidebarGroups.find((g) => g.id === groupId);
      if (!group) throw new Error(GROUP_GONE);
      const next = assertGroupName(draft, name, groupId);
      if (next === group.name) return false;
      group.name = next;
      return true;
    });
  }

  /** Members become ungrouped and keep their order. Unknown id: no-op. */
  removeSidebarGroup(groupId: string): void {
    this.#transaction((draft) => {
      const count = draft.sidebarGroups.length;
      draft.sidebarGroups = draft.sidebarGroups.filter((g) => g.id !== groupId);
      return draft.sidebarGroups.length !== count;
    });
  }

  /** `moveBefore` over the group order: null (or unknown) `beforeGroupId` appends; unknown `groupId` no-op. */
  moveSidebarGroup(groupId: string, beforeGroupId: string | null): void {
    this.#transaction((draft) => moveBefore(draft.sidebarGroups, (g) => g.id, groupId, beforeGroupId));
  }

  /** Unknown id or the current value: no write. */
  setSidebarGroupCollapsed(groupId: string, collapsed: boolean): void {
    this.#transaction((draft) => {
      const group = draft.sidebarGroups.find((g) => g.id === groupId);
      if (!group || group.collapsed === collapsed) return false;
      group.collapsed = collapsed;
      return true;
    });
  }

  /**
   * Exclusive membership change; the project then sits last in its new
   * segment. Unknown project: no-op. Unknown non-null group throws "That
   * group no longer exists." Already in the target segment: no write.
   */
  setProjectSidebarGroup(projectPath: string, groupId: string | null): void {
    this.#transaction((draft) => {
      if (groupId !== null && !draft.sidebarGroups.some((g) => g.id === groupId)) {
        throw new Error(GROUP_GONE);
      }
      return placeProject(draft, projectPath, groupId);
    });
  }

  /** Records an advisor choice for this session and the next one in its project. */
  setSessionAdvisor(tabId: string, advisor: boolean, advisorModel: string | null): void {
    this.#transaction((draft) => {
      const record = draft.sessions.find((session) => session.tabId === tabId);
      if (!record) return false;
      const project = draft.projects.find((candidate) => candidate.path === record.projectCwd);
      if (
        record.advisor === advisor &&
        record.advisorModel === advisorModel &&
        (!project ||
          (project.lastAdvisor === advisor && project.lastAdvisorModel === advisorModel))
      ) return false;
      record.advisor = advisor;
      record.advisorModel = advisorModel;
      if (project) {
        project.lastAdvisor = advisor;
        project.lastAdvisorModel = advisorModel;
      }
      return true;
    });
  }

  /**
   * Pins this session's omp approval mode (issue #681, ADR-0038). Session
   * scope only, deliberately without setSessionAdvisor's project last-used
   * mirror: a new session inherits omp's own config, not what some earlier
   * session was pinned to.
   */
  setSessionApprovalMode(tabId: string, mode: ApprovalMode | null): void {
    this.#transaction((draft) => {
      const record = draft.sessions.find((session) => session.tabId === tabId);
      if (!record) return false;
      if (record.approvalMode === mode) return false;
      record.approvalMode = mode;
      return true;
    });
  }

  /** Pins the tier this session's fast selection names (issue #719). Session
   * scope only — no project last-used mirror, same as approvalMode. */
  setSessionServiceTier(tabId: string, tier: ServiceTier | null): void {
    this.#transaction((draft) => {
      const record = draft.sessions.find((session) => session.tabId === tabId);
      if (!record) return false;
      if (record.serviceTier === tier) return false;
      record.serviceTier = tier;
      return true;
    });
  }

  /** Records the main model choice for this session and the next one in its project. */
  setSessionModel(tabId: string, model: string | null, thinkingLevel: string | null): void {
    this.#transaction((draft) => {
      const record = draft.sessions.find((session) => session.tabId === tabId);
      if (!record) return false;
      const project = draft.projects.find((candidate) => candidate.path === record.projectCwd);
      if (
        record.model === model &&
        record.thinkingLevel === thinkingLevel &&
        (!project ||
          (project.lastModel === model && project.lastThinkingLevel === thinkingLevel))
      ) return false;
      record.model = model;
      record.thinkingLevel = thinkingLevel;
      if (project) {
        project.lastModel = model;
        project.lastThinkingLevel = thinkingLevel;
      }
      return true;
    });
  }

  /**
   * Records this session's subagent model choices (ADR-0031). Session-scope
   * only, deliberately without setSessionModel's project last-used side
   * effect: subagent choices are not "last used" memory.
   */
  setSessionSubagentModels(tabId: string, subagentModels: SubagentModelMap | null): void {
    this.#transaction((draft) => {
      const record = draft.sessions.find((session) => session.tabId === tabId);
      if (!record) return false;
      if (JSON.stringify(record.subagentModels) === JSON.stringify(subagentModels)) return false;
      record.subagentModels = subagentModels === null ? null : { ...subagentModels };
      return true;
    });
  }

  /** Pins (or clears) the project's default main model for new sessions (issue #257). */
  setProjectDefaultModel(projectPath: string, model: string | null): void {
    this.#transaction((draft) => {
      const project = draft.projects.find((candidate) => candidate.path === projectPath);
      if (!project || project.defaultModel === model) return false;
      project.defaultModel = model;
      return true;
    });
  }

  /** Pins (or clears) the project's default advisor model for new sessions (issue #257). */
  setProjectDefaultAdvisorModel(projectPath: string, model: string | null): void {
    this.#transaction((draft) => {
      const project = draft.projects.find((candidate) => candidate.path === projectPath);
      if (!project || project.defaultAdvisorModel === model) return false;
      project.defaultAdvisorModel = model;
      return true;
    });
  }

  /** Turns the project's browser clock on or off. Unknown project or unchanged value: no save. */
  setProjectBrowserClock(projectPath: string, on: boolean): void {
    this.#transaction((draft) => {
      const project = draft.projects.find((candidate) => candidate.path === projectPath);
      if (!project || project.browserClock === on) return false;
      project.browserClock = on;
      return true;
    });
  }

  /**
   * Replaces (or clears, with null) one project's reviewer roster (issue #738).
   * Unknown project or a deep-equal value: no save — the document is an
   * object, so an Object.is seam would always look "changed".
   */
  setProjectReviewRoster(projectPath: string, document: ReviewDocument | null): boolean {
    return this.#transaction((draft) => {
      const project = draft.projects.find((candidate) => candidate.path === projectPath);
      if (!project) return false;
      if (JSON.stringify(project.reviewRoster ?? null) === JSON.stringify(document ?? null)) return false;
      project.reviewRoster = document;
      return true;
    });
  }

  /**
   * Replaces (or clears, with null) one project's Knowledge home (issue #766).
   * Unknown project or an equal value: no save. Compared on normalized copies so
   * a key-order difference from disk is not a change.
   */
  setProjectKnowledgeHome(projectPath: string, home: KnowledgeHome | null): boolean {
    const next: KnowledgeHome | null =
      home === null ? null : home.vault === undefined ? { home: home.home } : { home: home.home, vault: home.vault };
    return this.#transaction((draft) => {
      const project = draft.projects.find((candidate) => candidate.path === projectPath);
      if (!project) return false;
      const prev = project.knowledgeHome;
      const prevNorm =
        prev === null ? null : prev.vault === undefined ? { home: prev.home } : { home: prev.home, vault: prev.vault };
      if (JSON.stringify(prevNorm) === JSON.stringify(next)) return false;
      project.knowledgeHome = next;
      return true;
    });
  }

  addSession(record: OwnedSessionRecord): OwnedSessionRecord {
    this.#transaction((draft) => {
      // New sessions take the TOP of their project (#274): splice ahead of the
      // first record of the same project; a project's first session just appends.
      // Cross-project interleaving in the array is irrelevant — grouping filters
      // per project — but within-project order is the persisted sidebar order.
      const first = draft.sessions.findIndex((session) => session.projectCwd === record.projectCwd);
      const stored = structuredClone(record);
      if (first === -1) draft.sessions.push(stored);
      else draft.sessions.splice(first, 0, stored);
      return true;
    });
    return structuredClone(record);
  }

  removeSession(tabId: string): void {
    this.#transaction((draft) => {
      const count = draft.sessions.length;
      draft.sessions = draft.sessions.filter((session) => session.tabId !== tabId);
      return draft.sessions.length !== count;
    });
  }

  /**
   * Moves `tabId` to sit immediately before `beforeTabId`'s record in the
   * persisted sidebar order (#274); a null or vanished `beforeTabId` appends
   * the record — the bottom of its project, since grouping filters per
   * project. An unknown `tabId`, and a `beforeTabId` equal to `tabId`, are
   * no-ops (no save). Moving a handoff tree's root moves the tree: rows render
   * by their root's position regardless of array adjacency.
   */
  moveSession(tabId: string, beforeTabId: string | null): void {
    this.#transaction((draft) =>
      moveBefore(draft.sessions, (session) => session.tabId, tabId, beforeTabId),
    );
  }

  updateSession(
    tabId: string,
    patch: Partial<Omit<OwnedSessionRecord, "tabId">>,
  ): OwnedSessionRecord | undefined {
    const existing = this.#data.sessions.find((session) => session.tabId === tabId);
    if (!existing) return undefined;
    this.#transaction((draft) => {
      const record = draft.sessions.find((session) => session.tabId === tabId)!;
      const changed = (Object.keys(patch) as Array<keyof typeof patch>).some(
        (key) => !Object.is(record[key], patch[key]),
      );
      if (!changed) return false;
      Object.assign(record, patch);
      return true;
    });
    return structuredClone(this.#data.sessions.find((session) => session.tabId === tabId)!);
  }

  getFavorites(): string[] {
    return [...this.getSetting("modelFavorites")];
  }

  toggleFavorite(key: string): void {
    this.#transaction((draft) => {
      const current = draft.settings.modelFavorites;
      const index = current.indexOf(key);
      draft.settings.modelFavorites =
        index === -1 ? [...current, key] : current.filter((favorite) => favorite !== key);
      return true;
    });
  }
}

/**
 * Every tabId descended from rootTabId through the one-way
 * planImplementationSource relation (issue #309). Depth-first preorder,
 * children visited in registry (input) order; each tabId appears at most
 * once. Self-references are not followed; cycles and malformed snapshots
 * end their walk without error. A missing root still yields the records
 * that point at it.
 */
export function planHandoffDescendants(
  sessions: readonly Pick<OwnedSessionRecord, "tabId" | "planImplementationSource">[],
  rootTabId: string,
): string[] {
  const children = new Map<string, string[]>();
  for (const session of sessions) {
    const source = session.planImplementationSource;
    if (source === null || source.sourceTabId === session.tabId) continue;
    if (typeof source.sourceTabId !== "string") continue;
    const list = children.get(source.sourceTabId);
    if (list !== undefined) list.push(session.tabId);
    else children.set(source.sourceTabId, [session.tabId]);
  }
  const out: string[] = [];
  const visited = new Set<string>([rootTabId]);
  const visit = (id: string): void => {
    for (const child of children.get(id) ?? []) {
      if (visited.has(child)) continue;
      visited.add(child);
      out.push(child);
      visit(child);
    }
  };
  visit(rootTabId);
  return out;
}
