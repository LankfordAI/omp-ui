import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";
import { randomId } from "./random-id";

/**
 * Grace after a turn settles before the one billed prediction request goes
 * out: the end-of-turn refreshes (queue count, usage) land right after
 * `agent_end`, and a fast Tab on a typed draft must not have paid for a reply
 * nobody reads. Exactly one request per settled turn — the arm rides the
 * settle edge, never a re-checking condition effect.
 */
export const PREDICTION_REQUEST_GRACE_MS = 400;

/** The empty-composer next-message prediction ghost (issue #1239). */
export interface NextMessagePrediction {
  /** True while the ghost paints: the idle, focused, empty composer's placeholder. */
  shown: boolean;
  /** The predicted first choice while shown; null otherwise. */
  text: string | null;
  /**
   * Tab/Right over a painted ghost: the draft to insert — never send — or
   * null when nothing is shown (the key then belongs to whatever else listens).
   */
  accept(): string | null;
  /** Call from onChange with every edit: any keystroke retires the offer. */
  noteEdit(): void;
}

/**
 * OMP 19 predicts the user's next message after each completed turn and
 * ghosts it in its TUI's empty composer (upstream
 * `composer-prediction-controller.ts`); the native composer reaches the same
 * billed side turn through the composer-predictions bridge (#1239). This hook
 * owns the composer half:
 *
 * - One request per settled turn, trailing-graced, gated at fire time on
 *   `active` (focused, collapsed, live-idle, no dialog/hold/palette — the
 *   caller's contract, same as the word ghost's) plus the empty draft and the
 *   bridge's `available` publish. The bridge re-checks omp's EFFECTIVE
 *   `composer.predictions` before billing: its `available: false` publish is
 *   the user's opt-out, honored without any request leaving this process.
 * - The ghost paints as the empty composer's placeholder — upstream's exact
 *   surface. A non-empty draft belongs to the word ghost: this one only ever
 *   exists while the draft is empty, so the two can never paint at once.
 * - Tab/Right inserts on an explicit press; nothing sends. (Upstream's second
 *   Tab walks to the next alternative — the pick-list surface is issue #1030;
 *   only the first choice renders here.)
 * - Staleness retires the ghost: any keystroke (`noteEdit`), a session change
 *   under the tab, or any transcript growth while a prediction is pending or
 *   painted — the upstream anchor rule (a new message invalidates the
 *   prediction) seen from the renderer side.
 */
export function useNextMessagePrediction({
  tabId,
  text,
  active,
}: {
  tabId: string;
  /** The draft verbatim; any non-empty value hides and retires this ghost. */
  text: string;
  /** Every UI precondition the caller can see: focus, collapsed caret, live, idle, no dialog, no hold, no palette, not compact. */
  active: boolean;
}): NextMessagePrediction {
  const status = useStore((s) => s.rpc[tabId]?.status);
  const sessionId = useStore((s) => s.rpc[tabId]?.session.sessionId ?? null);
  const snapshot = useStore((s) => s.rpc[tabId]?.composerPredictions ?? null);
  const transcriptRevision = useStore((s) => s.rpc[tabId]?.transcriptRevision ?? 0);
  const requestPrediction = useStore((s) => s.requestComposerPrediction);

  /** The one open request for the turn that just settled; null when no slot is spent. */
  const [requestId, setRequestId] = useState<string | null>(null);
  const [choices, setChoices] = useState<string[] | null>(null);

  // Fire-time truth: the grace timer must read the world as it is when it
  // fires, not as it was when the turn settled.
  const activeRef = useRef(active);
  activeRef.current = active;
  const textRef = useRef(text);
  textRef.current = text;

  // Arm on the settle edge only: running → ready. A mount onto an idle
  // session asks nothing (upstream predicts only after a completed turn), and
  // a ghost cleared by typing never re-bills before the next settle.
  const previousStatus = useRef(status);
  useEffect(() => {
    const settled = previousStatus.current === "running" && status === "ready";
    previousStatus.current = status;
    if (!settled) return;
    // A fresh conversation point starts from nothing offered or pending.
    setChoices(null);
    setRequestId(null);
    const timer = window.setTimeout(() => {
      if (!activeRef.current || textRef.current !== "") return;
      const tab = useStore.getState().rpc[tabId];
      // Re-read the live gates at fire time: a turn that restarted in the
      // grace owns the conversation, and a queued follow-up means the session
      // has not actually come to rest.
      if (
        tab === undefined ||
        tab.status !== "ready" ||
        (tab.session.queuedMessageCount ?? 0) > 0 ||
        tab.extensionQueue.length > 0
      ) {
        return;
      }
      // The bridge publishes availability; absent or false means the host
      // cannot run the side turn or the user opted out — never bill.
      if (useStore.getState().rpc[tabId]?.composerPredictions?.available !== true) return;
      const next = randomId();
      setRequestId(next);
      void requestPrediction(tabId, next);
    }, PREDICTION_REQUEST_GRACE_MS);
    return () => window.clearTimeout(timer);
  }, [status, tabId, requestPrediction]);

  // Correlate the bridge's publish with the one open request: only a result
  // naming it counts. ok offers its choices (the request stays open as the
  // ghost's correlation token); any failure retires the slot.
  useEffect(() => {
    if (requestId === null) return;
    const result = snapshot?.result ?? null;
    if (result === null || result.requestId !== requestId) return;
    if (result.ok) {
      setChoices(result.choices);
      return;
    }
    setRequestId(null);
    setChoices(null);
  }, [snapshot, requestId]);

  // Staleness: a new message/turn or a session change under the tab grows the
  // transcript or swaps the session while a prediction is pending or painted —
  // upstream's anchor rule from this side. Guarded by `live` so an ordinary
  // late end-of-turn row with nothing outstanding discards nothing; the local
  // state itself stays out of the dependency list, because the discard effect
  // must not fire on the very commit that sets it.
  const live = requestId !== null || choices !== null;
  const liveRef = useRef(live);
  useEffect(() => {
    liveRef.current = live;
  });
  useEffect(() => {
    if (!liveRef.current) return;
    setRequestId(null);
    setChoices(null);
  }, [tabId, sessionId, transcriptRevision]);

  // Any keystroke retires the offer: the ghost belongs to the composer as it
  // stood when the turn settled, and a tab the user is typing into has moved
  // past it (the empty→non-empty direction also hands Tab back to the word
  // ghost for the rest of this draft).
  const noteEdit = useCallback((): void => {
    setChoices(null);
    setRequestId(null);
  }, []);

  const shown = choices !== null && active && text === "";
  const first = choices?.[0] ?? null;

  const accept = useCallback((): string | null => {
    if (!shown || first === null) return null;
    setChoices(null);
    setRequestId(null);
    return first;
  }, [shown, first]);

  return { shown, text: shown ? first : null, accept, noteEdit };
}
