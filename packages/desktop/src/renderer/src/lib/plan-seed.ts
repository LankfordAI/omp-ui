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

/** The fence info string planSeedText's body deserves: html docs keep their tags. */
export function planSeedInfo(planText: string): "markdown" | "html" {
  return /^\s*(?:<!doctype|<html)/i.test(planText) ? "html" : "markdown";
}

/**
 * True when `text` is, in its entirety, one HTML plan document: planSeedInfo's
 * doctype/html opener at the start and `</html>` closing the end. The native
 * transcript renders such text as the plan document instead of as prose or
 * code; a fragment, or a document with prose after it, stays text.
 */
export function isHtmlPlanDocument(text: string): boolean {
  return planSeedInfo(text) === "html" && /<\/html>\s*$/i.test(text);
}
