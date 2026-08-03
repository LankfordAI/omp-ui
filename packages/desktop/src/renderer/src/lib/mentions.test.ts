import { describe, expect, it } from "vitest";
import { deriveDirs, detectAtQuery, insertMention, mentionRanges } from "./mentions";

describe("detectAtQuery", () => {
  it("triggers at line start", () => {
    expect(detectAtQuery("@fo", 3)).toEqual({ start: 0, query: "fo" });
  });

  it("triggers after a space", () => {
    expect(detectAtQuery("hi @fo", 6)).toEqual({ start: 3, query: "fo" });
  });

  it("triggers after a boundary opener", () => {
    expect(detectAtQuery("(@fo", 4)).toEqual({ start: 1, query: "fo" });
  });

  it("opens on a bare @ with an empty query", () => {
    expect(detectAtQuery("see @", 5)).toEqual({ start: 4, query: "" });
  });

  it("does not trigger on an email address", () => {
    expect(detectAtQuery("a@b.com", 7)).toBeNull();
  });

  it("does not trigger on a mid-word @", () => {
    expect(detectAtQuery("x@y", 3)).toBeNull();
  });

  it("does not trigger with the caret on whitespace", () => {
    expect(detectAtQuery("@foo ", 5)).toBeNull();
  });

  it("respects the caret, not the word end", () => {
    expect(detectAtQuery("@foobar", 3)).toEqual({ start: 0, query: "fo" });
  });
});

describe("insertMention", () => {
  it("inserts a plain path with a trailing space", () => {
    expect(insertMention("see @fo and more", 4, 7, "a.ts")).toEqual({
      text: "see @a.ts  and more",
      caret: 10,
    });
  });

  it("quotes a path containing whitespace", () => {
    expect(insertMention("@fo", 0, 3, "my file.ts")).toEqual({
      text: '@"my file.ts" ',
      caret: 14,
    });
  });
});

describe("mentionRanges", () => {
  const known = new Set(["a.ts", "x y.ts", "src/"]);

  it("paints known mentions and skips unknown ones", () => {
    expect(mentionRanges("read @a.ts and @b.ts now", known)).toEqual([{ from: 5, to: 10 }]);
  });

  it("covers the quoted form, quotes included", () => {
    expect(mentionRanges('see @"x y.ts" here', known)).toEqual([{ from: 4, to: 13 }]);
  });

  it("paints a bare dir mention when its slash form is known", () => {
    expect(mentionRanges("list @src please", known)).toEqual([{ from: 5, to: 9 }]);
  });

  it("paints through trailing punctuation omp would strip", () => {
    expect(mentionRanges("see @a.ts.", known)).toEqual([{ from: 4, to: 10 }]);
  });

  it("ignores an email address", () => {
    expect(mentionRanges("mail a@b.com", new Set(["b.com"]))).toEqual([]);
  });
});

describe("deriveDirs", () => {
  it("yields every ancestor dir with a trailing slash, sorted and deduped", () => {
    expect(deriveDirs(["a/b/c.ts", "a/d.ts", "e.ts"])).toEqual(["a/", "a/b/"]);
  });

  it("returns nothing for a flat listing", () => {
    expect(deriveDirs(["a.ts", "b.ts"])).toEqual([]);
  });
});
