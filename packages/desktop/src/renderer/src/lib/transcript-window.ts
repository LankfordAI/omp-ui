/**
 * The native transcript renders a bounded tail window of render items
 * (issue #867, ADR-0057): DOM cost scales with the window, never with how long
 * a live tab has run. `frozenStart` null means follow mode.
 */
export const TRANSCRIPT_WINDOW_ROWS = 150;
/** Items one "load older" adds above the window. */
export const TRANSCRIPT_WINDOW_STEP = 150;
/** Items kept above a revealed target so it does not sit at the very top. */
export const TRANSCRIPT_REVEAL_CONTEXT = 20;
/** Distance from the top, in px, that loads older items while reading. */
export const LOAD_OLDER_TRIGGER_PX = 600;

/** First rendered index for a transcript of `length` items. */
export function windowStart(length: number, frozenStart: number | null): number {
  const tail = Math.max(0, length - TRANSCRIPT_WINDOW_ROWS);
  return frozenStart === null ? tail : Math.min(frozenStart, tail);
}

