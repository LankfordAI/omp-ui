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
  settleRunningTools,
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

export interface StoreMachinery {
  patchRpc(tabId: string, patch: Partial<RpcTabState>): void;
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
  slashCommandItems: Map<string, Map<string, string>>;
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
  refreshUsage(tabId: string): Promise<void>;
  stopStreamStallTimer(tabId: string): void;
  ensureStreamStallTimer(tabId: string): void;
  teardownExited(tabId: string, code: number): void;
  teardownHibernated(tabId: string): void;
  /** Rejects every in-flight wait on a process that can no longer answer. */
  abandonPendingCommands(tabId: string, reason: string): void;
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

function alertError(err: unknown): void {
  window.alert(err instanceof Error ? err.message : String(err));
}

export { alertError };

/** Planning sources whose accepted fresh handoff disables automatic prompts. */
export const handedOffPlanSources = new Set<string>();

/**
 * Compaction-usage refresh generations, keyed by tab: a relaunch or erase
 * bumps the generation so a stale retry loop dies instead of patching fresh
 * state.
 */
export const compactionUsageGenerations = new Map<string, number>();
let nextCompactionUsageGeneration = 0;

/** Allocates the tab's next compaction-usage generation and records it. */
export function bumpCompactionUsageGeneration(tabId: string): number {
  const generation = ++nextCompactionUsageGeneration;
  compactionUsageGenerations.set(tabId, generation);
  return generation;
}

/**
 * Live stream-stall detection (issue #228). Clock: the renderer-observed
 * checkpoint (never reset by local tool execution). Gate: the transcript's
 * own "assistant response open" flag. The label claims observation only —
 * "no stream activity", never a cause (issue #179).
 */
export const STREAM_STALL_THRESHOLD_MS = 30_000;
export const STREAM_STALL_TICK_MS = 1_000;

/**
 * Quiet-failure notice coalescing (issue #302): one dim transcript notice per
 * wedge episode per tab. Set by the first quiet failure (timeout or error),
 * re-armed by any quiet success, reset on relaunch. Tabs hide rather than
 * close, so the map is bounded by tab count and needs no teardown (same
 * posture as `subagentRefresh`).
 */
export const quietWedgeNotified = new Map<string, boolean>();
/**
 * Renderer-side timed-out commands whose completion response has not yet
 * been observed (issue #302). A command ahead of a victim in omp's serial
 * chain cannot still be in `pendingCommands` — it shares the same response
 * budget, so its entry left at its own, earlier timeout. The holder is the
 * earliest such command started before the victim: in a FIFO chain it is
 * the one executing while the rest merely queue behind it. Entries retire
 * when a late response for the command arrives, when any non-`bash` success
 * proves the chain drained past them, or on relaunch/erase.
 */
export interface TimedOutCommand {
  id: string;
  command: string;
  startedAt: number;
  timedOutAt: number;
}
export const timedOutCommands = new Map<string, TimedOutCommand[]>();

/**
 * Wall-clock of the last rpc frame observed for a tab. The late-ack budget's
 * liveness evidence: omp is alive and the chain is merely slow, not wedged
 * (issue #335). Written by handleRpcFrame; dropped on relaunch, boot, and
 * erase. Bounded by tab count, like `quietWedgeNotified`.
 */
export const lastFrameAt = new Map<string, number>();

/**
 * Notices appended while a tab is booting, delivered once its transcript has
 * loaded (issue #334). `bootRpcTab` resets `items` and `loadHistory` replaces
 * them wholesale, so a notice raised across a relaunch — a worktree release is
 * one, and it is the only durable record of where the session moved — would be
 * dropped. Bounded by tab count; cleared on erase, drained on boot.
 */
export interface PendingNotice {
  text: string;
  level?: "info" | "warn" | "error";
}
export const pendingNotices = new Map<string, PendingNotice[]>();

/** A late response for a timed-out command: the chain provably moved past it (issue #302). */
const retireTimedOutCommand = (tabId: string, id: string): void => {
  const list = timedOutCommands.get(tabId);
  if (!list) return;
  const at = list.findIndex((e) => e.id === id);
  if (at === -1) return;
  list.splice(at, 1);
  if (list.length === 0) timedOutCommands.delete(tabId);
};

/** A non-bash completion proves the FIFO chain drained past every earlier-started command (issue #302). */
const retireTimedOutEarlierThan = (tabId: string, startedAt: number): void => {
  const list = timedOutCommands.get(tabId);
  if (!list) return;
  const kept = list.filter((e) => e.startedAt >= startedAt);
  if (kept.length === list.length) return;
  if (kept.length === 0) timedOutCommands.delete(tabId);
  else timedOutCommands.set(tabId, kept);
};

export { retireTimedOutCommand, retireTimedOutEarlierThan };

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

  const streamStallTimers = new Map<string, number>();

  /**
   * Slash-command echo correlation: request id → CommandItem id, per tab.
   * Entries live only while the item may still settle off a late
   * `prompt_result`/`agent_start` (the response carried no `agentInvoked`).
   */
  const slashCommandItems = new Map<string, Map<string, string>>();

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
  /**
   * What was ahead of a timed-out command in omp's chain (issue #302). Entries
   * are appended in send order, so the first started before the victim is the
   * chain's current holder; the rest merely queue behind it. Returns the text
   * after the em dash, or null when there is nothing to attribute.
   */
  const wedgeSuffix = (
    tabId: string,
    err: RpcCommandTimeoutError,
  ): string | null => {
    const holder = (timedOutCommands.get(tabId) ?? []).find(
      (e) => e.startedAt < err.startedAt,
    );
    if (holder)
      return `queued behind ${holder.command} (timed out ${formatDuration(
        Date.now() - holder.timedOutAt,
      )} ago, response not yet observed)`;
    const pending = get().rpc[tabId]?.pendingCommands;
    const inFlight = pending
      ? [...pending.values()].map((p) =>
          p.quiet
            ? `${p.command} (bg, ${formatDuration(Date.now() - p.startedAt)})`
            : `${p.command} (${formatDuration(Date.now() - p.startedAt)})`,
        )
      : [];
    return inFlight.length > 0
      ? `other commands still in flight: ${inFlight.join(", ")}`
      : null;
  };

  /**
   * Drops every wait on a process that can no longer answer. Without this a
   * command in flight at exit/hibernate/relaunch fires its budget 30 s later
   * and paints a banner against the fresh session, with recovery text claiming
   * the command "may still complete in the live session" (issue #338).
   */
  const abandonPendingCommands = (tabId: string, reason: string): void => {
    const tab = get().rpc[tabId];
    timedOutCommands.delete(tabId);
    lastFrameAt.delete(tabId);
    if (!tab || tab.pendingCommands.size === 0) return;
    const pending = [...tab.pendingCommands.values()];
    tab.pendingCommands.clear();
    for (const p of pending) {
      clearTimeout(p.timer);
      p.reject(new RpcCommandAbandonedError(p.command, reason));
    }
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
    if (quietWedgeNotified.get(tabId)) return;
    quietWedgeNotified.set(tabId, true);
    const text =
      err instanceof RpcCommandTimeoutError
        ? `background "${command}" timed out after ${formatDuration(err.timeoutMs)} — ${
            wedgeSuffix(tabId, err) ?? "no other command in flight"
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
      if (opts?.quiet === true) quietWedgeNotified.delete(tabId);
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
      const suffix = timedOut ? wedgeSuffix(tabId, err) : null;
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

  const refreshUsage = async (tabId: string): Promise<void> => {
    await Promise.all([
      get()
        .rpcCommand(tabId, { type: "get_state" }, { quiet: true })
        .then((resp) => applyRpcState(tabId, resp))
        .catch(() => {}),
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
    const id = streamStallTimers.get(tabId);
    if (id !== undefined) window.clearInterval(id);
    streamStallTimers.delete(tabId);
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
    if (streamStallTimers.has(tabId)) return;
    streamStallTimers.set(
      tabId,
      window.setInterval(() => streamStallTick(tabId), STREAM_STALL_TICK_MS),
    );
  };

  /**
   * Process-exit teardown (the onPtyExit handler's body, issue #93/#187): the
   * dead process's final frames must not be lost, and its stall clock must
   * stop now.
   */
  const teardownExited = (tabId: string, code: number): void => {
    abandonPendingCommands(tabId, "the session process exited");
    // An rpc-mode omp that dies mid-tool sends no agent_end or
    // omp_ui_error frame — this exit is the only signal, so running
    // tool cards are settled here (issue #93). Settle from the effective
    // items: a batched stream commit may still be pending, and the dead
    // process's final frames must not be lost (issue #187).
    const before = get().rpc[tabId];
    const settled = before
      ? settleRunningTools(effectiveItems(tabId), "aborted")
      : undefined;
    cancelTranscriptBatch(tabId);
    compactionUsageGenerations.delete(tabId);
    // No frame may ever come again: stop the stall clock now instead of
    // letting the next tick re-arm on the leftover open-assistant flag
    // (issue #228).
    stopStreamStallTimer(tabId);
    set((s) => {
      // The stall field must clear even when no tool cards were running
      // — a pure-text stall settles to `settled === before.items`.
      const clearStall = before?.streamStallMs !== undefined;
      const rpc =
        before &&
        (clearStall ||
          (settled !== undefined && settled !== before.items))
          ? {
              ...s.rpc,
              [tabId]: {
                ...before,
                ...(clearStall ? { streamStallMs: undefined } : {}),
                ...(settled !== undefined && settled !== before.items
                  ? { items: settled }
                  : {}),
              },
            }
          : s.rpc;
      return { exited: { ...s.exited, [tabId]: code }, rpc };
    });
  };

  /**
   * Hibernation: the process was stopped on purpose after an idle window
   * (issue #246). Same teardown as a process exit — no frame may ever
   * come again, so settle running tools and stop the stall clock — but
   * the framing is "stopped to free memory", not a crash. `exited` is
   * set on purpose: every dead gate (composer, canReply, HUD) keys off
   * it; `hibernated` only changes what the overlay and HUD say.
   * Keep this teardown in sync with the onPtyExit handler above.
   */
  const teardownHibernated = (tabId: string): void => {
    abandonPendingCommands(tabId, "the session was hibernated");
    const before = get().rpc[tabId];
    const settled = before
      ? settleRunningTools(effectiveItems(tabId), "aborted")
      : undefined;
    cancelTranscriptBatch(tabId);
    compactionUsageGenerations.delete(tabId);
    stopStreamStallTimer(tabId);
    set((s) => {
      const clearStall = before?.streamStallMs !== undefined;
      const rpc =
        before &&
        (clearStall ||
          (settled !== undefined && settled !== before.items))
          ? {
              ...s.rpc,
              [tabId]: {
                ...before,
                ...(clearStall ? { streamStallMs: undefined } : {}),
                ...(settled !== undefined && settled !== before.items
                  ? { items: settled }
                  : {}),
              },
            }
          : s.rpc;
      return {
        exited: { ...s.exited, [tabId]: 0 },
        hibernated: { ...s.hibernated, [tabId]: true },
        rpc,
      };
    });
  };

  return {
    patchRpc,
    patchSession,
    effectiveItems,
    queueTranscriptFrame,
    flushTranscriptBatch,
    cancelTranscriptBatch,
    appendItem,
    patchItems,
    slashCommandItems,
    runCommand,
    pollUntil,
    syncSubagentSubscription,
    applyRpcState,
    refreshUsage,
    stopStreamStallTimer,
    ensureStreamStallTimer,
    teardownExited,
    teardownHibernated,
    abandonPendingCommands,
  };
}
