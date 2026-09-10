/**
 * The HTML plan document pipeline (issue #312, ADR-0022, amended by the
 * issue #312 follow-up): prepare authored source into a prepared document via
 * source-range composition, verify structurally, probe real layout, and hand
 * machine diagnostics to whichever surface (or verifier) asked.
 *
 * The input contract is AUTHORED SOURCE ONLY. The prepared result is a
 * separate typed value and must never be fed back through preparation —
 * reuse the prepared document instead of preparing its generated HTML again.
 * Byte-string idempotence is deliberately gone; the authored/prepared split
 * is what keeps a plan that documents this pipeline's own markers ordinary
 * source (issue #331's text scan is retired with the marker protocol).
 *
 * Diagnostics are machine data (see `@omp-ui/core/plan`): stable codes,
 * source locations, bounded detail. Localized prose lives at the presentation
 * boundary (`PlanReview`, `PlanCard`), never in the pipeline.
 */
import type { PlanDiagnostic, PlanRenderResult } from "@omp-ui/core/plan";
import { parse } from "parse5";
import { planHighlightTransform } from "./plan-highlight";
import { planDiagramTransform, renderMermaid } from "./plan-diagrams";
import {
  childNodesOf,
  composePlanSource,
  insertAt,
  parsePlanSource,
  type DefaultElement,
  type DefaultNode,
  type DefaultTextNode,
  type ParsedPlanSource,
  type PlanReplacement,
} from "./plan-source";
import { DEFAULT_THEME_ID, mixHex, resolveTheme, type Theme } from "./themes";

const GUARDRAIL_ID = "omp-ui-plan-guardrails";

/**
 * The restrictive plan-document CSP, shared by preflight and displayed
 * frames. Inline SVG and embedded data images remain supported; external
 * dependencies are not. Ordinary user-clicked links are unaffected (the
 * empty sandbox blocks navigation either way).
 */
export const PLAN_DOCUMENT_CSP =
  "default-src 'none'; script-src 'none'; style-src 'unsafe-inline'; " +
  "img-src data:; font-src data:; base-uri 'none'; form-action 'none'";

const CSP_META =
  `<meta http-equiv="Content-Security-Policy" content="${PLAN_DOCUMENT_CSP}">`;

/** The guardrail stylesheet for one theme. It must remain the final stylesheet
 * in the composed document so its important containment rules win over
 * presentation authored by the plan. The code-plane declarations ride in the
 * same sheet so a plan's own pre/code styling can never displace the plane
 * (issue #319), and the animation stop keeps layout probes deterministic (§4
 * of the preflight plan: nothing animates during measurement). */
function guardrailStylesheet(theme: Theme, tokenCss: string): string {
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

/** The plan document's typed prepared result — never authored input (§2). */
export interface PreparedPlanDocument {
  doc: string;
  diagnostics: PlanDiagnostic[];
}

/* -------------------------------------------------------------------------- */
/* Resource discovery (§2): authored external dependencies fail as source      */
/* diagnostics instead of letting the verifier navigate or fetch them.         */
/* -------------------------------------------------------------------------- */

const URL_ATTRS: Record<string, Record<string, string>> = {
  script: { src: "script resource" },
  link: { href: "stylesheet or link resource" },
  img: { src: "image resource" },
  audio: { src: "audio resource", poster: "audio poster" },
  video: { src: "video resource", poster: "video poster" },
  source: { src: "media source" },
  track: { src: "media track" },
  embed: { src: "embed resource" },
  object: { data: "object resource" },
  iframe: { src: "nested document" },
};

/** `data:` and fragment targets need no network; everything else fetches. */
function isSelfContainedUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "" || trimmed.startsWith("#")) return true;
  const lowered = trimmed.toLowerCase();
  if (lowered.startsWith("data:")) return true;
  return false;
}

function walkAll(node: DefaultNode, visit: (el: DefaultElement) => void): void {
  for (const child of childNodesOf(node)) {
    const el = child as DefaultElement;
    if (el.tagName === undefined) {
      walkAll(child, visit);
      continue;
    }
    // Template CONTENT is inert; parse5 keeps it off childNodes, and foreign
    // subtrees still expose their own resource elements (svg image/script).
    visit(el);
    walkAll(child, visit);
    // parse5 attaches template content as a `content` member the default
    // tree adapter type does not expose structurally.
    const content = (el as Partial<{ content: DefaultNode }>).content;
    if (content !== undefined) walkAll(content, visit);
  }
}

/** Scan a url()-bearing declaration value; data: values are allowed. */
function declaredUrls(style: string): string[] {
  const urls: string[] = [];
  const pattern = /url\(([^)]*)\)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(style)) !== null) {
    const raw = (match[1] ?? "").trim().replace(/^['"]|['"]$/g, "");
    if (!isSelfContainedUrl(raw)) urls.push(raw);
  }
  return urls;
}

/**
 * The CSS dependency scan uses the browser's parsed rules (imports and
 * declarations alike) and reports at the OWNING style block or style
 * attribute — never a guessed token column (§2).
 */
function cssDependencyDiagnostics(parsed: ParsedPlanSource): PlanDiagnostic[] {
  const out: PlanDiagnostic[] = [];
  const located = (
    el: DefaultElement,
    detail: string,
    message: string,
  ): PlanDiagnostic => {
    const loc = el.sourceCodeLocation;
    const diag: PlanDiagnostic = {
      code: "EXTERNAL_RESOURCE",
      stage: "source",
      repair: "source",
      severity: "error",
      message,
      detail,
    };
    if (loc && loc.startOffset >= 0) {
      diag.location = {
        startOffset: loc.startOffset,
        endOffset: loc.endOffset,
        line: loc.startLine,
        column: loc.startCol,
      };
    }
    return diag;
  };
  const urlsOfParsedSheet = (text: string): string[] => {
    try {
      const sheet = new CSSStyleSheet();
      sheet.replaceSync(text);
      const found: string[] = [];
      const visitRules = (rules: Iterable<CSSRule>): void => {
        for (const rule of rules) {
          if (rule instanceof CSSImportRule) {
            if (!isSelfContainedUrl(rule.href)) found.push(rule.href);
            if (rule.styleSheet) visitRules(rule.styleSheet.cssRules);
            continue;
          }
          if (rule instanceof CSSStyleRule) {
            const style = rule.style;
            for (let i = 0; i < style.length; i += 1) {
              const prop = style.item(i);
              const value = style.getPropertyValue(prop);
              found.push(...declaredUrls(`${prop}: ${value}`));
            }
          }
          if ("cssRules" in rule) {
            // Grouped rules (media/container layers) hold nested rules; the
            // CSSOM type for that is not inferrable from the union member.
            const grouping = rule as CSSGroupingRule;
            visitRules(grouping.cssRules);
          }
        }
      };
      visitRules(sheet.cssRules);
      return found;
    } catch {
      // No parsable sheet (jsdom without the CSSOM constructor): fall back to
      // a raw scan of the block text, which misses nothing plan authors write.
      return declaredUrls(text);
    }
  };
  walkAll(parsed.document, (el) => {
    if (el.tagName === "style" && el.sourceCodeLocation) {
      const text = (el.childNodes ?? [])
        .map((c) => (c.nodeName === "#text" ? (c as DefaultTextNode).value : ""))
        .join("");
      const urls = urlsOfParsedSheet(text);
      for (const url of urls) {
        out.push(
          located(el, `url(${url})`, "a stylesheet references a resource the plan document cannot fetch"),
        );
      }
      return;
    }
    const styleAttr = (el.attrs ?? []).find((a) => a.name === "style");
    if (styleAttr !== undefined) {
      for (const url of urlsOfParsedSheet(styleAttr.value)) {
        out.push(
          located(el, `url(${url})`, "an inline style references a resource the plan document cannot fetch"),
        );
      }
    }
  });
  return out;
}

/** Element-level resource and refresh-meta scan of the authored document. */
function elementResourceDiagnostics(parsed: ParsedPlanSource): PlanDiagnostic[] {
  const out: PlanDiagnostic[] = [];
  walkAll(parsed.document, (el) => {
    const loc = el.sourceCodeLocation;
    const push = (detail: string, message: string): void => {
      const diag: PlanDiagnostic = {
        code: "EXTERNAL_RESOURCE",
        stage: "source",
        repair: "source",
        severity: "error",
        message,
        detail,
      };
      if (loc && loc.startOffset >= 0) {
        diag.location = {
          startOffset: loc.startOffset,
          endOffset: loc.endOffset,
          line: loc.startLine,
          column: loc.startCol,
        };
      }
      out.push(diag);
    };
    const attrs = el.attrs ?? [];
    if (el.tagName === "meta") {
      const equiv = attrs.find((a) => a.name === "http-equiv")?.value.toLowerCase();
      if (equiv === "refresh") {
        push("meta http-equiv=refresh", "a refresh meta tag would navigate the document; navigation is not allowed");
        return;
      }
    }
    const byAttr = URL_ATTRS[el.tagName];
    if (byAttr !== undefined) {
      for (const attr of attrs) {
        const label = byAttr[attr.name];
        if (label === undefined) continue;
        if (!isSelfContainedUrl(attr.value)) {
          push(`${el.tagName}[${attr.name}]=${attr.value.slice(0, 200)}`, `the document depends on an external ${label}`);
        }
      }
    }
    // SVG hrefs fetch too (image/xlink:href, a is excluded below).
    if (el.namespaceURI !== undefined && el.namespaceURI !== "http://www.w3.org/1999/xhtml") {
      for (const attr of attrs) {
        if ((attr.name === "href" || attr.name.endsWith(":href")) && el.tagName !== "a") {
          if (!isSelfContainedUrl(attr.value)) {
            push(`${el.tagName}[${attr.name}]=${attr.value.slice(0, 200)}`, "the document depends on an external resource");
          }
        }
      }
    }
  });
  return out;
}

/* -------------------------------------------------------------------------- */
/* Structure composition (§2): guardrail + CSP ride insertion ranges, never   */
/* replacement-template expansion.                                           */
/* -------------------------------------------------------------------------- */

function structureReplacements(
  parsed: ParsedPlanSource,
  stylesheet: string,
): PlanReplacement[] {
  const { structure } = parsed;
  if (structure.closingHeadOffset !== null) {
    // Both generated parts before the explicit `</head>`; the guardrail
    // stays the final stylesheet of the head (§ guardrail note).
    return [insertAt(structure.closingHeadOffset, CSP_META + stylesheet)];
  }
  const out: PlanReplacement[] = [];
  const styleAt = structure.closingBodyOffset ?? structure.eofOffset;
  out.push(insertAt(styleAt, stylesheet));
  if (structure.hasExplicitHtml && structure.afterHtmlOpen !== null) {
    out.push(insertAt(structure.afterHtmlOpen, `<head>${CSP_META}</head>`));
  } else {
    // A bare fragment: prepend the generated head before any authored bytes.
    out.push(insertAt(0, `<head>${CSP_META}</head>`));
  }
  return out;
}

/**
 * Structural verification of a PREPARED document (§3): the generated policy
 * and style are verified by querying the parsed result — not by searching
 * prose for their ids — plus the no-visible-content catch that used to read
 * raw bytes. Returns diagnostics; empty means the document is structurally
 * sound and the surfaces may show it (pending layout).
 */
export function verifyPlanStructure(prepared: string): PlanDiagnostic[] {
  const diagnostics: PlanDiagnostic[] = [];
  let doc: DefaultNode;
  try {
    doc = parse(prepared, { scriptingEnabled: false });
  } catch (err) {
    return [
      {
        code: "RENDER_INVARIANT",
        stage: "prepare",
        repair: "application",
        severity: "error",
        message: "the prepared document does not parse",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
      },
    ];
  }
  let cspSeen = false;
  let guardrailSeen = false;
  let visibleText = false;
  let mediaSeen = false;
  const skip = new Set(["script", "style", "template", "noscript"]);
  const walk = (node: DefaultNode): void => {
    for (const child of childNodesOf(node)) {
      const el = child as DefaultElement;
      if (el.tagName !== undefined) {
        const attrs = el.attrs ?? [];
        if (el.tagName === "style" && attrs.some((a) => a.name === "id" && a.value === GUARDRAIL_ID)) {
          guardrailSeen = true;
        }
        if (
          el.tagName === "meta" &&
          attrs.some((a) => a.name === "http-equiv" && a.value.toLowerCase() === "content-security-policy") &&
          attrs.some((a) => a.name === "content" && a.value === PLAN_DOCUMENT_CSP)
        ) {
          cspSeen = true;
        }
        if (["svg", "img", "canvas", "video"].includes(el.tagName)) mediaSeen = true;
        if (skip.has(el.tagName)) continue;
        walk(child);
        continue;
      }
      if (child.nodeName === "#text" && (child as DefaultTextNode).value.trim() !== "") {
        visibleText = true;
      }
    }
  };
  walk(doc);
  if (!cspSeen) {
    diagnostics.push({
      code: "RENDER_INVARIANT",
      stage: "prepare",
      repair: "application",
      severity: "error",
      message: "the prepared document is missing the plan CSP",
    });
  }
  if (!guardrailSeen) {
    diagnostics.push({
      code: "RENDER_INVARIANT",
      stage: "prepare",
      repair: "application",
      severity: "error",
      message: "the prepared document is missing the readability guardrail",
    });
  }
  if (!visibleText && !mediaSeen) {
    // Catches content swallowed by an unclosed comment and content the parser
    // relocated away from the body: the two observed blank-frame classes.
    diagnostics.push({
      code: "EMPTY_DOCUMENT",
      stage: "prepare",
      repair: "source",
      severity: "error",
      message: "the document body has no visible content",
    });
  }
  return diagnostics;
}

/**
 * Prepares an authored HTML plan: parse once, splice highlighted code and
 * rendered diagrams onto their original ranges, insert the guardrail and the
 * plan CSP as composition parts, and verify the composed result structurally.
 * Never rejects: every failure mode is a diagnostic; unchanged source slices
 * survive byte-for-byte and transformed code keeps its decoded text — dollar
 * sequences, Unicode, and trailing newlines included (issue #412).
 */
export async function preparePlanDocument(
  html: string,
  theme: Theme = resolveTheme(DEFAULT_THEME_ID),
): Promise<PreparedPlanDocument> {
  let parsed: ParsedPlanSource;
  try {
    parsed = parsePlanSource(html);
  } catch (err) {
    return {
      doc: "",
      diagnostics: [
        {
          code: "RENDER_INVARIANT",
          stage: "prepare",
          repair: "application",
          severity: "error",
          message: "the authored document could not be parsed",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        },
      ],
    };
  }
  const resources = [
    ...elementResourceDiagnostics(parsed),
    ...cssDependencyDiagnostics(parsed),
  ];
  const [highlight, diagrams] = [
    await planHighlightTransform(parsed, theme),
    await planDiagramTransform(parsed, renderMermaid, {
      dark: theme.dark,
      surface: theme.tokens["--color-surface"],
      ink: theme.tokens["--color-ink"],
    }),
  ];
  const stylesheet = guardrailStylesheet(theme, highlight.tokenCss);
  const replacements = [
    ...highlight.replacements,
    ...diagrams.replacements,
    ...structureReplacements(parsed, stylesheet),
  ];
  let doc: string;
  try {
    doc = composePlanSource(html, replacements);
  } catch (err) {
    return {
      doc: "",
      diagnostics: parsed.diagnostics.concat(resources, diagrams.diagnostics, [
        {
          code: "RENDER_INVARIANT",
          stage: "prepare",
          repair: "application",
          severity: "error",
          message: "document composition failed",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        },
      ]),
    };
  }
  return {
    doc,
    diagnostics: [
      ...parsed.diagnostics,
      ...resources,
      ...diagrams.diagnostics,
      ...verifyPlanStructure(doc),
    ],
  };
}

/** Prepared-document state exposed to the plan surfaces (§3). */
export type PreparedPlanState =
  | { status: "pending" }
  | { status: "ready"; doc: string; diagnostics: PlanDiagnostic[]; identity?: string }
  | { status: "failed"; doc: string | null; diagnostics: PlanDiagnostic[]; identity?: string }
  | {
      status: "unavailable";
      doc: string | null;
      diagnostics: PlanDiagnostic[];
      identity?: string;
    };

/** One layout sample's outcome. `inconclusive` can never become `passed`. */
export type LayoutProbeResult =
  | { status: "measured"; diagnostics: PlanDiagnostic[] }
  | {
      status: "inconclusive";
      code: "VERIFIER_TIMEOUT" | "VERIFIER_UNAVAILABLE";
      detail?: string;
    };
export type LayoutProbe = (doc: string, width: number) => Promise<LayoutProbeResult>;

const PROBE_TIMEOUT_MS = 4_000;

// Whether this environment performs real layout. jsdom lays out nothing (all
// rects are zero) and offers no trusted CSSOM constructor path, so a
// layout-less environment resolves inconclusive without creating a frame —
// surfaces then show the document but never claim a layout verdict.
let layoutCapable: boolean | undefined;

function canMeasureLayout(): boolean {
  if (layoutCapable === undefined) {
    const el = document.createElement("div");
    el.textContent = "x";
    el.style.cssText = "position:absolute;left:-10000px;top:0";
    document.body.appendChild(el);
    layoutCapable = el.getBoundingClientRect().height > 0;
    el.remove();
  }
  return layoutCapable;
}

/**
 * Authoritative layout pass (§4, rewritten): loads the prepared document
 * into a hidden, script-less, SAME-ORIGIN probe iframe (measurement channel
 * only — never `allow-scripts`) and measures REAL visible content at a real
 * width:
 *
 *  - nonempty text ranges or drawable SVG/image elements with nonzero client
 *    rects, visible (no hidden ancestor, opacity > 0), nonzero clip areas —
 *    body padding alone does not pass;
 *  - document-level horizontal overflow beyond one CSS pixel fails, while an
 *    explicit scroll container may scroll inside;
 *  - CSP violations and broken embedded data images are resource failures;
 *  - the frame is offscreen but NOT visibility-hidden and NOT opacity-zero —
 *    both inherit into every child and would fail the visibility rule.
 *
 * Waits for the intended document's load plus two animation frames on the
 * PARENT page's clock. The hidden child frame's animation clock may never
 * advance (background throttling of offscreen frames), which produced false
 * VERIFIER_TIMEOUT banners over a correctly displayed document (issue #415);
 * the settle delay is a scheduling aid, not part of the measured space, so
 * it runs on the trusted top-level window. A timeout, crash, or layout-less
 * environment is inconclusive, never passed.
 */
export const probePlanLayout: LayoutProbe = (doc, width = 800) => {
  if (!canMeasureLayout()) {
    return Promise.resolve({
      status: "inconclusive",
      code: "VERIFIER_UNAVAILABLE",
      detail: "this environment performs no layout",
    });
  }
  const { promise, resolve } = Promise.withResolvers<LayoutProbeResult>();
  const frame = document.createElement("iframe");
  let settled = false;
  const cleanup = (): void => {
    frame.remove();
  };
  const done = (result: LayoutProbeResult): void => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    cleanup();
    resolve(result);
  };
  // The timeout detail names the phase the probe never left, so a load that
  // never fired is told apart from a measurement that never ran after load.
  let phase: "waiting-for-load" | "waiting-for-parent-frames" = "waiting-for-load";
  const timer = setTimeout(
    () =>
      done({
        status: "inconclusive",
        code: "VERIFIER_TIMEOUT",
        detail:
          phase === "waiting-for-load"
            ? `no document load within ${PROBE_TIMEOUT_MS} ms`
            : `no measurement after document load within ${PROBE_TIMEOUT_MS} ms`,
      }),
    PROBE_TIMEOUT_MS,
  );
  // The load listener and the post-close ready-state check are BOTH paths to
  // measurement; this guard keeps a document that was already complete from
  // being measured twice.
  let measurementScheduled = false;
  const scheduleMeasurement = (): void => {
    if (settled || measurementScheduled) return;
    measurementScheduled = true;
    phase = "waiting-for-parent-frames";
    // Two PARENT-page animation frames (§4): the trusted top-level clock is
    // the renderer's own and always advances, unlike the hidden child's.
    void twoFrames(window).then(() => {
      if (settled) return;
      let probe: PlanDiagnostic[];
      try {
        probe = measureProbeFrame(frame, violations, width);
      } catch (err) {
        done({
          status: "inconclusive",
          code: "VERIFIER_UNAVAILABLE",
          detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
        });
        return;
      }
      done({ status: "measured", diagnostics: probe });
    });
  };
  const violations: string[] = [];
  frame.setAttribute("sandbox", "allow-same-origin");
  frame.setAttribute("aria-hidden", "true");
  frame.tabIndex = -1;
  // Offscreen without hidden visibility: the document must lay out as the
  // real review frame would, and an inherited `hidden` would make every
  // valid child fail the new visibility check.
  frame.style.cssText =
    `position:absolute;left:-100000px;top:0;width:${width}px;height:600px;pointer-events:none;border:0`;
  document.body.appendChild(frame);
  const childWin = frame.contentWindow;
  const childDoc = frame.contentDocument;
  if (childWin === null || childDoc === null) {
    done({ status: "inconclusive", code: "VERIFIER_UNAVAILABLE", detail: "no same-origin probe document" });
    return promise;
  }
  // document.write keeps ONE child window alive, so a violation listener
  // attached HERE sees blocked loads from the very first parse step —
  // violations dispatch inside the child, and only a same-origin window
  // (the single granted token) can carry them back.
  childWin.addEventListener("securitypolicyviolation", (event: SecurityPolicyViolationEvent) => {
    violations.push(event.blockedURI);
  });
  childDoc.open();
  // The load listener binds AFTER open() so it observes the intended
  // document's load, not the initial about:blank document's.
  frame.addEventListener("load", () => scheduleMeasurement(), { once: true });
  childDoc.write(doc);
  childDoc.close();
  // close() on an already-parsed document may complete synchronously; cover
  // that race here instead of relying on the load event alone.
  if (childDoc.readyState === "complete") scheduleMeasurement();
  return promise;
};

/** The measurements §4 prescribes, taken in the child's own coordinate space. */
function measureProbeFrame(
  frame: HTMLIFrameElement,
  violations: string[],
  width: number,
): PlanDiagnostic[] {
  const out: PlanDiagnostic[] = [];
  const childWin = frame.contentWindow;
  const childDoc = frame.contentDocument;
  if (childWin === null || childDoc === null) {
    throw new Error("probe frame lost its same-origin window");
  }
  const root = childDoc.documentElement;
  const body = childDoc.body;

  if (violations.length > 0) {
    out.push({
      code: "EXTERNAL_RESOURCE",
      stage: "layout",
      repair: "source",
      severity: "error",
      message: "the document attempted to load blocked resources",
      detail: violations.slice(0, 5).join(", ").slice(0, 1000),
    });
  }

  // Broken required embedded images: complete-but-failed loads with no pixels.
  for (const img of Array.from(childDoc.querySelectorAll("img"))) {
    if (img.complete && img.naturalWidth === 0 && img.currentSrc !== "") {
      out.push({
        code: "EXTERNAL_RESOURCE",
        stage: "layout",
        repair: "source",
        severity: "error",
        message: "an embedded image could not be loaded",
        detail: (img.currentSrc || img.getAttribute("src") || "").slice(0, 200),
      });
    }
  }

  // Visible content: real descendants only; body padding alone does not pass.
  let visibleContent = false;
  const isVisible = (el: Element): boolean =>
    typeof el.checkVisibility === "function"
      ? el.checkVisibility({ visibilityProperty: true, opacityProperty: true, contentVisibilityAuto: true })
      : !!(el as HTMLElement).offsetParent || el === childDoc.body;
  const candidates = Array.from(body.querySelectorAll("*")).slice(0, 4000);
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    const tag = el.tagName.toLowerCase();
    const drawable =
      tag === "svg" ||
      tag === "img" ||
      tag === "canvas" ||
      tag === "video" ||
      el instanceof SVGElement;
    if (drawable) {
      visibleContent = true;
      break;
    }
    const textChild = Array.from(el.childNodes).find(
      (n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "",
    );
    if (textChild !== undefined) {
      const range = childDoc.createRange();
      range.selectNodeContents(textChild);
      const rects = range.getClientRects();
      for (let i = 0; i < rects.length; i += 1) {
        const r = rects.item(i);
        if (r !== null && r.width > 0 && r.height > 0) {
          visibleContent = true;
          break;
        }
      }
      if (visibleContent) break;
    }
  }
  if (!visibleContent) {
    out.push({
      code: "LAYOUT_EMPTY",
      stage: "layout",
      repair: "source",
      severity: "error",
      message: "the document laid out no visible content",
      detail: `measured at ${Math.round(width)}px`,
    });
    return out;
  }

  // Document-level horizontal overflow beyond 1 CSS pixel fails. An explicit
  // scroll container (overflow-x other than visible) may overflow inside it.
  const rootWidth = root.getBoundingClientRect().width;
  const withinScrollContainer = (el: Element | null): boolean => {
    let node: Element | null = el;
    while (node !== null && node !== root) {
      const overflowX = childWin.getComputedStyle(node).overflowX;
      if (overflowX !== "visible" && node !== body) return true;
      node = node.parentElement;
    }
    return false;
  };
  for (const el of candidates) {
    if (!isVisible(el)) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;
    if (rect.right > rootWidth + 1 || rect.left < -1) {
      if (withinScrollContainer(el)) continue;
      out.push({
        code: "LAYOUT_OVERFLOW",
        stage: "layout",
        repair: "source",
        severity: "error",
        message: "content overflows the document horizontally",
        detail: `<${el.tagName.toLowerCase()}> at ${Math.round(rect.width)}px wide`,
      });
      break;
    }
  }
  return out;
}

/** Two animation frames on the given window's clock — the parent page's. */
function twoFrames(win: Window): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
  return promise;
}

/** One reviewed-pipeline outcome for the surfaces (§3). */
export type PreparedReviewOutcome =
  | { status: "ready"; doc: string; diagnostics: PlanDiagnostic[] }
  | { status: "failed"; doc: string | null; diagnostics: PlanDiagnostic[] }
  | { status: "unavailable"; doc: string | null; diagnostics: PlanDiagnostic[] };

function hasError(diagnostics: PlanDiagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}

export interface PlanReviewOptions {
  probe?: LayoutProbe;
  theme?: Theme;
  widths?: readonly number[];
  /** Cap on the prepared output; exceeding it is PLAN_RESOURCE_LIMIT — an
   * application limitation, never an instruction to shorten the plan. */
  preparedByteLimit?: number;
}

/**
 * Full review pipeline (§3): prepare → structural verify → layout probe at
 * each given width. A layout-inconclusive result is UNAVAILABLE, never
 * passed: an inconclusive probe may not masquerade as success (that gap was
 * this plan's starting observation). The document is still carried so a
 * surface can show it while naming what could not be confirmed.
 */
export async function preparePlanForReview(
  html: string,
  probe: LayoutProbe = probePlanLayout,
  theme: Theme = resolveTheme(DEFAULT_THEME_ID),
  options: PlanReviewOptions = {},
): Promise<PreparedReviewOutcome> {
  const widths = options.widths ?? [800];
  const prepared = await preparePlanDocument(html, theme);
  if (options.preparedByteLimit !== undefined && utf8Length(prepared.doc) > options.preparedByteLimit) {
    return {
      status: "unavailable",
      doc: null,
      diagnostics: prepared.diagnostics.concat([
        {
          code: "PLAN_RESOURCE_LIMIT",
          stage: "prepare",
          repair: "application",
          severity: "error",
          message: "the prepared document exceeds the verifier's byte limit",
          detail: `limit ${options.preparedByteLimit}`,
        },
      ]),
    };
  }
  if (hasError(prepared.diagnostics)) {
    return { status: "failed", doc: prepared.doc === "" ? null : prepared.doc, diagnostics: prepared.diagnostics };
  }
  const diagnostics = [...prepared.diagnostics];
  let inconclusive: LayoutProbeResult | null = null;
  for (const width of widths) {
    let result: LayoutProbeResult;
    try {
      result = await probe(prepared.doc, width);
    } catch (err) {
      result = {
        status: "inconclusive",
        code: "VERIFIER_UNAVAILABLE",
        detail: (err instanceof Error ? err.message : String(err)).slice(0, 200),
      };
    }
    if (result.status === "inconclusive") {
      inconclusive = result;
      diagnostics.push({
        code: result.code,
        stage: "layout",
        repair: "application",
        severity: "warning",
        message: "the layout probe could not conclude",
        detail: result.detail ?? `width ${width}px`,
      });
      break;
    }
    diagnostics.push(...result.diagnostics);
  }
  if (inconclusive !== null) {
    return { status: "unavailable", doc: prepared.doc, diagnostics };
  }
  if (hasError(diagnostics)) {
    return { status: "failed", doc: prepared.doc, diagnostics };
  }
  return { status: "ready", doc: prepared.doc, diagnostics };
}

const textEncoder = new TextEncoder();

function utf8Length(text: string): number {
  return textEncoder.encode(text).length;
}

/** The widths the render-stage preflight samples by default: desktop and phone. */
export const PLAN_PREFLIGHT_WIDTHS = [800, 360] as const;

/**
 * The render-stage preflight (§3): the SAME parser, transforms, structural
 * checks, and layout probe that `preparePlanForReview` runs, shaped for the
 * main process to combine with its own source hash. The verifier page calls
 * this with the theme resolved from the explicitly passed themeId — never
 * from localStorage or an `ompBackend` bridge.
 */
export async function renderPlanPreflight(
  html: string,
  theme: Theme = resolveTheme(DEFAULT_THEME_ID),
  options: PlanReviewOptions = {},
): Promise<PlanRenderResult> {
  const outcome = await preparePlanForReview(html, options.probe ?? probePlanLayout, theme, {
    ...options,
    widths: options.widths ?? PLAN_PREFLIGHT_WIDTHS,
  });
  if (outcome.status === "ready") {
    return { status: "passed", diagnostics: outcome.diagnostics };
  }
  return { status: outcome.status, diagnostics: outcome.diagnostics };
}
