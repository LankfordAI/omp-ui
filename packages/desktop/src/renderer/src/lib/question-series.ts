import type { SelectOption } from "./multi-select";

/**
 * Multi-question asks arrive as one blocking select request per question,
 * each titled with a trailing page marker — "Language? (1/3)". Loop frames
 * of a multi-select page repeat the same marker after planSelect strips
 * the "(N selected)" prefix, so the marker + question text identify a
 * page. Answers are final once sent (rpc.md: one blocking request per
 * dialog), so this module only *tracks* the series for progress display
 * and read-only review — it can never drive back-navigation.
 */

/** Trailing "(i/n)" — anchored so a mid-title parenthetical never matches. */
const PAGE_MARKER = /\s*\((\d+)\/(\d+)\)\s*$/;

export interface PageFrame {
  /** Question text with the marker stripped. */
  base: string;
  /** 1-based page index, or null when the frame carries no marker. */
  page: number | null;
  /** Series length, or null when the frame carries no marker. */
  total: number | null;
}

export function parsePage(title: string): PageFrame {
  const m = PAGE_MARKER.exec(title);
  if (!m) return { base: title, page: null, total: null };
  return { base: title.slice(0, m.index).trimEnd(), page: Number(m[1]), total: Number(m[2]) };
}

export interface SeriesEntry {
  page: number;
  title: string;           // marker-stripped question text
  options: SelectOption[]; // listed options at answer time; [] for free-text
  answer: string[];        // chosen labels, or [freeText] for an editor answer
  multi: boolean;
}

export interface SeriesState {
  total: number;
  current: number;         // live page, 1-based
  currentTitle: string;    // marker-stripped title of the live page
  entries: SeriesEntry[];  // pages with a recorded answer, page order
}

/**
 * Advances the machine for an incoming select frame. Loop frames of the
 * live page (same page, same question) return `prev` unchanged. The next
 * page of the same total advances. Anything else — a different total, a
 * backward jump, or the same page carrying a new question — is a fresh
 * series: the old one was cancelled or completed and its history is moot.
 */
export function nextSeries(prev: SeriesState | null, frame: PageFrame): SeriesState | null {
  if (frame.page === null || frame.total === null) return null;
  if (prev !== null) {
    if (frame.page === prev.current && frame.base === prev.currentTitle) return prev;
    if (frame.total === prev.total && frame.page === prev.current + 1) {
      return { ...prev, current: frame.page, currentTitle: frame.base };
    }
  }
  return { total: frame.total, current: frame.page, currentTitle: frame.base, entries: [] };
}

/**
 * Upserts one page's answer. An "Other" pick records the options with an
 * empty answer so the rail keeps the page un-answered while the editor
 * frame is open; the editor's submit then fills the answer and keeps the
 * options for review.
 */
export function recordAnswer(state: SeriesState, entry: SeriesEntry): SeriesState {
  const prior = state.entries.find((e) => e.page === entry.page);
  const merged: SeriesEntry =
    entry.options.length === 0 && prior ? { ...entry, options: prior.options } : entry;
  return {
    ...state,
    entries: [...state.entries.filter((e) => e.page !== entry.page), merged].sort(
      (a, b) => a.page - b.page,
    ),
  };
}

/** A page counts as answered only once a real answer landed — an
 *  options-only placeholder from an "Other" pick does not fill its dot. */
export function isAnswered(state: SeriesState, page: number): boolean {
  return state.entries.some((e) => e.page === page && e.answer.length > 0);
}
