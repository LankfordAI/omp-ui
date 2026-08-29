import { describe, expect, it } from "vitest";
import { extractMermaidBlocks, renderMermaidBlocks, type DiagramRenderer } from "./plan-diagrams";

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

  it("leaves the optional dark argument undefined for plan blocks, so the default renderer keeps the light palette", async () => {
    // Issue #361 widened DiagramRenderer with `dark?`; the plan path must not
    // start passing it (plans stay on the fixed light canvas palette, #285).
    const args: unknown[][] = [];
    const render: DiagramRenderer = (...a: unknown[]) => {
      args.push(a);
      return Promise.resolve(stubSvg(a[0] as string));
    };
    const html = `<pre class="mermaid">graph TD; A-->B</pre>`;
    const out = await renderMermaidBlocks(html, render);

    expect(args).toEqual([["omp-ui-diagram-0", "graph TD; A-->B"]]);
    expect(out).toBe(`<div class="omp-ui-diagram">${stubSvg("omp-ui-diagram-0")}</div>`);
  });
});
