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

export type ProjectOpenTarget = "vscode" | "files" | "terminal";

export interface ProjectOpenAvailability {
  vsCode: boolean;
  terminal: boolean;
}

export interface ProjectRecord {
  path: string;
  name: string;
  addedAt: string;
  /** Main model most recently used in this project. */
  lastModel: string | null;
  /** Main-model thinking level most recently used in this project; legacy
   *  registries without the field are normalized to null at parse time. */
  lastThinkingLevel: string | null;
  /** Advisor state most recently used in this project; null defers to omp
   *  config. Legacy registries without the field are normalized to null at
   *  parse time. */
  lastAdvisor: boolean | null;
  /** Advisor model most recently used, including its optional `:level` suffix. */
  lastAdvisorModel: string | null;
  /**
   * Pinned main model for new sessions, as omp's `provider/id` selector
   * (issue #257). Consumed only at spawn; null = no pin, the last-used memory
   * and omp's config decide as before. Legacy registries without the field
   * are normalized to null at parse time.
   */
  defaultModel: string | null;
  /**
   * Pinned advisor model for new sessions, as omp's `model[:level]` selector
   * (issue #257). Consumed only at spawn; null = defer to the last-used
   * advisor model, then omp config's `modelRoles.advisor`. A pin does not
   * force the advisor on — on/off keeps its own chain (issue #174). Legacy
   * registries without the field are normalized to null at parse time.
   */
  defaultAdvisorModel: string | null;
}

/**
 * A worktree session's dedicated checkout (see CONTEXT.md "Worktree session").
 */
export interface SessionWorktree {
  /** Absolute path of the checkout under omp-ui's worktrees root. */
  path: string;
  /** The branch created for and checked out in this worktree. */
  branch: string;
  /**
   * What the branch was cut from: the spawn request's baseRef verbatim, or
   * the project checkout's branch at creation — its HEAD commit when the
   * checkout is detached. Null only on records predating this field.
   */
  base: string | null;
}

/** Merge-back feasibility snapshot for a worktree session (issue #272). */
export interface MergeBackStatus {
  /** Destination branch in the project; null when unresolvable. */
  destination: string | null;
  /** Why destination is null; null when destination is set. */
  reason: "no-repo" | "base-gone" | "no-branch-match" | null;
  /** destination is the project checkout's current branch. */
  destinationCheckedOut: boolean;
  /** The worktree session's branch still exists as a local branch. */
  branchExists: boolean;
  /** A merge is already in progress in the project checkout (.MERGE_HEAD). */
  mergeInProgress: boolean;
  /** Every commit of the branch is already in destination. */
  alreadyMerged: boolean;
  /** Commits on the branch that destination lacks; 0 when alreadyMerged. */
  ahead: number;
}

/** Outcome of a merge-back (issue #272). */
export interface MergeBackResult {
  kind: "ff" | "merged" | "already-merged" | "conflicts";
  destination: string;
  /** Commits folded into destination; 0 for already-merged. */
  commits: number;
  /** Conflicted paths when kind is "conflicts"; [] otherwise. */
  files: string[];
}

/** Outcome of a worktree-branch deletion attempt (issue #323). */
export interface WorktreeBranchRemoval {
  kind:
    | "removed"
    | "kept-unmerged"
    | "kept-no-destination"
    | "kept-refused"
    | "already-gone";
  /** git's message when kind is "kept-refused"; undefined otherwise. */
  detail?: string;
}

/** Saved provenance for a fresh implementation session created from an accepted plan. */
export interface PlanImplementationSource {
  /** Planning session tab that dispatched the implementation. */
  sourceTabId: string;
  /** Plan title captured at dispatch time. */
  planTitle: string;
  /** Canonical plan artifact, as a local:// URL. */
  planFilePath: string;
}

/** One plan-handoff descendant in a delete preview (issue #309). */
export interface PlanHandoffDescendant {
  tabId: string;
  title: string;
  /** True when the descendant's omp process is currently running. */
  running: boolean;
}

/** The sessions that would be erased with a deleted session (issue #309). */
export interface DeleteSessionPreview {
  descendants: PlanHandoffDescendant[];
}

export interface OwnedSessionRecord {
  tabId: string;
  /** UUIDv7 — null until the session materializes on disk (lazy materialization). */
  sessionId: string | null;
  /** Dir NAME under the sessions root (ADR-0003), never a path. */
  lineageDir: string;
  projectCwd: string;
  /**
   * Dedicated git worktree this session runs in; null = the session runs at
   * projectCwd. Post-dates the first schema-1 records — legacy records
   * without the field are normalized to null at parse time.
   */
  worktree: SessionWorktree | null;
  /**
   * Planning-session provenance for a fresh implementation. Post-dates the
   * first schema-1 records — legacy records without the field are normalized
   * to null at parse time.
   */
  planImplementationSource: PlanImplementationSource | null;
  launchedAt: string;
  mode: SessionMode;
  /** Agent mode (plan/build) of the last rpc-ui incarnation the plan
   *  extension reported. Post-dates existing records: legacy records without
   *  the field are normalized to "build" at parse time. */
  agentMode: AgentMode;
  /** Compaction method captured for a fresh native session; null for
   *  terminal-origin sessions. Normalized to null at parse time when absent. */
  compactionMethod: string | null;
  /** Main model selected for this session, as omp's `provider/id` selector.
   *  Normalized to null at parse time when absent. */
  model: string | null;
  /** Main-model thinking level selected for this session. Normalized to null
   *  at parse time when absent. */
  thinkingLevel: string | null;
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

/** Plan-review gate the session's agent is blocked on right now. Main-process owned. */
export interface PendingPlan {
  /** The proposal title as the agent wrote it. */
  title: string;
  /** The one plan artifact, as a local:// URL (matches PlanReviewRequest). */
  planFilePath: string;
  /** Absolute path for plan:read; null when no artifacts dir could be resolved. */
  planAbsPath: string | null;
  /** id of the proposal `extension_ui_request` frame — answering the gate must echo it. */
  frameId: string;
  /** ISO-8601 timestamp of the proposal. */
  proposedAt: string;
}

/** Latest verdict that closed a gate, so renderers that did not answer can settle their rows. */
export interface PlanSettle {
  frameId: string;
  verdict: "executed" | "refined";
}

export interface SessionSummary extends OwnedSessionRecord {
  title: string;
  status: SessionStatus | null;
  live: LiveState;
  pendingPlan: PendingPlan | null;
  planSettle: PlanSettle | null;
  /** Main-process watchdog aborted a silently wedged turn (issue #248); sidebar badge. */
  streamStalled: boolean;
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
  /** Preferred first compaction method captured by future native sessions; null defers to omp. */
  defaultCompactionMethod: string | null;
  /** Plan authoring format the next plan-mode toggle asks the agent for. */
  planFormat: PlanFormat;
  /** Idle window before an rpc-ui session's process is hibernated; 0 disables. */
  hibernateIdleMinutes: number;
  /** Silence window before a running turn is aborted as stream-stalled (issue #248); 0 disables. */
  streamStallAbortSeconds: number;
  /** Auto-answer a late advisor review (issue #111); seeds each rpc tab's advisorReply. */
  advisorAutoReply: boolean;
  /** Bounded auto-continue after a turn dies to a stream stall (issue #251); app-level, default on. */
  stallAutoContinue: boolean;
  /** OS notifications for background-session attention (issue #271); app-level, default on. */
  desktopNotifications: boolean;
  /** Seeds the advisor on/off for new sessions, default off (issue #174). */
  defaultAdvisor: boolean;
  modelFavorites: string[];
  /** Whether destructive session deletion proceeds without a renderer warning. */
  skipDeleteConfirmation: boolean;
  /** Active theme id; the renderer resolves it against its own theme table. */
  themeId: string;
  /** Active font family id; the renderer resolves it against its own font table. */
  fontFamilyId: string;
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
  /**
   * Merge-base commit the diff is taken from when a worktree base was
   * supplied and resolvable; null = ordinary diff vs HEAD.
   */
  mergeBase: string | null;
}

/**
 * Controls whether listBranches may refresh the current branch's configured
 * remote before reading its divergence.
 */
export interface BranchListOptions {
  fetchUpstream?: boolean;
}

/**
 * Local-branch listing and upstream state of a project's git repo (see
 * listBranches). Null repoRoot means the project is not inside a git
 * repository.
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
  /** Configured upstream's short ref; null when no upstream is configured. */
  upstreamRef: string | null;
  /** Configured upstream's remote name, including `.` for a local upstream. */
  upstreamRemote: string | null;
  /** Whether the configured upstream currently resolves to a local tracking ref. */
  hasUpstream: boolean;
  /** Commits on the current branch but not its upstream. */
  ahead: number;
  /** Commits on the upstream but not the current branch. */
  behind: number;
  /** Unix timestamp in milliseconds of the last successful network refresh. */
  upstreamFetchedAt: number | null;
  /** Most recent network refresh error, retained until a refresh succeeds. */
  upstreamRefreshError: string | null;
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
   * Create a dedicated git worktree and run the session in it. Only read when
   * resumeTabId is absent — resumes take the worktree from the record.
   * baseRef null starts from the project checkout's HEAD.
   */
  worktree?: { branch: string; baseRef: string | null };
  /**
   * Reuse an existing worktree checkout for this new session instead of
   * minting one (plan handoff, issue #316): the source record's
   * `SessionWorktree` verbatim. Only read when resumeTabId is absent, and
   * mutually exclusive with `worktree` — main rejects a request carrying
   * either both or a reuse on a resume. Main validates that the path sits
   * under the worktrees root and still exists, then records it unchanged.
   */
  worktreeReuse?: SessionWorktree;
  /** Provenance to persist on a fresh implementation session. */
  planImplementationSource?: PlanImplementationSource | null;
  /**
   * Initial Plan/Build posture for an rpc-ui spawn. Omitted new sessions follow
   * Default agent mode; omitted resumes follow the record's persisted
   * `agentMode` (issue #263). The fresh implementation spawn passes false so
   * the implementation session is never born read-only (issue #165).
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
export type AppPackageFormat = "appimage" | "nsis" | "maczip" | "deb" | "rpm" | "flatpak" | "unknown";

/** Snapshot of the omp-ui app update situation (see main/app-update.ts). */
export type AppUpdateStatus =
  | "disabled" // dev/unversioned build — updater off
  | "idle" // nothing to show; a silent auto-update stage may be in flight
  | "checking"
  | "up-to-date" // manual check only; transient
  | "available" // manual formats only; auto-updatable packages stage during the check
  | "downloading"
  | "downloaded" // AppImage/NSIS/macOS zip: staged + verified; others: installer opened/in folder
  | "installing" // authorized post-download handoff to the installer/native updater
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
  /**
   * Set when the user-level allowlist (`enabledServers`) is the only reason
   * this row is ON — its own source says `enabled: false`. omp's suppression
   * rule (`loadAllMCPConfigs`) reads that list solely from the user file, so
   * a project-scope disable of such a row can only take effect by clearing
   * the global force-enable; `disableReach` says what that costs.
   */
  enabledBy?: "allowlist";
  /**
   * Only on an `enabledBy: "allowlist"` row: how far a project-scope disable
   * reaches. "project" — nothing outside this project loses the server,
   * because the global-scope winner is writable (the writer flips it to
   * `enabled: true` before dropping the pin) or nothing outside depends on
   * the pin at all. "global" — the global winner is a tool-owned file omp-ui
   * never mutates, so dropping the pin turns the server off everywhere.
   */
  disableReach?: "project" | "global";
  /** native | mcp-json files are writable; tool-owned files are not. */
  writable: boolean;
}

export interface McpServersResult {
  servers: McpServerEntry[];
  /** Malformed/unreadable source files; the list still renders. */
  errors: Array<{ path: string; message: string }>;
}

export interface McpSetEnabledRequest {
  /**
   * null = global scope: user-level sources only, no project candidates.
   * Non-null names the working tree whose project-scope config decides —
   * for a worktree session that is its checkout, not the project root.
   */
  projectCwd: string | null;
  name: string;
  /**
   * Global scope only (writable native | mcp-json sources); ignored when
   * `projectCwd` is non-null — the project writer resolves the winner itself.
   */
  sourcePath?: string;
  enabled: boolean;
}

/** Which program the tab's console-drawer PTY runs — a login shell, or an omp TUI for a handoff (issue #243). */
export type ConsoleProgram = "shell" | "omp-tui";

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
  /** The bearer token in the clear — fallback credential; settings page reveals, copies, QRs it. */
  token: string;
  /** True once the user has set a sign-in password; primary pairing URLs then omit the token. */
  hasPassword: boolean;
  /** Primary pairing URLs: bare when hasPassword, token-bearing otherwise. Empty unless listening. */
  urls: string[];
  /** Token-bearing pairing URLs (fallback). Empty unless listening. */
  tokenUrls: string[];
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

/**
 * Mnemopi memory browsing (issue #206). Read straight off the SQLite banks by
 * the main process (see core/memory-store.ts) — omp exposes no runtime surface
 * for memory, so the pane reads what omp itself persisted.
 */
export type MemoryBackendKind = "off" | "local" | "hindsight" | "mnemopi";
/** omp's `mnemopi.scoping` setting; unrecognised values fall back to "per-project". */
export type MemoryScoping = "global" | "per-project" | "per-project-tagged";
/** Which bank a pane request addresses: the project's discovered bank or the global one. */
export type MemoryScope = "project" | "global";
/** Which mnemopi store a row lives in. */
export type MemoryStore = "working" | "episodic";

/** One bank's on-disk facts for the overview header. */
export interface MemoryBankInfo {
  bank: string;
  dbPath: string;
  exists: boolean;
  sizeBytes: number;
  workingCount: number;
  episodicCount: number;
  /** MAX(created_at) across both stores; null for an empty or missing bank. */
  lastWrite: string | null;
}

/** Resolved memory situation for a project (see readMemoryOverview). Never rejects. */
export interface MemoryOverview {
  backend: MemoryBackendKind;
  scoping: MemoryScoping;
  baseDir: string;
  global: MemoryBankInfo;
  /** Null when scoping is "global" or no project bank was discovered. */
  project: MemoryBankInfo | null;
  /** Any resolution failure lands here instead of throwing. */
  error: string | null;
}

/** One memory row as the pane sees it. */
export interface MemoryRow {
  id: string;
  store: MemoryStore;
  /** Clipped to MEMORY_CLIP_CHARS in list responses; getMemory returns it whole. */
  content: string;
  /** True when `content` was clipped — the pane fetches the full row on expand. */
  truncated: boolean;
  source: string | null;
  timestamp: string | null;
  createdAt: string | null;
  importance: number | null;
  memoryType: string | null;
  veracity: string | null;
  sessionId: string | null;
}

export interface MemoryListOptions {
  /** FTS query; null/empty lists by recency instead. */
  query: string | null;
  offset: number;
  /** Clamped to 1..200 in core. */
  limit: number;
}

/** One page of memories from a single bank. */
export interface MemoryPage {
  scope: MemoryScope;
  bank: string;
  rows: MemoryRow[];
  total: number;
  offset: number;
  limit: number;
}

/** Edit outcomes: episodic rows are visible but not editable. */
export type MemoryEditStatus = "ok" | "not_found" | "not_editable";
export interface MemoryEditResult {
  status: MemoryEditStatus;
}

export type { OmpBackend } from "./backend-channels";