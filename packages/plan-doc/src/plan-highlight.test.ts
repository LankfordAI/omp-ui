// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ThemedToken } from "shiki/core";
import { composePlanSource, parsePlanSource } from "./plan-source";
import { planHighlightTransform, type CodeTokenizer } from "./plan-highlight";
import { HIGHLIGHT_CHAR_CAP } from "./highlight";
import type { Theme } from "./themes";

// The tokenizer is injected in every case: these tests cover which blocks the
// parser classifies and how accepted blocks are spliced onto their original
// ranges, not shiki (the smoke test owns real-grammar coverage).
const THEME: Theme = {
  id: "test",
  label: "Test",
  dark: false,
  tokens: {},
  term: {},
  code: {
    foreground: "#111111",
    comment: "#888888",
    string: "#222222",
    constant: "#333333",
    keyword: "#444444",
    function: "#555555",
    type: "#666666",
    property: "#777777",
    punctuation: "#999999",
    inserted: "#00aa00",
    deleted: "#aa0000",
  },
};

/** Minimal ThemedToken fixture: `offset` is required by the type, unused here. */
function token(content: string, color?: string, fontStyle?: number): ThemedToken {
  return {
    content,
    offset: 0,
    ...(color ? { color } : {}),
    ...(fontStyle ? { fontStyle } : {}),
  } as ThemedToken;
}

/** Two lines whose reconstruction is exactly SOURCE. */
const LINES: ThemedToken[][] = [
  [token("def", "#0000ff"), token(" f", "#111111"), token("():", undefined, 2)],
  [token("    return", "#0000ff"), token(" 1")],
];

const SOURCE = "def f():\n    return 1";
const SOURCE_SPANS =
  `<span class="tk-0">def</span><span class="tk-1"> f</span><span class="tk-2">():</span>\n` +
  `<span class="tk-0">    return</span> 1`;

/** Parse authored HTML, run the transform with the injected tokenizer, compose. */
async function highlight(html: string, tokenize: CodeTokenizer = async () => LINES) {
  const parsed = parsePlanSource(html);
  const out = await planHighlightTransform(parsed, THEME, tokenize);
  return { parsed, out, doc: composePlanSource(html, out.replacements) };
}

describe("parsePlanSource code classification", () => {
  it("reads the language from the code element, falling back to the pre", () => {
    const onCode = parsePlanSource(
      '<p>before</p><pre><code class="language-python">x</code></pre><p>after</p>',
    );
    expect(onCode.codeBlocks).toHaveLength(1);
    expect(onCode.codeBlocks[0]!.lang).toBe("python");
    expect(onCode.codeBlocks[0]!.sourceText).toBe("x");
    expect(onCode.diagnostics.filter((d) => d.severity === "error")).toEqual([]);

    const onPre = parsePlanSource('<pre class="language-python"><code>x</code></pre>');
    expect(onPre.codeBlocks.map((b) => b.lang)).toEqual(["python"]);
  });

  it("prefers the code element's language over the pre's", () => {
    const parsed = parsePlanSource(
      '<pre class="language-rust"><code class="language-python">x</code></pre>',
    );
    expect(parsed.codeBlocks.map((b) => b.lang)).toEqual(["python"]);
  });

  it("resolves fence-tag aliases to the canonical grammar", () => {
    const parsed = parsePlanSource("<pre><code class='language-py'>x = 1</code></pre>");
    expect(parsed.codeBlocks.map((b) => b.lang)).toEqual(["python"]);
  });

  it("hands the transform the decoded source over its own inner range", () => {
    const parsed = parsePlanSource(
      '<pre><code class="language-python">if a &lt; b &amp;&amp; c:</code></pre>',
    );
    const block = parsed.codeBlocks[0]!;
    expect(block.sourceText).toBe("if a < b && c:");
    // The inner range is the code element's content only, so a splice can
    // never reach into the tags around it.
    expect(parsed.html.slice(block.inner.startOffset, block.inner.endOffset)).toBe(
      "if a &lt; b &amp;&amp; c:",
    );
  });

  it("never classifies a bare pre, a mermaid pre, an unknown language, or an over-cap block", () => {
    const cases = [
      "<pre>no code child</pre>",
      '<pre class="mermaid">flowchart TD; A--&gt;B</pre>',
      '<pre><code class="language-elixir">IO.puts 1</code></pre>',
      `<pre><code class="language-python">${"x".repeat(HIGHLIGHT_CHAR_CAP + 1)}</code></pre>`,
      '<pre><code>a</code><code>b</code></pre>',
      '<!--<pre><code class="language-python">x</code></pre>--><p>text</p>',
      '<p title="&lt;pre&gt;&lt;code class=&quot;language-python&quot;&gt;x&lt;/code&gt;&lt;/pre&gt;">text</p>',
      '<script>var s = "<pre><code class=\\"language-python\\">x</code></pre>";</script><p>text</p>',
    ];
    for (const html of cases) {
      const parsed = parsePlanSource(html);
      // Unknown languages and oversized payloads stay plain: never a guess,
      // never a gate, and never a diagnostic.
      expect(parsed.codeBlocks, html).toEqual([]);
      expect(parsed.diagnostics.filter((d) => d.severity === "error"), html).toEqual([]);
      expect(composePlanSource(html, [])).toBe(html);
    }
  });

  it("reports markup that should have been escaped inside a code block", () => {
    const parsed = parsePlanSource('<pre><code class="language-python">a<span>b</span>c</code></pre>');
    expect(parsed.codeBlocks).toEqual([]);
    expect(
      parsed.diagnostics
        .filter((d) => d.severity === "error")
        .map((d) => [d.code, d.repair, d.detail]),
    ).toEqual([["CODE_MARKUP", "source", "<span> inside the block"]]);
  });
});

describe("planHighlightTransform", () => {
  it("splices the class attributes and the code body, leaving every other byte alone", async () => {
    const tokenize = vi.fn<CodeTokenizer>(async () => LINES);
    const source =
      `<p>keep $&amp; exact</p><pre data-x="1"><code class="language-python extra">${SOURCE}</code></pre><p>tail $'</p>`;
    const { doc } = await highlight(source, tokenize);

    expect(doc).toBe(
      `<p>keep $&amp; exact</p>` +
        `<pre data-x="1" class="omp-ui-hl"><code class="extra">${SOURCE_SPANS}</code></pre>` +
        `<p>tail $'</p>`,
    );
    expect(doc).not.toContain("language-python");
    expect(tokenize).toHaveBeenCalledWith(SOURCE, "python", THEME);
  });

  it("consumes the language token from the pre when the code carries none", async () => {
    const { doc } = await highlight(`<pre class="language-python"><code>${SOURCE}</code></pre>`);
    expect(doc).toBe(`<pre class="omp-ui-hl"><code>${SOURCE_SPANS}</code></pre>`);
  });

  it("emits unstyled default-foreground tokens bare and re-escapes their text", async () => {
    const { doc, out } = await highlight(
      '<pre><code class="language-python">if a &lt; b &amp;&amp; c:</code></pre>',
      async () => [[token("if a < b && c:")]],
    );

    // No colour and no style: no span at all, just the escaped source text.
    expect(doc).toBe('<pre class="omp-ui-hl"><code>if a &lt; b &amp;&amp; c:</code></pre>');
    expect(out.tokenCss).toBe("");
  });

  it("dedupes identical (color, fontStyle) pairs into one rule per pair used", async () => {
    const { out } = await highlight(`<pre><code class="language-python">${SOURCE}</code></pre>`);

    // `def` and `    return` share (colour, style) → one class; three pairs.
    expect(out.tokenCss.match(/\.omp-ui-hl \.tk-\d+/g)).toHaveLength(3);
    expect(out.tokenCss).toContain(".omp-ui-hl .tk-0 { color: #0000ff !important; }");
    expect(out.tokenCss).toContain(".omp-ui-hl .tk-1 { color: #111111 !important; }");
    // fontStyle 2 (bold) with no colour: the style alone still earns a rule.
    expect(out.tokenCss).toContain(".omp-ui-hl .tk-2 { font-weight: 600; }");
  });

  it("styles the italic and underline fontStyle bits", async () => {
    const italic = await highlight(
      '<pre><code class="language-python"># c</code></pre>',
      async () => [[token("# c", "#888888", 1)]],
    );
    expect(italic.out.tokenCss).toContain(
      ".omp-ui-hl .tk-0 { color: #888888 !important; font-style: italic; }",
    );

    const under = await highlight(
      '<pre><code class="language-python">u</code></pre>',
      async () => [[token("u", undefined, 4)]],
    );
    expect(under.out.tokenCss).toContain(".omp-ui-hl .tk-0 { text-decoration: underline; }");
  });

  it("emits no token CSS and no splices when nothing is highlighted", async () => {
    const { doc, out } = await highlight("<p>no code</p>");
    expect(out.replacements).toEqual([]);
    expect(out.tokenCss).toBe("");
    expect(doc).toBe("<p>no code</p>");
  });

  it("keeps a block plain when the tokenizer rejects, and still transforms siblings", async () => {
    const source =
      `<pre><code class="language-python">${SOURCE}</code></pre><p>mid</p>` +
      '<pre><code class="language-rust">fn x() {}</code></pre>';
    const { doc } = await highlight(source, async (src, lang) => {
      if (lang === "python") throw new Error("grammar exploded");
      return [[token(src, "#00ff00")]];
    });

    // Highlighting is an enhancement, never a gate: the failed block keeps its
    // authored bytes, language class included, and gets no callout of any kind.
    expect(doc).toContain(`<pre><code class="language-python">${SOURCE}</code></pre>`);
    expect(doc).toContain("<p>mid</p>");
    expect(doc).toContain(
      '<pre class="omp-ui-hl"><code><span class="tk-0">fn x() {}</span></code></pre>',
    );
    expect(doc).not.toContain("omp-ui-diagram-error");
  });

  it("keeps a block plain when the tokenizer returns null", async () => {
    const source = `<pre><code class="language-python">${SOURCE}</code></pre>`;
    const { doc, out } = await highlight(source, async () => null);

    expect(out.replacements).toEqual([]);
    expect(out.tokenCss).toBe("");
    expect(doc).toBe(source);
  });

  it("keeps a block plain when the token stream cannot rebuild its source", async () => {
    const source = `<pre><code class="language-python">${SOURCE}</code></pre>`;
    const truncated = await highlight(source, async () => [[token("def f():")]]);
    expect(truncated.doc).toBe(source);
    expect(truncated.out.tokenCss).toBe("");

    // Trailing whitespace the grammar swallowed is a mismatch too.
    const padded = await highlight(source, async () => [[token(`${SOURCE} `)]]);
    expect(padded.doc).toBe(source);

    // Line-ending differences are normalized, not read as corruption.
    const crlf = await highlight(
      '<pre><code class="language-python">def f():\r\n    return 1</code></pre>',
      async () => LINES,
    );
    expect(crlf.doc).toContain('<span class="tk-0">def</span>');
  });

  it("shares one class numbering across every block of the document", async () => {
    const { doc, out } = await highlight(
      `<pre><code class="language-python">${SOURCE}</code></pre>` +
        `<pre><code class="language-python">${SOURCE}</code></pre>`,
    );
    // Shared numbering: `def` and `    return` carry the same pair, so each
    // block emits two tk-0 spans and the second block never restarts at tk-3.
    expect(doc.match(/class="tk-0"/g)).toHaveLength(4);
    expect(doc).not.toMatch(/tk-3/);
    expect(out.tokenCss.match(/\.omp-ui-hl \.tk-\d+/g)).toHaveLength(3);
  });
});
