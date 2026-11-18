import { describe, expect, it } from "vitest";
import { composerBacktickEdit, composerCodeAt, composerFenceAt, parseComposerCode } from "./composer-code";

describe("composer code ranges", () => {
  it("uses UTF-16 half-open CodeMark ranges and equal-length runs", () => {
    const code = parseComposerCode("😀 ``a`b``!");
    expect(code.inline).toEqual([{ open: { from: 3, to: 5 }, close: { from: 8, to: 10 } }]);
    expect([2, 3, 5, 9, 10].map((pos) => composerCodeAt(code, pos))).toEqual([false, true, true, true, false]);
    expect(parseComposerCode("`a``").inline).toEqual([]);
  });

  it("honors escapes, nesting, and literal mode", () => {
    expect(parseComposerCode("\\`escaped").inline).toEqual([]);
    const text = "> **`x`**\n> ```\n> `not inline`\n> ```";
    expect(parseComposerCode(text)).toEqual({
      inline: [{ open: { from: 4, to: 5 }, close: { from: 6, to: 7 } }],
      fences: [],
    });
    expect(parseComposerCode(text, true)).toEqual({ inline: [], fences: [] });
  });

  it("discards multiline inline code", () => {
    expect(parseComposerCode("`a\nb` and `c`").inline).toEqual([
      { open: { from: 10, to: 11 }, close: { from: 12, to: 13 } },
    ]);
  });

  it("uses physical marker lines and includes closing EOL but not following prose", () => {
    const text = "  ~~~~js\nx\n ~~~~~  \nprose";
    const code = parseComposerCode(text);
    expect(code.fences).toEqual([{
      open: { from: 2, to: 6 }, close: { from: 12, to: 17 },
      openLine: { from: 0, to: 8 }, lastLine: { from: 11, to: 19 },
    }]);
    expect(composerFenceAt(code, 19)).toBe(code.fences[0]);
    expect(composerFenceAt(code, 20)).toBeNull();
    expect(composerCodeAt(code, 20)).toBe(false);
  });

  it("counts a trailing empty EOF line in an unmatched longer fence", () => {
    const text = "````\n```\n";
    const code = parseComposerCode(text);
    expect(code.fences).toEqual([{
      open: { from: 0, to: 4 }, close: null,
      openLine: { from: 0, to: 4 }, lastLine: { from: 9, to: 9 },
    }]);
    expect(composerCodeAt(code, text.length)).toBe(true);
  });
});

// The pipe marks the caret before and after the edit; it isn't in the draft.
function typeThird(marked: string, literal = false): string | null {
  const from = marked.indexOf("|");
  const text = marked.slice(0, from) + marked.slice(from + 1);
  const edit = composerBacktickEdit(text, from, from, parseComposerCode(text, literal));
  if (!edit) return null;
  const updated = text.slice(0, edit.from) + edit.insert + text.slice(edit.to);
  return updated.slice(0, edit.caret) + "|" + updated.slice(edit.caret);
}

describe("typing the third backtick", () => {
  it("pairs a top-level opener and retains following newline and text", () => {
    expect(typeThird("``|")).toBe("```\n|\n```");
    expect(typeThird("intro\n``|\nprose")).toBe("intro\n```\n|\n```\nprose");
  });

  it("retains a bare existing closer, exits to prose, and adds a line at EOF", () => {
    expect(typeThird("```js\nbody\n``|\n```\nprose")).toBe("```js\nbody\n```\n|prose");
    expect(typeThird("```\n``|\n```")).toBe("```\n```\n|");
    expect(typeThird("```\n``|\n```\n")).toBe("```\n```\n|");
  });

  it("closes an unmatched three-backtick opener and leaves its new closer", () => {
    expect(typeThird("```\n``|")).toBe("```\n```\n|");
    expect(typeThird("```js\n``|\nprose")).toBe("```js\n```\n|prose");
  });

  it.each([
    "`|", "```|", " ``|", "\\``|", "x``|", "``| ", "``|x", "`|`", "> ``|",
    "<!--\n``|\n-->", "````\n``|\n````", "````\n``|\n```", "~~~~\n``|\n~~~~", "````\n``|",
    "```\n``|\nbody\n```", "```\n``|\n``` ", "```\n``|\n ````",
  ])("leaves %j literal", (text) => {
    expect(typeThird(text)).toBeNull();
  });

  it("leaves literal mode and noncollapsed selections alone", () => {
    expect(typeThird("``|", true)).toBeNull();
    expect(composerBacktickEdit("``x", 2, 3, parseComposerCode("``x"))).toBeNull();
  });
});
