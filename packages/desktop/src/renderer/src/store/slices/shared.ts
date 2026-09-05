// Co-owned store machinery (issue #295): the per-store helpers and module
// collections that more than one slice uses. Called once by the composition
// root, the returned object is injected into every slice factory. Slices
// reach other slices only through get(); everything here is shared by
// construction.
import type { StoreApi } from "zustand";
import type { SessionSummary } from "@omp-ui/core/types";
import { formatDuration } from "../../lib/duration";
import { field } from "../../lib/fields";
import {
  parseModelInfo,
  parseSessionRuntime,
  parseSessionStats,
  parseTodoPhases,
  type SessionRuntime,
} from "../../lib/rpc-types";
import {
  noticeItem,
  reduceEvent,
  type NoticeItem,
  type RenderItem,
} from "../../lib/transcript";
import type { AdvisorReplyWatcher } from "../../lib/advisor-reply";
import type { PlanConcernWatcher } from "../../lib/plan-concerns";
import type { StallContinueWatcher } from "../../lib/stall-continue";
import { backend } from "../../backend";
import type {
  RpcTabState,
  SidebarSessionState,
  TuiHandoff,
  UiStore,
} from "../types";
import { findRecord } from "./view";

export type SetState = StoreApi<UiStore>["setState"];
export type GetState = StoreApi<UiStore>["getState"];

export interface Watchers {
  concern: PlanConcernWatcher;
  advisorReply: AdvisorReplyWatcher;
  stall: StallContinueWatcher;
}

export interface TranscriptBatch {
  items: RenderItem[];
  raf?: number;
  timer?: number;
}

export interface PendingNotice {
  text: string;
  level?: "info" | "warn" | "error";
}

export interface TimedOutCommand {
  id: string;
  command: string;
  startedAt: number;
  timedOutAt: number;
}

/** Renderer-only process state. One entry owns every per-tab side channel. */
export interface TabRuntime {
  quietWedgeNotified: boolean;
  timedOutCommands: TimedOutCommand[];
  lastFrameAt?: number;
  pendingNotices: PendingNotice[];
  transcriptBatch?: TranscriptBatch;
  slashCommandItems: Map<string, string>;
  streamStallTimer?: number;
  compactionUsageGeneration?: number;
  lastUsageRefresh?: number;
  subagentPendingLevel?: "progress" | "events";
}

export interface StoreMachinery {
  patchRpc(tabId: string, patch: Partial<RpcTabState>): void;
  runtime(tabId: string): TabRuntime;
  patchRuntime(tabId: string, patch: Partial<TabRuntime>): void;
  createTabRuntime(tabId: string): TabRuntime;
  discardTabRuntime(tabId: string): void;
  bumpCompactionUsageGeneration(tabId: string): number;
  patchSession(tabId: string, patch: Partial<SessionRuntime>): void;
  effectiveItems(tabId: string): RenderItem[];
  queueTranscriptFrame(
    tabId: string,
    frame: unknown,
    stall: NoticeItem | null,
  ): void;
  flushTranscriptBatch(tabId: string): void;
  cancelTranscriptBatch(tabId: string): void;
  appendItem(tabId: string, item: RenderItem): void;
  patchItems(tabId: string, map: (item: RenderItem) => RenderItem): void;
  runCommand(
    tabId: string,
    cmd: Record<string, unknown>,
    opts?: { quiet?: boolean; captureId?: (id: string) => void },
  ): Promise<unknown>;
  pollUntil(
    tabId: string,
    pred: (tab: RpcTabState | undefined) => boolean,
    timeoutMs?: number,
  ): Promise<void>;
  syncSubagentSubscription(tabId: string): void;
  applyRpcState(tabId: string, resp: unknown): void;
  refreshUsage(tabId: string, afterState?: () => void): Promise<void>;
  stopStreamStallTimer(tabId: string): void;
  ensureStreamStallTimer(tabId: string): void;
}

/** The RPC response budget, shared by rpc-command and the advisor relaunch. */
export const RPC_COMMAND_TIMEOUT_MS = 30_000;

/**
 * omp answers on one serial chain (rpc-mode.ts `RpcInputDispatcher`). These
 * handlers are awaited before the ack and have no useful upper bound: a model
 * call (`compact`, `handoff`), a provider refresh (`set_model`, `cycle_model`,
 * `get_available_models`), a turn unwind (`abort`, `abort_and_prompt`), file or
 * network work (`export_html`, `login`), a UI round-trip (`new_session`,
 * `switch_session`, `branch`), or arbitrary shell (`bash`, which bypasses the
 * chain). For them, lateness is not failure (issue #335).
 */
const LATE_ACK_COMMANDS: Record<string, true> = {
  compact: true,
  handoff: true,
  abort: true,
  abort_and_prompt: true,
  export_html: true,
  login: true,
  new_session: true,
  switch_session: true,
  branch: true,
  set_model: true,
  cycle_model: true,
  get_available_models: true,
  bash: true,
};

/** Mirrors omp's own skill-command match: start of message or after whitespace. */
const SKILL_COMMAND_RE = /(^|\s)\/skill:[^\s/]+(\s|$)/;

/**
 * True when omp cannot ack before real work finishes, so the budget must
 * measure the process's silence rather than the command's duration.
 *
 * `prompt`: omp awaits `tryRunRpcSkillCommand` (a `/skill:` message runs the
 * whole agent turn inside the handler) and the builtin slash dispatcher (whose
 * handler may open an `extension_ui_request` and await the human) before it
 * acks. A plain-text prompt acks immediately and stays strict.
 */
export function isLateAckCommand(cmd: Record<string, unknown>): boolean {
  const type = typeof cmd.type === "string" ? cmd.type : "";
  if (LATE_ACK_COMMANDS[type] === true) return true;
  if (type !== "prompt") return false;
  const message = typeof cmd.message === "string" ? cmd.message : "";
  return message.trimStart().startsWith("/") || SKILL_COMMAND_RE.test(message);
}

/** A renderer-side RPC wait expired; the process may still finish the command. */
export class RpcCommandTimeoutError extends Error {
  readonly command: string;
  readonly timeoutMs: number;
  readonly startedAt: number;
  /** What was ahead of this command when its budget expired. */
  readonly attribution: string | null;
  /**
   * `response` — omp owed an immediate ack and did not send one: the serial
   * chain is wedged. `silence` — a late-ack command's window elapsed with no
   * frame at all: the process itself went quiet (issue #335).
   */
  readonly kind: "response" | "silence";

  constructor(
    command: string,
    timeoutMs: number,
    startedAt: number,
    kind: "response" | "silence" = "response",
    attribution: string | null = null,
  ) {
    super(
      kind === "silence"
        ? `RPC command "${command}" stopped responding — no session activity for ${formatDuration(
            timeoutMs,
          )} (sent ${formatDuration(Date.now() - startedAt)} ago)`
        : `RPC command "${command}" timed out after its ${formatDuration(timeoutMs)} response budget`,
    );
    this.name = "RpcCommandTimeoutError";
    this.command = command;
    this.timeoutMs = timeoutMs;
    this.startedAt = startedAt;
    this.kind = kind;
    this.attribution = attribution;
  }
}

/**
 * The pending wait was dropped because its process went away (exit,
 * hibernation, relaunch, erase) — never a diagnostic. The dead overlay, the
 * hibernated badge, or the fresh boot already tells the story, so `runCommand`
 * records no failure for it (issue #338).
 */
export class RpcCommandAbandonedError extends Error {
  readonly command: string;
  constructor(command: string, reason: string) {
    super(`RPC command "${command}" was dropped: ${reason}`);
    this.name = "RpcCommandAbandonedError";
    this.command = command;
  }
}

export function deriveSidebarSessionState(
  summary: SessionSummary,
  rpc: RpcTabState | undefined,
  exitCode: number | undefined,
): SidebarSessionState {
  if (summary.live !== "live") return summary.live;
  if (exitCode !== undefined) return "dormant";
  // A pending gate is main-process state (issue #215) — the record alone
  // marks the session awaiting-answer, even before its tab is booted.
  if (summary.pendingPlan !== null) return "awaiting-answer";
  if (summary.mode === "pty" || !rpc) return "live";
  if (rpc.status === "error") return "error";
  // A watchdog-aborted turn outranks awaiting-answer: the user must prompt to
  // continue the session, which also clears the queue (issue #248).
  if (summary.streamStalled) return "stalled";
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

export { termWriters, shellWriters };

function dropExited(
  exited: Record<string, number>,
  tabId: string,
): Record<string, number> {
  const next = { ...exited };
  delete next[tabId];
  return next;
}

function dropHibernated(
  hibernated: Record<string, boolean>,
  tabId: string,
): Record<string, boolean> {
  const next = { ...hibernated };
  delete next[tabId];
  return next;
}

function dropTuiHandoff(
  tuiHandoff: Record<string, TuiHandoff>,
  tabId: string,
): Record<string, TuiHandoff> {
  const next = { ...tuiHandoff };
  delete next[tabId];
  return next;
}

export { dropExited, dropHibernated, dropTuiHandoff };

/** Planning sources whose accepted fresh handoff disables automatic prompts. */
export const handedOffPlanSources = new Set<string>();

/**
 * The one renderer-only runtime entry per rpc tab. `bootRpcTab` creates the
 * entry synchronously before it sends a command, so every subsequent frame
 * has one owner for timers, correlations, and process-local diagnostics.
 */
const tabRuntimes = new Map<string, TabRuntime>();
let nextCompactionUsageGeneration = 0;

function freshTabRuntime(): TabRuntime {
  return {
    quietWedgeNotified: false,
    timedOutCommands: [],
    pendingNotices: [],
    slashCommandItems: new Map(),
  };
}
/** Test seam for the renderer store harness's whole-state reset. */
export function resetTabRuntimesForTests(): void {
  for (const runtime of tabRuntimes.values()) {
    if (runtime.transcriptBatch?.raf !== undefined) {
      window.cancelAnimationFrame(runtime.transcriptBatch.raf);
    }
    if (runtime.transcriptBatch?.timer !== undefined) {
      window.clearTimeout(runtime.transcriptBatch.timer);
    }
    if (runtime.streamStallTimer !== undefined) {
      window.clearInterval(runtime.streamStallTimer);
    }
  }
  tabRuntimes.clear();
}


/**
 * Live stream-stall detection (issue #228). Clock: the renderer-observed
 * checkpoint (never reset by local tool execution). Gate: the transcript's
 * own "assistant response open" flag. The label claims observation only —
 * "no stream activity", never a cause (issue #179).
 */
export const STREAM_STALL_THRESHOLD_MS = 30_000;
export const STREAM_STALL_TICK_MS = 1_000;

/** Command responses nest their payload under `data`. */
const respData = (resp: unknown): unknown =>
  resp !== null &&
  typeof resp === "object" &&
  "data" in resp &&
  resp.data !== null &&
  typeof resp.data === "object"
    ? resp.data
    : resp;

export { respData };

export function createMachinery(
  set: SetState,
  get: GetState,
  api: StoreApi<UiStore>,
): StoreMachinery {
  const patchRpc = (tabId: string, patch: Partial<RpcTabState>): void => {
    set((s) => {
      const tab = s.rpc[tabId];
      if (!tab) return s;
      return { rpc: { ...s.rpc, [tabId]: { ...tab, ...patch } } };
    });
  };

  const createTabRuntime = (tabId: string): TabRuntime => {
    const runtime = freshTabRuntime();
    tabRuntimes.set(tabId, runtime);
    return runtime;
  };

  const runtime = (tabId: string): TabRuntime =>
    tabRuntimes.get(tabId) ?? createTabRuntime(tabId);

  const patchRuntime = (
    tabId: string,
    patch: Partial<TabRuntime>,
  ): void => {
    const current = tabRuntimes.get(tabId);
    if (current === undefined) return;
    tabRuntimes.set(tabId, { ...current, ...patch });
  };

  const discardTabRuntime = (tabId: string): void => {
    const current = tabRuntimes.get(tabId);
    if (current === undefined) return;
    const batch = current.transcriptBatch;
    if (
      batch?.raf !== undefined &&
      typeof window.cancelAnimationFrame === "function"
    )
      window.cancelAnimationFrame(batch.raf);
    if (batch?.timer !== undefined) window.clearTimeout(batch.timer);
    if (current.streamStallTimer !== undefined)
      window.clearInterval(current.streamStallTimer);
    tabRuntimes.delete(tabId);
  };

  const bumpCompactionUsageGeneration = (tabId: string): number => {
    const generation = ++nextCompactionUsageGeneration;
    patchRuntime(tabId, { compactionUsageGeneration: generation });
    return generation;
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

  /** Committed items plus anything reduced but not yet flushed. */
  const effectiveItems = (tabId: string): RenderItem[] =>
    tabRuntimes.get(tabId)?.transcriptBatch?.items ??
    get().rpc[tabId]?.items ??
    [];

  const cancelTranscriptBatch = (tabId: string): void => {
    const batch = tabRuntimes.get(tabId)?.transcriptBatch;
    if (!batch) return;
    patchRuntime(tabId, { transcriptBatch: undefined });
    if (
      batch.raf !== undefined &&
      typeof window.cancelAnimationFrame === "function"
    ) {
      window.cancelAnimationFrame(batch.raf);
    }
    if (batch.timer !== undefined) window.clearTimeout(batch.timer);
  };

  const flushTranscriptBatch = (tabId: string): void => {
    const batch = tabRuntimes.get(tabId)?.transcriptBatch;
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
    const current = runtime(tabId).transcriptBatch;
    if (current) {
      patchRuntime(tabId, { transcriptBatch: { ...current, items } });
      return;
    }
    const batch: TranscriptBatch = { items };
    patchRuntime(tabId, { transcriptBatch: batch });
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

  const appendItem = (tabId: string, item: RenderItem): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    // A pending transcript batch owns the next commit — append onto it so the
    // item keeps its arrival position instead of being overwritten by the flush.
    const batch = tabRuntimes.get(tabId)?.transcriptBatch;
    if (batch) {
      patchRuntime(tabId, {
        transcriptBatch: { ...batch, items: [...batch.items, item] },
      });
      return;
    }
    patchRpc(tabId, { items: [...tab.items, item] });
  };
  /**
   * Quiet commands are background sync (heartbeats, usage ticks): their
   * failure means the session is congested, not that it failed. Never paint
   * the session-level failure — one dim, coalesced transcript notice per
   * wedge episode, naming the command still holding the chain when the
   * attribution memory has one (issue #302).
   */
  const noteQuietWedge = (tabId: string, command: string, err: unknown): void => {
    // A teardown must not consume the wedge-episode slot (issue #338).
    if (err instanceof RpcCommandAbandonedError) return;
    const current = runtime(tabId);
    if (current.quietWedgeNotified) return;
    patchRuntime(tabId, { quietWedgeNotified: true });
    const text =
      err instanceof RpcCommandTimeoutError
        ? `background "${command}" timed out after ${formatDuration(err.timeoutMs)} — ${
            err.attribution ?? "no other command in flight"
          }`
        : `background "${command}" failed: ${err instanceof Error ? err.message : String(err)}`;
    appendItem(tabId, noticeItem(text, "info"));
  };

  /** Maps every item; patches only when at least one item actually changed. */
  const patchItems = (
    tabId: string,
    map: (item: RenderItem) => RenderItem,
  ): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    const batch = tabRuntimes.get(tabId)?.transcriptBatch;
    const base = batch?.items ?? tab.items;
    const items = base.map(map);
    if (!items.some((item, i) => item !== base[i])) return;
    if (batch) {
      patchRuntime(tabId, { transcriptBatch: { ...batch, items } });
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
    const runtimeState = runtime(tabId);
    if (tab.subagentAckLevel === level || runtimeState.subagentPendingLevel === level) return;
    patchRuntime(tabId, { subagentPendingLevel: level });
    void runCommand(
      tabId,
      { type: "set_subagent_subscription", level },
      { quiet: true },
    ).then((response) => {
      if (runtime(tabId).subagentPendingLevel === level) {
        patchRuntime(tabId, { subagentPendingLevel: undefined });
      }
      if (response !== null) patchRpc(tabId, { subagentAckLevel: level });
      const current = get().rpc[tabId];
      const desired = current?.selectedSubagent ? "events" : "progress";
      if (current !== undefined && desired !== level) syncSubagentSubscription(tabId);
    });
  };

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
    opts?: { quiet?: boolean; captureId?: (id: string) => void },
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
      // Any quiet success proves the queue is draining: re-arm the
      // wedge-episode notice for the next episode (issue #302).
      if (opts?.quiet === true)
        patchRuntime(tabId, { quietWedgeNotified: false });
      return resp;
    } catch (err) {
      const tab = get().rpc[tabId];
      // The process went away; its overlay already says so (issue #338).
      if (err instanceof RpcCommandAbandonedError) return null;
      if (tab?.failure?.fatal) return null;
      // Background sync never paints the session-level failure: one dim,
      // coalesced notice per wedge episode instead (issue #302).
      if (opts?.quiet === true) {
        noteQuietWedge(tabId, command, err);
        return null;
      }
      const timedOut = err instanceof RpcCommandTimeoutError;
      const base = err instanceof Error ? err.message : String(err);
      // Name what was ahead of it in omp's chain: the banner is the surface a
      // user actually reads, and it is the one that lacked attribution (#337).
      const suffix = timedOut ? err.attribution : null;
      const liveState = findRecord(get().state, tabId)?.live;
      patchRpc(tabId, {
        failure: {
          message: timedOut
            ? suffix
              ? `${base} — ${suffix}`
              : base
            : `RPC command "${command}" failed: ${base}`,
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

  /** Polls `rpc[tabId]` until `pred` holds (or the bounded deadline passes). */
  const pollUntil = (
    tabId: string,
    pred: (tab: RpcTabState | undefined) => boolean,
    timeoutMs = 15_000,
  ): Promise<void> => {
    const read = (): RpcTabState | undefined => get().rpc[tabId];
    if (pred(read())) return Promise.resolve();
    // A subscription — not a timer loop — so readiness resolves the moment
    // state changes, with no wall-clock sampling. (new Promise, not
    // withResolvers: the web lib here is ES2022 and the rest of the file
    // builds resolvers this way.)
    return new Promise<void>((resolve) => {
      const timer = window.setTimeout(() => {
        unsubscribe();
        resolve();
      }, timeoutMs);
      const unsubscribe = api.subscribe(() => {
        if (pred(read())) {
          window.clearTimeout(timer);
          unsubscribe();
          resolve();
        }
      });
    });
  };

  const patchSession = (
    tabId: string,
    patch: Partial<SessionRuntime>,
  ): void => {
    const tab = get().rpc[tabId];
    if (!tab) return;
    patchRpc(tabId, { session: { ...tab.session, ...patch } });
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

  const refreshUsage = async (
    tabId: string,
    afterState?: () => void,
  ): Promise<void> => {
    await Promise.all([
      get()
        .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
        .then((resp) => applyRpcState(tabId, resp))
        .catch(() => {})
        .finally(afterState),
      get()
        .rpcCommand(tabId, { type: "get_session_stats" }, { quiet: true })
        .then((resp) =>
          patchRpc(tabId, { stats: parseSessionStats(respData(resp)) }),
        )
        .catch(() => {}),
    ]);
  };
  /** Stops the armed tab's interval, if any; idempotent. */
  const stopStreamStallTimer = (tabId: string): void => {
    const id = tabRuntimes.get(tabId)?.streamStallTimer;
    if (id !== undefined) window.clearInterval(id);
    patchRuntime(tabId, { streamStallTimer: undefined });
  };

  /**
   * One second, per armed tab (issue #228). Self-terminating: a gone tab,
   * a non-"running" status, a closed response, or a missing checkpoint
   * stops the clock and clears the field; the next frame while "running"
   * re-arms it, so callers only ever arm it.
   */
  const streamStallTick = (tabId: string): void => {
    const tab = get().rpc[tabId];
    // The gate is the transcript's own streaming flag: while it is set,
    // deltas would still be routed to that item, so the model owes us
    // frames. A closed response (tool execution, between turns,
    // compaction) is silent by design, and a missing checkpoint means
    // there is no silence to measure (a late joiner cannot time what it
    // never saw) — both stop the clock.
    const streamingOpen =
      tab !== undefined &&
      effectiveItems(tabId).some((i) => i.kind === "assistant" && i.streaming);
    const checkpoint = tab?.streamCheckpoint;
    if (
      tab === undefined ||
      tab.status !== "running" ||
      !streamingOpen ||
      checkpoint === undefined
    ) {
      stopStreamStallTimer(tabId);
      if (tab !== undefined && tab.streamStallMs !== undefined)
        patchRpc(tabId, { streamStallMs: undefined });
      return;
    }
    const silence = Date.now() - checkpoint.at;
    const next =
      silence >= STREAM_STALL_THRESHOLD_MS
        ? Math.floor(silence / 1000) * 1000
        : undefined;
    if (next !== tab.streamStallMs) patchRpc(tabId, { streamStallMs: next });
  };

  const ensureStreamStallTimer = (tabId: string): void => {
    if (runtime(tabId).streamStallTimer !== undefined) return;
    patchRuntime(tabId, {
      streamStallTimer: window.setInterval(
        () => streamStallTick(tabId),
        STREAM_STALL_TICK_MS,
      ),
    });
  };


  return {
    patchRpc,
    runtime,
    patchRuntime,
    createTabRuntime,
    discardTabRuntime,
    bumpCompactionUsageGeneration,
    patchSession,
    effectiveItems,
    queueTranscriptFrame,
    flushTranscriptBatch,
    cancelTranscriptBatch,
    appendItem,
    patchItems,
    runCommand,
    pollUntil,
    syncSubagentSubscription,
    applyRpcState,
    refreshUsage,
    stopStreamStallTimer,
    ensureStreamStallTimer,
  };
}
