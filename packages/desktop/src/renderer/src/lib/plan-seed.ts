/**
 * The plan body as prompt text. A fresh implementation session cannot reach the
 * planning session's `local://` artifacts, so the plan is embedded inline
 * (store.ts `spawnFreshImplementation`) — and an html plan's presentation layer
 * is pure cost there. Strip what is styling and keep what is spec.
 *
 * Deliberately not an html-to-markdown converter: the tags carry the plan's
 * structure (tables, headings, lists) and models read them fine. Only the
 * non-content nodes go.
 */
export function planSeedText(planText: string | null): string | null {
  if (planText === null) return null;
  if (!/^\s*(?:<!doctype|<html)/i.test(planText)) return planText;
  const stripped = planText
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  // A document that was nothing but styling is worse than no plan text at all:
  // the caller's fallback prompt at least does not lie about having a spec.
  // Tested on surviving text, not raw emptiness — the doctype/html/head/body
  // shell always survives the strip, so `stripped` is never the empty string.
  return stripped.replace(/<[^>]*>/g, "").trim() === "" ? null : stripped;
}
