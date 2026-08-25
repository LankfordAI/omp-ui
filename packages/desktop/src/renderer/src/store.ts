import { create } from "zustand";
import type {
  BackendState,
  PlanImplementationSource,
} from "@omp-ui/core/types";
import {
  parsePlanReviewTitle,
  parsePlanStatus,
  planMessage,


  PLAN_STATUS_KEY,
} from "@omp-ui/core/plan";
import {
  parseAdvisorStats,
  ADVISOR_STATS_COMMAND,
  ADVISOR_STATS_KEY,
} from "@omp-ui/core/advisor-stats";
import {
  MCP_RUNTIME_STATUS_KEY,
  parseMcpRuntimeStatus,
} from "@omp-ui/core/mcp-status";
import { modelStreamCheckpointLabel } from "@omp-ui/core/stream-activity";
import { backend } from "./backend";
import { formatDuration } from "./lib/duration";
import {
  extensionCancelResponse,
  routeExtensionRequest,
} from "./lib/extension-router";
import { arrField, boolField, field, numField, strField } from "./lib/fields";
import type { PlanExecutionOptions } from "./lib/plan-concerns";
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
} from "./lib/rpc-types";
import {
  generateTitleFromPrompt,
  isLowSignalTitleInput,
  isUntitled,
} from "./lib/session-title";
import { reduceSubagentFrame, SUBAGENT_BUFFER_CAP, subagentKey } from "./lib/subagent-events";
import { applyTheme, currentThemeId, resolveTheme } from "./lib/themes";
import { createSettingsSlice } from "./store/slices/settings";
import { createUpdatesSlice } from "./store/slices/updates";
import {
  createViewSlice,
  findRecord,
  installDesktopViewPersistence,
  installViewedTabReporter,
  pruneFocus,
  restoreDesktopView,
} from "./store/slices/view";
import {
  RPC_COMMAND_TIMEOUT_MS,
  RpcCommandTimeoutError,
  alertError,
  bumpCompactionUsageGeneration,
  compactionUsageGenerations,
  createMachinery,
  handedOffPlanSources,
  respData,
  retireTimedOutCommand,
  retireTimedOutEarlierThan,
  shellWriters,
  termWriters,
  timedOutCommands,
} from "./store/slices/shared";
import { createCatchupSlice } from "./store/slices/catchup";
import type {
  LastTurnMeta,
  RpcTabState,
  UiStore,
} from "./store/types";
import { createBranchesSlice } from "./store/slices/branches";
import { createPlanExecutionSlice, upsertPlan } from "./store/slices/plan-execution";
import { createLifecycleSlice } from "./store/slices/lifecycle";
export type {
  BranchActivity,
  CompactSurface,
  CompactionMethodsLoad,
  DeleteConfirmation,
  PendingCommand,
  PlanRecord,
  PlanRevisionNotes,
  RpcFailure,
  RpcTabState,
  SettingsPage,
  SidebarSessionState,
  TabInfo,
  TuiHandoff,
  UiStore,
} from "./store/types";
export { findRecord, runningSessionTitleOnCheckout, sessionCwd } from "./store/slices/view";
export {
  RpcCommandTimeoutError,
  STREAM_STALL_THRESHOLD_MS,
  STREAM_STALL_TICK_MS,
  deriveSidebarSessionState,
  registerShellWriter,
  registerTermWriter,
} from "./store/slices/shared";
import {
  commandItem,
  historyToItems,
  markerItem,
  noticeItem,
  planProposalItem,
  settleRunningTools,
  type CommandItem,
  type NoticeItem,
  type RenderItem,
} from "./lib/transcript";

/**
 * Per-item ceiling for accumulated command_output text. Unbounded growth is
 * the exact reason issue #43 deleted the drawer's output pane; a bounded
 * per-item buffer is not that.
 */
const COMMAND_OUTPUT_CAP = 64 * 1024;

function freshRpcTabState(advisorReply: boolean): RpcTabState {
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
    subagentItems: {},
    selectedSubagent: null,
    subagentMarkers: new Map(),
    subagentLevel: "progress",
    extensionStatus: {},
    pendingCommands: new Map(),
    streamCheckpoint: undefined,
    streamStallMs: undefined,
    stallAbortPending: undefined,
    stallCount: 0,
    extensionQueue: [],
    busy: false,
    failure: undefined,
    initialPrompt: null,
    autoTitleSent: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    mcpStatus: null,
    advisorReply,
  };
}

/** pi-ai's StreamTimeoutError classifier bit (Flag.Timeout, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_TIMEOUT = 0x0004_0000;
/** Every built-in provider's stall/first-event watchdog message (pi-ai providers/*). */
const STALL_MESSAGE_RE =
  /stream (stalled|timed out) while waiting for the (next|first) event/i;

/**
 * The per-stall diagnostic notice (issue #100), or null when this retry is
 * not a stream stall. Detection prefers omp's Timeout errorId bit, falling
 * back to the stable watchdog message text; either alone suffices.
 */
function stallNotice(tab: RpcTabState, frame: object): NoticeItem | null {
  const errorMessage = strField(frame, "errorMessage") ?? "";
  const errorId = numField(frame, "errorId") ?? 0;
  const watchdogMatch = STALL_MESSAGE_RE.exec(errorMessage);
  if ((errorId & OMP_ERROR_FLAG_TIMEOUT) === 0 && watchdogMatch === null)
    return null;

  tab.stallCount = (tab.stallCount ?? 0) + 1;
  const checkpoint = tab.streamCheckpoint;
  const stage =
    watchdogMatch?.[2]?.toLowerCase() === "first"
      ? "first-event"
      : watchdogMatch
        ? "idle"
        : null;
  const upstream = errorMessage ? ` Upstream error: ${errorMessage}` : "";
  let detail: string;
  if (stage === null) {
    detail =
      "OMP classified the retry as a stream timeout but supplied no watchdog stage. Review Settings → omp → Providers.";
  } else if (checkpoint === undefined) {
    detail = `the ${stage} watchdog fired, but no model-stream checkpoint was observed in this tab before it fired. Review Settings → omp → Providers.`;
  } else {
    detail = `${stage} watchdog fired after ${formatDuration(Date.now() - checkpoint.at)} since ${checkpoint.label}. Review Settings → omp → Providers.`;
  }
  return noticeItem(
    `provider stream stall #${tab.stallCount} — ${detail}${upstream}`,
    "warn",
  );
}

/** A turn's terminal message ended in a stream stall/timeout, not a user interrupt or other error. */
function isStreamStallEnd(lt: LastTurnMeta): boolean {
  if (lt.stopReason !== "error") return false;
  return (
    ((lt.errorId ?? 0) & OMP_ERROR_FLAG_TIMEOUT) !== 0 ||
    STALL_MESSAGE_RE.test(lt.errorMessage ?? "")
  );
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
export const USAGE_REFRESH_MS = 500;
export const COMPACTION_USAGE_RETRY_MS = 100;
export const COMPACTION_USAGE_MAX_ATTEMPTS = 6;
const lastUsageRefresh = new Map<string, number>();
/**
 * One-shot delayed get_state after a turn ends with a nonzero queue count.
 * omp reclaims parked advice and flushes deferred messages on settle, which
 * can land just after agent_end; and every get_state path swallows failure,
 * so a lost end-of-turn refresh otherwise freezes the last count forever
 * (issue #181). One shot only: a count that survives the re-fetch is genuinely
 * parked, and the composer now says so — polling forever would just churn.
 */
export const QUEUE_SETTLE_REFRESH_MS = 1500;
const queueSettleTimers = new Map<string, number>();

/**
 * Heartbeat-driven roster refresh (issue #62): every subagent_* frame wants a
 * roster read, but heartbeats arrive many times a second. Trailing throttle
 * to one quiet get_subagents round-trip per window, with in-flight
 * coalescing — a frame landing mid-request just schedules the trailing call,
 * so the final roster always lands. The Agents pane's manual refresh button
 * bypasses this entirely (it calls refreshSubagents directly).
 */
const SUBAGENT_REFRESH_MS = 500;
interface SubagentRefresh {
  last: number;
  inFlight: boolean;
  pending: boolean;
  timer: number | undefined;
}
const subagentRefresh = new Map<string, SubagentRefresh>();
/** Whole parameter actions, including their authoritative registry write. */
const pendingSessionParameterActions = new Map<string, Set<Promise<void>>>();

/** Shared empty buffer so identity comparison detects "no items yet". */
const EMPTY_BUFFER: RenderItem[] = [];

/** setStatus/setWidget/setTitle carry their text under different keys. */
function extensionStatusEntry(
  frame: object,
): { key: string; text: string | undefined } | null {
  const method = strField(frame, "method");
  const id = strField(frame, "id") ?? "";
  if (method === "setWidget") {
    const lines = arrField(frame, "widgetLines").filter(
      (l): l is string => typeof l === "string",
    );
    return {
      key: strField(frame, "widgetKey") ?? id,
      // `widgetLines: undefined` is the protocol's "clear this widget".
      text:
        field(frame, "widgetLines") === undefined
          ? undefined
          : lines.join("\n"),
    };
  }
  if (method === "setStatus") {
    return {
      key: strField(frame, "statusKey") ?? id,
      text: strField(frame, "statusText"),
    };
  }
  if (method === "setTitle") {
    return {
      key: strField(frame, "widgetKey") ?? id,
      text: strField(frame, "title"),
    };
  }
  return null;
}

export const useStore = create<UiStore>()((set, get, api) => {
  const m = createMachinery(set, get, api);
  const catchup = createCatchupSlice(set, get, m);
  const branchesSlice = createBranchesSlice(set, get);
  const plan = createPlanExecutionSlice(set, get, m, {
    spawnFreshImplementation: (
      tabId: string,
      planText: string | null,
      planImplementationSource: Readonly<PlanImplementationSource>,
      concerns: string | null,
      options?: PlanExecutionOptions,
    ) =>
      lifecycle.spawnFreshImplementation(tabId, planText, planImplementationSource, concerns, options),
  });
  const {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
    reconcilePlanGates,
  } = plan;
  const lifecycle = createLifecycleSlice(set, get, m, {
    concern: concernWatcher,
    advisorReply: advisorReplyWatcher,
    stall: stallContinueWatcher,
  });

  const trackSessionParameterAction = (tabId: string, action: Promise<void>): Promise<void> => {
    const actions = pendingSessionParameterActions.get(tabId) ?? new Set<Promise<void>>();
    actions.add(action);
    pendingSessionParameterActions.set(tabId, actions);
    const remove = (): void => {
      actions.delete(action);
      if (actions.size === 0) pendingSessionParameterActions.delete(tabId);
    };
    void action.then(remove, remove);
    return action;
  };

  /** Trailing-throttled roster refresh for the subagent_* heartbeat path. */
  const pulseSubagents = (tabId: string): void => {
    let st = subagentRefresh.get(tabId);
    if (!st) {
      st = { last: 0, inFlight: false, pending: false, timer: undefined };
      subagentRefresh.set(tabId, st);
    }
    const state = st;
    const fire = (): void => {
      state.inFlight = true;
      state.last = Date.now();
      void get()
        .refreshSubagents(tabId)
        .finally(() => {
          state.inFlight = false;
          if (state.pending) {
            state.pending = false;
            pulseSubagents(tabId);
          }
        });
    };
    if (state.inFlight) {
      state.pending = true;
      return;
    }
    const wait = state.last + SUBAGENT_REFRESH_MS - Date.now();
    if (wait <= 0) {
      fire();
      return;
    }
    // A scheduled trailing call already covers this frame.
    state.timer ??= window.setTimeout(() => {
      state.timer = undefined;
      fire();
    }, wait);
  };

  const refreshCompactionUsage = (tabId: string, tokensBefore: number): void => {
    const generation = bumpCompactionUsageGeneration(tabId);

    const isCurrent = (): boolean =>
      get().rpc[tabId] !== undefined &&
      compactionUsageGenerations.get(tabId) === generation;
    const finish = (): void => {
      if (compactionUsageGenerations.get(tabId) === generation)
        compactionUsageGenerations.delete(tabId);
    };

    void get()
      .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
      .then((resp) => {
        if (isCurrent())
          m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
      })
      .catch(() => {});

    const attempt = (attempts: number): void => {
      if (!isCurrent()) return;
      void get()
        .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
        .then((resp) => {
          if (!isCurrent()) return;
          const tab = get().rpc[tabId];
          const payload = respData(resp);
          const session =
            tab && payload !== null && typeof payload === "object"
              ? parseSessionRuntime(payload, tab.session)
              : null;
          const tokens = session?.contextUsage?.tokens;
          if (
            typeof tokens === "number" &&
            Number.isFinite(tokens) &&
            tokens < tokensBefore
          ) {
            if (!isCurrent()) return;
            m.applyRpcState(tabId, resp);
            finish();
            return;
          }
          if (attempts >= COMPACTION_USAGE_MAX_ATTEMPTS) {
            finish();
            return;
          }
          window.setTimeout(
            () => attempt(attempts + 1),
            COMPACTION_USAGE_RETRY_MS,
          );
        })
        .catch(() => {
          if (!isCurrent()) return;
          if (attempts >= COMPACTION_USAGE_MAX_ATTEMPTS) {
            finish();
            return;
          }
          window.setTimeout(
            () => attempt(attempts + 1),
            COMPACTION_USAGE_RETRY_MS,
          );
        });
    };

    attempt(1);
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
    if (now - (lastUsageRefresh.get(tabId) ?? -Infinity) < USAGE_REFRESH_MS)
      return;
    lastUsageRefresh.set(tabId, now);
    void get()
      .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
      .then((resp) => m.applyRpcState(tabId, resp))
      .catch(() => {});
    void get()
      .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
      .then((resp) =>
        m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) }),
      )
      .catch(() => {});
  };

  const scheduleQueueSettleRefresh = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab || tab.status === "running") return;
    if (tab.session.queuedMessageCount <= 0) return;
    const prev = queueSettleTimers.get(tabId);
    if (prev !== undefined) window.clearTimeout(prev);
    queueSettleTimers.set(
      tabId,
      window.setTimeout(() => {
        queueSettleTimers.delete(tabId);
        const current = get().rpc[tabId];
        // A new turn's own agent_end re-arms this; never fire mid-turn.
        if (!current || current.status === "running") return;
        void get()
          .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
          .then((resp) => m.applyRpcState(tabId, resp))
          .catch(() => {});
      }, QUEUE_SETTLE_REFRESH_MS),
    );
  };

  const loadHistory = async (tabId: string): Promise<void> => {
    const resp = await get().rpcCommand(tabId, { type: "get_messages" });
    // History replaces the transcript wholesale — a batch reduced from the
    // pre-history items would clobber it on the next flush. Per-agent marker
    // memory must not outlive the render items it was deduping against.
    m.cancelTranscriptBatch(tabId);
    get().rpc[tabId]?.subagentMarkers?.clear();
    m.patchRpc(tabId, {
      items: historyToItems(arrField(respData(resp), "messages")),
    });
    // A resumed transcript's advisories are history, not a live review: the
    // baseline moves past them so nothing here is ever answered.
    advisorReplyWatcher.reset(tabId);
    stallContinueWatcher.reset(tabId);
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
    ...createViewSlice(set, get, api),
    ...createSettingsSlice(set, get, api),
    ...createUpdatesSlice(set, get, api),
    ...lifecycle,
    state: null,
    exited: {},
    hibernated: {},
    lastActiveAt: catchup.lastActiveAt,
    catchup: catchup.catchup,
    rpc: {},
    branches: branchesSlice.branches,
    branchActivity: branchesSlice.branchActivity,
    branchDiffRevision: branchesSlice.branchDiffRevision,
    refreshBranches: branchesSlice.refreshBranches,
    checkoutGitBranch: branchesSlice.checkoutGitBranch,
    pullGitBranch: branchesSlice.pullGitBranch,
    readMergeBackStatus: branchesSlice.readMergeBackStatus,
    mergeWorktreeBranch: branchesSlice.mergeWorktreeBranch,
    suggestBranchName: branchesSlice.suggestBranchName,
    advisorDefaults: {},

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
          focusedTabByProject: pruneFocus(s.focusedTabByProject, state),
        }));
        syncTheme(state);
        reconcilePlanGates(state);
      });
      backend.onPtyData((tabId, data) => termWriters.get(tabId)?.(data));
      backend.onPtyExit((tabId, code) => m.teardownExited(tabId, code));
      backend.onSessionHibernated((tabId) => m.teardownHibernated(tabId));
      // OS notification click (issue #271): resurface the session's tab —
      // openSession is the hide/resurface path; main dedupes the resume
      // against a live process, so a late-joining renderer never
      // double-spawns. The event fans out to every renderer, so a click
      // resurfaces the tab in all of them.
      backend.onFocusSession((tabId) => {
        void get().openSession(tabId);
      });
      backend.onShellData((tabId, data) => shellWriters.get(tabId)?.(data));
      backend.onShellExit((tabId, code) => {
        set((s) => {
          // The handoff TUI quit, so its banner switches from "send" to
          // "restart session"; a plain login shell leaves the map identical.
          const staged = s.tuiHandoff[tabId];
          return {
            shellExited: { ...s.shellExited, [tabId]: code },
            tuiHandoff:
              staged && staged.phase !== "exited"
                ? { ...s.tuiHandoff, [tabId]: { ...staged, phase: "exited" } }
                : s.tuiHandoff,
          };
        });
      });
      backend.onRpcFrame((tabId, frame) => get().handleRpcFrame(tabId, frame));
      backend.onAppUpdateState((appUpdate) =>
        get().replaceAppUpdate(appUpdate),
      );
      backend.onOmpUpdateState((ompUpdate) =>
        get().replaceOmpUpdate(ompUpdate),
      );
      backend.onRemoteState((remote) => get().replaceRemote(remote));
      const [state, appUpdate, ompUpdate, remote] = await Promise.all([
        backend.getState(),
        backend.getAppUpdateState(),
        backend.getOmpUpdateState(),
        backend.getRemoteState(),
      ]);
      set({ state, appUpdate, ompUpdate, remote });
      syncTheme(state);
      reconcilePlanGates(state);
      await restoreDesktopView(api);
      installDesktopViewPersistence(api);
      installViewedTabReporter(api);
      catchup.installCatchupWatcher(api);
    },

    async bootRpcTab(tabId) {
      handedOffPlanSources.delete(tabId);
      if (rpcBooting.has(tabId)) return;
      rpcBooting.add(tabId);
      try {
        // A pending concern handoff belongs to the session that just went away.
        concernWatcher.cancel(tabId);
        advisorReplyWatcher.cancel(tabId);
        stallContinueWatcher.cancel(tabId);
        m.cancelTranscriptBatch(tabId);
        compactionUsageGenerations.delete(tabId);
        // A re-boot must not slam the Agents pane's drill-down shut: the open
        // detail view and the retained buffers behind it survive the process
        // restart, and the subscription re-escalates after boot (issue #63).
        const prior = get().rpc[tabId];
        m.patchRpc(tabId, {
          ...freshRpcTabState(get().state?.advisorAutoReply ?? true),
          selectedSubagent: prior?.selectedSubagent ?? null,
          subagentItems: prior?.subagentItems ?? {},
        });
        // The tab may not exist in state yet — ensure the slot exists.
        if (!get().rpc[tabId]) {
          set((s) => ({
            rpc: {
              ...s.rpc,
              [tabId]: freshRpcTabState(get().state?.advisorAutoReply ?? true),
            },
          }));
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
              m.applyRpcState(tabId, resp);
              return null;
            },
            (err: unknown) =>
              err instanceof Error ? err : new Error(String(err)),
          );
        // allSettled, not all: a missing subagent bus or a slow stats read must
        // never leave the tab stuck in "starting".
        const boots: Promise<unknown>[] = [
          get()
            .rpcCommand(tabId, { type: "get_available_models" })
            .then((resp) => {
              m.patchRpc(tabId, {
                availableModels: parseModelList(respData(resp)),
              });
            }),
          get()
            .rpcCommand(tabId, { type: "get_available_commands" })
            .then((resp) => {
              m.patchRpc(tabId, { commands: parseCommandList(respData(resp)) });
            }),
          get()
            .rpcCommand(tabId, { type: "get_session_stats" })
            .then((resp) => {
              m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
            }),
          // "progress" | "events" are the only legal levels; progress is the
          // cheap one — per-agent status, not every subagent token.
          get().rpcCommand(tabId, {
            type: "set_subagent_subscription",
            level: "progress",
          }),
        ];
        if (rec?.sessionId) boots.push(loadHistory(tabId));
        await Promise.allSettled(boots);
        // The fresh process just heard "progress" — reflect that in the
        // tracked level, then re-escalate if a detail view is still open.
        const runtime = get().rpc[tabId];
        if (runtime) {
          runtime.subagentLevel = "progress";
          m.syncSubagentSubscription(tabId);
        }
        // Arm the advisor-stats extension (its first slash run sets its `ui`
        // channel, after which it auto-publishes at each turn end). Armed for
        // every session, not just advisor-on ones: the extension is always loaded,
        // this one shot is cheap and idempotent, and it publishes `available:false`
        // for an advisor-off session that the HUD simply hides. Gating on the
        // record flag would let a stale `advisor` (race with the broadcast after the
        // advisor-toggle relaunch) skip the arm and starve the readout forever.
        void get().refreshAdvisorStats(tabId);
        if (stateFailure) {
          m.patchRpc(tabId, {
            status: "error",
            failure: {
              message: `RPC boot failed while running "get_state": ${stateFailure.message}`,
              kind: "boot",
              fatal: true,
              command: "get_state",
              ...(stateFailure instanceof RpcCommandTimeoutError
                ? { timeoutMs: stateFailure.timeoutMs }
                : {}),
              sessionStatus: "error",
              ...(rec?.live !== undefined ? { liveState: rec.live } : {}),
              recovery: "Retry boot to reconnect to the live session.",
            },
          });
        } else {
          m.patchRpc(tabId, { status: "ready" });
          // Boot reset the tab to fresh state before this ran, so a pending
          // gate on the record hydrates now instead of being clobbered.
          const bootedState = get().state;
          if (bootedState !== null) reconcilePlanGates(bootedState);
          // Backfill (loadHistory) completed before status flipped: a staged
          // resurface settles from the complete transcript (issue #273).
          catchup.settleCatchup(tabId);
        }
      } catch (err) {
        const liveState = findRecord(get().state, tabId)?.live;
        m.patchRpc(tabId, {
          status: "error",
          failure: {
            message: `RPC boot failed: ${err instanceof Error ? err.message : String(err)}`,
            kind: "boot",
            fatal: true,
            ...(err instanceof RpcCommandTimeoutError
              ? { command: err.command, timeoutMs: err.timeoutMs }
              : {}),
            sessionStatus: "error",
            ...(liveState !== undefined ? { liveState } : {}),
            recovery: "Retry boot to reconnect to the live session.",
          },
        });
      } finally {
        rpcBooting.delete(tabId);
      }
    },

    rpcCommand(tabId, cmd, opts) {
      const tab = get().rpc[tabId];
      if (!tab) return Promise.reject(new Error("rpc tab not initialized"));
      const id = randomId();
      const command = typeof cmd.type === "string" ? cmd.type : "unknown";
      const startedAt = Date.now();
      const timeoutMs = RPC_COMMAND_TIMEOUT_MS;
      // Quiet commands are background sync (usage ticks, subagent roster
      // heartbeats). They never touch `busy`: each round-trip would otherwise
      // strobe the progress sweeps for a few ms, jittering the transcript.
      const quiet = opts?.quiet ?? false;
      // Executor form required: the pending entry must exist before send.
      const promise = new Promise<unknown>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          // Remove before settling so the map remains the authoritative ref
          // count when `finally` recomputes busy.
          tab.pendingCommands.delete(id);
          // Attribution memory: the entry outlives the budget until a
          // completion response is observed, so a later quiet timeout can
          // name the command holding the chain (issue #302).
          const timedOut = timedOutCommands.get(tabId) ?? [];
          timedOut.push({ id, command, startedAt, timedOutAt: Date.now() });
          timedOutCommands.set(tabId, timedOut);
          const runtime = get().rpc[tabId];
          const liveState = findRecord(get().state, tabId)?.live;
          const details = {
            tabId,
            commandId: id,
            command,
            timeoutMs,
            elapsedMs: Date.now() - startedAt,
            pendingCommandCount: tab.pendingCommands.size,
            pending: [...tab.pendingCommands.values()].map((p) => ({
              command: p.command,
              quiet: p.quiet,
              elapsedMs: Date.now() - p.startedAt,
            })),
            sessionStatus: runtime?.status ?? null,
            isStreaming: runtime?.session.isStreaming ?? null,
            liveState: liveState ?? null,
          };
          console.warn("[rpc] command timeout", details);
          reject(new RpcCommandTimeoutError(command, timeoutMs, startedAt));
        }, timeoutMs);
        tab.pendingCommands.set(id, {
          resolve,
          reject,
          timer,
          quiet,
          command,
          startedAt,
          timeoutMs,
        });
      });
      if (!quiet) m.patchRpc(tabId, { busy: true });
      // Callers correlating async frames (prompt_result) with this command
      // learn the wire id before the first byte leaves.
      opts?.captureId?.(id);
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
          m.patchRpc(tabId, { busy: false });
        }
      });
    },

    handleRpcFrame(tabId, frame) {
      if (frame === null || typeof frame !== "object") return;
      const type = "type" in frame ? frame.type : undefined;
      // ready can beat the spawn IPC response that inserts the renderer tab.
      // bootRpcTab creates its own runtime slot, so it bypasses the ordinary
      // unknown-tab guard.
      if (type === "ready") {
        void get().bootRpcTab(tabId);
        return;
      }
      const tab = get().rpc[tabId];
      if (!tab) return;
      switch (type) {
        case "response": {
          const id =
            "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const pending = id ? tab.pendingCommands.get(id) : undefined;
          if (!pending) {
            // The budget expired first: this late response is the completion
            // observation the timeout attribution waits for (issue #302).
            if (id) retireTimedOutCommand(tabId, id);
            return;
          }
          clearTimeout(pending.timer);
          tab.pendingCommands.delete(id!);
          // The chain is FIFO: this completion proves every earlier-started
          // command completed. `bash` bypasses the chain, so it proves nothing (issue #302).
          if (pending.command !== "bash") retireTimedOutEarlierThan(tabId, pending.startedAt);
          if ("success" in frame && frame.success === false) {
            const message =
              "error" in frame && typeof frame.error === "string"
                ? frame.error
                : "command failed";
            pending.reject(new Error(message));
          } else {
            pending.resolve(frame);
          }
          return;
        }
        case "rpc_chunk":
          return; // reassembled in main — never expected here
        case "session_info_update":
          m.patchRpc(tabId, { session: parseSessionRuntime(frame, tab.session) });
          return;
        case "config_update": {
          const model = parseModelInfo(field(frame, "model")) ?? tab.model;
          const session = parseSessionRuntime(frame, tab.session);
          m.patchRpc(tabId, { model, session });
          if (model) {
            void backend
              .setSessionModel(
                tabId,
                `${model.provider}/${model.id}`,
                session.thinkingLevel,
              )
              .catch(() => {});
          }
          return;
        }
        case "available_commands_update":
          m.patchRpc(tabId, { commands: parseCommandList(frame) });
          return;
        case "subagent_lifecycle":
        case "subagent_progress":
        case "subagent_event": {
          const payload = field(frame, "payload");
          const progress = field(payload, "progress");
          // The agent key is id-first: the display name flips between frame
          // types for one agent, which keyed the old consecutive-only dedupe
          // wrong and flooded the transcript (issue #62).
          const key = subagentKey(frame);
          const name =
            strField(payload, "agent") ??
            strField(progress, "agent") ??
            strField(payload, "id") ??
            "subagent";
          const status =
            strField(payload, "status") ?? strField(progress, "status");
          const label = status
            ? `subagent ${name}: ${status}`
            : `subagent ${name}`;
          // Per-agent marker coalescing: a heartbeat repeats its label
          // forever, so only a genuine transition stamps a marker — no
          // matter how several agents' frames interleave.
          const markers = (tab.subagentMarkers ??= new Map());
          if (markers.get(key) !== label) {
            markers.set(key, label);
            m.appendItem(tabId, markerItem(label, "copper"));
          }
          // Per-agent buffer for the subagent view and the Agents pane
          // roster (issue #63). Identity return means the frame added
          // nothing. The viewed agent's buffer renders in the subagent
          // view's full transcript — it must not truncate; the cap bounds
          // retained background buffers.
          const buffers = tab.subagentItems ?? {};
          const prev = buffers[key] ?? EMPTY_BUFFER;
          const next = reduceSubagentFrame(
            prev,
            frame,
            tab.selectedSubagent === key ? false : SUBAGENT_BUFFER_CAP,
          );
          if (next !== prev) {
            m.patchRpc(tabId, { subagentItems: { ...buffers, [key]: next } });
          }
          pulseSubagents(tabId);
          return;
        }
        case "extension_error": {
          const text = strField(frame, "error") ?? "extension error";
          m.appendItem(tabId, {
            ...noticeItem(text, "error"),
            source: strField(frame, "extensionPath"),
          });
          return;
        }
        case "command_output": {
          // Attaches to the in-flight slash command's transcript row. omp
          // 17.3.8+ emits this for builtin replies (/computer status,
          // /usage, /context, ...), which is what makes them visible in
          // native sessions; the hard cap means a verbose reply can never
          // regrow the drawer pane issue #43 removed.
          const text = strField(frame, "text") ?? "";
          const running = m.effectiveItems(tabId)
            .filter((i): i is CommandItem => i.kind === "command" && i.status === "running")
            .at(-1);
          if (running === undefined) {
            m.appendItem(tabId, noticeItem(text, "info"));
            return;
          }
          const joined =
            running.output === undefined ? text : `${running.output}\n${text}`;
          const output =
            joined.length <= COMMAND_OUTPUT_CAP
              ? joined
              : `${joined.slice(0, COMMAND_OUTPUT_CAP)}\n… output truncated`;
          m.patchItems(tabId, (i) =>
            i.kind === "command" && i.id === running.id ? { ...i, output } : i,
          );
          return;
        }
        case "extension_ui_request": {
          // Plan mode rides the extension channel, so it is claimed before the
          // generic routing: the review dialog must reach the plan pane rather
          // than the raw select dialog, and the status frame is state, not text.
          const review = parsePlanReviewTitle(strField(frame, "title"));
          if (review) {
            m.patchRpc(tabId, {
              planReview: { request: review, frame },
              // A fresh proposal is never deferred — it demands its verdict.
              planDeferred: false,
              plans: upsertPlan(tab.plans, review.title, review.planFilePath),
            });
            const planItem = planProposalItem(
              review.title,
              review.planFilePath,
              review.planAbsPath,
            );
            m.appendItem(tabId, planItem);
            void get().loadPlanText(tabId, review.planAbsPath, planItem.id);
            return;
          }
          const entry = extensionStatusEntry(frame);
          if (entry?.key === PLAN_STATUS_KEY) {
            m.patchRpc(tabId, { plan: parsePlanStatus(entry.text) });
            return;
          }
          if (entry?.key === ADVISOR_STATS_KEY) {
            // Included in a catch-up snapshot only when the frame has
            // arrived by settle time; a later frame never re-settles a
            // taken snapshot (issue #273).
            m.patchRpc(tabId, { advisorStats: parseAdvisorStats(entry.text) });
            return;
          }
          if (entry?.key === MCP_RUNTIME_STATUS_KEY) {
            const mcpStatus = parseMcpRuntimeStatus(entry.text);
            if (mcpStatus === null) return;
            const observed = new Set(
              (tab.mcpStatus?.failedServers ?? []).map(
                (failure) => `${failure.kind}\u0000${failure.serverName}`,
              ),
            );
            for (const failure of mcpStatus.failedServers) {
              const key = `${failure.kind}\u0000${failure.serverName}`;
              if (observed.has(key)) continue;
              observed.add(key);
              const text = failure.kind === "auth"
                ? `MCP server “${failure.serverName}” failed authentication and is absent from this live session. Open the MCP manager, authenticate through omp’s TUI, then restart the session.`
                : `MCP server “${failure.serverName}” failed to connect and is absent from this live session. Open the MCP manager to inspect its configuration, then restart the session.`;
              m.appendItem(tabId, noticeItem(text, "warn"));
            }
            m.patchRpc(tabId, { mcpStatus });
            return;
          }
          const action = routeExtensionRequest(frame);
          if (action.action === "dialog") {
            m.patchRpc(tabId, { extensionQueue: [...tab.extensionQueue, frame] });
            return;
          }
          if (action.action === "open-url") {
            const url = strField(frame, "url");
            const id = "id" in frame ? frame.id : undefined;
            if (url === undefined || url === "") {
              backend.rpcSend(tabId, extensionCancelResponse(id));
              return;
            }
            // Main's setWindowOpenHandler denies the window and routes through
            // openExternalSafe (https/http/mailto only) — the renderer adds no
            // second policy. Reply immediately: a login flow's callback wait is
            // omp's to time out, never ours to block on the OS browser.
            window.open(url);
            backend.rpcSend(tabId, {
              type: "extension_ui_response",
              id,
              confirmed: true,
            });
            let origin = url;
            try {
              origin = new URL(url).origin;
            } catch {
              // Not parseable as a URL — the marker carries the raw string.
            }
            m.appendItem(tabId, markerItem(`opened browser: ${origin}`));
            return;
          }
          // Every non-dialog method is answered immediately — omp blocks on the
          // reply — but status/widget/title text is recorded first, because it
          // is the extension's actual output, not an interaction to decline.
          if (entry) {
            const extensionStatus = { ...tab.extensionStatus };
            if (entry.text === undefined || entry.text === "")
              delete extensionStatus[entry.key];
            else extensionStatus[entry.key] = entry.text;
            m.patchRpc(tabId, { extensionStatus });
          }
          backend.rpcSend(
            tabId,
            extensionCancelResponse("id" in frame ? frame.id : undefined),
          );
          if (!entry) {
            const method = strField(frame, "method") ?? "?";
            m.appendItem(tabId, markerItem(`extension ${method} auto-cancelled`));
          }
          return;
        }
        case "prompt_result": {
          // Settles a slash-command row whose response carried no
          // `agentInvoked` (older runtime): the wire id maps back to the item.
          const id = "id" in frame && typeof frame.id === "string" ? frame.id : null;
          const byRequest = m.slashCommandItems.get(tabId);
          const itemId = id !== null ? byRequest?.get(id) : undefined;
          if (byRequest !== undefined && id !== null && itemId !== undefined) {
            byRequest.delete(id);
            const invoked =
              boolField(frame, "agentInvoked") ??
              boolField(field(frame, "data"), "agentInvoked");
            m.patchItems(tabId, (i) =>
              i.kind === "command" && i.id === itemId && i.status === "running"
                ? { ...i, status: invoked === true ? "agent" : "done" }
                : i,
            );
          }
          m.patchRpc(tabId, { status: "ready" });
          return;
        }
        case "omp_ui_notice": {
          // Main-process notice frame (issue #248: the stall watchdog's abort
          // report). Appended verbatim, never answered.
          m.appendItem(
            tabId,
            noticeItem(strField(frame, "message") ?? "omp-ui notice", "warn"),
          );
          // A watchdog abort ends the turn with stopReason "aborted", which
          // isStreamStallEnd can never classify — the tagged notice is what
          // feeds auto-continue instead (issue #254).
          if (strField(frame, "reason") === "stall-abort")
            m.patchRpc(tabId, { stallAbortPending: true });
          return;
        }
        case "omp_ui_error": {
          const message = strField(frame, "message") ?? "omp rpc error";
          const liveState = findRecord(get().state, tabId)?.live;
          // The process died mid-tool, so no agent_end will settle running
          // cards. Settle the effective items — frames still pending in the
          // batch are part of the transcript up to the failure (issue #187).
          const settledItems = settleRunningTools(m.effectiveItems(tabId), "aborted");
          m.cancelTranscriptBatch(tabId);
          compactionUsageGenerations.delete(tabId);
          m.patchRpc(tabId, {
            status: "error",
            failure: {
              message,
              kind: "process",
              fatal: true,
              sessionStatus: "error",
              ...(liveState !== undefined ? { liveState } : {}),
              recovery:
                "The live session process stopped. Resume the session to continue.",
            },
            items: settledItems,
            // Process death is terminal for this run (issue #228).
            streamStallMs: undefined,
          });
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
          // Renderer-observed request/model progress for stall diagnosis. Local
          // tool execution and settlement frames deliberately do not reset it.
          const checkpointLabel = modelStreamCheckpointLabel(frame);
          if (checkpointLabel !== null) {
            tab.streamCheckpoint = { at: Date.now(), label: checkpointLabel };
          }
          // Late-joining clients see frames while "running" without an
          // agent_start — arm the stall clock on any such frame (issue #228).
          if (tab.status === "running") m.ensureStreamStallTimer(tabId);
          // The AgentSessionEvent stream — the actual transcript. Reduction is
          // eager (frame-exact for the watchers below) but the render commit is
          // coalesced — one Zustand set per burst instead of per frame, so the
          // renderer keeps servicing input mid-stream (issue #187).
          const stall =
            type === "auto_retry_start" ? stallNotice(tab, frame) : null;
          m.queueTranscriptFrame(tabId, frame, stall);
          if (type === "auto_compaction_start")
            compactionUsageGenerations.delete(tabId);
          if (type === "auto_compaction_end") {
            const result = field(frame, "result");
            const tokensBefore = numField(result, "tokensBefore");
            const aborted = boolField(frame, "aborted") === true;
            if (
              !aborted &&
              tokensBefore !== undefined &&
              Number.isFinite(tokensBefore) &&
              tokensBefore > 0
            )
              refreshCompactionUsage(tabId, tokensBefore);
            else void m.refreshUsage(tabId);
          }
          // A pending plan-concerns wait settles the moment a fresh advisor
          // finding lands after the verdict (or its bounded deadline fires).
          concernWatcher.feed(tabId);
          // A review that lands with the session idle has nothing carrying it
          // back to the main model — answer it (issue #104).
          //
          // This position is load-bearing; do not move it. The agent_start /
          // agent_end status patches below run AFTER this call, so on the
          // agent_end frame the tab still reads "running": canReply refuses,
          // and the cursor simply advances past the `agent finished` marker.
          // The advisory arriving on a later frame is then above that cursor,
          // with the tab finally "ready" — which is exactly the case to answer.
          advisorReplyWatcher.feed(tabId);
          if (type === "thinking_level_changed") {
            const level = strField(frame, "thinkingLevel");
            if (level) {
              m.patchSession(tabId, { thinkingLevel: level });
              const model = get().rpc[tabId]?.model;
              if (model) {
                void backend
                  .setSessionModel(
                    tabId,
                    `${model.provider}/${model.id}`,
                    level,
                  )
                  .catch(() => {});
              }
            }
          }
          if (type === "agent_start") {
            m.patchRpc(tabId, { status: "running", lastTurn: undefined });
            // A stale entry from a prior run (its tick has not fired yet)
            // must not block the fresh arm.
            m.stopStreamStallTimer(tabId);
            m.ensureStreamStallTimer(tabId);
            const pending = queueSettleTimers.get(tabId);
            if (pending !== undefined) {
              window.clearTimeout(pending);
              queueSettleTimers.delete(tabId);
            }
            // A slash command still awaiting its verdict (response carried no
            // `agentInvoked`) is what started this turn — mark it so.
            const byRequest = m.slashCommandItems.get(tabId);
            if (byRequest !== undefined && byRequest.size > 0) {
              const tracked = new Set(byRequest.values());
              byRequest.clear();
              m.patchItems(tabId, (i) =>
                i.kind === "command" && i.status === "running" && tracked.has(i.id)
                  ? { ...i, status: "agent" }
                  : i,
              );
            }
          }
          // Context and spend grow at turn boundaries — tick the HUD meter and
          // cost counter live while the agent is still mid-run, not just once
          // at agent_end.
          if (type === "message_end") {
            const message = field(frame, "message");
            if (
              message !== null &&
              typeof message === "object" &&
              strField(message, "role") === "assistant"
            ) {
              // The turn's terminal message end: drives the agent_end settle
              // target and the stall classification below.
              m.patchRpc(tabId, {
                lastTurn: {
                  stopReason: strField(message, "stopReason"),
                  errorMessage: strField(message, "errorMessage"),
                  errorId: numField(message, "errorId"),
                },
              });
            }
            if (tab.status === "running") refreshLiveUsage(tabId);
          }
          if (type === "agent_end") {
            // The tick self-terminates on the next pass; the explicit clear
            // keeps the field from lingering up to a second after the run.
            if (tab.status === "running")
              m.patchRpc(tabId, { status: "ready", streamStallMs: undefined });

            // Retry net: a rename that failed at prompt time (hasRenamed was
            // released) gets another shot at the next turn boundary.
            if (tab.initialPrompt && !tab.hasRenamed)
              get().renameSession(tabId);

            // Refresh todoPhases/contextUsage/isStreaming after each agent run.
            void get()
              .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
              .then((resp) => {
                m.applyRpcState(tabId, resp);
                scheduleQueueSettleRefresh(tabId);
              })
              // The refresh itself was lost — if the last-known count is
              // nonzero it may be frozen; the settle timer is the one retry.
              .catch(() => scheduleQueueSettleRefresh(tabId));

            // Session cost/token totals live on get_session_stats, which is
            // fetched once at boot — a fresh session reads $0 there. Refresh
            // it per run so the HUD cost counter updates instead of freezing
            // at $0.0000 for the whole session.
            void get().refreshStats(tabId);
            // (C) The provider-stall diagnostic posts at every
            // stall-classified error turn-end (issue #250). A watchdog abort
            // (issue #254) posted its own notice from main already.
            // (B) The continue prompt is gated on the app switch (issue #251).
            const lastTurn = get().rpc[tabId]?.lastTurn;
            const providerStall =
              lastTurn !== undefined && isStreamStallEnd(lastTurn);
            if (providerStall) {
              // The ready patch above replaced the stored tab, and stallNotice
              // bumps its stall counter in place — re-fetch the live object so
              // the increment does not land on a detached one.
              const liveTab = get().rpc[tabId];
              if (liveTab !== undefined) {
                const notice = stallNotice(liveTab, {
                  errorMessage: lastTurn.errorMessage,
                  errorId: lastTurn.errorId,
                });
                if (notice) m.appendItem(tabId, notice);
              }
            }
            const watchdogAbort = get().rpc[tabId]?.stallAbortPending === true;
            if (watchdogAbort) m.patchRpc(tabId, { stallAbortPending: false });
            if (
              (providerStall || watchdogAbort) &&
              get().rpc[tabId] !== undefined &&
              get().state?.stallAutoContinue !== false
            )
              stallContinueWatcher.trigger(tabId);
          }
        }
      }
    },

    answerExtension(tabId, request, response) {
      const tab = get().rpc[tabId];
      if (!tab) return;
      const id =
        request !== null && typeof request === "object" && "id" in request
          ? request.id
          : undefined;
      backend.rpcSend(tabId, {
        type: "extension_ui_response",
        id,
        ...response,
      });
      m.patchRpc(tabId, {
        extensionQueue: tab.extensionQueue.filter((q) => q !== request),
      });
    },

    setInitialPrompt(tabId, prompt) {
      const tab = get().rpc[tabId];
      if (!tab || tab.initialPrompt || tab.hasRenamed) return;
      // A resumed or user-named session owns its title — never overwrite it.
      // Decided here, at prompt time, because `set_session_name` writes with
      // source "user" and omp then refuses every later auto title.
      if (!isUntitled(findRecord(get().state, tabId)?.title)) {
        m.patchRpc(tabId, { hasRenamed: true });
        return;
      }
      // A greeting or bare ack would latch permanently — defer to the next
      // prompt instead (same policy as omp's own titling).
      if (isLowSignalTitleInput(prompt)) return;
      m.patchRpc(tabId, { initialPrompt: prompt });
      // Two-phase titling starts here: the derived name goes out immediately
      // (renameSession phase 1) and the model title is a background upgrade
      // (phase 2). `renameSession` guards on hasRenamed so the concurrent
      // agent_end path stays a harmless no-op (or a retry of phase 1).
      get().renameSession(tabId);
    },

    renameSession(tabId) {
      const tab = get().rpc[tabId];
      if (!tab || !tab.initialPrompt || tab.hasRenamed) return;
      const prompt = tab.initialPrompt;
      // Latch before the first await so a second agent_end can't double-rename.
      m.patchRpc(tabId, { hasRenamed: true });
      const record = findRecord(get().state, tabId);
      const projectCwd = record?.projectCwd;
      const sessionId = record?.sessionId ?? null;
      const derived = generateTitleFromPrompt(prompt);
      // Phase 1: the derived name goes out immediately, so the session is
      // named before any model round trip — no cold spawn, no provider wait.
      void (async () => {
        try {
          await get().rpcCommand(
            tabId,
            { type: "set_session_name", name: derived },
            { quiet: true },
          );
          const current = get().rpc[tabId];
          if (!current || current.initialPrompt !== prompt) return;
          m.patchRpc(tabId, { autoTitleSent: derived });
          // No model path: the derived name is final.
          if (!projectCwd) m.patchRpc(tabId, { initialPrompt: null });
        } catch (err) {
          // Release the latch so the next agent_end retries the whole titling.
          m.patchRpc(tabId, { hasRenamed: false });
          console.warn("[session-rename] set_session_name failed:", err);
        }
      })();
      // Phase 2: the model title is a background upgrade, never the first
      // name. A cold `omp -p` spawn plus the provider round trip takes
      // seconds (up to the 90 s timeout); waiting on it kept the session
      // unnamed for its whole duration.
      if (!projectCwd) return;
      void (async () => {
        const modelTitle = await backend
          .generateTitle(projectCwd, prompt)
          .catch((err: unknown) => {
            console.warn("[session-rename] model titling failed:", err);
            return null;
          });
        const current = get().rpc[tabId];
        // Tab gone, prompt re-latched, or a manual rename in the interim
        // (renameSessionTo clears initialPrompt): the derived name stands.
        if (!current || current.initialPrompt !== prompt) return;
        // Phase 1 must have landed, or the upgrade could send first and the
        // derived send would then overwrite it.
        if (current.autoTitleSent !== derived) return;
        // A /new or /branch while the model thought: never title the
        // replacement session with the previous prompt.
        if (
          sessionId !== null &&
          findRecord(get().state, tabId)?.sessionId !== sessionId
        )
          return;
        const title = findRecord(get().state, tabId)?.title;
        // The record shows a name we did not set: leave it alone.
        if (!isUntitled(title) && title !== derived) return;
        if (!modelTitle || modelTitle === derived || modelTitle === title) {
          m.patchRpc(tabId, { initialPrompt: null });
          return;
        }
        try {
          // A second user-sourced rename overwrites the first: omp only
          // refuses an "auto" title once a "user" one exists
          // (SessionManager.setSessionName, verified in omp 18.0.4). If a
          // future omp refuses the overwrite, the catch keeps the derived
          // name and settles — the session keeps its phase-1 name.
          await get().rpcCommand(
            tabId,
            { type: "set_session_name", name: modelTitle },
            { quiet: true },
          );
          m.patchRpc(tabId, { autoTitleSent: modelTitle, initialPrompt: null });
        } catch (err) {
          m.patchRpc(tabId, { initialPrompt: null });
          console.warn("[session-rename] title upgrade failed:", err);
        }
      })();
    },

    async sendPrompt(tabId, message, route = "steer", images) {
      const tab = get().rpc[tabId];
      if (!tab || tab.status === "starting") return false;
      if (route === "advisor_reply" || route === "stall_continue") {
        // omp-ui's own prompt (a late-review answer, a stall continue): it
        // must not title the session and must not re-arm either loop guard —
        // an auto-prompt is not human direction.
      } else {
        // Human direction makes a previously handed-off source active again,
        // even when its immediate hibernation was declined.
        handedOffPlanSources.delete(tabId);
        // Titling reads the first substantive prompt, whichever route it took.
        get().setInitialPrompt(tabId, message);
        advisorReplyWatcher.reset(tabId);
        stallContinueWatcher.reset(tabId);
      }
      // Always the `prompt` frame, never `steer`/`follow_up`: only AgentSession.prompt
      // builds the magic-keyword notices (orchestrate/ultrathink/workflowz), so those
      // frames would silently drop the keyword mid-run. `streamingBehavior` is what
      // omp's own TUI passes, and omp ignores it while the agent is idle.
      //
      // An advisor reply rides followUp, not steer: if a turn started between the
      // settle and this send, the reply queues behind it instead of interrupting.
      const streamingBehavior =
        route === "follow_up" || route === "advisor_reply" || route === "stall_continue"
          ? "followUp"
          : "steer";
      const cmd = { type: "prompt", message, streamingBehavior };
      // `images` is omitted entirely when empty: omp's own client sends no key
      // rather than an empty array, and every byte here is on one JSON line.
      const response = await m.runCommand(tabId, images?.length ? { ...cmd, images } : cmd);
      return response !== null;
    },

    async abortAgent(tabId) {
      await m.runCommand(tabId, { type: "abort" });
    },

    async abortAndPrompt(tabId, message, images) {
      if (get().rpc[tabId]?.status === "starting") return;
      handedOffPlanSources.delete(tabId);
      get().setInitialPrompt(tabId, message);
      advisorReplyWatcher.reset(tabId);
      stallContinueWatcher.reset(tabId);
      const type = "abort_and_prompt";
      await m.runCommand(
        tabId,
        images?.length ? { type, message, images } : { type, message },
      );
    },

    async loadAdvisorDefaults(projectCwd) {
      if (get().advisorDefaults[projectCwd]) return;
      try {
        const defaults = await backend.getAdvisorDefaults(projectCwd);
        set((s) => ({
          advisorDefaults: { ...s.advisorDefaults, [projectCwd]: defaults },
        }));
      } catch {
        // A missing or unreadable omp config is not an error worth a dialog —
        // the toggle just shows no inherited default.
      }
    },

    async setSessionAdvisor(tabId, advisor, advisorModel, preservedPlanMode) {
      const tab = get().rpc[tabId];
      if (tab?.status === "starting") return;
      const rec = findRecord(get().state, tabId);
      const changedLive =
        rec?.live === "live" &&
        rec.mode === "rpc-ui" &&
        (rec.advisor !== advisor || rec.advisorModel !== advisorModel);
      if (changedLive && tab) {
        const previousStatus = tab.status;
        const previousStreaming = tab.session.isStreaming;
        const previousPlan = tab.plan;
        const commandIds = new Set(
          [...tab.pendingCommands.entries()]
            .filter(([, pending]) => !pending.quiet)
            .map(([id]) => id),
        );
        const parameterActions = [
          ...(pendingSessionParameterActions.get(tabId) ?? []),
        ];
        const deadline = Date.now() + RPC_COMMAND_TIMEOUT_MS + 1_000;
        lifecycle.prepareRpcRelaunch(tabId);
        await m.pollUntil(
          tabId,
          (current) =>
            current !== undefined &&
            [...commandIds].every((id) => !current.pendingCommands.has(id)),
          RPC_COMMAND_TIMEOUT_MS + 1_000,
        );
        const remainingMs = Math.max(0, deadline - Date.now());
        if (parameterActions.length > 0 && remainingMs > 0) {
          await Promise.race([
            Promise.allSettled(parameterActions),
            new Promise<void>((resolve) => window.setTimeout(resolve, remainingMs)),
          ]);
        }
        const current = get().rpc[tabId];
        const commandsRemain =
          current === undefined ||
          [...commandIds].some((id) => current.pendingCommands.has(id));
        const parametersRemain = parameterActions.some((action) =>
          pendingSessionParameterActions.get(tabId)?.has(action),
        );
        if (commandsRemain || parametersRemain) {
          if (current) {
            m.patchRpc(tabId, {
              status: previousStatus,
              session: { ...current.session, isStreaming: previousStreaming },
              plan: previousPlan,
            });
          }
          window.alert(
            "Could not restart the advisor because an in-flight session command did not settle. The session is still running.",
          );
          return;
        }
      }
      const startInPlanMode =
        preservedPlanMode ??
        (changedLive
          ? (get().rpc[tabId]?.plan?.enabled ?? tab?.plan?.enabled ?? false)
          : false);
      try {
        await backend.setSessionAdvisor(tabId, advisor, advisorModel, startInPlanMode);
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
      if (get().rpc[tabId]?.status === "starting") return;
      const action = (async (): Promise<void> => {
        const resp = await m.runCommand(tabId, {
          type: "set_model",
          provider: model.provider,
          modelId: model.id,
        });
        if (resp === null) return;
        const selected = parseModelInfo(respData(resp)) ?? model;
        m.patchRpc(tabId, { model: selected });
        const thinkingLevel = get().rpc[tabId]?.session.thinkingLevel ?? null;
        await backend.setSessionModel(
          tabId,
          `${selected.provider}/${selected.id}`,
          thinkingLevel,
        );
      })();
      await trackSessionParameterAction(tabId, action);
    },

    async setThinkingLevel(tabId, level) {
      if (get().rpc[tabId]?.status === "starting") return;
      const action = (async (): Promise<void> => {
        const resp = await m.runCommand(tabId, {
          type: "set_thinking_level",
          level,
        });
        if (resp === null) return;
        m.patchSession(tabId, { thinkingLevel: level });
        const model = get().rpc[tabId]?.model;
        await backend.setSessionModel(
          tabId,
          model ? `${model.provider}/${model.id}` : null,
          level,
        );
      })();
      await trackSessionParameterAction(tabId, action);
    },

    async setSteeringMode(tabId, mode) {
      const resp = await m.runCommand(tabId, { type: "set_steering_mode", mode });
      if (resp === null) return;
      m.patchSession(tabId, { steeringMode: mode });
    },

    async setFollowUpMode(tabId, mode) {
      const resp = await m.runCommand(tabId, {
        type: "set_follow_up_mode",
        mode,
      });
      if (resp === null) return;
      m.patchSession(tabId, { followUpMode: mode });
    },

    async setInterruptMode(tabId, mode) {
      const resp = await m.runCommand(tabId, {
        type: "set_interrupt_mode",
        mode,
      });
      if (resp === null) return;
      m.patchSession(tabId, { interruptMode: mode });
    },

    async setAutoCompaction(tabId, enabled) {
      const resp = await m.runCommand(tabId, {
        type: "set_auto_compaction",
        enabled,
      });
      if (resp === null) return;
      m.patchSession(tabId, { autoCompactionEnabled: enabled });
    },

    async setAutoRetry(tabId, enabled) {
      await m.runCommand(tabId, { type: "set_auto_retry", enabled });
    },

    async abortRetry(tabId) {
      await m.runCommand(tabId, { type: "abort_retry" });
    },

    async compactSession(tabId) {
      m.appendItem(tabId, markerItem("compacting context", "copper"));
      const resp = await m.runCommand(tabId, { type: "compact" });
      if (resp === null) return;
      // `data.summary` is the entire compacted history — noted, never rendered.
      m.appendItem(tabId, markerItem("context compacted", "copper"));
      await m.refreshUsage(tabId);
    },

    async exportHtml(tabId) {
      const resp = await m.runCommand(tabId, { type: "export_html" });
      if (resp === null) return;
      const path = strField(respData(resp), "path");
      // The path rides the notice as data so the transcript can offer
      // open/reveal without parsing it back out of the text (issue #84).
      m.appendItem(tabId, {
        ...noticeItem(path ? `exported to ${path}` : "export finished", "info"),
        ...(path === undefined ? {} : { path }),
      });
    },

    async branchSession(tabId) {
      // Full-fidelity branch (issue #83): the backend copies the transcript
      // into a new lineage and registers it; the source session — this tab
      // included — keeps running untouched. omp's `branch` RPC is the wrong
      // tool here: it rewinds past the last user message in place.
      if (!findRecord(get().state, tabId)) return;
      try {
        const { tabId: forked } = await backend.forkSession(tabId);
        // The fork's record normally arrives by broadcast, but openSession
        // reads it from state — pull state explicitly so a slow broadcast
        // can't strand the new tab.
        set({ state: await backend.getState() });
        await get().openSession(forked);
      } catch (err) {
        alertError(err);
      }
    },

    async renameSessionTo(tabId, name) {
      const resp = await m.runCommand(tabId, { type: "set_session_name", name });
      if (resp === null) return;
      // A user-chosen name is final — the auto-titler must not overwrite it.
      m.patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
    },

    async setPlanMode(tabId, enabled) {
      if (get().rpc[tabId]?.status === "starting") return;
      // The extension owns the state; the UI never assumes the toggle took —
      // it re-renders when the extension publishes its status frame.
      // The format rides the `on` command, so the extension — not a later
      // Settings flip — decides what this session's plans are authored as.
      const format = get().state?.planFormat ?? "html";
      await m.runCommand(tabId, {
        type: "prompt",
        message: planMessage(enabled, format),
      });
    },

    executePlan: plan.executePlan,
    refinePlan: plan.refinePlan,
    deferPlanReview: plan.deferPlanReview,
    showPlanReview: plan.showPlanReview,
    dismissCatchup: catchup.dismissCatchup,
    loadPlanText: plan.loadPlanText,

    async runSlashCommand(tabId, line) {
      const message = line.startsWith("/") ? line : `/${line}`;
      if (message.trim() === "/") return;
      // omp-ui's own /new: a new live session in a new tab, not omp's in-process
      // lineage switch (that stays on the HUD's new-session button and in terminal
      // tabs' TUI). Bare command only — "/new …" still reaches omp verbatim.
      if (message.trim() === "/new") {
        const projectCwd = get().tabs.find(
          (t) => t.tabId === tabId,
        )?.projectCwd;
        // A composer only exists for a mounted tab; without one, keep the old path.
        if (projectCwd !== undefined) {
          await get().newSession(projectCwd);
          return;
        }
      }
      // omp-ui's plan toggle: omp's /plan is TUI-only, so over rpc it would
      // reach the model as literal prompt text and start an agent turn
      // (ADR-0007). Bare forms only — "/plan …" with any other argument still
      // reaches omp verbatim, and a pty tab's TUI owns its own /plan.
      const trimmed = message.trim();
      const planOn = /^\/plan(?:\s+on)?$/.test(trimmed);
      const planOff = /^\/(?:plan\s+off|no-plan)$/.test(trimmed);
      if (planOn || planOff) {
        const tab = get().tabs.find((t) => t.tabId === tabId);
        if (tab?.mode === "rpc-ui") {
          await get().setPlanMode(tabId, planOn);
          return;
        }
      }
      // omp-ui's MCP manager already owns the /mcp list surface. Bare forms
      // only — every other subcommand (reauth, add, …) works over rpc and
      // reaches omp verbatim with the normal command lifecycle.
      if (/^\/mcp(?:\s+list)?$/.test(trimmed)) {
        const projectCwd = get().tabs.find(
          (t) => t.tabId === tabId,
        )?.projectCwd;
        if (projectCwd !== undefined) {
          get().openMcpManager(projectCwd, tabId);
          return;
        }
      }
      // A first word matching no advertised command is a literal model prompt
      // (omp forwards it verbatim) — the user/assistant items tell that story;
      // it gets no command row.
      const body = trimmed.slice(1);
      const spaceAt = body.search(/\s/);
      const name = spaceAt === -1 ? body : body.slice(0, spaceAt);
      const args = spaceAt === -1 ? "" : body.slice(spaceAt + 1).trim();
      const command = get().rpc[tabId]?.commands.find(
        (c) => c.name === name || (c.aliases?.includes(name) ?? false),
      );
      if (command === undefined) {
        await m.runCommand(tabId, { type: "prompt", message });
        return;
      }
      // The acknowledgement row: makes the command visibly run - and settle -
      // while the reply itself rides command_output frames (omp 17.3.8+
      // emits them for builtin replies too).
      const item = commandItem(name, args);
      m.appendItem(tabId, item);
      const byRequest =
        m.slashCommandItems.get(tabId) ?? new Map<string, string>();
      m.slashCommandItems.set(tabId, byRequest);
      let requestId: string | undefined;
      const resp = await m.runCommand(
        tabId,
        { type: "prompt", message },
        {
          captureId: (id) => {
            requestId = id;
            byRequest.set(id, item.id);
          },
        },
      );
      const settle = (patch: Partial<CommandItem>): void => {
        if (requestId !== undefined) byRequest.delete(requestId);
        m.patchItems(tabId, (i) =>
          i.kind === "command" && i.id === item.id ? { ...i, ...patch } : i,
        );
      };
      if (resp === null) {
        // runCommand recorded the RpcFailure — mirror its text onto the row.
        settle({
          status: "failed",
          error: get().rpc[tabId]?.failure?.message ?? "command failed",
        });
        return;
      }
      const invoked = boolField(respData(resp), "agentInvoked");
      if (invoked === false) settle({ status: "done" });
      else if (invoked === true) settle({ status: "agent" });
      if (command.name === "compact") await m.refreshUsage(tabId);
      // `agentInvoked` absent (older runtime): stay running — prompt_result's
      // id mapping or the next agent_start settles it.
    },

    async setTodos(tabId, phases) {
      const resp = await m.runCommand(tabId, { type: "set_todos", phases });
      if (resp === null) return;
      m.patchRpc(tabId, {
        todos: parseTodoPhases(field(respData(resp), "todoPhases")),
      });
    },

    async refreshState(tabId) {
      const resp = await m.runCommand(
        tabId,
        { type: "get_state" },
        { quiet: true },
      );
      if (resp === null) return;
      m.applyRpcState(tabId, resp);
    },

    async refreshStats(tabId) {
      const resp = await m.runCommand(
        tabId,
        { type: "get_session_stats" },
        { quiet: true },
      );
      if (resp === null) return;
      m.patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
    },

    async refreshAdvisorStats(tabId) {
      // The extension answers by publishing over setStatus. Until omp has run a
      // turn the session is uncaptured, so it reports a live-session wait which
      // the HUD treats as "not yet" rather than an error.
      await m.runCommand(tabId, {
        type: "prompt",
        message: `/${ADVISOR_STATS_COMMAND}`,
      });
    },

    async refreshSubagents(tabId) {
      // Heartbeat-driven (every subagent_* frame) — quiet, or the busy sweeps
      // strobe for the lifetime of every spawned subagent.
      const resp = await m.runCommand(
        tabId,
        { type: "get_subagents" },
        { quiet: true },
      );
      if (resp === null) return;
      m.patchRpc(tabId, { subagents: parseSubagents(respData(resp)) });
    },

    openSubagent(tabId, key) {
      const tab = get().rpc[tabId];
      if (!tab || tab.selectedSubagent === key) return;
      m.patchRpc(tabId, { selectedSubagent: key });
      m.syncSubagentSubscription(tabId);
      // Backfill the run's full history from the subagent's own transcript
      // file, so the view shows the whole run — not just what streamed
      // since the click. Wholesale replace, the same contract as
      // loadHistory; the live event stream keeps appending after.
      // Direct rpcCommand, never runCommand: a failure (omp older than
      // v17.1.8, or an id the process forgot across a respawn) degrades to
      // the live buffer, not to a session-level failure panel.
      void get()
        .rpcCommand(
          tabId,
          { type: "get_subagent_messages", subagentId: key },
          { quiet: true },
        )
        .then((resp) => {
          // A switch or close while the read was in flight must not
          // clobber the new selection's buffer.
          if (get().rpc[tabId]?.selectedSubagent !== key) return;
          const messages = arrField(respData(resp), "messages");
          const buffers = get().rpc[tabId]?.subagentItems ?? {};
          m.patchRpc(tabId, {
            subagentItems: { ...buffers, [key]: historyToItems(messages) },
          });
        })
        .catch(() => {});
    },

    closeSubagent(tabId) {
      m.patchRpc(tabId, { selectedSubagent: null });
      m.syncSubagentSubscription(tabId);
    },

    appendNotice(tabId, text, level) {
      m.appendItem(tabId, noticeItem(text, level));
    },

  };
});

// Advisor auto-reply is an app-level setting (issue #111); each tab's
// advisorReply is a seeded snapshot of it. Any state write that flips the
// setting — a settings broadcast, init's first getState, a boot-time fetch —
// sweeps every open rpc tab. Module scope, not init(): the store module is
// evaluated once per renderer, and store tests never call the one-shot init().
useStore.subscribe((curr, prev) => {
  const next = curr.state?.advisorAutoReply;
  if (next === undefined || next === prev.state?.advisorAutoReply) return;
  let changed = false;
  const rpc: Record<string, RpcTabState> = {};
  for (const [tabId, tab] of Object.entries(curr.rpc)) {
    if (tab.advisorReply === next) {
      rpc[tabId] = tab;
    } else {
      rpc[tabId] = { ...tab, advisorReply: next };
      changed = true;
    }
  }
  if (changed) useStore.setState({ rpc });
});
