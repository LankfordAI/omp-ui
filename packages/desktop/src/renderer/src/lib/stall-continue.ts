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
 * Unlike the advisor watcher, there is no transcript scan: the trigger is a
 * single store event (a stall-classified error turn-end). What is shared with
 * the advisor watcher is the loop-guard shape — a settle window so a user who
 * sees the error and types "continue" themselves wins the race, and a
 * consecutive-continue count, since the continue turn is itself stallable.
 */

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

export type StallContinueReason = "stall" | "repetition";

export const STALL_CONTINUE_REPETITION_LEAD =
  "Your previous turn was halted by the server because the model began repeating " +
  "itself, so the output above is truncated. Continue from where you left off — do " +
  "not re-emit text you already produced. Resume the interrupted work, or state " +
  "explicitly what is blocked.";

export function stallContinueNotice(
  count: number,
  reason: StallContinueReason = "stall",
): string {
  const cause =
    reason === "repetition"
      ? "the model began repeating itself and the server halted the response"
      : "the previous turn's model stream stalled";
  return `stall auto-continue #${count} — ${cause}; continuing`;
}

export interface StallContinueCallbacks {
  /** True when this tab may be auto-prompted right now (see the store's predicate). */
  canContinue(tabId: string): boolean;
  onDispatch(tabId: string, reason: StallContinueReason): void;
  onNotice(tabId: string, text: string, level: "info" | "warn"): void;
  /**
   * The cap transition, for main's OS notifier (issue #271): true when the
   * guard pauses at its cap, false when it re-arms (reset) or the tab is
   * erased / re-booted (cancel).
   */
  onCapChange?: (tabId: string, paused: boolean) => void;
}

interface ContinueState {
  count: number;
  capPosted: boolean;
  reason: StallContinueReason;
  timer: ReturnType<typeof setTimeout> | undefined;
}

export class StallContinueWatcher {
  private readonly states = new Map<string, ContinueState>();

  constructor(
    private callbacks: StallContinueCallbacks,
    private settleMs: number = STALL_CONTINUE_SETTLE_MS,
  ) {}

  /** Called from the agent_end handler when the turn ended stall-classified or repetition-halted. */
  trigger(tabId: string, reason: StallContinueReason = "stall"): void {
    let st = this.states.get(tabId);
    if (!st) {
      st = { count: 0, capPosted: false, reason, timer: undefined };
      this.states.set(tabId, st);
    }
    // A stall on top of a pending continue (the continue turn itself stalled)
    // supersedes the old timer: one dispatch per turn end, latest cause wins.
    clearTimeout(st.timer);
    st.reason = reason;
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
      this.callbacks.onNotice(tabId, stallContinueNotice(st!.count, st!.reason), "info");
      this.callbacks.onDispatch(tabId, st!.reason);
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
}
