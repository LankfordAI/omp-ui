import { describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEWER,
  isReviewDocument,
  parseReviewDocument,
  resolveReviewRoster,
  validateReviewDocument,
  type ReviewDocument,
} from "./review-config";

const doc = (over: Partial<ReviewDocument> = {}): ReviewDocument => ({
  instructions: null,
  reviewers: [],
  ...over,
});
const entry = (name: string, over = {}) => ({
  name,
  model: null,
  instructions: null,
  targets: null,
  enabled: true,
  ...over,
});

describe("parseReviewDocument", () => {
  it("reads a well-formed body", () => {
    const r = parseReviewDocument(
      `
instructions: be harsh
reviewers:
  - name: Security
    model: litellm/Model-X:high
    targets: [pr]
  - name: style-critic
    enabled: false
`,
      "REVIEW.yml",
    );
    expect(r.blocking).toEqual([]);
    expect(r.document.instructions).toBe("be harsh");
    expect(r.document.reviewers).toEqual([
      { name: "security", model: "litellm/Model-X:high", instructions: null, targets: ["pr"], enabled: true },
      { name: "style-critic", model: null, instructions: null, targets: null, enabled: false },
    ]);
  });
  it("refuses non-mapping tops and syntax errors", () => {
    expect(parseReviewDocument("- a\n- b", "F").blocking[0]).toContain("not a mapping");
    expect(parseReviewDocument("instructions: [", "F").blocking[0]).toContain("YAML syntax error");
    expect(parseReviewDocument("# nothing", "F")).toEqual({
      document: { instructions: null, reviewers: [] },
      blocking: [],
    });
  });
  it("flags unknown keys at both levels", () => {
    const r = parseReviewDocument("instructions: x\nmodel: y\nreviewers:\n  - name: a\n    agent: b\n", "F");
    expect(r.blocking.some((w) => w.includes('unknown key "model"'))).toBe(true);
    expect(r.blocking.some((w) => w.includes('unknown key "agent"'))).toBe(true);
  });
  it("drops entries with a bad or duplicate slug, keeping the rest", () => {
    const r = parseReviewDocument(
      "reviewers:\n  - name: good\n  - name: ' '\n  - name: Good\n",
      "F",
    );
    expect(r.document.reviewers.map((e) => e.name)).toEqual(["good"]);
    expect(r.blocking.some((w) => w.includes("duplicates another entry"))).toBe(true);
  });
});

describe("validateReviewDocument", () => {
  it("normalizes blank text to null and reports no warnings", () => {
    const r = validateReviewDocument(
      doc({ instructions: "  ", reviewers: [entry("a", { model: " ", instructions: "" })] }),
      "the global roster",
    );
    expect(r.configWarnings).toEqual([]);
    expect(r.reviewers).toEqual([entry("a")]);
    expect(r.instructions).toBe(null);
  });
  it("drops an entry whose name slugs to nothing or repeats a slug", () => {
    const r = validateReviewDocument(doc({ reviewers: [entry("---"), entry("x"), entry("X")] }), "the global roster");
    expect(r.reviewers.map((e) => e.name)).toEqual(["x"]);
    expect(r.configWarnings).toHaveLength(2);
    expect(r.configWarnings[0]).toContain("the global roster");
  });
  it("drops over-length text and excess entries with warnings", () => {
    const big = "x".repeat(64 * 1024 + 1);
    const many = Array.from({ length: 65 }, (_, i) => entry(`r${i}`));
    const r = validateReviewDocument(
      doc({ instructions: big, reviewers: [...many, entry("big", { instructions: big })] }),
      "this project's roster",
    );
    expect(r.instructions).toBe(null);
    expect(r.reviewers).toHaveLength(64);
    expect(r.configWarnings.some((w) => w.includes("shared instructions over"))).toBe(true);
    expect(r.configWarnings.some((w) => w.includes("more than 64"))).toBe(true);
  });
  it("filters target kinds to the known set", () => {
    const r = validateReviewDocument(doc({ reviewers: [entry("a", { targets: ["pr", "moon"] as never[] })] }), "g");
    expect(r.reviewers[0]!.targets).toEqual(["pr"]);
  });
});

describe("isReviewDocument", () => {
  it("accepts documents and rejects anything else", () => {
    expect(isReviewDocument(doc({ reviewers: [entry("a")] }))).toBe(true);
    expect(isReviewDocument(null)).toBe(false);
    expect(isReviewDocument([])).toBe(false);
    expect(isReviewDocument(doc({ instructions: 3 } as never))).toBe(false);
    expect(isReviewDocument(doc({ reviewers: [{ name: "a" } as never] }))).toBe(false);
    expect(isReviewDocument(doc({ reviewers: [entry("a", { enabled: "yes" })] } as never))).toBe(false);
  });
});

describe("resolveReviewRoster", () => {
  const projectDoc = doc({ reviewers: [entry("p")] });
  const globalDoc = doc({ instructions: "shared", reviewers: [entry("g")] });

  it("the project document wins when a project exists", () => {
    const v = resolveReviewRoster("/p", { global: globalDoc, project: projectDoc });
    expect(v.reviewers.map((e) => e.name)).toEqual(["p"]);
    expect(v.instructions).toBe(null);
    expect(v.effective[0]!.sourceScope).toBe("project");
    expect(v.global).toBe(globalDoc);
    expect(v.project).toBe(projectDoc);
  });
  it("a project-less context ignores the project document", () => {
    const v = resolveReviewRoster(null, { global: globalDoc, project: projectDoc });
    expect(v.reviewers.map((e) => e.name)).toEqual(["g"]);
    expect(v.effective[0]!.sourceScope).toBe("user");
  });
  it("global fills when the project document is unset", () => {
    const v = resolveReviewRoster("/p", { global: globalDoc, project: null });
    expect(v.reviewers.map((e) => e.name)).toEqual(["g"]);
    expect(v.instructions).toBe("shared");
  });
  it("nothing set anywhere yields the default reviewer", () => {
    const v = resolveReviewRoster("/p", { global: null, project: null });
    expect(v.reviewers).toEqual([{ ...DEFAULT_REVIEWER }]);
    expect(v.effective).toEqual([{ ...DEFAULT_REVIEWER, sourceScope: "user" }]);
    expect(v.configWarnings).toEqual([]);
  });
  it("disabled entries stay out of the launch set but in the view", () => {
    const v = resolveReviewRoster(null, {
      global: doc({ reviewers: [entry("on"), entry("off", { enabled: false })] }),
      project: null,
    });
    expect(v.reviewers.map((e) => e.name)).toEqual(["on"]);
    expect(v.effective.map((e) => e.name)).toEqual(["on", "off"]);
  });
  it("validation warnings surface from the winning document", () => {
    const v = resolveReviewRoster("/p", {
      global: null,
      project: doc({ reviewers: [entry("---"), entry("ok")] }),
    });
    expect(v.reviewers.map((e) => e.name)).toEqual(["ok"]);
    expect(v.configWarnings).toHaveLength(1);
  });
});
