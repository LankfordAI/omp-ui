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

/**
 * A pasted image, shaped exactly like omp's `ImageContent` (minus the
 * OpenAI-only `detail` hint). `data` is bare base64 — never a `data:` URL.
 * Lives here rather than in images.ts because the renderer imports this file
 * type-only and images.ts pulls in node:fs.
 */
export interface ImageAttachment {
  type: "image";
  data: string;
  mimeType: string;
}

export interface ProjectRecord {
  path: string;
  name: string;
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
  /**
   * The `advisor` role this session pins, as omp's `model[:level]` selector.
   * Null defers to omp's own config. omp binds the role at process start, so
   * this is applied as a `--config` overlay at spawn and changing it respawns.
   */
  advisorModel: string | null;
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
  /** omp `model[:level]` selector for the advisor role; null uses omp's config. */
  advisorModel?: string | null;
  cols: number;
  rows: number;
  resumeTabId?: string;
}

/** omp's own advisor defaults, read from its config (see core/omp-config.ts). */
export interface AdvisorDefaults {
  enabled: boolean;
  /** `modelRoles.advisor` as written, or null when omp resolves it in code. */
  model: string | null;
}

/**
 * The renderer↔backend seam (ADR-0002). Changes only by extension — a future
 * packages/server reproduces exactly this surface over WebSocket.
 */
export interface OmpBackend {
  getState(): Promise<BackendState>;
  addProject(): Promise<ProjectRecord | null>;
  removeProject(path: string): Promise<void>;
  setDefaultMode(mode: SessionMode): Promise<void>;
  spawnSession(req: SpawnRequest): Promise<{ tabId: string }>;
  terminateSession(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  /**
   * Deletes a session: the registry record plus its lineage files in the active
   * and archive roots (transcript + artifacts). Irreversible; rejects while the
   * session is live.
   */
  deleteSession(tabId: string): Promise<void>;
  /**
   * Re-pins a session's advisor state. omp binds both the enable flag and the
   * `advisor` role at process start, so a live session is respawned with
   * `--resume`; a dormant one just records the choice for its next launch.
   */
  setSessionAdvisor(tabId: string, advisor: boolean, advisorModel: string | null): Promise<void>;
  /** omp's own advisor defaults for a project (global config + project overlay). */
  getAdvisorDefaults(projectCwd: string): Promise<AdvisorDefaults>;
  /**
   * Writes pasted image bytes to a scratch file and delivers its path to the
   * PTY as a bracketed paste — omp's TUI loads the file itself. The PTY carries
   * no byte channel, so this is the only route for terminal-mode images.
   */
  ptyPasteImage(tabId: string, image: ImageAttachment): Promise<void>;
  ptyWrite(tabId: string, data: string): void;
  ptyResize(tabId: string, cols: number, rows: number): void;
  rpcSend(tabId: string, command: object): void;
  onPtyData(cb: (tabId: string, data: Uint8Array) => void): void;
  onPtyExit(cb: (tabId: string, exitCode: number) => void): void;
  onRpcFrame(cb: (tabId: string, frame: object) => void): void;
  onStateChanged(cb: (state: BackendState) => void): void;
}
