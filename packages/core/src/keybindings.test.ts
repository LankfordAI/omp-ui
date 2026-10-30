import { describe, expect, it } from "vitest";
import { keybindingOverridesCodec } from "./backend-arg-codecs";
import {
  actionChords,
  chordProblem,
  keybindingConflicts,
  normalizeKeybindingOverrides,
  parseKeybindingOverrides,
} from "./keybindings";

describe("chordProblem", () => {
  it("accepts mod chords and function keys for press actions, refusing bare keys", () => {
    expect(chordProblem("toggleConsole", "mod+shift+j")).toBeNull();
    expect(chordProblem("toggleConsole", "f6")).toBeNull();
    expect(chordProblem("toggleConsole", "alt+j")).toBe("invalid");
    expect(chordProblem("toggleConsole", "j")).toBe("invalid");
    // Modifiers out of canonical order are not a chord the matcher could produce.
    expect(chordProblem("toggleConsole", "shift+mod+j")).toBe("invalid");
  });

  it("refuses reserved chords but lets an action keep its own default", () => {
    expect(chordProblem("toggleConsole", "mod+c")).toBe("reserved");
    expect(chordProblem("toggleConsole", "mod+3")).toBe("reserved");
    expect(chordProblem("stashDraft", "mod+alt+enter")).toBe("reserved");
    expect(chordProblem("undoSettle", "mod+z")).toBeNull();
    expect(chordProblem("sendInBackground", "mod+alt+enter")).toBeNull();
  });

  it("takes exactly one unmodified letter, digit, or function key for hold to talk", () => {
    expect(chordProblem("holdToTalk", "t")).toBeNull();
    expect(chordProblem("holdToTalk", "f9")).toBeNull();
    expect(chordProblem("holdToTalk", "mod+t")).toBe("invalid");
    expect(chordProblem("holdToTalk", " ")).toBe("invalid");
  });
});

describe("keybinding conflicts", () => {
  it("names both actions when an override takes another action's chord", () => {
    expect(keybindingConflicts({ toggleConsole: "mod+k" })).toEqual([
      { chord: "mod+k", actions: ["commandPalette", "toggleConsole"] },
    ]);
  });

  it("counts a default alternate only while its action keeps the default", () => {
    expect(keybindingConflicts({ toggleConsole: "mod+shift+=" })).toHaveLength(1);
    expect(keybindingConflicts({ textLarger: "mod+shift+l", toggleConsole: "mod+shift+=" })).toEqual([]);
    expect(actionChords({ textLarger: "mod+shift+l" }, "textLarger")).toEqual(["mod+shift+l"]);
  });

  it("is resolved by swapping two chords", () => {
    expect(keybindingConflicts({ commandPalette: "mod+j", toggleConsole: "mod+k" })).toEqual([]);
  });
});

describe("parseKeybindingOverrides", () => {
  it("drops unknown actions, invalid chords, and defaults", () => {
    expect(
      parseKeybindingOverrides({ toggleConsole: "mod+shift+j", nope: "mod+u", findInSession: "x", openSettings: "mod+," }),
    ).toEqual({ toggleConsole: "mod+shift+j" });
    expect(parseKeybindingOverrides(["mod+k"])).toEqual({});
  });

  it("falls conflicting overrides back to their defaults so no chord fires twice", () => {
    // A hand-edited registry: both rebound onto one chord, and one onto a default.
    const parsed = parseKeybindingOverrides({ toggleConsole: "mod+u", findInSession: "mod+u", newChat: "mod+k" });
    expect(parsed).toEqual({});
    expect(keybindingConflicts(parsed)).toEqual([]);
  });
});

describe("keybindingOverridesCodec", () => {
  it("refuses a map that conflicts, so the host never stores one", () => {
    expect(() => keybindingOverridesCodec.decode({ toggleConsole: "mod+k" }, "overrides")).toThrow(
      /mod\+k is bound to commandPalette and toggleConsole/,
    );
    expect(() => keybindingOverridesCodec.decode({ toggleConsole: "mod+v" }, "overrides")).toThrow(/reserved/);
    expect(keybindingOverridesCodec.decode({ commandPalette: "mod+j", toggleConsole: "mod+k" }, "overrides")).toEqual({
      commandPalette: "mod+j",
      toggleConsole: "mod+k",
    });
  });

  it("normalizes to table order without defaults", () => {
    expect(normalizeKeybindingOverrides({ toggleConsole: "mod+k", commandPalette: "mod+j", openSettings: "mod+," })).toEqual({
      commandPalette: "mod+j",
      toggleConsole: "mod+k",
    });
    expect(Object.keys(normalizeKeybindingOverrides({ toggleConsole: "mod+k", commandPalette: "mod+j" }))).toEqual([
      "commandPalette",
      "toggleConsole",
    ]);
  });
});
