import * as fs from "node:fs";
import * as path from "node:path";
import type { OwnedSessionRecord, ProjectRecord, SessionMode } from "./types";

interface RegistryData {
  schemaVersion: 1;
  settings: { defaultMode: SessionMode };
  projects: ProjectRecord[];
  sessions: OwnedSessionRecord[];
}

function emptyRegistry(): RegistryData {
  return { schemaVersion: 1, settings: { defaultMode: "pty" }, projects: [], sessions: [] };
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
    typeof value.addedAt === "string"
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
  const projects = projectsValue.filter(isProjectRecord);
  const sessions = sessionsValue
    .filter(isOwnedSessionRecord)
    .map((s) => ({ ...s, advisorModel: s.advisorModel ?? null }));
  const settings =
    "settings" in raw &&
    raw.settings !== null &&
    typeof raw.settings === "object" &&
    "defaultMode" in raw.settings &&
    isSessionMode(raw.settings.defaultMode)
      ? { defaultMode: raw.settings.defaultMode }
      : { defaultMode: "pty" as SessionMode };
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

  addProject(projectPath: string): ProjectRecord {
    const existing = this.#data.projects.find((p) => p.path === projectPath);
    if (existing) return structuredClone(existing);
    const record: ProjectRecord = {
      path: projectPath,
      name: path.basename(projectPath),
      addedAt: new Date().toISOString(),
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
   * Records a session's advisor state. Sessions own this, not projects: omp
   * binds the advisor per process, and the composer toggles it per session.
   */
  setSessionAdvisor(tabId: string, advisor: boolean, advisorModel: string | null): void {
    const record = this.#data.sessions.find((s) => s.tabId === tabId);
    if (!record) return;
    record.advisor = advisor;
    record.advisorModel = advisorModel;
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
}
