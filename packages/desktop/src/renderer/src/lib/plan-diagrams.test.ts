// @vitest-environment jsdom
// jsdom for the module graph only: the canvas gate imports ./themes, whose
// chain reads window at boot. No DOM behaviour is exercised here.
import { describe, expect, it } from "vitest";
import { extractMermaidBlocks, fitDarkPaint, renderMermaidBlocks, type DiagramRenderer } from "./plan-diagrams";
import { mixHex, THEMES } from "./themes";

const stubSvg = (id: string) => `<svg data-diagram="${id}" viewBox="0 0 10 10"></svg>`;

// Test seam: records the (id, source) pairs it is handed, throws for sources
// listed in `failFor`, otherwise returns a fixed SVG carrying the id.
function stubRenderer(failFor: string[] = []) {
  const seen: string[] = [];
  const render: DiagramRenderer = async (id, source) => {
    seen.push(`${id}:${source}`);
    if (failFor.includes(source)) throw new Error("Parse error on line 1");
    return stubSvg(id);
  };
  return { render, seen };
}

describe("extractMermaidBlocks", () => {
  it("finds a block, substitutes a placeholder, and decodes entities in the source", () => {
    const html = `<p>before</p><pre class="mermaid">flowchart TD; A["a &lt;b&gt; &amp; c"]--&gt;B</pre><p>after</p>`;
    const { html: staged, blocks } = extractMermaidBlocks(html);

    expect(blocks).toEqual([
      {
        placeholder: "<!--omp-ui-diagram-0-->",
        source: `flowchart TD; A["a <b> & c"]-->B`,
      },
    ]);
    expect(staged).toBe(`<p>before</p><!--omp-ui-diagram-0--><p>after</p>`);
  });

  it("matches mermaid as a class token, tolerating extra classes and casing", () => {
    const html = `<PRE CLASS="wide mermaid">graph TD; A-->B</PRE><pre class="mermaid-x">graph TD; C-->D</pre>`;
    const { html: staged, blocks } = extractMermaidBlocks(html);

    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.source).toBe("graph TD; A-->B");
    expect(staged).toBe(`<!--omp-ui-diagram-0--><pre class="mermaid-x">graph TD; C-->D</pre>`);
  });

  it("leaves a document without mermaid blocks untouched", () => {
    const html = `<pre class="not-mermaid">x</pre><pre>graph TD; A-->B</pre>`;
    const { html: staged, blocks } = extractMermaidBlocks(html);

    expect(blocks).toEqual([]);
    expect(staged).toBe(html);
  });
});

describe("renderMermaidBlocks", () => {
  it("substitutes rendered SVG wrapped in the diagram container", async () => {
    const { render, seen } = stubRenderer();
    const html = `<p>before</p><pre class="mermaid">flowchart TD; A-->B</pre><p>after</p>`;
    const out = await renderMermaidBlocks(html, render);

    expect(seen).toEqual(["omp-ui-diagram-0:flowchart TD; A-->B"]);
    expect(out).toBe(
      `<p>before</p><div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-0")}</div><p>after</p>`,
    );
  });

  it("substitutes every block and hands each a unique id", async () => {
    const { render, seen } = stubRenderer();
    const html = `<pre class="mermaid">graph TD; A-->B</pre><pre class="mermaid">graph TD; C-->D</pre>`;
    const out = await renderMermaidBlocks(html, render);

    expect(seen).toEqual(["omp-ui-diagram-0:graph TD; A-->B", "omp-ui-diagram-1:graph TD; C-->D"]);
    expect(out).toBe(
      `<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-0")}</div>` +
        `<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-1")}</div>`,
    );
  });

  it("replaces a failing block with an error callout and keeps rendering the rest", async () => {
    const { render, seen } = stubRenderer(["not a diagram <&>"]);
    const html =
      `<p>intro</p><pre class="mermaid">not a diagram &lt;&amp;&gt;</pre>` +
      `<pre class="mermaid">graph TD; A-->B</pre><p>outro</p>`;
    const out = await renderMermaidBlocks(html, render);

    expect(seen).toEqual([
      "omp-ui-diagram-0:not a diagram <&>",
      "omp-ui-diagram-1:graph TD; A-->B",
    ]);
    expect(out).toContain('class="omp-ui-diagram-error"');
    expect(out).toContain("diagram failed to render");
    // Source in the callout is re-escaped for HTML, not double-decoded.
    expect(out).toContain("<pre>not a diagram &lt;&amp;&gt;</pre>");
    expect(out).toContain(`<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-1")}</div>`);
    expect(out).toContain("<p>intro</p>");
    expect(out).toContain("<p>outro</p>");
    expect(out).not.toContain("omp-ui-diagram-0-->");
    expect(out).not.toContain("omp-ui-diagram-1-->");
  });

  it("returns a block-free document byte-identically without calling the renderer", async () => {
    const { render, seen } = stubRenderer();
    const html = `<p>no diagrams here</p>`;

    expect(await renderMermaidBlocks(html, render)).toBe(html);
    expect(seen).toEqual([]);
  });

  it("substitutes an SVG whose viewBox survives for the width carve-out", async () => {
    const { render } = stubRenderer();
    const out = await renderMermaidBlocks(`<pre class="mermaid">graph TD; A-->B</pre>`, render);

    expect(out).toContain('viewBox="0 0 10 10"');
    expect(out).not.toContain("max-width");
  });

  it("forwards canvas darkness to the renderer and fits authored paint on a dark canvas", async () => {
    // Issue #384 flipped the old contract: the plan path hands the renderer
    // the canvas the diagram lands on. Without a canvas spec the renderer
    // sees the light default and untouched source; with a dark one, authored
    // classDef hexes arrive already fitted to the canvas.
    const args: unknown[][] = [];
    const render: DiagramRenderer = (...a: unknown[]) => {
      args.push(a);
      return Promise.resolve(stubSvg(a[0] as string));
    };

    const plain = await renderMermaidBlocks(`<pre class="mermaid">graph TD; A-->B</pre>`, render);
    expect(args).toEqual([["omp-ui-diagram-0", "graph TD; A-->B", false]]);
    expect(plain).toBe(`<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-0")}</div>`);

    args.length = 0;
    const source = "flowchart TD\nA-->B\nclassDef hot fill:#fef3c7";
    await renderMermaidBlocks(`<pre class="mermaid">${source}</pre>`, render, {
      dark: true,
      surface: "#14171b",
      ink: "#e8ecf1",
    });
    expect(args).toHaveLength(1);
    expect(args[0]![0]).toBe("omp-ui-diagram-0");
    expect(args[0]![2]).toBe(true);
    // Graphite's canvas: the pale fill reaches mermaid darkened, not as
    // authored — 0.35 toward #14171b clears the ink at AA.
    expect(args[0]![1]).toBe("flowchart TD\nA-->B\nclassDef hot fill:#666457");
  });

  it("renders the error callout in the dark canvas palette", async () => {
    const render: DiagramRenderer = async () => {
      throw new Error("Parse error on line 1");
    };
    const out = await renderMermaidBlocks(`<pre class="mermaid">nope</pre>`, render, {
      dark: true,
      surface: "#14171b",
      ink: "#e8ecf1",
    });

    expect(out).toContain("border:1px solid #c9963f;background:#2a1e12;color:#f0c9a0");
    expect(out).not.toContain("#fdf6ec");
    expect(out).toContain("<pre>nope</pre>");
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
