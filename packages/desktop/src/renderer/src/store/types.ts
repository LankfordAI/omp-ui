import type {
  AgentMode,
  AdvisorDefaults,
  AppUpdateRestartResult,
  AppUpdateState,
  BackendState,
  BranchList,
  GlassChrome,
  BranchListOptions,
  ImageAttachment,
  LiveState,
  MergeBackResult,
  MergeBackStatus,
  MergeDestination,
  OmpSettingsSnapshot,
  OmpSettingValue,
  OmpUpdateState,
  PlanFormat,
  PlanHandoffDescendant,
  ProviderKeysSnapshot,
  ProviderOAuthState,
  ProviderOAuthStatus,
  RemoteBind,
  RemoteInstanceInput,
  RemoteInstancePatch,
  RemoteState,
  SessionMode,
  TranscriptWidth,
  UpdateTrain,
  WorktreeReleaseOptions,
  WorktreeReleaseResult,
  WebSearchProviderSnapshot,
  WorktreeSyncResult,
  PushResult,
} from "@omp-ui/core/types";
import type { PlanReviewRequest, PlanStatus } from "@omp-ui/core/plan";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import type { McpRuntimeStatus } from "@omp-ui/core/mcp-status";
import type {
  CapabilitySectionId,
  CapabilitySnapshot,
  SetSessionToolEnabledResult,
} from "@omp-ui/core/capabilities";
import type { GoalSnapshot } from "@omp-ui/core/goal";
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
  /** The joined remote instance that owns the session; null for a local one (issue #416). */
  instanceId: string | null;
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
  /**
   * `pending` while the agent waits on a verdict; settles on the others.
   * `invalidated` is NOT a user verdict (issue #312 follow-up): the gate's
   * validated source changed under review, so nothing was executed and no
   * refinement was requested.
   */
  status: "pending" | "executed" | "refined" | "invalidated";
}

/**
 * The local preparation readiness PlanReview observed for the CURRENT
 * proposal (§6): the store's execution guard reads it, so execute requires
 * more than a non-disabled button — a ready preparation whose identity is
 * the gate's own sourceHash.
 */
export interface PlanReadiness {
  status: "pending" | "ready" | "failed" | "unavailable";
  identity?: string;
}

/**
 * One tool enable/disable this session has in flight (issue #379). The roster
 * identity travels with the attempt: it is what lets a late answer be judged
 * as belonging to this observation or to one that has already been retired.
 */
export interface CapabilitiesToolPending {
  /** Exact registry name, as the published roster reports it. */
  name: string;
  /** The membership the user asked for. */
  enabled: boolean;
  processKey: string;
  sessionId: string | null;
}

/**
 * Why the last mutation this tab attempted did not land (issue #379). Every
 * non-`applied` branch of the bridge's reply, so the viewer can name the one
 * lever that actually applies.
 */
export type CapabilitiesToolFeedbackStatus = Exclude<
  SetSessionToolEnabledResult["status"],
  "applied"
>;

export interface CapabilitiesToolFeedback {
  name: string;
  enabled: boolean;
  status: CapabilitiesToolFeedbackStatus;
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
  /**
   * A re-titling this tab has in flight, recorded against the title it read;
   * null when idle (issue #433). A settle whose `requestId` is no longer the
   * tab's lost: a second click wins over the first.
   */
  titleRegeneration?: { readonly requestId: number; readonly previousTitle: string } | null;
  plan: PlanStatus | null;
  planReview: { request: PlanReviewRequest; frame: unknown } | null;
  planText: string | null;
  planHtml: string | null;
  planDeferred: boolean;
  /** PlanReview's local preparation verdict for the current gate (§6 guard). */
  planReadiness?: PlanReadiness | null;
  plans: PlanRecord[];
  advisorStats: AdvisorStatsView | null;
  mcpStatus: McpRuntimeStatus | null;
  /** The root session's loaded skills/tool roster; null until first observed. */
  capabilities: CapabilitySnapshot | null;
  /**
   * The session's goal snapshot as the root goal bridge published it (issue #381).
   * Display state only: the child process owns the goal and its continuation.
   */
  goal: GoalSnapshot | null;
  /** How the roster read went; the viewer's own state machine (issue #374). */
  capabilitiesLoad:
    | "idle"
    | "loading"
    | "available"
    | "starting"
    | "bridge-unavailable"
    | "terminal"
    | "not-live"
    | "missing-session"
    | "error";
  /**
   * The one tool enable/disable this session has in flight, recorded against
   * the roster identity it was issued from; null when idle (issue #379). It
   * lives in the tab, not in the viewer, so closing and reopening the modal
   * cannot issue a second mutation for the same session, and so a result that
   * arrives after the process or session moved on can be recognised as late.
   */
  capabilitiesToolPending?: CapabilitiesToolPending | null;
  /**
   * The outcome of the last mutation this tab attempted that did NOT land,
   * kept for the Tools tab's live region (issue #379). `applied` is absent by
   * construction: a confirmed change is told by the roster itself, never by a
   * duplicated flag.
   */
  capabilitiesToolFeedback?: CapabilitiesToolFeedback | null;
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
  /** The checkout's path; lets the dialog read the worktree's dirtiness (issue #388). */
  worktreePath: string | null;
  /** Plan-handoff descendants deleted with this session; empty = plain delete (issue #309). */
  cascade: PlanHandoffDescendant[];
}

/**
 * One destructive/disruptive session decision awaiting a DOM confirmation
 * (issue #373). Data-only: no promise resolver or callback lives in state —
 * the dialog calls back into the store actions by id. `id` is the
 * confirmation's own identity, so a subject's id travels under its own name.
 */
export type LifecycleConfirmationChoice =
  | { kind: "terminate"; tabId: string; title: string }
  | {
      kind: "switch-mode";
      tabId: string;
      title: string;
      fromMode: SessionMode;
      mode: SessionMode;
    }
  | { kind: "remove-project"; projectPath: string; instanceId: string | null }
  | { kind: "remove-remote-instance"; instanceId: string; nickname: string };

export type LifecycleConfirmation = {
  /** Identity across renders: stale button/Escape invocations must not act. */
  id: string;
  /** True while the accepted effect is in flight: dismissals become no-ops. */
  busy: boolean;
} & LifecycleConfirmationChoice;

/** One backend failure awaiting acknowledgment (issue #373, replaces alert). */
export interface ErrorNotice {
  id: string;
  message: string;
}

export type SettingsPage =
  | "general"
  | "appearance"
  | "updates"
  | "remote"
  | "remote-instances"
  | "providers"
  | "memory"
  | "omp"
  | "advanced"
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
  setTranscriptWidth(width: TranscriptWidth): Promise<void>;
  setGlassChrome(level: GlassChrome): Promise<void>;
  setLocaleId(id: string): Promise<void>;
  setAppUpdateCheckOnLaunch(on: boolean): Promise<void>;
  setAppUpdateTrain(train: UpdateTrain): Promise<void>;
  setOmpUpdateCheckOnLaunch(on: boolean): Promise<void>;
  clearDismissedAppUpdate(): Promise<void>;
  clearDismissedOmpUpdate(): Promise<void>;
  setRemoteEnabled(on: boolean): Promise<void>;
  setRemoteBind(bind: RemoteBind): Promise<void>;
  setRemotePort(port: number): Promise<void>;
  regenerateRemoteToken(): Promise<void>;
  setRemotePassword(password: string): Promise<void>;
  clearRemotePassword(): Promise<void>;
  /** Joins a remote instance (issue #416); rejects so the form shows the message inline. */
  addRemoteInstance(input: RemoteInstanceInput): Promise<void>;
  updateRemoteInstance(id: string, patch: RemoteInstancePatch): Promise<void>;
  removeRemoteInstance(id: string): Promise<void>;
  reconnectRemoteInstance(id: string): Promise<void>;
  readOmpSettings(projectCwd: string | null): Promise<OmpSettingsSnapshot>;
  ensureCompactionSettings(projectCwd: string): Promise<void>;
  writeOmpSetting(key: string, value: OmpSettingValue): Promise<void>;
  /** The installed omp's own web-search provider ids (ADR-0027); never a curated list. */
  readWebSearchProviders(): Promise<WebSearchProviderSnapshot>;
  readProviderKeys(projectCwd: string | null): Promise<ProviderKeysSnapshot>;
  setProviderKey(envName: string, value: string): Promise<ProviderKeysSnapshot>;
  clearProviderKey(envName: string): Promise<ProviderKeysSnapshot>;
  providerOAuth: ProviderOAuthState;
  replaceProviderOAuth(state: ProviderOAuthState): void;
  readProviderOAuth(): Promise<ProviderOAuthStatus[]>;
  startProviderOAuth(id: string): Promise<void>;
  submitProviderOAuthInput(value: string): Promise<void>;
  cancelProviderOAuth(): Promise<void>;
  signOutProviderOAuth(id: string): Promise<ProviderOAuthStatus[]>;
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
  /** A push of some branch of this repo is in flight (issue #414). */
  pushing: boolean;
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
  /** A pending session/project decision awaiting DOM confirmation (issue #373). */
  lifecycleConfirmation: LifecycleConfirmation | null;
  confirmLifecycleAction(id: string): Promise<void>;
  cancelLifecycleAction(id: string): void;
  /** Backend failures awaiting acknowledgment, oldest first (issue #373). */
  errorNotices: ErrorNotice[];
  reportError(error: unknown): void;
  dismissError(id: string): void;
  projectPickerOpen: boolean;
  /** The instance a picked directory registers on; null = local (issue #416). */
  projectPickerInstanceId: string | null;
  /** True while the diagnostic-bundle export dialog is open (issue #413). */
  diagnosticsDialogOpen: boolean;
  worktreeDialogProject: string | null;
  worktreeDialogInstanceId: string | null;
  /** The tab whose Finish worktree dialog is open (issues #385–#389); null = closed. */
  finishWorktreeTab: string | null;
  /** The capabilities viewer's resolved working tree (a worktree session's
   *  checkout, else the project root); null = global scope. `tabId` is the
   *  pinned live session whose roster the skills/tools tabs show. */
  capabilitiesViewer: {
    scopeCwd: string | null;
    tabId?: string;
    section: CapabilitySectionId;
    instanceId: string | null;
  } | null;
	projectSettings: { projectCwd: string; instanceId: string | null } | null;
  /**
   * Bumped per PTY tab when its remote instance rejoins (issue #416): the
   * terminal re-sends its size so the remote PTY repaints at the right shape.
   */
  ptyRedrawRevision: Record<string, number>;
  compactSurface: CompactSurface | null;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  inspectorWidth: number;
  inspectorOpen: boolean;
  init(): Promise<void>;
  openProjectPicker(instanceId?: string | null): void;
  closeProjectPicker(): void;
  openDiagnosticsDialog(): void;
  closeDiagnosticsDialog(): void;
  openCapabilitiesViewer(
    scopeCwd: string | null,
    tabId?: string,
    section?: CapabilitySectionId,
    instanceId?: string | null,
  ): void;
  closeCapabilitiesViewer(): void;
	openProjectSettings(projectCwd: string, instanceId?: string | null): void;
	closeProjectSettings(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  toggleSidebarCollapsed(): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
  restartSession(tabId: string): Promise<boolean>;
  addProject(path: string, instanceId?: string | null): Promise<void>;
  removeProject(path: string, instanceId?: string | null): Promise<void>;
  /** Stages the confirmation that forgets a joined remote instance (issue #416). */
  confirmRemoveRemoteInstance(instanceId: string, nickname: string): void;
  moveProject(
    projectPath: string,
    beforePath: string | null,
    instanceId?: string | null,
  ): Promise<void>;
  moveSession(tabId: string, beforeTabId: string | null): Promise<void>;
  setProjectDefaultModel(
    projectPath: string,
    model: string | null,
    instanceId?: string | null,
  ): Promise<void>;
  setProjectDefaultAdvisorModel(
    projectPath: string,
    model: string | null,
    instanceId?: string | null,
  ): Promise<void>;
  toggleFavorite(key: string, instanceId?: string | null): Promise<void>;
  newSession(
    projectCwd: string,
    modeOverride?: SessionMode,
    instanceId?: string | null,
  ): Promise<void>;
  /**
   * Creates a worktree session; throws on failure (the dialog renders the
   * message inline) — unlike newSession, which reports to the error notices.
   * The spec mints a new branch or checks out an existing local one
   * (issue #390); it lands verbatim in the spawn request's worktree field.
   */
  newWorktreeSession(
    projectCwd: string,
    spec:
      | { mint: { branch: string; baseRef: string | null; baseBranch: string | null } }
      | { checkout: { branch: string } },
    instanceId?: string | null,
  ): Promise<void>;
  /**
   * Converts an unprompted session to a worktree session (issue #225);
   * throws on failure (the composer renders the message inline) — unlike
   * restartSession, which reports to the error notices.
   */
  convertSessionToWorktree(
    tabId: string,
    opts: { branch: string; baseRef: string | null; baseBranch: string | null },
  ): Promise<void>;
  openWorktreeDialog(projectCwd: string, instanceId?: string | null): void;
  closeWorktreeDialog(): void;
  openFinishWorktree(tabId: string): void;
  closeFinishWorktree(): void;
  openSession(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  hideTab(tabId: string): void;
  terminate(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  resumeDead(tabId: string): Promise<void>;
  deleteSession(tabId: string): Promise<void>;
  confirmDeleteSession(skipFuture: boolean): Promise<void>;
  releaseWorktreeSession(
    tabId: string,
    opts: WorktreeReleaseOptions,
  ): Promise<WorktreeReleaseResult | null>;
  /**
   * Merges `source` into a worktree session's checkout (issue #387); null
   * when main rejected — already reported to the error notices.
   */
  syncWorktreeSession(tabId: string, source: string): Promise<WorktreeSyncResult | null>;
  /**
   * Renames a worktree session's branch in the checkout and on its record
   * (issues #386, #389); false when main rejected — already reported.
   */
  renameWorktreeSessionBranch(tabId: string, newName: string): Promise<boolean>;
  cancelDeleteSession(): void;
  bootRpcTab(tabId: string): Promise<void>;
  /** Re-runs get_available_models on a live tab (issue #368: new subscription accounts). */
  refreshAvailableModels(tabId: string): Promise<void>;
  /** Reads the live session's capability roster through the backend getter. */
  refreshCapabilities(tabId: string): Promise<void>;
  /**
   * Session-local enable/disable of one registered tool in the pinned live
   * native session (issue #379): OMP runtime state only — no config write, no
   * restart, no prompt. Resolves with the bridge's own outcome and never
   * throws; the published roster stays authoritative for what the switch
   * shows, so a refusal or an unconfirmed answer leaves it untouched.
   */
  setSessionToolEnabled(
    tabId: string,
    name: string,
    enabled: boolean,
  ): Promise<SetSessionToolEnabledResult>;

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
  loadAdvisorDefaults(projectCwd: string, instanceId?: string | null): Promise<void>;
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
  /** Re-title a live session from its transcript digest (issue #433). A user action, never automatic. */
  regenerateSessionTitle(tabId: string): Promise<void>;
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
  /** PlanReview publishes its local preparation readiness here (§6 guard). */
  setPlanReadiness(
    tabId: string,
    readiness:
      { status: "pending" | "ready" | "failed" | "unavailable"; identity?: string } | null,
  ): void;
  runSlashCommand(tabId: string, line: string): Promise<void>;
  /**
   * One `/goal` or `/guided-goal` line as a command against the session's own
   * goal bridge (issue #381). Never sends goal prose to the model: with no
   * usable bridge it settles the row with the reason instead. */
  runGoalCommand(tabId: string, line: string): Promise<void>;
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
  /**
   * Branch state is keyed by projectKey(instanceId, projectCwd) (issue #416):
   * the same path on two instances is two repositories.
   */
  refreshBranches(
    projectCwd: string,
    opts?: BranchListOptions,
    instanceId?: string | null,
  ): Promise<void>;
  checkoutGitBranch(
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
    instanceId?: string | null,
  ): Promise<string | null>;
  pullGitBranch(projectCwd: string, instanceId?: string | null): Promise<string | null>;
  /**
   * Pushes or publishes one named branch (issue #414). Resolves the structured
   * PushResult — git state is an answer; only a transport failure throws.
   */
  pushGitBranch(
    projectCwd: string,
    branch: string,
    instanceId?: string | null,
  ): Promise<PushResult>;
  /** The host's new-PR URL for base...head; null when the remote has no web face. */
  getPullRequestUrl(
    projectCwd: string,
    base: string,
    head: string,
    instanceId?: string | null,
  ): Promise<string | null>;
  resolveMergeDestination(
    projectCwd: string,
    base: string | null,
    instanceId?: string | null,
  ): Promise<MergeDestination>;
  readMergeBackStatus(
    projectCwd: string,
    branch: string,
    destination: string,
    worktreePath: string | null,
    instanceId?: string | null,
  ): Promise<MergeBackStatus>;
  createBranch(
    projectCwd: string,
    name: string,
    startPoint: string,
    instanceId?: string | null,
  ): Promise<void>;
  mergeWorktreeBranch(
    projectCwd: string,
    branch: string,
    destination: string,
    instanceId?: string | null,
  ): Promise<MergeBackResult>;
  /** Appends a transcript notice (issue #272); no-ops for tabs without rpc state. */
  appendNotice(tabId: string, text: string, level?: "info" | "warn" | "error"): void;
  suggestBranchName(
    projectCwd: string,
    planContext: string,
    instanceId?: string | null,
  ): Promise<string | null>;
}
