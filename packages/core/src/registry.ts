import * as fs from "node:fs";
import * as path from "node:path";
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
  /** How the agent authors plans for review (see core/plan-extension.ts). */
  planFormat: PlanFormat;
  /** Idle window before an rpc-ui session's process is hibernated; 0 disables. */
  hibernateIdleMinutes: number;
  /** Silence window before a running turn is aborted as stream-stalled (issue #248); 0 disables. */
  streamStallAbortSeconds: number;
  /** Auto-answer a late advisor review (issue #111); app-level, default on. */
  advisorAutoReply: boolean;
  /** Seeds the advisor on/off for new sessions (issue #174); default off. */
  defaultAdvisor: boolean;
  modelFavorites: string[];
  skipDeleteConfirmation: boolean;
  /** Release version whose update card the user dismissed ("Later"). */
  dismissedAppUpdateVersion: string | null;
  /** omp version whose update/install card the user dismissed ("Later"). */
  dismissedOmpUpdateVersion: string | null;
  /** Active theme id (see renderer lib/themes.ts). */
  themeId: string;
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
    // are legal and normalized by `parseRegistryData`.
    (!("lastModel" in value) || value.lastModel === null || typeof value.lastModel === "string") &&
    (!("lastThinkingLevel" in value) ||
      value.lastThinkingLevel === null ||
      typeof value.lastThinkingLevel === "string") &&
    (!("lastAdvisor" in value) ||
      value.lastAdvisor === null ||
      typeof value.lastAdvisor === "boolean") &&
    (!("lastAdvisorModel" in value) ||
      value.lastAdvisorModel === null ||
      typeof value.lastAdvisorModel === "string")
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

function isOwnedSessionRecord(value: unknown): value is OwnedSessionRecord {
  return (
    value !== null &&
    typeof value === "object" &&
    "tabId" in value &&
    typeof value.tabId === "string" &&
    "sessionId" in value &&
    (typeof value.sessionId === "string" || value.sessionId === null) &&
    "lineageDir" in value &&
    typeof value.lineageDir === "string" &&
    "projectCwd" in value &&
    typeof value.projectCwd === "string" &&
    // worktree post-dates the first schema-1 records, so absent or null is
    // legal and normalized to null by `parseRegistryData` — a present value
    // must carry both the checkout path and its branch, not just one.
    (!("worktree" in value) ||
      value.worktree === null ||
      (typeof value.worktree === "object" &&
        value.worktree !== null &&
        "path" in value.worktree &&
        typeof value.worktree.path === "string" &&
        "branch" in value.worktree &&
        typeof value.worktree.branch === "string")) &&
    // Handoff provenance also post-dates the first schema-1 records. When
    // present it must be complete: partial metadata cannot identify a plan.
    (!("planImplementationSource" in value) ||
      value.planImplementationSource === null ||
      isPlanImplementationSource(value.planImplementationSource)) &&
    "launchedAt" in value &&
    typeof value.launchedAt === "string" &&
    "mode" in value &&
    isSessionMode(value.mode) &&
    (!("model" in value) || typeof value.model === "string" || value.model === null) &&
    (!("thinkingLevel" in value) ||
      typeof value.thinkingLevel === "string" ||
      value.thinkingLevel === null) &&
    "advisor" in value &&
    typeof value.advisor === "boolean" &&
    // advisorModel post-dates the first schema-1 records, so absent is legal
    // and normalized to null by `parseRegistryData` — requiring it here would
    // silently drop every session written before the advisor picker shipped.
    (!("advisorModel" in value) ||
      typeof value.advisorModel === "string" ||
      value.advisorModel === null) &&
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
  const projects = projectsValue
    .filter(isProjectRecord)
    .map((p) => ({
      ...p,
      lastModel: p.lastModel ?? null,
      lastThinkingLevel: p.lastThinkingLevel ?? null,
      lastAdvisor: p.lastAdvisor ?? null,
      lastAdvisorModel: p.lastAdvisorModel ?? null,
    }));
  const sessions = sessionsValue
    .filter(isOwnedSessionRecord)
    .map((s) => ({
      ...s,
      model: s.model ?? null,
      thinkingLevel: s.thinkingLevel ?? null,
      advisorModel: s.advisorModel ?? null,
      worktree: s.worktree ?? null,
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
    if (data) return new Registry(file, data);
    // Corrupt (or unknown schemaVersion): quarantine and start empty.
    try {
      fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
    } catch {
      // best effort — starting empty either way
    }
    return new Registry(file, emptyRegistry());
  }

  #save(): void {
    fs.mkdirSync(path.dirname(this.#file), { recursive: true });
    const tmp = `${this.#file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(this.#data, null, 2)}\n`);
    fs.renameSync(tmp, this.#file);
  }

  #getSetting<K extends SettingKey>(key: K): RegistrySettings[K] {
    return this.#data.settings[key];
  }

  #setSetting<K extends SettingKey>(key: K, value: RegistrySettings[K]): void {
    if (Object.is(this.#data.settings[key], value)) return;
    this.#data.settings[key] = value;
    this.#save();
  }

  get projects(): readonly ProjectRecord[] {
    return deepFreeze(structuredClone(this.#data.projects));
  }

  get sessions(): readonly OwnedSessionRecord[] {
    return deepFreeze(structuredClone(this.#data.sessions));
  }

  get defaultMode(): SessionMode {
    return this.#getSetting("defaultMode");
  }

  get defaultAgentMode(): AgentMode {
    return this.#getSetting("defaultAgentMode");
  }

  get skipDeleteConfirmation(): boolean {
    return this.#getSetting("skipDeleteConfirmation");
  }

  addProject(projectPath: string): ProjectRecord {
    const existing = this.#data.projects.find((p) => p.path === projectPath);
    if (existing) return structuredClone(existing);
    const record: ProjectRecord = {
      path: projectPath,
      name: path.basename(projectPath),
      addedAt: new Date().toISOString(),
      lastModel: null,
      lastThinkingLevel: null,
      lastAdvisor: null,
      lastAdvisorModel: null,
    };
    this.#data.projects.push(record);
    this.#save();
    return structuredClone(record);
  }

  /** Cascades to the project's session records; files on disk are never touched. */
  removeProject(projectPath: string): void {
    this.#data.projects = this.#data.projects.filter((p) => p.path !== projectPath);
    this.#data.sessions = this.#data.sessions.filter((s) => s.projectCwd !== projectPath);
    this.#save();
  }

  /**
   * Moves `projectPath` to sit immediately before `beforePath` in the sidebar
   * order; a null `beforePath` (or one that is not registered) appends the
   * project to the end. The order is the persisted registry array order, so the
   * change survives a restart. An unknown `projectPath`, and a `beforePath`
   * equal to it, are no-ops (no save).
   */
  moveProject(projectPath: string, beforePath: string | null): void {
    // "Before itself" is the sidebar's own "leave it put" drop (it derives
    // beforePath from the row below the pointer). It must return here: the
    // splice below would hide the project from the beforePath lookup, and the
    // miss would append it to the end.
    if (beforePath === projectPath) return;
    const from = this.#data.projects.findIndex((p) => p.path === projectPath);
    if (from === -1) return; // unknown source: no-op, no write
    const [moved] = this.#data.projects.splice(from, 1);
    // `to` is looked up after the splice, so indices have already shifted —
    // "insert before the removed element's neighbour" stays correct.
    if (beforePath !== null) {
      const to = this.#data.projects.findIndex((p) => p.path === beforePath);
      if (to !== -1) {
        this.#data.projects.splice(to, 0, moved);
        this.#save();
        return;
      }
    }
    this.#data.projects.push(moved);
    this.#save();
  }

  /** Records an advisor choice for this session and the next one in its project. */
  setSessionAdvisor(tabId: string, advisor: boolean, advisorModel: string | null): void {
    const record = this.#data.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const project = this.#data.projects.find((p) => p.path === record.projectCwd);
    if (
      record.advisor === advisor &&
      record.advisorModel === advisorModel &&
      project?.lastAdvisor === advisor &&
      project.lastAdvisorModel === advisorModel
    ) return;
    record.advisor = advisor;
    record.advisorModel = advisorModel;
    if (project) {
      project.lastAdvisor = advisor;
      project.lastAdvisorModel = advisorModel;
    }
    this.#save();
  }

  /** Records the main model choice for this session and the next one in its project. */
  setSessionModel(tabId: string, model: string | null, thinkingLevel: string | null): void {
    const record = this.#data.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    const project = this.#data.projects.find((p) => p.path === record.projectCwd);
    if (
      record.model === model &&
      record.thinkingLevel === thinkingLevel &&
      project?.lastModel === model &&
      project.lastThinkingLevel === thinkingLevel
    ) return;
    record.model = model;
    record.thinkingLevel = thinkingLevel;
    if (project) {
      project.lastModel = model;
      project.lastThinkingLevel = thinkingLevel;
    }
    this.#save();
  }

  addSession(record: OwnedSessionRecord): OwnedSessionRecord {
    this.#data.sessions.push(structuredClone(record));
    this.#save();
    return structuredClone(record);
  }

  removeSession(tabId: string): void {
    this.#data.sessions = this.#data.sessions.filter((s) => s.tabId !== tabId);
    this.#save();
  }

  updateSession(
    tabId: string,
    patch: Partial<Omit<OwnedSessionRecord, "tabId">>,
  ): OwnedSessionRecord | undefined {
    const record = this.#data.sessions.find((s) => s.tabId === tabId);
    if (!record) return undefined;
    Object.assign(record, patch);
    this.#save();
    return structuredClone(record);
  }

  setDefaultMode(mode: SessionMode): void {
    this.#setSetting("defaultMode", mode);
  }

  setDefaultAgentMode(mode: AgentMode): void {
    this.#setSetting("defaultAgentMode", mode);
  }

  get planFormat(): PlanFormat {
    return this.#getSetting("planFormat");
  }

  setPlanFormat(format: PlanFormat): void {
    this.#setSetting("planFormat", format);
  }

  get hibernateIdleMinutes(): number {
    return this.#getSetting("hibernateIdleMinutes");
  }

  setHibernateIdleMinutes(minutes: number): void {
    this.#setSetting("hibernateIdleMinutes", minutes);
  }

  get streamStallAbortSeconds(): number {
    return this.#getSetting("streamStallAbortSeconds");
  }

  setStreamStallAbortSeconds(seconds: number): void {
    this.#setSetting("streamStallAbortSeconds", seconds);
  }

  get advisorAutoReply(): boolean {
    return this.#getSetting("advisorAutoReply");
  }

  setAdvisorAutoReply(on: boolean): void {
    this.#setSetting("advisorAutoReply", on);
  }

  get defaultAdvisor(): boolean {
    return this.#getSetting("defaultAdvisor");
  }

  setDefaultAdvisor(on: boolean): void {
    this.#setSetting("defaultAdvisor", on);
  }

  setSkipDeleteConfirmation(skip: boolean): void {
    this.#setSetting("skipDeleteConfirmation", skip);
  }

  get themeId(): string {
    return this.#getSetting("themeId");
  }

  setThemeId(id: string): void {
    this.#setSetting("themeId", id);
  }

  get appUpdateCheckOnLaunch(): boolean {
    return this.#getSetting("appUpdateCheckOnLaunch");
  }

  setAppUpdateCheckOnLaunch(on: boolean): void {
    this.#setSetting("appUpdateCheckOnLaunch", on);
  }

  get ompUpdateCheckOnLaunch(): boolean {
    return this.#getSetting("ompUpdateCheckOnLaunch");
  }

  setOmpUpdateCheckOnLaunch(on: boolean): void {
    this.#setSetting("ompUpdateCheckOnLaunch", on);
  }

  get remoteEnabled(): boolean {
    return this.#getSetting("remoteEnabled");
  }

  setRemoteEnabled(on: boolean): void {
    this.#setSetting("remoteEnabled", on);
  }

  get remoteBind(): RemoteBind {
    return this.#getSetting("remoteBind");
  }

  setRemoteBind(bind: RemoteBind): void {
    this.#setSetting("remoteBind", bind);
  }

  get remotePort(): number {
    return this.#getSetting("remotePort");
  }

  setRemotePort(port: number): void {
    this.#setSetting("remotePort", port);
  }

  get remoteToken(): string {
    return this.#getSetting("remoteToken");
  }

  setRemoteToken(token: string): void {
    this.#setSetting("remoteToken", token);
  }

  get remotePasswordHash(): string {
    return this.#getSetting("remotePasswordHash");
  }

  setRemotePasswordHash(hash: string): void {
    this.#setSetting("remotePasswordHash", hash);
  }

  get remotePasswordSalt(): string {
    return this.#getSetting("remotePasswordSalt");
  }

  setRemotePasswordSalt(salt: string): void {
    this.#setSetting("remotePasswordSalt", salt);
  }

  get dismissedAppUpdateVersion(): string | null {
    return this.#getSetting("dismissedAppUpdateVersion");
  }

  setDismissedAppUpdateVersion(version: string | null): void {
    this.#setSetting("dismissedAppUpdateVersion", version);
  }

  get dismissedOmpUpdateVersion(): string | null {
    return this.#getSetting("dismissedOmpUpdateVersion");
  }

  setDismissedOmpUpdateVersion(version: string | null): void {
    this.#setSetting("dismissedOmpUpdateVersion", version);
  }

  getFavorites(): string[] {
    return [...this.#getSetting("modelFavorites")];
  }

  toggleFavorite(key: string): void {
    const current = this.#data.settings.modelFavorites;
    const idx = current.indexOf(key);
    this.#data.settings.modelFavorites =
      idx === -1 ? [...current, key] : current.filter((k) => k !== key);
    this.#save();
  }
}
