// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { renderMermaid, renderMermaidBlocks } from "./plan-diagrams";

// jsdom implements no SVG text measurement, which mermaid's layout relies on.
// Stub getBBox with a fixed-size box so the render pipeline completes; the
// authoritative visual check is the browser smoke test (issue #285).
// TS's DOM lib declares getBBox on SVGGraphicsElement, not SVGElement; jsdom
// omits it entirely, so patch the prototype through a cast.
const svgProto = SVGElement.prototype as unknown as { getBBox?: () => DOMRect };
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

describe("renderMermaid (real mermaid)", () => {
  it("renders a trivial flowchart to SVG through the dynamic-import path", async () => {
    const out = await renderMermaidBlocks(
      `<p>plan</p><pre class="mermaid">flowchart TD; A-->B</pre>`,
      renderMermaid,
    );

    expect(out).toContain("<svg");
    expect(out).toContain("viewBox");
    expect(out).toContain('class="omp-ui-diagram"');
    expect(out).not.toContain('<pre class="mermaid">');
  });
});
