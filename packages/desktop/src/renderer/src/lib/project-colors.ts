/**
 * Per-project identity colours for the quick-open rows and drill-in chips.
 *
 * This module implements the ADR-0004 project-identity-colour exception: one
 * hue per project drawn from outside the four app accents, used as *identity*
 * (a stable visual handle on a specific project) rather than decoration, and
 * the generation of that hue lives only here — no component may derive its own
 * hash or pick its own lightness.
 *
 * Why the fill is adaptive-lightness instead of fixed: a fixed-lightness fill
 * was measured across the whole hue wheel at S in {45, 55, 65}, L in [38, 52],
 * and the worst-case contrast against ink — taking whichever of black/white
 * ink is *better* per hue — bottoms out at 4.15:1. Cyan and yellow sit at
 * opposite luminance ends, so no single lightness can serve both. Hence the
 * scheme here: saturation fixed at 60, a fixed near-white ink (`INK`), and the
 * fill's L lowered from 60 until it clears WCAG AA against that ink. Every hue
 * then lands in the 4.52–5.08 ratio band — AA everywhere, one formula, no ink
 * switching.
 */

/** The fixed monogram ink: near-white on every generated fill. */
export const INK = "#f7f9fb";

/**
 * Stable hue for a project identity string (FNV-1a over UTF-16 code units).
 * Deterministic across runs and platforms; the seed format (e.g.
 * `repo:<slug>` / `local\0<dir>`) is the caller's identity, this maps it to
 * [0, 360).
 */
export function projectHue(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h % 360;
}

/**
 * AA-safe monogram fill + ink for a hue: highest integer L in [24, 60] whose
 * contrast against `INK` reaches >= 4.5 (falling back to L = 24 if the wheel
 * ever hands us something nothing clears — see module doc for why it can't).
 */
export function monogramColorsForHue(hue: number): { backgroundColor: string; color: string } {
  for (let l = 60; l >= 24; l--) {
    if (contrastRatio(hslToRgb(hue, 60, l), INK_RGB) >= 4.5) {
      return { backgroundColor: `hsl(${hue} 60% ${l}%)`, color: INK };
    }
  }
  return { backgroundColor: `hsl(${hue} 60% 24%)`, color: INK };
}

/** Monogram colours straight from a project identity seed. */
export function monogramColors(seed: string): { backgroundColor: string; color: string } {
  return monogramColorsForHue(projectHue(seed));
}

/**
 * Same-hue wash for the drill-in header chip: a translucent plate of the
 * identity colour at a fixed mid lightness, so it reads as *this project*
 * next to the row's monogram without needing its own AA guarantee (the text
 * on it is theme ink, not ours).
 */
export function identityWash(seed: string): { backgroundColor: string; borderColor: string } {
  const hue = projectHue(seed);
  return {
    backgroundColor: `hsl(${hue} 60% 55% / 0.22)`,
    borderColor: `hsl(${hue} 60% 55% / 0.45)`,
  };
}

// --- internals -------------------------------------------------------------

const INK_RGB: Rgb = [0xf7, 0xf9, 0xfb];

type Rgb = [number, number, number];

/** Standard HSL (degrees, %, %) → 0–255 integer RGB. */
function hslToRgb(h: number, s: number, l: number): Rgb {
  const sn = s / 100;
  const ln = l / 100;
  const a = sn * Math.min(ln, 1 - ln);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return ln - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/** WCAG relative luminance from 0–255 sRGB channels. */
function luminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const v = c / 255;
    return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.072 * lin(b);
}

function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
