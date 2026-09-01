import * as fs from "node:fs";
import * as path from "node:path";
import { writeTextAtomic } from "./atomic-write";
import type {
  AgentMode,
  OwnedSessionRecord,
  PlanFormat,
  PlanImplementationSource,
  ProjectRecord,
  RemoteBind,
  SessionMode,
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
  modelFavorites: string[];
  skipDeleteConfirmation: boolean;
  /** One-time migration marker (#274): the sessions array order is explicit; load never re-sorts it. */
  sessionOrderFrozen: boolean;
  /** Release version whose update card the user dismissed ("Later"). */
  dismissedAppUpdateVersion: string | null;
  /** omp version whose update/install card the user dismissed ("Later"). */
  dismissedOmpUpdateVersion: string | null;
  /** Active theme id (see renderer lib/themes.ts). */
  themeId: string;
  /** Active font family id (see renderer lib/font-families.ts). */
  fontFamilyId: string;
  /** Active UI locale id; the renderer resolves it against its own locale table. */
  localeId: string;
  /** Check for a newer omp-ui release at launch. */
  appUpdateCheckOnLaunch: boolean;
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
}

interface RegistryData {
  schemaVersion: 1;
  settings: RegistrySettings;
  projects: ProjectRecord[];
  sessions: OwnedSessionRecord[];
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
  skipDeleteConfirmation: validatedSetting(
    () => false,
    (value): value is boolean => typeof value === "boolean",
  ),
  sessionOrderFrozen: validatedSetting(
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
  return {
    schemaVersion: 1,
    settings: buildSettings((key) => SETTINGS[key].fallback()),
    projects: [],
    sessions: [],
  };
}

function isSessionMode(value: unknown): value is SessionMode {
  return value === "pty" || value === "rpc-ui";
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
    optNullable(value, "defaultAdvisorModel", isStr)
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
    optNullable(value, "model", isStr) &&
    optNullable(value, "thinkingLevel", isStr) &&
    // advisorModel post-dates the first schema-1 records: requiring it here
    // would silently drop every session written before the advisor picker
    // shipped.
    optNullable(value, "advisorModel", isStr) &&
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
    }));
  const sessions = sessionsValue
    .filter(isOwnedSessionRecord)
    .map((s) => ({
      ...s,
      model: s.model ?? null,
      thinkingLevel: s.thinkingLevel ?? null,
      advisorModel: s.advisorModel ?? null,
      compactionMethod: s.compactionMethod ?? null,
      agentMode: s.agentMode ?? "build",
      worktree: s.worktree
        ? { path: s.worktree.path, branch: s.worktree.branch, base: s.worktree.base ?? null }
        : null,
      planImplementationSource: s.planImplementationSource ?? null,
    }));
  const settingsValue =
    "settings" in raw && raw.settings !== null && typeof raw.settings === "object"
      ? raw.settings
      : undefined;
  const settings = parseSettings(settingsValue);
  return { schemaVersion: 1, settings, projects, sessions };
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
   * Reads a persisted preference. `modelFavorites` is the only reference-typed
   * setting, and this hands out the live internal array — favorites access
   * must go through `getFavorites()`/`toggleFavorite()`. Cloning every read
   * was rejected: hot paths (the hibernate timer arms read
   * `hibernateIdleMinutes` per event) would allocate for nothing, and every
   * other setting is a primitive.
   */
  getSetting<K extends SettingKey>(key: K): RegistrySettings[K] {
    return this.#data.settings[key];
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
    };
    this.#transaction((draft) => {
      draft.projects.push(record);
      return true;
    });
    return structuredClone(record);
  }

  /** Cascades to the project's session records; files on disk are never touched. */
  removeProject(projectPath: string): void {
    this.#transaction((draft) => {
      const projectCount = draft.projects.length;
      const sessionCount = draft.sessions.length;
      draft.projects = draft.projects.filter((project) => project.path !== projectPath);
      draft.sessions = draft.sessions.filter((session) => session.projectCwd !== projectPath);
      return draft.projects.length !== projectCount || draft.sessions.length !== sessionCount;
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
