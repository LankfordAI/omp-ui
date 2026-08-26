// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { highlightCodeBlocks } from "./plan-highlight";
import { DEFAULT_THEME_ID, resolveTheme } from "./themes";
// Real shiki, no DOM stubs: the javascript regex engine and the tokenizer are
// pure JS, unlike mermaid's layout (which is why the mermaid smoke test needs
// a jsdom getBBox stub). The jsdom environment only provides `window` for the
// themes.ts boot path (themes imports the backend bridge at module scope).

describe("highlightCodeBlocks (real shiki)", () => {
  it("highlights a python block in the active theme's palette", async () => {
    const theme = resolveTheme(DEFAULT_THEME_ID);
    const { html, tokenCss } = await highlightCodeBlocks(
      "<pre><code class=\"language-python\">def f():\n    return 1</code></pre>",
      theme,
    );

    expect(html).toContain('<pre class="omp-ui-hl">');
    expect(html).not.toContain("language-python");
    expect(html).toContain("tk-");
    // No bare source left: every line was tokenized.
    expect(html).toContain("def");
    expect(html).toContain("return");
    expect(tokenCss).not.toBe("");

    // Every emitted colour is a value from the theme's code palette — the
    // runtime theme build colours the plan, not a stock shiki theme.
    const emitted = [...tokenCss.matchAll(/color: (#[0-9a-f]{6})/gi)].map(
      (m) => m[1].toLowerCase(),
    );
    expect(emitted.length).toBeGreaterThan(0);
    const palette = Object.values(theme.code).map((c) => c.toLowerCase());
    for (const colour of emitted) {
      expect(palette, `token colour ${colour} is not in the theme palette`).toContain(colour);
    }
  });
});
