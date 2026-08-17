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
  OmpSettingsSnapshot,
  OmpSettingValue,
  OmpUpdateState,
  PlanFormat,
  ProviderKeysSnapshot,
  RemoteBind,
  RemoteState,
  SessionMode,
} from "@omp-ui/core/types";
import type { PlanReviewRequest, PlanStatus } from "@omp-ui/core/plan";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
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

export interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
  /** Background sync — must never drive the busy sweep. */
  quiet: boolean;
  /** Command name only — never retain the command payload in diagnostics. */
  command: string;
  startedAt: number;
  timeoutMs: number;
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
  subagentLevel?: "progress" | "events";
  extensionStatus: Record<string, string>;
  pendingCommands: Map<string, PendingCommand>;
  /** Renderer-observed request/model progress; never local tool execution. */
  streamCheckpoint?: { at: number; label: string };
  stallCount?: number;
  extensionQueue: unknown[];
  /** True while any rpc command is in flight. */
  busy: boolean;
  failure?: RpcFailure;
  initialPrompt: string | null;
  hasRenamed: boolean;
  plan: PlanStatus | null;
  planReview: { request: PlanReviewRequest; frame: unknown } | null;
  planText: string | null;
  planHtml: string | null;
  planDeferred: boolean;
  plans: PlanRecord[];
  advisorStats: AdvisorStatsView | null;
  advisorReply: boolean;
}

export type SidebarSessionState =
  "working" | "awaiting-answer" | "ready" | "starting" | "error" | LiveState;

export interface DeleteConfirmation {
  tabId: string;
  title: string;
  running: boolean;
  hasFiles: boolean;
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

export interface SettingsSlice {
  /** The settings modal's open page, or null while closed. */
  settingsPage: SettingsPage | null;
  remote: RemoteState;
  openSettings(page?: SettingsPage): void;
  closeSettings(): void;
  replaceRemote(remote: RemoteState): void;
  setDefaultMode(mode: SessionMode): Promise<void>;
  setDefaultAgentMode(mode: AgentMode): Promise<void>;
  setPlanFormat(format: PlanFormat): Promise<void>;
  setAdvisorAutoReply(on: boolean): Promise<void>;
  setDefaultAdvisor(on: boolean): Promise<void>;
  setSkipDeleteConfirmation(skip: boolean): Promise<void>;
  setThemeId(id: string): Promise<void>;
  setAppUpdateCheckOnLaunch(on: boolean): Promise<void>;
  setOmpUpdateCheckOnLaunch(on: boolean): Promise<void>;
  clearDismissedAppUpdate(): Promise<void>;
  clearDismissedOmpUpdate(): Promise<void>;
  setRemoteEnabled(on: boolean): Promise<void>;
  setRemoteBind(bind: RemoteBind): Promise<void>;
  setRemotePort(port: number): Promise<void>;
  regenerateRemoteToken(): Promise<void>;
  readOmpSettings(projectCwd: string | null): Promise<OmpSettingsSnapshot>;
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

export interface UiStore extends SettingsSlice, UpdatesSlice {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
  restoringTabs: boolean;
  exited: Record<string, number>;
  shellExited: Record<string, number>;
  rpc: Record<string, RpcTabState>;
  consoleOpen: Record<string, boolean>;
  branches: Record<string, BranchList>;
  branchActivity: Record<string, BranchActivity>;
  branchDiffRevision: Record<string, number>;
  advisorDefaults: Record<string, AdvisorDefaults>;
  deleteConfirmation: DeleteConfirmation | null;
  projectPickerOpen: boolean;
  mcpManager: { tabId: string; projectCwd: string } | null;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  init(): Promise<void>;
  openProjectPicker(): void;
  closeProjectPicker(): void;
  openMcpManager(tabId: string, projectCwd: string): void;
  closeMcpManager(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  toggleSidebarCollapsed(): void;
  restartSession(tabId: string): Promise<boolean>;
  addProject(path: string): Promise<void>;
  removeProject(path: string): Promise<void>;
  moveProject(projectPath: string, beforePath: string | null): Promise<void>;
  toggleFavorite(key: string): Promise<void>;
  newSession(projectCwd: string, modeOverride?: SessionMode): Promise<void>;
  openSession(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  hideTab(tabId: string): void;
  terminate(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  resumeDead(tabId: string): Promise<void>;
  deleteSession(tabId: string): Promise<void>;
  confirmDeleteSession(skipFuture: boolean): Promise<void>;
  cancelDeleteSession(): void;
  bootRpcTab(tabId: string): Promise<void>;
  rpcCommand(
    tabId: string,
    cmd: Record<string, unknown>,
    opts?: { quiet?: boolean },
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
  ): Promise<void>;
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
    /** Explicit successor posture; approved-plan execution passes Build. */
    startInPlanMode?: boolean,
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
  compactSession(tabId: string): Promise<void>;
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
  refreshBranches(projectCwd: string, opts?: BranchListOptions): Promise<void>;
  checkoutGitBranch(
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
  ): Promise<string | null>;
  pullGitBranch(projectCwd: string): Promise<string | null>;
  suggestBranchName(
    projectCwd: string,
    planContext: string,
  ): Promise<string | null>;
}
