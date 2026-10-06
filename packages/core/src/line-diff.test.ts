import { describe, expect, it } from "vitest";
import { lineDiff } from "./line-diff";

describe("lineDiff", () => {
  it.each([
    ["", ""],
    ["one\ntwo", "one\ntwo"],
    ["one\ntwo", "one\ntwo\n"],
    ["one\ntwo\n", "one\ntwo"],
    ["one\r\ntwo\r\n", "one\ntwo\n"],
    ["\n", "\n"],
  ])("returns no rows for identical lines or a final-newline-only change", (before, after) => {
    expect(lineDiff(before, after)).toBe("");
  });

  it("treats empty input as zero lines, not a phantom blank", () => {
    expect(lineDiff("", "one\ntwo\n")).toBe("+1|one\n+2|two");
    expect(lineDiff("one\ntwo\n", "")).toBe("-1|one\n-2|two");
    expect(lineDiff("", "\n")).toBe("+1|");
    expect(lineDiff("\n", "")).toBe("-1|");
  });

  it("numbers replacements on their own side and deletes before adding", () => {
    expect(lineDiff("one\nold\nthree", "one\nnew\nthree"))
      .toBe(" 1|one\n-2|old\n+2|new\n 3|three");
    expect(lineDiff("a\nb", "x\ny\nz"))
      .toBe("-1|a\n-2|b\n+1|x\n+2|y\n+3|z");
  });

  it("uses after-side numbering for context when the head is inserted or deleted", () => {
    expect(lineDiff("a\nb", "new\na\nb")).toBe("+1|new\n 2|a\n 3|b");
    expect(lineDiff("gone\na\nb", "a\nb")).toBe("-1|gone\n 1|a\n 2|b");
  });

  it("handles middle and tail insertions and deletions", () => {
    expect(lineDiff("one\nthree", "one\ntwo\nthree"))
      .toBe(" 1|one\n+2|two\n 3|three");
    expect(lineDiff("one\ntwo\nthree", "one\nthree"))
      .toBe(" 1|one\n-2|two\n 2|three");
    expect(lineDiff("one", "one\ntwo")).toBe(" 1|one\n+2|two");
    expect(lineDiff("one\ntwo", "one")).toBe(" 1|one\n-2|two");
  });

  it("keeps separate changes and unchanged intervening lines", () => {
    expect(lineDiff("first\nremove\nkeep\nlast", "first\nkeep\ninsert\nlast"))
      .toBe(" 1|first\n-2|remove\n 2|keep\n+3|insert\n 4|last");
  });

  it("finds a shortest edit path for moved and repeated lines", () => {
    expect(lineDiff("a\nb\nc", "b\nc\na"))
      .toBe("-1|a\n 1|b\n 2|c\n+3|a");
    expect(lineDiff("head\nred\nsame\nred\ntail", "head\nsame\nred\nblue\ntail"))
      .toBe(" 1|head\n-2|red\n 2|same\n 3|red\n+4|blue\n 5|tail");
  });

  it("keeps content pipes, meaningful blanks and whitespace verbatim", () => {
    expect(lineDiff("a | b\n\nold\n\nend", "a | b\n\nnew | c\n\nend"))
      .toBe(" 1|a | b\n 2|\n-3|old\n+3|new | c\n 4|\n 5|end");
    expect(lineDiff("a\n", "a\n\n")).toBe(" 1|a\n+2|");
    expect(lineDiff("a\n\n", "a\n")).toBe(" 1|a\n-2|");
    expect(lineDiff("  old \t", "  new \t")).toBe("-1|  old \t\n+1|  new \t");
  });

  it("normalizes CRLF for display without changing the input strings", () => {
    const before = "one\r\n\r\nold\r\nend\r\n";
    const after = "one\r\n\r\nnew\r\nend\r\n";
    expect(lineDiff(before, after)).toBe(" 1|one\n 2|\n-3|old\n+3|new\n 4|end");
    expect(before).toBe("one\r\n\r\nold\r\nend\r\n");
    expect(after).toBe("one\r\n\r\nnew\r\nend\r\n");
  });

  it("defaults to three context lines on each side", () => {
    expect(lineDiff("1\n2\n3\n4\n5\n6\n7\n8\n9", "1\n2\n3\n4\nfive\n6\n7\n8\n9"))
      .toBe(" 2|2\n 3|3\n 4|4\n-5|5\n+5|five\n 6|6\n 7|7\n 8|8");
  });

  it("separates disjoint hunks with standalone @@ and no headers", () => {
    expect(lineDiff("1\n2\n3\n4\n5\n6\n7\n8", "1\ntwo\n3\n4\n5\nsix\n7\n8", 1))
      .toBe(" 1|1\n-2|2\n+2|two\n 3|3\n@@\n 5|5\n-6|6\n+6|six\n 7|7");
  });

  it("merges overlapping and touching context into one hunk", () => {
    expect(lineDiff("1\n2\n3\n4\n5", "1\ntwo\n3\nfour\n5", 1))
      .toBe(" 1|1\n-2|2\n+2|two\n 3|3\n-4|4\n+4|four\n 5|5");
    expect(lineDiff("1\n2\n3\n4\n5\n6", "1\ntwo\n3\n4\nfive\n6", 1))
      .toBe(" 1|1\n-2|2\n+2|two\n 3|3\n 4|4\n-5|5\n+5|five\n 6|6");
  });

  it("supports zero context while preserving absolute line numbers", () => {
    expect(lineDiff("1\n2\n3\n4\n5", "1\ntwo\n3\nfour\n5", 0))
      .toBe("-2|2\n+2|two\n@@\n-4|4\n+4|four");
  });

  it("keeps before and after numbering independent across separated hunks", () => {
    expect(lineDiff(
      "one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten",
      "intro\none\ntwo\nthree\nfour\nfive\nsix\nSEVEN\neight\nnine\nten",
      1,
    )).toBe("+1|intro\n 2|one\n@@\n 7|six\n-7|seven\n+8|SEVEN\n 9|eight");
  });

  it("trims long common prefixes and suffixes before searching", () => {
    const before = Array.from({ length: 12_000 }, (_, i) => `line ${i + 1}`);
    const after = [...before];
    after[6_000] = "changed";
    expect(lineDiff(before.join("\n"), after.join("\n")))
      .toBe(" 5998|line 5998\n 5999|line 5999\n 6000|line 6000\n-6001|line 6001\n+6001|changed\n 6002|line 6002\n 6003|line 6003\n 6004|line 6004");
  });

  it("handles a large unrelated replacement without keeping frontier history", () => {
    const before = Array.from({ length: 10_000 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 10_000 }, (_, i) => `new ${i}`);
    const expected = [
      ...before.map((line, i) => `-${i + 1}|${line}`),
      ...after.map((line, i) => `+${i + 1}|${line}`),
    ].join("\n");
    expect(lineDiff(before.join("\n"), after.join("\n"), 0)).toBe(expected);
  });

  it("bisects large replacements around a shared interior line", () => {
    const before = Array.from({ length: 512 }, (_, i) => `old ${i}`);
    const after = Array.from({ length: 512 }, (_, i) => `new ${i}`);
    before.splice(256, 0, "anchor");
    after.splice(128, 0, "anchor");
    const expected = [
      ...before.slice(0, 256).map((line, i) => `-${i + 1}|${line}`),
      ...after.slice(0, 128).map((line, i) => `+${i + 1}|${line}`),
      "@@",
      ...before.slice(257).map((line, i) => `-${i + 258}|${line}`),
      ...after.slice(129).map((line, i) => `+${i + 130}|${line}`),
    ].join("\n");
    expect(lineDiff(before.join("\n"), after.join("\n"), 0)).toBe(expected);
  });

  it("matches an independent shortest-edit oracle for repeated-line combinations", () => {
    const sequences: string[][] = [[]];
    for (let length = 1; length <= 4; length++) {
      for (let bits = 0; bits < 2 ** length; bits++) {
        sequences.push(Array.from({ length }, (_, i) => bits & (1 << i) ? "a" : "b"));
      }
    }
    for (const before of sequences) {
      for (const after of sequences) {
        const distance = Array.from({ length: before.length + 1 }, () =>
          Array<number>(after.length + 1).fill(0));
        for (let i = 0; i <= before.length; i++) distance[i][0] = i;
        for (let j = 0; j <= after.length; j++) distance[0][j] = j;
        for (let i = 1; i <= before.length; i++) {
          for (let j = 1; j <= after.length; j++) {
            distance[i][j] = before[i - 1] === after[j - 1]
              ? distance[i - 1][j - 1]
              : 1 + Math.min(distance[i - 1][j], distance[i][j - 1]);
          }
        }
        const rows = lineDiff(before.join("\n"), after.join("\n"), 0).split("\n");
        const deleted = new Set<number>();
        const added = new Set<number>();
        for (const row of rows) {
          const match = /^([+-])(\d+)\|(.*)$/.exec(row);
          if (match === null) continue;
          const index = Number(match[2]) - 1;
          if (match[1] === "-") {
            expect(match[3]).toBe(before[index]);
            expect(deleted.has(index)).toBe(false);
            deleted.add(index);
          } else {
            expect(match[3]).toBe(after[index]);
            expect(added.has(index)).toBe(false);
            added.add(index);
          }
        }
        expect(deleted.size + added.size).toBe(distance[before.length][after.length]);
        expect(before.filter((_, i) => !deleted.has(i)))
          .toEqual(after.filter((_, i) => !added.has(i)));
      }
    }
  });
});
