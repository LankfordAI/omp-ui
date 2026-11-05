import { describe, expect, it } from "vitest";
import {
  councilDocumentFromLegacy,
  isCouncilDocument,
  resolveCouncilRoster,
  validateCouncilDocument,
  type CouncilDocument,
  type CouncilMember,
} from "./council-config";

const doc = (over: Partial<CouncilDocument> = {}): CouncilDocument => ({
  instructions: null,
  members: [],
  ...over,
});
const entry = (name: string, over: Partial<CouncilMember> = {}): CouncilMember => ({
  name,
  model: "litellm/model-x",
  instructions: null,
  enabled: true,
  ...over,
});

describe("validateCouncilDocument", () => {
  it("normalizes blank text to null and reports no warnings", () => {
    const r = validateCouncilDocument(
      doc({ instructions: "  ", members: [entry("a", { instructions: "" })] }),
      "the global council",
    );
    expect(r.configWarnings).toEqual([]);
    expect(r.members).toEqual([entry("a")]);
    expect(r.instructions).toBe(null);
  });
  it("slugs member names", () => {
    const r = validateCouncilDocument(doc({ members: [entry("Security Critic")] }), "g");
    expect(r.members.map((m) => m.name)).toEqual(["security-critic"]);
  });
  it("drops an entry whose name slugs to nothing or repeats a slug", () => {
    const r = validateCouncilDocument(doc({ members: [entry("---"), entry("x"), entry("X")] }), "the global council");
    expect(r.members.map((m) => m.name)).toEqual(["x"]);
    expect(r.configWarnings).toEqual([
      'the global council: member "---": name must slug to [a-z][a-z0-9-]* — entry dropped',
      'the global council: member "X": duplicates another entry (slug "x") — entry dropped',
    ]);
  });
  it("drops an entry whose slug is over 24 characters", () => {
    const long = "a".repeat(25);
    const r = validateCouncilDocument(doc({ members: [entry(long), entry("b".repeat(24))] }), "g");
    expect(r.members.map((m) => m.name)).toEqual(["b".repeat(24)]);
    expect(r.configWarnings).toEqual([`g: member "${long}": name over 24 characters — entry dropped`]);
  });
  it("drops over-length text and excess stored entries with warnings", () => {
    const big = "x".repeat(64 * 1024 + 1);
    const many = Array.from({ length: 65 }, (_, i) => entry(`r${i}`, { enabled: false }));
    const r = validateCouncilDocument(
      doc({ instructions: big, members: [entry("big", { instructions: big }), ...many] }),
      "this project's council",
    );
    expect(r.instructions).toBe(null);
    expect(r.members).toEqual([]);
    expect(r.configWarnings).toEqual([
      `this project's council: shared instructions over ${64 * 1024} characters — dropped`,
      "this project's council: more than 64 members — the extras were dropped",
      `this project's council: member "big": text over ${64 * 1024} characters — entry dropped`,
    ]);
  });
  it("skips an enabled member with no model, warning about it", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("blank", { model: " " }), entry("none", { model: null }), entry("ok")] }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["ok"]);
    expect(r.configWarnings).toEqual(['g: member "blank": no model — skipped', 'g: member "none": no model — skipped']);
  });
  it("launches the first 3 enabled members with a model and warns about the rest", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("a"), entry("off", { enabled: false }), entry("b"), entry("c"), entry("d")] }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["a", "b", "c"]);
    expect(r.configWarnings).toEqual(['g: member "d": more than 3 members — skipped']);
  });
  it("never warns about disabled members", () => {
    const r = validateCouncilDocument(
      doc({
        members: [entry("a"), entry("b"), entry("c"), entry("d", { enabled: false }), entry("e", { model: null, enabled: false })],
      }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["a", "b", "c"]);
    expect(r.configWarnings).toEqual([]);
  });
});

describe("isCouncilDocument", () => {
  it("accepts documents and rejects anything else", () => {
    expect(isCouncilDocument(doc({ members: [entry("a"), entry("b", { model: null })] }))).toBe(true);
    expect(isCouncilDocument(null)).toBe(false);
    expect(isCouncilDocument([])).toBe(false);
    expect(isCouncilDocument({ instructions: null })).toBe(false);
    expect(isCouncilDocument(doc({ instructions: 3 } as never))).toBe(false);
    expect(isCouncilDocument(doc({ members: [{ name: "a" } as never] }))).toBe(false);
    expect(isCouncilDocument(doc({ members: [entry("a", { enabled: "yes" } as never)] }))).toBe(false);
    expect(isCouncilDocument(doc({ members: [entry("a", { model: 7 } as never)] }))).toBe(false);
  });
  it("tolerates extra keys", () => {
    const stored: unknown = { instructions: null, members: [{ ...entry("a"), targets: ["pr"] }], extra: 1 };
    expect(isCouncilDocument(stored)).toBe(true);
  });
  it("rejects more than 64 stored entries", () => {
    const many = Array.from({ length: 65 }, (_, i) => entry(`r${i}`));
    expect(isCouncilDocument(doc({ members: many.slice(0, 64) }))).toBe(true);
    expect(isCouncilDocument(doc({ members: many }))).toBe(false);
  });
});

describe("councilDocumentFromLegacy", () => {
  it("converts a legacy review roster, dropping targets", () => {
    const legacy = {
      instructions: "be harsh",
      reviewers: [
        { name: "security", model: "litellm/model-x", instructions: "focus auth", targets: ["pr"], enabled: true },
        { name: "style", model: null, instructions: null, targets: null, enabled: false },
      ],
    };
    expect(councilDocumentFromLegacy(legacy)).toEqual({
      instructions: "be harsh",
      members: [
        { name: "security", model: "litellm/model-x", instructions: "focus auth", enabled: true },
        { name: "style", model: null, instructions: null, enabled: false },
      ],
    });
  });
  it("reads non-string shared instructions as null", () => {
    expect(councilDocumentFromLegacy({ reviewers: [] })).toEqual({ instructions: null, members: [] });
  });
  it("rejects anything that is not a legacy document", () => {
    expect(councilDocumentFromLegacy(null)).toBe(null);
    expect(councilDocumentFromLegacy([])).toBe(null);
    expect(councilDocumentFromLegacy({ instructions: "x" })).toBe(null);
    expect(councilDocumentFromLegacy({ instructions: null, members: [] })).toBe(null);
    expect(councilDocumentFromLegacy({ instructions: null, reviewers: [{ name: "a" }] })).toBe(null);
    expect(councilDocumentFromLegacy({ instructions: null, reviewers: ["a"] })).toBe(null);
  });
});

describe("resolveCouncilRoster", () => {
  const projectDoc = doc({ members: [entry("p")] });
  const globalDoc = doc({ instructions: "shared", members: [entry("g")] });

  it("the project document wins when a project exists", () => {
    const v = resolveCouncilRoster("/p", { global: globalDoc, project: projectDoc });
    expect(v.members.map((m) => m.name)).toEqual(["p"]);
    expect(v.instructions).toBe(null);
    expect(v.effective[0]!.sourceScope).toBe("project");
    expect(v.global).toBe(globalDoc);
    expect(v.project).toBe(projectDoc);
  });
  it("a project-less context ignores the project document", () => {
    const v = resolveCouncilRoster(null, { global: globalDoc, project: projectDoc });
    expect(v.members.map((m) => m.name)).toEqual(["g"]);
    expect(v.effective[0]!.sourceScope).toBe("user");
  });
  it("global fills when the project document is unset", () => {
    const v = resolveCouncilRoster("/p", { global: globalDoc, project: null });
    expect(v.members.map((m) => m.name)).toEqual(["g"]);
    expect(v.instructions).toBe("shared");
  });
  it("nothing set anywhere yields an empty council", () => {
    expect(resolveCouncilRoster("/p", { global: null, project: null })).toEqual({
      members: [],
      effective: [],
      instructions: null,
      configWarnings: [],
      global: null,
      project: null,
    });
  });
  it("disabled entries stay out of the launch set but in the view", () => {
    const v = resolveCouncilRoster(null, {
      global: doc({ members: [entry("on"), entry("off", { enabled: false })] }),
      project: null,
    });
    expect(v.members.map((m) => m.name)).toEqual(["on"]);
    expect(v.effective.map((m) => m.name)).toEqual(["on", "off"]);
  });
  it("a model-less entry is in the view but not the launch set, with a warning", () => {
    const v = resolveCouncilRoster(null, {
      global: doc({ members: [entry("legacy", { model: null }), entry("ok")] }),
      project: null,
    });
    expect(v.members.map((m) => m.name)).toEqual(["ok"]);
    expect(v.effective).toEqual([
      { ...entry("legacy", { model: null }), sourceScope: "user" },
      { ...entry("ok"), sourceScope: "user" },
    ]);
    expect(v.configWarnings).toEqual(['the global council: member "legacy": no model — skipped']);
  });
  it("a 4th launchable member is skipped but stays in the view", () => {
    const v = resolveCouncilRoster("/p", {
      global: null,
      project: doc({ members: [entry("a"), entry("b"), entry("c"), entry("d")] }),
    });
    expect(v.members.map((m) => m.name)).toEqual(["a", "b", "c"]);
    expect(v.effective.map((m) => m.name)).toEqual(["a", "b", "c", "d"]);
    expect(v.configWarnings).toEqual(['this project\'s council: member "d": more than 3 members — skipped']);
  });
  it("validation warnings surface from the winning document", () => {
    const v = resolveCouncilRoster("/p", {
      global: null,
      project: doc({ members: [entry("---"), entry("ok")] }),
    });
    expect(v.members.map((m) => m.name)).toEqual(["ok"]);
    expect(v.effective.map((m) => m.name)).toEqual(["ok"]);
    expect(v.configWarnings).toHaveLength(1);
  });
});
