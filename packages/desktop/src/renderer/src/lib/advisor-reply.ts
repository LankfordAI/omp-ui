import { collectNewConcerns, noteKey, renderConcernsBlock } from "./advisor-concerns";
import type { AdvisorNote, RenderItem } from "./transcript";

/**
 * Auto-answers an advisor review that lands too late for the turn it reviewed.
 *
 * An omp advisor reviews a turn only once that turn has ended, async to the
 * primary loop (ADR-0008). When the reviewed turn is the session's last, the
 * review arrives after the `agent finished` marker, into an idle live rpc-ui
 * session — where the `advisory` render item is display-only and the main model
 * never sees, let alone answers, it. This watcher dispatches those findings
 * back into the same session as a follow-up so something always responds
 * (issue #104).
 */

/**
 * How long to keep collecting a late review's findings before answering it. One
 * review arrives in two shapes (a standalone `advisory` card and notes on the
 * turn's tool results) across separate frames, and a session-scoped advisor set
 * can post several — batching answers them in one prompt instead of burning a
 * loop-guard slot per frame.
 */
export const ADVISOR_REPLY_SETTLE_MS = 1_500;

/**
 * Consecutive auto-replies allowed before the guard stops. The reply turn is
 * itself reviewed, so an unbounded fold ping-pongs forever; two lets the advisor
 * challenge the fix once and no further. Any prompt from another source resets
 * the count.
 */
export const ADVISOR_REPLY_MAX = 2;

export const ADVISOR_REPLY_LEAD =
  "The advisor reviewed the turn that just ended; its findings landed after the turn closed, " +
  "so nothing has answered them yet. Address each one now — fix what needs fixing, or state " +
  "explicitly why no change is warranted:";

export const ADVISOR_REPLY_CAP_NOTICE =
  `advisor auto-reply paused after ${ADVISOR_REPLY_MAX} consecutive replies — send a prompt to re-arm`;

export interface AdvisorReplyCallbacks {
  getItems(tabId: string): RenderItem[];
  /** True when this tab may be auto-prompted right now (see the store's predicate). */
  canReply(tabId: string): boolean;
  onNotice(tabId: string, text: string, level: "info" | "warn"): void;
  onReply(tabId: string, message: string, notes: AdvisorNote[]): void;
}

interface ReplyState {
  /**
   * Transcript baseline: the item count as of the last moment the tab could not
   * be auto-prompted (a live turn, an advisor-reply opt-out, a dead tab), or as
   * of the last reply. Findings collected above it are exactly the ones that
   * landed while the session sat idle. No timing metadata rides an `advisory`
   * card (see `lib/transcript.ts` — it carries only an id and its notes), so
   * position relative to this cursor is the only correlation available.
   */
  cursor: number;
  replies: number;
  replied: Set<string>;
  timer?: ReturnType<typeof setTimeout>;
}

/**
 * Watches each live rpc-ui tab's transcript for advisor findings that arrived
 * with no turn left to answer them, and replies on the session's behalf.
 *
 * Three mechanics, all per-tab: a settle window so one review's frames fold
 * into a single prompt; a transcript cursor that re-baselines whenever the tab
 * is unreplyable, so history is never re-answered; and a consecutive-reply
 * count, since the reply turn draws its own review and would otherwise
 * ping-pong. Owns its timers — the store just feeds/resets/cancels; per-tab
 * map, same pattern as `PlanConcernWatcher`.
 *
 * Deliberately not `PlanConcernWatcher`'s lifecycle: that one holds a staged
 * dispatch until a review arrives, this one is the inverse — a review arrived
 * with nothing staged to hold.
 */
export class AdvisorReplyWatcher {
  private active = new Map<string, ReplyState>();

  constructor(
    private callbacks: AdvisorReplyCallbacks,
    private settleMs: number = ADVISOR_REPLY_SETTLE_MS,
  ) {}

  /**
   * Findings above the cursor that no reply has covered yet. No severity
   * filter: the ask is that the model always responds, nits included.
   */
  private unreplied(items: RenderItem[], st: ReplyState): AdvisorNote[] {
    return collectNewConcerns(items, st.cursor).filter((n) => !st.replied.has(noteKey(n)));
  }

  /** Called on every transcript frame, after the items patch. */
  feed(tabId: string): void {
    const items = this.callbacks.getItems(tabId);
    let st = this.active.get(tabId);
    if (!st) {
      // Seeding the cursor at the current length is REQUIRED: a resumed tab's
      // whole history is already-delivered advice, and must never be folded.
      st = { cursor: items.length, replies: 0, replied: new Set() };
      this.active.set(tabId, st);
    }

    if (!this.callbacks.canReply(tabId)) {
      st.cursor = items.length;
      if (st.timer !== undefined) {
        clearTimeout(st.timer);
        st.timer = undefined;
      }
      return;
    }

    // Batch window already open — later findings accumulate in `items` and are
    // collected at settle, so there is nothing to do per frame.
    if (st.timer !== undefined) return;

    const fresh = this.unreplied(items, st);
    if (fresh.length === 0) return;

    if (st.replies >= ADVISOR_REPLY_MAX) {
      // Bumping the cursor and marking these notes replied is what keeps the
      // cap notice to one per capped review rather than one per frame.
      st.cursor = items.length;
      for (const n of fresh) st.replied.add(noteKey(n));
      this.callbacks.onNotice(tabId, ADVISOR_REPLY_CAP_NOTICE, "warn");
      return;
    }

    st.timer = setTimeout(() => this.settle(tabId), this.settleMs);
  }

  private settle(tabId: string): void {
    const st = this.active.get(tabId);
    if (!st) return;
    if (st.timer !== undefined) {
      clearTimeout(st.timer);
      st.timer = undefined;
    }

    // A turn may have started inside the batch window — the session is no
    // longer idle, so it will answer the review itself.
    const items = this.callbacks.getItems(tabId);
    if (!this.callbacks.canReply(tabId)) {
      st.cursor = items.length;
      return;
    }

    const notes = this.unreplied(items, st);
    if (notes.length === 0) {
      st.cursor = items.length;
      return;
    }

    const message = renderConcernsBlock(notes, ADVISOR_REPLY_LEAD);
    if (message === null) return; // unreachable with notes.length > 0

    st.cursor = items.length;
    st.replies += 1;
    for (const n of notes) st.replied.add(noteKey(n));

    this.callbacks.onNotice(
      tabId,
      `advisor commented after the turn ended — answering it (${notes.length} finding${notes.length === 1 ? "" : "s"})`,
      "info",
    );
    this.callbacks.onReply(tabId, message, notes);
  }

  /**
   * A prompt from any other source (user, plan dispatch) or a history reload:
   * re-baseline and re-arm.
   */
  reset(tabId: string): void {
    const st = this.active.get(tabId);
    if (st?.timer !== undefined) clearTimeout(st.timer);
    const cursor = this.callbacks.getItems(tabId).length;
    if (st) {
      st.timer = undefined;
      st.cursor = cursor;
      st.replies = 0;
      st.replied.clear();
      return;
    }
    this.active.set(tabId, { cursor, replies: 0, replied: new Set() });
  }

  /** Tab teardown/reboot: drop the entry and its timer. */
  cancel(tabId: string): void {
    const st = this.active.get(tabId);
    if (!st) return;
    if (st.timer !== undefined) clearTimeout(st.timer);
    this.active.delete(tabId);
  }
}
