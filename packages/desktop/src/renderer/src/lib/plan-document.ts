import { useEffect, useState } from "react";
import { renderMermaidBlocks } from "./plan-diagrams";
import { HIGHLIGHT_PLACEHOLDER, highlightCodeBlocks } from "./plan-highlight";
import { currentThemeId, resolveTheme, useTheme, type Theme } from "./themes";

const GUARDRAIL_ID = "omp-ui-plan-guardrails";

// The guardrail stylesheet for one theme. It must remain the final stylesheet
// in an existing head so its important containment rules win over presentation
// authored by the plan. The code-plane declarations ride in the same sheet so
// a plan's own pre/code styling can never displace the plane (issue #319).
function guardrailStylesheet(theme: Theme): string {
  return `<style id="${GUARDRAIL_ID}">
html,
html::before,
html::after,
html :where(*:not(svg, svg *)),
html :where(*:not(svg, svg *))::before,
html :where(*:not(svg, svg *))::after {
  box-sizing: border-box !important;
}

html :where(*:not(svg, svg *)) {
  max-width: 100% !important;
  min-width: 0 !important;
  color: inherit !important;
  background-color: transparent !important;
  background-image: none !important;
}

:root,
body {
  color-scheme: light !important;
  color: #111 !important;
  background-color: #fff !important;
  background-image: none !important;
  width: 100% !important;
  max-width: 100% !important;
  min-inline-size: 0 !important;
  overflow-x: clip !important;
}

p,
h1,
h2,
h3,
h4,
h5,
h6,
blockquote,
ul,
ol,
li,
dt,
dd,
a,
th,
td,
caption,
pre,
code {
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

p,
h1,
h2,
h3,
h4,
h5,
h6,
blockquote,
ul,
ol,
li,
dt,
dd,
a,
th,
td,
caption {
  white-space: normal !important;
}

pre,
code {
  white-space: pre-wrap !important;
  /* Code plane (issue #319): the canvas stays light, but code sits on the
     active theme's sunken plane — the transcript's code plane — so the
     theme's token palette has the surface it was derived against. */
  background-color: ${theme.tokens["--color-sunken"]} !important;
  color: ${theme.code.foreground} !important;
  color-scheme: ${theme.dark ? "dark" : "light"} !important;
}

table {
  width: 100% !important;
  max-width: 100% !important;
  table-layout: fixed !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}

img,
video,
canvas,
svg {
  max-width: 100% !important;
  height: auto !important;
}

svg text {
  fill: #111 !important;
}

a,
a:link,
a:visited,
a:hover,
a:active {
  color: #0645ad !important;
  text-decoration: underline !important;
}
/* Rendered mermaid diagrams (issue #285): self-contained SVG with its own
   viewBox and inline styles. The :not(svg, svg *) negation above is not
   honored by every CSS parser, so the substitution gets an explicit
   carve-out — scale to the column, preserve aspect, never clip. */
/* Rendered mermaid diagrams (issues #285, #288): self-contained SVG with its
   own viewBox. mermaid emits width="100%", which stretches a tall flowchart to
   the column width and balloons its height (a 5-node TD chart reached
   ~850×1570 px with ~46px labels). The fix is to render at the intrinsic
   layout size mermaid computed — width/height:auto overrides the width="100%"
   attribute — and cap only the width so nothing overflows the column. Node
   size then stays consistent and readable regardless of node count: a tall
   diagram shows at natural size and scrolls modestly; a wide diagram still
   fills the column. Centered by the flex container. */
.omp-ui-diagram {
  display: flex;
  justify-content: center;
}

.omp-ui-diagram svg {
  width: auto !important;
  max-width: 100% !important;
  height: auto !important;
  display: block;
}
</style>`;
}

const GUARDRAIL_MARKER = new RegExp(
  `\\bid\\s*=\\s*(?:["']${GUARDRAIL_ID}["']|${GUARDRAIL_ID}(?=[\\s>]))`,
  "i",
);
const CLOSING_HEAD = /<\/head\s*>/i;
const OPENING_HTML = /<html(?:\s[^>]*)?>/i;

/**
 * Prepares an authored HTML plan for the sandboxed review iframe: highlights
 * any language-classed code blocks in the active theme (issue #319), renders
 * any `<pre class="mermaid">` diagram blocks to SVG (issue #285), then adds
 * non-destructive readability and horizontal-containment guardrails (the
 * token-colour rules ride inside the guardrail style). Apart from the code
 * highlighting, the diagram substitution, and the stylesheet insertion,
 * source bytes are retained exactly. Async because highlighting and mermaid
 * load behind dynamic imports; documents without either resolve in the same
 * microtask.
 */
export async function preparePlanDocument(
  html: string,
  theme: Theme = resolveTheme(currentThemeId()),
): Promise<string> {
  const { html: highlighted, tokenCss } = await highlightCodeBlocks(html, theme);
  html = await renderMermaidBlocks(highlighted);
  if (GUARDRAIL_MARKER.test(html)) return html;

  const base = guardrailStylesheet(theme);
  const stylesheet = tokenCss
    ? base.replace("</style>", `${tokenCss}\n</style>`)
    : base;

  if (CLOSING_HEAD.test(html)) {
    return html.replace(CLOSING_HEAD, `${stylesheet}$&`);
  }

  if (OPENING_HTML.test(html)) {
    return html.replace(OPENING_HTML, `$&<head>${stylesheet}</head>`);
  }

  return `${stylesheet}${html}`;
}

/** Prepared-document state exposed to the two plan surfaces (issue #312). */
export type PreparedPlanState =
  | { status: "pending" }
  | { status: "ready"; doc: string }
  | { status: "failed"; reason: string };

/** Layout probe result. "inconclusive" always passes through. */
export type LayoutProbeResult = "visible" | "empty" | "inconclusive";
export type LayoutProbe = (doc: string) => Promise<LayoutProbeResult>;

const DIAGRAM_PLACEHOLDER = /<!--omp-ui-diagram-\d+-->/;

/**
 * Structural verification of a prepared plan document (issue #312): asserts
 * the invariants a renderable plan satisfies, using the same tree
 * construction the review iframe would apply. Returns a human-readable
 * failure reason, or null when the document passes.
 */
export function verifyPlanStructure(prepared: string): string | null {
  if (DIAGRAM_PLACEHOLDER.test(prepared)) {
    return "a diagram placeholder survived substitution";
  }
  if (HIGHLIGHT_PLACEHOLDER.test(prepared)) {
    return "a highlight placeholder survived substitution";
  }

  const doc = new DOMParser().parseFromString(prepared, "text/html");

  // Injection guarantees the guardrail <style> by construction; absence means
  // an authored document carried the marker id on a non-style element and
  // dodged injection. tagName check instead of instanceof: HTMLStyleElement
  // is realm-bound and unavailable across realms in jsdom.
  const guardrail = doc.getElementById(GUARDRAIL_ID);
  if (guardrail === null || guardrail.tagName !== "STYLE") {
    return "the readability guardrail stylesheet is missing";
  }

  // Visible-content check: catches content swallowed by an unclosed comment
  // (the parser turns the remainder into a comment node) and content the
  // parser relocated into <head>. Threshold is deliberately > 0, not
  // "substantial": every observed blank-frame class produces exactly zero.
  const clone = doc.body.cloneNode(true) as HTMLElement;
  for (const hidden of clone.querySelectorAll("script, style, template, noscript")) {
    hidden.remove();
  }
  const hasText = (clone.textContent ?? "").trim().length > 0;
  const hasMedia = doc.body.querySelector("svg, img, canvas, video") !== null;
  if (!hasText && !hasMedia) {
    return "the document body has no visible content";
  }

  return null;
}

const PROBE_TIMEOUT_MS = 4000;

// Whether this environment performs real layout. jsdom lays out nothing (all
// rects are zero) and its iframe srcdoc load semantics are unreliable, so a
// layout-less environment resolves "inconclusive" without creating a frame —
// otherwise every jsdom test running the real pipeline would stall on the
// probe timeout or fail on false "empty" verdicts.
let layoutCapable: boolean | undefined;

function canMeasureLayout(): boolean {
  if (layoutCapable === undefined) {
    const el = document.createElement("div");
    el.textContent = "x";
    el.style.cssText = "position:absolute;visibility:hidden";
    document.body.appendChild(el);
    layoutCapable = el.getBoundingClientRect().height > 0;
    el.remove();
  }
  return layoutCapable;
}

/**
 * Authoritative layout pass (issue #312): loads the prepared document into a
 * hidden, throwaway iframe and measures that the body laid out visible
 * content. The frame grants allow-same-origin but never allow-scripts — the
 * framed document cannot execute, so the grant is a one-way parent→child
 * measurement channel. Only a definitive "loaded and measured empty" fails;
 * timeout, measurement error, or a layout-less environment resolve
 * "inconclusive" so the probe can never false-positive-block a valid plan.
 */
export const probePlanLayout: LayoutProbe = (doc) => {
  if (!canMeasureLayout()) return Promise.resolve("inconclusive");

  const { promise, resolve } = Promise.withResolvers<LayoutProbeResult>();
  const frame = document.createElement("iframe");
  let settled = false;
  const done = (result: LayoutProbeResult) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    frame.remove();
    resolve(result);
  };
  const timer = setTimeout(() => done("inconclusive"), PROBE_TIMEOUT_MS);

  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  frame.style.cssText =
    "position:absolute;left:-10000px;top:0;width:800px;height:600px;visibility:hidden;pointer-events:none;border:0";
  frame.addEventListener("load", () => {
    try {
      const body = frame.contentDocument?.body;
      if (!body) return done("inconclusive");
      const rect = body.getBoundingClientRect();
      const text = (body.innerText ?? body.textContent ?? "").trim();
      const visible =
        rect.height > 0 &&
        (text.length > 0 || body.querySelector("svg, img, canvas, video") !== null);
      done(visible ? "visible" : "empty");
    } catch {
      done("inconclusive");
    }
  });
  frame.srcdoc = doc;
  document.body.appendChild(frame);
  return promise;
};

/**
 * Full review pipeline (issue #312): prepare → structural verify → layout
 * probe. Never rejects — every failure mode settles as a `failed` state with
 * a human-readable reason, so the surfaces always have something to present
 * instead of a silent white void.
 */
export async function preparePlanForReview(
  html: string,
  probe: LayoutProbe = probePlanLayout,
  theme: Theme = resolveTheme(currentThemeId()),
): Promise<Exclude<PreparedPlanState, { status: "pending" }>> {
  let prepared: string;
  try {
    prepared = await preparePlanDocument(html, theme);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { status: "failed", reason: `document preparation failed: ${message}` };
  }

  const structural = verifyPlanStructure(prepared);
  if (structural !== null) return { status: "failed", reason: structural };

  let layout: LayoutProbeResult;
  try {
    layout = await probe(prepared);
  } catch {
    layout = "inconclusive";
  }
  if (layout === "empty") {
    return { status: "failed", reason: "prepared document rendered empty" };
  }
  return { status: "ready", doc: prepared };
}

/**
 * Prepared-document state for the two plan surfaces (PlanReview dock and the
 * transcript PlanCard): runs the full verification pipeline whenever the
 * input changes — `pending` while the first run is in flight, the previous
 * settled state while a re-run is in flight, so the iframe never blanks
 * mid-review. Any settled result (ready or failed) replaces the previous
 * state: a stale document is never shown for a plan that has changed.
 */
export function usePreparedPlanDocument(html: string | null): PreparedPlanState {
  const theme = useTheme();
  const [state, setState] = useState<PreparedPlanState>({ status: "pending" });
  useEffect(() => {
    if (html === null) {
      setState({ status: "pending" });
      return;
    }
    let alive = true;
    void preparePlanForReview(html, undefined, theme).then((settled) => {
      if (alive) setState(settled);
    });
    return () => {
      alive = false;
    };
    // Tokens carry their colour as inline classes, so a theme switch only
    // reaches the rendered plan by re-preparing it.
  }, [html, theme]);
  return state;
}
