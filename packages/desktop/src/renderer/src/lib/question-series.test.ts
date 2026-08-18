import { describe, expect, it } from "vitest";
import { isAnswered, nextSeries, parsePage, recordAnswer, type SeriesState } from "./question-series";

/**
 * Frames mirror the ask tool's wire shapes captured in multi-select.test.ts:
 * single pages arrive as "Language? (1/3)"; multi-select loop frames as
 * "(1 selected) Tools? (2/3)" — planSelect strips the count prefix before
 * parsePage ever runs.
 */

describe("parsePage", () => {
  it("parses a trailing page marker", () => {
    expect(parsePage("Language? (1/3)")).toEqual({ base: "Language?", page: 1, total: 3 });
  });

  it("returns nulls without a marker", () => {
    expect(parsePage("Which tools?")).toEqual({ base: "Which tools?", page: null, total: null });
  });

  it("ignores a non-trailing parenthetical", () => {
    expect(parsePage("Q (2/3) extra")).toEqual({ base: "Q (2/3) extra", page: null, total: null });
  });

  it("parses double digits", () => {
    expect(parsePage("Format? (12/20)")).toEqual({ base: "Format?", page: 12, total: 20 });
  });
});

describe("nextSeries", () => {
  it("starts a fresh series from no prior state", () => {
    expect(nextSeries(null, parsePage("Language? (1/3)"))).toEqual({
      total: 3,
      current: 1,
      currentTitle: "Language?",
      entries: [],
    });
  });

  it("ignores frames without a marker", () => {
    const prev = nextSeries(null, parsePage("Language? (1/3)"));
    expect(nextSeries(prev, parsePage("Which tools?"))).toBeNull();
  });

  it("returns the same object for a loop frame of the live page", () => {
    const prev = nextSeries(null, parsePage("Tools? (2/3)"));
    // A multi-select loop frame repeats page + question after planSelect
    // strips "(N selected) ".
    expect(nextSeries(prev, parsePage("Tools? (2/3)"))).toBe(prev);
  });

  it("advances to the next page, preserving entries", () => {
    let state = nextSeries(null, parsePage("Language? (1/3)"))!;
    state = recordAnswer(state, { page: 1, title: "Language?", options: [], answer: ["Rust"], multi: false });
    const next = nextSeries(state, parsePage("Tools? (2/3)"))!;
    expect(next).toMatchObject({ total: 3, current: 2, currentTitle: "Tools?" });
    expect(next.entries).toEqual(state.entries);
  });

  it("starts fresh on a different total", () => {
    const prev = nextSeries(null, parsePage("Language? (2/7)"));
    expect(nextSeries(prev, parsePage("Tools? (1/3)"))).toEqual({
      total: 3,
      current: 1,
      currentTitle: "Tools?",
      entries: [],
    });
  });

  it("starts fresh on a backward page jump", () => {
    const prev = nextSeries(null, parsePage("Language? (3/3)"));
    const next = nextSeries(prev, parsePage("Language? (1/3)"))!;
    expect(next.current).toBe(1);
    expect(next.entries).toEqual([]);
  });

  it("starts fresh when the same page carries a new question", () => {
    const prev = nextSeries(null, parsePage("Language? (2/3)"));
    const next = nextSeries(prev, parsePage("Something else? (2/3)"))!;
    expect(next.currentTitle).toBe("Something else?");
    expect(next.entries).toEqual([]);
  });
});

const base = (): SeriesState => nextSeries(null, parsePage("Language? (1/3)"))!;

describe("recordAnswer", () => {
  const options = [
    { value: "Rust", label: "Rust" },
    { value: "Go", label: "Go" },
  ];

  it("appends entries in page order", () => {
    let state = base();
    state = recordAnswer(state, { page: 2, title: "Tools?", options, answer: ["Alpha"], multi: false });
    state = recordAnswer(state, { page: 1, title: "Language?", options, answer: ["Rust"], multi: false });
    expect(state.entries.map((e) => e.page)).toEqual([1, 2]);
  });

  it("replaces a prior entry for the same page", () => {
    let state = base();
    state = recordAnswer(state, { page: 1, title: "Language?", options, answer: ["Rust"], multi: false });
    state = recordAnswer(state, { page: 1, title: "Language?", options, answer: ["Go"], multi: false });
    expect(state.entries).toHaveLength(1);
    expect(state.entries[0].answer).toEqual(["Go"]);
  });

  it("keeps the placeholder's options when the editor answer lands", () => {
    let state = base();
    // "Other" pick: options recorded, answer pending.
    state = recordAnswer(state, { page: 1, title: "Language?", options, answer: [], multi: false });
    // Editor submit: free text, no options of its own.
    state = recordAnswer(state, { page: 1, title: "Language?", options: [], answer: ["custom"], multi: false });
    expect(state.entries[0].options).toEqual(options);
    expect(state.entries[0].answer).toEqual(["custom"]);
  });
});

describe("isAnswered", () => {
  it("treats an options-only placeholder as unanswered", () => {
    const state = recordAnswer(base(), {
      page: 1,
      title: "Language?",
      options: [{ value: "Rust", label: "Rust" }],
      answer: [],
      multi: false,
    });
    expect(isAnswered(state, 1)).toBe(false);
  });

  it("is true once an answer landed", () => {
    const state = recordAnswer(base(), {
      page: 1,
      title: "Language?",
      options: [],
      answer: ["Rust"],
      multi: false,
    });
    expect(isAnswered(state, 1)).toBe(true);
  });

  it("is false for pages with no entry", () => {
    expect(isAnswered(base(), 2)).toBe(false);
  });
});
