import type { MagicKeyword } from "@omp-ui/core/magic-keywords";
import type { SessionCommand } from "@omp-ui/core/session-command";
import type { ProjectSettingsSectionId } from "../components/ProjectSettings";
import type {
  AgentMode,
  ApprovalMode,
  ServiceTier,
  AdvisorDefaults,
  AppUpdateRestartResult,
  AppUpdateState,
  BackendState,
  ExperimentDetail,
  ProjectExperiments,
  BranchList,
  DocumentAttachment,
  GlassChrome,
  BranchListOptions,
  ImageAttachment,
  JudgeModelSnapshot,
  KnowledgeHome,
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
  ProviderSignOutResult,
  RemoteBind,
  RemoteInstanceInput,
  RemoteInstancePatch,
  RemoteState,
  SessionMode,
  SttModelSnapshot,
  TranscriptWidth,
  UpdateTrain,
  WorktreeReleaseOptions,
  WorktreeReleaseResult,
  WebSearchProviderSnapshot,
  WorktreeSyncResult,
  PushResult,
} from "@omp-ui/core/types";
import type { DocumentRef } from "../lib/document-context";
import type {
  BrowserPaneFrameHeader,
  BrowserPaneState,
  BrowserPaneUnavailableReason,
} from "@omp-ui/core/browser-pane";
import type { PlanReviewRequest, PlanStatus } from "@omp-ui/core/plan";
import type { AdvisorStatsView } from "@omp-ui/core/advisor-stats";
import type { LimitsView } from "@omp-ui/core/limits";
import type { McpRuntimeStatus } from "@omp-ui/core/mcp-status";
import type {
  CapabilitySectionId,
  CapabilitySnapshot,
  SetSessionToolEnabledResult,
} from "@omp-ui/core/capabilities";
import type { GoalState } from "@omp-ui/core/goal";
import type { VibeSnapshot } from "@omp-ui/core/vibe";
import type { BtwSnapshot } from "@omp-ui/core/side-questions";
import type { LiveSnapshot } from "@omp-ui/core/live-voice";
import type { RailTab } from "../lib/panel-layout";
import type { AutoresearchSnapshot, ExperimentProposal } from "@omp-ui/core/autoresearch";
import type { ApprovalPrompt } from "@omp-ui/core/approval";
import type { CompactionThresholdSettings } from "@omp-ui/core/compaction-threshold";
import type {
  PlanExecutionContext,
  PlanExecutionOptions,
} from "../lib/plan-concerns";
import type { GitResolutionTrigger } from "../lib/git-resolution-prompt";
import type {
  ModelInfo,
  PromptRoute,
  SessionRuntime,
  SessionStats,
  SlashCommandInfo,
  SubagentInfo,
  TodoPhase,
} from "../lib/rpc-types";
import type { CollabAccess, CollabTabState } from "@omp-ui/core/collab";
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

/** A subagent verb the Agents pane dispatches (issues #684, #713). */
export type SubagentControlAction = "steer" | "kill";

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
  /** Issue #774: the model omp could not restore, when the death was a
   *  resume that found its saved model gone. Drives the model picker on the
   *  failure surface; absent on every other failure. */
  failedModel?: string;
}


/** Optional revision instructions sent back to the planner on refine. */
export interface PlanRevisionNotes {
  text: string;
  images?: ImageAttachment[];
  /** Resolved scratch paths; refinePlan re-sends them with zero re-upload. */
  documents?: DocumentRef[];
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

/**
 * The renderer's posture on one tab's browser pane (issue #519). `open` and
 * `fullscreen` are the user's choices and survive a process reboot (#528);
 * `ensure` is the answer to the last `browserPaneEnsure` and restarts at
 * `idle` whenever the pane component remounts.
 */
export interface BrowserPaneView {
  open: boolean;
  fullscreen: boolean;
  /** True when the #530 auto-open opened this pane and no user action has
   * touched it since; only such a pane auto-closes when the agent detaches. */
  agentOpened: boolean;
  ensure: "idle" | "pending" | "available" | "unavailable" | "not-live";
  unavailableReason: BrowserPaneUnavailableReason | null;
  state: BrowserPaneState | null;
  /** Physical size of the last painted frame; null until one arrives. */
  frame: BrowserPaneFrameHeader | null;
}

/**
 * A manual compaction's verdict as the renderer knows it. `pending` means omp
 * has neither acknowledged nor refused it yet — past the response budget the
 * ack is still coming, and only the response frame can prove the work landed
 * (issue #625).
 */
export type CompactionOutcome = "acked" | "pending" | "failed";

/** `predict_word_feedback` fields: the draft and caret at which `suggestion` was shown. */
export interface WordPredictionFeedback {
  text: string;
  cursor: number;
  suggestion: string;
  accepted: boolean;
}

/** Per-tab rpc-ui state (the phase-2 doc's state machine, concretized). */
export interface RpcTabState {
  status: "starting" | "ready" | "running" | "error";
  /** Keywords OMP actually consumed in the current root input generation. */
  activeTurnKeywords: readonly MagicKeyword[];
  /** Refuses user commands while a lifecycle mutation drains the old process. */
  commandAdmissionBlocked?: boolean;
  items: RenderItem[];
  /** Increments once per visible transcript commit; drives event-paced liveness motion. */
  transcriptRevision: number;
  todos: TodoPhase[];
  model: ModelInfo | null;
  availableModels: ModelInfo[];
  commands: SlashCommandInfo[];
  session: SessionRuntime;
  stats: SessionStats | null;
  subagents: SubagentInfo[];
  subagentItems: Record<string, RenderItem[]>;
  selectedSubagent: string | null;
  browserPane: BrowserPaneView;
  /**
   * Attachments handed to the composer from outside it — the browser pane's
   * attach-to-prompt button. Drained once by the composer's effect.
   */
  composerQueue?: { images: ImageAttachment[]; documents?: DocumentAttachment[]; text: string[] };
  subagentMarkers: Map<string, string>;
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
  stallCount: number;
  /** The turn's terminal assistant message end; drives settle target and stall classification. */
  lastTurn?: LastTurnMeta;
  /** A main-process watchdog abort notice arrived; the next agent_end feeds auto-continue (issue #254). */
  stallAbortPending?: boolean;
  extensionQueue: unknown[];
  /** True while any rpc command is in flight. */
  busy: boolean;
  /**
   * A manual compaction this tab started whose completion omp has not yet
   * confirmed. Its ack is the completion event, and a compaction larger than
   * the response budget holds this set past that budget's expiry: the
   * transcript's start Marker stays open and the Session HUD keeps reading
   * "compacting" until the response frame lands (issue #625).
   */
  compacting?: { startedAt: number };
  failure?: RpcFailure;
  initialPrompt: string | null;
  hasRenamed: boolean;
  /** Outstanding auto-title attempt: dispatched at `at`, attempt `n` of
   *  MAX_RENAME_ATTEMPTS; judged against the record's title at later turn
   *  ends (issue #791). */
  titleAttempt: { at: number; n: number } | null;
  plan: PlanStatus | null;
  planReview: { request: PlanReviewRequest; frame: unknown } | null;
  /** The agent's pending propose_experiment select, until Launch or Cancel answers it (issue #567). */
  experimentProposal: { proposal: ExperimentProposal; frame: unknown } | null;
  /** The agent's pending `Allow tool:` select, until Allow or Deny answers it
   *  (issue #681). Routed here instead of extensionQueue; the approval card
   *  renders it while main still counts the frame as a blocking dialog. */
  approvalPrompt: { prompt: ApprovalPrompt; frame: unknown } | null;
  planText: string | null;
  planHtml: string | null;
  planDeferred: boolean;
  /** PlanReview's local preparation verdict for the current gate (§6 guard). */
  planReadiness: PlanReadiness | null;
  advisorStats: AdvisorStatsView | null;
  mcpStatus: McpRuntimeStatus | null;
  /** The root session's loaded skills/tool roster; null until first observed. */
  capabilities: CapabilitySnapshot | null;
  /**
   * omp's goal state as its last goal response, get_state, or goal_updated
   * reported it (ADR-0046); null = no goal or not yet known. Display state
   * only: omp's runtime in the child owns the goal and its continuation.
   */
  goal: GoalState | null;
  /**
   * The session's vibe snapshot as the root vibe bridge published it (issue
   * #683): the director's mode flag and worker roster. Display state only —
   * the child process owns omp's vibe runtime; a malformed publish leaves the
   * last good snapshot standing.
   */
  vibe: VibeSnapshot | null;
  /**
   * The session's side questions (`/btw`) as the bridge published them (issue
   * #682). Display state only: the child process owns the history files. A
   * malformed publish leaves the last good snapshot standing.
   */
  sideQuestions: BtwSnapshot | null;
  /**
   * Live voice (issue #778) as omp's `live_*` frames reported it. Display
   * state only: the child process owns the realtime session, and the frames
   * replace by (role, turn) — snapshot semantics, never transcript rows.
   */
  live: LiveSnapshot | null;
  /** The verb in flight per agent id; the pane's disabled state reads this. */
  subagentControlBusy: Record<string, SubagentControlAction>;
  /** The last verb's failure line — omp's own sentence, or the update hint; cleared by the next dispatch. */
  subagentControlError: string | null;
  /**
   * The session's autoresearch snapshot as the root bridge published it
   * (ADR-0030): mode, goal and last tool activity. Display state only — omp's
   * DB is the record of runs, read through the Lab's channels.
   */
  autoresearch: AutoresearchSnapshot | null;
  /** Rate-window snapshot as the limits bridge published it (issue #673); null until first observed. */
  limits: LimitsView | null;
  /**
   * The retry layer rotated a credential or waited on a rate window during
   * THIS turn (issue #673): set by auto_retry frames, cleared at the next
   * agent_start, so the chip lives exactly through the turn that experienced it.
   */
  quotaEvent?: { at: number; kind: "rotation" | "wait"; delayMs?: number } | null;
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
  | { kind: "remove-remote-instance"; instanceId: string; nickname: string }
  | {
      /** Rewind the live tab to one user prompt via omp's in-place `branch`
       *  (issue #680). `entryId` stays valid even if the leaf moves: entries
       *  are never deleted. `laterTurns` is the dialog's count of discarded
       *  transcript rows. */
      kind: "rewind";
      tabId: string;
      entryId: string;
      laterTurns: number;
      editResend: boolean;
    }
  | {
      /** Jump the live tab's leaf onto another tree entry through the tree
       *  bridge (issue #680, Phase 2). `summarize` asks omp for a summary
       *  turn across the abandoned tail. */
      kind: "navigate";
      tabId: string;
      entryId: string;
      summarize: boolean;
      laterTurns: number;
    }
  | {
      /** Fork the live tab at one entry via omp's native `fork` RPC
       *  (issue #717): the tab moves to a new session file holding the
       *  path through `entryId` (inclusive); the source file is untouched.
       *  `laterTurns` = entries leaving the current branch, counted the
       *  rewind way — on-path rows count the tail, off-path rows the
       *  divergent current branch. */
      kind: "fork";
      tabId: string;
      entryId: string;
      laterTurns: number;
    };

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
  | "knowledge-vault"
  | "omp"
  | "experimental"
  | "advanced"
  | "about";

export type CompactSurface =
  "sessions" | "inspector" | "session-actions" | "composer-options" | "browser-pane";

/** What the sidebar group dialog edits (issue #745); in-memory, never persisted. */
export type SidebarGroupDialogRequest =
  | { kind: "create" }
  | { kind: "rename"; groupId: string }
  | { kind: "move"; projectPath: string };

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
  setDefaultAutoThinking(on: boolean): Promise<void>;
  setSubagentModelInheritByDefault(on: boolean): Promise<void>;
  setSkipDeleteConfirmation(skip: boolean): Promise<void>;
  setExperimentsEnabled(on: boolean): Promise<void>;
  /** Shows/hides the composer mic button app-wide (issue #647). */
  setVoiceInputEnabled(on: boolean): Promise<void>;
  /** The app-wide dictation model; null auto-resolves at call time. */
  setSttModel(model: string | null): Promise<void>;
  setThemeId(id: string): Promise<void>;
  setFontFamilyId(id: string): Promise<void>;
  setTranscriptWidth(width: TranscriptWidth): Promise<void>;
  setGlassChrome(level: GlassChrome): Promise<void>;
  setLocaleId(id: string): Promise<void>;
  setAppUpdateCheckOnLaunch(on: boolean): Promise<void>;
  setAppUpdateTrain(train: UpdateTrain): Promise<void>;
  /** Knowledge vault registry (issue #764); always the local backend, which on a web client is the host's (#759). Rejects so the picker shows the refusal inline. */
  addVault(path: string): Promise<void>;
  /** Null after a reported failure. */
  importVaults(ids: string[]): Promise<{ added: string[]; skipped: string[] } | null>;
  removeVault(name: string): Promise<void>;
  setDefaultWriteVault(name: string): Promise<void>;
  /** Rejects so the home-folder field shows the refusal inline. */
  setVaultHomeFolder(name: string, homeFolder: string): Promise<void>;
  setVaultWritesOutsideHome(name: string, on: boolean): Promise<void>;
  openVault(name: string, file: string | null): Promise<void>;
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
  /** Re-reads a joined instance's session list; dials now from any other status (#658). */
  refreshRemoteInstanceState(id: string): Promise<void>;
  readOmpSettings(projectCwd: string | null): Promise<OmpSettingsSnapshot>;
  ensureCompactionSettings(projectCwd: string): Promise<void>;
  writeOmpSetting(key: string, value: OmpSettingValue): Promise<void>;
  /** The installed omp's own web-search provider ids (ADR-0027); never a curated list. */
  readWebSearchProviders(): Promise<WebSearchProviderSnapshot>;
  /** The installed omp's STT catalog for the dictation picker (issue #647). */
  readSttModels(): Promise<SttModelSnapshot>;
  readProviderKeys(projectCwd: string | null): Promise<ProviderKeysSnapshot>;
  /** The installed omp's judge-kind catalog for the judge role row (issue #669). */
  readJudgeModels(): Promise<JudgeModelSnapshot>;
  setProviderKey(
    projectCwd: string | null,
    envName: string,
    value: string,
  ): Promise<ProviderKeysSnapshot>;
  clearProviderKey(projectCwd: string | null, envName: string): Promise<ProviderKeysSnapshot>;
  providerOAuth: ProviderOAuthState;
  replaceProviderOAuth(state: ProviderOAuthState): void;
  readProviderOAuth(): Promise<ProviderOAuthStatus[]>;
  startProviderOAuth(id: string): Promise<void>;
  submitProviderOAuthInput(value: string): Promise<void>;
  cancelProviderOAuth(): Promise<void>;
  signOutProviderOAuth(id: string, credentialId: number): Promise<ProviderSignOutResult>;
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
  /** Any listBranches is in flight — gates the pull/push rows. */
  refreshing: boolean;
  /**
   * A refresh that fetches the configured upstream is in flight — the sole
   * trigger for the popover's `composer.branch.refreshing` row (issue #506).
   * A local reload must not claim upstream work.
   */
  fetching: boolean;
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

/**
 * The Lab main-pane surface (CONTEXT.md "Lab"): which projects it scopes and,
 * when set, the one experiment whose detail view is open. `null` on the store
 * means the Lab is closed; any tab activation through `focusOn` closes it.
 */
export interface LabView {
  /** null = every project; otherwise one project's experiments. */
  projectCwd: string | null;
  instanceId: string | null;
  /** Detail view target; null = overview. */
  experiment: {
    projectCwd: string;
    instanceId: string | null;
    /** The owned worktree session whose checkout's DB holds it; null = the project checkout. */
    tabId: string | null;
    experimentId: number;
  } | null;
}

/** Cached `autoresearch:overview` answer for one project (keyed by projectKey). */
export interface ExperimentsCache {
  load: "idle" | "loading" | "ready" | "error";
  result: ProjectExperiments | null;
  /** Keyed `${tabId ?? ""}:${experimentId}`. */
  detail: Record<string, { load: "loading" | "ready" | "error"; value: ExperimentDetail | null }>;
  error: string | null;
  revision: number;
}

/** What the New experiment dialog submits: init_experiment's parameters plus the launch's own fields. */
export interface NewExperimentSpec {
  goal: string;
  metric: string;
  unit: string;
  direction: "lower" | "higher";
  /** null = the agent writes ./autoresearch.sh itself. */
  command: string | null;
  scopePaths: string[];
  offLimits: string[];
  constraints: string[];
  maxIterations: number | null;
  /** Not an init_experiment parameter: what the proposing agent learned, appended to the kickoff. null from the blank form. */
  brief: string | null;
  model: ModelInfo | null;
  /** null = launch at the project checkout (not a git repo). */
  worktree: { mint: { branch: string; baseRef: string | null; baseBranch: string | null } } | null;
}

export interface LabSlice {
  lab: LabView | null;
  experimentDialog: { projectCwd: string; instanceId: string | null; proposalTabId?: string } | null;
  /** By projectKey(instanceId, projectCwd). */
  experiments: Record<string, ExperimentsCache>;
  /**
   * Opens the Lab overview (null = all projects). With `focus.tabId`, opens the
   * detail of that tab's linked experiment when the cache already knows it,
   * else the overview scoped to the tab's project.
   */
  openLab(projectCwd?: string | null, instanceId?: string | null, focus?: { tabId: string }): void;
  openLabExperiment(target: NonNullable<LabView["experiment"]>): void;
  closeLab(): void;
  openExperimentDialog(projectCwd: string, instanceId?: string | null, proposalTabId?: string): void;
  closeExperimentDialog(): void;
  /** Holds the proposal on its tab; opens the dialog for it when none is open, else it waits its turn. */
  acceptExperimentProposal(tabId: string, proposal: ExperimentProposal, frame: unknown): void;
  /** Answers the pending select (skipping the send when the tab's process has exited) and clears it. False when none is pending. */
  answerExperimentProposal(tabId: string, value: string): boolean;
  /**
   * Starts the interview: in `inTab` when given (a live rpc-ui tab), else in a
   * fresh rpc-ui session for the project. Closes any open experiment dialog first.
   */
  startExperimentInterview(projectCwd: string, instanceId: string | null, description: string, inTab?: string): Promise<void>;
  /** Guarded by a per-project generation so a late reply never overwrites a newer one. */
  loadExperiments(projectCwd: string, instanceId?: string | null): Promise<void>;
  loadExperimentDetail(target: NonNullable<LabView["experiment"]>): Promise<void>;
  /**
   * Spawns the experiment session (worktree when `spec.worktree`), waits for
   * ready, applies the model, arms omp's mode with bare `/autoresearch`, then
   * sends the kickoff prompt. Throws on spawn failure so the dialog renders
   * the message inline (like newWorktreeSession). With `gate`, a successful
   * spawn answers the proposing tab's blocked select with the spec as launched.
   */
  newExperiment(
    projectCwd: string,
    spec: NewExperimentSpec,
    instanceId?: string | null,
    gate?: { tabId: string },
  ): Promise<void>;
  /** `/autoresearch off` on a live rpc-ui tab; refused with an error notice otherwise. */
  stopExperiment(tabId: string): Promise<void>;
  /** Prompts a fresh segment (init_experiment new_segment) on a live rpc-ui tab. */
  startNewSegment(tabId: string): Promise<void>;
}

/**
 * The Stats main-pane surface (CONTEXT.md "Stats view"): the range it reads.
 * `null` on the store means the surface is closed; any tab activation
 * through `focusOn` closes it (issue #668).
 */
export interface StatsView {
  /** null = all time; 7 / 30 = the range presets. */
  rangeDays: number | null;
}

export interface StatsSlice {
  stats: StatsView | null;
  openStats(rangeDays?: number | null): void;
  setStatsRange(rangeDays: number | null): void;
  closeStats(): void;
}

/**
 * One tab's live-share posture (issue #686): `off` = no host this tab (omp
 * exposes none or `/collab stop` ran), `sharing` carries the registry row's
 * state. Native tabs cannot host at all — omp's command lives in the TUI —
 * a fact the dialog reads from tab mode, not from this map.
 */
export type CollabTabView = { kind: "off" } | { kind: "sharing"; state: CollabTabState };

export interface UiStore extends SettingsSlice, UpdatesSlice, LabSlice, StatsSlice {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  focusedTabByProject: Record<string, string>;
  restoringTabs: boolean;
  exited: Record<string, number>;
  shellExited: Record<string, number>;
  /** True for tabs whose process omp-ui hibernated while idle (issue #246). */
  hibernated: Record<string, boolean>;
  /** Active source → implementation plan handoffs derived from persisted records. */
  handedOffFor: Record<string, string>;
  /** Last persisted handoff relation observed, including human-released sources. */
  observedPlanHandoffs: Record<string, string>;
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
  /** Stages one pending session decision (#373); every caller of a
   *  confirmation-gated action reaches it through the store. */
  stageLifecycleConfirmation(choice: LifecycleConfirmationChoice): void;
  confirmLifecycleAction(id: string): Promise<void>;
  cancelLifecycleAction(id: string): void;
  /** Backend failures awaiting acknowledgment, oldest first (issue #373). */
  errorNotices: ErrorNotice[];
  reportError(error: unknown): void;
  dismissError(id: string): void;
  /** Per-tab live-share state (issue #686); absent = off. */
  collab: Record<string, CollabTabView>;
  /** The tab whose Share-live dialog is open (issue #686); null = closed. */
  shareLiveTab: string | null;
  /** The tab/access a first live share (issue #686) awaits privacy
   *  confirmation for; null = closed. */
  shareLiveConfirmTab: { tabId: string; access: CollabAccess } | null;
  openShareLive(tabId: string): void;
  /** Records the privacy flag and starts the pending live share. */
  confirmShareLivePrivacy(): void;
  cancelShareLivePrivacy(): void;
  closeShareLive(): void;
  /** `/collab` (full) or `/collab view` into the tab's TUI via main. */
  startCollab(tabId: string, access: CollabAccess): Promise<void>;
  stopCollab(tabId: string): Promise<void>;
  /** One generation-bound link; `view` asks for the read-only variant. */
  collabLink(tabId: string, view: boolean): Promise<string>;
  applyCollabState(tabId: string, state: CollabTabState | null): void;
  projectPickerOpen: boolean;
  /** The instance a picked directory registers on; null = local (issue #416). */
  projectPickerInstanceId: string | null;
  /** The open sidebar group dialog (issue #745); null = closed. */
  sidebarGroupDialog: SidebarGroupDialogRequest | null;
  /** True while the first-run Getting started checklist overlay is open (issue #623). */
  gettingStartedOpen: boolean;
  /** True while the diagnostic-bundle export dialog is open (issue #413). */
  diagnosticsDialogOpen: boolean;
  browserPaneClearDialogOpen: boolean;
  /** The tab whose first-share privacy dialog is open (issue #679); null = closed. */
  shareConfirmTab: string | null;
  worktreeDialogProject: string | null;
  worktreeDialogInstanceId: string | null;
  /** The tab whose Finish worktree dialog is open (issues #385–#389); null = closed. */
  finishWorktreeTab: string | null;
  /** The session tree navigator (issue #680, Phase 2): the pinned live tab
   *  whose tree is open; null = closed. */
  sessionTreeView: { tabId: string } | null;
  /** The capabilities viewer's resolved working tree (a worktree session's
   *  checkout, else the project root); null = global scope. `tabId` is the
   *  pinned live session whose roster the skills/tools tabs show. */
  capabilitiesViewer: {
    scopeCwd: string | null;
    tabId?: string;
    section: CapabilitySectionId;
    instanceId: string | null;
  } | null;
	projectSettings: { projectCwd: string; instanceId: string | null; section?: ProjectSettingsSectionId } | null;
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
  /** Split browser pane width preference (issue #519). */
  browserPaneWidth: number;
  /** Sidebar host filter (issue #507): "all" | "local" | a joined instance id. */
  hostScope: string;
  init(): Promise<void>;
  openProjectPicker(instanceId?: string | null): void;
  closeProjectPicker(): void;
  openSidebarGroupDialog(request: SidebarGroupDialogRequest): void;
  closeSidebarGroupDialog(): void;
  openGettingStarted(): void;
  dismissGettingStarted(): void;
  openDiagnosticsDialog(): void;
  closeDiagnosticsDialog(): void;
  openBrowserPaneClearDialog(): void;
  closeBrowserPaneClearDialog(): void;
  /** Records the first-share privacy flag and forwards /share for the tab (issue #679). */
  confirmSharePrivacy(tabId: string): Promise<void>;
  cancelSharePrivacy(): void;
  /** Opens the tree navigator for a live tab and arms its bridge (issue #680). */
  openSessionTreeView(tabId: string): void;
  closeSessionTreeView(): void;
  openCapabilitiesViewer(
    scopeCwd: string | null,
    tabId?: string,
    section?: CapabilitySectionId,
    instanceId?: string | null,
  ): void;
  closeCapabilitiesViewer(): void;
	openProjectSettings(projectCwd: string, instanceId?: string | null, section?: ProjectSettingsSectionId): void;
	closeProjectSettings(): void;
  showCompactSurface(surface: CompactSurface): void;
  closeCompactSurface(): void;
  toggleSidebarCollapsed(): void;
  setSidebarWidth(width: number): void;
  setInspectorWidth(width: number): void;
  setInspectorOpen(open: boolean): void;
  /** A pending request to show one rail pane for a tab; the mounted rail applies each `nonce` once (issue #682). */
  railPaneFocus: Record<string, { pane: RailTab; nonce: number }>;
  focusRailPane(tabId: string, pane: RailTab): void;
  setBrowserPaneWidth(width: number): void;
  /** Opens the tab's browser pane and asks main to ensure its page exists. */
  openBrowserPane(tabId: string): void;
  closeBrowserPane(tabId: string): void;
  toggleBrowserPane(tabId: string): void;
  setBrowserPaneFullscreen(tabId: string, on: boolean): void;
  /** Re-runs `browserPaneEnsure` for the tab; a stale answer for a rebuilt tab is dropped. */
  ensureBrowserPane(tabId: string): Promise<void>;
  /** A `browser-pane:state` push; auto-opens the pane when the agent first attaches (#530). */
  handleBrowserPaneState(tabId: string, state: BrowserPaneState): void;
  /** Records the painted frame's size; a no-op while the dimensions are unchanged. */
  noteBrowserPaneFrame(tabId: string, header: BrowserPaneFrameHeader): void;
  queueComposerAttachment(tabId: string, image: ImageAttachment, text: string): void;
  queueComposerDocument(tabId: string, document: DocumentAttachment, text: string): void;
  /** Queues prose with no image — the rewind's edit-and-resend prefill
   *  (issue #680); the composer drains it like an attachment hand-back. */
  queueComposerText(tabId: string, text: string): void;
  /** Takes the queued attachments; null when nothing is queued. */
  drainComposerQueue(tabId: string): {
    images: ImageAttachment[];
    documents?: DocumentAttachment[];
    text: string[];
  } | null;
  setHostScope(scope: string): void;
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
  /** Sidebar groups (issue #745) — always this computer's registry. Rejects with the backend's message so the dialog can show it inline. */
  createSidebarGroup(name: string, projectPath: string | null): Promise<void>;
  /** Rejects with the backend's message so the dialog can show it inline. */
  renameSidebarGroup(groupId: string, name: string): Promise<void>;
  /** This and the next three report failures through reportError and never reject. */
  removeSidebarGroup(groupId: string): Promise<void>;
  moveSidebarGroup(groupId: string, beforeGroupId: string | null): Promise<void>;
  setSidebarGroupCollapsed(groupId: string, collapsed: boolean): Promise<void>;
  setProjectSidebarGroup(projectPath: string, groupId: string | null): Promise<void>;
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
  setProjectBrowserClock(projectPath: string, on: boolean, instanceId?: string | null): Promise<void>;
  setProjectKnowledgeHome(projectPath: string, home: KnowledgeHome | null, instanceId?: string | null): Promise<void>;
  /** Registry names of the owning instance's vaults (issue #766): this host's, or a joined instance's. */
  vaultNames(instanceId?: string | null): Promise<string[]>;
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
  /** Relaunch a dead tab forcing `model` (issue #774's recovery resume). */
  resumeWithModel(tabId: string, model: string): Promise<void>;
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
  /** Spawns a native resolution session in the explicitly addressed instance's
   * checkout, reusing its registered worktree when applicable. True only once
   * that session acknowledges the resolution prompt. */
  spawnGitResolution(
    projectCwd: string,
    trigger: GitResolutionTrigger,
    instanceId?: string | null,
  ): Promise<boolean>;
  /** Resolves the owning project's stopped merge without returning the worktree.
   * A stale route or unsafe source/target refuses dispatch; success is an ack. */
  resolveWorktreeMerge(
    tabId: string,
    trigger: Extract<GitResolutionTrigger, { kind: "merge" }>,
    route: "current" | "fresh",
  ): Promise<boolean>;
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
    cmd: SessionCommand,
    opts?: { quiet?: boolean; captureId?: (id: string) => void },
  ): Promise<unknown>;
  handleRpcFrame(tabId: string, frame: object): void;
  answerExtension(
    tabId: string,
    request: unknown,
    response: Record<string, unknown>,
  ): void;
  /**
   * Aligns each open rpc tab's blocking-dialog queue with main's
   * `pendingDialogs` list (issue #555). Safe to run on every state read.
   */
  reconcilePendingDialogs(state: BackendState): void;
  setInitialPrompt(tabId: string, prompt: string): void;
  renameSession(tabId: string): void;
  sendPrompt(
    tabId: string,
    message: string,
    route?: PromptRoute,
    images?: ImageAttachment[],
    docRefs?: DocumentRef[],
  ): Promise<boolean>;
  abortAgent(tabId: string): Promise<void>;
  abortAndPrompt(
    tabId: string,
    message: string,
    images?: ImageAttachment[],
    docRefs?: DocumentRef[],
  ): Promise<void>;
  loadAdvisorDefaults(projectCwd: string, instanceId?: string | null): Promise<void>;
  setSessionAdvisor(
    tabId: string,
    advisor: boolean,
    advisorModel: string | null,
  ): Promise<void>;
  /** Pins the session's approval mode (issue #681); a live rpc session relaunches. */
  setSessionApprovalMode(tabId: string, mode: ApprovalMode | null): Promise<void>;
  setAdvisorModel(tabId: string, selector: string | null): Promise<void>;
  setModel(tabId: string, model: ModelInfo): Promise<void>;
  setThinkingLevel(tabId: string, level: string): Promise<void>;
  setSteeringMode(tabId: string, mode: string): Promise<void>;
  setFollowUpMode(tabId: string, mode: string): Promise<void>;
  /**
   * Moves the first queued user follow-up whose queue-chip text is `message`
   * into omp's steering queue (issue #714). Never falls back to `steer`.
   */
  promoteQueuedMessage(tabId: string, message: string): Promise<void>;
  /**
   * Withdraws one queued message whose queue-chip text is `message` from
   * omp's `queue` and restores it — prose, images, documents — to the
   * composer draft (issue #776). Never falls back to another verb: a
   * rejection is recorded and nothing else is sent.
   */
  editQueuedMessage(tabId: string, message: string, queue: "steering" | "followUp"): Promise<void>;
  setInterruptMode(tabId: string, mode: string): Promise<void>;
  setAutoCompaction(tabId: string, enabled: boolean): Promise<void>;
  setFastMode(tabId: string, enabled: boolean): Promise<void>;
  /** Toggles omp's slow mode (issue #777); the response's `enabled` is the
   *  computed truth, followed by a get_state re-read for the stage chip. */
  setSlowMode(tabId: string, enabled: boolean): Promise<void>;
  /** Starts omp's live voice session (issue #778); truth arrives as the
   *  `live_*` frames, the ack only settles start/stop/mute dispatch. */
  startLiveVoice(tabId: string): Promise<void>;
  /** Stops omp's live voice session (issue #778); `live_end` is the truth. */
  stopLiveVoice(tabId: string): Promise<void>;
  /** Toggles the live session's mute (issue #778); `live_phase` "muted"
   *  reports omp's truth, so no local toggle state is kept. */
  setLiveMuted(tabId: string, muted: boolean): Promise<void>;
  /** Drops the live error strip; keeps a running session's snapshot. */
  clearLiveError(tabId: string): void;
  /** Writes the tier this session's fast selection names (issue #719);
   *  applied by the next spawn's replay — never a respawn. null clears. */
  setSessionServiceTier(tabId: string, tier: ServiceTier | null): Promise<void>;
  /** Picks the fast-mode tier from the control (off rides setFastMode).
   *  Enabling on a tier goes straight to it — no intermediate priority
   *  set; a declined ultrafast pick re-sends `/fast ultra` (issue #719). */
  setServiceTier(tabId: string, tier: ServiceTier): Promise<void>;
  setAutoRetry(tabId: string, enabled: boolean): Promise<void>;
  abortRetry(tabId: string): Promise<void>;
  /** Holds an approval frame on its tab, split out of the generic queue (issue #681). */
  acceptApprovalPrompt(tabId: string, prompt: ApprovalPrompt, frame: unknown): void;
  /** Answers the pending approval (skipping the send when the process exited) and clears it. False when none is held. */
  answerApprovalPrompt(tabId: string, verdict: "Approve" | "Deny"): boolean;
  /**
   * Compacts the context. Resolves `acked` only when omp acknowledged the
   * compaction (#336), `pending` when it is still running past the response
   * budget, and `failed` when omp refused it or the process left.
   * `waitForCompletion` additionally rides out a `pending` compaction until
   * its ack lands or COMPACT_SETTLE_DEADLINE_MS passes — the plan-execution
   * caller's contract, since dispatching into a context that never compacted
   * is the failure #336 was filed for.
   */
  compactSession(
    tabId: string,
    options?: { waitForCompletion?: boolean },
  ): Promise<CompactionOutcome>;
  exportHtml(tabId: string): Promise<void>;
  /** Shares the session through omp's /share, gated on the first-share privacy
   *  dialog (issue #679). Native (rpc-ui) sessions only; the command must be
   *  advertised by the tab or the action leaves a notice instead of sending. */
  shareSession(tabId: string): Promise<void>;
  branchSession(tabId: string): Promise<void>;
  /**
   * Rewinds a live native session to one user prompt in place via omp's
   * `branch` RPC (issue #680): the discarded turns stay in the session file
   * as a non-leaf branch. Staging correlates the clicked transcript row with
   * its entry id and stages the confirmation; `performRewind` is the accepted
   * effect, run only by the lifecycle confirmation.
   */
  stageRewind(tabId: string, itemIndex: number, editResend: boolean): Promise<void>;
  performRewind(tabId: string, entryId: string, editResend: boolean): Promise<void>;
  /** Re-reads the current branch's model context into the transcript
   *  (get_messages → items, wholesale replace). The boot hydration contract,
   *  reused after an in-place rewind (issue #680). */
  reloadHistory(tabId: string): Promise<void>;
  /**
   * Jumps the live tab's leaf onto another tree entry through the tree
   * bridge (issue #680, Phase 2): dispatches the hidden navigate command,
   * settles from the published snapshot, then reloads history. The accepted
   * effect of the `navigate` lifecycle confirmation.
   */
  performNavigate(tabId: string, entryId: string, summarize: boolean): Promise<void>;
  renameSessionTo(tabId: string, name: string): Promise<void>;
  /** The navigator's rewind: the entry id comes from the tree, so no
   *  positional correlation runs (issue #680). */
  stageRewindEntry(tabId: string, entryId: string, editResend: boolean): Promise<void>;
  /** Stages the native-`fork` confirmation (issue #717) for a tree row whose
   *  entry id is already known; validates the entry is a message and counts
   *  the turns the current branch gives up. */
  stageForkEntry(tabId: string, entryId: string): Promise<void>;
  /** The accepted fork effect: send `fork`, then reload + re-merge identity. */
  performFork(tabId: string, entryId: string): Promise<void>;
  /** Stages a tree jump for a non-prompt entry (issue #680, Phase 2). */
  stageNavigate(tabId: string, entryId: string, summarize: boolean): Promise<void>;
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
  /** Re-raises the review for an interrupted plan (ADR-0033). */
  representPlan(tabId: string, planFilePath: string, title: string): Promise<void>;
  /** Stops tracking an interrupted plan; main refuses a live gate. */
  dismissProposedPlan(tabId: string, planFilePath: string): Promise<void>;
  /** PlanReview publishes its local preparation readiness here (§6 guard). */
  setPlanReadiness(
    tabId: string,
    readiness:
      { status: "pending" | "ready" | "failed" | "unavailable"; identity?: string } | null,
  ): void;
  runSlashCommand(tabId: string, line: string): Promise<void>;
  /** One "!" draft as omp's concurrent bash command; settles its shell row
   *  from the response. No model turn (issue #678). */
  runShellCommand(tabId: string, command: string): Promise<void>;
  /** omp's abort_bash: cancels every bash running in the tab's process. */
  abortShellCommands(tabId: string): Promise<void>;
  /**
   * omp's ghost-text word completion for the draft (issue #715): the suffix
   * for the prose word ending at `cursor`, or null. Never throws, never
   * paints a failure; an omp without the command or a failing daemon
   * answers null without re-sending (unsupported: until the process is
   * replaced; failure: 30 s).
   */
  predictWord(tabId: string, text: string, cursor: number): Promise<string | null>;
  /** Feeds omp's learner the fate of a shown ghost (issue #715). Fire-and-forget. */
  sendWordPredictionFeedback(tabId: string, feedback: WordPredictionFeedback): void;
  /**
   * One `/goal` or `/guided-goal` line: dispatches omp's native goal command
   * (ADR-0046). Never sends goal prose to the model; a refusal settles the
   * row with omp's reason. */
  runGoalCommand(tabId: string, line: string): Promise<void>;
  /**
   * One `/vibe` line as a command against the session's own vibe bridge
   * (issue #683). Never sends director prose to the model: with no usable
   * bridge it settles the row with the reason instead. Worker traffic
   * (`/vibe spawn|send|wait|kill`) rides the bridge's hidden command channel,
   * not the prompt path. */
  runVibeCommand(tabId: string, line: string): Promise<void>;
  /** Dispatches one hidden bridge command quietly (issue #680). */
  runHiddenCommand(tabId: string, command: string, args: string): Promise<void>;
  /**
   * One composer `/btw` line in a native tab (issue #682): text asks a side
   * question, bare `/btw` focuses the Side questions pane. Never reaches the
   * model as prose and appends no transcript row.
   */
  runSideQuestionCommand(tabId: string, line: string): Promise<void>;
  /** Asks one side question, or a follow-up on `topicId`, through the bridge. */
  askSideQuestion(tabId: string, question: string, topicId?: string): Promise<void>;
  /** Cancels the running side question. */
  cancelSideQuestion(tabId: string): Promise<void>;
  /** Asks the bridge to re-read `btw-history/` and republish. */
  refreshSideQuestions(tabId: string): Promise<void>;
  /** One subagent verb (issues #684, #713) on omp's native rpc command; the response settles it, never a transcript row. */
  steerSubagent(tabId: string, agentId: string, text: string): Promise<void>;
  killSubagent(tabId: string, agentId: string): Promise<void>;
  setTodos(tabId: string, phases: TodoPhase[]): Promise<void>;
  refreshState(tabId: string): Promise<void>;
  refreshStats(tabId: string): Promise<void>;
  refreshAdvisorStats(tabId: string): Promise<void>;
  refreshLimits(tabId: string): Promise<void>;
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
  /** Bumps the project's diff-pane revision so a mounted DiffsPane re-reads (issue #711). */
  refreshBranchDiff(projectCwd: string, instanceId?: string | null): void;
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
