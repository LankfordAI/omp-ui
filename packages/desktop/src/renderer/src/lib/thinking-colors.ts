/**
 * The thinking-level ramp (issue #946): cool end → iris → warm end, so a
 * higher effort reads warmer. Returns CSS colour strings (theme variables
 * mixed with color-mix), never raw hex — themes own the raw colours.
 */
export function thinkingLevelColor(index: number, count: number): string {
  if (count <= 1 || index < 0 || index >= count) return "var(--color-iris)";
  const f = index / (count - 1);
  if (f === 0.5) return "var(--color-iris)";
  return f < 0.5
    ? `color-mix(in srgb, var(--color-think-cool) ${Math.round((1 - f * 2) * 100)}%, var(--color-iris))`
    : `color-mix(in srgb, var(--color-think-warm) ${Math.round((f * 2 - 1) * 100)}%, var(--color-iris))`;
}

/** The slider fill: a gradient through every stop up to and including `index`. */
export function thinkingFillGradient(index: number, count: number): string {
  const stops = Array.from({ length: index + 1 }, (_, i) => thinkingLevelColor(i, count));
  if (stops.length === 1) stops.push(stops[0]!);
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
