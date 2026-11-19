import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

/** A draft edit to apply in place: replace the buffer, caret at its end. */
export interface PredictionEdit {
  text: string;
  caret: number;
}

/**
 * The next-message prediction surface (#1239 ghost + #1030 alternatives),
 * mirroring upstream v19 `editor.ts` (`#getShownPrediction`,
 * `#getPredictionAlternatives`, `#handleTabCompletion`) one-to-one.
 */
export interface NextMessagePrediction {
  /** True while the EMPTY composer's placeholder paints the first choice. */
  shown: boolean;
  /** The placeholder text while shown; null otherwise (#1239 surface). */
  text: string | null;
  /**
   * Non-empty single-line draft, caret at its end, no list open: the part of
   * the FIRST prediction this draft is a strict prefix of — typing letters
   * ghosts the first MATCHING alternative, not only choices[0]. Null when the
   * word ghost owns the slot instead.
   */
  ghostSuffix: string | null;
  /**
   * The buffer equals one of two or more alternatives (caret at end): Tab
   * opens their list, and the caller paints the upstream inline hint
   * ` Tab {hintMore} more` — how many OTHERS the list holds. Null while a
   * ghost suffix holds the slot (upstream's hint order) or the list is open.
   */
  hintMore: number | null;
  /** Any face of the offer is on screen: chip, and the word ghost yields. */
  held: boolean;
  /** The pick list while it is open (upstream's "assist" state). */
  listOpen: boolean;
  /** Every alternative, most likely first; only meaningful while `listOpen`. */
  choices: readonly string[];
  /** Which row the list opens with selected: the one the buffer equals. */
  selectedIndex: number;
  /**
   * Tab/Right over a painted ghost: insert the rest of it — never submit — or
   * null when no ghost is shown (the key then belongs to whatever listens).
   */
  accept(): PredictionEdit | null;
  /** Tab over a buffer that equals one of ≥2 alternatives: open their list. */
  openList(): boolean;
  /** Close the pick list without touching the buffer (Escape, dismissal). */
  closeList(): void;
  /**
   * Choose row `index` from the open list: swap the whole buffer to it, or
   * null when it already equals the buffer (upstream's stale-pick bail: the
   * list closes, the buffer does not move).
   */
  pick(index: number): PredictionEdit | null;
  /** Call from onChange on every USER edit: closes the list, ends the insert. */
  noteEdit(): void;
}

/**
 * OMP 19 predicts the user's next message after each completed turn and
 * ghosts it in its TUI's composer (upstream `composer-prediction-controller.ts`);
 * the native composer reaches the same billed side turn through the
 * composer-predictions bridge (#1239). This hook owns the composer half:
 *
 * - One request per settled turn, trailing-graced, gated at fire time on
 *   `active` (focused, collapsed, live-idle, no dialog/hold/palette — the
 *   caller's contract, same as the word ghost's) plus the empty draft and the
 *   bridge's `available` publish. The bridge re-checks omp's EFFECTIVE
 *   `composer.predictions` before billing: its `available: false` publish is
 *   the user's opt-out, honored without any request leaving this process.
 *   The one request carries every alternative (#1030 rides it; nothing here
 *   bills twice).
 * - The empty composer paints choices[0] as its placeholder (#1239); once the
 *   user types, the ghost follows upstream `#getShownPrediction`: the FIRST
 *   prediction the draft is a strict prefix of (single line, caret at end).
 *   Exception, exactly upstream's: when the buffer equals an inserted
 *   prediction that is one of ≥2 predictions, no ghost extends it — Tab opens
 *   the pick list instead. The pick list swaps the whole buffer to the chosen
 *   alternative and closes.
 * - Tab order (upstream `#handleTabCompletion`): accept the shown prediction →
 *   open the alternatives list → fall through to the word completion, which
 *   the caller wires after this hook. While any face holds the ghost slot the
 *   caller must not paint or accept the word ghost — upstream's inline-hint
 *   precedence (`#getInlineHint`, `#getShownWordCompletion`).
 * - Accepted rank is NOT reported: upstream resolves acceptance into OTLP
 *   metric attributes inside `ComposerPredictionController` (TUI mode only —
 *   `rpc-mode.ts` never instantiates it), and the extension API exposes no
 *   meter or telemetry surface to carry one here; `predict_word_feedback`
 *   (a different feature) has no rank field either. omp offers this bridge no
 *   sink for a rank, so none is invented; see the note in
 *   `packages/core/src/composer-predictions-extension.ts`.
 * - Staleness retires the offer: a session change under the tab or any
 *   transcript growth while a prediction is pending or painted — upstream's
 *   anchor rule (a new message invalidates the prediction) seen from the
 *   renderer side. TYPING does not retire it (upstream keeps offering the
 *   choices while you edit): it only closes the list and clears the inserted
 *   mark, so a retyped prefix ghosts again.
 */
export function useNextMessagePrediction({
  tabId,
  text,
  caret,
  active,
}: {
  tabId: string;
  /** The draft verbatim; a single-line draft ghosts the matching choice. */
  text: string;
  /** The collapsed caret offset; ghost and list require it at the draft's end. */
  caret: number;
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
  const [choices, setChoices] = useState<readonly string[] | null>(null);
  const [listOpen, setListOpen] = useState(false);
  /**
   * The buffer an insert or pick produced (upstream's `#insertedPrediction`):
   * only this exact buffer suppresses the ghost so Tab can open the list.
   * Any user edit clears it (`#notifyChange` does the same upstream).
   */
  const [inserted, setInserted] = useState<string | null>(null);

  // Fire-time truth: the grace timer must read the world as it is when it
  // fires, not as it was when the turn settled.
  const activeRef = useRef(active);
  activeRef.current = active;
  const textRef = useRef(text);
  textRef.current = text;

  /** Every offer-state retirement on one line (settle edge, staleness). */
  const retire = useCallback((): void => {
    setRequestId(null);
    setChoices(null);
    setListOpen(false);
    setInserted(null);
  }, []);

  // Arm on the settle edge only: running → ready. A mount onto an idle
  // session asks nothing (upstream predicts only after a completed turn), and
  // a ghost cleared by typing never re-bills before the next settle.
  const previousStatus = useRef(status);
  useEffect(() => {
    const settled = previousStatus.current === "running" && status === "ready";
    previousStatus.current = status;
    if (!settled) return;
    // A fresh conversation point starts from nothing offered or pending.
    retire();
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
  }, [status, tabId, requestPrediction, retire]);

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
    retire();
  }, [tabId, sessionId, transcriptRevision, retire]);

  // Upstream's single-line rule (`lines.length !== 1`) and cursor-at-end rule.
  const atEnd = caret === text.length;
  const singleLine = !text.includes("\n");

  // Losing the composer (a palette/dialog/focus change flips `active`) closes
  // an open list: only one popup at a time, and a hidden one must not reopen
  // itself when focus returns.
  useEffect(() => {
    if (!active) setListOpen(false);
  }, [active]);

  // The ghost: the first choice the draft is a strict prefix of — EXCEPT the
  // inserted one of ≥2 choices, where no ghost extends (Tab must open the
  // list). An empty draft is a strict prefix of everything, so choices[0]
  // ghosts whole; the caller paints that face as the placeholder.
  const ghost = useMemo((): { index: number; suffix: string } | null => {
    if (!active || listOpen || choices === null || !singleLine || !atEnd) return null;
    if (choices.length > 1 && text !== "" && text === inserted && choices.includes(text)) return null;
    const index = choices.findIndex((choice) => text.length < choice.length && choice.startsWith(text));
    return index < 0 ? null : { index, suffix: choices[index]!.slice(text.length) };
  }, [active, listOpen, choices, singleLine, atEnd, text, inserted]);

  // Two or more alternatives and the buffer equals one of them: Tab opens the
  // list (upstream `#getPredictionAlternatives`), with that row selected.
  const alternatives = useMemo((): { index: number; more: number } | null => {
    if (!active || choices === null || choices.length < 2 || !singleLine || !atEnd) return null;
    const index = choices.indexOf(text);
    return index < 0 ? null : { index, more: choices.length - 1 };
  }, [active, choices, singleLine, atEnd, text]);

  // Upstream's inline-hint precedence: a prediction ghost first, then the
  // "Tab N more" hint (never while the list holds the slot), then whatever
  // the word ghost offers — the caller paints at most one.
  const placeholder = choices !== null && active && text === "" ? choices[0]! : null;
  const open = active && listOpen;
  const ghostSuffix = text === "" ? null : (ghost?.suffix ?? null);
  const hintMore = ghost !== null || open || alternatives === null ? null : alternatives.more;
  const shownPlaceholderText = placeholder;

  const accept = useCallback((): PredictionEdit | null => {
    if (!active || listOpen || choices === null) return null;
    if (ghost === null) return null;
    const next = text + ghost.suffix;
    setInserted(next);
    return { text: next, caret: next.length };
  }, [active, listOpen, choices, ghost, text]);

  const openList = useCallback((): boolean => {
    // Already open: the list (not this key) owns subsequent presses.
    if (listOpen || alternatives === null) return false;
    setListOpen(true);
    return true;
  }, [listOpen, alternatives]);

  const closeList = useCallback((): void => {
    setListOpen(false);
  }, []);

  const pick = useCallback(
    (index: number): PredictionEdit | null => {
      setListOpen(false);
      if (choices === null) return null;
      const value = choices[index];
      // Upstream `#applyAssistReplacement`: a pick that already equals the
      // buffer changes nothing — the list just closes.
      if (value === undefined || value === text) return null;
      setInserted(value);
      return { text: value, caret: value.length };
    },
    [choices, text],
  );

  // A USER edit ends the pick and the inserted mark (upstream cancels the
  // assist list on input and clears `#insertedPrediction` in `#notifyChange`)
  // but NOT the offer: a retyped prefix ghosts again until a new message or
  // settle retires it. Insert/pick edits reach the editor with noteEdit=false,
  // so this never fires for them.
  const noteEdit = useCallback((): void => {
    setListOpen(false);
    setInserted(null);
  }, []);

  const held = placeholder !== null || ghostSuffix !== null || hintMore !== null || open;

  return {
    shown: shownPlaceholderText !== null,
    text: shownPlaceholderText,
    ghostSuffix,
    hintMore,
    held,
    listOpen: open,
    choices: choices ?? EMPTY_CHOICES,
    selectedIndex: alternatives?.index ?? 0,
    accept,
    openList,
    closeList,
    pick,
    noteEdit,
  };
}

const EMPTY_CHOICES: readonly string[] = [];
