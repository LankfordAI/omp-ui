import type { Tone } from "../../lib/tone";

export type { Tone };

export const TONE_TEXT: Record<Tone, string> = {
  neutral: "text-ink-mid",
  signal: "text-signal",
  copper: "text-copper",
  rose: "text-rose",
  iris: "text-iris",
};

export const TONE_DOT: Record<Tone, string> = {
  neutral: "bg-ink-faint",
  signal: "bg-signal",
  copper: "bg-copper",
  rose: "bg-rose",
  iris: "bg-iris",
};

export const TONE_CHIP: Record<Tone, string> = {
  neutral: "border-line bg-raised text-ink-mid",
  signal: "border-signal-dim/50 bg-signal-wash text-signal",
  copper: "border-copper-dim/50 bg-copper-wash text-copper",
  rose: "border-rose-dim/50 bg-rose-wash text-rose",
  iris: "border-iris-dim/50 bg-iris-wash text-iris",
};

/** One border step up: the outline hover, and the resting ring that marks a solid tonal button. */
export const TONE_BORDER_RAISED: Record<Tone, string> = {
  neutral: "border-line-strong",
  signal: "border-signal-dim",
  copper: "border-copper-dim",
  rose: "border-rose-dim",
  iris: "border-iris-dim",
};

/** Full-accent border, hover-only: the solid tonal button's feedback. `neutral` is unused (solid neutral is `bg-ink`). */
export const TONE_BORDER_FULL_HOVER: Record<Tone, string> = {
  neutral: "hover:border-line-strong",
  signal: "hover:border-signal",
  copper: "hover:border-copper",
  rose: "hover:border-rose",
  iris: "hover:border-iris",
};

/** Outline hover: the border strengthens; the fill never brightness-filters (light washes lift to white — issue #66). */
export const TONE_BORDER_OUTLINE_HOVER: Record<Tone, string> = {
  neutral: "hover:border-line-strong",
  signal: "hover:border-signal-dim",
  copper: "hover:border-copper-dim",
  rose: "hover:border-rose-dim",
  iris: "hover:border-iris-dim",
};

/** Full-accent border, resting: the ring that marks a selected choice (Button `selected`). */
export const TONE_BORDER_FULL: Record<Tone, string> = {
  neutral: "border-line-strong",
  signal: "border-signal",
  copper: "border-copper",
  rose: "border-rose",
  iris: "border-iris",
};

export const TONE_CAPSULE: Record<Tone, string> = {
  neutral: "border-line bg-raised divide-line",
  signal: "border-signal-dim/50 bg-signal-wash divide-signal-dim/40",
  copper: "border-copper-dim/50 bg-copper-wash divide-copper-dim/40",
  rose: "border-rose-dim/50 bg-rose-wash divide-rose-dim/40",
  iris: "border-iris-dim/50 bg-iris-wash divide-iris-dim/40",
};
