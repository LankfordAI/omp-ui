import * as fs from "node:fs";
import * as path from "node:path";
import type { OwnedSessionRecord, ProjectRecord, SessionMode } from "./types";

interface RegistryData {
  schemaVersion: 1;
  settings: {
    defaultMode: SessionMode;
    modelFavorites: string[];
    skipDeleteConfirmation: boolean;
  };
  projects: ProjectRecord[];
  sessions: OwnedSessionRecord[];
}

function emptyRegistry(): RegistryData {
  return {
    schemaVersion: 1,
    settings: {
      // The native transcript is the primary mode (the sidebar's mode toggle
      // went away with #10); pty stays an explicit per-spawn menu choice.
      defaultMode: "rpc-ui",
      modelFavorites: [],
      skipDeleteConfirmation: false,
    },
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
    }));
  const settingsObj =
    "settings" in raw && raw.settings !== null && typeof raw.settings === "object"
      ? raw.settings
      : undefined;
  const rawDefaultMode: SessionMode | undefined =
    settingsObj !== undefined && "defaultMode" in settingsObj && isSessionMode(settingsObj.defaultMode)
      ? settingsObj.defaultMode
      : undefined;
  const favRaw =
    settingsObj !== undefined && "modelFavorites" in settingsObj
      ? settingsObj.modelFavorites
      : undefined;
  const rawSkipDeleteConfirmation =
    settingsObj !== undefined &&
    "skipDeleteConfirmation" in settingsObj &&
    typeof settingsObj.skipDeleteConfirmation === "boolean"
      ? settingsObj.skipDeleteConfirmation
      : false;
  const settings: RegistryData["settings"] = {
    defaultMode: rawDefaultMode ?? ("rpc-ui" as SessionMode),
    modelFavorites:
      Array.isArray(favRaw) ? favRaw.filter((v): v is string => typeof v === "string") : [],
    skipDeleteConfirmation: rawSkipDeleteConfirmation,
  };
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

  get projects(): readonly ProjectRecord[] {
    return deepFreeze(structuredClone(this.#data.projects));
  }

  get sessions(): readonly OwnedSessionRecord[] {
    return deepFreeze(structuredClone(this.#data.sessions));
  }

  get defaultMode(): SessionMode {
    return this.#data.settings.defaultMode;
  }

  get skipDeleteConfirmation(): boolean {
    return this.#data.settings.skipDeleteConfirmation;
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
    this.#data.settings.defaultMode = mode;
    this.#save();
  }

  setSkipDeleteConfirmation(skip: boolean): void {
    if (this.#data.settings.skipDeleteConfirmation === skip) return;
    this.#data.settings.skipDeleteConfirmation = skip;
    this.#save();
  }

  getFavorites(): string[] {
    return [...this.#data.settings.modelFavorites];
  }

  toggleFavorite(key: string): void {
    const current = this.#data.settings.modelFavorites;
    const idx = current.indexOf(key);
    this.#data.settings.modelFavorites =
      idx === -1 ? [...current, key] : current.filter((k) => k !== key);
    this.#save();
  }
}
