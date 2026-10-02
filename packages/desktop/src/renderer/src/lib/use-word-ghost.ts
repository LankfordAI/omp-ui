import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../store";

/** Idle time after the last edit before omp is asked about the draft (issue #715). */
export const WORD_GHOST_DEBOUNCE_MS = 100;
/** omp's editor replaces a provisional space with these (tui editor PROVISIONAL_SPACE_ABSORBERS). */
const PROVISIONAL_SPACE_ABSORBERS = /^[-.,;:!?)\]}]$/;
/** omp's WORD_SUFFIX character class: the draft must end inside a word. */
const WORD_END = /[\p{L}\p{M}']$/u;

/** A suffix omp offered for the exact draft and caret it was asked about. */
export interface WordGhost {
  suffix: string;
  text: string;
  cursor: number;
}

/**
 * Host-side pre-gate; omp applies the full prose rules. The caret must end
 * the whole draft (not merely its line): the ghost paints in the mirror
 * only, and a ghost before a later line would re-wrap the mirror and drift
 * every following glyph off the textarea (#282).
 */
export function wordGhostCandidate(text: string, caret: number): boolean {
  if (caret !== text.length) return false;
  const lead = text.trimStart();
  if (lead.startsWith("/") || lead.startsWith("!")) return false;
  return WORD_END.test(text);
}

export function useWordGhost({
  tabId,
  text,
  caret,
  active,
}: {
  tabId: string;
  text: string;
  caret: number;
  /** Every UI precondition: focused, live, collapsed selection, no palette open. */
  active: boolean;
}): {
  /** The ghost to paint now, or null. */
  ghost: WordGhost | null;
  /** Call from onChange with the new value/caret BEFORE committing it. */
  noteEdit(nextText: string, nextCaret: number): void;
  /** Tab (space) / → (no space): the draft to commit, or null when nothing is shown. */
  accept(space: boolean): { text: string; caret: number } | null;
  /** A printable keydown right after a Tab accept: the draft to commit, or null. */
  takeProvisionalKey(key: string): { text: string; caret: number } | null;
} {
  const predictWord = useStore((s) => s.predictWord);
  const sendFeedback = useStore((s) => s.sendWordPredictionFeedback);
  const [stored, setStored] = useState<WordGhost | null>(null);
  const seq = useRef(0);
  const provisional = useRef<number | null>(null);

  const eligible = active && wordGhostCandidate(text, caret);
  const ghost =
    eligible && stored !== null && stored.text === text && stored.cursor === caret ? stored : null;

  useEffect(() => {
    // Every draft/caret/eligibility change retires the previous request.
    const id = ++seq.current;
    if (!eligible) return;
    const timer = window.setTimeout(() => {
      void predictWord(tabId, text, caret).then((suffix) => {
        if (seq.current !== id) return;
        // null keeps a projected ghost for this exact draft, as omp's editor does.
        if (suffix !== null) setStored({ suffix, text, cursor: caret });
      });
    }, WORD_GHOST_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [eligible, tabId, text, caret, predictWord]);

  const noteEdit = useCallback(
    (nextText: string, nextCaret: number): void => {
      provisional.current = null;
      if (ghost === null) return;
      const appended =
        nextCaret === nextText.length &&
        nextText.length > ghost.text.length &&
        nextText.startsWith(ghost.text);
      if (appended) {
        const typed = nextText.slice(ghost.text.length);
        const overlap = Math.min(typed.length, ghost.suffix.length);
        if (
          ghost.suffix.slice(0, overlap).toLocaleLowerCase() ===
          typed.slice(0, overlap).toLocaleLowerCase()
        ) {
          // Typing through the ghost: show the remainder at once, no feedback.
          setStored(
            typed.length < ghost.suffix.length
              ? { suffix: ghost.suffix.slice(typed.length), text: nextText, cursor: nextCaret }
              : null,
          );
          return;
        }
        sendFeedback(tabId, {
          text: ghost.text,
          cursor: ghost.cursor,
          suggestion: ghost.suffix,
          accepted: false,
        });
      }
      setStored(null);
    },
    [ghost, tabId, sendFeedback],
  );

  const accept = useCallback(
    (space: boolean): { text: string; caret: number } | null => {
      if (ghost === null) return null;
      sendFeedback(tabId, {
        text: ghost.text,
        cursor: ghost.cursor,
        suggestion: ghost.suffix,
        accepted: true,
      });
      const next = ghost.text + ghost.suffix + (space ? " " : "");
      setStored(null);
      provisional.current = space ? next.length : null;
      return { text: next, caret: next.length };
    },
    [ghost, tabId, sendFeedback],
  );

  const takeProvisionalKey = useCallback(
    (key: string): { text: string; caret: number } | null => {
      const at = provisional.current;
      provisional.current = null;
      if (at === null || at !== caret || text[at - 1] !== " ") return null;
      if (key === " ") return { text, caret };
      if (PROVISIONAL_SPACE_ABSORBERS.test(key))
        return { text: text.slice(0, at - 1) + key + text.slice(at), caret: at };
      return null;
    },
    [text, caret],
  );

  return { ghost, noteEdit, accept, takeProvisionalKey };
}
