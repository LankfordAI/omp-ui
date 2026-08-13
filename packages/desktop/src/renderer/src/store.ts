import { create } from "zustand";
import type { BackendState, SessionSummary } from "@omp-ui/core/types";
import {
  isHtmlPlanPath,
  parsePlanReviewTitle,
  parsePlanStatus,
  planMessage,
  PLAN_EXECUTE,
  PLAN_REFINE,
  PLAN_STATUS_KEY,
} from "@omp-ui/core/plan";
import {
  parseAdvisorStats,
  ADVISOR_STATS_COMMAND,
  ADVISOR_STATS_KEY,
} from "@omp-ui/core/advisor-stats";
import { backend } from "./backend";
import { AdvisorReplyWatcher } from "./lib/advisor-reply";
import { formatDuration } from "./lib/duration";
import {
  extensionCancelResponse,
  routeExtensionRequest,
} from "./lib/extension-router";
import { arrField, field, numField, strField } from "./lib/fields";
import {
  PlanConcernWatcher,
  withConcerns,
  withOrchestrate,
  type PlanExecutionContext,
  type PlanExecutionOptions,
} from "./lib/plan-concerns";
import { planSeedText } from "./lib/plan-seed";
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
  type SessionRuntime,
} from "./lib/rpc-types";
import {
  generateTitleFromPrompt,
  isLowSignalTitleInput,
  isUntitled,
} from "./lib/session-title";
import { reduceSubagentFrame, subagentKey } from "./lib/subagent-events";
import { applyTheme, currentThemeId, resolveTheme } from "./lib/themes";
import { createSettingsSlice } from "./store/slices/settings";
import { createUpdatesSlice } from "./store/slices/updates";
import {
  createViewSlice,
  findRecord,
  focusOn,
  forgetFocus,
  installDesktopViewPersistence,
  pruneFocus,
  restoreDesktopView,
} from "./store/slices/view";
import type {
  BranchActivity,
  PlanRecord,
  RpcTabState,
  SidebarSessionState,
  UiStore,
} from "./store/types";
export type {
  BranchActivity,
  CompactSurface,
  DeleteConfirmation,
  PendingCommand,
  PlanRecord,
  PlanRevisionNotes,
  RpcFailure,
  RpcTabState,
  SettingsPage,
  SidebarSessionState,
  TabInfo,
  UiStore,
} from "./store/types";
export { findRecord } from "./store/slices/view";
import {
  historyToItems,
  markerItem,
  noticeItem,
  planProposalItem,
  reduceEvent,
  settleRunningTools,
  type NoticeItem,
  type RenderItem,
} from "./lib/transcript";

const RPC_COMMAND_TIMEOUT_MS = 30_000;

/** A renderer-side RPC wait expired; the process may still finish the command. */
export class RpcCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;

  constructor(command: string, timeoutMs: number) {
    super(
      `RPC command "${command}" timed out after its ${formatDuration(timeoutMs)} response budget`,
    );
    this.name = "RpcCommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
  }
}

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
    stallCount: 0,
    extensionQueue: [],
    busy: false,
    failure: undefined,
    initialPrompt: null,
    hasRenamed: false,
    plan: null,
    planReview: null,
    planText: null,
    planHtml: null,
    planDeferred: false,
    plans: [],
    advisorStats: null,
    advisorReply,
  };
}

export function deriveSidebarSessionState(
  summary: SessionSummary,
  rpc: RpcTabState | undefined,
  exitCode: number | undefined,
): SidebarSessionState {
  if (summary.live !== "live") return summary.live;
  if (exitCode !== undefined) return "dormant";
  if (summary.mode === "pty" || !rpc) return "live";
  if (rpc.status === "error") return "error";
  if (rpc.planReview !== null || rpc.extensionQueue.length > 0)
    return "awaiting-answer";
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

// One IPC data listener total; each TerminalTab registers its writer here.
const termWriters = new Map<string, (data: Uint8Array) => void>();
export function registerTermWriter(
  tabId: string,
  cb: (data: Uint8Array) => void,
): () => void {
  termWriters.set(tabId, cb);
  return () => {
    termWriters.delete(tabId);
  };
}

// One IPC data listener total; each ShellDrawer registers its writer here.
const shellWriters = new Map<string, (data: Uint8Array) => void>();
export function registerShellWriter(
  tabId: string,
  cb: (data: Uint8Array) => void,
): () => void {
  shellWriters.set(tabId, cb);
  return () => {
    shellWriters.delete(tabId);
  };
}

/** pi-ai's StreamTimeoutError classifier bit (Flag.Timeout, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_TIMEOUT = 0x0004_0000;
/** Every built-in provider's stall/first-event watchdog message (pi-ai providers/*). */
const STALL_MESSAGE_RE =
  /stream (stalled|timed out) while waiting for the (next|first) event/i;

/**
 * The latest renderer-observed request/model progress checkpoint. Local tool
 * execution is deliberately excluded: it cannot reset a provider-stream clock.
 */
function streamCheckpointLabel(frame: object): string | null {
  const type = "type" in frame ? frame.type : undefined;
  switch (type) {
    case "turn_start":
      return "turn started";
    case "message_start":
      return strField(field(frame, "message"), "role") === "assistant"
        ? "response opened"
        : null;
    case "message_update": {
      switch (strField(field(frame, "assistantMessageEvent"), "type")) {
        case "text_delta":
          return "streaming text";
        case "thinking_delta":
          return "streaming thinking";
        case "toolcall_start":
        case "toolcall_delta":
          return "streaming tool-call arguments";
        case "toolcall_end":
          return "tool-call arguments complete";
        default:
          return null;
      }
    }
    default:
      return null;
  }
}

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

function dropExited(
  exited: Record<string, number>,
  tabId: string,
): Record<string, number> {
  const next = { ...exited };
  delete next[tabId];
  return next;
}

function alertError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
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

interface BranchRefreshRuntime {
  state: {
    fetchUpstream: boolean;
    pendingNetwork: boolean;
  };
  promise: Promise<void>;
}

const branchRefreshes = new Map<string, BranchRefreshRuntime>();

/** Shared empty buffer so identity comparison detects "no items yet". */
const EMPTY_BUFFER: RenderItem[] = [];

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
function upsertPlan(
  records: PlanRecord[],
  title: string,
  key: string,
): PlanRecord[] {
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
function settlePlan(
  records: PlanRecord[],
  key: string,
  status: PlanRecord["status"],
): PlanRecord[] {
  return records.map((r) => (r.key === key ? { ...r, status } : r));
}

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
  const patchRpc = (tabId: string, patch: Partial<RpcTabState>): void => {
    set((s) => {
      const tab = s.rpc[tabId];
      if (!tab) return s;
      return { rpc: { ...s.rpc, [tabId]: { ...tab, ...patch } } };
    });
  };

  /**
   * Per-tab pending transcript commit (issue #187). AgentSessionEvent frames
   * are reduced eagerly onto the batch's `items` — the reduce is cheap and the
   * watchers (plan concerns, advisor reply) read through {@link effectiveItems},
   * so semantics stay frame-exact — but the Zustand commit that re-renders the
   * transcript is coalesced to one per animation frame, with a timer fallback
   * so a hidden window (rAF paused) still converges. One commit per burst
   * instead of one per frame is what keeps the renderer able to service input.
   */
  const TRANSCRIPT_FLUSH_MS = 50;
  interface TranscriptBatch {
    items: RenderItem[];
    raf?: number;
    timer?: number;
  }
  const transcriptBatches = new Map<string, TranscriptBatch>();

  /** Committed items plus anything reduced but not yet flushed. */
  const effectiveItems = (tabId: string): RenderItem[] =>
    transcriptBatches.get(tabId)?.items ?? get().rpc[tabId]?.items ?? [];

  const cancelTranscriptBatch = (tabId: string): void => {
    const batch = transcriptBatches.get(tabId);
    if (!batch) return;
    transcriptBatches.delete(tabId);
    if (
      batch.raf !== undefined &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(batch.raf);
    }
    if (batch.timer !== undefined) window.clearTimeout(batch.timer);
  };

  const flushTranscriptBatch = (tabId: string): void => {
    const batch = transcriptBatches.get(tabId);
    if (!batch) return;
    cancelTranscriptBatch(tabId);
    const tab = get().rpc[tabId];
    if (!tab || tab.items === batch.items) return;
    patchRpc(tabId, { items: batch.items });
  };

  const queueTranscriptFrame = (
    tabId: string,
    frame: unknown,
    stall: NoticeItem | null,
  ): void => {
    if (!get().rpc[tabId]) return;
    const reduced = reduceEvent(effectiveItems(tabId), frame);
    const items = stall ? [...reduced, stall] : reduced;
    let batch = transcriptBatches.get(tabId);
    if (batch) {
      batch.items = items;
      return;
    }
    batch = { items };
    transcriptBatches.set(tabId, batch);
    if (typeof window.requestAnimationFrame === "function") {
      batch.raf = window.requestAnimationFrame(() =>
        flushTranscriptBatch(tabId),
      );
    } else {
      batch.timer = window.setTimeout(
        () => flushTranscriptBatch(tabId),
        TRANSCRIPT_FLUSH_MS,
      );
    }
  };

  const patchBranchActivity = (
    projectCwd: string,
    patch: Partial<BranchActivity>,
  ): void => {
    set((s) => {
      const current = s.branchActivity[projectCwd];
      return {
        branchActivity: {
          ...s.branchActivity,
          [projectCwd]: {
            refreshing: patch.refreshing ?? current?.refreshing ?? false,
            pulling: patch.pulling ?? current?.pulling ?? false,
          },
        },
      };
    });
  };

  const prepareRpcRelaunch = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    // A flush queued by the dying process must not land in the fresh state.
    cancelTranscriptBatch(tabId);
    patchRpc(tabId, {
      status: "starting",
      session: { ...tab.session, isStreaming: false },
      extensionQueue: [],
      planReview: null,
      planText: null,
      planHtml: null,
      planDeferred: false,
      failure: undefined,
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
   * structured failure surfaces instead of vanishing into a swallowed catch.
   * Resolves to the response frame, or `null` — which a real response never is
   * — on failure.
   */
  const runCommand = async (
    tabId: string,
    cmd: Record<string, unknown>,
    opts?: { quiet?: boolean },
  ): Promise<unknown> => {
    const command = typeof cmd.type === "string" ? cmd.type : "unknown";
    try {
      const resp = await get().rpcCommand(tabId, cmd, opts);
      // Only an explicit, user-visible success retires a transient failure.
      // Background refreshes must not make a diagnostic disappear, and no
      // command response may hide a fatal boot/process failure.
      const tab = get().rpc[tabId];
      if (
        opts?.quiet !== true &&
        tab?.failure !== undefined &&
        !tab.failure.fatal
      ) {
        patchRpc(tabId, { failure: undefined });
      }
      return resp;
    } catch (err) {
      const tab = get().rpc[tabId];
      if (tab?.failure?.fatal) return null;
      const timedOut = err instanceof RpcCommandTimeoutError;
      const message = err instanceof Error ? err.message : String(err);
      const liveState = findRecord(get().state, tabId)?.live;
      patchRpc(tabId, {
        failure: {
          message: timedOut
            ? message
            : `RPC command "${command}" failed: ${message}`,
          kind: "command",
          fatal: false,
          command,
          ...(timedOut ? { timeoutMs: err.timeoutMs } : {}),
          ...(tab ? { sessionStatus: tab.status } : {}),
          ...(liveState !== undefined ? { liveState } : {}),
          recovery: timedOut
            ? "Prompt-like commands may still complete in the live session. Refresh state before continuing; resending can duplicate work."
            : "Refresh state to confirm the live session before retrying.",
        },
      });
      return null;
    }
  };

  const appendItem = (tabId: string, item: RenderItem): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    // A pending transcript batch owns the next commit — append onto it so the
    // item keeps its arrival position instead of being overwritten by the flush.
    const batch = transcriptBatches.get(tabId);
    if (batch) {
      batch.items = [...batch.items, item];
      return;
    }
    patchRpc(tabId, { items: [...tab.items, item] });
  };

  /** Maps every item; patches only when at least one item actually changed. */
  const patchItems = (
    tabId: string,
    map: (item: RenderItem) => RenderItem,
  ): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    const base = transcriptBatches.get(tabId)?.items ?? tab.items;
    const items = base.map(map);
    if (!items.some((item, i) => item !== base[i])) return;
    const batch = transcriptBatches.get(tabId);
    if (batch) {
      batch.items = items;
      return;
    }
    patchRpc(tabId, { items });
  };

  /**
   * Sends set_subagent_subscription when — and only when — the tab's desired
   * level differs from what the process last heard: "events" while an Agents
   * pane detail view is open, "progress" otherwise (issue #63).
   */
  const syncSubagentSubscription = (tabId: string): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    const level = tab.selectedSubagent ? "events" : "progress";
    if (tab.subagentLevel === level) return;
    tab.subagentLevel = level;
    void runCommand(
      tabId,
      { type: "set_subagent_subscription", level },
      { quiet: true },
    );
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

  const patchSession = (
    tabId: string,
    patch: Partial<SessionRuntime>,
  ): void => {
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
    patchRpc(tabId, {
      planReview: null,
      planText: null,
      planHtml: null,
      planDeferred: false,
    });
    return true;
  };

  /**
   * Guarantees the live session is in Build before the implementation prompt
   * runs (issue #165). The execute verdict already exits plan mode in-process
   * inside the extension's proposal handler; this waits for that exit's
   * status frame, and if it never surfaces, drives the mode off directly
   * with the mode command. Bounded: a stuck session must not delay
   * implementation indefinitely. `plan == null` means no extension status was
   * ever published — the session was never armed, so Build holds by
   * construction.
   */
  const ensureBuildMode = async (tabId: string): Promise<void> => {
    const build = (t: RpcTabState | undefined) =>
      t?.plan == null ||
      t?.plan.enabled === false ||
      get().exited[tabId] !== undefined;
    await pollUntil(tabId, build);
    if (get().rpc[tabId]?.plan?.enabled !== true) return;
    // The verdict's in-process exit never surfaced — force it. Fire-and-forget:
    // the extension's status frame releases the wait, and a failed command must
    // not delay or abort dispatch (issue #165).
    void get()
      .setPlanMode(tabId, false)
      .catch(() => {});
    await pollUntil(tabId, build, 5_000);
  };

  /** Sends the implementation prompt for a settled execute verdict. */
  const dispatchExecutePlan = (
    tabId: string,
    context: PlanExecutionContext,
    planText: string | null,
    concerns: string | null,
    options?: PlanExecutionOptions,
  ): void => {
    const message = withOrchestrate(
      withConcerns(EXECUTION_PROMPT, concerns),
      options?.orchestrate === true,
    );
    if (context === "fresh") {
      void spawnFreshImplementation(tabId, planText, concerns, options);
      return;
    }
    // What the receiving session runs today — only staged *changes* are applied.
    const tab = get().rpc[tabId];
    const rec = findRecord(get().state, tabId);
    const stagedModel = options?.model ?? null;
    const modelChanged =
      stagedModel !== null &&
      `${stagedModel.provider}/${stagedModel.id}` !==
        (tab?.model ? `${tab.model.provider}/${tab.model.id}` : null);
    const thinkingChanged =
      options?.thinkingLevel != null &&
      options.thinkingLevel !== (tab?.session.thinkingLevel ?? null);
    const advisorChanged =
      options?.advisor !== undefined &&
      rec !== undefined &&
      (rec.advisor !== options.advisor ||
        (rec.advisorModel ?? null) !== (options.advisorModel ?? null));

    if (advisorChanged) {
      // omp binds the advisor at process start, so the change is a relaunch and
      // the implementation prompt must wait for the booted session — a queued
      // follow-up would die with the old process. The plan turn ends first so
      // the kill cannot orphan the verdict's tool result.
      void (async () => {
        await pollUntil(tabId, (t) => (t?.status ?? "ready") !== "running");
        if (modelChanged) await get().setModel(tabId, stagedModel!);
        if (thinkingChanged)
          await get().setThinkingLevel(tabId, options!.thinkingLevel!);
        await get().setSessionAdvisor(
          tabId,
          options!.advisor!,
          options!.advisorModel ?? null,
        );
        // A failed relaunch alerts and leaves the tab dead — never prompt it.
        await pollUntil(
          tabId,
          (t) =>
            t?.status === "ready" ||
            t?.status === "error" ||
            get().exited[tabId] !== undefined,
        );
        if (get().rpc[tabId]?.status !== "ready") return;
        if (context === "compacted") await get().compactSession(tabId);
        await ensureBuildMode(tabId);
        await get().sendPrompt(tabId, message, "prompt");
      })();
      return;
    }

    void (async () => {
      if (modelChanged) await get().setModel(tabId, stagedModel!);
      if (thinkingChanged)
        await get().setThinkingLevel(tabId, options!.thinkingLevel!);
      if (context === "compacted") {
        // `compact` runs between turns, so the just-accepted plan turn must end
        // before compacting, then prompt the implementer.
        await pollUntil(tabId, (t) => (t?.status ?? "ready") !== "running");
        await get().compactSession(tabId);
        await ensureBuildMode(tabId);
        await get().sendPrompt(tabId, message, "prompt");
        return;
      }
      // Existing context: followUp queues the prompt until the current turn
      // ends, so it races nothing — the implementer runs in this same session.
      // The gate only yields for a genuinely armed session: an unarmed one is
      // already Build and must dispatch in the same synchronous frame the
      // verdict lands in (issue #165).
      if (get().rpc[tabId]?.plan?.enabled === true)
        await ensureBuildMode(tabId);
      await get().sendPrompt(tabId, message, "follow_up");
    })();
  };

  /**
   * Holds an approve verdict's dispatch for the drafting turn's advisor
   * review. This is the store's whole concern-wait surface: the watcher owns
   * the per-tab timers and the single-source settle/fold, and the store just
   * begins, feeds frames, and cancels on teardown. See lib/plan-concerns.ts
   * for the timing and the card/tool-note dedup.
   */
  const concernWatcher = new PlanConcernWatcher({
    getItems: effectiveItems,
    onNotice: (tabId, text) => appendItem(tabId, noticeItem(text, "info")),
    onDispatch: (tabId, intent, concerns) => {
      // The no-double-dispatch guarantee. concernWatcher.feed settles
      // synchronously inside the frame handler, so by the time
      // advisorReplyWatcher.feed runs on that same frame `isActive` already
      // reads false — this reset is what stops the reply watcher from
      // separately answering the very review this dispatch just folded in.
      advisorReplyWatcher.reset(tabId);
      dispatchExecutePlan(
        tabId,
        intent.context,
        intent.planText,
        concerns,
        intent.options,
      );
    },
  });

  /**
   * Answers an advisor review that lands after `agent finished`, when nothing in
   * the idle session would carry it back to the main model (issue #104). Same
   * collection core as the plan fold; the watcher owns the batch window, the
   * transcript baseline, and the consecutive-reply guard.
   */
  const advisorReplyWatcher = new AdvisorReplyWatcher({
    getItems: effectiveItems,
    canReply: (tabId) => {
      const tab = get().rpc[tabId];
      if (!tab) return false;
      if (!tab.advisorReply) return false;
      // "ready" only: starting/running/error are all no-prompt states, and a
      // running turn already receives the advisor's notes in its own context.
      if (tab.status !== "ready") return false;
      if (get().exited[tabId] !== undefined) return false;
      // The agent is blocked inside a plan proposal — a follow-up would queue
      // behind a gate that only the user can resolve.
      if (tab.planReview !== null || tab.planDeferred) return false;
      // ADR-0009's fold owns this very review and dispatches it itself.
      if (concernWatcher.isActive(tabId)) return false;
      return true;
    },
    onNotice: (tabId, text, level) =>
      appendItem(tabId, noticeItem(text, level)),
    onReply: (tabId, message) => {
      void get().sendPrompt(tabId, message, "advisor_reply");
    },
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
    advisorReplyWatcher.cancel(tabId);
    cancelTranscriptBatch(tabId);
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
      return {
        rpc,
        tabs,
        activeTabId,
        focusedTabByProject: forgetFocus(s.focusedTabByProject, tabId, tabs),
        exited: dropExited(s.exited, tabId),
      };
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
    options?: PlanExecutionOptions,
  ): Promise<void> => {
    const rec = findRecord(get().state, srcTabId);
    if (!rec) return;
    const projectCwd = rec.projectCwd;
    // A staged tuple (the modal always sends one) wins over the project's
    // last-used defaults; legacy callers keep the fallback chain.
    await get().loadAdvisorDefaults(projectCwd);
    const defaults = get().advisorDefaults[projectCwd];
    const project = get().state?.projects.find(
      (g) => g.project.path === projectCwd,
    )?.project;
    const advisor =
      options?.advisor ??
      project?.lastAdvisor ??
      get().state?.defaultAdvisor ??
      defaults?.enabled ??
      false;
    const advisorModel =
      options?.advisor !== undefined
        ? (options.advisorModel ?? null)
        : (project?.lastAdvisorModel ?? defaults?.model ?? null);
    let freshId: string;
    try {
      ({ tabId: freshId } = await backend.spawnSession({
        projectCwd,
        mode: "rpc-ui",
        advisor,
        advisorModel,
        cols: 80,
        rows: 24,
        startInPlanMode: false,
      }));
    } catch (err) {
      alertError(err);
      return;
    }
    set((s) => ({
      tabs: [
        ...s.tabs,
        { tabId: freshId, mode: "rpc-ui", projectCwd, hidden: false },
      ],
      ...focusOn(s, freshId, projectCwd),
      exited: dropExited(s.exited, freshId),
    }));
    appendItem(
      srcTabId,
      noticeItem(
        "plan approved — implementation dispatched to a fresh session",
        "info",
      ),
    );
    await pollUntil(freshId, (t) => t?.status === "ready");
    // Staged main-model parameters ride the composer's own actions, so they
    // persist into session parameter memory exactly like a composer change.
    const stagedModel = options?.model ?? null;
    if (stagedModel !== null) {
      const cur = get().rpc[freshId]?.model;
      if (
        `${stagedModel.provider}/${stagedModel.id}` !==
        (cur ? `${cur.provider}/${cur.id}` : null)
      ) {
        await get().setModel(freshId, stagedModel);
      }
    }
    if (
      options?.thinkingLevel != null &&
      options.thinkingLevel !==
        (get().rpc[freshId]?.session.thinkingLevel ?? null)
    ) {
      await get().setThinkingLevel(freshId, options.thinkingLevel);
    }
    const lead = "A plan was approved for this project. Implement it now.";
    const body = planSeedText(planText);
    const seed = body
      ? `${lead}\n\n${body}\n\nProceed with the implementation.`
      : lead;
    await get().sendPrompt(
      freshId,
      withOrchestrate(
        withConcerns(seed, concerns),
        options?.orchestrate === true,
      ),
      "prompt",
    );
  };

  const applyRpcState = (tabId: string, resp: unknown): void => {
    const tab = get().rpc[tabId];
    const payload = respData(resp);
    if (!tab || payload === null || typeof payload !== "object") return;
    const model = parseModelInfo(field(payload, "model")) ?? tab.model;
    const session = parseSessionRuntime(payload, tab.session);
    patchRpc(tabId, {
      todos:
        "todoPhases" in payload
          ? parseTodoPhases(field(payload, "todoPhases"))
          : tab.todos,
      model,
      session,
    });
    if (model) {
      void backend
        .setSessionModel(
          tabId,
          `${model.provider}/${model.id}`,
          session.thinkingLevel,
        )
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
    if (now - (lastUsageRefresh.get(tabId) ?? -Infinity) < USAGE_REFRESH_MS)
      return;
    lastUsageRefresh.set(tabId, now);
    void get()
      .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
      .then((resp) => applyRpcState(tabId, resp))
      .catch(() => {});
    void get()
      .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
      .then((resp) =>
        patchRpc(tabId, { stats: parseSessionStats(respData(resp)) }),
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
          .then((resp) => applyRpcState(tabId, resp))
          .catch(() => {});
      }, QUEUE_SETTLE_REFRESH_MS),
    );
  };

  const loadHistory = async (tabId: string): Promise<void> => {
    const resp = await get().rpcCommand(tabId, { type: "get_messages" });
    // History replaces the transcript wholesale — a batch reduced from the
    // pre-history items would clobber it on the next flush. Per-agent marker
    // memory must not outlive the render items it was deduping against.
    cancelTranscriptBatch(tabId);
    get().rpc[tabId]?.subagentMarkers?.clear();
    patchRpc(tabId, {
      items: historyToItems(arrField(respData(resp), "messages")),
    });
    // A resumed transcript's advisories are history, not a live review: the
    // baseline moves past them so nothing here is ever answered.
    advisorReplyWatcher.reset(tabId);
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
    state: null,
    exited: {},
    shellExited: {},
    rpc: {},
    consoleOpen: {},
    branches: {},
    branchActivity: {},
    branchDiffRevision: {},
    advisorDefaults: {},
    deleteConfirmation: null,

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
      });
      backend.onPtyData((tabId, data) => termWriters.get(tabId)?.(data));
      backend.onPtyExit((tabId, code) => {
        // An rpc-mode omp that dies mid-tool sends no agent_end or
        // omp_ui_error frame — this exit is the only signal, so running
        // tool cards are settled here (issue #93). Settle from the effective
        // items: a batched stream commit may still be pending, and the dead
        // process's final frames must not be lost (issue #187).
        const before = get().rpc[tabId];
        const settled = before
          ? settleRunningTools(effectiveItems(tabId))
          : undefined;
        cancelTranscriptBatch(tabId);
        set((s) => {
          const rpc =
            before && settled !== undefined && settled !== before.items
              ? { ...s.rpc, [tabId]: { ...before, items: settled } }
              : s.rpc;
          return { exited: { ...s.exited, [tabId]: code }, rpc };
        });
      });
      backend.onShellData((tabId, data) => shellWriters.get(tabId)?.(data));
      backend.onShellExit((tabId, code) => {
        set((s) => ({ shellExited: { ...s.shellExited, [tabId]: code } }));
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
      await restoreDesktopView(api);
      installDesktopViewPersistence(api);
    },

    async restartSession(tabId) {
      const rec = findRecord(get().state, tabId);
      try {
        if (rec?.live === "live" && rec.mode === "rpc-ui")
          prepareRpcRelaunch(tabId);
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
        !window.confirm(
          `Remove project ${path} and its session records? Files on disk are kept.`,
        )
      )
        return;
      try {
        await backend.removeProject(path);
      } catch (err) {
        alertError(err);
      }
    },

    // No optimistic update: the `stateChanged` broadcast replaces `state`
    // authoritatively, exactly like removeProject.
    async moveProject(projectPath, beforePath) {
      try {
        await backend.moveProject(projectPath, beforePath);
      } catch (err) {
        alertError(err);
      }
    },

    async toggleFavorite(key) {
      await backend.toggleFavorite(key);
    },

    async newSession(projectCwd, modeOverride) {
      const mode = modeOverride ?? get().state?.defaultMode ?? "pty";
      // Carry the project's complete last-used advisor tuple into the new
      // session. Before any explicit choice, the app's own default decides;
      // omp's configured default only seeds while the app is not booted.
      await get().loadAdvisorDefaults(projectCwd);
      const defaults = get().advisorDefaults[projectCwd];
      const project = get().state?.projects.find(
        (g) => g.project.path === projectCwd,
      )?.project;
      const lastAdvisorModel =
        project?.lastAdvisorModel ?? defaults?.model ?? null;
      const advisor =
        project?.lastAdvisor ??
        get().state?.defaultAdvisor ??
        defaults?.enabled ??
        false;
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
          ...focusOn(s, tabId, projectCwd),
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
          tabs: s.tabs.map((t) =>
            t.tabId === tabId ? { ...t, hidden: false } : t,
          ),
          ...focusOn(
            s,
            tabId,
            s.tabs.find((t) => t.tabId === tabId)?.projectCwd,
          ),
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
          tabs: [
            ...s.tabs,
            {
              tabId,
              mode: rec.mode,
              projectCwd: rec.projectCwd,
              hidden: false,
            },
          ],
          ...focusOn(s, tabId, rec.projectCwd),
          exited: dropExited(s.exited, tabId),
        }));
      } catch (err) {
        alertError(err);
      }
    },

    focusTab(tabId) {
      set((s) => ({
        tabs: s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: false } : t,
        ),
        ...focusOn(s, tabId, s.tabs.find((t) => t.tabId === tabId)?.projectCwd),
      }));
    },

    hideTab(tabId) {
      set((s) => {
        const tabs = s.tabs.map((t) =>
          t.tabId === tabId ? { ...t, hidden: true } : t,
        );
        let activeTabId = s.activeTabId;
        if (activeTabId === tabId) {
          const visible = tabs.filter((t) => !t.hidden);
          activeTabId =
            visible.length > 0 ? visible[visible.length - 1]!.tabId : null;
        }
        return {
          tabs,
          activeTabId,
          focusedTabByProject: forgetFocus(s.focusedTabByProject, tabId, tabs),
        };
      });
    },

    async terminate(tabId) {
      if (
        !window.confirm(
          "Terminate the running agent? The session stays resumable.",
        )
      )
        return;
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
          tabs: s.tabs.map((t) =>
            t.tabId === tabId ? { ...t, hidden: false } : t,
          ),
          ...focusOn(s, tabId, rec.projectCwd),
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
        advisorReplyWatcher.cancel(tabId);
        cancelTranscriptBatch(tabId);
        // A re-boot must not slam the Agents pane's drill-down shut: the open
        // detail view and the retained buffers behind it survive the process
        // restart, and the subscription re-escalates after boot (issue #63).
        const prior = get().rpc[tabId];
        patchRpc(tabId, {
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
              applyRpcState(tabId, resp);
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
              patchRpc(tabId, {
                availableModels: parseModelList(respData(resp)),
              });
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
          syncSubagentSubscription(tabId);
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
          patchRpc(tabId, {
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
          patchRpc(tabId, { status: "ready" });
        }
      } catch (err) {
        const liveState = findRecord(get().state, tabId)?.live;
        patchRpc(tabId, {
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
          const runtime = get().rpc[tabId];
          const liveState = findRecord(get().state, tabId)?.live;
          const details = {
            tabId,
            commandId: id,
            command,
            timeoutMs,
            elapsedMs: Date.now() - startedAt,
            pendingCommandCount: tab.pendingCommands.size,
            sessionStatus: runtime?.status ?? null,
            isStreaming: runtime?.session.isStreaming ?? null,
            liveState: liveState ?? null,
          };
          console.warn("[rpc] command timeout", details);
          reject(new RpcCommandTimeoutError(command, timeoutMs));
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
          if (!pending) return;
          clearTimeout(pending.timer);
          tab.pendingCommands.delete(id!);
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
          patchRpc(tabId, { session: parseSessionRuntime(frame, tab.session) });
          return;
        case "config_update": {
          const model = parseModelInfo(field(frame, "model")) ?? tab.model;
          const session = parseSessionRuntime(frame, tab.session);
          patchRpc(tabId, { model, session });
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
          patchRpc(tabId, { commands: parseCommandList(frame) });
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
            appendItem(tabId, markerItem(label, "copper"));
          }
          // Per-agent buffer for the Agents pane drill-down (issue #63).
          // Identity return means the frame added nothing.
          const buffers = tab.subagentItems ?? {};
          const prev = buffers[key] ?? EMPTY_BUFFER;
          const next = reduceSubagentFrame(prev, frame);
          if (next !== prev) {
            patchRpc(tabId, { subagentItems: { ...buffers, [key]: next } });
          }
          pulseSubagents(tabId);
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
            const planItem = planProposalItem(
              review.title,
              review.planFilePath,
              review.planAbsPath,
            );
            appendItem(tabId, planItem);
            void get().loadPlanText(tabId, review.planAbsPath, planItem.id);
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
            if (entry.text === undefined || entry.text === "")
              delete extensionStatus[entry.key];
            else extensionStatus[entry.key] = entry.text;
            patchRpc(tabId, { extensionStatus });
          }
          backend.rpcSend(
            tabId,
            extensionCancelResponse("id" in frame ? frame.id : undefined),
          );
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
          const liveState = findRecord(get().state, tabId)?.live;
          // The process died mid-tool, so no agent_end will settle running
          // cards. Settle the effective items — frames still pending in the
          // batch are part of the transcript up to the failure (issue #187).
          const settledItems = settleRunningTools(effectiveItems(tabId));
          cancelTranscriptBatch(tabId);
          patchRpc(tabId, {
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
          const checkpointLabel = streamCheckpointLabel(frame);
          if (checkpointLabel !== null) {
            tab.streamCheckpoint = { at: Date.now(), label: checkpointLabel };
          }
          // The AgentSessionEvent stream — the actual transcript. Reduction is
          // eager (frame-exact for the watchers below) but the render commit is
          // coalesced — one Zustand set per burst instead of per frame, so the
          // renderer keeps servicing input mid-stream (issue #187).
          const stall =
            type === "auto_retry_start" ? stallNotice(tab, frame) : null;
          queueTranscriptFrame(tabId, frame, stall);
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
              patchSession(tabId, { thinkingLevel: level });
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
            patchRpc(tabId, { status: "running" });
            const pending = queueSettleTimers.get(tabId);
            if (pending !== undefined) {
              window.clearTimeout(pending);
              queueSettleTimers.delete(tabId);
            }
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
            if (tab.initialPrompt && !tab.hasRenamed)
              get().renameSession(tabId);

            // Refresh todoPhases/contextUsage/isStreaming after each agent run.
            void get()
              .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
              .then((resp) => {
                applyRpcState(tabId, resp);
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
      patchRpc(tabId, {
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
          ? await backend
              .generateTitle(projectCwd, prompt)
              .catch((err: unknown) => {
                console.warn("[session-rename] model titling failed:", err);
                return null;
              })
          : null;
        // The tab can die or be renamed by hand while the model thinks.
        const current = get().rpc[tabId];
        if (!current || current.initialPrompt !== prompt) return;
        const name = modelTitle ?? generateTitleFromPrompt(prompt);
        try {
          await get().rpcCommand(
            tabId,
            { type: "set_session_name", name },
            { quiet: true },
          );
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
      if (route === "advisor_reply") {
        // omp-ui's own answer to a late review: it must not title the session and
        // must not re-arm the loop guard it was dispatched by.
      } else {
        // Titling reads the first substantive prompt, whichever route it took.
        get().setInitialPrompt(tabId, message);
        advisorReplyWatcher.reset(tabId);
      }
      // Always the `prompt` frame, never `steer`/`follow_up`: only AgentSession.prompt
      // builds the magic-keyword notices (orchestrate/ultrathink/workflowz), so those
      // frames would silently drop the keyword mid-run. `streamingBehavior` is what
      // omp's own TUI passes, and omp ignores it while the agent is idle.
      //
      // An advisor reply rides followUp, not steer: if a turn started between the
      // settle and this send, the reply queues behind it instead of interrupting.
      const streamingBehavior =
        route === "follow_up" || route === "advisor_reply"
          ? "followUp"
          : "steer";
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
      advisorReplyWatcher.reset(tabId);
      const type = "abort_and_prompt";
      await runCommand(
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
      const resp = await runCommand(tabId, {
        type: "set_thinking_level",
        level,
      });
      if (resp === null) return;
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
      const resp = await runCommand(tabId, {
        type: "set_follow_up_mode",
        mode,
      });
      if (resp === null) return;
      patchSession(tabId, { followUpMode: mode });
    },

    async setInterruptMode(tabId, mode) {
      const resp = await runCommand(tabId, {
        type: "set_interrupt_mode",
        mode,
      });
      if (resp === null) return;
      patchSession(tabId, { interruptMode: mode });
    },

    async setAutoCompaction(tabId, enabled) {
      const resp = await runCommand(tabId, {
        type: "set_auto_compaction",
        enabled,
      });
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
      // The path rides the notice as data so the transcript can offer
      // open/reveal without parsing it back out of the text (issue #84).
      appendItem(tabId, {
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
      const resp = await runCommand(tabId, { type: "set_session_name", name });
      if (resp === null) return;
      // A user-chosen name is final — the auto-titler must not overwrite it.
      patchRpc(tabId, { hasRenamed: true, initialPrompt: null });
    },

    async setPlanMode(tabId, enabled) {
      // The extension owns the state; the UI never assumes the toggle took —
      // it re-renders when the extension publishes its status frame.
      // The format rides the `on` command, so the extension — not a later
      // Settings flip — decides what this session's plans are authored as.
      const format = get().state?.planFormat ?? "html";
      await runCommand(tabId, {
        type: "prompt",
        message: planMessage(enabled, format),
      });
    },

    executePlan(tabId, context, options) {
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
        patchItems(tabId, (i) =>
          i.kind === "plan" &&
          i.planFilePath === planKey &&
          i.status === "pending"
            ? { ...i, status: "executed" }
            : i,
        );
      }
      // The drafting turn's review lands after the verdict, so hold dispatch
      // for it when the user wants the advisor's concerns actioned. Execute
      // only: the execute ToolResult tells the agent to stop and wait, so this
      // turn ends and its review genuinely follows — refine keeps the planner
      // in the same turn and is left immediate. The watcher owns the gate; the
      // store just checks its own advisor config for whether a review is coming.
      const configured = get().rpc[tabId]?.advisorStats?.configured === true;
      if ((options?.addressAdvisor ?? true) && configured) {
        concernWatcher.begin(tabId, { context, planText, options });
        return;
      }
      dispatchExecutePlan(tabId, context, planText, null, options);
    },

    refinePlan(tabId, notes) {
      const planKey = get().rpc[tabId]?.planReview?.request.planFilePath;
      if (!answerPlanSelect(tabId, PLAN_REFINE)) return;
      if (planKey) {
        patchRpc(tabId, {
          plans: settlePlan(get().rpc[tabId]?.plans ?? [], planKey, "refined"),
        });
        patchItems(tabId, (i) =>
          i.kind === "plan" &&
          i.planFilePath === planKey &&
          i.status === "pending"
            ? { ...i, status: "refined" }
            : i,
        );
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

    async loadPlanText(tabId, absPath, itemId) {
      if (!absPath) {
        patchRpc(tabId, { planText: null, planHtml: null });
        return;
      }
      try {
        const text = await backend.readPlanFile(tabId, absPath);
        // One file, one read: the html plan IS the plan, so `planHtml` is the
        // render-mode flag rather than a second document (ADR-0014).
        patchRpc(tabId, {
          planText: text,
          planHtml: isHtmlPlanPath(absPath) ? text : null,
        });
        if (itemId !== undefined) {
          patchItems(tabId, (i) =>
            i.kind === "plan" && i.id === itemId ? { ...i, text } : i,
          );
        }
      } catch {
        // The pane falls back to the plan's path — a failed read must never
        // strand the review, because the agent is waiting on the verdict.
        patchRpc(tabId, { planText: null, planHtml: null });
      }
    },

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
      const planLine = message.trim();
      const planOn = /^\/plan(?:\s+on)?$/.test(planLine);
      const planOff = /^\/(?:plan\s+off|no-plan)$/.test(planLine);
      if (planOn || planOff) {
        const tab = get().tabs.find((t) => t.tabId === tabId);
        if (tab?.mode === "rpc-ui") {
          await get().setPlanMode(tabId, planOn);
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
      patchRpc(tabId, {
        todos: parseTodoPhases(field(respData(resp), "todoPhases")),
      });
    },

    async refreshState(tabId) {
      const resp = await runCommand(
        tabId,
        { type: "get_state" },
        { quiet: true },
      );
      if (resp === null) return;
      applyRpcState(tabId, resp);
    },

    async refreshStats(tabId) {
      const resp = await runCommand(
        tabId,
        { type: "get_session_stats" },
        { quiet: true },
      );
      if (resp === null) return;
      patchRpc(tabId, { stats: parseSessionStats(respData(resp)) });
    },

    async refreshAdvisorStats(tabId) {
      // The extension answers by publishing over setStatus. Until omp has run a
      // turn the session is uncaptured, so it reports a live-session wait which
      // the HUD treats as "not yet" rather than an error.
      await runCommand(tabId, {
        type: "prompt",
        message: `/${ADVISOR_STATS_COMMAND}`,
      });
    },

    async refreshSubagents(tabId) {
      // Heartbeat-driven (every subagent_* frame) — quiet, or the busy sweeps
      // strobe for the lifetime of every spawned subagent.
      const resp = await runCommand(
        tabId,
        { type: "get_subagents" },
        { quiet: true },
      );
      if (resp === null) return;
      patchRpc(tabId, { subagents: parseSubagents(respData(resp)) });
    },

    openSubagent(tabId, key) {
      patchRpc(tabId, { selectedSubagent: key });
      syncSubagentSubscription(tabId);
    },

    closeSubagent(tabId) {
      patchRpc(tabId, { selectedSubagent: null });
      syncSubagentSubscription(tabId);
    },

    clearShellExited(tabId) {
      set((s) => ({ shellExited: dropExited(s.shellExited, tabId) }));
    },

    toggleConsole(tabId) {
      set((s) => ({
        consoleOpen: { ...s.consoleOpen, [tabId]: !s.consoleOpen[tabId] },
      }));
    },

    async refreshBranches(projectCwd, opts) {
      const fetchUpstream = opts?.fetchUpstream === true;
      const active = branchRefreshes.get(projectCwd);
      if (active !== undefined) {
        if (fetchUpstream && !active.state.fetchUpstream)
          active.state.pendingNetwork = true;
        return active.promise;
      }

      patchBranchActivity(projectCwd, { refreshing: true });
      const state = { fetchUpstream, pendingNetwork: false };
      let nextOptions = opts;
      const promise = Promise.resolve().then(async () => {
        try {
          while (true) {
            try {
              const list = await backend.listBranches(projectCwd, nextOptions);
              set((s) => ({ branches: { ...s.branches, [projectCwd]: list } }));
            } catch {
              // Keep the last known snapshot when listing fails.
            }

            if (!state.pendingNetwork) return;
            state.pendingNetwork = false;
            state.fetchUpstream = true;
            nextOptions = { fetchUpstream: true };
          }
        } finally {
          branchRefreshes.delete(projectCwd);
          patchBranchActivity(projectCwd, { refreshing: false });
        }
      });
      branchRefreshes.set(projectCwd, { state, promise });
      return promise;
    },

    async checkoutGitBranch(projectCwd, name, opts) {
      try {
        await backend.checkoutBranch(projectCwd, name, opts);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      await get().refreshBranches(projectCwd, { fetchUpstream: false });
      return null;
    },

    async pullGitBranch(projectCwd) {
      if (get().branchActivity[projectCwd]?.pulling === true) return null;

      patchBranchActivity(projectCwd, { pulling: true });
      let pulled = false;
      try {
        await backend.pullBranch(projectCwd);
        pulled = true;
        await get().refreshBranches(projectCwd, { fetchUpstream: false });
        return null;
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      } finally {
        if (pulled) {
          set((s) => ({
            branchDiffRevision: {
              ...s.branchDiffRevision,
              [projectCwd]: (s.branchDiffRevision[projectCwd] ?? 0) + 1,
            },
          }));
        }
        patchBranchActivity(projectCwd, { pulling: false });
      }
    },

    async suggestBranchName(projectCwd, planContext) {
      // Best-effort like titling: never throw into the review modal.
      return backend
        .suggestBranchName(projectCwd, planContext)
        .catch(() => null);
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
