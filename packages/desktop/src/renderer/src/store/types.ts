import type {
  AgentMode,
  AdvisorDefaults,
  AppUpdateRestartResult,
  AppUpdateState,
  BackendState,
  BranchList,
  BranchListOptions,
  ImageAttachment,
  LiveState,
  MergeBackResult,
  MergeBackStatus,
  OmpSettingsSnapshot,
  OmpSettingValue,
  OmpUpdateState,
  PlanFormat,
  PlanHandoffDescendant,
  ProviderKeysSnapshot,
  RemoteBind,
  RemoteState,
  SessionMode,
  WorktreeReleaseResult,
} from "@omp-ui/core/types";
import type { PlanReviewRequest, PlanStatus } from "@omp-ui/core/plan";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import type { McpRuntimeStatus } from "@omp-ui/core/mcp-status";
import type { CompactionThresholdSettings } from "@omp-ui/core/compaction-threshold";
import type {
  PlanExecutionContext,
  PlanExecutionOptions,
} from "../lib/plan-concerns";
import type {
  ModelInfo,
  PromptRoute,
  SessionRuntime,
  SessionStats,
  SlashCommandInfo,
  SubagentInfo,
  TodoPhase,
} from "../lib/rpc-types";
import type { RenderItem } from "../lib/transcript";

export interface TabInfo {
  tabId: string;
  mode: SessionMode;
  projectCwd: string;
  /** Hidden tabs stay mounted (display:none) — the xterm instance survives. */
  hidden: boolean;
}

/** Renderer-local presentation and recovery context for an RPC failure. */
export interface RpcFailure {
  message: string;
  kind: "command" | "process" | "boot";
  fatal: boolean;
  command?: string;
  timeoutMs?: number;
  sessionStatus?: RpcTabState["status"];
  liveState?: LiveState;
  recovery: string;
}


/** Optional revision instructions sent back to the planner on refine. */
export interface PlanRevisionNotes {
  text: string;
  images?: ImageAttachment[];
}

/** One proposed plan this session has surfaced, newest first. */
export interface PlanRecord {
  /** The plan artifact path (the slug) — uniquely identifies the plan. */
  key: string;
  title: string;
  /** `pending` while the agent waits on a verdict; settles on the others. */
  status: "pending" | "executed" | "refined";
}

/** Per-tab rpc-ui state (the phase-2 doc's state machine, concretized). */
export interface RpcTabState {
  status: "starting" | "ready" | "running" | "error";
  items: RenderItem[];
  todos: TodoPhase[];
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  commands: SlashCommandInfo[];
  session: SessionRuntime;
  stats: SessionStats | null;
  subagents: SubagentInfo[];
  subagentItems?: Record<string, RenderItem[]>;
  selectedSubagent?: string | null;
  subagentMarkers?: Map<string, string>;
  subagentAckLevel?: "progress" | "events";
  extensionStatus: Record<string, string>;
  /** Renderer-observed request/model progress; never local tool execution. */
  streamCheckpoint?: { at: number; label: string };
  /**
   * Model-stream silence in ms, present only while an assistant response is
   * open AND the silence has exceeded STREAM_STALL_THRESHOLD_MS (issue #228).
   * Whole-second granularity: changes at most once per second.
   */
  streamStallMs?: number;
  stallCount?: number;
  /** The turn's terminal assistant message end; drives settle target and stall classification. */
  lastTurn?: LastTurnMeta;
  /** A main-process watchdog abort notice arrived; the next agent_end feeds auto-continue (issue #254). */
  stallAbortPending?: boolean;
  extensionQueue: unknown[];
  /** True while any rpc command is in flight. */
  busy: boolean;
  failure?: RpcFailure;
  initialPrompt: string | null;
  /**
   * The auto-title that has already been sent, after its send was acked:
   * the phase-1 derived name first, then the model title when the phase-2
   * upgrade lands. Phase 2 must never send before phase 1 has landed, or the
   * derived send would overwrite the model name.
   */
  autoTitleSent: string | null;
  hasRenamed: boolean;
  plan: PlanStatus | null;
  planReview: { request: PlanReviewRequest; frame: unknown } | null;
  planText: string | null;
  planHtml: string | null;
  planDeferred: boolean;
  plans: PlanRecord[];
  advisorStats: AdvisorStatsView | null;
  mcpStatus: McpRuntimeStatus | null;
  advisorReply: boolean;
}

/** The turn's terminal assistant message end; drives settle target and stall classification. */
export interface LastTurnMeta {
  stopReason?: string;
  errorMessage?: string;
  errorId?: number;
}

export type SidebarSessionState =
  | "working"
  | "awaiting-answer"
  | "stalled"
  | "ready"
  | "starting"
  | "error"
  | LiveState;

export interface DeleteConfirmation {
  tabId: string;
  title: string;
  running: boolean;
  hasFiles: boolean;
  worktreeBranch: string | null;
  /** The worktree record's base; null for non-worktree sessions and pre-field records. */
  worktreeBase: string | null;
  /** Plan-handoff descendants deleted with this session; empty = plain delete (issue #309). */
  cascade: PlanHandoffDescendant[];
}

export type SettingsPage =
  | "general"
  | "appearance"
  | "updates"
  | "remote"
  | "providers"
  | "memory"
  | "omp"
  | "about";

export type CompactSurface =
  "sessions" | "inspector" | "session-actions" | "composer-options";

export type CompactionMethodsLoad =
  | { status: "unloaded" }
  | { status: "loading" }
  | { status: "loaded"; methods: string[] }
  | { status: "failed"; message: string };

export interface SettingsSlice {
  /** The settings modal's open page, or null while closed. */
  settingsPage: SettingsPage | null;
  remote: RemoteState;
  compactionMethods: CompactionMethodsLoad;
  /**
   * Effective compaction threshold keys per project, from the settings read.
   * `null` = the read failed (no notch); absent key = not read yet (no notch).
   */
  compactionSettings: Record<string, CompactionThresholdSettings | null>;
  openSettings(page?: SettingsPage): void;
  closeSettings(): void;
  replaceRemote(remote: RemoteState): void;
  setDefaultMode(mode: SessionMode): Promise<void>;
  setDefaultAgentMode(mode: AgentMode): Promise<void>;
  ensureCompactionMethods(): Promise<void>;
  setDefaultCompactionMethod(method: string | null): Promise<void>;
  setPlanFormat(format: PlanFormat): Promise<void>;
  setHibernateIdleMinutes(minutes: number): Promise<void>;
  setStreamStallAbortSeconds(seconds: number): Promise<void>;
  setAdvisorAutoReply(on: boolean): Promise<void>;
  setStallAutoContinue(on: boolean): Promise<void>;
  setDesktopNotifications(on: boolean): Promise<void>;
  setDefaultAdvisor(on: boolean): Promise<void>;
  setSkipDeleteConfirmation(skip: boolean): Promise<void>;
  setThemeId(id: string): Promise<void>;
  setFontFamilyId(id: string): Promise<void>;
  setAppUpdateCheckOnLaunch(on: boolean): Promise<void>;
  setOmpUpdateCheckOnLaunch(on: boolean): Promise<void>;
  clearDismissedAppUpdate(): Promise<void>;
  clearDismissedOmpUpdate(): Promise<void>;
  setRemoteEnabled(on: boolean): Promise<void>;
  setRemoteBind(bind: RemoteBind): Promise<void>;
  setRemotePort(port: number): Promise<void>;
  regenerateRemoteToken(): Promise<void>;
  setRemotePassword(password: string): Promise<void>;
  clearRemotePassword(): Promise<void>;
  readOmpSettings(projectCwd: string | null): Promise<OmpSettingsSnapshot>;
  ensureCompactionSettings(projectCwd: string): Promise<void>;
  writeOmpSetting(key: string, value: OmpSettingValue): Promise<void>;
  readProviderKeys(projectCwd: string | null): Promise<ProviderKeysSnapshot>;
  setProviderKey(envName: string, value: string): Promise<ProviderKeysSnapshot>;
  clearProviderKey(envName: string): Promise<ProviderKeysSnapshot>;
}

export interface UpdatesSlice {
  appUpdate: AppUpdateState;
  ompUpdate: OmpUpdateState;
  replaceAppUpdate(appUpdate: AppUpdateState): void;
  replaceOmpUpdate(ompUpdate: OmpUpdateState): void;
  checkOmpUpdate(): Promise<void>;
  downloadOmpUpdate(): Promise<void>;
  dismissOmpUpdate(version: string, remember: boolean): Promise<void>;
  checkAppUpdate(): Promise<void>;
  downloadAppUpdate(): Promise<void>;
  openAppUpdateReleaseNotes(): Promise<void>;
  showAppUpdateDownload(): Promise<void>;
  restartForAppUpdate(confirmed?: boolean): Promise<AppUpdateRestartResult>;
  setAppUpdateInstallOnQuit(on: boolean): Promise<void>;
  dismissAppUpdate(version: string, remember: boolean): Promise<void>;
}

export interface BranchActivity {
  refreshing: boolean;
  pulling: boolean;
}

/**
 * A terminal-only omp flow staged for the tab's console drawer (issue #243).
 * The drawer runs omp's TUI for as long as this entry exists; `key` forces a
 * respawn when a second handoff is staged into an already-open drawer.
 */
export interface TuiHandoff {
  line: string;
  key: number;
  phase: "running" | "exited";
}

export interface UiStore extends SettingsSlice, UpdatesSlice {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
  restoringTabs: boolean;
  exited: Record<string, number>;
  shellExited: Record<string, number>;
  /** True for tabs whose process omp-ui hibernated while idle (issue #246). */
  hibernated: Record<string, boolean>;
  rpc: Record<string, RpcTabState>;
  consoleOpen: Record<string, boolean>;
  searchOpen: Record<string, boolean>;
  tuiHandoff: Record<string, TuiHandoff>;
  branches: Record<string, BranchList>;
  branchActivity: Record<string, BranchActivity>;
  branchDiffRevision: Record<string, number>;
  advisorDefaults: Record<string, AdvisorDefaults>;
  deleteConfirmation: DeleteConfirmation | null;
  projectPickerOpen: boolean;
  worktreeDialogProject: string | null;
  /** The working tree the MCP manager resolves and writes at (a worktree
   *  session's checkout, else the project root); null = global scope. */
  mcpManager: { scopeCwd: string | null; tabId?: string } | null;
	projectSettings: { projectCwd: string } | null;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  init(): Promise<void>;
  openProjectPicker(): void;
  closeProjectPicker(): void;
  openMcpManager(scopeCwd: string | null, tabId?: string): void;
  closeMcpManager(): void;
	openProjectSettings(projectCwd: string): void;
	closeProjectSettings(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  toggleSidebarCollapsed(): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
  restartSession(tabId: string): Promise<boolean>;
  addProject(path: string): Promise<void>;
  removeProject(path: string): Promise<void>;
  moveProject(projectPath: string, beforePath: string | null): Promise<void>;
  moveSession(tabId: string, beforeTabId: string | null): Promise<void>;
  setProjectDefaultModel(projectPath: string, model: string | null): Promise<void>;
  setProjectDefaultAdvisorModel(projectPath: string, model: string | null): Promise<void>;
  toggleFavorite(key: string): Promise<void>;
  newSession(projectCwd: string, modeOverride?: SessionMode): Promise<void>;
  /**
   * Creates a worktree session; throws on failure (the dialog renders the
   * message inline) — unlike newSession's alertError.
   */
  newWorktreeSession(
    projectCwd: string,
    opts: { branch: string; baseRef: string | null },
  ): Promise<void>;
  /**
   * Converts an unprompted session to a worktree session (issue #225);
   * throws on failure (the composer renders the message inline) — unlike
   * restartSession's alertError.
   */
  convertSessionToWorktree(
    tabId: string,
    opts: { branch: string; baseRef: string | null },
  ): Promise<void>;
  openWorktreeDialog(projectCwd: string): void;
  closeWorktreeDialog(): void;
  openSession(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  hideTab(tabId: string): void;
  terminate(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  resumeDead(tabId: string): Promise<void>;
  deleteSession(tabId: string): Promise<void>;
  confirmDeleteSession(skipFuture: boolean): Promise<void>;
  releaseWorktreeSession(tabId: string): Promise<WorktreeReleaseResult | null>;
  cancelDeleteSession(): void;
  bootRpcTab(tabId: string): Promise<void>;
  rpcCommand(
    tabId: string,
    cmd: Record<string, unknown>,
    opts?: { quiet?: boolean; captureId?: (id: string) => void },
  ): Promise<unknown>;
  handleRpcFrame(tabId: string, frame: object): void;
  answerExtension(
    tabId: string,
    request: unknown,
    response: Record<string, unknown>,
  ): void;
  setInitialPrompt(tabId: string, prompt: string): void;
  renameSession(tabId: string): void;
  sendPrompt(
    tabId: string,
    message: string,
    route?: PromptRoute,
    images?: ImageAttachment[],
  ): Promise<boolean>;
  abortAgent(tabId: string): Promise<void>;
  abortAndPrompt(
    tabId: string,
    message: string,
    images?: ImageAttachment[],
  ): Promise<void>;
  loadAdvisorDefaults(projectCwd: string): Promise<void>;
  setSessionAdvisor(
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void>;
  setAdvisorModel(tabId: string, selector: string | null): Promise<void>;
  setModel(tabId: string, model: ModelInfo): Promise<void>;
  setThinkingLevel(tabId: string, level: string): Promise<void>;
  setSteeringMode(tabId: string, mode: string): Promise<void>;
  setFollowUpMode(tabId: string, mode: string): Promise<void>;
  setInterruptMode(tabId: string, mode: string): Promise<void>;
  setAutoCompaction(tabId: string, enabled: boolean): Promise<void>;
  setAutoRetry(tabId: string, enabled: boolean): Promise<void>;
  abortRetry(tabId: string): Promise<void>;
  /** Resolves true only when omp acknowledged the compaction (issue #336). */
  compactSession(tabId: string): Promise<boolean>;
  exportHtml(tabId: string): Promise<void>;
  branchSession(tabId: string): Promise<void>;
  renameSessionTo(tabId: string, name: string): Promise<void>;
  setPlanMode(tabId: string, enabled: boolean): Promise<void>;
  executePlan(
    tabId: string,
    context: PlanExecutionContext,
    options?: PlanExecutionOptions,
  ): void;
  refinePlan(tabId: string, notes?: PlanRevisionNotes): void;
  loadPlanText(
    tabId: string,
    absPath: string | null,
    itemId?: string,
  ): Promise<void>;
  deferPlanReview(tabId: string): void;
  showPlanReview(tabId: string): void;
  runSlashCommand(tabId: string, line: string): Promise<void>;
  setTodos(tabId: string, phases: TodoPhase[]): Promise<void>;
  refreshState(tabId: string): Promise<void>;
  refreshStats(tabId: string): Promise<void>;
  refreshAdvisorStats(tabId: string): Promise<void>;
  refreshSubagents(tabId: string): Promise<void>;
  openSubagent(tabId: string, key: string): void;
  closeSubagent(tabId: string): void;
  clearShellExited(tabId: string): void;
  toggleConsole(tabId: string): void;
  openSearch(tabId: string): void;
  closeSearch(tabId: string): void;
  /** Opens the console on an omp TUI and stages `line` for the user to send. */
  startTuiHandoff(tabId: string, line: string): void;
  /** Types the staged line into the running TUI; no-op once it has exited. */
  sendTuiHandoff(tabId: string): void;
  /** Drops the staged handoff, returning the drawer to a plain login shell. */
  dismissTuiHandoff(tabId: string): void;
  refreshBranches(projectCwd: string, opts?: BranchListOptions): Promise<void>;
  checkoutGitBranch(
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
  ): Promise<string | null>;
  pullGitBranch(projectCwd: string): Promise<string | null>;
  readMergeBackStatus(
    projectCwd: string,
    branch: string,
    base: string | null,
  ): Promise<MergeBackStatus>;
  mergeWorktreeBranch(
    projectCwd: string,
    branch: string,
    destination: string,
  ): Promise<MergeBackResult>;
  /** Appends a transcript notice (issue #272); no-ops for tabs without rpc state. */
  appendNotice(tabId: string, text: string, level?: "info" | "warn" | "error"): void;
  suggestBranchName(
    projectCwd: string,
    planContext: string,
  ): Promise<string | null>;
}
