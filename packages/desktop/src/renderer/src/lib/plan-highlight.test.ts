// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import type { ThemedToken } from "shiki/core";
import {
  extractCodeBlocks,
  highlightCodeBlocks,
  type CodeTokenizer,
} from "./plan-highlight";
import { HIGHLIGHT_CHAR_CAP } from "./highlight";
import type { Theme } from "./themes";

// The tokenizer is injected in every case: the unit tests exercise the
// extract → placeholder → substitute contract, not shiki (covered by the
// smoke test).
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
  return { content, offset: 0, ...(color ? { color } : {}), ...(fontStyle ? { fontStyle } : {}) } as ThemedToken;
}

const LINES: ThemedToken[][] = [
  [token("def", "#0000ff"), token(" f", "#111111"), token("():", undefined, 2)],
  [token("    return", "#0000ff"), token(" 1")],
];

describe("extractCodeBlocks", () => {
  it("extracts a block language-classed on the code element with decoded source", () => {
    const { html, blocks } = extractCodeBlocks(
      "<p>before</p><pre><code class=\"language-python\">def f():</code></pre><p>after</p>",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("python");
    expect(blocks[0].source).toBe("def f():");
    expect(html).toBe("<p>before</p><!--omp-ui-highlight-0--><p>after</p>");
  });

  it("extracts a block language-classed on the pre element", () => {
    const { blocks } = extractCodeBlocks(
      "<pre class=\"language-python\"><code>def f():</code></pre>",
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("python");
  });

  it("prefers the code element's language over the pre's", () => {
    const { blocks } = extractCodeBlocks(
      '<pre class="language-rust"><code class="language-python">x</code></pre>',
    );

    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("python");
  });

  it("resolves fence-tag aliases to the canonical grammar", () => {
    const { blocks } = extractCodeBlocks("<pre><code class='language-py'>x = 1</code></pre>");

    expect(blocks).toHaveLength(1);
    expect(blocks[0].lang).toBe("python");
  });

  it("leaves a bare pre without a code child untouched", () => {
    const source = "<pre>no code child</pre>";
    const { html, blocks } = extractCodeBlocks(source);

    expect(blocks).toHaveLength(0);
    expect(html).toBe(source);
  });

  it("leaves a mermaid pre untouched", () => {
    const source = '<pre class="mermaid">flowchart TD; A--&gt;B</pre>';
    const { html, blocks } = extractCodeBlocks(source);

    expect(blocks).toHaveLength(0);
    expect(html).toBe(source);
  });

  it("leaves an unknown language untouched rather than guessing", () => {
    const source = "<pre><code class=\"language-elixir\">IO.puts 1</code></pre>";
    const { html, blocks } = extractCodeBlocks(source);

    expect(blocks).toHaveLength(0);
    expect(html).toBe(source);
  });

  it("leaves a block over the character cap untouched", () => {
    const source = `<pre><code class="language-python">${"x".repeat(HIGHLIGHT_CHAR_CAP + 1)}</code></pre>`;
    const { html, blocks } = extractCodeBlocks(source);

    expect(blocks).toHaveLength(0);
    expect(html).toBe(source);
  });
});

describe("highlightCodeBlocks", () => {
  it("re-emits the block with the language token consumed and omp-ui-hl on the pre", async () => {
    const tokenize: CodeTokenizer = vi.fn(async () => LINES);
    const source =
      '<pre data-x="1"><code class="language-python extra">def f():</code></pre>';
    const { html } = await highlightCodeBlocks(source, THEME, tokenize);

    expect(html).toContain('<pre data-x="1" class="omp-ui-hl"><code class="extra">');
    expect(html).not.toContain("language-python");
    expect(html).toContain("</code></pre>");
    expect(tokenize).toHaveBeenCalledWith("def f():", "python", THEME);
  });

  it("emits default-foreground tokens bare and colored tokens as tk spans", async () => {
    const { html } = await highlightCodeBlocks(
      "<pre><code class=\"language-python\">def f():</code></pre>",
      THEME,
      async () => LINES,
    );

    expect(html).toBe(
      `<pre class="omp-ui-hl"><code>` +
        `<span class="tk-0">def</span><span class="tk-1"> f</span><span class="tk-2">():</span>\n` +
        `<span class="tk-0">    return</span> 1</code></pre>`,
    );
  });

  it("dedupes identical (color, fontStyle) pairs into one rule and styles by bitmask", async () => {
    const { tokenCss } = await highlightCodeBlocks(
      "<pre><code class=\"language-python\">def f():</code></pre>",
      THEME,
      async () => LINES,
    );

    // def and return share (color, style) → one class; three pairs total.
    expect(tokenCss.match(/\.omp-ui-hl \.tk-\d+/g)).toHaveLength(3);
    expect(tokenCss).toContain(".omp-ui-hl .tk-0 { color: #0000ff !important; }");
    expect(tokenCss).toContain(".omp-ui-hl .tk-1 { color: #111111 !important; }");
    // fontStyle 2 (bold) without a colour: the style alone still earns a rule.
    expect(tokenCss).toContain(".omp-ui-hl .tk-2 { font-weight: 600; }");
  });

  it("emits an italic rule for fontStyle 1", async () => {
    const { tokenCss } = await highlightCodeBlocks(
      "<pre><code class=\"language-python\"># c</code></pre>",
      THEME,
      async () => [[token("# c", "#888888", 1)]],
    );

    expect(tokenCss).toContain(".omp-ui-hl .tk-0 { color: #888888 !important; font-style: italic; }");
  });

  it("returns empty tokenCss when nothing was highlighted", async () => {
    const { html, tokenCss } = await highlightCodeBlocks("<p>no code</p>", THEME, async () => LINES);

    expect(html).toBe("<p>no code</p>");
    expect(tokenCss).toBe("");
  });

  it("keeps a block plain when the tokenizer rejects, leaving siblings highlighted", async () => {
    const source =
      '<pre><code class="language-python">one</code></pre><p>mid</p>' +
      '<pre><code class="language-rust">fn x() {}</code></pre>';
    const tokenize: CodeTokenizer = async (src, lang) => {
      if (lang === "python") throw new Error("grammar exploded");
      return [[token(src, "#00ff00")]];
    };
    const { html, tokenCss } = await highlightCodeBlocks(source, THEME, tokenize);

    expect(html).toContain('<pre><code class="language-python">one</code></pre>');
    expect(html).toContain("<p>mid</p>");
    expect(html).toContain('<pre class="omp-ui-hl"><code><span class="tk-0">fn x() {}</span></code></pre>');
    // Plain text is the fallback: no callout markup of any kind.
    expect(html).not.toContain("omp-ui-diagram-error");
    expect(html).not.toContain("failed");
    expect(tokenCss).toContain(".omp-ui-hl .tk-0 { color: #00ff00 !important; }");
  });

  it("keeps a block plain when the tokenizer returns null", async () => {
    const source = '<pre><code class="language-python">x</code></pre>';
    const { html, tokenCss } = await highlightCodeBlocks(source, THEME, async () => null);

    expect(html).toBe(source);
    expect(tokenCss).toBe("");
  });

  it("is idempotent: a second pass over its own output is byte-identical", async () => {
    const tokenize = vi.fn<CodeTokenizer>(async () => LINES);
    const source = '<pre><code class="language-python">def f():</code></pre>';
    const once = await highlightCodeBlocks(source, THEME, tokenize);
    const twice = await highlightCodeBlocks(once.html, THEME, tokenize);

    expect(twice.html).toBe(once.html);
    expect(twice.tokenCss).toBe("");
    expect(tokenize).toHaveBeenCalledTimes(1); // the consumed class means no second extraction
  });

  it("decodes author-escaped entities before tokenizing and re-escapes on emit", async () => {
    const captured: string[] = [];
    const tokenize: CodeTokenizer = async (src) => {
      captured.push(src);
      return [[token(src, "#abcdef")]];
    };
    const { html } = await highlightCodeBlocks(
      "<pre><code class=\"language-python\">if a &lt; b &amp;&amp; c:</code></pre>",
      THEME,
      tokenize,
    );

    expect(captured).toEqual(["if a < b && c:"]);
    expect(html).toContain("<span class=\"tk-0\">if a &lt; b &amp;&amp; c:</span>");
  });
});
