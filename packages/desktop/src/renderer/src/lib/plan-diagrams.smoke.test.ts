// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMermaid, renderMermaidBlocks } from "./plan-diagrams";

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

describe("renderMermaid (real mermaid)", () => {
  it("renders a trivial flowchart to SVG through the dynamic-import path", async () => {
    const out = await renderMermaidBlocks(
      `<p>plan</p><pre class="mermaid">flowchart TD; A-->B</pre>`,
      renderMermaid,
    );

    expect(out).toContain("<svg");
    expect(out).toContain("viewBox");
    expect(out).toContain('class="omp-ui-diagram"');
    // Labels must be SVG <text>, never foreignObject HTML — FO labels clip
    // at column-scaled widths (issue #303).
    expect(out).not.toContain("<foreignObject");
    expect(out).not.toContain('<pre class="mermaid">');
  });
});
