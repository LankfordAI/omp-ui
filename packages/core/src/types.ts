// Pure types, zero imports — the renderer imports these type-only via the
// @omp-ui/core/types subpath, so this file must stay dependency-free.

export type SessionStatus =
  | "complete"
  | "interrupted"
  | "aborted"
  | "error"
  | "pending"
  | "unknown";

export type SessionMode = "pty" | "rpc-ui";
export type LiveState = "live" | "dormant" | "archived" | "missing";

export interface ProjectRecord {
  path: string;
  name: string;
  advisor: boolean;
  addedAt: string;
}

export interface OwnedSessionRecord {
  tabId: string;
  /** UUIDv7 — null until the session materializes on disk (lazy materialization). */
  sessionId: string | null;
  /** Dir NAME under the sessions root (ADR-0003), never a path. */
  lineageDir: string;
  projectCwd: string;
  launchedAt: string;
  mode: SessionMode;
  advisor: boolean;
  cachedTitle: string | null;
  cachedModified: string | null;
}

export interface SessionSummary extends OwnedSessionRecord {
  title: string;
  status: SessionStatus | null;
  live: LiveState;
}

export interface ProjectGroup {
  project: ProjectRecord;
  sessions: SessionSummary[];
}

export interface BackendState {
  projects: ProjectGroup[];
  defaultMode: SessionMode;
}

export interface SpawnRequest {
  projectCwd: string;
  mode: SessionMode;
  advisor: boolean;
  cols: number;
  rows: number;
  resumeTabId?: string;
}

/**
 * The renderer↔backend seam (ADR-0002). Changes only by extension — a future
 * packages/server reproduces exactly this surface over WebSocket.
 */
export interface OmpBackend {
  getState(): Promise<BackendState>;
  addProject(): Promise<ProjectRecord | null>;
  removeProject(path: string): Promise<void>;
  setProjectAdvisor(path: string, advisor: boolean): Promise<void>;
  setDefaultMode(mode: SessionMode): Promise<void>;
  spawnSession(req: SpawnRequest): Promise<{ tabId: string }>;
  terminateSession(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  /** Prunes a session record from the registry (files on disk are kept). */
  removeSession(tabId: string): Promise<void>;
  ptyWrite(tabId: string, data: string): void;
  ptyResize(tabId: string, cols: number, rows: number): void;
  rpcSend(tabId: string, command: object): void;
  onPtyData(cb: (tabId: string, data: Uint8Array) => void): void;
  onPtyExit(cb: (tabId: string, exitCode: number) => void): void;
  onRpcFrame(cb: (tabId: string, frame: object) => void): void;
  onStateChanged(cb: (state: BackendState) => void): void;
}
