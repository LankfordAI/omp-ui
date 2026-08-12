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
</style>`;

const GUARDRAIL_MARKER = new RegExp(
  `\\bid\\s*=\\s*(?:["']${GUARDRAIL_ID}["']|${GUARDRAIL_ID}(?=[\\s>]))`,
  "i",
);
const CLOSING_HEAD = /<\/head\s*>/i;
const OPENING_HTML = /<html(?:\s[^>]*)?>/i;

/**
 * Adds non-destructive readability and horizontal-containment guardrails to an
 * authored HTML plan. Apart from the stylesheet insertion, source bytes are
 * retained exactly.
 */
export function preparePlanDocument(html: string): string {
  if (GUARDRAIL_MARKER.test(html)) return html;

  if (CLOSING_HEAD.test(html)) {
    return html.replace(CLOSING_HEAD, `${PLAN_GUARDRAIL_STYLESHEET}$&`);
  }

  if (OPENING_HTML.test(html)) {
    return html.replace(OPENING_HTML, `$&<head>${PLAN_GUARDRAIL_STYLESHEET}</head>`);
  }

  return `${PLAN_GUARDRAIL_STYLESHEET}${html}`;
}
