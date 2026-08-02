import { describe, expect, it } from "vitest";
import {
  DONE_SENTINEL,
  isDoneSentinel,
  OTHER_OPTION,
  planSelect,
  readOptions,
  togglePick,
} from "./multi-select";

/**
 * Fixtures below are verbatim frames captured from a live `omp --mode=rpc-ui`
 * session driving the ask tool — one per question shape the tool can produce.
 */

describe("planSelect — single question, single-select", () => {
  // { method: "select", title: "Which tools do you use?",
  //   options: ["Alpha","Beta","Gamma","Other (type your own)"] }
  it("is not a loop and has no done value", () => {
    const plan = planSelect(
      "Which tools do you use?",
      readOptions(["Alpha", "Beta", "Gamma", OTHER_OPTION]),
    );
    expect(plan).toMatchObject({ base: "Which tools do you use?", count: null, doneValue: null });
    expect(plan.listed.map((o) => o.label)).toEqual(["Alpha", "Beta", "Gamma", OTHER_OPTION]);
  });

  it("keeps a recommended suffix in the label (protocol echoes it back)", () => {
    // ask appends " (Recommended)" in single-select mode; the reply must be
    // the label as sent, so the plan must not strip it.
    const plan = planSelect("Pick one", readOptions(["JWT (Recommended)", "OAuth2"]));
    expect(plan.listed[0]!.value).toBe("JWT (Recommended)");
  });
});

describe("planSelect — single question, multi-select loop", () => {
  // First frame is indistinguishable from single-select:
  // { title: "Which tools?", options: ["Alpha","Beta","Gamma","Other (type your own)"] }
  it("treats the first frame as a plain select", () => {
    const plan = planSelect("Which tools?", readOptions(["Alpha", "Beta", OTHER_OPTION]));
    expect(plan.count).toBeNull();
    expect(plan.doneValue).toBeNull();
  });

  // Loop frame:
  // { title: "(1 selected) Which tools?",
  //   options: ["Alpha","Beta","Gamma","✔ Done selecting","Other (type your own)"] }
  it("recognizes a loop frame and lifts the sentinel out of the list", () => {
    const plan = planSelect(
      "(1 selected) Which tools?",
      readOptions(["Alpha", "Beta", "Gamma", "✔ Done selecting", OTHER_OPTION]),
    );
    expect(plan).toMatchObject({
      base: "Which tools?",
      count: 1,
      doneValue: "✔ Done selecting",
    });
    expect(plan.listed.map((o) => o.label)).toEqual(["Alpha", "Beta", "Gamma", OTHER_OPTION]);
  });
});

describe("planSelect — multi-question ask", () => {
  // Pages carry a (i/n) marker: { title: "Language? (1/3)", options: [...] }
  it("keeps the page marker in the base of a single-select page", () => {
    const plan = planSelect("Language? (1/3)", readOptions(["Rust", "Go", OTHER_OPTION]));
    expect(plan).toMatchObject({ base: "Language? (1/3)", count: null, doneValue: null });
  });

  // Multi-select page loop frames carry NO sentinel (forward navigation is
  // active in the TUI): { title: "(1 selected) Tools? (2/3)",
  //   options: ["Alpha","Beta","Gamma","Other (type your own)"] }
  it("falls back to the default sentinel when a loop frame lists none", () => {
    const plan = planSelect(
      "(1 selected) Tools? (2/3)",
      readOptions(["Alpha", "Beta", "Gamma", OTHER_OPTION]),
    );
    expect(plan).toMatchObject({ base: "Tools? (2/3)", count: 1 });
    // omp accepts the unlisted sentinel string and finishes the question
    // (verified live) — so the plan must still offer a way to submit.
    expect(plan.doneValue).toBe(DONE_SENTINEL);
  });

  it("distinguishes pages of identical questions by their page marker", () => {
    expect(planSelect("Tools? (1/3)", []).base).not.toBe(planSelect("Tools? (2/3)", []).base);
  });
});

describe("planSelect — title edge cases", () => {
  it("does not eat a mid-title parenthetical", () => {
    const plan = planSelect("Pick (2 selected) style", []);
    expect(plan).toMatchObject({ base: "Pick (2 selected) style", count: null });
  });

  it("parses double-digit counts", () => {
    expect(planSelect("(12 selected) Q", []).count).toBe(12);
  });
});

describe("readOptions — option shapes", () => {
  it("reads bare strings (what omp's ask sends)", () => {
    expect(readOptions(["a"])).toEqual([{ value: "a", label: "a", description: undefined }]);
  });

  it("reads object options with label/value/description", () => {
    expect(readOptions([{ label: "L", value: "v", description: "d" }])).toEqual([
      { value: "v", label: "L", description: "d" },
    ]);
  });

  it("falls back value → label for label-only objects", () => {
    expect(readOptions([{ label: "L" }])[0]).toMatchObject({ value: "L" });
  });

  it("returns empty for a frame without options (confirm/input)", () => {
    expect(readOptions(undefined)).toEqual([]);
  });
});

describe("isDoneSentinel", () => {
  it("matches omp's themed sentinel variants", () => {
    for (const s of ["✔ Done selecting", "✓ Done selecting", "Done selecting"]) {
      expect(isDoneSentinel(s)).toBe(true);
    }
  });

  it("rejects real options", () => {
    for (const s of ["Done", "Keep selecting", "✔ Done selecting now"]) {
      expect(isDoneSentinel(s)).toBe(false);
    }
  });
});

describe("togglePick", () => {
  it("adds an unpicked label", () => {
    expect(togglePick(["a"], "b")).toEqual(["a", "b"]);
  });

  it("removes a picked label", () => {
    expect(togglePick(["a", "b"], "a")).toEqual(["b"]);
  });

  it("propagates the unknown state", () => {
    expect(togglePick(null, "a")).toBeNull();
  });
});
