// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { chordFromEvent, matchesHotkey } from "./hotkeys";

const key = (init: KeyboardEventInit): KeyboardEvent => new KeyboardEvent("keydown", init);

describe("hotkey matching across layouts (issue #998)", () => {
  it("matches macOS Option glyphs by the physical key", () => {
    const optionS = key({ key: "ß", code: "KeyS", metaKey: true, altKey: true });
    expect(matchesHotkey(optionS, "mod+alt+s")).toBe(true);
    expect(chordFromEvent(optionS)).toBe("mod+alt+s");
  });

  it("records and matches shifted punctuation by the unshifted key", () => {
    const plus = key({ key: "+", code: "Equal", ctrlKey: true, shiftKey: true });
    expect(chordFromEvent(plus)).toBe("mod+shift+=");
    expect(matchesHotkey(plus, "mod+shift+=")).toBe(true);
  });

  it("keeps a plain Alt letter as typed, whatever key code the layout reports", () => {
    // AZERTY: the A key sits where QWERTY has Q.
    const altA = key({ key: "a", code: "KeyQ", ctrlKey: true, altKey: true });
    expect(chordFromEvent(altA)).toBe("mod+alt+a");
    expect(matchesHotkey(altA, "mod+alt+q")).toBe(false);
  });

  it("starts no chord on a lone modifier", () => {
    expect(chordFromEvent(key({ key: "Control", ctrlKey: true }))).toBeNull();
  });
});
