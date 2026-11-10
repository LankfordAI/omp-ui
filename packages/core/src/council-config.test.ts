import { describe, expect, it } from "vitest";
import {
  councilDocumentFromLegacy,
  isCouncilDocument,
  resolveCouncilRoster,
  suggestCouncilMembers,
  validateCouncilDocument,
  type CouncilDocument,
  type CouncilMember,
  type CouncilSuggestionModel,
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
  it("derives a blank name from the member's model with no warning (#1057)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("", { model: "openrouter/anthropic/claude-opus-5.5" })] }),
      "the global council",
    );
    expect(r.members).toEqual([entry("claude-opus-5-5", { model: "openrouter/anthropic/claude-opus-5.5" })]);
    expect(r.configWarnings).toEqual([]);
  });
  it("drops a blank-named entry whose model derives no name (#1057)", () => {
    const r = validateCouncilDocument(doc({ members: [entry("", { model: null }), entry("", { model: "litellm/🔒" })] }), "g");
    expect(r.members).toEqual([]);
    expect(r.configWarnings).toEqual([
      'g: member "": name must slug to [a-z][a-z0-9-]* — entry dropped',
      'g: member "": name must slug to [a-z][a-z0-9-]* — entry dropped',
    ]);
  });
  it("suffixes -2 when two blank names derive the same slug (#1057)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("", { model: "openrouter/anthropic/gpt-4x" }), entry("", { model: "azure/gpt-4x" })] }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["gpt-4x", "gpt-4x-2"]);
    expect(r.configWarnings).toEqual([]);
  });
  it("suffixes -2 when a derived name collides with an earlier typed name (#1057)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("hawk"), entry("", { model: "azure/hawk" })] }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["hawk", "hawk-2"]);
    expect(r.configWarnings).toEqual([]);
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
  it("launches a blank-named trial entry beside a member named from its model with no warning (#1140)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("a")], trial: entry("", { model: "azure/hawk" }) }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["a"]);
    expect(r.trial).toEqual(entry("hawk", { model: "azure/hawk" }));
    expect(r.configWarnings).toEqual([]);
  });
  it("launches three members plus a trial entry with no cap warning (#1140)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("a"), entry("b"), entry("c")], trial: entry("t") }),
      "g",
    );
    expect(r.members.map((m) => m.name)).toEqual(["a", "b", "c"]);
    expect(r.trial).toEqual(entry("t"));
    expect(r.configWarnings).toEqual([]);
  });
  it("skips an enabled trial entry with no model, warning about it (#1140)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("a")], trial: entry("x", { model: null }) }),
      "g",
    );
    expect(r.trial).toBe(null);
    expect(r.configWarnings).toEqual(['g: trial member "x": no model — skipped']);
  });
  it("skips a launchable trial entry when no council member launches (#1140)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("off", { enabled: false })], trial: entry("t") }),
      "g",
    );
    expect(r.trial).toBe(null);
    expect(r.configWarnings).toEqual(['g: trial member "t": no council member launches — skipped']);
  });
  it("drops a typed trial name that duplicates a member's slug (#1140)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("hawk")], trial: entry("hawk", { model: "azure/falcon" }) }),
      "g",
    );
    expect(r.trial).toBe(null);
    expect(r.configWarnings).toEqual(['g: trial member "hawk": duplicates another entry (slug "hawk") — entry dropped']);
  });
  it("suffixes -2 when a blank trial name derives a member's slug (#1140)", () => {
    const r = validateCouncilDocument(
      doc({ members: [entry("hawk")], trial: entry("", { model: "azure/hawk" }) }),
      "g",
    );
    expect(r.trial).toEqual(entry("hawk-2", { model: "azure/hawk" }));
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
    expect(isCouncilDocument(doc({ trial: entry("t") }))).toBe(true);
    expect(isCouncilDocument(doc({ trial: null }))).toBe(true);
    expect(isCouncilDocument(doc({ trial: "x" as never }))).toBe(false);
    expect(isCouncilDocument(doc({ trial: { name: "x" } as never }))).toBe(false);
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
      trial: null,
      effectiveTrial: null,
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
  it("a disabled trial entry stays out of the launch set but in the view (#1140)", () => {
    const v = resolveCouncilRoster("/p", {
      global: null,
      project: doc({ members: [entry("a")], trial: entry("t", { enabled: false }) }),
    });
    expect(v.trial).toBe(null);
    expect(v.effectiveTrial).toEqual({ ...entry("t", { enabled: false }), sourceScope: "project" });
    expect(v.configWarnings).toEqual([]);
  });
  it("launches a trial entry from the winning document beside a member (#1140)", () => {
    const v = resolveCouncilRoster(null, {
      global: doc({ members: [entry("g")], trial: entry("", { model: "azure/hawk" }) }),
      project: null,
    });
    expect(v.trial).toEqual(entry("hawk", { model: "azure/hawk" }));
    expect(v.effectiveTrial).toEqual({ ...entry("hawk", { model: "azure/hawk" }), sourceScope: "user" });
    expect(v.configWarnings).toEqual([]);
  });
});

const row = (provider: string, id: string): CouncilSuggestionModel => ({ provider, id });

describe("suggestCouncilMembers", () => {
  it("seeds matched favorites in favorites order, stripping a :level when matching", () => {
    const members = suggestCouncilMembers(
      [row("openai", "gpt-4"), row("anthropic", "claude"), row("google", "gemini")],
      ["anthropic/claude:high", "google/gemini"],
    );
    expect(members).toEqual([
      { name: "", model: "anthropic/claude", instructions: null, enabled: true },
      { name: "", model: "google/gemini", instructions: null, enabled: true },
    ]);
  });
  it("skips favorites absent from the catalog", () => {
    const members = suggestCouncilMembers([row("openai", "gpt-4")], ["litellm/gone:high", "openai/gpt-4"]);
    expect(members.map((m) => m.model)).toEqual(["openai/gpt-4"]);
  });
  it("keeps two favorites sharing a provider (#1058)", () => {
    const members = suggestCouncilMembers(
      [row("openai", "gpt-4"), row("openai", "gpt-5")],
      ["openai/gpt-4", "openai/gpt-5"],
    );
    expect(members.map((m) => m.model)).toEqual(["openai/gpt-4", "openai/gpt-5"]);
  });
  it("caps the selection at 3 favorites", () => {
    const members = suggestCouncilMembers(
      [row("a", "m1"), row("b", "m2"), row("c", "m3"), row("d", "m4")],
      ["a/m1", "b/m2", "c/m3", "d/m4"],
    );
    expect(members.map((m) => m.model)).toEqual(["a/m1", "b/m2", "c/m3"]);
  });
  it("never falls back to uncataloged picks: no favorites seeds nothing (#1058)", () => {
    expect(suggestCouncilMembers([row("openai", "gpt-4"), row("anthropic", "claude")], [])).toEqual([]);
  });
  it("returns nothing for an empty catalog", () => {
    expect(suggestCouncilMembers([], ["openai/gpt-4"])).toEqual([]);
  });
  it("deduplicates the same model favorited twice", () => {
    const members = suggestCouncilMembers([row("openai", "gpt-4")], ["openai/gpt-4", "openai/gpt-4:high"]);
    expect(members.map((m) => m.model)).toEqual(["openai/gpt-4"]);
  });
});
