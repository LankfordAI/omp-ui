/**
 * Subsequence fuzzy matching for the command and model palettes.
 *
 * Scoring, not just filtering: with 49 commands and 414 models the ranking is
 * the whole product. A prefix hit must beat a mid-word hit, and a run of
 * consecutive characters must beat the same characters scattered across the
 * haystack — otherwise "gpt5" surfaces "…-legacy-pt-…5" ahead of "gpt-5".
 */

export interface FuzzyHit {
  /** Higher is better. Only comparable between matches of the same needle. */
  score: number;
  /** Indices in the haystack that the needle consumed, ascending. */
  hits: number[];
}

const START_BONUS = 12;
const WORD_START_BONUS = 8;
const CONSECUTIVE_BONUS = 6;
const CASE_BONUS = 1;
/** Charged per skipped character so a tight match outranks a sprawling one. */
const GAP_PENALTY = 0.4;

/** Characters after which the next char reads as the start of a new word. */
const BOUNDARY: Record<string, true> = {
  " ": true,
  "-": true,
  _: true,
  "/": true,
  ":": true,
  ".": true,
};

/**
 * Greedy left-to-right subsequence match. Greedy is the right trade here: the
 * lists are small and the needles are short, so an optimal-alignment search
 * would cost more than the ranking it buys.
 */
export function fuzzyMatch(haystack: string, needle: string): FuzzyHit | null {
  if (needle === "") return { score: 0, hits: [] };
  const hay = haystack.toLowerCase();
  const pin = needle.toLowerCase();
  if (pin.length > hay.length) return null;

  const hits: number[] = [];
  let score = 0;
  let at = 0;

  for (let n = 0; n < pin.length; n++) {
    const found = hay.indexOf(pin[n], at);
    if (found === -1) return null;

    const consecutive = n > 0 && found === hits[n - 1] + 1;
    if (found === 0) score += START_BONUS;
    else if (BOUNDARY[hay[found - 1]]) score += WORD_START_BONUS;
    if (consecutive) score += CONSECUTIVE_BONUS;
    if (haystack[found] === needle[n]) score += CASE_BONUS;
    score -= (found - at) * GAP_PENALTY;

    hits.push(found);
    at = found + 1;
  }

  // Shorter haystacks are the more specific answer for the same needle.
  score -= hay.length * 0.02;
  return { score, hits };
}

/** Best match across several fields, each weighted by how much it means. */
export function fuzzyBest(
  needle: string,
  fields: { text: string; weight: number; report?: boolean }[],
): { score: number; hits: number[] } | null {
  let best: { score: number; hits: number[] } | null = null;
  for (const f of fields) {
    const m = fuzzyMatch(f.text, needle);
    if (!m) continue;
    const weighted = m.score * f.weight;
    if (best === null || weighted > best.score) {
      best = { score: weighted, hits: f.report === false ? [] : m.hits };
    }
  }
  return best;
}

/**
 * Splits `text` into alternating unmatched/matched runs so a row can emphasise
 * exactly the characters the query consumed.
 */
export function highlightRuns(text: string, hits: number[]): { text: string; hit: boolean }[] {
  if (hits.length === 0) return text === "" ? [] : [{ text, hit: false }];
  const marked = new Set(hits);
  const runs: { text: string; hit: boolean }[] = [];
  let start = 0;
  let hit = marked.has(0);
  for (let i = 1; i <= text.length; i++) {
    const next = i < text.length && marked.has(i);
    if (i === text.length || next !== hit) {
      runs.push({ text: text.slice(start, i), hit });
      start = i;
      hit = next;
    }
  }
  return runs;
}
