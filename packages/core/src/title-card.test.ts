import { describe, expect, it } from "vitest";
import { parseTitleCard } from "./title-card";

describe("parseTitleCard (issue #838)", () => {
  it("splits an emoji card into icon, code, and title", () => {
    expect(parseTitleCard("📝 PLAN: Develop a Plan for Issue 835")).toEqual({
      icon: "📝",
      code: "PLAN",
      title: "Develop a Plan for Issue 835",
    });
    expect(parseTitleCard("🧪 SWEEP: Run sweep smoke test command")).toEqual({
      icon: "🧪",
      code: "SWEEP",
      title: "Run sweep smoke test command",
    });
  });

  it("strips a Nerd Font PUA glyph to a null icon, keeping the code chip", () => {
    // A Nerd Font glyph is a real PUA codepoint; \u escapes keep it visible
    // in source. The renderer bundles no Nerd Font, so it strips to null.
    expect(parseTitleCard("\uE0A0 PLAN: Vendor glyph atlas")).toEqual({
      icon: null,
      code: "PLAN",
      title: "Vendor glyph atlas",
    });
  });

  it("trims the registry pad slot before matching", () => {
    expect(parseTitleCard("📝 PLAN: Ship dark mode   ")).toEqual({
      icon: "📝",
      code: "PLAN",
      title: "Ship dark mode",
    });
  });

  it("keeps a multi-codepoint ZWJ emoji intact", () => {
    expect(parseTitleCard("👨‍💻 PLAN: Pair program the fix")).toEqual({
      icon: "👨‍💻",
      code: "PLAN",
      title: "Pair program the fix",
    });
  });

  it("returns null for plain titles, boring icons, and lookalikes", () => {
    expect(parseTitleCard("Add MIT license file")).toBeNull();
    expect(parseTitleCard("HTTP: a primer")).toBeNull();
    // A short code alone is never a card: no icon token.
    expect(parseTitleCard("PLAN: bare code rename")).toBeNull();
    // Lowercase codes are not omp's card shape.
    expect(parseTitleCard("📝 plan: lowercase code")).toBeNull();
    // An empty title after the colon is not a card.
    expect(parseTitleCard("📝 PLAN: ")).toBeNull();
  });
});
