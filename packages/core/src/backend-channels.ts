import type {
  AdvisorDefaults,
  AgentMode,
  AppUpdateRestartResult,
  AppUpdateState,
  BackendState,
  BranchDiff,
  BranchList,
  BranchListOptions,
  ConsoleProgram,
  DeleteSessionPreview,
  DeleteSessionResult,
  DiagnosticsExportRequest,
  DiagnosticsExportResult,
  DiagnosticsPreview,
  DirBrowseResult,
  GlassChrome,
  ImageAttachment,
  McpServersResult,
  InstanceIdentity,
  McpSetEnabledRequest,
  MemoryOverview,
  MergeBackResult,
  MergeBackStatus,
  MergeDestination,
  OmpSettingValue,
  OmpSettingsSnapshot,
  OmpUpdateState,
  PlanFormat,
  ProjectRecord,
  ProjectOpenAvailability,
  ProjectOpenTarget,
  ProviderKeysSnapshot,
  PushResult,
  ProviderOAuthState,
  ProviderOAuthStatus,
  RemoteBind,
  RemoteInstanceInput,
  RemoteInstancePatch,
  RemoteState,
  ResolvedMentionContext,
  ScopedCapabilitiesResult,
  ScopedCapabilityMutation,
  SessionMode,
  SpawnRequest,
  TranscriptWidth,
  UpdateTrain,
  WebSearchProviderSnapshot,
  WorktreeReleaseOptions,
  WorktreeReleaseResult,
  WorktreeSyncResult,
} from "./types";
import type { SessionCapabilitiesResult, SetSessionToolEnabledResult } from "./capabilities";
import type { RpcFrame } from "./rpc/codec";
import { PLAN_EXECUTE, PLAN_REFINE, type PlanAnswerResult, type PlanReviewVerdict } from "./plan";
import {
  agentModeCodec,
  any,
  arrayOf,
  diagnosticsExportRequestCodec,
  bool,
  branchListOptionsCodec,
  checkoutOptionsCodec,
  consoleProgramCodec,
  glassChromeCodec,
  imageAttachmentCodec,
  mcpSetEnabledRequestCodec,
  nullable,
  num,
  ompSettingValueCodec,
  oneOf,
  planFormatCodec,
  projectOpenTargetCodec,
  remoteBindCodec,
  remoteInstanceInputCodec,
  remoteInstancePatchCodec,
  rpcFrameCodec,
  scopedCapabilityMutationCodec,
  sessionModeCodec,
  spawnRequestCodec,
  str,
  trailingOptional,
  transcriptWidthCodec,
  updateTrainCodec,
  worktreeReleaseOptionsCodec,
  type ArgCodec,
  type ArgCodecs,
} from "./backend-arg-codecs";

declare const CHANNEL_ARGS: unique symbol;

/** Runtime descriptor for a request/reply channel. */
export interface RequestChannel<Args extends unknown[], Result> {
  readonly kind: "request";
  readonly args: ArgCodecs<NoInfer<Args>>;
  readonly $result?: Result;
  readonly [CHANNEL_ARGS]?: Args;
}

/** Runtime descriptor for a fire-and-forget client notification. */
export interface NotifyChannel<Args extends unknown[]> {
  readonly kind: "notify";
  readonly args: ArgCodecs<NoInfer<Args>>;
  readonly [CHANNEL_ARGS]?: Args;
}

/** Type-only marker for an event emitted by the backend. */
export interface EventChannel<Args extends unknown[]> {
  readonly kind: "event";
  readonly $args?: Args;
}

const EVENT = { kind: "event" } as const;

/** Declares a request/reply channel's argument tuple, codecs, and result. */
function request<Args extends unknown[], Result>(
  args: ArgCodecs<Args>,
): RequestChannel<Args, Result> {
  return { kind: "request", args };
}

/** Declares a fire-and-forget notification channel's argument tuple and codecs. */
function notify<Args extends unknown[]>(args: ArgCodecs<Args>): NotifyChannel<Args> {
  return { kind: "notify", args };
}

/** Declares a backend event channel's callback argument tuple. */
function event<Args extends unknown[]>(): EventChannel<Args> {
  return EVENT;
}

/**
 * The renderer↔backend seam (ADR-0002). A capability is declared once here;
 * the public client, channel names, and main-process handler table derive from it.
 */
export const BACKEND_CHANNELS = {
  getState: { channel: "state:get", ...request<[], BackendState>([]) },
  /**
   * Registers a directory as a project. `path` may be ~-prefixed or absolute;
   * the backend expands, resolves, and validates it is an existing directory,
   * rejecting with a user-facing message otherwise. An already-registered path
   * resolves to its existing record.
   */
  addProject: { channel: "project:add", ...request<[path: string], ProjectRecord>([str()]) },
  /**
   * Reports which external project-open targets are available. The host
   * resolves this once and caches the result for the application lifetime.
   */
  getProjectOpenAvailability: {
    channel: "project:openAvailability",
    ...request<[], ProjectOpenAvailability>([]),
  },
  /**
   * Opens a project in the selected external target. Rejects with an
   * actionable, user-facing message when the target cannot be opened.
   */
  openProject: {
    channel: "project:open",
    ...request<[projectPath: string, target: ProjectOpenTarget], void>([str(), projectOpenTargetCodec]),
  },
  /** Directory listing for the in-app project picker (read-only, never mutates). */
  browseDirectories: {
    channel: "dir:browse",
    ...request<[partialPath: string], DirBrowseResult>([str()]),
  },
  removeProject: { channel: "project:remove", ...request<[path: string], void>([str()]) },
  /**
   * Moves a registered project to sit immediately before `beforePath` in the
   * sidebar order; a null `beforePath` (or one that is not registered) appends
   * it to the end. The order is the persisted registry order, so the change
   * survives a restart. An unknown `projectPath`, and a `beforePath` equal to
   * it, are no-ops.
   */
  moveProject: {
    channel: "project:move",
    ...request<[projectPath: string, beforePath: string | null], void>([str(), nullable(str())]),
  },
  /**
   * Pins the project's default main model (issue #257) — the `provider/id`
   * selector new sessions boot with, ahead of last-used memory. null clears
   * the pin.
   */
  setProjectDefaultModel: {
    channel: "project:setDefaultModel",
    ...request<[projectPath: string, model: string | null], void>([str(), nullable(str())]),
  },
  /**
   * Pins the project's default advisor model (issue #257) — the
   * `model[:level]` selector a new session's advisor uses when the advisor
   * on/off chain enables it. null clears the pin.
   */
  setProjectDefaultAdvisorModel: {
    channel: "project:setDefaultAdvisorModel",
    ...request<[projectPath: string, model: string | null], void>([str(), nullable(str())]),
  },
  /**
   * Moves an owned session to sit immediately before `beforeTabId` in its
   * project's sidebar order (#274); a null or unknown `beforeTabId` appends
   * it. The order is the persisted registry array order, so the change
   * survives a restart. An unknown `tabId`, and a `beforeTabId` equal to
   * `tabId`, are no-ops. Never touches process state, live or otherwise.
   */
  moveSession: {
    channel: "session:move",
    ...request<[tabId: string, beforeTabId: string | null], void>([str(), nullable(str())]),
  },
  setDefaultMode: {
    channel: "settings:setDefaultMode",
    ...request<[mode: SessionMode], void>([sessionModeCodec]),
  },
  setDefaultAgentMode: {
    channel: "settings:setDefaultAgentMode",
    ...request<[mode: AgentMode], void>([agentModeCodec]),
  },
  listCompactionMethods: {
    channel: "settings:listCompactionMethods",
    ...request<[], string[]>([]),
  },
  setDefaultCompactionMethod: {
    channel: "settings:setDefaultCompactionMethod",
    ...request<[method: string | null], void>([nullable(str())]),
  },
  setPlanFormat: {
    channel: "settings:setPlanFormat",
    ...request<[format: PlanFormat], void>([planFormatCodec]),
  },
  setHibernateIdleMinutes: {
    channel: "settings:setHibernateIdleMinutes",
    ...request<[minutes: number], void>([num()]),
  },
  setStreamStallAbortSeconds: {
    channel: "settings:setStreamStallAbortSeconds",
    ...request<[seconds: number], void>([num()]),
  },
  setAdvisorAutoReply: {
    channel: "settings:setAdvisorAutoReply",
    ...request<[on: boolean], void>([bool()]),
  },
  setStallAutoContinue: {
    channel: "settings:setStallAutoContinue",
    ...request<[on: boolean], void>([bool()]),
  },
  /** OS notifications for background-session attention states (issue #271); default on. */
  setDesktopNotifications: {
    channel: "settings:setDesktopNotifications",
    ...request<[on: boolean], void>([bool()]),
  },
  setDefaultAdvisor: {
    channel: "settings:setDefaultAdvisor",
    ...request<[on: boolean], void>([bool()]),
  },
  setSkipDeleteConfirmation: {
    channel: "settings:setSkipDeleteConfirmation",
    ...request<[skip: boolean], void>([bool()]),
  },
  setThemeId: { channel: "settings:setThemeId", ...request<[id: string], void>([str()]) },
  setFontFamilyId: { channel: "settings:setFontFamilyId", ...request<[id: string], void>([str()]) },
  setTranscriptWidth: {
    channel: "settings:setTranscriptWidth",
    ...request<[width: TranscriptWidth], void>([transcriptWidthCodec]),
  },
  setGlassChrome: {
    channel: "settings:setGlassChrome",
    ...request<[level: GlassChrome], void>([glassChromeCodec]),
  },
  setLocaleId: { channel: "settings:setLocaleId", ...request<[id: string], void>([str()]) },
  setAppUpdateCheckOnLaunch: {
    channel: "settings:setAppUpdateCheckOnLaunch",
    ...request<[on: boolean], void>([bool()]),
  },
  setAppUpdateTrain: {
    channel: "settings:setAppUpdateTrain",
    ...request<[train: UpdateTrain], void>([updateTrainCodec]),
  },
  setOmpUpdateCheckOnLaunch: {
    channel: "settings:setOmpUpdateCheckOnLaunch",
    ...request<[on: boolean], void>([bool()]),
  },
  /** Clears the remembered omp-ui update dismissal so the offer can return. */
  clearDismissedAppUpdate: {
    channel: "settings:clearDismissedAppUpdate",
    ...request<[], void>([]),
  },
  /** Clears the remembered omp update dismissal so the offer can return. */
  clearDismissedOmpUpdate: {
    channel: "settings:clearDismissedOmpUpdate",
    ...request<[], void>([]),
  },
  /** Repaints the native title-bar overlay to match the active theme. */
  setWindowChrome: {
    channel: "window:setChrome",
    ...request<[background: string, symbol: string], void>([str(), str()]),
  },
  /**
   * omp's own settings for the allowlist, with the layer each value comes from.
   * `projectCwd` selects the project layer to account for; pass null to read
   * the global layer alone.
   */
  readOmpSettings: {
    channel: "omp-settings:read",
    ...request<[projectCwd: string | null], OmpSettingsSnapshot>([nullable(str())]),
  },
  /**
   * Writes one omp setting to the GLOBAL layer via `omp config set`. `value`
   * is serialized per its schema type. Rejects with omp's own stderr message.
   */
  writeOmpSetting: {
    channel: "omp-settings:write",
    ...request<[key: string, value: OmpSettingValue], void>([str(), ompSettingValueCodec]),
  },
  /**
   * The installed omp's own web-search provider ids, discovered by probing its `omp search`
   * flag validation. Never a curated omp-ui list (ADR-0027). Never rejects for an
   * undiscoverable list — `discovered` and `error` say so.
   */
  readWebSearchProviders: {
    channel: "web-search-providers:read",
    ...request<[], WebSearchProviderSnapshot>([]),
  },
  /**
   * Provider credentials omp-ui supplies to every omp it launches, with the
   * source of each. `projectCwd` scopes the report-only `.env` scan; pass null
   * to skip it. Never returns key material — only masked tails.
   */
  readProviderKeys: {
    channel: "provider-keys:read",
    ...request<[projectCwd: string | null], ProviderKeysSnapshot>([nullable(str())]),
  },
  /**
   * Stores one provider credential, encrypted by the OS credential store, and
   * applies it so the next session sees it. Rejects when the variable is not a
   * known provider variable, the value is not a single non-empty line, or the
   * platform offers no credential store.
   */
  setProviderKey: {
    channel: "provider-keys:set",
    ...request<[envName: string, value: string], ProviderKeysSnapshot>([str(), str()]),
  },
  /** Forgets a stored credential; inherited or login-shell values take over again. */
  clearProviderKey: {
    channel: "provider-keys:clear",
    ...request<[envName: string], ProviderKeysSnapshot>([str()]),
  },
  /**
   * Subscription (OAuth) sign-in rows, re-read from omp's own auth store
   * (`omp token <id> --list`). Carries account identities, never a token.
   */
  readProviderOAuth: {
    channel: "provider-oauth:read",
    ...request<[], ProviderOAuthStatus[]>([]),
  },
  /** The one app-wide sign-in flow's current phase; boot seed for late-joining clients. */
  getProviderOAuthState: {
    channel: "provider-oauth:getState",
    ...request<[], ProviderOAuthState>([]),
  },
  /** Starts the flow in a bare session-less rpc child; rejects when one is already running. */
  startProviderOAuth: {
    channel: "provider-oauth:start",
    ...request<[id: string], void>([str()]),
  },
  /** Answers omp's pasted-redirect-URL prompt. */
  submitProviderOAuthInput: {
    channel: "provider-oauth:input",
    ...request<[value: string], void>([str()]),
  },
  /** Aborts an active flow, or dismisses a terminal done/error state. */
  cancelProviderOAuth: {
    channel: "provider-oauth:cancel",
    ...request<[], void>([]),
  },
  /** Signs out via `omp auth-broker logout`; resolves with the refreshed rows. */
  signOutProviderOAuth: {
    channel: "provider-oauth:signOut",
    ...request<[id: string], ProviderOAuthStatus[]>([str()]),
  },
  spawnSession: {
    channel: "session:spawn",
    ...request<[req: SpawnRequest], { tabId: string }>([spawnRequestCodec]),
  },
  terminateSession: {
    channel: "session:terminate",
    ...request<[tabId: string], void>([str()]),
  },
  /**
   * Hibernates a planning source after its fresh implementation session has
   * accepted the seed prompt (issue #283). Main validates the persisted
   * handoff relation and refuses to reap live or uncertain work.
   */
  hibernatePlanSource: {
    channel: "session:hibernatePlanSource",
    ...request<[sourceTabId: string, implementationTabId: string], boolean>([str(), str()]),
  },
  switchMode: {
    channel: "session:switchMode",
    ...request<[tabId: string, mode: SessionMode], void>([str(), sessionModeCodec]),
  },
  /**
   * Delete preview (issue #309): every owned session descended from
   * `tabId` through `planImplementationSource`, with its cached title and
   * whether its omp process is running. Read-only; an unknown `tabId`
   * resolves to no descendants, mirroring `session:delete`'s leniency.
   */
  deleteSessionPreview: {
    channel: "session:deletePreview",
    ...request<[tabId: string], DeleteSessionPreview>([str()]),
  },
  /**
   * Deletes a session: the registry record plus its lineage files in the
   * active and archive roots (transcript + artifacts). Irreversible. With
   * `cascade`, also deletes every plan-handoff descendant of the session,
   * each through the same per-session path (issue #309).
   */
  deleteSession: {
    channel: "session:delete",
    ...request<[tabId: string, cascade: boolean], DeleteSessionResult>([str(), bool()]),
  },
  /**
   * Full-fidelity branch (issue #83): copies the session's transcript into a
   * new lineage dir under a fresh session id and registers it, ready to open
   * in a new tab. The source session — file, record, live process — is left
   * untouched. Rejects when the source is archived or has no transcript yet.
   */
  forkSession: {
    channel: "session:fork",
    ...request<[tabId: string], { tabId: string }>([str()]),
  },
  /**
   * Re-pins a session's advisor state. omp binds both the enable flag and the
   * `advisor` role at process start, so a live session is respawned with
   * `--resume`; a dormant one just records the choice for its next launch.
   */
  setSessionAdvisor: {
    channel: "session:setAdvisor",
    ...request<[tabId: string, advisor: boolean, advisorModel: string | null], void>([str(), bool(), nullable(str())]),
  },
  /** omp's advisor defaults for a project (global config plus project overlay). */
  getAdvisorDefaults: {
    channel: "advisor:defaults",
    ...request<[projectCwd: string], AdvisorDefaults>([str()]),
  },
  /**
   * Records the main model and thinking level for both this session and the
   * next session in its project. Null values defer to omp's config.
   */
  setSessionModel: {
    channel: "session:setModel",
    ...request<
      [tabId: string, model: string | null, thinkingLevel: string | null],
      void
    >([str(), nullable(str()), nullable(str())]),
  },
  /**
   * Titles a first user prompt with omp's own small model (the `tiny`/`commit`/
   * `smol` role chain). A `titleHint` replaces the prompt as the payload when
   * set: the record already names what a plan-seeded implementation session
   * should be titled from, and the seed plus plan body must not become the
   * title. Resolves to null whenever the model declines or the run fails —
   * the caller keeps its derived title in that case.
   */
  generateTitle: {
    channel: "title:generate",
    ...request<[projectCwd: string, prompt: string, titleHint?: string | null], string | null>(
      [str(), str(), trailingOptional(nullable(str()))],
    ),
  },
  /** Re-titles a live session from a transcript digest; null = declined or failed. */
  retitleSession: {
    channel: "title:retitle",
    ...request<[projectCwd: string, previousTitle: string, transcript: string], string | null>(
      [str(), str(), str()],
    ),
  },
  /**
   * Suggests a git branch name for a plan with omp's own small model (the
   * `tiny`/`commit`/`smol` role chain, same as titling). Resolves to null on
   * every failure path — the caller pre-fills its derived name.
   */
  suggestBranchName: {
    channel: "branch:nameSuggest",
    ...request<[projectCwd: string, planContext: string], string | null>([str(), str()]),
  },
  /**
   * Reads a plan artifact for the review pane, by absolute path. Confined to
   * the session's lineage dir by the implementation; null when the file is
   * absent or out of bounds.
   */
  readPlanFile: {
    channel: "plan:read",
    ...request<[tabId: string, absPath: string], string | null>([str(), str()]),
  },
  /**
   * The acknowledged answer for a plan-review gate (issue #312 follow-up).
   * Only this request may settle a tracked HTML gate: main verifies the live
   * session, the gate identity, and — for `execute` — that the artifact still
   * hashes to the preflight `sourceHash` before answering the agent's blocked
   * select. Two clients can therefore never both execute, and a changed file
   * cannot start an implementation. `sourceHash` is null for markdown gates,
   * which keep their un-gated semantics.
   */
  answerPlanReview: {
    channel: "plan:answer",
    ...request<
      [tabId: string, frameId: string, verdict: PlanReviewVerdict, sourceHash: string | null],
      PlanAnswerResult
    >([str(), str(), oneOf(PLAN_EXECUTE, PLAN_REFINE), nullable(str())]),
  },
  /**
   * Opens an absolute path with the system default handler (a browser for the
   * exported transcript HTML). Rejects when the handler reports a failure.
   */
  openPath: { channel: "file:open", ...request<[absPath: string], void>([str()]) },
  /** Reveals an absolute path in the platform file manager. */
  showPathInFolder: {
    channel: "file:showInFolder",
    ...request<[absPath: string], void>([str()]),
  },
  /**
   * Working-tree changes on the active branch of a project's git repo: tracked
   * changes vs HEAD plus new untracked files. Null fields when the project is
   * not inside a git repository.
   */
  getBranchDiff: {
    channel: "branch:diff",
    ...request<[projectCwd: string, base?: string | null], BranchDiff>([str(), trailingOptional(nullable(str()))]),
  },
  /**
   * Local branches of a project's git repo, default branch first. Null fields
   * when the project is not inside a git repository.
   */
  listBranches: {
    channel: "branch:list",
    ...request<[projectCwd: string, opts?: BranchListOptions], BranchList>([str(), trailingOptional(branchListOptionsCodec)]),
  },
  /**
   * Switches the project's repo to `name` (`checkout -b` when opts.create).
   * Rejects with git's stderr when git refuses — the branch menu shows that
   * message verbatim.
   */
  checkoutBranch: {
    channel: "branch:checkout",
    ...request<
      [projectCwd: string, name: string, opts?: { create?: boolean }],
      void
    >([str(), str(), trailingOptional(checkoutOptionsCodec)]),
  },
  /** Pulls the checked-out branch from its configured upstream. */
  pullBranch: {
    channel: "branch:pull",
    ...request<[projectCwd: string], void>([str()]),
  },
  /**
   * Pushes `branch` to its upstream, or publishes it to `remote` — or to the
   * repo's default remote when none is given. Resolves a structured
   * PushResult; never rejects on git state (issue #414). No force flag: a
   * `rejected` result means pull first.
   */
  pushBranch: {
    channel: "branch:push",
    ...request<[projectCwd: string, branch: string, remote?: string | null], PushResult>([
      str(),
      str(),
      trailingOptional(nullable(str())),
    ]),
  },
  /** The host's new-PR URL for base...head, or null when the remote is unparseable. */
  pullRequestUrl: {
    channel: "branch:prUrl",
    ...request<[projectCwd: string, base: string, head: string], string | null>([
      str(),
      str(),
      str(),
    ]),
  },
  /**
   * Default merge destination resolved from a recorded base (issue #385):
   * the finish dialog's initial suggestion. A non-repo resolves to
   * destination null, reason "no-repo" — never throws.
   */
  resolveMergeDestination: {
    channel: "branch:mergeDestination",
    ...request<[projectCwd: string, base: string | null], MergeDestination>([
      str(),
      nullable(str()),
    ]),
  },
  /**
   * Merge-back feasibility for one CHOSEN destination (issues #272, #385):
   * where it is checked out, divergence both ways, the worktree's dirtiness
   * (#388), and the merge-tree conflict preview (#387).
   */
  getMergeBackStatus: {
    channel: "branch:mergeStatus",
    ...request<
      [projectCwd: string, branch: string, destination: string, worktreePath: string | null],
      MergeBackStatus
    >([str(), str(), str(), nullable(str())]),
  },
  /** Merges the worktree branch into the chosen destination — in the project checkout when it holds it, else in a scratch worktree (issues #272, #385). */
  mergeWorktreeBranch: {
    channel: "branch:mergeBack",
    ...request<[projectCwd: string, branch: string, destination: string], MergeBackResult>([str(), str(), str()]),
  },
  /**
   * Creates a local branch at a start point without checking it out (issue
   * #385: the finish dialog's "new branch…" destination). Rejects with git's
   * stderr when the name exists or is invalid.
   */
  createBranch: {
    channel: "branch:create",
    ...request<[projectCwd: string, name: string, startPoint: string], void>([str(), str(), str()]),
  },
  /**
   * Resolved mnemopi memory overview for a project; never rejects — failures
   * land in `.error` (issue #206).
   */
  memoryOverview: {
    channel: "memory:overview",
    ...request<[projectCwd: string], MemoryOverview>([str()]),
  },
  /**
   * Lists resolved, redacted MCP servers and per-file errors; null projectCwd
   * lists the global (user-level) scope only.
   */
  getMcpServers: {
    channel: "mcp:list",
    ...request<[projectCwd: string | null], McpServersResult>([nullable(str())]),
  },
  /** Toggles one writable MCP server and returns the refreshed list. */
  setMcpServerEnabled: {
    channel: "mcp:setEnabled",
    ...request<[req: McpSetEnabledRequest], McpServersResult>([mcpSetEnabledRequestCodec]),
  },
  /**
   * Restarts a live session in place (kill + relaunch with `--resume`, same
   * dance as the advisor/mode-switch relaunch) so it picks up changed MCP
   * config. Rejects when the session is not live.
   */
  restartSession: {
    channel: "session:restart",
    ...request<[tabId: string], void>([str()]),
  },
  convertToWorktree: {
    channel: "session:convert-to-worktree",
    ...request<[tabId: string, branch: string, baseRef: string | null, baseBranch: string | null], void>(
      [str(), str(), nullable(str()), nullable(str())],
    ),
  },
  /**
   * Merges the destination INTO the session's worktree checkout so conflicts
   * are resolved there by the session that owns the change (issue #387).
   * Rejects when the tab is unknown, not a worktree session, or the checkout
   * is dirty; predicted conflicts are LEFT IN PLACE and reported.
   */
  syncWorktree: {
    channel: "worktree:sync",
    ...request<[tabId: string, source: string], WorktreeSyncResult>([str(), str()]),
  },
  /**
   * Renames the branch a worktree session runs on, in the checkout and on
   * its record (issues #386, #389). No respawn — a running omp process is
   * unaffected by a ref rename. Rejects with git's stderr on a collision.
   */
  renameWorktreeBranch: {
    channel: "worktree:renameBranch",
    ...request<[tabId: string, newName: string], void>([str(), str()]),
  },
  /**
   * Returns a worktree session to its project checkout (issue #334) — the
   * inverse of `session:convert-to-worktree`. Nulls the record's worktree,
   * reclaims the checkout and branch, and respawns in place with `--resume`:
   * the session, its transcript, its lineage and its tab all survive.
   * Rejects when the tab is unknown, is not a worktree session, or the
   * checkout is dirty (issue #388). `keepBranch` skips branch deletion;
   * `mergedInto` is the destination the caller just merged into — verified
   * by ancestry before any deletion (issues #386, #385). `checkoutOnReturn`
   * is the branch the project checkout is switched onto after the reclaim
   * (issue #431); null leaves it on whatever branch it already holds.
   */
  releaseWorktree: {
    channel: "session:release-worktree",
    ...request<[tabId: string, opts: WorktreeReleaseOptions], WorktreeReleaseResult>([
      str(),
      worktreeReleaseOptionsCodec,
    ]),
  },
  /**
   * Capabilities roster observed by a live session's bridge; never rejects —
   * the tab's state maps to missing-session / not-live / terminal /
   * bridge-unavailable / starting / available+snapshot (issue #374).
   */
  getSessionCapabilities: {
    channel: "session:capabilities",
    ...request<[tabId: string], SessionCapabilitiesResult>([str()]),
  },
  /**
   * The capability CATALOGS (issue #383, ADR-0025): skills and tools as
   * config truth resolved at a scope — null `scopeCwd` is the global scope,
   * a path is that working tree's project scope. Config + disk only: it
   * spawns no session and connects to nothing (the probe-session alternative
   * was rejected — ADR-0025). Never rejects for a config reason: a failed
   * settings read answers with per-section errors carrying omp's message.
   */
  getScopedCapabilities: {
    channel: "capabilities:scoped",
    ...request<[scopeCwd: string | null], ScopedCapabilitiesResult>([nullable(str())]),
  },
  /**
   * Applies one catalog mutation and answers with the scope's refreshed
   * catalogs. Global requests write omp's global layer via `omp config set`;
   * project requests edit `.omp/config.yml` in place (comments preserved) or
   * refuse naming the offending line. Validation rejects before any spawn.
   */
  setScopedCapability: {
    channel: "capabilities:scoped:set",
    ...request<[req: ScopedCapabilityMutation], ScopedCapabilitiesResult>(
      [scopedCapabilityMutationCodec],
    ),
  },
  /**
   * Session-local enable/disable of one registered tool in a pinned live
   * native session (issue #379). `processKey`/`sessionId` carry the identity
   * the renderer observed, and main re-validates them against the live entry;
   * a stale request is rejected, never redirected to a successor. Never
   * rejects — the result reports applied+snapshot, a runtime refusal reason,
   * or an unconfirmed/bridge lifecycle status (issue #374 lineage).
   */
  setSessionToolEnabled: {
    channel: "session:tool-enabled",
    ...request<
      [tabId: string, processKey: string, sessionId: string | null, name: string, enabled: boolean],
      SetSessionToolEnabledResult
    >([str(), str(), nullable(str()), str(), bool()]),
  },
  /**
   * Project-relative file listing for the composer's @ picker;
   * gitignore-aware, with a walk fallback outside repos.
   */
  listProjectFiles: {
    channel: "project-files:list",
    ...request<[projectCwd: string], { files: string[]; truncated: boolean }>([str()]),
  },
  /**
   * Busy-route mention resolution: omp skips @-extraction on steer/follow_up,
   * so omp-ui inlines mention contents itself on those routes.
   */
  resolveFileMentions: {
    channel: "file-mentions:resolve",
    ...request<[projectCwd: string, message: string], ResolvedMentionContext>([str(), str()]),
  },
  /**
   * Writes pasted image bytes to a scratch file and delivers its path to the
   * PTY as a bracketed paste — omp's TUI loads the file itself. The PTY carries
   * no byte channel, so this is the only route for terminal-mode images.
   */
  ptyPasteImage: {
    channel: "pty:pasteImage",
    ...request<[tabId: string, image: ImageAttachment], void>([str(), imageAttachmentCodec]),
  },
  ptyWrite: { channel: "pty:write", ...notify<[tabId: string, data: string]>([str(), str()]) },
  ptyResize: {
    channel: "pty:resize",
    ...notify<[tabId: string, cols: number, rows: number]>([str(), num(), num()]),
  },
  /**
   * Spawns the tab's console-drawer program in `cwd` — the user's login shell
   * ($SHELL -l; COMSPEC on Windows) by default (issue #42), or omp's TUI for a
   * handoff (issue #243). Replaces any program already running for the tab.
   * Rejects when the program cannot be spawned.
   */
  shellSpawn: {
    channel: "shell:spawn",
    ...request<
      [tabId: string, cwd: string, cols: number, rows: number, program?: ConsoleProgram],
      void
    >([str(), str(), num(), num(), trailingOptional(consoleProgramCodec)]),
  },
  /** Kills the tab's console-drawer shell, suppressing its exit event. */
  shellKill: { channel: "shell:kill", ...notify<[tabId: string]>([str()]) },
  shellWrite: { channel: "shell:write", ...notify<[tabId: string, data: string]>([str(), str()]) },
  shellResize: {
    channel: "shell:resize",
    ...notify<[tabId: string, cols: number, rows: number]>([str(), num(), num()]),
  },
  onShellData: {
    channel: "shell:data",
    ...event<[tabId: string, data: Uint8Array]>(),
  },
  onShellExit: {
    channel: "shell:exit",
    ...event<[tabId: string, exitCode: number]>(),
  },
  rpcSend: { channel: "rpc:send", ...notify<[tabId: string, command: RpcFrame]>([str(), rpcFrameCodec]) },
  /**
   * Reports the tab this renderer currently has in view, or null when none.
   * `clientId` is the renderer's stable report identity so a reload replaces
   * its previous report instead of accumulating. Fire-and-forget: the
   * hibernation guard re-checks report freshness on every quiet-window tick,
   * so a report that goes silent (closed window, dead socket) stops
   * protecting on its own (issue #266).
   */
  tabViewed: { channel: "tab:viewed", ...notify<[clientId: string, tabId: string | null]>([str(), nullable(str())]) },
  /**
   * Reports this renderer's stall auto-continue guard for a tab (issue #271):
   * true when it pauses at its cap, false when it re-arms (user prompt / plan
   * execute) or the tab is erased or re-booted.
   */
  reportStallCap: {
    channel: "stall:cap",
    ...notify<[tabId: string, paused: boolean]>([str(), bool()]),
  },
  onPtyData: { channel: "pty:data", ...event<[tabId: string, data: Uint8Array]>() },
  onPtyExit: {
    channel: "pty:exit",
    ...event<[tabId: string, exitCode: number]>(),
  },
  /** The session's process was hibernated after an idle window (issue #246). */
  onSessionHibernated: {
    channel: "session:hibernated",
    ...event<[tabId: string]>(),
  },
  /**
   * A desktop OS notification for this tab was clicked: every renderer
   * resurfaces (or resumes) the session's tab through openSession (issue #271).
   */
  onFocusSession: {
    channel: "session:focus",
    ...event<[tabId: string]>(),
  },
  onRpcFrame: { channel: "rpc:frame", ...event<[tabId: string, frame: object]>() },
  onStateChanged: { channel: "state:changed", ...event<[state: BackendState]>() },
  toggleFavorite: {
    channel: "favorites:toggle",
    ...request<[key: string], void>([str()]),
  },
  /** Current omp binary update state. */
  getOmpUpdateState: { channel: "omp:updateGetState", ...request<[], OmpUpdateState>([]) },
  /** Manual check — surfaces up-to-date/error transiently, bypasses dismissal. */
  checkOmpUpdate: { channel: "omp:updateCheck", ...request<[], OmpUpdateState>([]) },
  /**
   * Starts the opt-in install/update of the managed omp binary. No-op unless
   * an update or install is offered. Progress flows via onOmpUpdateState.
   */
  downloadOmpUpdate: { channel: "omp:updateDownload", ...request<[], void>([]) },
  /**
   * Hides the card. `remember: true` also persists the version so background
   * checks stay quiet for that offer; `false` is a transient hide.
   */
  dismissOmpUpdate: {
    channel: "omp:updateDismiss",
    ...request<[version: string, remember: boolean], void>([str(), bool()]),
  },
  onOmpUpdateState: { channel: "omp:updateState", ...event<[state: OmpUpdateState]>() },
  /** Current omp-ui update state. */
  getAppUpdateState: { channel: "app:updateGetState", ...request<[], AppUpdateState>([]) },
  /** Manual check — surfaces up-to-date/error/disabled transiently. */
  checkAppUpdate: { channel: "app:updateCheck", ...request<[], AppUpdateState>([]) },
  /**
   * Starts the package-appropriate manual action for non-auto-update formats:
   * verified download + system-installer handoff. AppImage/NSIS/macOS-zip
   * staging begins as soon as a check finds an update (issue #99, issue #125).
   */
  downloadAppUpdate: { channel: "app:updateDownload", ...request<[], void>([]) },
  /** Opens the pending release's GitHub page. */
  openAppUpdateReleaseNotes: { channel: "app:updateOpenNotes", ...request<[], void>([]) },
  /** Reveals the downloaded update artifact in its folder. */
  showAppUpdateDownload: { channel: "app:updateShowDownload", ...request<[], void>([]) },
  /**
   * Requests a restart into a staged update. The first call leaves `confirmed`
   * false; `confirmation-required` must be answered in the initiating renderer.
   */
  restartForAppUpdate: {
    channel: "app:updateRestart",
    ...request<[confirmed?: boolean], AppUpdateRestartResult>([trailingOptional(bool())]),
  },
  /** Arms or disarms applying a staged update on the next natural quit. */
  setAppUpdateInstallOnQuit: {
    channel: "app:updateInstallOnQuit",
    ...request<[on: boolean], void>([bool()]),
  },
  /**
   * Hides the card. `remember: true` also persists the version so background
   * checks stay quiet for that release; `false` is a transient hide.
   */
  dismissAppUpdate: {
    channel: "app:updateDismiss",
    ...request<[version: string, remember: boolean], void>([str(), bool()]),
  },
  onAppUpdateState: { channel: "app:updateState", ...event<[state: AppUpdateState]>() },
  /** Embedded remote-access server settings + live status (issue #37). */
  getRemoteState: { channel: "remote:getState", ...request<[], RemoteState>([]) },
  setRemoteEnabled: { channel: "remote:setEnabled", ...request<[on: boolean], void>([bool()]) },
  setRemoteBind: { channel: "remote:setBind", ...request<[bind: RemoteBind], void>([remoteBindCodec]) },
  /** Rejects when the port is not a whole number in 1024–65535. */
  setRemotePort: { channel: "remote:setPort", ...request<[port: number], void>([num()]) },
  /** Mints a fresh token and restarts the server, dropping every connected client. */
  regenerateRemoteToken: { channel: "remote:regenerateToken", ...request<[], void>([]) },
  /**
   * Sets the remote sign-in password (stored as a salted scrypt hash) and restarts the server,
   * dropping every connected client. Rejects with the policy message from
   * validateRemotePassword when the password is unacceptable.
   */
  setRemotePassword: { channel: "remote:setPassword", ...request<[password: string], void>([str()]) },
  /** Clears the password; remote access falls back to token-only. Restarts the server. */
  clearRemotePassword: { channel: "remote:clearPassword", ...request<[], void>([]) },
  onRemoteState: { channel: "remote:state", ...event<[state: RemoteState]>() },
  /** This app's stable identity; a joiner uses it to detect itself and version skew (issue #416). */
  getInstanceIdentity: { channel: "instance:identity", ...request<[], InstanceIdentity>([]) },
  /** Signs in (password) or adopts a token, stores the derived credential, connects. Rejects with a user-facing message. */
  addRemoteInstance: {
    channel: "remote-instance:add",
    ...request<[input: RemoteInstanceInput], void>([remoteInstanceInputCodec]),
  },
  /** Edits nickname/url/secret; a url or secret change reconnects. */
  updateRemoteInstance: {
    channel: "remote-instance:update",
    ...request<[id: string, patch: RemoteInstancePatch], void>([str(), remoteInstancePatchCodec]),
  },
  /** Disconnects and forgets the record and credential. Open tabs of that instance are removed by the renderer on the next state. */
  removeRemoteInstance: { channel: "remote-instance:remove", ...request<[id: string], void>([str()]) },
  /** Resets backoff and dials now; also the retry from needs-sign-in after a secret change. */
  reconnectRemoteInstance: {
    channel: "remote-instance:reconnect",
    ...request<[id: string], void>([str()]),
  },
  /** Forwards one allowlisted request to the named instance; rejects `unknown instance`, `not joined`, or `channel not proxied`. */
  remoteInstanceRequest: {
    channel: "remote-instance:request",
    ...request<[instanceId: string, channel: string, args: unknown[]], unknown>([
      str(),
      str(),
      arrayOf(any()),
    ]),
  },
  /** Forwards one allowlisted notification; silently dropped when the instance is not joined. */
  remoteInstanceNotify: {
    channel: "remote-instance:notify",
    ...notify<[instanceId: string, channel: string, args: unknown[]]>([str(), str(), arrayOf(any())]),
  },
  /**
   * Manifest for the export dialog: sections, file names, sizes — no contents
   * read beyond stat/git (issue #413).
   */
  previewDiagnosticsBundle: {
    channel: "diagnostics:preview",
    ...request<[], DiagnosticsPreview>([]),
  },
  /** Builds the zip and writes it to destinationPath (absolute) or beside the registry when null. */
  exportDiagnosticsBundle: {
    channel: "diagnostics:export",
    ...request<[req: DiagnosticsExportRequest], DiagnosticsExportResult>([
      diagnosticsExportRequestCodec,
    ]),
  },
  /** Desktop-only: native save dialog; resolves the chosen path or null on cancel. */
  chooseDiagnosticsPath: {
    channel: "diagnostics:choosePath",
    ...request<[basename: string], string | null>([str()]),
  },
  /** The app-wide subscription sign-in flow's phase changes. */
  onProviderOAuthState: { channel: "provider-oauth:state", ...event<[state: ProviderOAuthState]>() },
} as const;
export type BackendChannelSpec = typeof BACKEND_CHANNELS;
export type BackendMethodName = keyof BackendChannelSpec;

type ChannelNames = {
  readonly [Method in BackendMethodName]: BackendChannelSpec[Method]["channel"];
};

/** Channel strings keyed by the same public method names as {@link OmpBackend}. */
export const CH = Object.fromEntries(
  Object.entries(BACKEND_CHANNELS).map(([method, descriptor]) => [method, descriptor.channel]),
) as ChannelNames;

const ARG_CODECS_BY_CHANNEL = new Map<string, readonly ArgCodec<unknown>[]>();
for (const descriptor of Object.values(BACKEND_CHANNELS)) {
  if (descriptor.kind !== "event") {
    ARG_CODECS_BY_CHANNEL.set(
      descriptor.channel,
      descriptor.args as readonly ArgCodec<unknown>[],
    );
  }
}

type ClientMethod<Descriptor> = Descriptor extends RequestChannel<infer Args, infer Result>
  ? (...args: Args) => Promise<Result>
  : Descriptor extends NotifyChannel<infer Args>
    ? (...args: Args) => void
    : Descriptor extends EventChannel<infer Args>
      ? (cb: (...args: Args) => void) => void
      : never;

/** Public backend client, derived entirely from {@link BACKEND_CHANNELS}. */
export type OmpBackend = {
  readonly [Method in BackendMethodName]: ClientMethod<BackendChannelSpec[Method]>;
};

type RequestHandlers = {
  readonly [Method in BackendMethodName as BackendChannelSpec[Method]["kind"] extends "request"
    ? BackendChannelSpec[Method]["channel"]
    : never]: BackendChannelSpec[Method] extends RequestChannel<infer Args, infer Result>
    ? (...args: Args) => Result | Promise<Result>
    : never;
};

type NotifyHandlers = {
  readonly [Method in BackendMethodName as BackendChannelSpec[Method]["kind"] extends "notify"
    ? BackendChannelSpec[Method]["channel"]
    : never]: BackendChannelSpec[Method] extends NotifyChannel<infer Args>
    ? (...args: Args) => void
    : never;
};

/** Complete main-process implementations for request and notify channels; events have no handlers. */
export interface ChannelTable {
  readonly request: RequestHandlers;
  readonly notify: NotifyHandlers;
}

function decodeArgs(
  channel: string,
  args: unknown[],
  codecs: readonly ArgCodec<unknown>[],
): unknown[] {
  if (args.length > codecs.length) {
    throw new Error(`invalid arguments for ${channel}: expected at most ${codecs.length}`);
  }

  const decoded = new Array<unknown>(args.length);
  for (let index = 0; index < codecs.length; index += 1) {
    try {
      const value = codecs[index]!.decode(args[index], `argument ${index}`);
      if (index < args.length) decoded[index] = value;
    } catch (error) {
      const detail = error instanceof Error ? error.message : `argument ${index} is invalid`;
      throw new Error(`invalid arguments for ${channel}: ${detail}`, { cause: error });
    }
  }
  return decoded;
}

/**
 * The single dispatch boundary into a {@link ChannelTable}. Both transports — Electron's
 * ipcMain and the remote ws server — deliver dynamically decoded `unknown[]` argument
 * arrays. This boundary rejects malformed tuples before tuple-checked handlers run.
 *
 * An unknown request channel rejects with a named error; a throwing handler rejects with
 * its own error. The transport decides what a rejection means on the wire.
 */
export function dispatchRequest(
  table: ChannelTable,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const codecs = ARG_CODECS_BY_CHANNEL.get(channel);
  if (!Object.hasOwn(table.request, channel) || codecs === undefined) {
    return Promise.reject(new Error(`unknown channel ${channel}`));
  }
  const handler = (table.request as unknown as Record<string, (...args: unknown[]) => unknown>)[
    channel
  ]!;
  try {
    return Promise.resolve(handler(...decodeArgs(channel, args, codecs)));
  } catch (err) {
    return Promise.reject(err);
  }
}

/**
 * Fire-and-forget dispatch. Unknown notify channels are ignored — there is no one to tell —
 * and a throwing handler is swallowed: a notify has no reply channel, so the error can only
 * be dropped. Both transports share that policy (issue #301).
 */
export function dispatchNotify(
  table: ChannelTable,
  channel: string,
  args: unknown[],
): void {
  const codecs = ARG_CODECS_BY_CHANNEL.get(channel);
  if (!Object.hasOwn(table.notify, channel) || codecs === undefined) return;
  const handler = (table.notify as unknown as Record<string, (...args: unknown[]) => void>)[
    channel
  ]!;
  try {
    handler(...decodeArgs(channel, args, codecs));
  } catch {
    // No reply channel — malformed input and handler failures are dropped.
  }
}

/** Transport primitives implemented at an IPC or WebSocket boundary. */
export interface BackendTransport {
  request<Args extends unknown[], Result>(channel: string, args: Args): Promise<Result>;
  notify<Args extends unknown[]>(channel: string, args: Args): void;
  on<Args extends unknown[]>(channel: string, cb: (...args: Args) => void): void;
}

type RuntimeMethod = (...args: never[]) => unknown;

/** Builds every backend method from the shared spec and transport primitives. */
export function makeBackendClient(transport: BackendTransport): OmpBackend {
  const client: Record<string, RuntimeMethod> = {};

  for (const [method, descriptor] of Object.entries(BACKEND_CHANNELS)) {
    switch (descriptor.kind) {
      case "request":
        client[method] = (...args) => transport.request<never[], never>(descriptor.channel, args);
        break;
      case "notify":
        client[method] = (...args) => transport.notify(descriptor.channel, args);
        break;
      case "event":
        client[method] = (...args) => transport.on(descriptor.channel, args[0]);
        break;
    }
  }

  return client as OmpBackend;
}
