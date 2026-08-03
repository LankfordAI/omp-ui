import { describe, expect, it } from "vitest";
import { isSafeHref, parseMarkdown, type MdBlock } from "./markdown";

/**
 * Flattens a block tree back to the characters a reader would see. The "never
 * drops input" guarantee is only checkable against a round-trip like this.
 */
function literalText(blocks: MdBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "code") {
      parts.push(block.text);
    } else if (block.kind === "rule") {
      parts.push("");
    } else if (block.kind === "list") {
      for (const item of block.items) parts.push(item.map((s) => s.text).join(""));
    } else if (block.kind === "table") {
      // One line per row, cells joined with `|` so cell text stays checkable.
      parts.push(block.headers.map((cell) => cell.map((s) => s.text).join("")).join("|"));
      for (const row of block.rows) {
        parts.push(row.map((cell) => cell.map((s) => s.text).join("")).join("|"));
      }
    } else {
      parts.push(block.spans.map((s) => s.text).join(""));
    }
  }
  return parts.join("\n");
}

describe("parseMarkdown blocks", () => {
  it("splits paragraphs on blank lines and joins soft-wrapped lines", () => {
    expect(parseMarkdown("one\nstill one\n\ntwo")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "one\nstill one" }] },
      { kind: "p", spans: [{ kind: "text", text: "two" }] },
    ]);
  });

  it("parses a fenced block with a language", () => {
    const blocks = parseMarkdown("before\n\n```ts\nconst a = 1;\n```\n\nafter");
    expect(blocks[1]).toEqual({ kind: "code", lang: "ts", text: "const a = 1;" });
    expect(blocks[2]).toEqual({ kind: "p", spans: [{ kind: "text", text: "after" }] });
  });

  it("parses a fenced block without a language", () => {
    expect(parseMarkdown("```\nplain\n```")).toEqual([{ kind: "code", lang: null, text: "plain" }]);
  });

  it("supports ~~~ fences", () => {
    expect(parseMarkdown("~~~py\nx = 1\n~~~")).toEqual([
      { kind: "code", lang: "py", text: "x = 1" },
    ]);
  });

  it("keeps everything after an unclosed fence as code", () => {
    expect(parseMarkdown("```sh\nnpm run build\nstill streaming")).toEqual([
      { kind: "code", lang: "sh", text: "npm run build\nstill streaming" },
    ]);
  });

  it("does not treat markers inside a fence as markdown", () => {
    const blocks = parseMarkdown("```\n# not a heading\n- not a list\n**not strong**\n```");
    expect(blocks).toEqual([
      { kind: "code", lang: null, text: "# not a heading\n- not a list\n**not strong**" },
    ]);
  });

  it("parses ATX headings at every level and strips closing hashes", () => {
    const blocks = parseMarkdown("# h1\n###### h6\n## closed ##");
    expect(blocks.map((b) => (b.kind === "heading" ? b.level : -1))).toEqual([1, 6, 2]);
    expect(blocks[2]).toEqual({
      kind: "heading",
      level: 2,
      spans: [{ kind: "text", text: "closed" }],
    });
  });

  it("leaves a seven-hash run as a paragraph", () => {
    expect(parseMarkdown("####### too deep")[0]?.kind).toBe("p");
  });

  it("parses bullet lists with -, * and +", () => {
    expect(parseMarkdown("- a\n* b\n+ c")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [
          [{ kind: "text", text: "a" }],
          [{ kind: "text", text: "b" }],
          [{ kind: "text", text: "c" }],
        ],
      },
    ]);
  });

  it("parses ordered lists and keeps them separate from bullets", () => {
    const blocks = parseMarkdown("1. first\n2. second\n- bullet");
    expect(blocks[0]).toMatchObject({ kind: "list", ordered: true });
    expect(blocks[1]).toMatchObject({ kind: "list", ordered: false });
  });

  it("folds a wrapped or nested line into the open list item", () => {
    const blocks = parseMarkdown("- parent\n  continued");
    expect(blocks).toHaveLength(1);
    expect(literalText(blocks)).toBe("parent\n  continued");
  });

  it("parses blockquotes across consecutive lines", () => {
    expect(parseMarkdown("> one\n> two")).toEqual([
      { kind: "quote", spans: [{ kind: "text", text: "one\ntwo" }] },
    ]);
  });

  it("parses a pipe table into headers and rows", () => {
    const blocks = parseMarkdown("| a | b |\n|---|---|\n| 1 | 2 |\n| 3 | 4 |");
    expect(blocks[0]?.kind).toBe("table");
    expect(blocks[0]).toEqual({
      kind: "table",
      headers: [[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]],
      rows: [
        [[{ kind: "text", text: "1" }], [{ kind: "text", text: "2" }]],
        [[{ kind: "text", text: "3" }], [{ kind: "text", text: "4" }]],
      ],
    });
  });

  it("strips outer pipes and trims padding around cells", () => {
    const blocks = parseMarkdown("|  a   | b  |\n| :--  | -: |\n|  x   | y  |");
    expect(blocks[0]?.kind).toBe("table");
    if (blocks[0]?.kind === "table") {
      expect(blocks[0].headers).toEqual([
        [{ kind: "text", text: "a" }],
        [{ kind: "text", text: "b" }],
      ]);
      expect(blocks[0].rows).toEqual([
        [[{ kind: "text", text: "x" }], [{ kind: "text", text: "y" }]],
      ]);
    }
  });

  it("parses inline and code spans inside table cells", () => {
    const blocks = parseMarkdown("| **name** | `cmd` |\n|---|---|\n| a | b |");
    expect(blocks[0]).toEqual({
      kind: "table",
      headers: [
        [{ kind: "strong", text: "name" }],
        [{ kind: "code", text: "cmd" }],
      ],
      rows: [[[{ kind: "text", text: "a" }], [{ kind: "text", text: "b" }]]],
    });
  });

  it("keeps a backslash-escaped pipe inside a single cell", () => {
    const blocks = parseMarkdown("| path | val |\n|---|---|\n| a\\|b | c |");
    expect(blocks[0]?.kind).toBe("table");
    if (blocks[0]?.kind === "table") {
      expect(blocks[0].rows[0]).toEqual([
        [{ kind: "text", text: "a|b" }],
        [{ kind: "text", text: "c" }],
      ]);
    }
  });

  it("round-trips table cell text without dropping input", () => {
    const src = "| alpha | beta gamma |\n|---|---|\n| delta | epsilon |\n| zeta | eta |";
    const out = literalText(parseMarkdown(src));
    for (const cell of ["alpha", "beta gamma", "delta", "epsilon", "zeta", "eta"]) {
      expect(out).toContain(cell);
    }
  });

  it("keeps a pipe header as a paragraph until the delimiter row lands", () => {
    expect(parseMarkdown("| a | b |")[0]?.kind).toBe("p");
  });

  it("keeps prose containing a pipe as a paragraph when no delimiter follows", () => {
    expect(parseMarkdown("use | or && carefully")[0]?.kind).toBe("p");
  });

  it("does not turn paragraph-then-rule into a table", () => {
    // The header line has no pipe, so splitTableRow must reject the whole row.
    expect(parseMarkdown("hello\n---")[0]?.kind).toBe("p");
    expect(parseMarkdown("hello\n---\nworld").map((b) => b.kind)).toEqual([
      "p",
      "rule",
      "p",
    ]);
  });

  it("requires a pipe in the delimiter row to form a table", () => {
    // `---` with no pipe is a rule, not a delimiter; prose rows must survive.
    expect(parseMarkdown("a | b\n---\nc | d").map((b) => b.kind)).toEqual([
      "p",
      "rule",
      "p",
    ]);
  });

  it("parses ---, *** and ___ as rules rather than lists", () => {
    expect(parseMarkdown("---\n***\n___")).toEqual([
      { kind: "rule" },
      { kind: "rule" },
      { kind: "rule" },
    ]);
  });

  it("returns no blocks for empty or whitespace-only input", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("\n\n   \n")).toEqual([]);
  });

  it("normalises CRLF", () => {
    expect(parseMarkdown("a\r\n\r\nb")).toHaveLength(2);
  });
});

describe("parseMarkdown inline", () => {
  it("parses inline code and strips one padding space per side", () => {
    expect(parseMarkdown("run `npm test` now")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "run " },
        { kind: "code", text: "npm test" },
        { kind: "text", text: " now" },
      ],
    });
    expect(parseMarkdown("`` ` ``")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "code", text: "`" }],
    });
  });

  it("keeps markdown markers inside inline code literal", () => {
    expect(parseMarkdown("`**not strong**`")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "code", text: "**not strong**" }],
    });
  });

  it("parses strong and em", () => {
    expect(parseMarkdown("**bold** and *soft* and _under_")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "strong", text: "bold" },
        { kind: "text", text: " and " },
        { kind: "em", text: "soft" },
        { kind: "text", text: " and " },
        { kind: "em", text: "under" },
      ],
    });
  });

  it("keeps ** spanning a line break literal", () => {
    expect(parseMarkdown("**start\nend**")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "**start\nend**" }] },
    ]);
  });

  it("keeps unmatched markers literal without dropping input", () => {
    for (const src of ["**dangling", "a * b * c", "half `code", "[text](", "[text]", "_x"]) {
      expect(literalText(parseMarkdown(src))).toBe(src);
    }
  });

  it("does not emphasise inside snake_case identifiers", () => {
    expect(parseMarkdown("call snake_case_name here")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "text", text: "call snake_case_name here" }],
    });
  });

  it("resolves nested-looking markers to a single span", () => {
    expect(parseMarkdown("***both***")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "strong", text: "both" }],
    });
    expect(parseMarkdown("**a *b* c**")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "strong", text: "a *b* c" }],
    });
  });

  it("parses a link and preserves its href", () => {
    expect(parseMarkdown("see [omp](https://example.com/a?b=1) here")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "see " },
        { kind: "link", text: "omp", href: "https://example.com/a?b=1" },
        { kind: "text", text: " here" },
      ],
    });
  });

  it("parses links inside headings and list items", () => {
    expect(parseMarkdown("# [t](https://a.dev)")[0]).toMatchObject({
      kind: "heading",
      spans: [{ kind: "link", href: "https://a.dev" }],
    });
    expect(parseMarkdown("- [t](https://a.dev)")[0]).toMatchObject({
      kind: "list",
      items: [[{ kind: "link", href: "https://a.dev" }]],
    });
  });
});

describe("isSafeHref", () => {
  it("allows http, https and mailto", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:a@b.dev")).toBe(true);
    expect(isSafeHref("  HTTPS://Example.com  ")).toBe(true);
  });

  it("rejects script, data, file and relative targets", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>x</script>",
      "file:///etc/passwd",
      "vbscript:msgbox",
      "/relative/path",
      "",
      "   ",
      "java\nscript:alert(1)",
    ]) {
      expect(isSafeHref(href)).toBe(false);
    }
  });
});

describe("parseMarkdown robustness", () => {
  it("never throws on adversarial or random input", () => {
    const alphabet = "`*_-#[]()>~\\ \n\t{}\"'0123456789abz|+.!";
    const cases: string[] = [
      "```".repeat(50),
      "*".repeat(200),
      "[".repeat(100) + "]".repeat(100),
      "> ".repeat(100),
      "\u0000\u001b[31mred\u001b[0m",
      "😀 **emoji** `😀` [😀](https://a.dev)",
      "- ".repeat(500),
      "#".repeat(300),
      "a\r\nb\rc\nd",
    ];
    // Deterministic LCG: a fuzz case that fails must fail again on rerun.
    let seed = 1337;
    for (let n = 0; n < 400; n++) {
      let s = "";
      for (let k = 0; k < n % 90; k++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        s += alphabet[seed % alphabet.length];
      }
      cases.push(s);
    }
    for (const src of cases) {
      expect(() => parseMarkdown(src)).not.toThrow();
    }
  });

  it("emits only known block and span kinds", () => {
    const BLOCK_KINDS: Record<string, true> = {
      p: true,
      heading: true,
      code: true,
      list: true,
      quote: true,
      rule: true,
    };
    const SPAN_KINDS: Record<string, true> = {
      text: true,
      code: true,
      strong: true,
      em: true,
      link: true,
    };
    const blocks = parseMarkdown(
      "# h\n\ntext **b** `c` [l](https://a.dev)\n\n> q\n\n- i\n\n1. o\n\n---\n\n```js\nx\n```",
    );
    expect(blocks.length).toBeGreaterThan(6);
    for (const block of blocks) {
      expect(BLOCK_KINDS[block.kind]).toBe(true);
      const groups = block.kind === "list" ? block.items : "spans" in block ? [block.spans] : [];
      for (const group of groups) {
        for (const span of group) expect(SPAN_KINDS[span.kind]).toBe(true);
      }
    }
  });

  it("preserves every non-marker character of a plain paragraph", () => {
    const src = "the quick brown fox — jumps over 13 lazy dogs; a/b\\c (d) {f}";
    expect(literalText(parseMarkdown(src))).toBe(src);
  });
});
