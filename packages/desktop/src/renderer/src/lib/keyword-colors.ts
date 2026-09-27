/**
 * The composer's magic-keyword colours — the character shimmer and the border
 * ring painted for each keyword. Matching, the keyword table, and its hue
 * endpoints come from `@omp-ui/core/magic-keywords` (the port of omp 18.3.2);
 * this module only turns a keyword's hue ramp into CSS.
 *
 * The gradient is the only signal the user gets that a keyword armed, so the
 * ramps are sampled continuously from omp's endpoints: omp's terminal editor
 * quantizes to 14 ANSI stops; sampling the ramp directly keeps the same
 * endpoints while letting the sweep advance a uniform hue delta per frame —
 * the stepped pick made the GUI shimmer stall and lurch (issue #204).
 */

import { MAGIC_KEYWORDS, type MagicKeyword } from "@omp-ui/core/magic-keywords";

/** Time for the gradient to sweep one full cycle across each keyword. */
export const SHIMMER_PERIOD_MS = 1800;

/** Colour stops in a keyword's border ring (`keywordPalette`). */
const STOPS = 14;

/** Hue in degrees at t ∈ [0, 1) along `keyword`'s omp ramp. */
function hueAt(keyword: MagicKeyword, t: number): number {
  const [start, end] = MAGIC_KEYWORDS.find((k) => k.word === keyword)!.hue;
  return Math.round(start + t * (end - start)) % 360;
}

/**
 * One CSS colour per character of `keyword`, sampled continuously from the
 * keyword's hue ramp. `phase` ∈ [0, 1) rotates the sample cyclically to
 * animate the shimmer; values outside the range wrap.
 */
export function keywordColors(keyword: MagicKeyword, phase: number): string[] {
  // Wrap into [0, 1) so negative inputs and values >= 1 stay well-defined.
  const wrapped = ((phase % 1) + 1) % 1;
  const n = keyword.length;
  const colors: string[] = [];
  for (let i = 0; i < n; i++) {
    colors.push(`hsl(${hueAt(keyword, (i / n + wrapped) % 1)} 90% 62%)`);
  }
  return colors;
}

const PALETTES = new Map<MagicKeyword, readonly string[]>();

/**
 * The 14-stop ring for `keyword` — the conic gradient the composer runs
 * around its border while the keyword is armed. The stops sample the same
 * hue ramp keywordColors draws from (the browser interpolates between them),
 * so the border and the characters can never disagree about a keyword's
 * colours.
 */
export function keywordPalette(keyword: MagicKeyword): readonly string[] {
  let palette = PALETTES.get(keyword);
  if (palette === undefined) {
    const stops: string[] = [];
    for (let i = 0; i < STOPS; i++) stops.push(`hsl(${hueAt(keyword, i / STOPS)} 90% 62%)`);
    palette = stops;
    PALETTES.set(keyword, palette);
  }
  return palette;
}
