// @vitest-environment jsdom
// The existing plan parser's highlighter/theme import graph reads window.
import { describe, expect, it } from "vitest";
import { planReviewText } from "./plan-review-text";

describe("planReviewText", () => {
  it("projects the authored body in order, including a supplied fragment body", () => {
    const body = `<h1>Purpose</h1><p>pre<em>flight</em> checks\n  are <strong>required</strong>.</p>
      <p>Second<br>line<br><br>after blank</p><ul><li>First</li><li>Second<ul><li>Nested</li></ul></li></ul>
      <h2>Verification</h2><p>Last</p>`;
    const expected = "# Purpose\npreflight checks are required.\nSecond\nline\n\nafter blank\n- First\n- Second\n- Nested\n## Verification\nLast";
    expect(planReviewText(body, "html")).toBe(expected);
    expect(planReviewText(`<!doctype html><html><head><title>Not body</title></head><body>${body}</body></html>`, "html"))
      .toBe(expected);
  });

  it("excludes inert, hidden, and non-body content without losing adjacent prose", () => {
    const text = planReviewText(`<!doctype html><html><head><title>HEAD_SECRET</title><style>STYLE_SECRET</style></head>
      <body><p>pre<!-- COMMENT_SECRET --><span hidden>HIDDEN_SECRET</span><em>flight</em></p>
      <script>SCRIPT_SECRET</script><style>STYLE_BODY_SECRET</style><template><p>TEMPLATE_SECRET</p></template>
      <noscript>NOSCRIPT_SECRET</noscript><section hidden="false"><p>HIDDEN_TREE_SECRET</p></section>
      <div aria-hidden="true"><p>ARIA_SECRET</p></div><div aria-hidden="TRUE">ARIA_CASE_SECRET</div>
      <p aria-hidden="false">Visible &amp; &lt;em&gt; &amp;lt;</p></body></html>`, "html");
    expect(text).toBe("preflight\nVisible & <em> &lt;");
    expect(text).not.toContain("SECRET");
  });

  it("preserves every pre/code block's decoded whitespace and labels unknown languages", () => {
    const code = "  if (a < b) {\n\treturn '&lt;';\n}\n  ";
    const html = `<p>Before</p><pre><code class="language-unknown">  if (a &lt; b) {\n\treturn '&amp;lt;';\n}\n  </code></pre>
      <pre> plain\n\tpre\n </pre><code>  inline\tcode  </code><p>After</p>`;
    const text = planReviewText(html, "html");
    expect(text).toContain(`[Code (unknown)]\n${code}\n[/Code]`);
    expect(text).toContain("[Code]\n plain\n\tpre\n \n[/Code]");
    expect(text).toContain("[Code]\n  inline\tcode  \n[/Code]");
    expect(text.indexOf("Before")).toBeLessThan(text.indexOf(code));
    expect(text.indexOf(code)).toBeLessThan(text.indexOf("After"));
  });

  it("classifies only an exact mermaid token on pre as diagram source", () => {
    const text = planReviewText(`<pre class="wide mermaid language-js">  graph TD;\n A--&gt;B\n </pre>
      <pre class="mermaid-x">ordinary pre</pre><pre class="MERMAID">case-sensitive class</pre>
      <div class="mermaid">ordinary prose</div><code class="mermaid">ordinary code</code>`, "html");
    expect(text).toContain("[Diagram source (Mermaid)]\n  graph TD;\n A-->B\n \n[/Diagram source]");
    expect(text.match(/\[Diagram source \(Mermaid\)\]/g)).toHaveLength(1);
    expect(text).toContain("[Code]\nordinary pre\n[/Code]");
    expect(text).toContain("[Code]\ncase-sensitive class\n[/Code]");
    expect(text).toContain("ordinary prose");
    expect(text).toContain("[Code]\nordinary code\n[/Code]");
  });

  it("retains tables' caption, headers, and authored rows without expanding spans", () => {
    const text = planReviewText(`<p>Before</p><table><caption>Authored <em>tradeoffs</em></caption>
      <thead><tr><th>Choice</th><th colspan="2">Reason</th></tr></thead>
      <tbody><tr><td rowspan="2">A</td><td>Faster <strong>path</strong></td><td></td></tr>
      <tr><td>B</td><td>Safer</td></tr><tr hidden><td>SECRET</td></tr></tbody>
      <tfoot><tr><td>Summary</td><td>Documented</td></tr></tfoot></table><p>After</p>`, "html");
    expect(text).toBe("Before\nAuthored tradeoffs\nChoice | Reason\nA | Faster path | \nB | Safer\nSummary | Documented\nAfter");
  });

  it("reads only authored SVG labels, once per parent and deduplicated per SVG", () => {
    const svg = `<svg viewBox="0 0 999 999"><title>Workflow</title><desc>Authored description</desc>
      <defs><text>DEFS_SECRET</text><title>DEFS_TITLE_SECRET</title></defs><metadata>METADATA_SECRET</metadata>
      <path d="M 0 0 L 99 99"/><rect x="42" y="43" width="100" height="200"/>
      <text x="123" y="456">pre<tspan>flight</tspan><tspan> check</tspan></text>
      <text>preflight check</text><text hidden>HIDDEN_SECRET</text><g aria-hidden="true"><text>ARIA_SECRET</text></g>
      <g>NOT_A_LABEL_SECRET<tspan>Standalone</tspan></g>
      <foreignObject><div xmlns="http://www.w3.org/1999/xhtml"><p>HTML <em>label</em></p><p>HTML label</p>
      <span hidden>FOREIGN_SECRET</span></div></foreignObject></svg>`;
    const text = planReviewText(`<p>Before</p>${svg}<p>Between</p>${svg}<p>After</p>`, "html");
    expect(text).toBe("Before\nWorkflow\nAuthored description\npreflight check\nStandalone\nHTML label\nBetween\nWorkflow\nAuthored description\npreflight check\nStandalone\nHTML label\nAfter");
    expect(text).not.toContain("SECRET");
    expect(text).not.toContain("123");
    expect(text).not.toContain("456");
  });

  it("preserves code whitespace in foreignObject labels and direct label text", () => {
    const text = planReviewText(`<svg><foreignObject>Direct label<div><pre><code>  x\n\ty\n </code></pre></div></foreignObject></svg>`, "html");
    expect(text).toBe("Direct label\n[Code]\n  x\n\ty\n \n[/Code]");
  });

  it("deduplicates visible foreignObject headings against other SVG labels", () => {
    expect(planReviewText('<svg><text>Same label</text><foreignObject><h3>Same label</h3><p>Other label</p></foreignObject></svg>', "html"))
      .toBe("Same label\nOther label");
  });

  it("reads MathML's authored presentation once and excludes alternate payloads", () => {
    const text = planReviewText(`<p>Formula <math><semantics><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow>
      <annotation encoding="application/x-tex">TEX_SECRET</annotation><annotation-xml encoding="application/xhtml+xml"><div>ALT_SECRET</div></annotation-xml>
      </semantics></math> follows.</p><math display="block"><mi>a</mi><mo>=</mo><mn>2</mn></math><p>End</p>`, "html");
    expect(text).toBe("Formula x+1 follows.\na=2\nEnd");
    expect(text).not.toContain("SECRET");
  });

  it("keeps ordered and nested list items in authored order", () => {
    const text = planReviewText('<ol start="3"><li>First<ul><li>Nested</li></ul></li><li value="8">Second</li></ol>', "html");
    expect(text).toBe("3. First\n- Nested\n8. Second");
  });

  it("keeps paragraph and code content attached to their list item boundary", () => {
    expect(planReviewText('<ul><li><p>First</p><p>Continuation</p></li><li><pre>  code</pre></li></ul>', "html"))
      .toBe("- First\nContinuation\n- [Code]\n  code\n[/Code]");
  });

  it("retains leading, consecutive, and trailing authored br boundaries", () => {
    expect(planReviewText("<br>A<br><br>B<br>", "html")).toBe("\nA\n\nB\n");
  });

  it("preserves Markdown renderer literals while recursing through formatting and link labels", () => {
    const text = planReviewText("# Purpose\n\npre*flight* **checks** [the *label*](https://example.com) &amp; <b>literal HTML</b> `  x  ` $x+1$ [INFERENCE]\n\n> **Quoted**\n> next line\n\n---\n\nEnd", "markdown");
    expect(text).toBe("# Purpose\n\npreflight checks the label &amp; <b>literal HTML</b> ` x ` $x+1$ [INFERENCE]\n\n> Quoted\n> next line\n\n---\n\nEnd");
    expect(text).not.toContain("https://example.com");
  });

  it("recurses through nested Markdown list items and their fenced code", () => {
    const text = planReviewText("1. Parent\n   - Child\n     ```ts\n       x();\n     ```\n     - Grandchild\n2. Next\n\nAfter", "markdown");
    expect(text).toContain("1. Parent\n  - Child\n\n[Code (ts)]\n  x();\n[/Code]\n    - Grandchild\n2. Next");
    expect(text.endsWith("\n\nAfter")).toBe(true);
    expect(text.indexOf("Parent")).toBeLessThan(text.indexOf("Child"));
    expect(text.indexOf("Child")).toBeLessThan(text.indexOf("Grandchild"));
    expect(text.indexOf("Grandchild")).toBeLessThan(text.indexOf("Next"));
  });

  it("preserves Markdown code, Mermaid, math, tables, and rule boundaries", () => {
    const source = "Before\n\n```mystery\n  <b>&amp;</b>\n\tx\n \n```\n\n```mermaid\n graph TD;\n A-->B\n```\n\n$$\n a + b\n$$\n\n| Choice | Reason |\n| --- | --- |\n| **A** | [Fast](https://example.com) |\n| B | ` x ` |\n\n---\n\nAfter";
    const text = planReviewText(source, "markdown");
    expect(text).toContain("[Code (mystery)]\n  <b>&amp;</b>\n\tx\n \n[/Code]");
    expect(text).toContain("[Diagram source (Mermaid)]\n graph TD;\n A-->B\n[/Diagram source]");
    expect(text).toContain("[Math]\n a + b\n[/Math]");
    expect(text).toContain("Choice | Reason\nA | Fast\nB | `x`");
    expect(text.endsWith("\n\n---\n\nAfter")).toBe(true);
  });

  it("retains incomplete fences as complete renderer-visible code", () => {
    expect(planReviewText("Before\n\n```sh\n  echo '<tail>'\n\tstill here", "markdown"))
      .toBe("Before\n\n[Code (sh)]\n  echo '<tail>'\n\tstill here\n[/Code]");
  });

  it("never truncates a large artifact or its final authored boundaries", () => {
    const padding = "Complete prose ".repeat(3_000);
    const html = planReviewText(`<p>${padding}</p><table><tr><td>TAIL_TABLE</td><td>kept</td></tr></table>
      <pre><code>  TAIL_CODE\n\tkept  </code></pre><svg><text>TAIL_SVG</text></svg>
      <math><mi>TAIL_MATH</mi></math><p>TAIL_PARAGRAPH</p>`, "html");
    expect(html.length).toBeGreaterThan(16_000);
    expect(html).toContain("TAIL_TABLE | kept");
    expect(html).toContain("[Code]\n  TAIL_CODE\n\tkept  \n[/Code]");
    expect(html.endsWith("TAIL_SVG\nTAIL_MATH\nTAIL_PARAGRAPH")).toBe(true);
    const markdown = planReviewText(`${padding}\n\n\`\`\`txt\n  TAIL_CODE\n\`\`\`\n\nTAIL_PARAGRAPH`, "markdown");
    expect(markdown.length).toBeGreaterThan(16_000);
    expect(markdown.endsWith("[Code (txt)]\n  TAIL_CODE\n[/Code]\n\nTAIL_PARAGRAPH")).toBe(true);
  });
});
