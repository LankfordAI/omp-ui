import { create } from "zustand";
import type {
  AdvisorDefaults,
  AppUpdateState,
  BackendState,
  BranchList,
  ImageAttachment,
  LiveState,
  OmpSettingsSnapshot,
  OmpSettingValue,
  OmpUpdateState,
  ProviderKeysSnapshot,
  RemoteBind,
  RemoteState,
  SessionMode,
  SessionSummary,
} from "@omp-ui/core/types";
import {
  parsePlanReviewTitle,
  parsePlanStatus,
  PLAN_COMMAND,
  PLAN_EXECUTE,
  PLAN_REFINE,
  PLAN_STATUS_KEY,
  type PlanReviewRequest,
  type PlanStatus,
} from "@omp-ui/core/plan";
import {
  parseAdvisorStats,
  ADVISOR_STATS_COMMAND,
  ADVISOR_STATS_KEY,
  type AdvisorStatsView,
} from "@omp-ui/core/advisor-stats";
import { backend } from "./backend";
import { extensionCancelResponse, routeExtensionRequest } from "./lib/extension-router";
import { arrField, field, strField } from "./lib/fields";
import {
  PlanConcernWatcher,
  withConcerns,
  type PlanExecutionContext,
} from "./lib/plan-concerns";
import { randomId } from "./lib/random-id";
import {
  emptySessionRuntime,
  parseCommandList,
  parseModelInfo,
  parseModelList,
  parseSessionRuntime,
  parseSessionStats,
  parseSubagents,
  parseTodoPhases,
  type ModelInfo,
  type PromptRoute,
  type SessionRuntime,
  type SessionStats,
  type SlashCommandInfo,
  type SubagentInfo,
  type TodoPhase,
} from "./lib/rpc-types";
import { generateTitleFromPrompt, isLowSignalTitleInput, isUntitled } from "./lib/session-title";
import { applyTheme, currentThemeId, resolveTheme } from "./lib/themes";
import {
  historyToItems,
  markerItem,
  noticeItem,
  reduceEvent,
  type RenderItem,
} from "./lib/transcript";

export interface TabInfo {
  tabId: string;
  mode: SessionMode;
  projectCwd: string;
  /** Hidden tabs stay mounted (display:none) — the xterm instance survives. */
  hidden: boolean;
}

export interface PendingCommand {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: number;
  /** Background sync — must never drive the busy sweep. */
  quiet: boolean;
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
  /** Extension setStatus/setWidget/setTitle text, keyed by widget/status key. */
  extensionStatus: Record<string, string>;
  /** Not rendered — mutated in place. */
  pendingCommands: Map<string, PendingCommand>;
  extensionQueue: unknown[];
  /** True while any rpc command is in flight. */
  busy: boolean;
  error?: string;
  /**
   * The first user message worth titling from. Set on the first substantive
   * prompt, cleared once the rename lands.
   */
  initialPrompt: string | null;
  /** Whether this tab's session has been auto-titled (or was already named). */
  hasRenamed: boolean;
  /**
   * Plan-mode state, published by the generated plan extension over `setStatus`
   * (see core/plan-extension.ts). Null until the extension first reports — a
   * session whose omp cannot drive plan mode reports `unavailable` instead.
   */
  plan: PlanStatus | null;
  /**
   * The plan awaiting the user's verdict. omp's agent is *blocked* on this:
   * the extension's `select` does not resolve until `executePlan`/`refinePlan`
   * replies, so it must be answered on every path out of the review pane.
   */
  planReview: { request: PlanReviewRequest; frame: unknown } | null;
  /** Plan markdown for the review pane, read off disk. */
  planText: string | null;
  /**
   * The review pane was dismissed without answering the gate ("not now"): the
   * plan stays pending and the agent stays paused; the rail's plans pane is
   * where it is re-opened. Cleared when a verdict lands or a new plan is read.
   */
  planDeferred: boolean;
  /** This session's proposed-plan history, newest first. */
  plans: PlanRecord[];
  /**
   * Advisor spend and context, published by the generated advisor-stats
   * extension over `setStatus` (see core/advisor-stats-extension.ts). Null until
   * the extension first reports; `available: false` means it could not drive
   * omp's surface (or has not run a turn yet) and the HUD omits the element.
   */
  advisorStats: AdvisorStatsView | null;
}

function freshRpcTabState(): RpcTabState {
  return {
    status: "starting",
    items: [],
    todos: [],
    model: null,
    availableModels: [],
    commands: [],
    session: emptySessionRuntime(),
    stats: null,
    subagents: [],
    extensionStatus: {},
    pendingCommands: new Map(),
    extensionQueue: [],
    busy: false,
    initialPrompt: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
  };
}
export type SidebarSessionState =
  | "working"
  | "awaiting-answer"
  | "ready"
  | "starting"
  | "error"
  | LiveState;

export function deriveSidebarSessionState(
  summary: SessionSummary,
  rpc: RpcTabState | undefined,
  exitCode: number | undefined,
): SidebarSessionState {
  if (summary.live !== "live") return summary.live;
  if (exitCode !== undefined) return "dormant";
  if (summary.mode === "pty" || !rpc) return "live";
  if (rpc.status === "error") return "error";
  if (rpc.planReview !== null || rpc.extensionQueue.length > 0) return "awaiting-answer";
  switch (rpc.status) {
    case "running":
      return "working";
    case "ready":
      return "ready";
    case "starting":
      return "starting";
    default:
      return "live";
  }
}


export interface DeleteConfirmation {
  tabId: string;
  title: string;
  running: boolean;
  hasFiles: boolean;
}

/**
 * The settings modal's pages. Declared here rather than in the component: the
 * store imports nothing from any component, and reversing that would make a
 * type-only cycle.
 */
export type SettingsPage =
  | "general"
  | "appearance"
  | "updates"
  | "remote"
  | "providers"
  | "omp"
  | "about";

interface UiStore {
  state: BackendState | null;
  tabs: TabInfo[];
  activeTabId: string | null;
  exited: Record<string, number>;
  /** Console-drawer shell exit codes, keyed by tabId (issue #42). */
  shellExited: Record<string, number>;
  rpc: Record<string, RpcTabState>;
  /**
   * Console drawer open/closed, keyed by tabId (issue #33). View preference,
   * not session state: in-memory only, remembered per tab for the app's
   * lifetime.
   */
  consoleOpen: Record<string, boolean>;
  /**
   * Branch listings keyed by project cwd (issue #35). Shared across every tab
   * on the project, so a checkout in one tab updates all of their chips.
   */
  branches: Record<string, BranchList>;
  /** omp's advisor defaults, keyed by project cwd — see loadAdvisorDefaults. */
  advisorDefaults: Record<string, AdvisorDefaults>;
  deleteConfirmation: DeleteConfirmation | null;
  /** True while the in-app project picker modal is open. */
  projectPickerOpen: boolean;
  /**
   * The MCP manager modal, pinned at open time to the tab it was opened from
   * (focus changes must not retarget it). Null while closed.
   */
  mcpManager: { tabId: string; projectCwd: string } | null;
  /** The settings modal's open page, or null while closed. */
  settingsPage: SettingsPage | null;
  /**
   * Latest pushed omp-ui app update state (issue #18; main/app-update.ts owns
   * the machine). The card renders from this; actions are thin pass-throughs —
   * every visible change arrives as a push, never an optimistic set.
   */
  appUpdate: AppUpdateState;
  /**
   * Latest pushed omp binary install/update state (issue #19;
   * main/omp-update.ts owns the machine). The card renders from this; actions
   * are thin pass-throughs — every visible change arrives as a push, never an
   * optimistic set.
   */
  ompUpdate: OmpUpdateState;
  /**
   * Latest pushed remote-access server settings + status (issue #37;
   * main/remote-server.ts owns the machine). Kept out of BackendState on
   * purpose: the token has no business riding a broadcast every rpc tab
   * re-renders on. Actions are thin pass-throughs — every visible change
   * arrives as a push, never an optimistic set.
   */
  remote: RemoteState;
  init(): Promise<void>;
  checkOmpUpdate(): Promise<void>;
  downloadOmpUpdate(): Promise<void>;
  dismissOmpUpdate(version: string, remember: boolean): Promise<void>;
  checkAppUpdate(): Promise<void>;
  downloadAppUpdate(): Promise<void>;
  openAppUpdateReleaseNotes(): Promise<void>;
  showAppUpdateDownload(): Promise<void>;
  restartForAppUpdate(): Promise<void>;
  dismissAppUpdate(version: string, remember: boolean): Promise<void>;
  openProjectPicker(): void;
  closeProjectPicker(): void;
  openMcpManager(tabId: string, projectCwd: string): void;
  closeMcpManager(): void;
  openSettings(page?: SettingsPage): void;
  closeSettings(): void;
  setDefaultMode(mode: SessionMode): Promise<void>;
  setSkipDeleteConfirmation(skip: boolean): Promise<void>;
  /**
   * The one action that sets before it persists: a theme switch must feel
   * instant, so the paint leads and the write follows. See the implementation.
   */
  setThemeId(id: string): Promise<void>;
  setAppUpdateCheckOnLaunch(on: boolean): Promise<void>;
  setOmpUpdateCheckOnLaunch(on: boolean): Promise<void>;
  clearDismissedAppUpdate(): Promise<void>;
  clearDismissedOmpUpdate(): Promise<void>;
  setRemoteEnabled(on: boolean): Promise<void>;
  setRemoteBind(bind: RemoteBind): Promise<void>;
  setRemotePort(port: number): Promise<void>;
  regenerateRemoteToken(): Promise<void>;
  /**
   * Request/response, not push: these two return their value (or reject) and
   * touch no store field, so the settings omp page owns the result. They
   * deliberately skip `alertError` and RETHROW — that page surfaces failures
   * inline instead of through `window.alert`.
   */
  readOmpSettings(projectCwd: string | null): Promise<OmpSettingsSnapshot>;
  writeOmpSetting(key: string, value: OmpSettingValue): Promise<void>;
  /**
   * Same request/response contract as the two above (rethrow, no store field):
   * the providers page renders failures inline. Every call answers with the
   * refreshed snapshot, so writes need no separate re-read.
   */
  readProviderKeys(projectCwd: string | null): Promise<ProviderKeysSnapshot>;
  setProviderKey(envName: string, value: string): Promise<ProviderKeysSnapshot>;
  clearProviderKey(envName: string): Promise<ProviderKeysSnapshot>;
  /**
   * Restarts a live session in place so it picks up changed MCP config
   * (kill + `--resume` relaunch). Errors surface via the alert path; resolves
   * true only when the relaunch was actually requested.
   */
  restartSession(tabId: string): Promise<boolean>;
  /** Registers `path` via the backend; rejects with the backend's message. */
  addProject(path: string): Promise<void>;
  removeProject(path: string): Promise<void>;
  toggleFavorite(key: string): Promise<void>;
  newSession(projectCwd: string, modeOverride?: SessionMode): Promise<void>;
  openSession(tabId: string): Promise<void>;
  focusTab(tabId: string): void;
  hideTab(tabId: string): void;
  terminate(tabId: string): Promise<void>;
  switchMode(tabId: string, mode: SessionMode): Promise<void>;
  resumeDead(tabId: string): Promise<void>;
  /** Opens the warning, or immediately deletes when warnings were disabled. */
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
  answerExtension(tabId: string, request: unknown, response: Record<string, unknown>): void;
  /** Offer a user message as the auto-title source; low-signal text defers. */
  setInitialPrompt(tabId: string, prompt: string): void;
  /** Auto-title the session from the stored prompt. */
  renameSession(tabId: string): void;

  /** Always the `prompt` frame; `route` picks omp's `streamingBehavior` for a busy agent. */
  sendPrompt(
    tabId: string,
    message: string,
    route?: PromptRoute,
    images?: ImageAttachment[],
  ): Promise<void>;
  abortAgent(tabId: string): Promise<void>;
  abortAndPrompt(tabId: string, message: string, images?: ImageAttachment[]): Promise<void>;

  /**
   * omp's own advisor defaults for a project, cached per cwd. Read from omp's
   * config because the rpc protocol reports no advisor state at all.
   */
  loadAdvisorDefaults(projectCwd: string): Promise<void>;
  /**
   * Re-pins this session's advisor. Relaunches a live session — omp binds both
   * `advisor.enabled` and the `advisor` role at process start.
   */
  setSessionAdvisor(tabId: string, advisor: boolean, advisorModel: string | null): Promise<void>;
  /**
   * Explicitly pins a session's advisor model (or null to return to omp's
   * configured advisor). A deliberate choice, so it is also remembered per
   * project for future new sessions — null clears that memory.
   */
  setAdvisorModel(tabId: string, selector: string | null): Promise<void>;

  setModel(tabId: string, model: ModelInfo): Promise<void>;
  setThinkingLevel(tabId: string, level: string): Promise<void>;
  cycleThinkingLevel(tabId: string): Promise<void>;

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
  newRpcSession(tabId: string): Promise<void>;

  /**
   * Turns plan mode on or off for this tab. Drives the generated extension's
   * slash command rather than an rpc command — omp's rpc protocol has no plan
   * surface at all (see core/plan-extension.ts).
   */
  setPlanMode(tabId: string, enabled: boolean): Promise<void>;
  /**
   * Accepts a pending plan review and executes it. The agent is blocked until
   * this replies, so it must be answered on every exit from the review pane.
   * `context` picks where implementation runs: the same session (`existing`),
   * the same session after compacting its context (`compacted`), or a freshly
   * spawned session seeded with the plan (`fresh`). `addressAdvisor` (default
   * true) holds dispatch for the drafting turn's advisor review (which lands
   * only after the execute verdict lets the turn end) and folds any concerns
   * into the implementation prompt.
   */
  executePlan(tabId: string, context: PlanExecutionContext, addressAdvisor?: boolean): void;
  /**
   * Refuses a plan review, sending the agent back to revise the draft.
   * `notes` (optional text + images) are delivered to the planner as revision
   * instructions; with none this is a plain, no-notes refinement. The revision
   * stays immediate — the planner revises in this same session, where the
   * advisor's injected notes are already visible.
   */
  refinePlan(tabId: string, notes?: PlanRevisionNotes): void;
  /** Loads the plan markdown for the review pane. */
  loadPlanText(tabId: string, absPath: string | null): Promise<void>;
  /**
   * Dismisses the plan review WITHOUT answering the gate: the agent stays
   * paused on its proposal and the plan stays pending in the rail's plans tab,
   * re-opened later via showPlanReview. Unlike refine, this never revises.
   */
  deferPlanReview(tabId: string): void;
  /** Re-opens the review pane for tabId's pending plan (clears deferral). */
  showPlanReview(tabId: string): void;

  /**
   * `line` may include args, e.g. "/advisor on". Leading "/" optional.
   * A bare "/new" is omp-ui's own new-session shortcut: it spawns a new live
   * session tab in the tab's project and never reaches omp.
   */
  runSlashCommand(tabId: string, line: string): Promise<void>;
  setTodos(tabId: string, phases: TodoPhase[]): Promise<void>;
  refreshState(tabId: string): Promise<void>;
  refreshStats(tabId: string): Promise<void>;
  refreshAdvisorStats(tabId: string): Promise<void>;
  refreshSubagents(tabId: string): Promise<void>;
  /** Clears the drawer's dead-shell overlay while a replacement spawns. */
  clearShellExited(tabId: string): void;
  /** Toggles the composer's console drawer for a tab (issue #33). */
  toggleConsole(tabId: string): void;
  /** (Re)reads the project's branch listing; on failure keeps the last known. */
  refreshBranches(projectCwd: string): Promise<void>;
  /**
   * Switches the project's git branch (issue #35). Returns null on success, or
   * git's error message to show in the menu.
   */
  checkoutGitBranch(
    projectCwd: string,
    name: string,
    opts?: { create?: boolean },
  ): Promise<string | null>;
  /** Best-effort model suggestion for the execute modal's new-branch prefill. */
  suggestBranchName(projectCwd: string, planContext: string): Promise<string | null>;
}

// One IPC data listener total; each TerminalTab registers its writer here.
const termWriters = new Map<string, (data: Uint8Array) => void>();
export function registerTermWriter(tabId: string, cb: (data: Uint8Array) => void): () => void {
  termWriters.set(tabId, cb);
  return () => {
    termWriters.delete(tabId);
  };
}

// One IPC data listener total; each ShellDrawer registers its writer here.
const shellWriters = new Map<string, (data: Uint8Array) => void>();
export function registerShellWriter(tabId: string, cb: (data: Uint8Array) => void): () => void {
  shellWriters.set(tabId, cb);
  return () => {
    shellWriters.delete(tabId);
  };
}

export function findRecord(
  state: BackendState | null,
  tabId: string,
): SessionSummary | undefined {
  for (const group of state?.projects ?? []) {
    const hit = group.sessions.find((s) => s.tabId === tabId);
    if (hit) return hit;
  }
  return undefined;
}

function dropExited(exited: Record<string, number>, tabId: string): Record<string, number> {
  const next = { ...exited };
  delete next[tabId];
  return next;
}

function alertError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
}

/**
 * Remote-settings writes restart the server, which drops the socket a REMOTE client is asking
 * over — so that client's own call never gets its reply. That is the requested outcome, not a
 * failure: swallow it and let the reconnect banner take over (it reloads once the server answers
 * on the new address). Every other rejection still alerts, and the desktop client — which is not
 * on the socket — never takes this branch.
 */
function alertRemoteError(err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  if (message === "remote connection lost") return;
  window.alert(message);
}

// StrictMode double-invokes effects in dev, and the preload listener API has
// no unsubscribe — init must be idempotent or every listener registers twice.
let initialized = false;

/** A new rpc process emits exactly one ready frame — that's the boot signal. */
const rpcBooting = new Set<string>();

/**
 * Minimum gap between mid-run get_state/get_session_stats refreshes, keyed by
 * tab. Context and spend only grow at turn boundaries, and an agent run fires
 * several per-turn message_ends in quick succession — throttle to one
 * authoritative snapshot per boundary window instead of one rpc call per frame.
 */
const USAGE_REFRESH_MS = 500;
const lastUsageRefresh = new Map<string, number>();

/** The implementation prompt sent to whichever context executes an approved plan. */
const EXECUTION_PROMPT =
  "The plan review is complete — execute the approved plan now. It is set as this " +
  "session's reference.";

/** Polls `rpc[tabId]` until `pred` holds (or the bounded deadline passes). */
function pollUntil(
  tabId: string,
  pred: (tab: RpcTabState | undefined) => boolean,
  timeoutMs = 15_000,
): Promise<void> {
  const read = (): RpcTabState | undefined => useStore.getState().rpc[tabId];
  if (pred(read())) return Promise.resolve();
  // A subscription — not a timer loop — so readiness resolves the moment state
  // changes, with no wall-clock sampling. (new Promise, not withResolvers: the
  // web lib here is ES2022 and the rest of the file builds resolvers this way.)
  return new Promise<void>((resolve) => {
    const timer = window.setTimeout(() => {
      unsubscribe();
      resolve();
    }, timeoutMs);
    const unsubscribe = useStore.subscribe(() => {
      if (pred(read())) {
        window.clearTimeout(timer);
        unsubscribe();
        resolve();
      }
    });
  });
}

/**
 * Records a freshly proposed plan in the session's history. Keyed by the plan
 * artifact path: a refined-and-reproposed plan updates its one pending entry
 * instead of stacking lookalike rows.
 */
function upsertPlan(records: PlanRecord[], title: string, key: string): PlanRecord[] {
  const idx = records.findIndex((r) => r.key === key);
  if (idx === -1) return [{ key, title, status: "pending" }, ...records];
  const current = records[idx]!;
  if (current.status === "pending" && current.title === title) return records;
  return [
    ...records.slice(0, idx),
    { ...current, title, status: "pending" },
    ...records.slice(idx + 1),
  ];
}

/** Settles a proposed plan's record (keeps its position in the history). */
function settlePlan(records: PlanRecord[], key: string, status: PlanRecord["status"]): PlanRecord[] {
  return records.map((r) => (r.key === key ? { ...r, status } : r));
}

/** setStatus/setWidget/setTitle carry their text under different keys. */
function extensionStatusEntry(frame: object): { key: string; text: string | undefined } | null {
  const method = strField(frame, "method");
  const id = strField(frame, "id") ?? "";
  if (method === "setWidget") {
    const lines = arrField(frame, "widgetLines").filter((l): l is string => typeof l === "string");
    return {
      key: strField(frame, "widgetKey") ?? id,
      // `widgetLines: undefined` is the protocol's "clear this widget".
      text: field(frame, "widgetLines") === undefined ? undefined : lines.join("\n"),
    };
  }
  if (method === "setStatus") {
    return { key: strField(frame, "statusKey") ?? id, text: strField(frame, "statusText") };
  }
  if (method === "setTitle") {
    return { key: strField(frame, "widgetKey") ?? id, text: strField(frame, "title") };
  }
  return null;
}

export const useStore = create<UiStore>()((set, get) => {
  const patchRpc = (tabId: string, patch: Partial<RpcTabState>): void => {
    set((s) => {
      const tab = s.rpc[tabId];
      if (!tab) return s;
      return { rpc: { ...s.rpc, [tabId]: { ...tab, ...patch } } };
    });
  };

  const prepareRpcRelaunch = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    patchRpc(tabId, {
      status: "starting",
      session: { ...tab.session, isStreaming: false },
      extensionQueue: [],
      planReview: null,
      planText: null,
      planDeferred: false,
      error: undefined,
    });
  };

  // Command responses nest their payload under `data`.
  const respData = (resp: unknown): unknown =>
    resp !== null &&
    typeof resp === "object" &&
    "data" in resp &&
    resp.data !== null &&
    typeof resp.data === "object"
      ? resp.data
      : resp;

  /**
   * Every store method routes failures here: the tab keeps its status (a
   * rejected `set_model` must not wedge a live session into "error") but the
   * message surfaces instead of vanishing into a swallowed catch. Resolves to
   * the response frame, or `null` — which a real response never is — on failure.
   */
  const runCommand = async (
    tabId: string,
    cmd: Record<string, unknown>,
    opts?: { quiet?: boolean },
  ): Promise<unknown> => {
    try {
      const resp = await get().rpcCommand(tabId, cmd, opts);
      // A later success retires a transient failure banner, but never a fatal
      // one — `status: "error"` means the process itself is gone.
      const tab = get().rpc[tabId];
      if (tab?.error !== undefined && tab.status !== "error") patchRpc(tabId, { error: undefined });
      return resp;
    } catch (err) {
      patchRpc(tabId, { error: err instanceof Error ? err.message : String(err) });
      return null;
    }
  };

  const appendItem = (tabId: string, item: RenderItem): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    patchRpc(tabId, { items: [...tab.items, item] });
  };

  const patchSession = (tabId: string, patch: Partial<SessionRuntime>): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    patchRpc(tabId, { session: { ...tab.session, ...patch } });
  };

  /**
   * Answers the blocked plan-review `select` and clears the pane. Returns
   * false when there is no pending review to answer, so callers skip dispatch.
   */
  const answerPlanSelect = (tabId: string, value: string): boolean => {
    const tab = get().rpc[tabId];
    if (!tab?.planReview) return false;
    const request = tab.planReview.frame;
    const id =
      request !== null && typeof request === "object" && "id" in request
        ? request.id
        : undefined;
    // omp's agent is blocked on this reply — clear the pane only after sending.
    backend.rpcSend(tabId, {
      type: "extension_ui_response",
      id,
      value,
    });
    patchRpc(tabId, { planReview: null, planText: null, planDeferred: false });
    return true;
  };

  /** Sends the implementation prompt for a settled execute verdict. */
  const dispatchExecutePlan = (
    tabId: string,
    context: PlanExecutionContext,
    planText: string | null,
    concerns: string | null,
  ): void => {
    if (context === "fresh") {
      void spawnFreshImplementation(tabId, planText, concerns);
      return;
    }
    if (context === "compacted") {
      // `compact` runs between turns, so the just-accepted plan turn must end
      // (it has by now) before compacting, then prompt the implementer.
      void (async () => {
        await pollUntil(tabId, (t) => (t?.status ?? "ready") !== "running");
        await get().compactSession(tabId);
        await get().sendPrompt(tabId, withConcerns(EXECUTION_PROMPT, concerns), "prompt");
      })();
      return;
    }
    // Existing context: followUp queues the prompt until the current turn
    // ends, so it races nothing — the implementer runs in this same session.
    void get().sendPrompt(tabId, withConcerns(EXECUTION_PROMPT, concerns), "follow_up");
  };

  /**
   * Holds an approve verdict's dispatch for the drafting turn's advisor
   * review. This is the store's whole concern-wait surface: the watcher owns
   * the per-tab timers and the single-source settle/fold, and the store just
   * begins, feeds frames, and cancels on teardown. See lib/plan-concerns.ts
   * for the timing and the card/tool-note dedup.
   */
  const concernWatcher = new PlanConcernWatcher({
    getItems: (tabId) => get().rpc[tabId]?.items ?? [],
    onNotice: (tabId, text) => appendItem(tabId, noticeItem(text, "info")),
    onDispatch: (tabId, intent, concerns) =>
      dispatchExecutePlan(tabId, intent.context, intent.planText, concerns),
  });

  const eraseSession = async (tabId: string): Promise<void> => {
    try {
      await backend.deleteSession(tabId);
    } catch (err) {
      alertError(err);
      return;
    }
    const tab = get().rpc[tabId];
    // A dangling concern-wait timer must not fire into the dead tab's slot.
    concernWatcher.cancel(tabId);
    if (tab) {
      for (const pending of tab.pendingCommands.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error("session deleted"));
      }
    }
    set((s) => {
      const rpc = { ...s.rpc };
      delete rpc[tabId];
      const tabs = s.tabs.filter((t) => t.tabId !== tabId);
      const activeTabId =
        s.activeTabId === tabId
          ? (tabs.filter((t) => !t.hidden).at(-1)?.tabId ?? null)
          : s.activeTabId;
      return { rpc, tabs, activeTabId, exited: dropExited(s.exited, tabId) };
    });
  };

  /**
   * Spawns a fresh rpc-ui session in the plan's project, seeds it with the
   * plan text as its first prompt, and surfaces it as the active tab.
   */
  const spawnFreshImplementation = async (
    srcTabId: string,
    planText: string | null,
    concerns: string | null = null,
  ): Promise<void> => {
    const rec = findRecord(get().state, srcTabId);
    if (!rec) return;
    const projectCwd = rec.projectCwd;
    // A fresh implementation session inherits the complete last-used advisor
    // tuple for this project, falling back to omp only before the first choice.
    await get().loadAdvisorDefaults(projectCwd);
    const defaults = get().advisorDefaults[projectCwd];
    const project = get().state?.projects.find((g) => g.project.path === projectCwd)?.project;
    const lastAdvisorModel = project?.lastAdvisorModel ?? defaults?.model ?? null;
    const advisor = project?.lastAdvisor ?? defaults?.enabled ?? false;
    let freshId: string;
    try {
      ({ tabId: freshId } = await backend.spawnSession({
        projectCwd,
        mode: "rpc-ui",
        advisor,
        advisorModel: lastAdvisorModel,
        cols: 80,
        rows: 24,
      }));
    } catch (err) {
      alertError(err);
      return;
    }
    set((s) => ({
      tabs: [...s.tabs, { tabId: freshId, mode: "rpc-ui", projectCwd, hidden: false }],
      activeTabId: freshId,
      exited: dropExited(s.exited, freshId),
    }));
    appendItem(
      srcTabId,
      noticeItem("plan approved — implementation dispatched to a fresh session", "info"),
    );
    await pollUntil(freshId, (t) => t?.status === "ready");
    const lead = "A plan was approved for this project. Implement it now.";
    const seed = planText ? `${lead}\n\n${planText}\n\nProceed with the implementation.` : lead;
    await get().sendPrompt(freshId, withConcerns(seed, concerns), "prompt");
  };

  const applyRpcState = (tabId: string, resp: unknown): void => {
    const tab = get().rpc[tabId];
    const payload = respData(resp);
    if (!tab || payload === null || typeof payload !== "object") return;
    const model = parseModelInfo(field(payload, "model")) ?? tab.model;
    const session = parseSessionRuntime(payload, tab.session);
    patchRpc(tabId, {
      todos: "todoPhases" in payload ? parseTodoPhases(field(payload, "todoPhases")) : tab.todos,
      model,
      session,
    });
    if (model) {
      void backend
        .setSessionModel(tabId, `${model.provider}/${model.id}`, session.thinkingLevel)
        .catch(() => {});
    }
  };

  /**
   * Live usage tick: context meter AND spend. Fired on each per-turn
   * `message_end` while the agent is mid-run, so the HUD tracks the growing
   * context and cost instead of only snapping to the final values at
   * `agent_end`. Same get_state/get_session_stats sources as the closing
   * refresh — just throttled so a burst of turn boundaries costs one snapshot,
   * not one per frame. get_session_stats is a synchronous message fold in omp,
   * so the extra call is as cheap as get_state.
   */
  const refreshLiveUsage = (tabId: string): void => {
    const now = Date.now();
    if (now - (lastUsageRefresh.get(tabId) ?? -Infinity) < USAGE_REFRESH_MS) return;
    lastUsageRefresh.set(tabId, now);
    void get()
      .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
      .then((resp) => applyRpcState(tabId, resp))
      .catch(() => {});
    void get()
      .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
      .then((resp) => patchRpc(tabId, { stats: parseSessionStats(respData(resp)) }))
      .catch(() => {});
  };

  const loadHistory = async (tabId: string): Promise<void> => {
    const resp = await get().rpcCommand(tabId, { type: "get_messages" });
    patchRpc(tabId, { items: historyToItems(arrField(respData(resp), "messages")) });
  };

  /**
   * Repaints the document to match the registry's persisted themeId. The
   * registry stays authoritative; lib/themes.ts keeps only a localStorage
   * mirror so the first frame paints before this runs. The id guard is what
   * stops a redundant broadcast from re-writing ~28 custom properties on
   * every state change.
   */
  const syncTheme = (s: BackendState): void => {
    const t = resolveTheme(s.themeId);
    if (t.id !== currentThemeId()) applyTheme(t);
  };

  return {
    state: null,
    tabs: [],
    activeTabId: null,
    exited: {},
    shellExited: {},
    rpc: {},
    consoleOpen: {},
    branches: {},
    advisorDefaults: {},
    deleteConfirmation: null,
    projectPickerOpen: false,
    mcpManager: null,
    settingsPage: null,
    appUpdate: {
      status: "idle",
      currentVersion: null,
      latestVersion: null,
      releaseUrl: null,
      releaseName: null,
      format: "unknown",
      progress: null,
      downloadedPath: null,
      error: null,
    },
    ompUpdate: {
      status: "idle",
      installPath: null,
      installedVersion: null,
      latestVersion: null,
      progress: null,
      error: null,
    },
    remote: {
      status: "stopped",
      enabled: false,
      bind: "localhost",
      port: 4677,
      token: "",
      urls: [],
      webBundleMissing: false,
      error: null,
    },

    async init() {
      if (initialized) return;
      initialized = true;
      backend.onStateChanged((state) => {
        set((s) => ({
          state,
          // Record mode is authoritative — tabs follow it (e.g. after switchMode).
          tabs: s.tabs.map((t) => {
            const rec = findRecord(state, t.tabId);
            return rec && rec.mode !== t.mode ? { ...t, mode: rec.mode } : t;
          }),
        }));
        syncTheme(state);
      });
      backend.onPtyData((tabId, data) => termWriters.get(tabId)?.(data));
      backend.onPtyExit((tabId, code) => {
        set((s) => ({ exited: { ...s.exited, [tabId]: code } }));
      });
      backend.onShellData((tabId, data) => shellWriters.get(tabId)?.(data));
      backend.onShellExit((tabId, code) => {
        set((s) => ({ shellExited: { ...s.shellExited, [tabId]: code } }));
      });
      backend.onRpcFrame((tabId, frame) => get().handleRpcFrame(tabId, frame));
      backend.onAppUpdateState((appUpdate) => set({ appUpdate }));
      backend.onOmpUpdateState((ompUpdate) => set({ ompUpdate }));
      backend.onRemoteState((remote) => set({ remote }));
      set({
        state: await backend.getState(),
        appUpdate: await backend.getAppUpdateState(),
        ompUpdate: await backend.getOmpUpdateState(),
        remote: await backend.getRemoteState(),
      });
      const booted = get().state;
      if (booted) syncTheme(booted);
    },

    openProjectPicker() {
      set({ projectPickerOpen: true });
    },

    closeProjectPicker() {
      set({ projectPickerOpen: false });
    },

    openMcpManager(tabId, projectCwd) {
      set({ mcpManager: { tabId, projectCwd } });
    },

    closeMcpManager() {
      set({ mcpManager: null });
    },

    openSettings(page) {
      set({ settingsPage: page ?? "general" });
    },

    closeSettings() {
      set({ settingsPage: null });
    },

    async setDefaultMode(mode) {
      try {
        await backend.setDefaultMode(mode);
      } catch (err) {
        alertError(err);
      }
    },

    async setSkipDeleteConfirmation(skip) {
      try {
        await backend.setSkipDeleteConfirmation(skip);
      } catch (err) {
        alertError(err);
      }
    },

    async setThemeId(id) {
      // Apply-then-persist is the one exception to the store's push-only rule:
      // a theme switch must feel instant. The broadcast that follows carries
      // the same id, so syncTheme becomes a no-op; if the write fails the user
      // sees the alert and the next launch reverts to the persisted theme.
      applyTheme(resolveTheme(id));
      try {
        await backend.setThemeId(id);
      } catch (err) {
        alertError(err);
      }
    },

    async setAppUpdateCheckOnLaunch(on) {
      try {
        await backend.setAppUpdateCheckOnLaunch(on);
      } catch (err) {
        alertError(err);
      }
    },

    async setOmpUpdateCheckOnLaunch(on) {
      try {
        await backend.setOmpUpdateCheckOnLaunch(on);
      } catch (err) {
        alertError(err);
      }
    },

    async clearDismissedAppUpdate() {
      try {
        await backend.clearDismissedAppUpdate();
      } catch (err) {
        alertError(err);
      }
    },

    async clearDismissedOmpUpdate() {
      try {
        await backend.clearDismissedOmpUpdate();
      } catch (err) {
        alertError(err);
      }
    },

    async setRemoteEnabled(on) {
      try {
        await backend.setRemoteEnabled(on);
      } catch (err) {
        alertRemoteError(err);
      }
    },

    async setRemoteBind(bind) {
      try {
        await backend.setRemoteBind(bind);
      } catch (err) {
        alertRemoteError(err);
      }
    },

    async setRemotePort(port) {
      try {
        await backend.setRemotePort(port);
      } catch (err) {
        alertRemoteError(err);
      }
    },

    async regenerateRemoteToken() {
      try {
        await backend.regenerateRemoteToken();
      } catch (err) {
        alertRemoteError(err);
      }
    },

    // No try/catch on purpose: the settings omp page renders its own inline
    // error, so these two rethrow instead of routing through alertError.
    readOmpSettings(projectCwd) {
      return backend.readOmpSettings(projectCwd);
    },

    writeOmpSetting(key, value) {
      return backend.writeOmpSetting(key, value);
    },

    // Same deal: the providers page renders its own inline error.
    readProviderKeys(projectCwd) {
      return backend.readProviderKeys(projectCwd);
    },

    setProviderKey(envName, value) {
      return backend.setProviderKey(envName, value);
    },

    clearProviderKey(envName) {
      return backend.clearProviderKey(envName);
    },

    async restartSession(tabId) {
      const rec = findRecord(get().state, tabId);
      try {
        if (rec?.live === "live" && rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
        await backend.restartSession(tabId);
        return true;
      } catch (err) {
        alertError(err);
        return false;
      }
    },

    async addProject(path) {
      await backend.addProject(path);
      set({ projectPickerOpen: false });
    },

    async removeProject(path) {
      if (
        !window.confirm(`Remove project ${path} and its session records? Files on disk are kept.`)
      )
        return;
      try {
        await backend.removeProject(path);
      } catch (err) {
        alertError(err);
      }
    },

    async toggleFavorite(key) {
      await backend.toggleFavorite(key);
    },

    async checkOmpUpdate() {
      await backend.checkOmpUpdate();
    },

    async downloadOmpUpdate() {
      await backend.downloadOmpUpdate();
    },

    async dismissOmpUpdate(version, remember) {
      await backend.dismissOmpUpdate(version, remember);
    },

    async checkAppUpdate() {
      await backend.checkAppUpdate();
    },

    async downloadAppUpdate() {
      await backend.downloadAppUpdate();
    },

    async openAppUpdateReleaseNotes() {
      await backend.openAppUpdateReleaseNotes();
    },

    async showAppUpdateDownload() {
      await backend.showAppUpdateDownload();
    },

    async restartForAppUpdate() {
      await backend.restartForAppUpdate();
    },

    async dismissAppUpdate(version, remember) {
      await backend.dismissAppUpdate(version, remember);
    },

    async newSession(projectCwd, modeOverride) {
      const mode = modeOverride ?? get().state?.defaultMode ?? "pty";
      // Carry the project's complete last-used advisor tuple into the new
      // session. Before any explicit choice, omp's configured default wins.
      await get().loadAdvisorDefaults(projectCwd);
      const defaults = get().advisorDefaults[projectCwd];
      const project = get().state?.projects.find((g) => g.project.path === projectCwd)?.project;
      const lastAdvisorModel = project?.lastAdvisorModel ?? defaults?.model ?? null;
      const advisor = project?.lastAdvisor ?? defaults?.enabled ?? false;
      try {
        const { tabId } = await backend.spawnSession({
          projectCwd,
          mode,
          advisor,
          advisorModel: lastAdvisorModel,
          cols: 80,
          rows: 24,
        });
        set((s) => ({
          tabs: [...s.tabs, { tabId, mode, projectCwd, hidden: false }],
          activeTabId: tabId,
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    async openSession(tabId) {
      const existing = get().tabs.find((t) => t.tabId === tabId);
      if (existing) {
        // Live session → resurface its tab, never respawn (omp has no
        // cross-process session lock; two writers would corrupt the .jsonl).
        set((s) => ({
          tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: false } : t)),
          activeTabId: tabId,
        }));
        return;
      }
      const rec = findRecord(get().state, tabId);
      if (!rec) return;
      try {
        await backend.spawnSession({
          projectCwd: rec.projectCwd,
          mode: rec.mode,
          advisor: rec.advisor,
          cols: 80,
          rows: 24,
          resumeTabId: tabId,
        });
        set((s) => ({
          tabs: [...s.tabs, { tabId, mode: rec.mode, projectCwd: rec.projectCwd, hidden: false }],
          activeTabId: tabId,
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    focusTab(tabId) {
      set((s) => ({
        tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: false } : t)),
        activeTabId: tabId,
      }));
    },

    hideTab(tabId) {
      set((s) => {
        const tabs = s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: true } : t));
        let activeTabId = s.activeTabId;
        if (activeTabId === tabId) {
          const visible = tabs.filter((t) => !t.hidden);
          activeTabId = visible.length > 0 ? visible[visible.length - 1]!.tabId : null;
        }
        return { tabs, activeTabId };
      });
    },

    async terminate(tabId) {
      if (!window.confirm("Terminate the running agent? The session stays resumable.")) return;
      await backend.terminateSession(tabId);
    },

    async switchMode(tabId, mode) {
      const rec = findRecord(get().state, tabId);
      if (rec?.live === "live") {
        const other = mode === "pty" ? "terminal" : "native";
        if (
          !window.confirm(
            `Restart this session in ${other} mode? The process is killed and resumed.`,
          )
        )
          return;
      }
      try {
        if (
          rec?.live === "live" &&
          rec.mode !== mode &&
          (rec.mode === "rpc-ui" || mode === "rpc-ui")
        ) {
          prepareRpcRelaunch(tabId);
        }
        await backend.switchMode(tabId, mode);
      } catch (err) {
        alertError(err);
      }
    },

    async resumeDead(tabId) {
      const rec = findRecord(get().state, tabId);
      if (!rec) return;
      try {
        if (rec.mode === "rpc-ui") prepareRpcRelaunch(tabId);
        await backend.spawnSession({
          projectCwd: rec.projectCwd,
          mode: rec.mode,
          advisor: rec.advisor,
          cols: 80,
          rows: 24,
          resumeTabId: tabId,
        });
        set((s) => ({
          tabs: s.tabs.map((t) => (t.tabId === tabId ? { ...t, hidden: false } : t)),
          activeTabId: tabId,
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    async deleteSession(tabId) {
      const rec = findRecord(get().state, tabId);
      if (!rec) return;
      if (get().state?.skipDeleteConfirmation === true) {
        await eraseSession(tabId);
        return;
      }
      set({
        deleteConfirmation: {
          tabId,
          title: rec.title,
          running: rec.live === "live",
          hasFiles: rec.live !== "missing",
        },
      });
    },

    async confirmDeleteSession(skipFuture) {
      const pending = get().deleteConfirmation;
      if (!pending) return;
      set({ deleteConfirmation: null });
      if (skipFuture) {
        try {
          await backend.setSkipDeleteConfirmation(true);
        } catch (err) {
          alertError(err);
        }
      }
      await eraseSession(pending.tabId);
    },

    cancelDeleteSession() {
      set({ deleteConfirmation: null });
    },

    async bootRpcTab(tabId) {
      if (rpcBooting.has(tabId)) return;
      rpcBooting.add(tabId);
      try {
        // A pending concern handoff belongs to the session that just went away.
        concernWatcher.cancel(tabId);
        patchRpc(tabId, freshRpcTabState());
        // The tab may not exist in state yet — ensure the slot exists.
        if (!get().rpc[tabId]) {
          set((s) => ({ rpc: { ...s.rpc, [tabId]: freshRpcTabState() } }));
        }
        // Boot can outrun init()'s first getState — the record decides whether
        // history (get_messages) is fetched, so don't read it from thin air.
        if (!get().state) set({ state: await backend.getState() });
        const rec = findRecord(get().state, tabId);
        // get_state is the canary: if it fails, the tab is dead, not "ready".
        const stateFailure = await get()
          .rpcCommand(tabId, { type: "get_state" })
          .then(
            (resp) => {
              applyRpcState(tabId, resp);
              return null;
            },
            (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
          );
        // allSettled, not all: a missing subagent bus or a slow stats read must
        // never leave the tab stuck in "starting".
        const boots: Promise<unknown>[] = [
          get()
            .rpcCommand(tabId, { type: "get_available_models" })
            .then((resp) => {
              patchRpc(tabId, { availableModels: parseModelList(respData(resp)) });
            }),
          get()
            .rpcCommand(tabId, { type: "get_available_commands" })
            .then((resp) => {
              patchRpc(tabId, { commands: parseCommandList(respData(resp)) });
            }),
          get()
            .rpcCommand(tabId, { type: "get_session_stats" })
            .then((resp) => {
              patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
            }),
          // "progress" | "events" are the only legal levels; progress is the
          // cheap one — per-agent status, not every subagent token.
          get().rpcCommand(tabId, { type: "set_subagent_subscription", level: "progress" }),
        ];
        if (rec?.sessionId) boots.push(loadHistory(tabId));
        await Promise.allSettled(boots);
        // Arm the advisor-stats extension (its first slash run sets its `ui`
        // channel, after which it auto-publishes at each turn end). Armed for
        // every session, not just advisor-on ones: the extension is always loaded,
        // this one shot is cheap and idempotent, and it publishes `available:false`
        // for an advisor-off session that the HUD simply hides. Gating on the
        // record flag would let a stale `advisor` (race with the broadcast after the
        // advisor-toggle relaunch) skip the arm and starve the readout forever.
        void get().refreshAdvisorStats(tabId);
        if (stateFailure) {
          patchRpc(tabId, { status: "error", error: `get_state failed: ${stateFailure.message}` });
        } else {
          patchRpc(tabId, { status: "ready" });
        }
      } catch (err) {
        patchRpc(tabId, {
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        rpcBooting.delete(tabId);
      }
    },

    rpcCommand(tabId, cmd, opts) {
      const tab = get().rpc[tabId];
      if (!tab) return Promise.reject(new Error("rpc tab not initialized"));
      const id = randomId();
      // Quiet commands are background sync (usage ticks, subagent roster
      // heartbeats). They never touch `busy`: each round-trip would otherwise
      // strobe the progress sweeps for a few ms, jittering the transcript.
      const quiet = opts?.quiet ?? false;
      // Executor form required: the pending entry must exist before send.
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          get().rpc[tabId]?.pendingCommands.delete(id);
          reject(new Error("rpc command timed out"));
        }, 30_000);
        tab.pendingCommands.set(id, { resolve, reject, timer, quiet });
      });
      if (!quiet) patchRpc(tabId, { busy: true });
      backend.rpcSend(tabId, { ...cmd, id });
      // The map is the ref count: both settle paths remove their entry before
      // settling, so concurrent commands can't clear `busy` for each other.
      // Only loud entries count — a lingering quiet heartbeat must not pin
      // `busy`, and a settling quiet one must not clear it early either way.
      return promise.finally(() => {
        const pending = get().rpc[tabId]?.pendingCommands;
        let loud = 0;
        if (pending) for (const p of pending.values()) if (!p.quiet) loud++;
        if (loud === 0 && get().rpc[tabId]?.busy) {
          patchRpc(tabId, { busy: false });
        }
      });
    },

    handleRpcFrame(tabId, frame) {
      const tab = get().rpc[tabId];
      if (!tab || frame === null || typeof frame !== "object") return;
      const type = "type" in frame ? frame.type : undefined;
      switch (type) {
        case "response": {
          const id = "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const pending = id ? tab.pendingCommands.get(id) : undefined;
          if (!pending) return;
          clearTimeout(pending.timer);
          tab.pendingCommands.delete(id!);
          if ("success" in frame && frame.success === false) {
            const message =
              "error" in frame && typeof frame.error === "string" ? frame.error : "command failed";
            pending.reject(new Error(message));
          } else {
            pending.resolve(frame);
          }
          return;
        }
        case "ready":
          // A fresh process — (re)boot this tab's state.
          void get().bootRpcTab(tabId);
          return;
        case "rpc_chunk":
          return; // reassembled in main — never expected here
        case "session_info_update":
          patchRpc(tabId, { session: parseSessionRuntime(frame, tab.session) });
          return;
        case "config_update": {
          const model = parseModelInfo(field(frame, "model")) ?? tab.model;
          const session = parseSessionRuntime(frame, tab.session);
          patchRpc(tabId, { model, session });
          if (model) {
            void backend
              .setSessionModel(tabId, `${model.provider}/${model.id}`, session.thinkingLevel)
              .catch(() => {});
          }
          return;
        }
        case "available_commands_update":
          patchRpc(tabId, { commands: parseCommandList(frame) });
          return;
        case "subagent_lifecycle":
        case "subagent_progress":
        case "subagent_event": {
          const payload = field(frame, "payload");
          const progress = field(payload, "progress");
          const name =
            strField(payload, "agent") ??
            strField(progress, "agent") ??
            strField(payload, "id") ??
            "subagent";
          const status = strField(payload, "status") ?? strField(progress, "status");
          const label = status ? `subagent ${name}: ${status}` : `subagent ${name}`;
          // Progress frames repeat every heartbeat — collapse an identical
          // consecutive label instead of stamping the transcript each time.
          const last = tab.items.at(-1);
          if (!(last?.kind === "marker" && last.label === label)) {
            appendItem(tabId, markerItem(label, "copper"));
          }
          void get().refreshSubagents(tabId);
          return;
        }
        case "extension_error": {
          const text = strField(frame, "error") ?? "extension error";
          appendItem(tabId, {
            ...noticeItem(text, "error"),
            source: strField(frame, "extensionPath"),
          });
          return;
        }
        case "command_output":
          // Slash-command replies had a pane in the console drawer until
          // issue #43 made the drawer a full-width shell; dropped on purpose.
          return;
        case "extension_ui_request": {
          // Plan mode rides the extension channel, so it is claimed before the
          // generic routing: the review dialog must reach the plan pane rather
          // than the raw select dialog, and the status frame is state, not text.
          const review = parsePlanReviewTitle(strField(frame, "title"));
          if (review) {
            patchRpc(tabId, {
              planReview: { request: review, frame },
              // A fresh proposal is never deferred — it demands its verdict.
              planDeferred: false,
              plans: upsertPlan(tab.plans, review.title, review.planFilePath),
            });
            void get().loadPlanText(tabId, review.planAbsPath);
            return;
          }
          const entry = extensionStatusEntry(frame);
          if (entry?.key === PLAN_STATUS_KEY) {
            patchRpc(tabId, { plan: parsePlanStatus(entry.text) });
            return;
          }
          if (entry?.key === ADVISOR_STATS_KEY) {
            patchRpc(tabId, { advisorStats: parseAdvisorStats(entry.text) });
            return;
          }
          const action = routeExtensionRequest(frame);
          if (action.action === "dialog") {
            patchRpc(tabId, { extensionQueue: [...tab.extensionQueue, frame] });
            return;
          }
          // Every non-dialog method is answered immediately — omp blocks on the
          // reply — but status/widget/title text is recorded first, because it
          // is the extension's actual output, not an interaction to decline.
          if (entry) {
            const extensionStatus = { ...tab.extensionStatus };
            if (entry.text === undefined || entry.text === "") delete extensionStatus[entry.key];
            else extensionStatus[entry.key] = entry.text;
            patchRpc(tabId, { extensionStatus });
          }
          backend.rpcSend(tabId, extensionCancelResponse("id" in frame ? frame.id : undefined));
          if (!entry) {
            const method = strField(frame, "method") ?? "?";
            appendItem(tabId, markerItem(`extension ${method} auto-cancelled`));
          }
          return;
        }
        case "prompt_result":
          patchRpc(tabId, { status: "ready" });
          return;
        case "omp_ui_error": {
          const message = strField(frame, "message") ?? "omp rpc error";
          patchRpc(tabId, { status: "error", error: message });
          return;
        }
        case "host_tool_call":
          // No host tools are registered — answer with an error, never hang the agent.
          backend.rpcSend(tabId, {
            type: "host_tool_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui does not register host tools",
          });
          return;
        case "host_uri_request":
          // Same discipline: omp awaits a result for every uri request.
          backend.rpcSend(tabId, {
            type: "host_uri_result",
            id: "id" in frame ? frame.id : undefined,
            error: "omp-ui registers no uri schemes",
          });
          return;
        default: {
          // The AgentSessionEvent stream — the actual transcript.
          const nextItems = reduceEvent(tab.items, frame);
          patchRpc(tabId, { items: nextItems });
          // A pending plan-concerns wait settles the moment a fresh advisor
          // finding lands after the verdict (or its bounded deadline fires).
          concernWatcher.feed(tabId);
          if (type === "thinking_level_changed") {
            const level = strField(frame, "thinkingLevel");
            if (level) {
              patchSession(tabId, { thinkingLevel: level });
              const model = get().rpc[tabId]?.model;
              if (model) {
                void backend
                  .setSessionModel(tabId, `${model.provider}/${model.id}`, level)
                  .catch(() => {});
              }
            }
          }
          if (type === "agent_start") {
            patchRpc(tabId, { status: "running" });
          }
          // Context and spend grow at turn boundaries — tick the HUD meter and
          // cost counter live while the agent is still mid-run, not just once
          // at agent_end.
          if (type === "message_end" && tab.status === "running") {
            refreshLiveUsage(tabId);
          }
          if (type === "agent_end") {
            if (tab.status === "running") patchRpc(tabId, { status: "ready" });

            // Retry net: a rename that failed at prompt time (hasRenamed was
            // released) gets another shot at the next turn boundary.
            if (tab.initialPrompt && !tab.hasRenamed) get().renameSession(tabId);

            // Refresh todoPhases/contextUsage/isStreaming after each agent run.
            void get()
              .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
              .then((resp) => applyRpcState(tabId, resp))
              .catch(() => {});

            // Session cost/token totals live on get_session_stats, which is
            // fetched once at boot — a fresh session reads $0 there. Refresh
            // it per run so the HUD cost counter updates instead of freezing
            // at $0.0000 for the whole session.
            void get().refreshStats(tabId);
          }
        }
      }
    },

    answerExtension(tabId, request, response) {
      const tab = get().rpc[tabId];
      if (!tab) return;
      const id =
        request !== null && typeof request === "object" && "id" in request ? request.id : undefined;
      backend.rpcSend(tabId, { type: "extension_ui_response", id, ...response });
      patchRpc(tabId, { extensionQueue: tab.extensionQueue.filter((q) => q !== request) });
    },

    setInitialPrompt(tabId, prompt) {
      const tab = get().rpc[tabId];
      if (!tab || tab.initialPrompt || tab.hasRenamed) return;
      // A resumed or user-named session owns its title — never overwrite it.
      // Decided here, at prompt time, because `set_session_name` writes with
      // source "user" and omp then refuses every later auto title.
      if (!isUntitled(findRecord(get().state, tabId)?.title)) {
        patchRpc(tabId, { hasRenamed: true });
        return;
      }
      // A greeting or bare ack would latch permanently — defer to the next
      // prompt instead (same policy as omp's own titling).
      if (isLowSignalTitleInput(prompt)) return;
      patchRpc(tabId, { initialPrompt: prompt });
      // Name the session as soon as the first substantive prompt is sent, not
      // when the first run finishes. `renameSession` guards on hasRenamed so
      // the concurrent agent_end path stays a harmless no-op (or a retry).
      get().renameSession(tabId);
    },

    renameSession(tabId) {
      const tab = get().rpc[tabId];
      if (!tab || !tab.initialPrompt || tab.hasRenamed) return;
      const prompt = tab.initialPrompt;
      // Latch before the first await so a second agent_end can't double-rename.
      patchRpc(tabId, { hasRenamed: true });
      const projectCwd = findRecord(get().state, tabId)?.projectCwd;
      void (async () => {
        // omp's small model writes the title; the derived one is the fallback
        // for a model that declines, errors, or isn't reachable. Never both —
        // `set_session_name` is a one-shot latch (source "user").
        const modelTitle = projectCwd
          ? await backend.generateTitle(projectCwd, prompt).catch((err: unknown) => {
              console.warn("[session-rename] model titling failed:", err);
              return null;
            })
          : null;
        // The tab can die or be renamed by hand while the model thinks.
        const current = get().rpc[tabId];
        if (!current || current.initialPrompt !== prompt) return;
        const name = modelTitle ?? generateTitleFromPrompt(prompt);
        try {
          await get().rpcCommand(tabId, { type: "set_session_name", name }, { quiet: true });
          patchRpc(tabId, { initialPrompt: null });
        } catch (err) {
          // Release the latch so the next agent_end retries.
          patchRpc(tabId, { hasRenamed: false });
          console.warn("[session-rename] set_session_name failed:", err);
        }
      })();
    },

    async sendPrompt(tabId, message, route = "steer", images) {
      const tab = get().rpc[tabId];
      if (!tab) return;
      // Titling reads the first substantive prompt, whichever route it took.
      get().setInitialPrompt(tabId, message);
      // Always the `prompt` frame, never `steer`/`follow_up`: only AgentSession.prompt
      // builds the magic-keyword notices (orchestrate/ultrathink/workflowz), so those
      // frames would silently drop the keyword mid-run. `streamingBehavior` is what
      // omp's own TUI passes, and omp ignores it while the agent is idle.
      const streamingBehavior = route === "follow_up" ? "followUp" : "steer";
      const cmd = { type: "prompt", message, streamingBehavior };
      // `images` is omitted entirely when empty: omp's own client sends no key
      // rather than an empty array, and every byte here is on one JSON line.
      await runCommand(tabId, images?.length ? { ...cmd, images } : cmd);
    },

    async abortAgent(tabId) {
      await runCommand(tabId, { type: "abort" });
    },

    async abortAndPrompt(tabId, message, images) {
      get().setInitialPrompt(tabId, message);
      const type = "abort_and_prompt";
      await runCommand(tabId, images?.length ? { type, message, images } : { type, message });
    },

    async loadAdvisorDefaults(projectCwd) {
      if (get().advisorDefaults[projectCwd]) return;
      try {
        const defaults = await backend.getAdvisorDefaults(projectCwd);
        set((s) => ({ advisorDefaults: { ...s.advisorDefaults, [projectCwd]: defaults } }));
      } catch {
        // A missing or unreadable omp config is not an error worth a dialog —
        // the toggle just shows no inherited default.
      }
    },

    async setSessionAdvisor(tabId, advisor, advisorModel) {
      const rec = findRecord(get().state, tabId);
      try {
        if (
          rec?.live === "live" &&
          rec.mode === "rpc-ui" &&
          (rec.advisor !== advisor || rec.advisorModel !== advisorModel)
        ) {
          prepareRpcRelaunch(tabId);
        }
        await backend.setSessionAdvisor(tabId, advisor, advisorModel);
      } catch (err) {
        // Changing the advisor relaunches the agent, so a failure here means
        // the session is down, not merely that a setting did not stick. Say
        // that, rather than surfacing the bare IPC error.
        const reason = err instanceof Error ? err.message : String(err);
        window.alert(
          `Could not ${advisor ? "enable" : "disable"} the advisor: ${reason}\n\n` +
            "The agent has stopped — resume the session to continue.",
        );
      }
    },

    async setAdvisorModel(tabId, selector) {
      // setSessionAdvisor persists the complete advisor tuple for both this
      // session and the next one; selecting a model also enables the advisor.
      await get().setSessionAdvisor(tabId, true, selector);
    },

    async setModel(tabId, model) {
      const resp = await runCommand(tabId, {
        type: "set_model",
        provider: model.provider,
        modelId: model.id,
      });
      if (resp === null) return;
      const selected = parseModelInfo(respData(resp)) ?? model;
      patchRpc(tabId, { model: selected });
      const thinkingLevel = get().rpc[tabId]?.session.thinkingLevel ?? null;
      await backend.setSessionModel(
        tabId,
        `${selected.provider}/${selected.id}`,
        thinkingLevel,
      );
    },

    async setThinkingLevel(tabId, level) {
      const resp = await runCommand(tabId, { type: "set_thinking_level", level });
      if (resp === null) return;
      patchSession(tabId, { thinkingLevel: level });
      const model = get().rpc[tabId]?.model;
      await backend.setSessionModel(
        tabId,
        model ? `${model.provider}/${model.id}` : null,
        level,
      );
    },

    async cycleThinkingLevel(tabId) {
      const resp = await runCommand(tabId, { type: "cycle_thinking_level" });
      if (resp === null) return;
      const level = strField(respData(resp), "level");
      if (!level) return;
      patchSession(tabId, { thinkingLevel: level });
      const model = get().rpc[tabId]?.model;
      await backend.setSessionModel(
        tabId,
        model ? `${model.provider}/${model.id}` : null,
        level,
      );
    },

    async setSteeringMode(tabId, mode) {
      const resp = await runCommand(tabId, { type: "set_steering_mode", mode });
      if (resp === null) return;
      patchSession(tabId, { steeringMode: mode });
    },

    async setFollowUpMode(tabId, mode) {
      const resp = await runCommand(tabId, { type: "set_follow_up_mode", mode });
      if (resp === null) return;
      patchSession(tabId, { followUpMode: mode });
    },

    async setInterruptMode(tabId, mode) {
      const resp = await runCommand(tabId, { type: "set_interrupt_mode", mode });
      if (resp === null) return;
      patchSession(tabId, { interruptMode: mode });
    },

    async setAutoCompaction(tabId, enabled) {
      const resp = await runCommand(tabId, { type: "set_auto_compaction", enabled });
      if (resp === null) return;
      patchSession(tabId, { autoCompactionEnabled: enabled });
    },

    async setAutoRetry(tabId, enabled) {
      await runCommand(tabId, { type: "set_auto_retry", enabled });
    },

    async abortRetry(tabId) {
      await runCommand(tabId, { type: "abort_retry" });
    },

    async compactSession(tabId) {
      appendItem(tabId, markerItem("compacting context", "copper"));
      const resp = await runCommand(tabId, { type: "compact" });
      if (resp === null) return;
      // `data.summary` is the entire compacted history — noted, never rendered.
      appendItem(tabId, markerItem("context compacted", "copper"));
      await get().refreshState(tabId);
      await get().refreshStats(tabId);
    },

    async exportHtml(tabId) {
      const resp = await runCommand(tabId, { type: "export_html" });
      if (resp === null) return;
      const path = strField(respData(resp), "path");
      appendItem(tabId, noticeItem(path ? `exported to ${path}` : "export finished", "info"));
    },

    async branchSession(tabId) {
      // `branch` needs the entry to branch from; the last user message is the
      // only one a "branch this session" button can mean.
      const listed = await runCommand(tabId, { type: "get_branch_messages" });
      if (listed === null) return;
      const entryId = strField(arrField(respData(listed), "messages").at(-1), "entryId");
      if (!entryId) {
        patchRpc(tabId, { error: "no user message to branch from" });
        return;
      }
      const resp = await runCommand(tabId, { type: "branch", entryId });
      if (resp === null) return;
      if (field(respData(resp), "cancelled") === true) return;
      // The session id changes; the record catches up via the watcher broadcast.
      await loadHistory(tabId).catch(() => {});
      await get().refreshState(tabId);
    },

    async renameSessionTo(tabId, name) {
      const resp = await runCommand(tabId, { type: "set_session_name", name });
      if (resp === null) return;
      // A user-chosen name is final — the auto-titler must not overwrite it.
      patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
    },

    async newRpcSession(tabId) {
      const resp = await runCommand(tabId, { type: "new_session" });
      if (resp === null) return;
      if (field(respData(resp), "cancelled") === true) return;
      patchRpc(tabId, {
        items: [],
        todos: [],
        stats: null,
        subagents: [],
        initialPrompt: null,
        hasRenamed: false,
        // A new session in this tab is a new plan lifecycle: the old plan
        // belongs to the session that just went away.
        plan: null,
        planReview: null,
        planText: null,
        planDeferred: false,
        plans: [],
      });
      // A new plan lifecycle — kill any wait left by the outgoing session.
      concernWatcher.cancel(tabId);
      await get().refreshState(tabId);
    },

    async setPlanMode(tabId, enabled) {
      // The extension owns the state; the UI never assumes the toggle took —
      // it re-renders when the extension publishes its status frame.
      await runCommand(tabId, {
        type: "prompt",
        message: `/${PLAN_COMMAND} ${enabled ? "on" : "off"}`,
      });
    },

    executePlan(tabId, context, addressAdvisor = true) {
      // The fresh context embeds the plan text in the new session's prompt, so
      // capture it before the gate's answer clears the pane.
      const tab = get().rpc[tabId];
      const planText = tab?.planText ?? null;
      const planKey = tab?.planReview?.request.planFilePath;
      // Answer the gate first — omp's agent is blocked on the reply, so every
      // exit from the review pane must land its verdict before any dispatch.
      if (!answerPlanSelect(tabId, PLAN_EXECUTE)) return;
      if (planKey) {
        patchRpc(tabId, {
          plans: settlePlan(get().rpc[tabId]?.plans ?? [], planKey, "executed"),
        });
      }
      // The drafting turn's review lands after the verdict, so hold dispatch
      // for it when the user wants the advisor's concerns actioned. Execute
      // only: the execute ToolResult tells the agent to stop and wait, so this
      // turn ends and its review genuinely follows — refine keeps the planner
      // in the same turn and is left immediate. The watcher owns the gate; the
      // store just checks its own advisor config for whether a review is coming.
      const configured = get().rpc[tabId]?.advisorStats?.configured === true;
      if (addressAdvisor && configured) {
        concernWatcher.begin(tabId, { context, planText });
        return;
      }
      dispatchExecutePlan(tabId, context, planText, null);
    },

    refinePlan(tabId, notes) {
      const planKey = get().rpc[tabId]?.planReview?.request.planFilePath;
      if (!answerPlanSelect(tabId, PLAN_REFINE)) return;
      if (planKey) {
        patchRpc(tabId, {
          plans: settlePlan(get().rpc[tabId]?.plans ?? [], planKey, "refined"),
        });
      }
      const text = notes?.text?.trim() ?? "";
      const images = notes?.images;
      if (text === "" && !images?.length) return;
      // The planner's current turn continues after the refine verdict; the
      // notes steer it live, and omp appends images after the text block.
      const message = text
        ? `Revise the plan to incorporate these requested changes:\n\n${text}`
        : "Revise the plan per the attached change notes.";
      void get().sendPrompt(tabId, message, "steer", images);
    },

    deferPlanReview(tabId) {
      patchRpc(tabId, { planDeferred: true });
    },

    showPlanReview(tabId) {
      patchRpc(tabId, { planDeferred: false });
    },

    async loadPlanText(tabId, absPath) {
      if (!absPath) {
        patchRpc(tabId, { planText: null });
        return;
      }
      try {
        patchRpc(tabId, { planText: await backend.readPlanFile(tabId, absPath) });
      } catch {
        // The pane falls back to the plan's path — a failed read must never
        // strand the review, because the agent is waiting on the verdict.
        patchRpc(tabId, { planText: null });
      }
    },

    async runSlashCommand(tabId, line) {
      const message = line.startsWith("/") ? line : `/${line}`;
      if (message.trim() === "/") return;
      // omp-ui's own /new: a new live session in a new tab, not omp's in-process
      // lineage switch (that stays on the HUD's new-session button and in terminal
      // tabs' TUI). Bare command only — "/new …" still reaches omp verbatim.
      if (message.trim() === "/new") {
        const projectCwd = get().tabs.find((t) => t.tabId === tabId)?.projectCwd;
        // A composer only exists for a mounted tab; without one, keep the old path.
        if (projectCwd !== undefined) {
          await get().newSession(projectCwd);
          return;
        }
      }
      // Replies arrive asynchronously as command_output frames, which the
      // store drops — the drawer's output pane is gone (issue #43).
      await runCommand(tabId, { type: "prompt", message });
    },

    async setTodos(tabId, phases) {
      const resp = await runCommand(tabId, { type: "set_todos", phases });
      if (resp === null) return;
      patchRpc(tabId, { todos: parseTodoPhases(field(respData(resp), "todoPhases")) });
    },

    async refreshState(tabId) {
      const resp = await runCommand(tabId, { type: "get_state" }, { quiet: true });
      if (resp === null) return;
      applyRpcState(tabId, resp);
    },

    async refreshStats(tabId) {
      const resp = await runCommand(tabId, { type: "get_session_stats" }, { quiet: true });
      if (resp === null) return;
      patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
    },

    async refreshAdvisorStats(tabId) {
      // The extension answers by publishing over setStatus. Until omp has run a
      // turn the session is uncaptured, so it reports a live-session wait which
      // the HUD treats as "not yet" rather than an error.
      await runCommand(tabId, { type: "prompt", message: `/${ADVISOR_STATS_COMMAND}` });
    },

    async refreshSubagents(tabId) {
      // Heartbeat-driven (every subagent_* frame) — quiet, or the busy sweeps
      // strobe for the lifetime of every spawned subagent.
      const resp = await runCommand(tabId, { type: "get_subagents" }, { quiet: true });
      if (resp === null) return;
      patchRpc(tabId, { subagents: parseSubagents(respData(resp)) });
    },

    clearShellExited(tabId) {
      set((s) => ({ shellExited: dropExited(s.shellExited, tabId) }));
    },

    toggleConsole(tabId) {
      set((s) => ({ consoleOpen: { ...s.consoleOpen, [tabId]: !s.consoleOpen[tabId] } }));
    },

    async refreshBranches(projectCwd) {
      const list = await backend.listBranches(projectCwd).catch(() => null);
      // On failure keep the last known list — the chip/menu stay usable.
      if (list) set((s) => ({ branches: { ...s.branches, [projectCwd]: list } }));
    },

    async checkoutGitBranch(projectCwd, name, opts) {
      try {
        await backend.checkoutBranch(projectCwd, name, opts);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      await get().refreshBranches(projectCwd);
      return null;
    },

    async suggestBranchName(projectCwd, planContext) {
      // Best-effort like titling: never throw into the review modal.
      return backend.suggestBranchName(projectCwd, planContext).catch(() => null);
    },
  };
});
