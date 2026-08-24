import { describe, expect, it, vi } from "vitest";
import { preparePlanDocument } from "./plan-document";

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
  max-width: 100% !important;
  max-height: 28rem !important;
  width: auto !important;
  height: auto !important;
  display: block;
}`);
    // Tall diagrams shrink to the height cap instead of stretching to column
    // width and ballooning (issue #288).
    expect(css).toContain(`.omp-ui-diagram {
  display: flex;
  justify-content: center;
}`);
  });
});
