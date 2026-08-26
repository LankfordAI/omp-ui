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
  DirBrowseResult,
  ImageAttachment,
  McpServersResult,
  McpSetEnabledRequest,
  MemoryEditResult,
  MemoryListOptions,
  MemoryOverview,
  MemoryPage,
  MemoryRow,
  MemoryScope,
  MergeBackResult,
  MergeBackStatus,
  OmpSettingValue,
  OmpSettingsSnapshot,
  OmpUpdateState,
  PlanFormat,
  ProjectRecord,
  ProjectOpenAvailability,
  ProjectOpenTarget,
  ProviderKeysSnapshot,
  RemoteBind,
  RemoteState,
  ResolvedMentionContext,
  SessionMode,
  SpawnRequest,
} from "./types";
import type { RpcFrame } from "./rpc/codec";

/** Type-only marker for a request/reply channel. */
export interface RequestChannel<Args extends unknown[], Result> {
  readonly kind: "request";
  readonly $args?: Args;
  readonly $result?: Result;
}

/** Type-only marker for a fire-and-forget client notification. */
export interface NotifyChannel<Args extends unknown[]> {
  readonly kind: "notify";
  readonly $args?: Args;
}

/** Type-only marker for an event emitted by the backend. */
export interface EventChannel<Args extends unknown[]> {
  readonly kind: "event";
  readonly $args?: Args;
}

const REQUEST = { kind: "request" } as const;
const NOTIFY = { kind: "notify" } as const;
const EVENT = { kind: "event" } as const;

/** Declares a request/reply channel's argument tuple and result. */
export function request<Args extends unknown[], Result>(): RequestChannel<Args, Result> {
  return REQUEST;
}

/** Declares a fire-and-forget notification channel's argument tuple. */
export function notify<Args extends unknown[]>(): NotifyChannel<Args> {
  return NOTIFY;
}

/** Declares a backend event channel's callback argument tuple. */
export function event<Args extends unknown[]>(): EventChannel<Args> {
  return EVENT;
}

/**
 * The renderer↔backend seam (ADR-0002). A capability is declared once here;
 * the public client, channel names, and main-process handler table derive from it.
 */
export const BACKEND_CHANNELS = {
  getState: { channel: "state:get", ...request<[], BackendState>() },
  /**
   * Registers a directory as a project. `path` may be ~-prefixed or absolute;
   * the backend expands, resolves, and validates it is an existing directory,
   * rejecting with a user-facing message otherwise. An already-registered path
   * resolves to its existing record.
   */
  addProject: { channel: "project:add", ...request<[path: string], ProjectRecord>() },
  /**
   * Reports which external project-open targets are available. The host
   * resolves this once and caches the result for the application lifetime.
   */
  getProjectOpenAvailability: {
    channel: "project:openAvailability",
    ...request<[], ProjectOpenAvailability>(),
  },
  /**
   * Opens a project in the selected external target. Rejects with an
   * actionable, user-facing message when the target cannot be opened.
   */
  openProject: {
    channel: "project:open",
    ...request<[projectPath: string, target: ProjectOpenTarget], void>(),
  },
  /** Directory listing for the in-app project picker (read-only, never mutates). */
  browseDirectories: {
    channel: "dir:browse",
    ...request<[partialPath: string], DirBrowseResult>(),
  },
  removeProject: { channel: "project:remove", ...request<[path: string], void>() },
  /**
   * Moves a registered project to sit immediately before `beforePath` in the
   * sidebar order; a null `beforePath` (or one that is not registered) appends
   * it to the end. The order is the persisted registry order, so the change
   * survives a restart. An unknown `projectPath`, and a `beforePath` equal to
   * it, are no-ops.
   */
  moveProject: {
    channel: "project:move",
    ...request<[projectPath: string, beforePath: string | null], void>(),
  },
  /**
   * Pins the project's default main model (issue #257) — the `provider/id`
   * selector new sessions boot with, ahead of last-used memory. null clears
   * the pin.
   */
  setProjectDefaultModel: {
    channel: "project:setDefaultModel",
    ...request<[projectPath: string, model: string | null], void>(),
  },
  /**
   * Pins the project's default advisor model (issue #257) — the
   * `model[:level]` selector a new session's advisor uses when the advisor
   * on/off chain enables it. null clears the pin.
   */
  setProjectDefaultAdvisorModel: {
    channel: "project:setDefaultAdvisorModel",
    ...request<[projectPath: string, model: string | null], void>(),
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
    ...request<[tabId: string, beforeTabId: string | null], void>(),
  },
  setDefaultMode: {
    channel: "settings:setDefaultMode",
    ...request<[mode: SessionMode], void>(),
  },
  setDefaultAgentMode: {
    channel: "settings:setDefaultAgentMode",
    ...request<[mode: AgentMode], void>(),
  },
  listCompactionMethods: {
    channel: "settings:listCompactionMethods",
    ...request<[], string[]>(),
  },
  setDefaultCompactionMethod: {
    channel: "settings:setDefaultCompactionMethod",
    ...request<[method: string | null], void>(),
  },
  setPlanFormat: {
    channel: "settings:setPlanFormat",
    ...request<[format: PlanFormat], void>(),
  },
  setHibernateIdleMinutes: {
    channel: "settings:setHibernateIdleMinutes",
    ...request<[minutes: number], void>(),
  },
  setStreamStallAbortSeconds: {
    channel: "settings:setStreamStallAbortSeconds",
    ...request<[seconds: number], void>(),
  },
  setAdvisorAutoReply: {
    channel: "settings:setAdvisorAutoReply",
    ...request<[on: boolean], void>(),
  },
  setStallAutoContinue: {
    channel: "settings:setStallAutoContinue",
    ...request<[on: boolean], void>(),
  },
  /** OS notifications for background-session attention states (issue #271); default on. */
  setDesktopNotifications: {
    channel: "settings:setDesktopNotifications",
    ...request<[on: boolean], void>(),
  },
  setDefaultAdvisor: {
    channel: "settings:setDefaultAdvisor",
    ...request<[on: boolean], void>(),
  },
  setSkipDeleteConfirmation: {
    channel: "settings:setSkipDeleteConfirmation",
    ...request<[skip: boolean], void>(),
  },
  setThemeId: { channel: "settings:setThemeId", ...request<[id: string], void>() },
  setAppUpdateCheckOnLaunch: {
    channel: "settings:setAppUpdateCheckOnLaunch",
    ...request<[on: boolean], void>(),
  },
  setOmpUpdateCheckOnLaunch: {
    channel: "settings:setOmpUpdateCheckOnLaunch",
    ...request<[on: boolean], void>(),
  },
  /** Clears the remembered omp-ui update dismissal so the offer can return. */
  clearDismissedAppUpdate: {
    channel: "settings:clearDismissedAppUpdate",
    ...request<[], void>(),
  },
  /** Clears the remembered omp update dismissal so the offer can return. */
  clearDismissedOmpUpdate: {
    channel: "settings:clearDismissedOmpUpdate",
    ...request<[], void>(),
  },
  /** Repaints the native title-bar overlay to match the active theme. */
  setWindowChrome: {
    channel: "window:setChrome",
    ...request<[background: string, symbol: string], void>(),
  },
  /**
   * omp's own settings for the allowlist, with the layer each value comes from.
   * `projectCwd` selects the project layer to account for; pass null to read
   * the global layer alone.
   */
  readOmpSettings: {
    channel: "omp-settings:read",
    ...request<[projectCwd: string | null], OmpSettingsSnapshot>(),
  },
  /**
   * Writes one omp setting to the GLOBAL layer via `omp config set`. `value`
   * is serialized per its schema type. Rejects with omp's own stderr message.
   */
  writeOmpSetting: {
    channel: "omp-settings:write",
    ...request<[key: string, value: OmpSettingValue], void>(),
  },
  /**
   * Provider credentials omp-ui supplies to every omp it launches, with the
   * source of each. `projectCwd` scopes the report-only `.env` scan; pass null
   * to skip it. Never returns key material — only masked tails.
   */
  readProviderKeys: {
    channel: "provider-keys:read",
    ...request<[projectCwd: string | null], ProviderKeysSnapshot>(),
  },
  /**
   * Stores one provider credential, encrypted by the OS credential store, and
   * applies it so the next session sees it. Rejects when the variable is not a
   * known provider variable, the value is not a single non-empty line, or the
   * platform offers no credential store.
   */
  setProviderKey: {
    channel: "provider-keys:set",
    ...request<[envName: string, value: string], ProviderKeysSnapshot>(),
  },
  /** Forgets a stored credential; inherited or login-shell values take over again. */
  clearProviderKey: {
    channel: "provider-keys:clear",
    ...request<[envName: string], ProviderKeysSnapshot>(),
  },
  spawnSession: {
    channel: "session:spawn",
    ...request<[req: SpawnRequest], { tabId: string }>(),
  },
  terminateSession: {
    channel: "session:terminate",
    ...request<[tabId: string], void>(),
  },
  /**
   * Hibernates a planning source after its fresh implementation session has
   * accepted the seed prompt (issue #283). Main validates the persisted
   * handoff relation and refuses to reap live or uncertain work.
   */
  hibernatePlanSource: {
    channel: "session:hibernatePlanSource",
    ...request<[sourceTabId: string, implementationTabId: string], boolean>(),
  },
  switchMode: {
    channel: "session:switchMode",
    ...request<[tabId: string, mode: SessionMode], void>(),
  },
  /**
   * Delete preview (issue #309): every owned session descended from
   * `tabId` through `planImplementationSource`, with its cached title and
   * whether its omp process is running. Read-only; an unknown `tabId`
   * resolves to no descendants, mirroring `session:delete`'s leniency.
   */
  deleteSessionPreview: {
    channel: "session:deletePreview",
    ...request<[tabId: string], DeleteSessionPreview>(),
  },
  /**
   * Deletes a session: the registry record plus its lineage files in the
   * active and archive roots (transcript + artifacts). Irreversible. With
   * `cascade`, also deletes every plan-handoff descendant of the session,
   * each through the same per-session path (issue #309).
   */
  deleteSession: {
    channel: "session:delete",
    ...request<[tabId: string, cascade: boolean], void>(),
  },
  /**
   * Full-fidelity branch (issue #83): copies the session's transcript into a
   * new lineage dir under a fresh session id and registers it, ready to open
   * in a new tab. The source session — file, record, live process — is left
   * untouched. Rejects when the source is archived or has no transcript yet.
   */
  forkSession: {
    channel: "session:fork",
    ...request<[tabId: string], { tabId: string }>(),
  },
  /**
   * Re-pins a session's advisor state. omp binds both the enable flag and the
   * `advisor` role at process start, so a live session is respawned with
   * `--resume`; a dormant one just records the choice for its next launch.
   */
  setSessionAdvisor: {
    channel: "session:setAdvisor",
    ...request<[tabId: string, advisor: boolean, advisorModel: string | null], void>(),
  },
  /** omp's advisor defaults for a project (global config plus project overlay). */
  getAdvisorDefaults: {
    channel: "advisor:defaults",
    ...request<[projectCwd: string], AdvisorDefaults>(),
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
    >(),
  },
  /**
   * Titles a first user prompt with omp's own small model (the `tiny`/`commit`/
   * `smol` role chain). Resolves to null whenever the model declines or the run
   * fails — the caller keeps its derived title in that case.
   */
  generateTitle: {
    channel: "title:generate",
    ...request<[projectCwd: string, prompt: string], string | null>(),
  },
  /**
   * Suggests a git branch name for a plan with omp's own small model (the
   * `tiny`/`commit`/`smol` role chain, same as titling). Resolves to null on
   * every failure path — the caller pre-fills its derived name.
   */
  suggestBranchName: {
    channel: "branch:nameSuggest",
    ...request<[projectCwd: string, planContext: string], string | null>(),
  },
  /**
   * Reads a plan artifact for the review pane, by absolute path. Confined to
   * the session's lineage dir by the implementation; null when the file is
   * absent or out of bounds.
   */
  readPlanFile: {
    channel: "plan:read",
    ...request<[tabId: string, absPath: string], string | null>(),
  },
  /**
   * Opens an absolute path with the system default handler (a browser for the
   * exported transcript HTML). Rejects when the handler reports a failure.
   */
  openPath: { channel: "file:open", ...request<[absPath: string], void>() },
  /** Reveals an absolute path in the platform file manager. */
  showPathInFolder: {
    channel: "file:showInFolder",
    ...request<[absPath: string], void>(),
  },
  /**
   * Working-tree changes on the active branch of a project's git repo: tracked
   * changes vs HEAD plus new untracked files. Null fields when the project is
   * not inside a git repository.
   */
  getBranchDiff: {
    channel: "branch:diff",
    ...request<[projectCwd: string, base?: string | null], BranchDiff>(),
  },
  /**
   * Local branches of a project's git repo, default branch first. Null fields
   * when the project is not inside a git repository.
   */
  listBranches: {
    channel: "branch:list",
    ...request<[projectCwd: string, opts?: BranchListOptions], BranchList>(),
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
    >(),
  },
  /** Pulls the checked-out branch from its configured upstream. */
  pullBranch: {
    channel: "branch:pull",
    ...request<[projectCwd: string], void>(),
  },
  /** Merge-back feasibility for a worktree session's recorded base (issue #272). */
  getMergeBackStatus: {
    channel: "branch:mergeStatus",
    ...request<[projectCwd: string, branch: string, base: string | null], MergeBackStatus>(),
  },
  /** Merges the worktree branch into its destination in the project checkout (issue #272). */
  mergeWorktreeBranch: {
    channel: "branch:mergeBack",
    ...request<[projectCwd: string, branch: string, destination: string], MergeBackResult>(),
  },
  /**
   * Resolved mnemopi memory overview for a project; never rejects — failures
   * land in `.error` (issue #206).
   */
  memoryOverview: {
    channel: "memory:overview",
    ...request<[projectCwd: string], MemoryOverview>(),
  },
  /** One page of a bank's memories, newest first; FTS search when opts.query is set. */
  memoryList: {
    channel: "memory:list",
    ...request<[projectCwd: string, scope: MemoryScope, opts: MemoryListOptions], MemoryPage>(),
  },
  /** Point lookup with full, unclipped content — the pane's expand-on-demand fetch. */
  memoryGet: {
    channel: "memory:get",
    ...request<[projectCwd: string, scope: MemoryScope, id: string], MemoryRow | null>(),
  },
  /** Inserts a durable user memory into the working store. */
  memoryAdd: {
    channel: "memory:add",
    ...request<[projectCwd: string, scope: MemoryScope, content: string], MemoryRow>(),
  },
  /** Patches a working row's content/importance; episodic rows are not_editable. */
  memoryUpdate: {
    channel: "memory:update",
    ...request<
      [projectCwd: string, scope: MemoryScope, id: string, patch: { content?: string; importance?: number }],
      MemoryEditResult
    >(),
  },
  /**
   * Deletes a working row and its sidecar artifacts; episodic rows are
   * not_editable.
   */
  memoryForget: {
    channel: "memory:forget",
    ...request<[projectCwd: string, scope: MemoryScope, id: string], MemoryEditResult>(),
  },
  /**
   * Lists resolved, redacted MCP servers and per-file errors; null projectCwd
   * lists the global (user-level) scope only.
   */
  getMcpServers: {
    channel: "mcp:list",
    ...request<[projectCwd: string | null], McpServersResult>(),
  },
  /** Toggles one writable MCP server and returns the refreshed list. */
  setMcpServerEnabled: {
    channel: "mcp:setEnabled",
    ...request<[req: McpSetEnabledRequest], McpServersResult>(),
  },
  /**
   * Restarts a live session in place (kill + relaunch with `--resume`, same
   * dance as the advisor/mode-switch relaunch) so it picks up changed MCP
   * config. Rejects when the session is not live.
   */
  restartSession: {
    channel: "session:restart",
    ...request<[tabId: string], void>(),
  },
  convertToWorktree: {
    channel: "session:convert-to-worktree",
    ...request<[tabId: string, branch: string, baseRef: string | null], void>(),
  },
  /**
   * Project-relative file listing for the composer's @ picker;
   * gitignore-aware, with a walk fallback outside repos.
   */
  listProjectFiles: {
    channel: "project-files:list",
    ...request<[projectCwd: string], { files: string[]; truncated: boolean }>(),
  },
  /**
   * Busy-route mention resolution: omp skips @-extraction on steer/follow_up,
   * so omp-ui inlines mention contents itself on those routes.
   */
  resolveFileMentions: {
    channel: "file-mentions:resolve",
    ...request<[projectCwd: string, message: string], ResolvedMentionContext>(),
  },
  /**
   * Writes pasted image bytes to a scratch file and delivers its path to the
   * PTY as a bracketed paste — omp's TUI loads the file itself. The PTY carries
   * no byte channel, so this is the only route for terminal-mode images.
   */
  ptyPasteImage: {
    channel: "pty:pasteImage",
    ...request<[tabId: string, image: ImageAttachment], void>(),
  },
  ptyWrite: { channel: "pty:write", ...notify<[tabId: string, data: string]>() },
  ptyResize: {
    channel: "pty:resize",
    ...notify<[tabId: string, cols: number, rows: number]>(),
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
    >(),
  },
  /** Kills the tab's console-drawer shell, suppressing its exit event. */
  shellKill: { channel: "shell:kill", ...notify<[tabId: string]>() },
  shellWrite: { channel: "shell:write", ...notify<[tabId: string, data: string]>() },
  shellResize: {
    channel: "shell:resize",
    ...notify<[tabId: string, cols: number, rows: number]>(),
  },
  onShellData: {
    channel: "shell:data",
    ...event<[tabId: string, data: Uint8Array]>(),
  },
  onShellExit: {
    channel: "shell:exit",
    ...event<[tabId: string, exitCode: number]>(),
  },
  rpcSend: { channel: "rpc:send", ...notify<[tabId: string, command: RpcFrame]>() },
  /**
   * Reports the tab this renderer currently has in view, or null when none.
   * `clientId` is the renderer's stable report identity so a reload replaces
   * its previous report instead of accumulating. Fire-and-forget: the
   * hibernation guard re-checks report freshness on every quiet-window tick,
   * so a report that goes silent (closed window, dead socket) stops
   * protecting on its own (issue #266).
   */
  tabViewed: { channel: "tab:viewed", ...notify<[clientId: string, tabId: string | null]>() },
  /**
   * Reports this renderer's stall auto-continue guard for a tab (issue #271):
   * true when it pauses at its cap, false when it re-arms (user prompt / plan
   * execute) or the tab is erased or re-booted.
   */
  reportStallCap: {
    channel: "stall:cap",
    ...notify<[tabId: string, paused: boolean]>(),
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
    ...request<[key: string], void>(),
  },
  /** Current omp binary update state. */
  getOmpUpdateState: { channel: "omp:updateGetState", ...request<[], OmpUpdateState>() },
  /** Manual check — surfaces up-to-date/error transiently, bypasses dismissal. */
  checkOmpUpdate: { channel: "omp:updateCheck", ...request<[], OmpUpdateState>() },
  /**
   * Starts the opt-in install/update of the managed omp binary. No-op unless
   * an update or install is offered. Progress flows via onOmpUpdateState.
   */
  downloadOmpUpdate: { channel: "omp:updateDownload", ...request<[], void>() },
  /**
   * Hides the card. `remember: true` also persists the version so background
   * checks stay quiet for that offer; `false` is a transient hide.
   */
  dismissOmpUpdate: {
    channel: "omp:updateDismiss",
    ...request<[version: string, remember: boolean], void>(),
  },
  onOmpUpdateState: { channel: "omp:updateState", ...event<[state: OmpUpdateState]>() },
  /** Current omp-ui update state. */
  getAppUpdateState: { channel: "app:updateGetState", ...request<[], AppUpdateState>() },
  /** Manual check — surfaces up-to-date/error/disabled transiently. */
  checkAppUpdate: { channel: "app:updateCheck", ...request<[], AppUpdateState>() },
  /**
   * Starts the package-appropriate manual action for non-auto-update formats:
   * verified download + system-installer handoff. AppImage/NSIS/macOS-zip
   * staging begins as soon as a check finds an update (issue #99, issue #125).
   */
  downloadAppUpdate: { channel: "app:updateDownload", ...request<[], void>() },
  /** Opens the pending release's GitHub page. */
  openAppUpdateReleaseNotes: { channel: "app:updateOpenNotes", ...request<[], void>() },
  /** Reveals the downloaded update artifact in its folder. */
  showAppUpdateDownload: { channel: "app:updateShowDownload", ...request<[], void>() },
  /**
   * Requests a restart into a staged update. The first call leaves `confirmed`
   * false; `confirmation-required` must be answered in the initiating renderer.
   */
  restartForAppUpdate: {
    channel: "app:updateRestart",
    ...request<[confirmed?: boolean], AppUpdateRestartResult>(),
  },
  /** Arms or disarms applying a staged update on the next natural quit. */
  setAppUpdateInstallOnQuit: {
    channel: "app:updateInstallOnQuit",
    ...request<[on: boolean], void>(),
  },
  /**
   * Hides the card. `remember: true` also persists the version so background
   * checks stay quiet for that release; `false` is a transient hide.
   */
  dismissAppUpdate: {
    channel: "app:updateDismiss",
    ...request<[version: string, remember: boolean], void>(),
  },
  onAppUpdateState: { channel: "app:updateState", ...event<[state: AppUpdateState]>() },
  /** Embedded remote-access server settings + live status (issue #37). */
  getRemoteState: { channel: "remote:getState", ...request<[], RemoteState>() },
  setRemoteEnabled: { channel: "remote:setEnabled", ...request<[on: boolean], void>() },
  setRemoteBind: { channel: "remote:setBind", ...request<[bind: RemoteBind], void>() },
  /** Rejects when the port is not a whole number in 1024–65535. */
  setRemotePort: { channel: "remote:setPort", ...request<[port: number], void>() },
  /** Mints a fresh token and restarts the server, dropping every connected client. */
  regenerateRemoteToken: { channel: "remote:regenerateToken", ...request<[], void>() },
  /**
   * Sets the remote sign-in password (stored as a salted scrypt hash) and restarts the server,
   * dropping every connected client. Rejects with the policy message from
   * validateRemotePassword when the password is unacceptable.
   */
  setRemotePassword: { channel: "remote:setPassword", ...request<[password: string], void>() },
  /** Clears the password; remote access falls back to token-only. Restarts the server. */
  clearRemotePassword: { channel: "remote:clearPassword", ...request<[], void>() },
  onRemoteState: { channel: "remote:state", ...event<[state: RemoteState]>() },
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

/**
 * The single dispatch boundary into a {@link ChannelTable}. Both transports — Electron's
 * ipcMain and the remote ws server — deliver dynamically decoded `unknown[]` argument
 * arrays, so the channel-keyed table is widened exactly once, here; individual handlers
 * stay tuple-checked by ChannelTable.
 *
 * An unknown request channel rejects with a named error; a throwing handler rejects with
 * its own error. The transport decides what a rejection means on the wire.
 */
export function dispatchRequest(
  table: ChannelTable,
  channel: string,
  args: unknown[],
): Promise<unknown> {
  const handler = (table.request as unknown as Record<string, (...args: unknown[]) => unknown>)[
    channel
  ];
  if (handler === undefined) return Promise.reject(new Error(`unknown channel ${channel}`));
  try {
    return Promise.resolve(handler(...args));
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
  const handler = (table.notify as unknown as Record<string, (...args: unknown[]) => void>)[
    channel
  ];
  if (handler === undefined) return;
  try {
    handler(...args);
  } catch {
    // No reply channel — see the doc comment.
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
