import { describe, expect, it } from "vitest";
import { obsidianReplyLink, parseObsidianNoteUri } from "@omp-ui/core/vault-shared";
import {
  isSafeHref,
  parseMarkdown,
  parseMarkdownCached,
  type MdBlock,
  type MdList,
  type MdSpan,
} from "./markdown";

/** Text of one span, recursing into nested spans (issue #40 nests emphasis;
    math spans carry their TeX payload as `text`, issue #191). */
const spanText = (s: MdSpan): string => ("spans" in s ? s.spans.map(spanText).join("") : s.text);

/** Text of a single non-list, non-table block. */
const blockText = (block: MdBlock): string =>
  "spans" in block
    ? block.spans.map(spanText).join("")
    : block.kind === "code" || block.kind === "math"
      ? block.text
      : "";

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
      alignments: [null, null],
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
      alignments: [null, null],
    });
  });
  it("preserves a blank leading header cell (issue #365)", () => {
    const src = "| | Model A | Model B |\n|---|---|---|\n| Label | A | B |";
    const blocks = parseMarkdown(src);
    expect(blocks[0]).toEqual({
      kind: "table",
      headers: [
        [],
        [{ kind: "text", text: "Model A" }],
        [{ kind: "text", text: "Model B" }],
      ],
      rows: [
        [
          [{ kind: "text", text: "Label" }],
          [{ kind: "text", text: "A" }],
          [{ kind: "text", text: "B" }],
        ],
      ],
      alignments: [null, null, null],
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

describe("GFM table interruption and nesting (issues #873–#876)", () => {
  const cell = (t: string) => [{ kind: "text", text: t } as MdSpan];

  it("#873 interrupts a paragraph at the delimiter row", () => {
    // The models' habit: a bold lead-in with no blank line before the table.
    const blocks = parseMarkdown("**Issues filed**:\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table"]);
    expect(blockText(blocks[0]!)).toBe("Issues filed:");
  });

  it("#873 keeps prose after an interrupted table as its own paragraph", () => {
    const blocks = parseMarkdown("**lead**\n| A | B |\n|---|---|\n| 1 | 2 |\nafter");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table", "p"]);
    expect(blockText(blocks[2]!)).toBe("after");
  });

  it("#873 prose with stray pipes before the real header stays prose", () => {
    // Only the line whose successor is a delimiter opens the table; the
    // first pipe line inside the paragraph must not become the header.
    const blocks = parseMarkdown("intro | pipe |\nmore text\n| A | B |\n|---|---|\n| 1 | 2 |");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table"]);
    expect(blockText(blocks[0]!)).toBe("intro | pipe |\nmore text");
  });

  it("#873 resumes after a table body that ends on a plain line", () => {
    const blocks = parseMarkdown("intro\n| h |\n|-|\nplain\nmore");
    expect(blocks.map((b) => b.kind)).toEqual(["p", "table", "p"]);
    expect(blockText(blocks[2]!)).toBe("plain\nmore");
  });

  it("#875 requires delimiter cells to equal the header cell count", () => {
    // Two header cells, one delimiter cell: no table, all prose.
    expect(parseMarkdown("| A | B |\n|---|\n| 1 | 2 |").map((b) => b.kind)).toEqual(["p"]);
  });

  it("#875 pads ragged rows to the header width", () => {
    const blocks = parseMarkdown("| A | B | C |\n|---|---|---|\n| 1 |");
    if (blocks[0]?.kind !== "table") throw new Error("expected a table");
    expect(blocks[0].rows).toEqual([[cell("1"), [], []]]);
  });

  it("#875 truncates over-long rows to the header width", () => {
    const blocks = parseMarkdown("| A | B |\n|---|---|\n| 1 | 2 | 3 |");
    if (blocks[0]?.kind !== "table") throw new Error("expected a table");
    expect(blocks[0].rows).toEqual([[cell("1"), cell("2")]]);
  });

  it("#874 captures delimiter alignments per column", () => {
    const blocks = parseMarkdown("| A | B | C |\n|--:|:-:|---|\n| 1 | 2 | 3 |");
    if (blocks[0]?.kind !== "table") throw new Error("expected a table");
    expect(blocks[0].alignments).toEqual(["right", "center", null]);
    const left = parseMarkdown("| A | B |\n|:--|-:|\n| 1 | 2 |");
    if (left[0]?.kind !== "table") throw new Error("expected a table");
    expect(left[0].alignments).toEqual(["left", "right"]);
  });

  it("excludes an escaped pipe from delimiter-cell splitting", () => {
    // `---\|---` is one escaped cell, not two delimiter columns.
    expect(parseMarkdown("| A |\n|---\\|---|\n| 1 |").map((b) => b.kind)).toEqual(["p"]);
  });

  it("#876 nests a table in list-item content", () => {
    const blocks = parseMarkdown("- lead\n  | A | B |\n  |---|---|\n  | 1 | 2 |");
    if (blocks[0]?.kind !== "list") throw new Error("expected a list");
    const itemBlocks = blocks[0].items[0]!.blocks;
    expect(itemBlocks.map((b) => b.kind)).toEqual(["p", "table"]);
  });

  it("#876 nests a table in a blockquote body", () => {
    const blocks = parseMarkdown("> | A | B |\n> |---|---|\n> | 1 | 2 |");
    expect(blocks).toEqual([
      {
        kind: "quote",
        spans: [],
        table: {
          headers: [cell("A"), cell("B")],
          rows: [[cell("1"), cell("2")]],
          alignments: [null, null],
        },
      },
    ]);
  });

  it("#876 keeps quote prose beside the quoted table", () => {
    const blocks = parseMarkdown("> note\n> | A | B |\n> |---|---|\n> | 1 | 2 |");
    if (blocks[0]?.kind !== "quote") throw new Error("expected a quote");
    expect(blockText(blocks[0])).toBe("note");
    expect(blocks[0].table?.headers.map((c) => c.map(spanText).join(""))).toEqual(["A", "B"]);
  });
});

describe("parseMarkdownCached (issue #858)", () => {
  // A document touching every block kind; streaming it in must agree with a
  // whole-document parse at every stop, not just at the end.
  const doc = [
    "# Title",
    "",
    "A paragraph that wraps",
    "across two lines.",
    "",
    "- item one",
    "- item two",
    "  - nested",
    "",
    "> quoted text",
    "> more quote",
    "",
    "| a | b |",
    "| - | - |",
    "| 1 | 2 |",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "$$",
    "E = mc^2",
    "$$",
    "",
    "---",
    "",
    "The end.",
    "",
    "**Interrupted table**:",
    "| x | y |",
    "| --: | :-: |",
    "| 1 | 2 |",
    "",
    "- item with table",
    "  | p | q |",
    "  | - | - |",
    "  | 1 | 2 |",
    "",
    "> quoted | prose",
    "> | m | n |",
    "> | --- | --- |",
    "> | 1 | 2 |",
  ].join("\n");

  it("matches parseMarkdown at every streaming step", () => {
    for (let n = 1; n <= doc.length; n += 7) {
      const chunk = doc.slice(0, n);
      expect(parseMarkdownCached(chunk)).toEqual(parseMarkdown(chunk));
    }
    expect(parseMarkdownCached(doc)).toEqual(parseMarkdown(doc));
  });

  it("reuses the blocks before the touched tail on an append", () => {
    const a = parseMarkdownCached("alpha\n\nbeta");
    const b = parseMarkdownCached("alpha\n\nbeta and more");
    expect(b[0]).toBe(a[0]); // untouched prefix block, same object
    expect(b[1]).toEqual(parseMarkdown("alpha\n\nbeta and more")[1]);
  });

  it("re-parses whole after a non-append edit", () => {
    parseMarkdownCached("alpha\n\nbeta");
    const edited = "ALPHA\n\nbeta";
    expect(parseMarkdownCached(edited)).toEqual(parseMarkdown(edited));
  });

  it("reflows a streamed table row from its header once the delimiter lands", () => {
    const partial = parseMarkdownCached("| a | b |");
    expect(partial[0]?.kind).toBe("p");
    const table = parseMarkdownCached("| a | b |\n| - | - |");
    expect(table[0]?.kind).toBe("table");
    const grown = parseMarkdownCached("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(grown).toEqual(parseMarkdown("| a | b |\n| - | - |\n| 1 | 2 |"));
  });

  it("streams an interrupted table to parity at every line", () => {
    // The #873 shape streamed line-by-line: the paragraph holds the raw
    // table lines until the delimiter lands, then the tail re-parse must
    // split it exactly like the whole-document parse.
    const doc = "**lead**:\n| A | B |\n|---|---|\n| 1 | 2 |\nafter";
    const stops = [...doc.matchAll(/\n/g)].map((m) => m.index + 1);
    for (const n of [...stops, doc.length]) {
      const chunk = doc.slice(0, n);
      expect(parseMarkdownCached(chunk)).toEqual(parseMarkdown(chunk));
    }
  });
});

describe("parseMarkdown inline", () => {
  it("consumes backslash escapes for every ASCII punctuation character", () => {
    const punctuation = "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~";
    for (const ch of punctuation) {
      expect(parseMarkdown(`\\${ch}`)).toEqual([
        { kind: "p", spans: [{ kind: "text", text: ch }] },
      ]);
    }
  });

  it("keeps backslashes before nonpunctuation and at the streaming tail", () => {
    const src = "before \\word \\7 \\é \\ \\";
    expect(parseMarkdown(src)).toEqual([
      { kind: "p", spans: [{ kind: "text", text: src }] },
    ]);
  });

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

  it("skips escaped closing brackets in a link label", () => {
    expect(parseMarkdown("[label\\](ignored) end](https://a.dev)")).toEqual([
      {
        kind: "p",
        spans: [
          {
            kind: "link",
            spans: [{ kind: "text", text: "label](ignored) end" }],
            href: "https://a.dev",
          },
        ],
      },
    ]);
  });

  it("allows a closing bracket after an escaped backslash", () => {
    expect(parseMarkdown("[label\\\\](https://a.dev)")).toEqual([
      {
        kind: "p",
        spans: [
          {
            kind: "link",
            spans: [{ kind: "text", text: "label\\" }],
            href: "https://a.dev",
          },
        ],
      },
    ]);
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

describe("canonical Obsidian reply links", () => {
  const vaultName = "Team & personal notes";
  const file = "Projects/duplicate (draft)/Roadmap (v2).MD";

  it.each([
    "Roadmap [draft] **bold** _under_ `code` $cost$ | A/B \\ C (v2)",
    "!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~",
    "[INFERENCE]",
    "Trailing backslash\\",
    "日本語 café 📝",
  ])("round-trips the literal title %j and exact target", (title) => {
    const blocks = parseMarkdown(obsidianReplyLink(vaultName, file, title));
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "p") throw new Error("expected a paragraph");
    expect(block.spans).toHaveLength(1);
    const link = block.spans[0];
    if (link?.kind !== "link") throw new Error("expected a reply link");
    expect(link.spans).toEqual([{ kind: "text", text: title }]);
    expect(link.href).toContain("%28");
    expect(link.href).toContain("%29");
    expect(parseObsidianNoteUri(link.href)).toEqual({ vaultName, file });
  });

  it("keeps canonical links and their escapes literal inside code", () => {
    const reply = obsidianReplyLink(vaultName, file, "[draft] *bold* `code` $cost$ | \\");
    expect(parseMarkdown(`see \`\`${reply}\`\` now`)).toEqual([
      {
        kind: "p",
        spans: [
          { kind: "text", text: "see " },
          { kind: "code", text: reply },
          { kind: "text", text: " now" },
        ],
      },
    ]);
    expect(parseMarkdown(`~~~md\n${reply}\n~~~`)).toEqual([
      { kind: "code", lang: "md", text: reply },
    ]);
    expect(parseMarkdown(`~~~md\n${reply}`)).toEqual([
      { kind: "code", lang: "md", text: reply },
    ]);
  });

  it("keeps an incomplete reply link as literal text while streaming", () => {
    const title = "[draft] *bold* `code` $cost$ | \\";
    const reply = obsidianReplyLink(vaultName, file, title);
    const href = reply.slice(reply.lastIndexOf("](") + 2, -1);
    expect(parseMarkdown(reply.slice(0, -1))).toEqual([
      { kind: "p", spans: [{ kind: "text", text: `[${title}](${href}` }] },
    ]);
  });
});

describe("claim marker (issue #558)", () => {
  it("parses [INFERENCE] as an inf span with its neighbours", () => {
    expect(parseMarkdown("a [INFERENCE] b")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "a " },
        { kind: "inf", text: "[INFERENCE]" },
        { kind: "text", text: " b" },
      ],
    });
  });

  it("matches case-insensitively and keeps the canonical literal", () => {
    for (const src of ["[inference]", "[Inference]", "[InFeReNcE]"]) {
      expect(parseMarkdown(src)[0]).toEqual({
        kind: "p",
        spans: [{ kind: "inf", text: "[INFERENCE]" }],
      });
    }
  });

  it("leaves an unterminated marker as literal text", () => {
    // Mid-stream tail: resolves on the next delta's full re-parse.
    expect(parseMarkdown("text [INFE")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "text", text: "text [INFE" }],
    });
  });

  it("handles brackets around the marker", () => {
    expect(parseMarkdown("[INFERENCE]]")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "inf", text: "[INFERENCE]" },
        { kind: "text", text: "]" },
      ],
    });
    expect(parseMarkdown("[[INFERENCE]")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "[" },
        { kind: "inf", text: "[INFERENCE]" },
      ],
    });
  });

  it("lets a real link win over the marker", () => {
    expect(parseMarkdown("[INFERENCE](https://a.dev)")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "link",
          spans: [{ kind: "text", text: "INFERENCE" }],
          href: "https://a.dev",
        },
      ],
    });
  });

  it("keeps the marker literal inside inline code", () => {
    expect(parseMarkdown("`[INFERENCE]`")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "code", text: "[INFERENCE]" }],
    });
  });

  it("parses the marker flush against punctuation and nested in strong", () => {
    expect(parseMarkdown("text.[INFERENCE]")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "text." },
        { kind: "inf", text: "[INFERENCE]" },
      ],
    });
    expect(parseMarkdown("**bold [INFERENCE]**")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "strong",
          spans: [
            { kind: "text", text: "bold " },
            { kind: "inf", text: "[INFERENCE]" },
          ],
        },
      ],
    });
  });

  it("never matches across a newline", () => {
    expect(parseMarkdown("[INFERENCE\n]")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "[INFERENCE\n]" }] },
    ]);
  });
});

describe("LaTeX math (issue #191)", () => {
  it("parses inline math in prose", () => {
    expect(parseMarkdown("value is $y_0 + y_1$ now")).toEqual([
      {
        kind: "p",
        spans: [
          { kind: "text", text: "value is " },
          { kind: "math", text: "y_0 + y_1" },
          { kind: "text", text: " now" },
        ],
      },
    ]);
  });

  it("parses inline math inside nested spans", () => {
    expect(parseMarkdown("**$a$** and *$b$*")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "strong", spans: [{ kind: "math", text: "a" }] },
        { kind: "text", text: " and " },
        { kind: "em", spans: [{ kind: "math", text: "b" }] },
      ],
    });
  });

  it("parses inline math in headings, table cells and list items", () => {
    expect(parseMarkdown("# Cost of $O(n \\log n)$")[0]).toEqual({
      kind: "heading",
      level: 1,
      spans: [
        { kind: "text", text: "Cost of " },
        { kind: "math", text: "O(n \\log n)" },
      ],
    });
    expect(parseMarkdown("| $a$ | b |\n|---|---|\n| c | d |")[0]).toEqual({
      kind: "table",
      headers: [
        [{ kind: "math", text: "a" }],
        [{ kind: "text", text: "b" }],
      ],
      rows: [[[{ kind: "text", text: "c" }], [{ kind: "text", text: "d" }]]],
      alignments: [null, null],
    });
    expect(parseMarkdown("- $a$")[0]).toMatchObject({
      kind: "list",
      items: [{ blocks: [{ kind: "p", spans: [{ kind: "math", text: "a" }] }] }],
    });
  });

  it("parses inline math in link labels and quote bodies", () => {
    expect(parseMarkdown("[$a$](https://a.dev)")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "link", spans: [{ kind: "math", text: "a" }], href: "https://a.dev" },
      ],
    });
    expect(parseMarkdown("> $q$")).toEqual([
      { kind: "quote", spans: [{ kind: "math", text: "q" }] },
    ]);
  });

  it("parses a one-line display math block", () => {
    expect(parseMarkdown("$$y = y_0 + y_1$$")).toEqual([
      { kind: "math", text: "y = y_0 + y_1" },
    ]);
    // Up to three leading spaces and trailing whitespace are structural.
    expect(parseMarkdown("   $$x$$ ")).toEqual([{ kind: "math", text: "x" }]);
    // Four spaces is past the {0,3} cutoff: a literal paragraph.
    expect(parseMarkdown("    $$x$$")[0]).toMatchObject({
      kind: "p",
      spans: [{ kind: "text", text: "    $$x$$" }],
    });
  });

  it("parses a paired display block and retains blank body lines", () => {
    expect(parseMarkdown("$$\ny = y_0 + y_1\n$$")).toEqual([
      { kind: "math", text: "y = y_0 + y_1" },
    ]);
    expect(parseMarkdown("$$\na\n\nb\n$$")).toEqual([{ kind: "math", text: "a\n\nb" }]);
  });

  it("lets a display line interrupt an open paragraph", () => {
    expect(parseMarkdown("text\n$$\nx\n$$").map((b) => b.kind)).toEqual(["p", "math"]);
    expect(parseMarkdown("text\n$$x$$\nmore").map((b) => b.kind)).toEqual(["p", "math", "p"]);
  });

  it("keeps an unclosed display opener literal without dropping characters", () => {
    expect(parseMarkdown("$$\nbody")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "$$\nbody" }] },
    ]);
    expect(parseMarkdown("$$")).toEqual([{ kind: "p", spans: [{ kind: "text", text: "$$" }] }]);
    // A paired run with an empty body is noise, not math.
    expect(parseMarkdown("$$\n$$").map((b) => b.kind)).toEqual(["p", "p"]);
  });

  it("keeps dollar runs and display delimiters in prose literal", () => {
    for (const src of ["$$$$", "price is $$x$$ today"]) {
      expect(literalText(parseMarkdown(src))).toBe(src);
    }
  });

  it("keeps escaped dollars literal and sheds the escape backslash", () => {
    expect(parseMarkdown("\\$5")).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "$5" }] },
    ]);
  });

  it("keeps whitespace-padded and unclosed inline delimiters literal", () => {
    for (const src of ["a $ b $ c", "$ x $", "a $b", "$"]) {
      expect(literalText(parseMarkdown(src))).toBe(src);
    }
  });

  it("keeps dollar delimiters inside code spans and fences as code", () => {
    expect(parseMarkdown("`$not_math$`")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "code", text: "$not_math$" }],
    });
    expect(parseMarkdown("```\n$a$\n$$b$$\n```")).toEqual([
      { kind: "code", lang: null, text: "$a$\n$$b$$" },
    ]);
  });

  it("holds a paired display block in a list item without splitting the list", () => {
    const blocks = parseMarkdown("1. First\n   $$\n   y\n   $$\n2. Second");
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected a list");
    expect(block.ordered).toBe(true);
    expect(block.items).toHaveLength(2);
    expect(block.items[0]?.blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "First" }] },
      { kind: "math", text: "y" },
    ]);
    expect(block.items[1]?.blocks).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "Second" }] },
    ]);
  });

  it("holds a one-line display block in a list item", () => {
    expect(parseMarkdown("- $$x$$")).toEqual([
      {
        kind: "list",
        ordered: false,
        items: [{ blocks: [{ kind: "math", text: "x" }], children: [] }],
      },
    ]);
  });

  it("keeps an over-indented display line literal inside an item", () => {
    // contentIndent is 2; an 8-space line dedents to 6, past the {0,3} cutoff.
    const out = literalText(parseMarkdown("- a\n        $$x$$"));
    expect(out).toContain("$$x$$");
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
    const alphabet = "`*_-#[]()>~\\ \n\t{}\"'$0123456789abz|+.!";
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
      math: true,
      list: true,
      quote: true,
      rule: true,
    };
    const SPAN_KINDS: Record<string, true> = {
      text: true,
      code: true,
      math: true,
      strong: true,
      em: true,
      link: true,
    };
    const blocks = parseMarkdown(
      "# h\n\ntext **b** `c` [l](https://a.dev) $x^2$\n\n$$y = 1$$\n\n> q\n\n- i\n\n1. o\n\n---\n\n```js\nx\n```",
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

describe("bare URL autolinking (issue #101)", () => {
  it("links a bare http(s) URL between text spans", () => {
    expect(parseMarkdown("see https://www.githubstatus.com now")[0]).toEqual({
      kind: "p",
      spans: [
        { kind: "text", text: "see " },
        {
          kind: "link",
          spans: [{ kind: "text", text: "https://www.githubstatus.com" }],
          href: "https://www.githubstatus.com",
        },
        { kind: "text", text: " now" },
      ],
    });
  });

  it("links a bare URL inside a heading", () => {
    expect(parseMarkdown("# https://a.dev")[0]).toMatchObject({
      kind: "heading",
      spans: [{ kind: "link", href: "https://a.dev" }],
    });
  });

  it("trims trailing punctuation but keeps it in the literal text", () => {
    for (const src of ["see https://a.dev.", "(see https://a.dev)", "see https://a.dev)."]) {
      const blocks = parseMarkdown(src);
      const spans = blocks[0]?.kind === "p" ? blocks[0].spans : [];
      expect(spans.find((s) => s.kind === "link")).toMatchObject({
        kind: "link",
        href: "https://a.dev",
      });
      expect(literalText(blocks)).toBe(src);
    }
  });

  it("keeps balanced parentheses inside the URL", () => {
    expect(parseMarkdown("https://en.wikipedia.org/wiki/Foo_(bar)")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "link",
          spans: [{ kind: "text", text: "https://en.wikipedia.org/wiki/Foo_(bar)" }],
          href: "https://en.wikipedia.org/wiki/Foo_(bar)",
        },
      ],
    });
  });

  it("keeps a scheme with no host and a word-glued scheme as plain text", () => {
    expect(parseMarkdown("https://")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "text", text: "https://" }],
    });
    expect(parseMarkdown("foohttps://a.dev")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "text", text: "foohttps://a.dev" }],
    });
  });

  it("never autolinks inside code spans or fenced blocks", () => {
    expect(parseMarkdown("`https://a.dev`")[0]).toEqual({
      kind: "p",
      spans: [{ kind: "code", text: "https://a.dev" }],
    });
    expect(parseMarkdown("```\nhttps://a.dev\n```")[0]).toEqual({
      kind: "code",
      lang: null,
      text: "https://a.dev",
    });
  });

  it("does not double-link a bracket-link label", () => {
    const blocks = parseMarkdown("[label https://a.dev](https://a.dev)");
    const spans = blocks[0]?.kind === "p" ? blocks[0].spans : [];
    expect(spans.filter((s) => s.kind === "link")).toHaveLength(1);
    expect(spans[0]).toEqual({
      kind: "link",
      spans: [{ kind: "text", text: "label https://a.dev" }],
      href: "https://a.dev",
    });
  });

  it("links a bare URL inside strong", () => {
    expect(parseMarkdown("**https://a.dev**")[0]).toEqual({
      kind: "p",
      spans: [
        {
          kind: "strong",
          spans: [{ kind: "link", spans: [{ kind: "text", text: "https://a.dev" }], href: "https://a.dev" }],
        },
      ],
    });
  });

  it("round-trips every character with trimmed punctuation as text", () => {
    for (const src of [
      "see https://a.dev, and https://b.dev!",
      "https://a.dev.",
      "(see https://a.dev)",
      "https://a.dev).",
      "x https://a.dev] y",
      "https://a.dev'quoted'",
    ]) {
      expect(literalText(parseMarkdown(src))).toBe(src);
    }
  });
});

describe("raw pre.mermaid blocks (issue #878)", () => {
  it("parses a settled block into a decoded mermaid code block", () => {
    const src = [
      "The tunnel:",
      "",
      '<pre class="mermaid">',
      "flowchart LR",
      '  A["a &lt;b&gt; &amp; c"]--&gt;B',
      "</pre>",
    ].join("\n");
    expect(parseMarkdown(src)).toEqual([
      { kind: "p", spans: [{ kind: "text", text: "The tunnel:" }] },
      { kind: "code", lang: "mermaid", text: 'flowchart LR\n  A["a <b> & c"]-->B' },
    ]);
  });

  it("decodes the five taught entities once and passes unknown ones through", () => {
    const blocks = parseMarkdown(
      '<pre class="mermaid">\nA["&quot;&lt;&gt;&amp;&#39;"] --> B["&lt;&amp;gt; &nbsp; &lt;3"]\n</pre>',
    );
    // `&amp;gt;` decodes exactly once (to `&gt;`); the unknown `&nbsp;` and
    // the literal `<3` pass through byte-identical.
    expect(blocks[0]).toEqual({
      kind: "code",
      lang: "mermaid",
      text: 'A[""<>&\'"] --> B["<&gt; &nbsp; <3"]',
    });
  });

  it("keeps an unclosed opener literal until the closer lands, then reflows", () => {
    // Streaming: the opener interrupts the paragraph like a settled block
    // would (startsBlock), and without a closer the run stays literal text —
    // two paragraphs, every character preserved.
    const streaming = '<h2>X</h2>\n<pre class="mermaid">\nflowchart LR';
    expect(parseMarkdown(streaming).map((b) => b.kind)).toEqual(["p", "p"]);
    expect(literalText(parseMarkdown(streaming))).toBe(streaming);
    // The same source settled parses as heading-then-diagram (reflow, like tables).
    const settled = parseMarkdown('## X\n<pre class="mermaid">\nflowchart LR\n</pre>');
    expect(settled.map((b) => b.kind)).toEqual(["heading", "code"]);
  });

  it("interrupts a paragraph with no blank line before the opener", () => {
    // The observed failure shape: prose directly under a heading, then the block.
    const blocks = parseMarkdown(
      'Diagram source:\n<pre class="mermaid">\nflowchart LR; A-->B\n</pre>\nafter',
    );
    expect(blocks.map((b) => b.kind)).toEqual(["p", "code", "p"]);
    expect(blockText(blocks[2]!)).toBe("after");
  });

  it("matches the class token like plan-source: multi-token and quote styles", () => {
    for (const open of [
      '<pre class="wide mermaid">',
      "<pre class='mermaid'>",
      '<PRE CLASS="MERMAID">',
      '<pre id="d1" class="mermaid" data-x=2>',
      '<pre class="mermaid wide">',
      '   <pre class="mermaid">',
    ]) {
      const blocks = parseMarkdown(`${open}\nflowchart LR; A-->B\n</pre>`);
      expect(blocks[0], open).toEqual({
        kind: "code",
        lang: "mermaid",
        text: "flowchart LR; A-->B",
      });
    }
  });

  it("leaves non-matching pre tags and mid-line openers literal", () => {
    for (const src of [
      '<pre class="mermaid-x">\nflowchart LR; A-->B\n</pre>',
      "<pre>\ngraph TD; A--&gt;B\n</pre>",
      '<p>see <pre class="mermaid"> flowchart LR</p>\n</pre>',
      'use <pre class="mermaid"> inline in prose\n</pre>',
      '<div class="mermaid">\nflowchart LR; A-->B\n</div>',
      '<pre class="mermaid">\n</pre>',
    ]) {
      expect(parseMarkdown(src)[0]?.kind, src).toBe("p");
    }
  });

  it("stops at the first dedicated closer line", () => {
    // The line-anchored scan makes "first closer wins" automatic.
    const blocks = parseMarkdown(
      '<pre class="mermaid">\nflowchart LR; A-->B\n</pre>\n<pre class="mermaid">\nflowchart TD; C-->D\n</pre>',
    );
    expect(blocks.map((b) => b.kind)).toEqual(["code", "code"]);
    expect(blockText(blocks[1]!)).toBe("flowchart TD; C-->D");
  });

  it("holds a settled block inside a list item at content indent (the #41 mirror)", () => {
    const blocks = parseMarkdown(
      '- lead\n  <pre class="mermaid">\n  flowchart LR; A-->B\n  </pre>\n- next',
    );
    expect(blocks).toHaveLength(1);
    const block = blocks[0];
    if (block?.kind !== "list") throw new Error("expected one list");
    expect(block.items).toHaveLength(2);
    expect(block.items[0]!.blocks.map((b) => b.kind)).toEqual(["p", "code"]);
    expect(blockText(block.items[0]!.blocks[1]!)).toBe("flowchart LR; A-->B");
  });

  it("keeps an over-indented opener literal inside an item", () => {
    // contentIndent is 2; an 8-space opener dedents to 6, past the {0,3} cutoff.
    const out = literalText(
      parseMarkdown('- a\n        <pre class="mermaid">\nflowchart LR\n        </pre>'),
    );
    expect(out).toContain('<pre class="mermaid">');
  });

  it("re-parses an append delta identically with parseMarkdownCached", () => {
    // #858 invariant for the new construct: line-anchored and context-free, so
    // the tail slice must agree with a whole parse at every streaming stop.
    const doc = [
      "intro para",
      "",
      '<pre class="mermaid">',
      "flowchart LR",
      '  A["a &lt;b&gt;"]--&gt;B',
      "</pre>",
      "",
      "outro para",
    ].join("\n");
    for (let n = 1; n <= doc.length; n += 5) {
      const chunk = doc.slice(0, n);
      expect(parseMarkdownCached(chunk)).toEqual(parseMarkdown(chunk));
    }
    expect(parseMarkdownCached(doc)).toEqual(parseMarkdown(doc));
  });
});
