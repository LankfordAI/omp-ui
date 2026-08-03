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
  /** Main model most recently used in this project. */
  lastModel: string | null;
  /** Main-model thinking level most recently used in this project. */
  lastThinkingLevel?: string | null;
  /** Advisor state most recently used in this project; null defers to omp config. */
  lastAdvisor?: boolean | null;
  /** Advisor model most recently used, including its optional `:level` suffix. */
  lastAdvisorModel: string | null;
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
  /** Main model selected for this session, as omp's `provider/id` selector. */
  model?: string | null;
  /** Main-model thinking level selected for this session. */
  thinkingLevel?: string | null;
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
  modelFavorites: string[];
  /** Whether destructive session deletion proceeds without a renderer warning. */
  skipDeleteConfirmation: boolean;
}

/**
 * Busy-route mention resolution result (see core/mention-resolve.ts). omp only
 * extracts `@path` mentions on the idle prompt path; on steer/follow_up omp-ui
 * inlines the contents itself and hands them back in this shape.
 */
export interface ResolvedMentionContext {
  /** Appended after the draft message; "" when nothing resolved. */
  contextText: string;
  /** Mentioned images that ride the prompt frame's `images` field. */
  images: ImageAttachment[];
}

/**
 * Working-tree state of a project's git repo (see readBranchDiff). Null
 * repoRoot means the project is not inside a git repository.
 */
export interface BranchDiff {
  /** Active branch name; null when detached or not a git repo. */
  branch: string | null;
  /** Repo root the branch lives in — the diff is read relative to it. */
  repoRoot: string | null;
  /** `git diff HEAD` for tracked files, verbatim unified diff. */
  diff: string;
  /** New untracked files, read as creates. Oversized files are skipped. */
  untracked: Array<{ path: string; text: string; binary: boolean }>;
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
 * Snapshot of the omp install/update situation (see core/omp-update.ts). Kept
 * inline here rather than imported so this file stays dependency-free for the
 * renderer's type-only import.
 */
export interface OmpUpdateInfo {
  /** Resolved omp binary path, or null when omp is not installed/not found. */
  installPath: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  /** True when both versions are known and installed < latest. */
  updateAvailable: boolean;
  error: string | null;
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
  setSkipDeleteConfirmation(skip: boolean): Promise<void>;
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
   * Records the main model and thinking level for both this session and the
   * next session in its project. Null values defer to omp's config.
   */
  setSessionModel(
    tabId: string,
    model: string | null,
    thinkingLevel: string | null,
  ): Promise<void>;
  /**
   * Titles a first user prompt with omp's own small model (the `tiny`/`commit`/
   * `smol` role chain). Resolves to null whenever the model declines or the run
   * fails — the caller keeps its derived title in that case.
   */
  generateTitle(projectCwd: string, prompt: string): Promise<string | null>;
  /**
   * Reads a plan artifact for the review pane, by absolute path. Confined to
   * the session's lineage dir by the implementation; null when the file is
   * absent or out of bounds.
   */
  readPlanFile(tabId: string, absPath: string): Promise<string | null>;
  /**
   * Working-tree changes on the active branch of a project's git repo: tracked
   * changes vs HEAD plus new untracked files. Null fields when the project is
   * not inside a git repository.
   */
  getBranchDiff(projectCwd: string): Promise<BranchDiff>;
  /**
   * Project-relative file listing for the composer's @ picker;
   * gitignore-aware, with a walk fallback outside repos.
   */
  listProjectFiles(projectCwd: string): Promise<{ files: string[]; truncated: boolean }>;
  /**
   * Busy-route mention resolution: omp skips @-extraction on steer/follow_up,
   * so omp-ui inlines mention contents itself on those routes.
   */
  resolveFileMentions(projectCwd: string, message: string): Promise<ResolvedMentionContext>;
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
  toggleFavorite(key: string): Promise<void>;
  /** Snapshot of the omp install/update situation (see checkOmpUpdate). */
  checkOmpUpdate(): Promise<OmpUpdateInfo>;
  /**
   * Installs (or updates) the app-managed omp binary to the latest published
   * release. No auto-apply — the implementation prompts the user first.
   * Resolves with the resulting state.
   */
  applyOmpUpdate(): Promise<OmpUpdateInfo>;
}
