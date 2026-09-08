// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { composePlanSource, parsePlanSource } from "./plan-source";
import { planHighlightTransform } from "./plan-highlight";
import { DEFAULT_THEME_ID, resolveTheme } from "./themes";
import type { Theme } from "./themes";

// Real shiki, no DOM stubs: the javascript regex engine and the tokenizer are
// pure JS, unlike mermaid's layout (which is why the mermaid smoke test needs
// a jsdom getBBox stub). The jsdom environment only provides `window` for the
// themes.ts boot path (themes imports the backend bridge at module scope).
//
// This is the engine check for the range pipeline: the classifier and the
// composer are pinned by plan-highlight.test.ts with an injected tokenizer;
// here the real grammar decides the spans, so the assertion that matters is
// that the spans land on the block's OWN range and every other byte of the
// document survives the join literally.
const theme: Theme = resolveTheme(DEFAULT_THEME_ID);

/** Authored HTML → real shiki → composed document. */
async function highlight(html: string, active: Theme = theme) {
  const parsed = parsePlanSource(html);
  const out = await planHighlightTransform(parsed, active);
  return { parsed, out, doc: composePlanSource(html, out.replacements) };
}

/** Every colour the transform emitted, lowercased. */
function emittedColours(tokenCss: string): string[] {
  return [...tokenCss.matchAll(/color: (#[0-9a-f]{6})/gi)].map((m) => m[1]!.toLowerCase());
}

describe("planHighlightTransform (real shiki)", () => {
  it("highlights a python block in the active theme's palette", async () => {
    const html = "<pre><code class=\"language-python\">def f():\n    return 1</code></pre>";
    const { parsed, out, doc } = await highlight(html);

    expect(parsed.codeBlocks.map((b) => b.lang)).toEqual(["python"]);
    expect(doc).toContain('<pre class="omp-ui-hl">');
    expect(doc).not.toContain("language-python");
    expect(doc).toContain("tk-");
    // No bare source left: every line was tokenized.
    expect(doc).toContain("def");
    expect(doc).toContain("return");
    expect(out.tokenCss).not.toBe("");

    // Every emitted colour is a value from the theme's code palette — the
    // runtime theme build colours the plan, not a stock shiki theme.
    const emitted = emittedColours(out.tokenCss);
    expect(emitted.length).toBeGreaterThan(0);
    const palette = Object.values(theme.code).map((c) => c.toLowerCase());
    for (const colour of emitted) {
      expect(palette, `token colour ${colour} is not in the theme palette`).toContain(colour);
    }
  });

  it("tokenizes bash without disturbing a dollar sequence or the neighbouring bytes", async () => {
    const html =
      '<p>step 7 &mdash; totals</p><pre class="wide"><code class="language-bash">' +
      "awk '/total:$/' report.csv\n" +
      'echo "${TOTAL} done" # $& comment</code></pre><p>tail $&amp; $\'</p>';
    const { parsed, out, doc } = await highlight(html);
    // The `language-bash` convention is consumed, the highlighter class added.
    expect(doc).not.toContain("language-bash");
    expect(parsed.codeBlocks.map((b) => b.lang)).toEqual(["bash"]);
    expect(doc).toContain('<pre class="wide omp-ui-hl">');
    expect(out.replacements.length).toBeGreaterThan(0);
    // The generated spans carry the dollar bytes; the composer inserts them as
    // data, so no replacement pattern can fire (issue #412).
    const text = doc.replace(/<[^>]*>/g, "");
    expect(text).toContain(`awk '/total:$/' report.csv`);
    // `escapeHtml` re-escapes the generated span text, so the dollar bytes
    // arrive in their entity form — never expanded, never doubled.
    expect(text).toContain('echo &quot;${TOTAL} done&quot; # $&amp; comment');
    expect(doc).toContain("<p>tail $&amp; $'</p>");
  });

  it("leaves an unknown language byte-identical and emits no token CSS", async () => {
    const html =
      '<html><body><pre><code class="language-brainfuck">-&gt;+[&lt;]&gt;-</code></pre></body></html>';
    const { parsed, out, doc } = await highlight(html);

    // Unknown grammar: plain text, never a guess and never a diagnostic.
    expect(parsed.codeBlocks).toEqual([]);
    expect(parsed.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(out.replacements).toEqual([]);
    expect(out.tokenCss).toBe("");
    expect(doc).toBe(html);
  });

  it("splices only the classified blocks of a mixed document", async () => {
    const html =
      "<h1>Plan</h1>" +
      '<pre><code class="language-python">def f():\n    return 1</code></pre>' +
      "<p>prose with &amp; an entity</p>" +
      "<pre><code>plain = 1</code></pre>" +
      '<p><code>inline chip</code></p>';
    const { parsed, doc } = await highlight(html);

    expect(parsed.codeBlocks).toHaveLength(1);
    expect(doc).toContain('<pre class="omp-ui-hl"><code><span class="tk-');
    // Untouched regions are byte-preserved by the composition, not reprinted.
    expect(doc).toContain("<h1>Plan</h1>");
    expect(doc).toContain("<p>prose with &amp; an entity</p>");
    expect(doc).toContain("<pre><code>plain = 1</code></pre>");
    expect(doc).toContain("<p><code>inline chip</code></p>");
  });
});
