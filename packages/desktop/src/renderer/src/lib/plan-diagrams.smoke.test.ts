// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { composePlanSource, parsePlanSource } from "./plan-source";
import { planDiagramTransform, renderMermaid, type PlanCanvas } from "./plan-diagrams";

// jsdom implements no SVG text measurement, which mermaid's layout relies on.
// Stub getBBox and getComputedTextLength with fixed sizes so the render
// pipeline completes; the authoritative visual check is the browser smoke test
// (issue #285). getComputedTextLength is only reached since htmlLabels:false
// (issue #303) made labels pure SVG text — Chromium has both natively.
// TS's DOM lib declares these on SVGGraphicsElement/SVGTextContentElement,
// not SVGElement; jsdom omits them entirely, so patch through a cast.
const svgProto = SVGElement.prototype as unknown as {
  getBBox?: () => DOMRect;
  getComputedTextLength?: () => number;
};
svgProto.getBBox ??= () =>
  ({
    x: 0,
    y: 0,
    width: 40,
    height: 20,
    top: 0,
    right: 40,
    bottom: 20,
    left: 0,
    toJSON: () => ({}),
  }) as DOMRect;
svgProto.getComputedTextLength ??= () => 40;

// Real mermaid through the range pipeline: the classifier and the composer are
// pinned with a stub renderer in plan-diagrams.test.ts; this is the engine
// check, so the assertion is that a rendered (or failed) diagram lands on the
// authored block's own range and nothing else moves.
const GRAPHITE: PlanCanvas = { dark: true, surface: "#14171b", ink: "#e8ecf1" };

async function draw(html: string, canvas?: PlanCanvas) {
  const parsed = parsePlanSource(html);
  const out = await planDiagramTransform(parsed, renderMermaid, canvas);
  return { parsed, out, doc: composePlanSource(html, out.replacements) };
}

describe("planDiagramTransform (real mermaid)", () => {
  // The real mermaid graph transforms and evaluates per worker with no
  // cross-worker module cache: ~440 ms idle, but measured at 9.5 s under
  // full-suite contention, which exceeded vitest's 5 s default (issue #329).
  // These cases pay that cost, so the budget lives here rather than in a
  // global testTimeout.
  it("splices a rendered flowchart over the authored pre", async () => {
    const html = '<p>plan</p><pre class="mermaid">flowchart TD; A-->B</pre><p>tail</p>';
    const { parsed, out, doc } = await draw(html);

    expect(parsed.diagramBlocks).toHaveLength(1);
    expect(out.diagnostics).toEqual([]);
    expect(out.replacements).toHaveLength(1);
    expect(doc).toContain("<svg");
    expect(doc).toContain("viewBox");
    expect(doc).toContain('class="omp-ui-diagram"');
    // Labels must be SVG <text>, never foreignObject HTML — FO labels clip
    // at column-scaled widths (issue #303).
    expect(doc).not.toContain("<foreignObject");
    expect(doc).toContain("<text");
    expect(doc).not.toContain('<pre class="mermaid">');
    // Everything outside the one replacement range is byte-identical.
    expect(doc.startsWith("<p>plan</p>")).toBe(true);
    expect(doc.endsWith("<p>tail</p>")).toBe(true);
  }, 30_000);

  it("fits an authored classDef fill for a dark canvas before rendering", async () => {
    // Issue #384: on a graphite canvas a pale authored fill must not survive
    // into the rendered SVG — mermaid receives the fitted hex, so the node
    // arrives dark under canvas-ink labels.
    const source = "flowchart TD\nA-->B\nclassDef hot fill:#fef3c7\nclass A hot";
    const { doc } = await draw(`<p>plan</p><pre class="mermaid">${source}</pre>`, GRAPHITE);

    expect(doc).toContain("<svg");
    expect(doc).toContain('class="omp-ui-diagram"');
    expect(doc).not.toContain("#fef3c7");
  }, 30_000);

  it("reports a broken diagram as a source finding with an inline callout", async () => {
    const html =
      '<p>before</p><pre class="mermaid">flowchart TD; A --&gt; &gt;B</pre><p>after</p>';
    const { out, doc } = await draw(html);

    const [diag] = out.diagnostics;
    expect(
      out.diagnostics.map((d) => [d.code, d.stage, d.repair, d.severity, d.blockIndex]),
    ).toEqual([["MERMAID_SYNTAX", "diagram", "source", "error", 0]]);
    expect(diag?.location).toBeDefined();
    expect(diag?.excerpt).toContain("flowchart TD");
    // The block is REPLACED by a visible callout carrying its own source —
    // never the silent plain-source fallback a reader could mistake for a
    // diagram, and never the authored pre left in place.
    expect(doc).toContain('class="omp-ui-diagram-error"');
    expect(doc).toContain("diagram failed to render");
    expect(doc).toContain("<pre>flowchart TD; A --&gt; &gt;B</pre>");
    expect(doc).not.toContain('<pre class="mermaid">');
    expect(doc).toContain("<p>before</p>");
    expect(doc).toContain("<p>after</p>");
  }, 30_000);
});
