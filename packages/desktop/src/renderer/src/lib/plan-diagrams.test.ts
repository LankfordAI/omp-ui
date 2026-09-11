// @vitest-environment jsdom
// jsdom for the module graph only: the canvas gate imports ./themes, whose
// chain reads window at boot. No DOM behaviour is exercised here.
import { describe, expect, it } from "vitest";
import {
  DiagramSyntaxError,
  fitDarkPaint,
  planDiagramTransform,
  type DiagramRenderer,
  type PlanCanvas,
} from "./plan-diagrams";
import { composePlanSource, parsePlanSource } from "./plan-source";
import { mixHex, THEMES } from "./themes";

const stubSvg = (id: string) => `<svg data-diagram="${id}" viewBox="0 0 10 10"></svg>`;

// Test seam: records the (id, source, dark) triples it is handed and throws the
// given error for a listed source, so a parse failure and an engine failure are
// distinguishable without the real mermaid (covered by the smoke test).
function stubRenderer(failFor: Record<string, Error> = {}) {
  const seen: unknown[][] = [];
  const render: DiagramRenderer = async (id, source, dark) => {
    seen.push([id, source, dark]);
    const fail = failFor[source];
    if (fail) throw fail;
    return stubSvg(id);
  };
  return { render, seen };
}

/** Parse authored HTML, substitute its diagrams, compose the document. */
async function transform(html: string, render: DiagramRenderer, canvas?: PlanCanvas) {
  const parsed = parsePlanSource(html);
  const out = await planDiagramTransform(parsed, render, canvas);
  return { parsed, out, doc: composePlanSource(html, out.replacements) };
}

describe("parsePlanSource diagram classification", () => {
  it("reads a pre.mermaid body as diagram source, decoded once", () => {
    const parsed = parsePlanSource(
      '<p>before</p><pre class="mermaid">flowchart TD; A["a &lt;b&gt; &amp; c"]--&gt;B</pre><p>after</p>',
    );
    expect(parsed.diagramBlocks).toHaveLength(1);
    expect(parsed.diagramBlocks[0]!.sourceText).toBe('flowchart TD; A["a <b> & c"]-->B');
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  });

  it("matches mermaid as a class token, tolerating extra classes and casing", () => {
    const parsed = parsePlanSource(
      '<PRE CLASS="wide mermaid">graph TD; A-->B</PRE><pre class="mermaid-x">graph TD; C-->D</pre>',
    );
    expect(parsed.diagramBlocks).toHaveLength(1);
    expect(parsed.diagramBlocks[0]!.sourceText).toBe("graph TD; A-->B");
  });

  it("classifies a diagram before any language class", () => {
    // The same pre carries both conventions; mermaid wins, and the block is
    // not handed to the highlighter.
    const parsed = parsePlanSource('<pre class="mermaid language-bash">flowchart TD; A-->B</pre>');
    expect(parsed.diagramBlocks.map((b) => b.sourceText)).toEqual(["flowchart TD; A-->B"]);
    expect(parsed.codeBlocks).toEqual([]);
  });

  it("leaves documents without a real mermaid pre block-free", () => {
    const cases = [
      '<pre class="not-mermaid">x</pre><pre>graph TD; A-->B</pre>',
      // Markup inside the block is escaped source, not diagram nodes.
      '<pre class="mermaid"><b>bold</b></pre>',
      // Not a `pre`, so not a diagram.
      '<div class="mermaid">graph TD; A-->B</div>',
      // Inert content never defines a block.
      '<template><pre class="mermaid">graph TD; A-->B</pre></template><p>text</p>',
      // Foreign subtrees are scanned past.
      '<svg><foreignObject><pre class="mermaid">graph TD; A-->B</pre></foreignObject></svg><p>text</p>',
      // A comment is a comment.
      '<!--<pre class="mermaid">graph TD; A-->B</pre>--><p>text</p>',
    ];
    for (const html of cases) {
      const parsed = parsePlanSource(html);
      expect(parsed.diagramBlocks, html).toEqual([]);
      expect(parsed.codeBlocks, html).toEqual([]);
    }
  });

  it("reports markup inside a mermaid block as a source finding", () => {
    const parsed = parsePlanSource('<pre class="mermaid">graph<TD>x</TD></pre>');
    expect(parsed.diagramBlocks).toEqual([]);
    expect(
      parsed.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => [d.code, d.repair, d.detail]),
    ).toEqual([["CODE_MARKUP", "source", '<td> inside the block']]);
  });
});

describe("planDiagramTransform", () => {
  it("splices the rendered SVG over the pre and keeps every other byte", async () => {
    const { render, seen } = stubRenderer();
    const html = '<p>before</p><pre class="mermaid">flowchart TD; A-->B</pre><p>tail $&</p>';
    const { doc } = await transform(html, render);

    expect(seen).toEqual([["omp-ui-diagram-0", "flowchart TD; A-->B", false]]);
    expect(doc).toBe(
      `<p>before</p><div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-0")}</div><p>tail $&</p>`,
    );
  });

  it("renders every block with an id unique to its index", async () => {
    const { render, seen } = stubRenderer();
    const html = '<pre class="mermaid">graph TD; A-->B</pre><p>mid</p><pre class="mermaid">graph TD; C-->D</pre>';
    const { doc } = await transform(html, render);

    expect(seen.map(([id]) => id)).toEqual(["omp-ui-diagram-0", "omp-ui-diagram-1"]);
    expect(doc).toBe(
      `<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-0")}</div><p>mid</p>` +
        `<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-1")}</div>`,
    );
  });

  it("returns a diagram-free document as no splices at all", async () => {
    const { render, seen } = stubRenderer();
    const { doc, out } = await transform("<p>no diagrams here</p>", render);

    expect(seen).toEqual([]);
    expect(out.replacements).toEqual([]);
    expect(doc).toBe("<p>no diagrams here</p>");
  });

  it("reports a parse failure as a source diagnostic beside its callout", async () => {
    const broken = "not a diagram <&>";
    const { render, seen } = stubRenderer({
      [broken]: new DiagramSyntaxError("Parse error on line 2", 2),
    });
    const html = `<p>intro</p><pre class="mermaid">not a diagram &lt;&amp;&gt;</pre><pre class="mermaid">graph TD; A-->B</pre>`;
    const { doc, out } = await transform(html, render);

    expect(out.diagnostics).toHaveLength(1);
    const [diagnostic] = out.diagnostics;
    expect(diagnostic).toMatchObject({
      code: "MERMAID_SYNTAX",
      stage: "diagram",
      repair: "source",
      severity: "error",
      blockIndex: 0,
      excerpt: broken,
      detail: "Parse error on line 2 (diagram line 2)",
    });
    // The location is the authored pre, in offsets and in line/column.
    expect(diagnostic!.location!.startOffset).toBe(html.indexOf('<pre class="mermaid">'));
    expect(diagnostic!.location!.endOffset).toBe(html.indexOf("</pre>") + "</pre>".length);
    expect(diagnostic!.location!.line).toBe(1);

    // The document still shows the block, escaped rather than re-parsed, and
    // the sibling still rendered.
    expect(seen).toHaveLength(2);
    expect(doc).toContain(
      `<strong>diagram failed to render</strong><pre>not a diagram &lt;&amp;&gt;</pre>`,
    );
    expect(doc).toContain(`<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-1")}</div>`);
    expect(doc).toContain("<p>intro</p>");
  });

  it("reports an engine failure as an application diagnostic", async () => {
    const { render } = stubRenderer({ nope: new Error("engine exploded") });
    const { doc, out } = await transform('<pre class="mermaid">nope</pre>', render);

    expect(out.diagnostics.map((d) => [d.code, d.repair, d.severity])).toEqual([
      ["RENDER_INVARIANT", "application", "error"],
    ]);
    expect(out.diagnostics[0]!.detail).toBe("engine exploded");
    // A failure the agent cannot fix still leaves the source readable.
    expect(doc).toContain('<div class="omp-ui-diagram-error"');
    expect(doc).toContain("<pre>nope</pre>");
  });

  it("paints the error callout for the canvas it lands on", async () => {
    const { render } = stubRenderer({ nope: new DiagramSyntaxError("Parse error") });
    const light = await transform('<pre class="mermaid">nope</pre>', render);
    expect(light.doc).toContain("border:1px solid #b45309;background:#fdf6ec;color:#7c2d12");

    const dark = await transform('<pre class="mermaid">nope</pre>', render, {
      dark: true,
      surface: "#14171b",
      ink: "#e8ecf1",
    });
    expect(dark.doc).toContain("border:1px solid #c9963f;background:#2a1e12;color:#f0c9a0");
    expect(dark.doc).not.toContain("#fdf6ec");
  });

  it("hands the renderer the canvas it lands on, fitting authored paint only when dark", async () => {
    // Issue #384: the plan path forwards the canvas, so mermaid sees the
    // darkness the diagram actually renders under and a pale authored fill
    // arrives already re-fitted instead of as written.
    const { render, seen } = stubRenderer();
    const source = "flowchart TD\nA-->B\nclassDef hot fill:#fef3c7";

    await transform(`<pre class="mermaid">${source}</pre>`, render);
    expect(seen).toEqual([["omp-ui-diagram-0", source, false]]);

    seen.length = 0;
    const dark = await planDiagramTransform(
      parsePlanSource(`<pre class="mermaid">${source}</pre>`),
      render,
      { dark: true, surface: "#14171b", ink: "#e8ecf1" },
    );
    expect(seen).toHaveLength(1);
    expect(seen[0]![0]).toBe("omp-ui-diagram-0");
    expect(seen[0]![2]).toBe(true);
    // 0.35 toward the graphite canvas is the first rung clearing AA.
    expect(seen[0]![1]).toBe("flowchart TD\nA-->B\nclassDef hot fill:#666457");
    expect(dark.diagnostics).toEqual([]);
  });
});

// WCAG luminance/contrast mirrored from themes.test.ts: the fit's gate must
// not depend on a copy that can go stale.
function luminance(hex: string): number {
  const h = hex.replace("#", "").slice(0, 6);
  const channel = (offset: number): number => {
    const c = Number.parseInt(h.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

function contrast(a: string, b: string): number {
  const [la, lb] = [luminance(a), luminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

describe("fitDarkPaint", () => {
  // Graphite's canvas and ink, the default theme's dark pairing.
  const surface = "#14171b";
  const ink = "#e8ecf1";

  it("darkens a pale fill toward the canvas on the first ladder rung", () => {
    // #fef3c7 against graphite ink is ~1.1:1; at 0.35 toward the canvas it
    // reaches 5.02 and stops there.
    expect(fitDarkPaint("classDef a fill:#fef3c7", surface, ink)).toBe(
      `classDef a fill:${mixHex("#fef3c7", surface, 0.35)}`,
    );
  });

  it("passes an already-dark fill through untouched", () => {
    // 10.66:1 against the ink: nothing to fix, and the passthrough is what
    // makes the fit idempotent.
    expect(fitDarkPaint("classDef a fill:#3a3223", surface, ink)).toBe(
      "classDef a fill:#3a3223",
    );
  });

  it("lifts a dark stroke toward the ink until it clears the canvas", () => {
    const out = fitDarkPaint("style A stroke:#101418", surface, ink);
    const hex = out.match(/stroke:(#[0-9a-f]{6})/)![1]!;
    expect(hex).not.toBe("#101418");
    expect(contrast(hex, surface)).toBeGreaterThanOrEqual(3);
  });

  it("leaves a fill hex inside a quoted node label untouched", () => {
    const source = 'flowchart TD\nA["fill:#fef3c7"]-->B';
    expect(fitDarkPaint(source, surface, ink)).toBe(source);
  });

  it("expands a 3-digit hex before mixing", () => {
    // #fff fails AA against the light ink on a dark canvas; mixHex would
    // throw on the 3-digit form, so the fit expands it first.
    expect(fitDarkPaint("classDef a fill:#fff", surface, ink)).toBe(
      `classDef a fill:${mixHex("#ffffff", surface, 0.35)}`,
    );
  });

  it("leaves init directives alone", () => {
    const line = '%%{init: {"themeVariables": {"primaryColor": "#fef3c7"}}}%%';
    expect(fitDarkPaint(line, surface, ink)).toBe(line);
  });

  it("is idempotent", () => {
    const source =
      "flowchart TD\nA-->B\nclassDef a fill:#fef3c7,stroke:#333333\nclassDef b fill:#fff";
    const once = fitDarkPaint(source, surface, ink);
    expect(fitDarkPaint(once, surface, ink)).toBe(once);
  });

  it("keeps every fitted fill AA-readable against the ink of every shipped theme", () => {
    const fills = [
      "#f1f5f9", "#e2e8f0", // slate-100/200
      "#e0f2fe", "#bae6fd", // sky-100/200
      "#fef3c7", "#fde68a", // amber-100/200
      "#fff1f2", "#ffe4e6", // rose-100/200
      "#d1fae5", "#a7f3d0", // emerald-100/200
      "#f5f3ff", "#ede9fe", // violet-100/200
    ];
    const source = fills.map((hex, i) => `classDef c${i} fill:${hex}`).join("\n");
    for (const theme of THEMES) {
      const out = fitDarkPaint(
        source,
        theme.tokens["--color-surface"],
        theme.tokens["--color-ink"],
      );
      const got = [...out.matchAll(/fill:(#[0-9a-f]{6})/g)].map((m) => m[1]!);
      expect(got).toHaveLength(fills.length);
      for (const hex of got) {
        expect(`${theme.id} ${hex} vs ${theme.tokens["--color-ink"]}`).toSatisfy(
          () => contrast(theme.tokens["--color-ink"], hex) >= 4.5,
        );
      }
    }
  });
});
