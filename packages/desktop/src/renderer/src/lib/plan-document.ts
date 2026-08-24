import { useEffect, useState } from "react";
import { renderMermaidBlocks } from "./plan-diagrams";

const GUARDRAIL_ID = "omp-ui-plan-guardrails";

// This stylesheet must remain the final stylesheet in an existing head so its
// important containment rules win over presentation authored by the plan.
const PLAN_GUARDRAIL_STYLESHEET = `<style id="${GUARDRAIL_ID}">
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
   own viewBox. mermaid emits width:100%, so without a height cap a tall
   flowchart stretches to column width and balloons in height (a 5-node TD
   chart reached ~850×1570 px). Constrain by height too and keep the intrinsic
   aspect ratio: width/height auto lets the SVG scale down to whichever limit
   binds, centered by the flex container. Wide diagrams still fill the column;
   tall ones shrink to the cap instead of forcing a multi-screen scroll. */
.omp-ui-diagram {
  display: flex;
  justify-content: center;
}

.omp-ui-diagram svg {
  max-width: 100% !important;
  max-height: 28rem !important;
  width: auto !important;
  height: auto !important;
  display: block;
}
</style>`;

const GUARDRAIL_MARKER = new RegExp(
  `\\bid\\s*=\\s*(?:["']${GUARDRAIL_ID}["']|${GUARDRAIL_ID}(?=[\\s>]))`,
  "i",
);
const CLOSING_HEAD = /<\/head\s*>/i;
const OPENING_HTML = /<html(?:\s[^>]*)?>/i;

/**
 * Prepares an authored HTML plan for the sandboxed review iframe: renders any
 * `<pre class="mermaid">` diagram blocks to SVG (issue #285), then adds
 * non-destructive readability and horizontal-containment guardrails. Apart
 * from the diagram substitution and stylesheet insertion, source bytes are
 * retained exactly. Async because mermaid loads behind a dynamic import;
 * documents without diagrams resolve in the same microtask.
 */
export async function preparePlanDocument(html: string): Promise<string> {
  html = await renderMermaidBlocks(html);
  if (GUARDRAIL_MARKER.test(html)) return html;

  if (CLOSING_HEAD.test(html)) {
    return html.replace(CLOSING_HEAD, `${PLAN_GUARDRAIL_STYLESHEET}$&`);
  }

  if (OPENING_HTML.test(html)) {
    return html.replace(OPENING_HTML, `$&<head>${PLAN_GUARDRAIL_STYLESHEET}</head>`);
  }

  return `${PLAN_GUARDRAIL_STYLESHEET}${html}`;
}
/**
 * Prepared-document state for the two plan surfaces (PlanReview dock and the
 * transcript PlanCard): runs `preparePlanDocument` whenever the input changes
 * and returns the last resolved document — `null` while the first render is
 * in flight, the previous document while a re-render is in flight, so the
 * iframe never blanks mid-review.
 */
export function usePreparedPlanDocument(html: string | null): string | null {
  const [doc, setDoc] = useState<string | null>(null);
  useEffect(() => {
    if (html === null) {
      setDoc(null);
      return;
    }
    let alive = true;
    void preparePlanDocument(html).then((prepared) => {
      if (alive) setDoc(prepared);
    });
    return () => {
      alive = false;
    };
  }, [html]);
  return doc;
}
