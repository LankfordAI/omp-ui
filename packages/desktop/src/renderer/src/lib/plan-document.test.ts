// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { preparePlanDocument } from "./plan-document";
import { currentThemeId, DEFAULT_THEME_ID, resolveTheme } from "./themes";
import type { CodeTokenizer } from "./plan-highlight";
import type { Theme } from "./themes";

vi.mock("./plan-diagrams", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-diagrams")>();
  return {
    ...original,
    // Stub the network-weight renderer: unit tests exercise the substitution
    // contract, not mermaid's layout engine (covered by the smoke test).
    renderMermaidBlocks: (html: string, render?: (id: string, source: string) => Promise<string>) =>
      original.renderMermaidBlocks(html, render ?? (async (id) => `<svg data-diagram="${id}"></svg>`)),
  };
});

// The stub tokenizer stands in for shiki: default `null` leaves every block
// plain (no token CSS), so the byte-identity cases pin the unhighlighted
// contract; a non-null result drives the token-CSS-landing cases.
const highlightMock = vi.hoisted(() => ({
  themes: [] as string[],
  tokenize: null as CodeTokenizer | null,
}));

vi.mock("./plan-highlight", async (importOriginal) => {
  const original = await importOriginal<typeof import("./plan-highlight")>();
  return {
    ...original,
    highlightCodeBlocks: (html: string, theme: Theme) => {
      highlightMock.themes.push(theme.id);
      return original.highlightCodeBlocks(html, theme, highlightMock.tokenize ?? (async () => null));
    },
  };
});

const MARKER = 'id="omp-ui-plan-guardrails"';

function guardrailCss(html: string): string {
  const match = html.match(/<style id="omp-ui-plan-guardrails">([\s\S]*?)<\/style>/);
  if (!match?.[1]) throw new Error("guardrail stylesheet was not injected");
  return match[1];
}

describe("preparePlanDocument injection", () => {
  it("puts the final stylesheet inside an existing head without moving the doctype or markup", async () => {
    const source =
      '<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><style>.plan{color:red}</style></head><body><h1>Plan</h1></body></html>';
    const prepared = await preparePlanDocument(source);

    expect(prepared.startsWith('<!doctype html>\n<html lang="en"><head>')).toBe(true);
    expect(prepared).toContain(`<style>.plan{color:red}</style><style ${MARKER}>`);
    expect(prepared.indexOf(MARKER)).toBeLessThan(prepared.indexOf("</head>"));
    expect(prepared.endsWith("<body><h1>Plan</h1></body></html>")).toBe(true);
    expect(prepared.replace(/<style id="omp-ui-plan-guardrails">[\s\S]*?<\/style>/, "")).toBe(
      source,
    );
  });

  it("inserts a complete head immediately after an html opening when no head closes", async () => {
    const source = '<!DOCTYPE html><html data-plan="alpha"><body>Plan</body></html>';
    const prepared = await preparePlanDocument(source);

    expect(prepared).toMatch(
      /^<!DOCTYPE html><html data-plan="alpha"><head><style id="omp-ui-plan-guardrails">/,
    );
    expect(prepared).toContain("</style></head><body>Plan</body></html>");
  });

  it("prefixes a fragment and otherwise preserves it byte-for-byte", async () => {
    const fragment = "<article>\n  <h1>Plan</h1>\n  <p>Keep me exact.</p>\n</article>";
    const prepared = await preparePlanDocument(fragment);

    expect(prepared.startsWith(`<style ${MARKER}>`)).toBe(true);
    expect(prepared.endsWith(fragment)).toBe(true);
  });

  it("matches opening html and the first closing head case-insensitively", async () => {
    const source = "<!DoCtYpE html><HTML><HeAd><title>Plan</title></hEaD><body>x</body></HTML>";
    const prepared = await preparePlanDocument(source);

    expect(prepared).toContain(`<title>Plan</title><style ${MARKER}>`);
    expect(prepared).toContain("</style></hEaD><body>x</body>");
    expect(prepared.match(/<head>/gi)).toHaveLength(1);
  });

  it("returns an already prepared document byte-identically", async () => {
    const once = await preparePlanDocument("<html><head></head><body>Plan</body></html>");
    expect(await preparePlanDocument(once)).toBe(once);
  });

  it("recognizes the stable marker with alternate quoting and casing", async () => {
    const marked = "<article ID='omp-ui-plan-guardrails'>leave unchanged</article>";
    expect(await preparePlanDocument(marked)).toBe(marked);
  });
});

describe("preparePlanDocument guardrails", () => {
  it("forces a light white canvas and inherited dark ink over hostile plan colors", async () => {
    const source =
      "<html><head><style>:root,body,p{color:#fff;background:transparent}</style></head>" +
      '<body style="color: white; background: transparent"><p>Readable</p></body></html>';
    const prepared = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    expect(prepared.indexOf("color:#fff")).toBeLessThan(prepared.indexOf(MARKER));
    expect(css).toContain(`:root,
body {
  color-scheme: light !important;
  color: #111 !important;
  background-color: #fff !important;
  background-image: none !important;
  width: 100% !important;
  max-width: 100% !important;
  min-inline-size: 0 !important;
  overflow-x: clip !important;
}`);
    expect(css).toContain(`html :where(*:not(svg, svg *)) {
  max-width: 100% !important;
  min-width: 0 !important;
  color: inherit !important;
  background-color: transparent !important;
  background-image: none !important;
}`);
  });

  it("paints pre and code on the active theme's sunken plane, after the universal rule", async () => {
    const source =
      "<html><head><style>pre{background:#f1f5f9;color:#000}code{background:#e8edf3}</style></head>" +
      "<body><p>inline <code>chip</code></p><pre><code>x = 1</code></pre></body></html>";
    const prepared = await preparePlanDocument(source, resolveTheme("graphite"));
    const css = guardrailCss(prepared);

    expect(css).toContain(`background-color: #0e1013 !important;`);
    expect(css).toContain(`color: #e8ecf1 !important;`);
    expect(css).toContain(`color-scheme: dark !important;`);
    expect(css).toContain(`white-space: pre-wrap !important;`);
    // Same specificity and !important tier as the universal rule: the plane
    // holds only because it sits later in the sheet.
    expect(prepared.indexOf("background-color: #0e1013 !important")).toBeGreaterThan(
      prepared.indexOf("background-color: transparent !important"),
    );
  });

  it("follows light themes with a light code plane", async () => {
    const source = "<html><head></head><body><pre><code>x</code></pre></body></html>";
    const css = guardrailCss(await preparePlanDocument(source, resolveTheme("light")));

    expect(css).toContain(`background-color: #f1f4f7 !important;`);
    expect(css).toContain(`color: #12161b !important;`);
    expect(css).toContain(`color-scheme: light !important;`);
  });

  it("contains fixed content-box layouts without erasing authored padding or borders", async () => {
    const source =
      '<div style="box-sizing:content-box;width:1200px;padding:80px;border:12px solid red">Wide</div>';
    const prepared = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    expect(prepared.endsWith(source)).toBe(true);
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
    const css = guardrailCss(await preparePlanDocument(source));

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
  /* Code plane (issue #319): the canvas stays light, but code sits on the
     active theme's sunken plane — the transcript's code plane — so the
     theme's token palette has the surface it was derived against. */
  background-color: #0e1013 !important;
  color: #e8ecf1 !important;
  color-scheme: dark !important;
}`);
    expect(css).toContain(`a,
a:link,
a:visited,
a:hover,
a:active {
  color: #0645ad !important;
  text-decoration: underline !important;
}`);
  });

  it("forces wide tables to fill and stay within the available width", async () => {
    const source =
      '<table style="width:1600px;table-layout:auto"><tr><td>unbroken-cell-content</td></tr></table>';
    const css = guardrailCss(await preparePlanDocument(source));

    expect(css).toContain(`table {
  width: 100% !important;
  max-width: 100% !important;
  table-layout: fixed !important;
  overflow-wrap: anywhere !important;
  word-break: break-word !important;
}`);
  });

  it("constrains oversized media and changes only SVG text paint", async () => {
    const source =
      '<img width="2400" height="1200"><svg width="2400" height="800"><circle cx="30" cy="30" r="20" fill="red"/><text x="0" y="20" fill="white">Plan</text></svg>';
    const prepared = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    expect(prepared.endsWith(source)).toBe(true);
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
  fill: #111 !important;
}`);
    expect(css).not.toMatch(/svg\s+(?:circle|ellipse|line|path|polygon|polyline|rect)\s*{/);
  });
});
describe("preparePlanDocument diagram substitution", () => {
  it("renders a mermaid block to SVG before injecting guardrails", async () => {
    const source =
      '<html><head><title>Plan</title></head><body><pre class="mermaid">flowchart TD; A-->B</pre></body></html>';
    const prepared = await preparePlanDocument(source);

    expect(prepared).toContain('<div class="omp-ui-diagram"><svg data-diagram="omp-ui-diagram-0"></svg></div>');
    expect(prepared).not.toContain('<pre class="mermaid">');
    expect(prepared).toContain(MARKER);
    // Diagram substitution happens before guardrail injection, so the
    // rendered SVG is contained by the injected stylesheet like everything else.
    expect(prepared.indexOf("omp-ui-diagram")).toBeGreaterThan(prepared.indexOf(MARKER));
  });

  it("ships the containment carve-out for rendered diagrams", async () => {
    const css = guardrailCss(await preparePlanDocument("<p>plan</p>"));

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
  afterEach(() => {
    highlightMock.themes.length = 0;
    highlightMock.tokenize = null;
  });

  it("passes the explicit theme through and defaults to the applied theme", async () => {
    const source = "<p>plan</p>";
    highlightMock.themes.length = 0;
    const explicit = { ...resolveTheme(DEFAULT_THEME_ID), id: "explicit" };
    await preparePlanDocument(source, explicit);
    await preparePlanDocument(source);

    expect(highlightMock.themes).toEqual([
      "explicit",
      resolveTheme(currentThemeId()).id,
    ]);
  });

  it("lands non-empty token CSS inside the guardrail stylesheet with the marker still last", async () => {
    highlightMock.tokenize = async () => [
      [{ content: "x", color: "#123456", offset: 0 }],
    ];
    const source =
      '<html><head><title>t</title></head><body><pre><code class="language-python">x</code></pre></body></html>';
    const prepared = await preparePlanDocument(source);
    const css = guardrailCss(prepared);

    expect(prepared).toContain('<pre class="omp-ui-hl">');
    expect(css).toContain(".omp-ui-hl .tk-0 { color: #123456 !important; }");
    // The token rules ride inside the guardrail stylesheet, which stays the
    // final stylesheet in the head.
    expect(prepared.indexOf(".omp-ui-hl .tk-0")).toBeGreaterThan(prepared.indexOf(MARKER));
    expect(prepared.indexOf(MARKER)).toBeLessThan(prepared.indexOf("</head>"));
  });
});
