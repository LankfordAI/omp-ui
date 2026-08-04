import { describe, expect, it } from "vitest";
import { isSafeHref, parseMarkdown, type MdBlock, type MdList, type MdSpan } from "./markdown";

/** Text of one span, recursing into nested spans (issue #40 nests emphasis). */
const spanText = (s: MdSpan): string => ("spans" in s ? s.spans.map(spanText).join("") : s.text);

/** Text of a single non-list, non-table block. */
const blockText = (block: MdBlock): string =>
  "spans" in block ? block.spans.map(spanText).join("") : block.kind === "code" ? block.text : "";

/**
 * Flattens a block tree back to the characters a reader would see. Each list
 * item contributes one `\n`-joined line per block it holds (paragraphs and
 * fenced code), so the round-trip still exposes every character.
 */
function literalText(blocks: MdBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.kind === "list") {
      const walk = (list: MdList): void => {
        for (const item of list.items) {
          parts.push(item.blocks.map(blockText).join("\n"));
          for (const child of item.children) walk(child);
        }
      };
      walk(block);
    } else if (block.kind === "table") {
      // One line per row, cells joined with `|` so cell text stays checkable.
      parts.push(block.headers.map((cell) => cell.map(spanText).join("")).join("|"));
      for (const row of block.rows) {
        parts.push(row.map((cell) => cell.map(spanText).join("")).join("|"));
      }
    } else {
      parts.push(blockText(block));
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
          { blocks: [{ kind: "p", spans: [{ kind: "text", text: "a" }] }], children: [] },
          { blocks: [{ kind: "p", spans: [{ kind: "text", text: "b" }] }], children: [] },
          { blocks: [{ kind: "p", spans: [{ kind: "text", text: "c" }] }], children: [] },
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
    // The 2 spaces are the item's content indent — structural now, stripped.
    expect(literalText(blocks)).toBe("parent\ncontinued");
  });

  it("keeps a numbered list with nested bullets as one block (issue #8)", () => {
    // One block is the numbering-continuity contract: the renderer numbers
    // items per block, so splitting would restart at 1 after the nested run.
    const blocks = parseMarkdown("1. First\n   - a\n   - b\n2. Second\n3. Third");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.ordered).toBe(true);
    expect(block.items).toHaveLength(3);
    expect(block.items[0]?.children).toHaveLength(1);
    expect(block.items[0]?.children[0]).toMatchObject({ ordered: false });
    expect(block.items[0]?.children[0]?.items).toHaveLength(2);
    expect(block.items[1]?.children).toEqual([]);
    expect(block.items[2]?.children).toEqual([]);
  });

  it("nests a 2-space-indented marker under its parent", () => {
    const blocks = parseMarkdown("1. First\n  - a\n2. Second");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.ordered).toBe(true);
    expect(block.items).toHaveLength(2);
    expect(block.items[0]?.children).toHaveLength(1);
    expect(block.items[0]?.children[0]).toMatchObject({ ordered: false });
    expect(block.items[0]?.children[0]?.items).toHaveLength(1);
  });

  it("nests lists three levels deep", () => {
    const blocks = parseMarkdown("- a\n  - b\n    - c");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.items).toHaveLength(1);
    const child = block.items[0]?.children[0];
    expect(child).toMatchObject({ ordered: false });
    expect(child?.items).toHaveLength(1);
    const grandchild = child?.items[0]?.children[0];
    expect(grandchild).toMatchObject({ ordered: false });
    expect(grandchild?.items).toHaveLength(1);
    expect(grandchild?.items[0]?.children).toEqual([]);
  });

  it("keeps mixed-kind child lists as siblings in source order", () => {
    const blocks = parseMarkdown("1. a\n   - x\n   1. y");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.items[0]?.children.map((c) => c.ordered)).toEqual([false, true]);
    expect(block.items[0]?.children[0]?.items).toHaveLength(1);
    expect(block.items[0]?.children[1]?.items).toHaveLength(1);
  });

  it("folds a continuation line into the deepest open item", () => {
    const blocks = parseMarkdown("1. a\n   - x\n     tail");
    expect(blocks).toHaveLength(1);
    // The sub-item's content indent is 5, stripped as structural.
    expect(literalText(blocks)).toContain("x\ntail");
  });

  it("keeps a nested list open across a blank line", () => {
    const blocks = parseMarkdown("- a\n  - x\n\n  - y");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.items).toHaveLength(1);
    expect(block.items[0]?.children).toHaveLength(1);
    expect(block.items[0]?.children[0]?.items).toHaveLength(2);
  });

  it("folds markers deeper than the depth cap into literal text", () => {
    const lines = Array.from({ length: 9 }, (_, k) => `${"  ".repeat(k)}- l${k}`);
    const blocks = parseMarkdown(lines.join("\n"));
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    let list: MdList = block;
    let depth = 1;
    while (list.items[0]?.children[0]) {
      list = list.items[0]!.children[0]!;
      depth++;
    }
    expect(depth).toBe(8);
    const leafText = list.items.map((i) => i.blocks.map(blockText).join("\n")).join("\n");
    expect(leafText).toContain("l7");
    // The cap marker sheds its 16 leading spaces, so it reads as `- l8`.
    expect(leafText).toContain("- l8");
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
        [{ kind: "strong", spans: [{ kind: "text", text: "name" }] }],
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
        { kind: "strong", spans: [{ kind: "text", text: "bold" }] },
        { kind: "text", text: " and " },
        { kind: "em", spans: [{ kind: "text", text: "soft" }] },
        { kind: "text", text: " and " },
        { kind: "em", spans: [{ kind: "text", text: "under" }] },
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

  it("parses nested emphasis inside bold", () => {
    expect(parseMarkdown("***both***")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "strong", spans: [{ kind: "text", text: "both" }] }],
    });
    expect(parseMarkdown("**a *b* c**")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "strong",
          spans: [
            { kind: "text", text: "a " },
            { kind: "em", spans: [{ kind: "text", text: "b" }] },
            { kind: "text", text: " c" },
          ],
        },
      ],
    });
  });

  it("parses a link and preserves its href", () => {
    expect(parseMarkdown("see [omp](https://example.com/a?b=1) here")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "see " },
        {
          kind: "link",
          spans: [{ kind: "text", text: "omp" }],
          href: "https://example.com/a?b=1",
        },
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
      items: [
        { blocks: [{ kind: "p", spans: [{ kind: "link", href: "https://a.dev" }] }] },
      ],
    });
  });
});

describe("nested inline spans and item blocks (issues #40, #41)", () => {
  it("parses inline code inside strong, em and links", () => {
    expect(parseMarkdown("**After each `rs.add()`**")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "strong",
          spans: [
            { kind: "text", text: "After each " },
            { kind: "code", text: "rs.add()" },
          ],
        },
      ],
    });
    expect(parseMarkdown("*run `npm test`*")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "em",
          spans: [
            { kind: "text", text: "run " },
            { kind: "code", text: "npm test" },
          ],
        },
      ],
    });
    expect(parseMarkdown("[`cmd` here](https://a.dev)")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "link",
          spans: [
            { kind: "code", text: "cmd" },
            { kind: "text", text: " here" },
          ],
          href: "https://a.dev",
        },
      ],
    });
  });

  it("holds a fenced code block inside a list item (issue #41)", () => {
    const blocks = parseMarkdown([
      "5. **After each `rs.add()`**",
      "   - Wait for SECONDARY.",
      "   - `health: 1`.",
      "   - Exact member configuration:",
      "     ```javascript",
      "     hidden: true",
      "     priority: 0",
      "     votes: 0",
      "     ```",
    ].join("\n"));
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.items[0]?.blocks[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "strong",
          spans: [
            { kind: "text", text: "After each " },
            { kind: "code", text: "rs.add()" },
          ],
        },
      ],
    });
    const child = block.items[0]?.children[0];
    expect(child?.items[2]?.blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "Exact member configuration:" }] },
      { kind: "code", lang: "javascript", text: "hidden: true\npriority: 0\nvotes: 0" },
    ]);
  });

  it("keeps a list going when an item carries a fenced block", () => {
    const blocks = parseMarkdown("- item\n  ```js\n  x\n  ```\n- next");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.items).toHaveLength(2);
    // The fence lands inside the first item (not a sibling block), so the
    // two items stay one numbered list — the issue #8 continuity contract.
    expect(block.items[0]?.blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "item" }] },
      { kind: "code", lang: "js", text: "x" },
    ]);
    expect(block.items[1]?.blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "next" }] },
    ]);
  });

  it("holds a fenced block deep under a nested sub-item", () => {
    const blocks = parseMarkdown("1. a\n   - x\n     ```py\n     v\n     ```");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.items[0]?.children[0]?.items[0]?.blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "x" }] },
      { kind: "code", lang: "py", text: "v" },
    ]);
  });

  it("keeps an over-indented fence literal instead of a code block", () => {
    // contentIndent is 2, so an 8-space fence dedents to 6 spaces and
    // FENCE_RE's `{0,3}` cutoff keeps it as paragraph text.
    const out = literalText(parseMarkdown("- a\n        ```\nj\n        ```"));
    expect(out).toContain("```");
  });

  it("keeps an unclosed fence as the item's tail code block", () => {
    const blocks = parseMarkdown("- a\n  ```\n  tail");
    expect(blocks[0]).toMatchObject({
      kind: "list",
      items: [
        {
          blocks: [
            { kind: "p", spans: [{ kind: "text", text: "a" }] },
            { kind: "code", lang: null, text: "tail" },
          ],
        },
      ],
    });
  });

  it("round-trips the issue-41 repro without dropping fence body", () => {
    const out = literalText(
      parseMarkdown([
        "5. **After each `rs.add()`**",
        "   - Exact member configuration:",
        "     ```javascript",
        "     hidden: true",
        "     priority: 0",
        "     votes: 0",
        "     ```",
      ].join("\n")),
    );
    expect(out).toContain("hidden: true");
    expect(out).toContain("priority: 0");
    expect(out).toContain("votes: 0");
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
    const collectList = (list: MdList): MdSpan[][] =>
      list.items.flatMap((item) => [
        ...item.blocks.filter((b) => "spans" in b).map((b) => b.spans),
        ...item.children.flatMap(collectList),
      ]);
    for (const block of blocks) {
      expect(BLOCK_KINDS[block.kind]).toBe(true);
      const groups = block.kind === "list" ? collectList(block) : "spans" in block ? [block.spans] : [];
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
