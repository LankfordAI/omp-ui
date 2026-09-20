import { mixHex, type Theme } from "./themes";

export const GUARDRAIL_ID = "omp-ui-plan-guardrails";

/**
 * The restrictive plan-document CSP, shared by preflight and displayed
 * frames. Inline SVG and embedded data images remain supported; external
 * dependencies are not. Ordinary user-clicked links are unaffected (the
 * empty sandbox blocks navigation either way).
 */
export const PLAN_DOCUMENT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

export const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="${PLAN_DOCUMENT_CSP}">`;

/** The guardrail stylesheet for one theme. It must remain the final stylesheet
 * in the composed document so its important containment rules win over
 * presentation authored by the plan. The code-plane declarations ride in the
 * same sheet so a plan's own pre/code styling can never displace the plane
 * (issue #319), and the animation stop keeps layout probes deterministic (§4
 * of the preflight plan: nothing animates during measurement). */
export function guardrailStylesheet(theme: Theme, tokenCss: string): string {
  const canvas = theme.tokens["--color-surface"];
  const ink = theme.tokens["--color-ink"];
  const chip = theme.tokens["--color-hover"];
  const link = mixHex(theme.tokens["--color-iris"], ink, 0.7);
  const scheme = theme.dark ? "dark" : "light";
  // Hand-drawn SVG reaches the iframe byte-identical, so its authored shape
  // fills cannot be re-fitted the way mermaid's classDef hexes are (T2b). On
  // a dark canvas they become washes instead of unreadable pale cards: the
  // tint keeps the shape's geometry via its untouched stroke, and every label
  // is canvas ink on canvas-or-wash. Rendered mermaid is excluded — its own
  // palette already follows the canvas.
  const svgWash = theme.dark
    ? "svg:not(.omp-ui-diagram svg) :is(rect, path, polygon, circle, ellipse) {\n" +
      "  fill-opacity: 0.18 !important;\n" +
      "}\n"
    : "";
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

:root {
  color-scheme: ${scheme} !important;
  color: ${ink} !important;
  background-color: ${canvas} !important;
  background-image: none !important;
  width: 100% !important;
  max-width: 100% !important;
  min-inline-size: 0 !important;
  overflow-x: clip !important;
}

/* Body stays width:auto on purpose. Forcing 100% on top of the UA's 8px
   margin made every document 16px wider than the viewport — an invisible
   horizontal scroll in the review pane and a permanent LAYOUT_OVERFLOW in
   the probe. auto fills the containing block MINUS margins, so containment
   holds while an authored body margin stays authored layout, not overflow.
   The root already paints the full-viewport background, so the margin
   strips are the same canvas color. */
body {
  color-scheme: ${scheme} !important;
  color: ${ink} !important;
  background-color: ${canvas} !important;
  background-image: none !important;
  min-inline-size: 0 !important;
  overflow-x: clip !important;
}

/* Deterministic measurement (§4): the probe waits two frames, and a document
   that animates into or out of visibility would make the verdict random.
   A static plan document has nothing to animate anyway. */
*,
*::before,
*::after {
  animation: none !important;
  transition: none !important;
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

/* Inline chips (issue #380): a prose chip carries no syntax tokens, so it
   never needed the theme's plane — #375 lifted the block well one step and
   the chips rode along into its colour. Chips now take a tint one step off
   the canvas (--color-hover), so it reads on either theme, and no colour
   rule: they inherit the surrounding ink, so code inside a link stays
   link-coloured. */
code {
  background-color: ${chip} !important;
}

/* Code plane (issues #319, #375): block code keeps the active theme's raised
   plane so the token palette has a surface from its own family — one step up
   from the transcript's sunken plane, one step above the canvas, not a black
   well. A pre code selector outranks the chip rule by specificity
   (0-0-2 vs 0-0-1); the chip rule outranks the universal transparent rule by sheet order, the
   same tier-and-order mechanism the plane rule already relied on. */
pre,
pre code {
  background-color: ${theme.tokens["--color-raised"]} !important;
  color: ${theme.code.foreground} !important;
  color-scheme: ${scheme} !important;
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
  fill: ${ink} !important;
}

a,
a:link,
a:visited,
a:hover,
a:active {
  color: ${link} !important;
  text-decoration: underline !important;
}
/* Rendered mermaid diagrams (issues #285, #288): self-contained SVG with its
   own viewBox. mermaid emits width="100%", which stretches a tall flowchart to
   the column width and balloons its height (a 5-node TD chart reached
   ~850×1570 px with ~46px labels). The fix is to render at the intrinsic
   layout size mermaid computed — width/height:auto overrides the width="100%"
   attribute — and cap only the width so nothing overflows the column. Node
   size then stays consistent and readable regardless of node count, centered
   by the flex container. */
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
${svgWash}${tokenCss}</style>`;
}
