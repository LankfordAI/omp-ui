import type {
  FleetAuditEntry,
  FleetDispatchRequest,
  FleetDispatchResult,
  FleetGrantRaiseOutcome,
  FleetMachine,
  FleetPendingDispatch,
  FleetRung,
  FleetTargetPick,
  PlacementPreference,
} from "@omp-ui/core/fleet";
import type { MagicKeyword } from "@omp-ui/core/magic-keywords";
import type { SessionCommand } from "@omp-ui/core/session-command";
import type { ProjectSettingsSectionId } from "../components/ProjectSettings";
import type {
  AgentMode,
  ApprovalMode,
  AudioDeviceRole,
  AudioDevicesSnapshot,
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
  ModelCatalogSnapshot,
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
  VaultNoteVoice,
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
import type { AsyncJobsSnapshot } from "@omp-ui/core/async-jobs";
import type { SessionSpendSnapshot } from "@omp-ui/core/session-spend";
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
import type {
  LiveAudioEntry,
  LiveAudioLoad,
  LiveHistoryEntry,
  LiveSnapshot,
  LiveTurn,
} from "@omp-ui/core/live-voice";
import type { LiveReplayState, LiveReplayTarget } from "./slices/live-audio";
import type { RailTab } from "../lib/panel-layout";
import type { AutoresearchSnapshot, ExperimentProposal } from "@omp-ui/core/autoresearch";
import type { ApprovalChoice, ApprovalPrompt } from "@omp-ui/core/approval";
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
  sourceKey: string;
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
  /** Exact gate and read sequence that supplied the displayed artifact. */
  planSourceKey: string | null;
  /** Reactive review voice availability; runtime ownership is process-local. */
  planVoice: { ready: boolean; busy: boolean; error: string | null };
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
   * The session's omp background jobs as the async-jobs bridge published them
   * (issue #835). Display state only — omp's async job manager owns the jobs;
   * a malformed publish leaves the last good snapshot standing.
   */
  asyncJobs: AsyncJobsSnapshot | null;
  /** The kill this client has in flight (one per tab); settled by the snapshot whose result carries its requestId. */
  asyncJobsKill: { requestId: string; jobId: string | null } | null;
  /** The last kill's failure — the bridge's sentence or the rpc error; cleared by the next kill. */
  asyncJobsKillError: string | null;
  /**
   * Whole-session spend as the session-spend bridge published it (issue #866):
   * the root journal plus every subagent transcript, surviving compaction.
   * Null until first observed; the HUD and rail fall back to `stats` then.
   */
  sessionSpend: SessionSpendSnapshot | null;
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
  /** The terminal assistant text carried a server repetition-halt notice (issue #839). */
  repetitionStop?: boolean;
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
    }
  | {
      /** Carry every stored credential to or from another host, or write/read
       *  a bundle file (issue #888). Mandatory gate before any credential
       *  touches disk: the body spells out that the bundle is plaintext.
       *  `targetLabel` names the peer for display (nickname or chosen path);
       *  `instanceId` carries it only for the two instance-to-instance arms. */
      kind: "carry-auth";
      action: "to-instance" | "from-instance" | "save-file" | "import-file";
      targetLabel: string;
      instanceId?: string;
    }
  | {
      /** Fleet remote version update — the omp-binary arm. The mandatory gate
       *  names the member and the version hop (`targetVersion` null = latest);
       *  live sessions on the member keep the binary they started with. The
       *  body spells out the join transport exactly like rollout-keys does. */
      kind: "fleet-update-omp";
      machineKey: string;
      machineNickname: string | null;
      currentVersion: string | null;
      targetVersion: string | null;
    }
  | {
      /** Fleet remote version update — stage the app package. Nothing installs
       *  until the apply arm runs at the member's next quit. */
      kind: "fleet-stage-app";
      machineKey: string;
      machineNickname: string | null;
      version: string | null;
    }
  | {
      /** Fleet remote version update — apply the staged package at the member's
       *  next quit (never a restart from a fleet request). `liveSessions` is the
       *  count the body names; accepting with any live sessions IS the user's
       *  "Install when I quit" choice, so the request carries them through. */
      kind: "fleet-apply-app";
      machineKey: string;
      machineNickname: string | null;
      liveSessions: number;
    }
  | {
      /** Provider key rollout to one fleet member (issue #905). Mandatory gate: the body
       *  names the count, the member, and whether the join transport is encrypted. Values
       *  never reach the renderer; main reads them at confirm time. */
      kind: "rollout-keys";
      instanceId: string;
      targetLabel: string;
      envNames: string[];
      encrypted: boolean;
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
  /** Opt out of the "Stop the agent?" confirmation (issue #925). */
  setSkipTerminateConfirmation(skip: boolean): Promise<void>;
  setExperimentsEnabled(on: boolean): Promise<void>;
  /** Shows/hides the composer mic button app-wide (issue #647). */
  setVoiceInputEnabled(on: boolean): Promise<void>;
  /** Parks the live voice call while a delegated backend turn works (issue #815). */
  setLiveWorkParking(on: boolean): Promise<void>;
  /** Minutes between live-voice progress reports while work parking; null
   *  disables (issue #826). */
  setLiveProgressReportMinutes(minutes: number | null): Promise<void>;
  /** The app-wide dictation model; null auto-resolves at call time. */
  setSttModel(model: string | null): Promise<void>;
  /** One role's app-wide audio device (issue #857); null = OS default. */
  setAudioDevice(role: AudioDeviceRole, id: string | null): Promise<void>;
  setThemeId(id: string): Promise<void>;
  setFontFamilyId(id: string): Promise<void>;
  setTranscriptWidth(width: TranscriptWidth): Promise<void>;
  setGlassChrome(level: GlassChrome): Promise<void>;
  setLocaleId(id: string): Promise<void>;
  setAppUpdateCheckOnLaunch(on: boolean): Promise<void>;
  setAppUpdateTrain(train: UpdateTrain): Promise<void>;
  /** Voice vault note bodies take (#793); reaches sessions started afterwards. */
  setVaultNoteVoice(voice: VaultNoteVoice): Promise<void>;
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
  setOmpAutoUpgrade(on: boolean): Promise<void>;
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
  /** The machine's audio devices for the audio-device picker (issue #855). */
  readAudioDevices(): Promise<AudioDevicesSnapshot>;
  readProviderKeys(projectCwd: string | null): Promise<ProviderKeysSnapshot>;
  /** The installed omp's judge-kind catalog for the judge role row (issue #669). */
  readJudgeModels(): Promise<JudgeModelSnapshot>;
  /** The installed omp's chat-kind catalog for the model-role browse picker (#797). */
  readChatModels(): Promise<ModelCatalogSnapshot>;
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
 * The Fleet main-pane surface (CONTEXT.md "Fleet", issue #899): the last
 * machine read. `null` on the store means the surface is closed; any tab
 * activation through `focusOn` closes it, like the Stats view.
 */
export interface FleetView {
  /** null until the first `fleet:machines` read lands. */
  machines: FleetMachine[] | null;
  loading: boolean;
  /** The last read's failure; shown in the view, never as an error notice (it polls). */
  error: string | null;
  /** This machine's own fleet audit ring (#901); null until the first read. */
  audit: FleetAuditEntry[] | null;
}

/** What a Retry re-sends for one unknown-outcome dispatch: the request and its one target. */
export interface FleetRetryEntry {
  req: FleetDispatchRequest;
  pick: FleetTargetPick;
}

export interface FleetSlice {
  fleet: FleetView | null;
  /**
   * In-memory only, by dispatchId: the request behind each unknown outcome
   * this renderer dispatched. A reload forgets the prompt, so a pending row
   * without an entry offers Dismiss only.
   */
  fleetLastRequests: Record<string, FleetRetryEntry>;
  openFleet(): void;
  closeFleet(): void;
  refreshFleet(): Promise<void>;
  /** Null when the dispatcher rejected the whole request (reported as an error notice). */
  dispatchFleet(req: FleetDispatchRequest): Promise<FleetDispatchResult | null>;
  setFleetPlacement(machineKey: string, pref: PlacementPreference): Promise<void>;
  setFleetAgentDispatch(on: boolean): Promise<void>;
  /** The exec master switch (issue #901). */
  setFleetExecEnabled(on: boolean): Promise<void>;
  /** What any dispatcher may at most hold on this machine (issue #901). */
  setFleetExecCeiling(rung: FleetRung): Promise<void>;
  /** The declared clone/register roots (issue #901), whole-list set. */
  setFleetProjectRoots(roots: string[]): Promise<void>;
  /** Node-local grant edit; null resets the rung to the join default (issue #901). */
  setFleetGrant(dispatcherId: string, rung: FleetRung | null): Promise<void>;
  /** The member's re-presentation ceremony; the outcome renders in the panel (issue #901). */
  requestFleetGrant(machineKey: string, rung: FleetRung, secret: string): Promise<FleetGrantRaiseOutcome>;
  /** Re-sends one unknown outcome to its one machine, reusing both ids (the owner dedupes). */
  retryFleetDispatch(pending: FleetPendingDispatch): Promise<void>;
  dismissFleetDispatch(dispatchId: string): Promise<void>;
}

/**
 * The Seance consult dialog's opener context (issue #885): where the consult
 * launches from and what the composer line prefilled. `sourceTabId` marks an
 * in-place consult — the invoking live tab hosts the consultant; without it,
 * submitting spawns a fresh consult session in `projectCwd`.
 */
export interface SeanceDialogInit {
  projectCwd: string;
  instanceId: string | null;
  sourceTabId?: string;
  prefill?: { source?: string; model?: string };
}

/** One Seance consult launch: which session hosts it and what it consults. */
export interface SeanceConsultTarget {
  projectCwd: string;
  instanceId: string | null;
  /** Given = the consult runs in this existing live tab instead of spawning. */
  tabId?: string;
  /** Absolute transcript path (or verbatim selector) of the consulted session. */
  sourceSession: string;
  /** Human label for the kickoff's subject line. */
  sourceLabel: string;
  /** Read privacy of the consulted source (issue #852): a spawned consult session inherits it. */
  private?: boolean;
  /** The consulted source is a Chat: a spawned consult lands in a fresh chat. */
  chat?: boolean;
}

export interface SeanceSlice {
  seanceDialog: SeanceDialogInit | null;
  openSeanceDialog(init: SeanceDialogInit): void;
  closeSeanceDialog(): void;
  /**
   * Launches one consult: in `target.tabId` when given (readiness-gated),
   * else spawns a fresh rpc-ui session in the source's project and prompts
   * it after settle. The kickoff composes the single `task` call with
   * `agent: "seance"` — omp's only seance entry point over rpc.
   */
  launchSeanceConsult(target: SeanceConsultTarget, question: string, model?: string | null): Promise<void>;
  /** One composer `/seance` line in a native tab (issue #885): opens the dialog pre-filled and focuses the Seance pane. */
  runSeanceLine(tabId: string, line: string): Promise<void>;
  /** The sidebar row's ghost action: resolves the source transcript path, then opens the dialog defaulted to that row. */
  consultFromRow(sourceTabId: string): Promise<void>;
}

/**
 * One tab's live-share posture (issue #686): `off` = no host this tab (omp
 * exposes none or `/collab stop` ran), `sharing` carries the registry row's
 * state. Native tabs cannot host at all — omp's command lives in the TUI —
 * a fact the dialog reads from tab mode, not from this map.
 */
export type CollabTabView = { kind: "off" } | { kind: "sharing"; state: CollabTabState };

/**
 * Sidebar badge for live voice park/resume (#811): the reactive mirror of
 * the runtime's `liveArmed` / `liveParked` / `livePendingFeedback` flags —
 * `patchRuntime` fires no store update, so the sidebar row reads this map.
 * A tab with no entry has nothing to show.
 */
export interface LiveVoiceBadge {
  armed: boolean;
  parked: boolean;
  pending: boolean;
}

export interface UiStore extends SettingsSlice, UpdatesSlice, LabSlice, StatsSlice, FleetSlice, SeanceSlice {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  restoringTabs: boolean;
  exited: Record<string, number>;
  shellExited: Record<string, number>;
  /** Sidebar badge for live voice park/resume (#811); mirrors the runtime. */
  liveVoice: Record<string, LiveVoiceBadge>;
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
  /** App-global successes awaiting acknowledgment, oldest first (issue #888):
   *  flows with no live transcript to receive a per-tab notice (a migrated-in
   *  row) report here; renders as a calm dialog beside the error queue. */
  infoNotices: ErrorNotice[];
  reportNotice(message: string): void;
  dismissNotice(id: string): void;
  /** #888: per-tab in-flight migration, renderer-local progress only. */
  migrating: Record<string, "packing" | "transferring" | "finishing">;
  /** Percent forwarded (0-100) per in-flight migration tabId (issue #888);
   *  cleared with `migrating`. */
  migrationProgress: Record<string, number>;
  /** Streams the tab's transcript bundle to `targetInstanceId` (null = this
   *  machine) at `targetCwd`, then marks the source moved. Chunk-forwarding
   *  lives here so neither side ever holds the full bundle. */
  migrateSession(tabId: string, targetInstanceId: string | null, targetCwd: string): Promise<void>;
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
  /** True while the first-run Getting started checklist overlay is open (issue #623). */
  gettingStartedOpen: boolean;
  /** True while the diagnostic-bundle export dialog is open (issue #413). */
  diagnosticsDialogOpen: boolean;
  browserPaneClearDialogOpen: boolean;
  /** The tab whose first-share privacy dialog is open (issue #679); null = closed. */
  shareConfirmTab: string | null;
  /** The New session dialog (one launcher for local and fleet work); null = closed. */
  newSessionDialog: {
    /** Seed project; null opens with the first registry project. */
    projectCwd: string | null;
    /** Owner of that project; null = this app's registry / LOCAL_MACHINE_KEY. */
    instanceId: string | null;
    /** Which Where face is active at open. */
    where: "here" | "fleet";
    /** Workspace capsule value at open. */
    workspace: "checkout" | "worktree";
  } | null;
  /** The project quick-open overlay (T3-style new-thread picker); in-memory, not persisted. */
  projectQuickOpen: {
    /** Seed query pre-typed at open; usually empty. */
    query: string;
  } | null;
  /** The row whose Migrate session dialog is open (issue #888); null = closed. */
  migrateDialog: { tabId: string } | null;
  openMigrateDialog(tabId: string): void;
  closeMigrateDialog(): void;
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
  init(): Promise<void>;
  /** Re-paired browser socket (issue #890): reconcile state and re-boot live rpc tabs without a reload. */
  resyncAfterReconnect(): Promise<void>;
  openProjectPicker(instanceId?: string | null): void;
  closeProjectPicker(): void;
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
  restartSession(tabId: string): Promise<boolean>;
  addProject(path: string, instanceId?: string | null): Promise<void>;
  removeProject(path: string, instanceId?: string | null): Promise<void>;
  /** Stages the confirmation that forgets a joined remote instance (issue #416). */
  confirmRemoveRemoteInstance(instanceId: string, nickname: string): void;
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
    /** `{ private: true }` spawns a private session (issue #852): pinned
     *  write-quiet against the memory system. Never a default.
     *  `{ planMode: true }` starts the fresh session in plan mode (rpc-ui
     *  only; ignored for pty). */
    opts?: { private?: boolean; planMode?: boolean },
  ): Promise<string | null>;
  /** Spawns a fresh Chat (local only) and lands its tab; resolves its tabId, or null when it never landed. */
  newChat(opts?: { private?: boolean; askSource?: { tabId: string; title: string } }): Promise<string | null>;
  /** "Ask about this session" (#895): a fresh Chat with the source's summary pinned. Local sources only. */
  askAboutSession(sourceTabId: string): Promise<void>;
  /**
   * Creates a worktree session; throws on failure (the dialog renders the
   * message inline) — unlike newSession, which reports to the error notices.
   * The spec mints a new branch or checks out an existing local one
   * (issue #390); it lands verbatim in the spawn request's worktree field.
   * Returns null when the spawn never answers within SPAWN_SETTLE_MS (the
   * timeout is already reported; issue #907) — a spawn that lands later
   * still mounts its tab.
   */
  newWorktreeSession(
    projectCwd: string,
    spec:
      | { mint: { branch: string; baseRef: string | null; baseBranch: string | null } }
      | { checkout: { branch: string } },
    instanceId?: string | null,
  ): Promise<string | null>;
  /**
   * One launcher action (the New session dialog): spawns a session — in a
   * worktree checkout when asked, otherwise plainly, optionally in plan
   * mode — then applies an optional title and sends an optional first
   * prompt once the runtime reports ready. Returns the landed tab id, or
   * null when the spawn never landed.
   */
  launchSession(
    projectCwd: string,
    opts: {
      instanceId?: string | null;
      prompt?: string;
      title?: string | null;
      planMode?: boolean;
      worktree?:
        | { mint: { branch: string; baseRef: string | null; baseBranch: string | null } }
        | { checkout: { branch: string } }
        | null;
    },
  ): Promise<string | null>;
  /**
   * Converts an unprompted session to a worktree session (issue #225);
   * throws on failure (the composer renders the message inline) — unlike
   * restartSession, which reports to the error notices.
   */
  convertSessionToWorktree(
    tabId: string,
    opts: { branch: string; baseRef: string | null; baseBranch: string | null },
  ): Promise<void>;
  openNewSessionDialog(seed?: {
    projectCwd?: string | null;
    instanceId?: string | null;
    where?: "here" | "fleet";
    workspace?: "checkout" | "worktree";
  }): void;
  closeNewSessionDialog(): void;
  openProjectQuickOpen(seed?: { query?: string }): void;
  closeProjectQuickOpen(): void;
  openFinishWorktree(tabId: string): void;
  closeFinishWorktree(): void;
  openSession(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  hideTab(tabId: string): void;
  terminate(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  /** Relaunch a dead tab. `restore` relaunches the PTY with omp --restore so
   *  the interrupted turn continues (#872); ignored for rpc-ui tabs. */
  resumeDead(tabId: string, opts?: { restore?: boolean }): Promise<void>;
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
  /**
   * Boot-stall watchdog (#892): stamps a boot failure on a tab still stuck in
   * "starting" after the renderer's deadline; no-op once a frame owns it.
   */
  flagBootStall(tabId: string): void;
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
  /** The prompt-commit auto-title trigger (issue #795): no-op unless the
   * first-prompt arm is still live when the turn admits the user
   * message's `message_start`. */
  dispatchEarlyTitle(tabId: string): void;
  /** The live voice Auto-title arm (issue #803): `setInitialPrompt`'s gates,
   *  then the shot waits for the first assistant `message_end` whose text
   *  or thinking omp's title digest can read. */
  armDelegatedTitle(tabId: string, prompt: string): void;
  renameSession(tabId: string): void;
  /** The replan refresh (issue #804): re-dispatch the bare `/rename` after a
   *  `todo init` when the title is still an omp-ui-generated auto-title;
   *  no-op when any gate (marker, titled, ladder, floor) refuses. */
  refreshAutoTitle(tabId: string): void;
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
  /** Starts omp's live voice session (issue #778); truth arrives as the
   *  `live_*` frames, the ack only settles start/stop/mute dispatch.
   *  `instructions` override the built recap+pending text (manual probes,
   *  issue #811); omitted means build from the runtime. */
  startLiveVoice(tabId: string, opts?: { instructions?: string }): Promise<void>;
  /** Parks live voice (#811): closes the realtime call of an armed session
   *  the user stopped viewing, folding the spoken turns into the recap. The
   *  intent survives; returning resumes through `startLiveVoice`. */
  parkLiveVoice(tabId: string): Promise<void>;
  /** Stops omp's live voice session (issue #778); `live_end` is the truth.
   *  Clears the #811 armed intent and the recap/pending buffers. */
  stopLiveVoice(tabId: string): Promise<void>;
  /** Toggles the live session's mute (issue #778); `live_phase` "muted"
   *  reports omp's truth, so no local toggle state is kept. */
  setLiveMuted(tabId: string, muted: boolean): Promise<void>;
  /** Drops the live error strip; keeps a running session's snapshot. */
  clearLiveError(tabId: string): void;
  /** The connecting watchdog's verdict (#827): locally end a live snapshot
   *  stuck on `connecting` so the pill becomes a restartable error. */
  abandonStalledLiveConnect(tabId: string): void;
  /** The work-park arm (#815): gates and timers for parking the open call
   *  while a live-owned turn works. Reached from the delegation frame, the
   *  plan-handoff seed turn's start ack, and an in-place execute on an open
   *  call (issue #842); every gate re-verifies, so callers only signal
   *  intent. */
  armLiveWorkPark(tabId: string): void;
  /** The recordings stored under this session's lineage dir (#809), newest
   *  first — disk enumeration, so a session that is not being viewed lists
   *  the same entries. [] while omp exposes no audio at all (ADR-0049). */
  listLiveRecordings(tabId: string): Promise<LiveAudioEntry[]>;
  /** Loads one live turn's recording by reference built from the session
   *  AND the connection these turns belong to (#809); `connectionId`
   *  overrides the snapshot's for a history row from an earlier connection
   *  (#817). Never invents an id — a session that never materialized or
   *  never started live voice answers `unavailable` without dispatch. */
  loadLiveRecording(tabId: string, turn: LiveTurn, connectionId?: string | null): Promise<LiveAudioLoad>;
  /** Persist one FINAL spoken turn under the session's lineage dir (#817).
   *  Fire-and-forget from the frame reducer; non-finals, un-minted
   *  connection ids, and dispatch failures all no-op — the strip renders
   *  from the snapshot; disk is the durable copy. */
  appendLiveHistory(tabId: string, connectionId: string, turn: LiveTurn): Promise<void>;
  /** The session's persisted spoken turns (#817), oldest connection first —
   *  disk enumeration, so a session that is not being viewed reads the same
   *  history. [] for a session that never spoke. */
  listLiveHistory(tabId: string): Promise<LiveHistoryEntry[]>;
  /** The one clip the replay player holds (#810); null while nothing is
   *  loaded, playing, or paused. The player dispatches only the read
   *  channel — replay never sends a live command. */
  liveReplay: LiveReplayState | null;
  /** Plays one recording (#810): resolves the ref from the entry's own
   *  connection (reopen-safe) or the live snapshot's, loads the bytes, and
   *  claims the module-level singleton. Refuses without a state change
   *  while this tab's live output is speaking; a load that does not answer
   *  `ready` clears the slot — never a fallback. */
  playLiveRecording(tabId: string, target: LiveReplayTarget): Promise<void>;
  /** Pauses the clip in place; its state (and any notice) stays. */
  pauseLiveReplay(): void;
  /** Resumes the paused clip and clears the guard's notice. */
  resumeLiveReplay(): void;
  /** Stops and releases the clip; the affordances render idle. */
  stopLiveReplay(): void;
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
  /** Answers the held approval (skipping the send when the process exited) and clears it.
   *  False when none is held, or when "session" is asked of a two-option prompt. */
  answerApprovalPrompt(tabId: string, choice: ApprovalChoice): boolean;
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
  /** Share anonymized (issue #834): shells out to the installed omp's
   *  redaction command; gated on the omp version floor, hidden below it. */
  anonymizeSession(tabId: string): Promise<void>;
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
  acceptPlanReview(
    tabId: string,
    review: NonNullable<RpcTabState["planReview"]>,
    itemId?: string,
  ): void;
  clearPlanReview(tabId: string, expectedGateKey?: string): void;
  switchLiveVoice(
    tabId: string,
    request: {
      mode: "park" | "wake";
      reviewKey?: string | null;
      briefOverview?: boolean;
      progress?: boolean;
    },
  ): Promise<void>;
  reconcileLivePlanReview(tabId: string): void;
  explainPlanVoice(tabId: string): Promise<void>;
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
    readiness: PlanReadiness | null,
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
  /** Arms the session-spend bridge and asks it to republish (issue #866); quiet. */
  refreshSessionSpend(tabId: string): Promise<void>;
  /** Arms the async-jobs bridge and asks it to republish (issue #835); quiet. */
  refreshAsyncJobs(tabId: string): Promise<void>;
  /** Cancels one running background job, or every one when `job` is null (issue #835). */
  killAsyncJob(tabId: string, job: { id: string; startTime: number } | null): Promise<void>;
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
