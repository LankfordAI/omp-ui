import type { FrameObserver, RpcFrame } from "@omp-ui/core";
import type { AttentionSink } from "./attention-tracker";
import type { LiveEntry } from "../live-entry";

/**
 * Continues a live rpc-ui session whose turn died to a stream stall.
 *
 * omp's provider watchdog aborts the turn when the model stream goes silent
 * (issue #100's diagnostic covers the detection), and omp deliberately never
 * retries a turn that already emitted content — a retry would re-run the model
 * call from the top and re-emit the partial output (issue #250's incident:
 * kimi-k3 via OpenRouter died mid-`ask`, and the only artifacts were an error
 * receipt and a mislabelled card). omp-ui's stall watchdog
 * (`streamStallAbortSeconds`, issue #248) aborts the same way on its side.
 * Either way the session is left idle with nothing carrying the work forward
 * (issue #251). This watcher dispatches a bounded "continue" prompt into the
 * same session so it resumes instead of sitting idle.
 *
 * The guard lives in the host (issue #442): the session's frame stream is the
 * trigger, so the continue goes out whether or not any client is connected,
 * and every client sees the same count. What is shared with the renderer's
 * advisor watcher is the loop-guard shape — a settle window so a user who sees
 * the error and types "continue" themselves wins the race, and a
 * consecutive-continue count, since the continue turn is itself stallable.
 */

/** pi-ai's StreamTimeoutError classifier bit (Flag.Timeout, pi-ai error/flags.ts). */
const OMP_ERROR_FLAG_TIMEOUT = 0x0004_0000;
/** Every built-in provider's stall/first-event watchdog message (pi-ai providers/*). */
const STALL_MESSAGE_RE =
  /stream (stalled|timed out) while waiting for the (next|first) event/i;
/** Prefix of every prompt id omp-ui mints for its own automatic prompts. */
const OWN_PROMPT_ID_PREFIX = "omp-ui-";

/**
 * How long the session may sit idle before the continue prompt is dispatched.
 * If a user prompt lands in the window it re-arms the guard and cancels the
 * pending dispatch — the human direction wins.
 */
export const STALL_CONTINUE_SETTLE_MS = 1_500;

/**
 * Consecutive auto-continues allowed per session before the guard stops. The
 * continue turn draws its own model call and can stall again; without a cap a
 * persistently dead provider would loop forever. Two lets the session push
 * through one transient stall episode and no further. Any user prompt
 * re-arms the count.
 */
export const STALL_CONTINUE_MAX = 2;

export const STALL_CONTINUE_LEAD =
  "Your previous turn was aborted before it finished: the model stream stalled and no " +
  "further output could be retrieved. Continue from where you left off — resume the " +
  "interrupted work, or state explicitly what is blocked.";

export const STALL_CONTINUE_CAP_NOTICE =
  `stall auto-continue paused after ${STALL_CONTINUE_MAX} consecutive continues — send a prompt to re-arm`;

export function stallContinueNotice(count: number): string {
  return `stall auto-continue #${count} — the previous turn's model stream stalled; continuing`;
}

export interface StallContinueCallbacks {
  /** True when this tab may be auto-prompted right now. */
  canContinue(tabId: string): boolean;
  onDispatch(tabId: string): void;
  onNotice(tabId: string, text: string, level: "info" | "warn"): void;
  /**
   * The cap transition, for the attention level (issue #271): true when the
   * guard pauses at its cap, false when it re-arms (reset) or the tab is
   * erased / re-booted (cancel).
   */
  onCapChange?: (tabId: string, paused: boolean) => void;
}

interface ContinueState {
  count: number;
  capPosted: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class StallContinueWatcher {
  private readonly states = new Map<string, ContinueState>();

  constructor(
    private callbacks: StallContinueCallbacks,
    private settleMs: number = STALL_CONTINUE_SETTLE_MS,
  ) {}

  /** Called from the agent_end handler when the turn died to a stall-classified error end. */
  trigger(tabId: string): void {
    let st = this.states.get(tabId);
    if (!st) {
      st = { count: 0, capPosted: false, timer: undefined };
      this.states.set(tabId, st);
    }
    // A stall on top of a pending continue (the continue turn itself stalled)
    // supersedes the old timer: one dispatch per stall event.
    if (st.timer !== undefined) clearTimeout(st.timer);
    if (st.count >= STALL_CONTINUE_MAX) {
      if (!st.capPosted) {
        st.capPosted = true;
        this.callbacks.onCapChange?.(tabId, true);
        this.callbacks.onNotice(tabId, STALL_CONTINUE_CAP_NOTICE, "warn");
      }
      return;
    }
    st.timer = setTimeout(() => {
      st!.timer = undefined;
      if (!this.callbacks.canContinue(tabId)) return; // user moved on, tab died, or a gate owns the session
      st!.count += 1;
      this.callbacks.onNotice(tabId, stallContinueNotice(st!.count), "info");
      this.callbacks.onDispatch(tabId);
    }, this.settleMs);
  }

  /** Any user-originated prompt: the session moved on under human direction. Cancels a pending dispatch. */
  reset(tabId: string): void {
    const st = this.states.get(tabId);
    if (!st) return;
    if (st.capPosted) this.callbacks.onCapChange?.(tabId, false);
    st.count = 0;
    st.capPosted = false;
    if (st.timer !== undefined) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }
  }

  /** Tab erased or re-booted: drop state and any pending dispatch. */
  cancel(tabId: string): void {
    const st = this.states.get(tabId);
    if (!st) return;
    if (st.capPosted) this.callbacks.onCapChange?.(tabId, false);
    if (st.timer !== undefined) clearTimeout(st.timer);
    this.states.delete(tabId);
  }

  /** App quit: every pending dispatch is dropped; nothing announces. */
  cancelAll(): void {
    for (const st of this.states.values()) clearTimeout(st.timer);
    this.states.clear();
  }
}

export interface StallContinueTrackerDeps {
  /** Whether the tab may receive an automatic prompt right now (live, idle, ungated). */
  canContinue(tabId: string): boolean;
  /** Sends the continue prompt into the tab's live process. */
  dispatch(tabId: string): void;
  /** Posts a transcript notice to every client of the tab. */
  notice(tabId: string, text: string, level: "info" | "warn"): void;
  attention: AttentionSink;
  settleMs?: number;
}

interface LastTurn {
  stopReason: string | undefined;
  errorMessage: string | undefined;
  errorId: number | undefined;
}

/** A turn's terminal assistant message ended in a stream stall/timeout. */
function isStreamStallEnd(lastTurn: LastTurn): boolean {
  if (lastTurn.stopReason !== "error") return false;
  return (
    ((lastTurn.errorId ?? 0) & OMP_ERROR_FLAG_TIMEOUT) !== 0 ||
    STALL_MESSAGE_RE.test(lastTurn.errorMessage ?? "")
  );
}

/**
 * The frame-observer face of the guard: classifies each rpc-ui turn end and
 * feeds the watcher. Two stall shapes exist — the provider's own watchdog ends
 * the terminal assistant message with a timeout error, while main's stall
 * watchdog aborts the turn (stopReason "aborted", unclassifiable from the
 * frame) and reports the abort through `noteWatchdogAbort` instead.
 */
export class StallContinueTracker implements FrameObserver<LiveEntry> {
  private readonly watcher: StallContinueWatcher;
  private readonly lastTurn = new Map<string, LastTurn>();
  private readonly watchdogAbortPending = new Set<string>();

  constructor(deps: StallContinueTrackerDeps) {
    this.watcher = new StallContinueWatcher(
      {
        canContinue: (tabId) => deps.canContinue(tabId),
        onDispatch: (tabId) => deps.dispatch(tabId),
        onNotice: (tabId, text, level) => deps.notice(tabId, text, level),
        onCapChange: (tabId, paused) => deps.attention.stallPaused(tabId, paused),
      },
      deps.settleMs,
    );
  }

  /** Main's stall watchdog aborted this tab's running turn; the coming agent_end is a stall end. */
  noteWatchdogAbort(tabId: string): void {
    this.watchdogAbortPending.add(tabId);
  }

  onFrame(tabId: string, frame: RpcFrame, entry: LiveEntry): void {
    if (entry.kind !== "rpc-ui") return;
    switch (frame.type) {
      case "agent_start":
        this.lastTurn.delete(tabId);
        this.watchdogAbortPending.delete(tabId);
        return;
      case "message_end": {
        const message = frame.message;
        if (typeof message !== "object" || message === null) return;
        const m = message as Record<string, unknown>;
        if (m.role !== "assistant") return;
        this.lastTurn.set(tabId, {
          stopReason: typeof m.stopReason === "string" ? m.stopReason : undefined,
          errorMessage: typeof m.errorMessage === "string" ? m.errorMessage : undefined,
          errorId: typeof m.errorId === "number" ? m.errorId : undefined,
        });
        return;
      }
      case "agent_end": {
        const lastTurn = this.lastTurn.get(tabId);
        const providerStall = lastTurn !== undefined && isStreamStallEnd(lastTurn);
        const watchdogAbort = this.watchdogAbortPending.delete(tabId);
        this.lastTurn.delete(tabId);
        if (providerStall || watchdogAbort) this.watcher.trigger(tabId);
        return;
      }
    }
  }

  /** A human prompt re-arms the guard; omp-ui's own prompts (the continue itself) never do. */
  onSend(tabId: string, cmd: RpcFrame): void {
    if (cmd.type !== "prompt") return;
    if (typeof cmd.id === "string" && cmd.id.startsWith(OWN_PROMPT_ID_PREFIX)) return;
    this.watcher.reset(tabId);
  }

  onExit(tabId: string): void {
    this.clear(tabId);
  }

  dispose(tabId: string): void {
    this.clear(tabId);
  }

  /** App quit: drop every tab's state without announcing. */
  disposeAll(): void {
    this.lastTurn.clear();
    this.watchdogAbortPending.clear();
    this.watcher.cancelAll();
  }

  private clear(tabId: string): void {
    this.lastTurn.delete(tabId);
    this.watchdogAbortPending.delete(tabId);
    this.watcher.cancel(tabId);
  }
}
