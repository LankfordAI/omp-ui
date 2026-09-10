// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { PLAN_DOCUMENT_CSP, preparePlanDocument, verifyPlanStructure } from "./plan-document";
import { DEFAULT_THEME_ID, mixHex, resolveTheme } from "./themes";
import type { CodeTokenizer } from "./plan-highlight";
import type { Theme } from "./themes";
import type { DiagramRenderer, PlanCanvas } from "./plan-diagrams";
import type { PlanDiagnostic } from "@omp-ui/core/plan";
import type { ParsedPlanSource } from "./plan-source";

// The two seams of the prepare pass (issue #312 follow-up): the diagram
// renderer and the code tokenizer. Everything else — the parse, the ranges,
// the composition — runs for real, so these cases pin what the pipeline puts
// where, not mermaid's or shiki's engines (the `.smoke` files own those).
const seams = vi.hoisted(() => ({
  canvasDark: [] as (boolean | undefined)[],
  themes: [] as string[],
  tokenize: null as CodeTokenizer | null,
}));

vi.mock("./plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-diagrams")>();
  return {
    ...original,
    // Stub the network-weight renderer: unit tests exercise the splice
    // contract, not mermaid's layout engine (covered by the smoke test). The
    // real renderer the caller injected is replaced by the stub; the canvas
    // spec rides through untouched so these cases can assert the plan path no
    // longer drops darkness (issue #384).
    planDiagramTransform: (
      parsed: ParsedPlanSource,
      _render: DiagramRenderer,
      canvas?: PlanCanvas,
    ) => {
      seams.canvasDark.push(canvas?.dark);
      return original.planDiagramTransform(
        parsed,
        async (id: string) => `<svg data-diagram="${id}"></svg>`,
        canvas,
      );
    },
  };
});

// The stub tokenizer stands in for shiki: default `null` leaves every block
// plain (no token CSS), so the byte-identity cases pin the unhighlighted
// contract; a non-null result drives the token-splice cases.
vi.mock("./plan-highlight", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-highlight")>();
  return {
    ...original,
    planHighlightTransform: (
      parsed: ParsedPlanSource,
      theme: Theme,
      tokenize?: CodeTokenizer,
    ) => {
      seams.themes.push(theme.id);
      return original.planHighlightTransform(
        parsed,
        theme,
        tokenize ?? seams.tokenize ?? (async () => null),
      );
    },
  };
});

afterEach(() => {
  seams.tokenize = null;
  seams.themes.length = 0;
});

const MARKER = 'id="omp-ui-plan-guardrails"';
const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${PLAN_DOCUMENT_CSP}">`;
const GUARDRAIL_RE = new RegExp(`<style ${MARKER}>[\\s\\S]*?</style>`, "g");

function guardrailCss(doc: string): string {
  const match = doc.match(/<style id="omp-ui-plan-guardrails">([\s\S]*?)<\/style>/);
  if (!match?.[1]) throw new Error("guardrail stylesheet was not injected");
  return match[1];
}

/** Remove the parts composition GENERATED (the CSP meta, a generated head
 * wrapper, the guardrail sheet); what remains must be the authored bytes. */
function stripGenerated(doc: string): string {
  return doc
    .replace(`<head>${CSP_META}</head>`, "")
    .replace(CSP_META, "")
    .replace(/<style id="omp-ui-plan-guardrails">[\s\S]*?<\/style>/, "");
}

/** The composed document with the generated parts and all markup dropped:
 * what a reader of the rendered page sees, entity form included. */
function visibleText(doc: string): string {
  return stripGenerated(doc).replace(/<[^>]*>/g, "");
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function errors(diagnostics: PlanDiagnostic[]): string[] {
  return diagnostics.filter((d) => d.severity === "error").map((d) => d.code);
}

describe("preparePlanDocument structure", () => {
  it("lands the CSP and the guardrail before an explicit </head>, byte-preserving the rest", async () => {
    const source =
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><style>.plan{color:red}</style></head><body><h1>Plan</h1></body></html>';
    const { doc, diagnostics } = await preparePlanDocument(source);

    expect(errors(diagnostics)).toEqual([]);
    expect(doc.startsWith('<!doctype html>\n<html lang="en"><head>')).toBe(true);
    // Both generated parts ride one insertion range at the parsed end-tag
    // offset, CSP first so the guardrail stays the final stylesheet (§2).
    expect(doc.indexOf(CSP_META)).toBeLessThan(doc.indexOf(MARKER));
    expect(doc.indexOf(MARKER)).toBeLessThan(doc.indexOf("</head>"));
    expect(doc.endsWith("<body><h1>Plan</h1></body></html>")).toBe(true);
    expect(stripGenerated(doc)).toBe(source);
  });

  it("generates a complete head after an explicit <html> when no head closes", async () => {
    const source = '<!DOCTYPE html><html data-plan="alpha"><body>Plan</body></html>';
    const { doc, diagnostics } = await preparePlanDocument(source);

    expect(errors(diagnostics)).toEqual([]);
    expect(
      doc.startsWith(`<!DOCTYPE html><html data-plan="alpha"><head>${CSP_META}</head><body>`),
    ).toBe(true);
    // No head to close, so the sheet rides the parsed body end tag instead.
    expect(doc).toContain(`</style></body></html>`);
    expect(stripGenerated(doc)).toBe(source);
  });

  it("prepends the generated head to a bare fragment and appends the sheet at eof", async () => {
    const fragment = "<article>\n  <h1>Plan</h1>\n  <p>Keep me exact.</p>\n</article>";
    const { doc, diagnostics } = await preparePlanDocument(fragment);

    expect(errors(diagnostics)).toEqual([]);
    expect(doc.startsWith(`<head>${CSP_META}</head><article>`)).toBe(true);
    expect(doc).toContain(`</article><style ${MARKER}>`);
    expect(stripGenerated(doc)).toBe(fragment);
  });

  it("takes the closing head from the parse, not from a case-sensitive scan", async () => {
    const source = "<!DoCtYpE html><HTML><HeAd><title>Plan</title></hEaD><body>x</body></HTML>";
    const { doc } = await preparePlanDocument(source);

    expect(doc).toContain(`<title>Plan</title>${CSP_META}<style ${MARKER}>`);
    expect(doc).toContain(`</style></hEaD><body>x</body>`);
    // No generated head: the authored one closed, so nothing was synthesised.
    expect(doc.match(/<head>/gi)).toHaveLength(1);
    expect(stripGenerated(doc)).toBe(source);
  });

  it("injects the guardrail into a plan that documents the marker and the CSP as content", async () => {
    // A plan about the plan renderer quotes the id in an inline chip and the
    // CSP meta in a code block; quoted text must never read as "already
    // prepared" (issue #331), and it must not double the policy either.
    const quoted = CSP_META.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const body =
      `<body><p>The renderer injects <code>${MARKER}</code>.</p>` +
      `<pre><code>${quoted}</code></pre><p>end</p></body>`;
    const { doc, diagnostics } = await preparePlanDocument(
      `<html><head></head>${body}</html>`,
    );

    expect(errors(diagnostics)).toEqual([]);
    expect(doc.match(GUARDRAIL_RE)).toHaveLength(1);
    expect(countOf(doc, CSP_META)).toBe(1);
    // The quoted text survived as text, not as policy or as a second sheet.
    expect(doc).toContain(`<code>${MARKER}</code>`);
    expect(doc).toContain(`<pre><code>${quoted}</code></pre>`);
    expect(doc.indexOf(MARKER)).toBeLessThan(doc.indexOf("</head>"));
  });

  it("treats authored marker-lookalike comments as ordinary bytes", async () => {
    const source =
      "<html><head><title>t</title></head><body><h1>Plan</h1><!--omp-ui-highlight-0-->" +
      "<p>tail</p><!--omp-ui-diagram-1--></body></html>";
    const { doc, diagnostics } = await preparePlanDocument(source);

    expect(errors(diagnostics)).toEqual([]);
    expect(countOf(doc, "omp-ui-highlight-0")).toBe(1);
    expect(countOf(doc, "omp-ui-diagram-1")).toBe(1);
    expect(stripGenerated(doc)).toBe(source);
  });

  it("carries the CSP and the guardrail exactly once for every document shape", async () => {
    // MISSING_CSP / MISSING_GUARDRAIL are reserved: composition always lands
    // both parts, so the structural verifier of a prepared document must find
    // them for a fragment, an implied head, and an authored head alike.
    const shapes = [
      "<p>plan</p>",
      "<!doctype html><html><body>plan</body></html>",
      "<html><head><title>t</title></head><body><p>plan</p></body></html>",
      "<!doctype html>\n<HTML>\n<HEAD></HEAD>\n<BODY><p>plan</p></BODY>\n</HTML>",
    ];
    for (const html of shapes) {
      const { doc, diagnostics } = await preparePlanDocument(html);
      expect(errors(diagnostics), html).toEqual([]);
      expect(countOf(doc, CSP_META), html).toBe(1);
      expect(doc.match(GUARDRAIL_RE), html).toHaveLength(1);
      expect(verifyPlanStructure(doc), html).toEqual([]);
    }
  });
});

describe("preparePlanDocument diagnostics", () => {
  it("reports an empty document at the prepare stage", async () => {
    for (const source of ["", "<html><head></head><body></body></html>"]) {
      const { diagnostics } = await preparePlanDocument(source);
      expect(
        diagnostics
          .filter((d) => d.severity === "error")
          .map((d) => [d.code, d.stage, d.repair, d.message]),
        source,
      ).toEqual([["EMPTY_DOCUMENT", "prepare", "source", "the document body has no visible content"]]);
    }
  });

  it("reports a swallowed body at the prepare stage and keeps the composition", async () => {
    const { doc, diagnostics } = await preparePlanDocument(
      "<html><head></head><body><!-- oops <h1>Plan</h1></body></html>",
    );
    expect(errors(diagnostics)).toContain("EMPTY_DOCUMENT");
    // Composition still ran: the document is returned, never authored input.
    expect(countOf(doc, CSP_META)).toBe(1);
  });

  it("fails authored external resources as source findings located on the element", async () => {
    // `[authored, detail, message, tag]`. A `style=""` ATTRIBUTE is not in the
    // table: `cssDependencyDiagnostics` hands declaration lists to
    // `CSSStyleSheet.replaceSync`, which throws in Chromium (the fallback
    // catches it) but parses to an empty sheet in jsdom, so only a `<style>`
    // block's url() is observable here — see the report on the source seam.
    const cases: [string, string, string, string][] = [
      [
        '<script src="https://cdn.example/app.js"></script>',
        "script[src]=https://cdn.example/app.js",
        "external script resource",
        "script",
      ],
      [
        '<link rel="stylesheet" href="https://cdn.example/a.css">',
        "link[href]=https://cdn.example/a.css",
        "external stylesheet or link resource",
        "link",
      ],
      [
        '<img src="https://cdn.example/a.png" alt="a">',
        "img[src]=https://cdn.example/a.png",
        "external image resource",
        "img",
      ],
      [
        '<iframe src="https://cdn.example/embed"></iframe>',
        "iframe[src]=https://cdn.example/embed",
        "external nested document",
        "iframe",
      ],
      [
        // Longhand: a `background` shorthand is enumerated together with the
        // longhand it expands into, so its url would be reported twice.
        "<style>p{background-image:url(https://cdn.example/bg.png)}</style>",
        "url(https://cdn.example/bg.png)",
        "a stylesheet references a resource",
        "style",
      ],
      [
        '<meta http-equiv="refresh" content="0">',
        "meta http-equiv=refresh",
        "navigation is not allowed",
        "meta",
      ],
    ];
    for (const [authored, detail, message, tag] of cases) {
      const source = `<html><head></head><body><h1>Plan</h1>${authored}</body></html>`;
      const { diagnostics } = await preparePlanDocument(source);
      const found = diagnostics.filter((d) => d.code === "EXTERNAL_RESOURCE");
      expect(found, authored).toHaveLength(1);
      const [diag] = found;
      expect(diag?.stage, authored).toBe("source");
      expect(diag?.repair, authored).toBe("source");
      expect(diag?.severity, authored).toBe("error");
      expect(diag?.detail, authored).toBe(detail);
      expect(diag?.message, authored).toContain(message);
      // The location is the parsed element range, not a guessed column.
      expect(diag?.location, authored).toBeDefined();
      const slice = source.slice(diag?.location?.startOffset, diag?.location?.endOffset);
      expect(slice, authored).toContain(`<${tag}`);
    }
  });

  it("accepts data: and fragment URLs as self-contained", async () => {
    const source =
      '<html><head></head><body><h1>Plan</h1><img src="data:image/png;base64,iVBORw0KGgo=" alt="a">' +
      '<a href="#section">jump</a><svg><circle r="4"/></svg></body></html>';
    const { doc, diagnostics } = await preparePlanDocument(source);
    expect(errors(diagnostics)).toEqual([]);
    expect(doc).toContain("data:image/png;base64,iVBORw0KGgo=");
  });
});

describe("preparePlanDocument guardrails", () => {
  it("paints the canvas and ink from the active theme over hostile plan colors", async () => {
    const source =
      "<html><head><style>:root,body,p{color:#fff;background:transparent}</style></head>" +
      '<body style="color: white; background: transparent"><p>Readable</p></body></html>';
    const { doc: prepared } = await preparePlanDocument(source, resolveTheme("graphite"));
    const graphite = guardrailCss(prepared);
    expect(prepared.indexOf("color:#fff")).toBeLessThan(prepared.indexOf(MARKER));
    // The theme canvas and ink must be declared with !important for BOTH
    // root and body, so neither an authored `:root, body` reset nor inline
    // hostiles can win (the two selectors may share a rule or split — the
    // contract is the declarations, not the grouping).
    const rulesFor = (css: string, selector: string): string => {
      const at = new RegExp(`(^|\\n)${selector}\\s*(,[^\\n{]*)?\\{`, "m");
      const hit = css.match(at);
      if (!hit) return "";
      const from = hit.index ?? 0;
      return css.slice(from + hit[0].length, css.indexOf("}", from));
    };
    for (const sel of [":root", "body"]) {
      const graphiteRule = rulesFor(graphite, sel);
      expect(graphiteRule, sel).toContain("color-scheme: dark !important");
      expect(graphiteRule, sel).toContain("color: #e8ecf1 !important");
      expect(graphiteRule, sel).toContain("background-color: #14171b !important");
    }
    const { doc: light } = await preparePlanDocument(source, resolveTheme("light"));
    for (const sel of [":root", "body"]) {
      const lightRule = rulesFor(guardrailCss(light), sel);
      expect(lightRule, sel).toContain("color-scheme: light !important");
      expect(lightRule, sel).toContain("color: #12161b !important");
      expect(lightRule, sel).toContain("background-color: #fafbfc !important");
    }
    expect(guardrailCss(light)).toContain(`html :where(*:not(svg, svg *)) {
  max-width: 100% !important;
  min-width: 0 !important;
  color: inherit !important;
  background-color: transparent !important;
  background-image: none !important;
}`);
  });

  it("paints block code on the theme plane and inline chips on a canvas tint", async () => {
    const source =
      "<html><head><style>pre{background:#f1f5f9;color:#000}code{background:#e8edf3}</style></head>" +
      "<body><p>inline <code>chip</code></p><pre><code>x = 1</code></pre></body></html>";
    const { doc: prepared } = await preparePlanDocument(source, resolveTheme("graphite"));
    const css = guardrailCss(prepared);

    expect(css).toContain(`background-color: #1a1e23 !important;`);
    expect(css).toContain(`color: #e8ecf1 !important;`);
    expect(css).toContain(`color-scheme: dark !important;`);
    expect(css).toContain(`white-space: pre-wrap !important;`);
    // Same specificity and !important tier as the universal rule: the plane
    // holds only because it sits later in the sheet.
    expect(prepared.indexOf("background-color: #1a1e23 !important")).toBeGreaterThan(
      prepared.indexOf("background-color: transparent !important"),
    );
    expect(css).toContain(`code {
  background-color: #2a3037 !important;
}`);
    expect(css).toContain(`pre,
pre code {`);
    // chip rule beats the universal transparent rule by order
    expect(css.indexOf("background-color: #2a3037 !important")).toBeGreaterThan(
      css.indexOf("background-color: transparent !important"),
    );
  });

  it("follows light themes with a light code plane", async () => {
    const source = "<html><head></head><body><pre><code>x</code></pre></body></html>";
    const { doc: prepared } = await preparePlanDocument(source, resolveTheme("light"));
    const css = guardrailCss(prepared);

    expect(css).toContain(`background-color: #ffffff !important;`);
    expect(css).toContain(`color: #12161b !important;`);
    expect(css).toContain(`color-scheme: light !important;`);
    expect(css).toContain(`background-color: #e6ebf0 !important;`);
  });

  it("contains fixed content-box layouts without erasing authored padding or borders", async () => {
    const source =
      '<div style="box-sizing:content-box;width:1200px;padding:80px;border:12px solid red">Wide</div>';
    const { doc: prepared } = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    // The authored element passes through untouched; only generated parts moved.
    expect(prepared).toContain(source);
    expect(css).toContain(`html,
html::before,
html::after,
html :where(*:not(svg, svg *)),
html :where(*:not(svg, svg *))::before,
html :where(*:not(svg, svg *))::after {
  box-sizing: border-box !important;
}`);
    expect(css).toContain("max-width: 100% !important;");
    expect(css).toContain("min-width: 0 !important;");
    expect(css).not.toMatch(/(?:^|[;{]\s*)(?:font|margin|padding|border)\s*:/m);
  });

  it("wraps prose, headings, lists, links, cells, captions, and unbroken preformatted text", async () => {
    const token = "x".repeat(400);
    const source = `<h1>${token}</h1><ul><li>${token}</li></ul><table><caption>${token}</caption><tr><td>${token}</td></tr></table><pre><code>${token}</code></pre><a href="#x">${token}</a>`;
    const { doc: prepared } = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    expect(css).toContain(`p,
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
}`);
    expect(css).toContain(`pre,
code {
  white-space: pre-wrap !important;
}`);
    // The link is the accent mixed 30% toward the theme ink (issue #384);
    // asserted through mixHex so the formula is pinned, not a second literal.
    const graphite = resolveTheme("graphite");
    const link = mixHex(graphite.tokens["--color-iris"], graphite.tokens["--color-ink"], 0.7);
    expect(css).toContain(`a,
a:link,
a:visited,
a:hover,
a:active {
  color: ${link} !important;
  text-decoration: underline !important;
}`);
  });

  it("forces wide tables to fill and stay within the available width", async () => {
    const source =
      '<html><head></head><body><table style="width:1600px;table-layout:auto"><tr><td>unbroken-cell-content</td></tr></table></body></html>';
    const { doc: prepared } = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    expect(css).toContain(`table {
  width: 100% !important;
  max-width: 100% !important;
  table-layout: fixed !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}`);
  });

  it("constrains oversized media, paints SVG text with theme ink, and washes hand-drawn fills on dark only", async () => {
    const source =
      '<html><head></head><body><img width="2400" height="1200" alt="a"><svg width="2400" height="800"><circle cx="30" cy="30" r="20" fill="red"/><text x="0" y="20" fill="white">Plan</text></svg></body></html>';
    const { doc: prepared } = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    // The oversized media markup passes through untouched; only the head grew.
    expect(stripGenerated(prepared)).toBe(source);
    const blanketSelectors = [...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)]
      .filter(
        ([, , declarations]) =>
          declarations.includes("box-sizing: border-box") ||
          declarations.includes("color: inherit") ||
          declarations.includes("background-color: transparent"),
      )
      .map(([, selectors]) => selectors.trim());

    expect(blanketSelectors).toEqual([
      `html,
html::before,
html::after,
html :where(*:not(svg, svg *)),
html :where(*:not(svg, svg *))::before,
html :where(*:not(svg, svg *))::after`,
      "html :where(*:not(svg, svg *))",
    ]);
    expect(css).toContain(`img,
video,
canvas,
svg {
  max-width: 100% !important;
  height: auto !important;
}`);
    expect(css).toContain(`svg text {
  fill: #e8ecf1 !important;
}`);
    expect(css).not.toMatch(/svg\s+(?:circle|ellipse|line|path|polygon|polyline|rect)\s*{/);
    // Hand-drawn shape fills become washes on a dark canvas (issue #384):
    // opacity only — the shapes themselves stay outside the guardrail.
    expect(css).toContain(`svg:not(.omp-ui-diagram svg) :is(rect, path, polygon, circle, ellipse) {
  fill-opacity: 0.18 !important;
}`);
    const { doc: light } = await preparePlanDocument(source, resolveTheme("light"));
    expect(guardrailCss(light)).not.toContain("fill-opacity");
  });
});

describe("preparePlanDocument diagram substitution", () => {
  it("renders a mermaid block to SVG over the block's own range", async () => {
    const source =
      '<html><head><title>Plan</title></head><body><pre class="mermaid">flowchart TD; A-->B</pre></body></html>';
    const { doc: prepared, diagnostics } = await preparePlanDocument(source);

    expect(errors(diagnostics)).toEqual([]);
    expect(prepared).toContain(
      '<div class="omp-ui-diagram"><svg data-diagram="omp-ui-diagram-0"></svg></div>',
    );
    expect(prepared).not.toContain('<pre class="mermaid">');
    expect(prepared).toContain(MARKER);
    // The rendered diagram replaces the authored pre in place: everything
    // outside that one range is untouched.
    const substitute =
      '<div class="omp-ui-diagram"><svg data-diagram="omp-ui-diagram-0"></svg></div>';
    expect(stripGenerated(prepared).replace(substitute, '<pre class="mermaid">flowchart TD; A-->B</pre>')).toBe(
      source,
    );
  });

  it("hands the canvas spec to substitution instead of dropping darkness", async () => {
    // Issue #384: the plan path forwards the theme's canvas, so mermaid and
    // the authored-paint fit see the darkness the document actually lands on.
    seams.canvasDark.length = 0;
    const source = '<html><head></head><body><pre class="mermaid">graph TD; A-->B</pre></body></html>';
    await preparePlanDocument(source, resolveTheme("graphite"));
    await preparePlanDocument(source, resolveTheme("light"));

    expect(seams.canvasDark).toEqual([true, false]);
  });

  it("ships the containment carve-out for rendered diagrams", async () => {
    const { doc: prepared } = await preparePlanDocument("<p>plan</p>");
    const css = guardrailCss(prepared);

    expect(css).toContain(`.omp-ui-diagram svg {
  width: auto !important;
  max-width: 100% !important;
  height: auto !important;
  display: block;
}`);
    // Diagrams render at intrinsic layout size (useMaxWidth:false in mermaid),
    // capped only by column width — node size stays consistent regardless of
    // node count, so tall charts no longer balloon (issue #288).
    expect(css).toContain(`.omp-ui-diagram {
  display: flex;
  justify-content: center;
}`);
  });
});

describe("preparePlanDocument code highlighting (issue #319)", () => {
  it("passes the explicit theme through and defaults to the default theme", async () => {
    const source = "<p>plan</p>";
    seams.themes.length = 0;
    const explicit = { ...resolveTheme(DEFAULT_THEME_ID), id: "explicit" };
    await preparePlanDocument(source, explicit);
    await preparePlanDocument(source);

    expect(seams.themes).toEqual(["explicit", DEFAULT_THEME_ID]);
  });

  it("splices token spans onto the block range and lands the token CSS in the guardrail sheet", async () => {
    seams.tokenize = async () => [[{ content: "x", color: "#123456", offset: 0 }]];
    const source =
      '<html><head><title>t</title></head><body><pre><code class="language-python">x</code></pre></body></html>';
    const { doc: prepared, diagnostics } = await preparePlanDocument(source);

    expect(errors(diagnostics)).toEqual([]);
    expect(prepared).toContain('<pre class="omp-ui-hl"><code><span class="tk-0">x</span></code></pre>');
    const css = guardrailCss(prepared);
    expect(css).toContain(".omp-ui-hl .tk-0 { color: #123456 !important; }");
    // The token rules ride inside the guardrail stylesheet, which stays the
    // final stylesheet in the head.
    expect(prepared.indexOf(".omp-ui-hl .tk-0")).toBeGreaterThan(prepared.indexOf(MARKER));
    expect(prepared.indexOf(MARKER)).toBeLessThan(prepared.indexOf("</head>"));
  });

  it("keeps every byte outside the transformed block untouched", async () => {
    seams.tokenize = async () => [[{ content: "1", color: "#123456", offset: 0 }]];
    const source =
      '<html><head><title>t</title></head><body><h1>Weird &amp; wild</h1>' +
      '<p aria-label="a &gt; b">$& and $\' stay literal</p>' +
      '<pre class="wide"><code class="language-json">1</code></pre>' +
      "<p>café — unicode ok</p></body></html>";
    const { doc: prepared, diagnostics } = await preparePlanDocument(source);

    expect(errors(diagnostics)).toEqual([]);
    // Only the class attributes and the code body moved.
    expect(prepared).toContain('<h1>Weird &amp; wild</h1>');
    expect(prepared).toContain('<p aria-label="a &gt; b">$& and $\' stay literal</p>');
    expect(prepared).toContain("<p>café — unicode ok</p>");
    expect(prepared).toContain('<pre class="wide omp-ui-hl"><code><span class="tk-0">1</span></code></pre>');
  });
});

describe("preparePlanDocument dollar regressions (issue #412)", () => {
  // Block 1 ends in dollar-followed-by-quote exactly like the reported release
  // plan's Step 7 Bash regex (`$'` is the String.replace "after-match"
  // pattern); block 2 carries `$&` (decoded from `$&amp;`). Under the old
  // replacement-string pipeline either one rewrote the tail of the document.
  const FIXTURE = [
    "<!doctype html>",
    "<html><head><title>p</title></head><body>",
    "<h1>Release steps</h1>",
    `<pre><code class="language-bash">awk '/total:$/' report.csv</code></pre>`,
    "<!--omp-ui-highlight-0-->",
    '<pre><code class="language-json">{"k": "a$&amp;b"}\n</code></pre>',
    "<p>café — unicode ok</p>",
    "</body></html>",
  ].join("\n");

  it("keeps dollar sequences literal and later blocks exactly once", async () => {
    const { doc, diagnostics } = await preparePlanDocument(FIXTURE, resolveTheme(DEFAULT_THEME_ID));

    // The dollar-quote survives literally, once, in its own block.
    expect(countOf(doc, `awk '/total:$/' report.csv`)).toBe(1);
    // The authored marker-looking comment survived AS source, and the pipeline
    // injected no placeholder of its own.
    expect(countOf(doc, "<!--omp-ui-highlight-0-->")).toBe(1);
    expect(countOf(doc, "omp-ui-highlight-0")).toBe(1);
    // The second block appears exactly once with its decoded dollar-ampersand
    // still entity-encoded, and no unescaped `$&` expansion anywhere.
    expect(countOf(doc, "a$&amp;b")).toBe(1);
    expect(countOf(doc, "language-json")).toBe(1);
    expect(doc).not.toContain("a$&b");
    expect(errors(diagnostics)).toEqual([]);
    // And the composed document carries the guardrail + CSP once each.
    expect(doc.match(GUARDRAIL_RE)).toHaveLength(1);
    expect(countOf(doc, CSP_META)).toBe(1);
  });

  it("keeps dollar sequences literal when the block is highlighted", async () => {
    // Same fixture with a tokenizer that accepts both blocks: the generated
    // span text carries the dollar bytes, and the composer inserts it verbatim.
    seams.tokenize = async (source) => {
      const half = Math.floor(source.length / 2);
      return [
        [
          { content: source.slice(0, half), color: "#123456", offset: 0 },
          { content: source.slice(half), color: "#654321", offset: half },
        ],
      ];
    };
    const { doc, diagnostics } = await preparePlanDocument(FIXTURE, resolveTheme(DEFAULT_THEME_ID));

    expect(errors(diagnostics)).toEqual([]);
    // The spans split the source mid-token; only the joined text can carry a
    // literal, so the count is taken with the markup removed.
    const text = visibleText(doc);
    expect(countOf(text, `awk '/total:$/' report.csv`)).toBe(1);
    expect(countOf(text, "a$&amp;b")).toBe(1);
    expect(doc).not.toContain("a$&b");
    expect(countOf(doc, "omp-ui-highlight-0")).toBe(1);
    expect(countOf(doc, "<h1>Release steps</h1>")).toBe(1);
    expect(doc.match(GUARDRAIL_RE)).toHaveLength(1);
    expect(countOf(doc, CSP_META)).toBe(1);
  });
});
