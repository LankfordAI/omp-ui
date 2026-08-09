// Pure types, zero runtime imports — the renderer imports these type-only via
// the @omp-ui/core/types subpath.

export type SessionStatus =
  | "complete"
  | "interrupted"
  | "aborted"
  | "error"
  | "pending"
  | "unknown";

export type SessionMode = "pty" | "rpc-ui";
export type AgentMode = "plan" | "build";
export type LiveState = "live" | "dormant" | "archived" | "missing";

/**
 * How the agent is asked to author plans for review: `html` adds a rich,
 * self-contained HTML rendition beside the canonical markdown plan, `md`
 * keeps markdown only. See core/plan-extension.ts.
 */
export type PlanFormat = "html" | "md";

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
  /** Initial Plan/Build posture for newly created native sessions. */
  defaultAgentMode: AgentMode;
  /** Plan authoring format the next plan-mode toggle asks the agent for. */
  planFormat: PlanFormat;
  /** Auto-answer a late advisor review (issue #111); seeds each rpc tab's advisorReply. */
  advisorAutoReply: boolean;
  modelFavorites: string[];
  /** Whether destructive session deletion proceeds without a renderer warning. */
  skipDeleteConfirmation: boolean;
  /** Active theme id; the renderer resolves it against its own theme table. */
  themeId: string;
  appUpdateCheckOnLaunch: boolean;
  ompUpdateCheckOnLaunch: boolean;
  /** Release version whose omp-ui update card was dismissed, or null. */
  dismissedAppUpdateVersion: string | null;
  /** omp version whose install/update card was dismissed, or null. */
  dismissedOmpUpdateVersion: string | null;
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

/**
 * Local-branch listing of a project's git repo (see listBranches). Null
 * repoRoot means the project is not inside a git repository.
 */
export interface BranchList {
  /** Null when projectCwd is not inside a git repository. */
  repoRoot: string | null;
  /** Current branch; null on a detached HEAD. */
  current: string | null;
  /** Local branches, default branch first, then alphabetical. */
  branches: string[];
  /** The repo's default branch when one can be determined. */
  defaultBranch: string | null;
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
  /**
   * Initial Plan/Build posture for a brand-new rpc-ui session. Omitted means
   * "follow the Default agent mode" (the current behavior). Plan execution
   * passes false so the implementation session is never born read-only
   * (issue #165).
   */
  startInPlanMode?: boolean;
}

/** omp's own advisor defaults, read from its config (see core/omp-config.ts). */
export interface AdvisorDefaults {
  enabled: boolean;
  /** `modelRoles.advisor` as written, or null when omp resolves it in code. */
  model: string | null;
}

/**
 * omp's own settings, as the settings surface's omp page sees them (see
 * core/omp-settings.ts). Declared here so the shared channel spec can stay
 * transport-agnostic.
 */
export type OmpSettingType = "boolean" | "number" | "string" | "enum" | "array" | "record";
export type OmpSettingValue = boolean | number | string | string[] | Record<string, unknown>;
/** Which config layer supplies a value, per omp's own merge order. */
export type OmpSettingLayer = "default" | "global" | "project";

export interface OmpSettingEntry {
  key: string;
  type: OmpSettingType;
  /** omp's own description; "" when it ships none. */
  description: string;
  /** Effective value for the read's projectCwd; undefined = unset. */
  value: OmpSettingValue | undefined;
  /** Enum members, in omp's order; null for non-enum types. */
  options: string[] | null;
  layer: OmpSettingLayer;
}

export interface OmpSettingsSnapshot {
  /** Only the allowlisted keys omp actually knows, in OMP_SETTING_KEYS order. */
  entries: OmpSettingEntry[];
  /** Absolute path of omp's agent config dir (core `getOmpAgentDir()`). */
  agentDir: string | null;
  /** The project layer file that was accounted for, when it exists. */
  projectConfigPath: string | null;
  /** Non-null when omp could not be run at all; entries is then empty. */
  error: string | null;
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
export type AppPackageFormat = "appimage" | "nsis" | "deb" | "rpm" | "flatpak" | "unknown";

/** Snapshot of the omp-ui app update situation (see main/app-update.ts). */
export type AppUpdateStatus =
  | "disabled" // dev/unversioned build — updater off
  | "idle" // nothing to show; a silent auto-update stage may be in flight
  | "checking"
  | "up-to-date" // manual check only; transient
  | "available" // manual formats only; auto-updatable packages stage during the check
  | "downloading"
  | "downloaded" // AppImage/NSIS: staged + verified; others: installer opened/in folder
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
  /** Explicit user opt-in to apply the staged auto-update on the next natural quit. */
  installOnQuit: boolean;
  error: string | null;
}

/** Result of requesting a restart into a staged app update. */
export type AppUpdateRestartResult = "confirmation-required" | "restarting" | "unavailable";

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

/** Which interface the embedded remote server binds to. */
export type RemoteBind = "localhost" | "lan";

export type RemoteStatus = "stopped" | "starting" | "listening" | "error";

/**
 * The embedded remote-access server's settings and live status (issue #37). Pushed like
 * AppUpdateState/OmpUpdateState rather than folded into BackendState: the token has no business
 * riding a broadcast every rpc tab re-renders on.
 */
export interface RemoteState {
  status: RemoteStatus;
  enabled: boolean;
  bind: RemoteBind;
  port: number;
  /** The bearer token in the clear — the settings page reveals, copies, and QRs it. */
  token: string;
  /** Pairing URLs with the token in the query, primary first. Empty unless listening. */
  urls: string[];
  /** True when out/web is absent, so the server answers 503 with a build hint. */
  webBundleMissing: boolean;
  error: string | null;
}

/**
 * Where a provider credential's effective value comes from, highest priority
 * first (see core/provider-keys.ts). `dotenv` is report-only: omp loads project
 * `.env` files itself, so omp-ui never injects those.
 */
export type ProviderKeySource = "stored" | "environment" | "login-shell" | "dotenv" | "none";

/**
 * One provider row on the settings page. Carries no key material: `masked` is
 * the last four characters behind a fixed mask, computed in the main process.
 */
export interface ProviderKeyStatus {
  /** omp's provider id where one exists, else a stable slug (see PROVIDER_KEY_SPECS). */
  id: string;
  label: string;
  group: "models" | "search";
  /** The variable a value typed into this row is written to. */
  env: string;
  /** The variable actually supplying the value — an alternate when the primary is unset. */
  activeEnv: string;
  source: ProviderKeySource;
  /** Null when no source supplies this credential. */
  masked: string | null;
  hint: string | null;
  /** True when a stored value is overriding an inherited one for the same variable. */
  shadowsEnvironment: boolean;
}

/** The providers page's whole payload: rows plus how securely they can be stored. */
export interface ProviderKeysSnapshot {
  providers: ProviderKeyStatus[];
  /** False when the OS offers no credential store; writes are refused. */
  encryptionAvailable: boolean;
  /** safeStorage's backend label, shown so the user knows what protects the file. */
  backend: string;
}

export type { OmpBackend } from "./backend-channels";