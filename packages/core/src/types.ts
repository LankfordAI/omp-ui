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

/** How this omp-ui install was packaged (see core/app-update.ts). */
export type AppPackageFormat = "appimage" | "deb" | "rpm" | "flatpak" | "unknown";

/** Snapshot of the omp-ui app update situation (see main/app-update.ts). */
export type AppUpdateStatus =
  | "disabled" // dev/unversioned build — updater off
  | "idle" // nothing to show
  | "checking"
  | "up-to-date" // manual check only; transient
  | "available"
  | "downloading"
  | "downloaded" // AppImage: ready to restart; others: installer opened/in folder
  | "error";

export interface AppUpdateState {
  status: AppUpdateStatus;
  currentVersion: string | null;
  latestVersion: string | null;
  /** Release page URL (from the release JSON html_url). */
  releaseUrl: string | null;
  releaseName: string | null;
  format: AppPackageFormat;
  /** 0–100 while downloading; null = indeterminate or not downloading. */
  progress: number | null;
  downloadedPath: string | null;
  error: string | null;
}

/** Where the omp binary install/update flow stands (see desktop main/omp-update.ts). */
export type OmpUpdateStatus =
  | "idle" // nothing to show
  | "checking"
  | "up-to-date" // manual check only; transient
  | "missing" // omp not installed — an install offer, not an update
  | "available"
  | "downloading"
  | "installed" // applied; new sessions use the new binary
  | "error";

export interface OmpUpdateState {
  status: OmpUpdateStatus;
  /** Resolved omp binary path, or null when omp is not installed. */
  installPath: string | null;
  installedVersion: string | null;
  latestVersion: string | null;
  /** 0–100 while downloading; null = indeterminate or not downloading. */
  progress: number | null;
  error: string | null;
}

/** The config sources omp-ui resolves MCP servers from (see core/mcp-config.ts). */
export type McpServerSource =
  | "native"
  | "claude"
  | "gemini"
  | "opencode"
  | "cursor"
  | "windsurf"
  | "vscode"
  | "mcp-json";

/**
 * One MCP server definition row for the manager modal. Redacted at the core
 * boundary: `env`, `headers`, `auth`, and `oauth` values never cross into the
 * renderer, and http/sse endpoints carry no userinfo or query string.
 */
export interface McpServerEntry {
  name: string;
  transport: "stdio" | "http" | "sse";
  /** stdio: command + args; http/sse: url with userinfo+query stripped. */
  endpoint: string;
  source: McpServerSource;
  scope: "project" | "user";
  /** Absolute path of the defining file (display only; renderer never writes). */
  sourcePath: string;
  /** False on shadowed duplicate rows (a higher-priority source claimed the name). */
  effective: boolean;
  /** `"<source>:<sourcePath>"` of the winning entry, on shadowed rows only. */
  shadowedBy?: string;
  state: "enabled" | "disabled";
  disabledBy?: "config" | "denylist";
  /** native | mcp-json files are writable; tool-owned files are not. */
  writable: boolean;
}

export interface McpServersResult {
  servers: McpServerEntry[];
  /** Malformed/unreadable source files; the list still renders. */
  errors: Array<{ path: string; message: string }>;
}

export interface McpSetEnabledRequest {
  projectCwd: string;
  name: string;
  /** Pass only when the entry's source is writable (native | mcp-json). */
  sourcePath?: string;
  enabled: boolean;
}

/** One directory candidate from browseDirectories. */
export interface DirBrowseEntry {
  /** Basename, e.g. "omp-ui". */
  name: string;
  /** Absolute path of this entry. */
  fullPath: string;
}

/** Result of a browseDirectories call (see core/dir-browse.ts). */
export interface DirBrowseResult {
  /** The directory that was listed (absolute); "" when the input was invalid. */
  parentPath: string;
  /** Directories only, name-sorted. Empty on any error. */
  entries: DirBrowseEntry[];
  /** invalid = not a ~/ or absolute path; missing = ENOENT/ENOTDIR; denied = EACCES/EPERM. */
  error: "invalid" | "missing" | "denied" | null;
}

/**
 * The renderer↔backend seam (ADR-0002). Changes only by extension — a future
 * packages/server reproduces exactly this surface over WebSocket.
 */
export interface OmpBackend {
  getState(): Promise<BackendState>;
  /**
   * Registers a directory as a project. `path` may be ~-prefixed or absolute;
   * the backend expands, resolves, and validates it is an existing directory,
   * rejecting with a user-facing message otherwise. An already-registered path
   * resolves to its existing record.
   */
  addProject(path: string): Promise<ProjectRecord>;
  /** Directory listing for the in-app project picker (read-only, never mutates). */
  browseDirectories(partialPath: string): Promise<DirBrowseResult>;
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
  /** MCP servers resolved for a project's cwd, redacted; errors are per-file. */
  getMcpServers(projectCwd: string): Promise<McpServersResult>;
  /** Toggles one server via omp's own write algorithm; returns the refreshed list. */
  setMcpServerEnabled(req: McpSetEnabledRequest): Promise<McpServersResult>;
  /**
   * Restarts a live session in place (kill + relaunch with `--resume`, same
   * dance as the advisor/mode-switch relaunch) so it picks up changed MCP
   * config. Rejects when the session is not live.
   */
  restartSession(tabId: string): Promise<void>;
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
  /** Current omp binary update state. */
  getOmpUpdateState(): Promise<OmpUpdateState>;
  /** Manual check — surfaces up-to-date/error transiently, bypasses dismissal. */
  checkOmpUpdate(): Promise<OmpUpdateState>;
  /**
   * Starts the opt-in install/update of the managed omp binary. No-op unless
   * an update or install is offered. Progress flows via onOmpUpdateState.
   */
  downloadOmpUpdate(): Promise<void>;
  /**
   * Hides the card. `remember: true` also persists the version so background
   * checks stay quiet for that offer; `false` is a transient hide.
   */
  dismissOmpUpdate(version: string, remember: boolean): Promise<void>;
  onOmpUpdateState(cb: (state: OmpUpdateState) => void): void;
  /** Current app (omp-ui) update state. */
  getAppUpdateState(): Promise<AppUpdateState>;
  /** Manual check — surfaces up-to-date/error/disabled transiently. */
  checkAppUpdate(): Promise<AppUpdateState>;
  /**
   * Starts the package-appropriate update action (AppImage: electron-updater
   * download; deb/rpm/flatpak: verified download + open with system handler).
   * No-op unless an update is available. Progress flows via onAppUpdateState.
   */
  downloadAppUpdate(): Promise<void>;
  /** Opens the pending release's GitHub page. */
  openAppUpdateReleaseNotes(): Promise<void>;
  /** Reveals the downloaded artifact in its folder (non-AppImage). */
  showAppUpdateDownload(): Promise<void>;
  /** Restarts into the downloaded AppImage update; asks first when sessions are live. */
  restartForAppUpdate(): Promise<void>;
  /**
   * Hides the card. `remember: true` also persists the version so background
   * checks stay quiet for that release; `false` is a transient hide.
   */
  dismissAppUpdate(version: string, remember: boolean): Promise<void>;
  onAppUpdateState(cb: (state: AppUpdateState) => void): void;
}
