import { describe, expect, it } from "vitest";
import themeSources from "../../desktop/src/renderer/src/lib/theme-sources.json";
import { contrastRatio, deriveTheme, themeContrastFailures, type ThemeSource } from "./theme";
import {
  THEME_SEED_DEFAULTS,
  authoredThemeId,
  isThemeSeeds,
  seedsOfTheme,
  themeColoursFromSeeds,
  type ThemeSeeds,
} from "./theme-seeds";

const curated = themeSources as ThemeSource[];
const byId = (id: string): ThemeSource => curated.find((theme) => theme.id === id)!;

const failuresOf = (seeds: ThemeSeeds) =>
  themeContrastFailures(deriveTheme({ id: "custom-test", label: "Test", ...themeColoursFromSeeds(seeds) }));

describe("THEME_SEED_DEFAULTS", () => {
  it.each([
    ["dark", "graphite"],
    ["light", "light"],
  ] as const)("the %s row equals the curated %s theme", (scheme, id) => {
    const source = byId(id);
    const seeds = seedsOfTheme(source);
    const row = THEME_SEED_DEFAULTS[scheme];
    expect({ ink: seeds.ink, accents: seeds.accents, syntax: seeds.syntax }).toEqual({
      ink: row.ink,
      accents: row.accents,
      syntax: row.syntax,
    });
    expect(row.think).toEqual({
      cool: source.tokens["--color-think-cool"],
      warm: source.tokens["--color-think-warm"],
    });
  });
});

describe("themeColoursFromSeeds", () => {
  it.each(curated.map((theme) => [theme.id, theme] as const))("seeds read back from %s pass the gate", (_id, theme) => {
    expect(failuresOf(seedsOfTheme(theme))).toEqual([]);
  });

  it.each(["#000000", "#1a1b26", "#ffffff", "#fdf6e3"])("a canvas-only %s passes", (canvas) => {
    expect(failuresOf({ canvas })).toEqual([]);
  });

  it("reports the reading ink on a mid-luminance canvas", () => {
    expect(failuresOf({ canvas: "#808080" })).toContainEqual(expect.objectContaining({ label: "--color-ink" }));
  });

  it.each(["#000000", "#1a1b26", "#ffffff", "#fdf6e3"])("ink tiers on %s read on chrome and stay ordered", (canvas) => {
    const { tokens } = themeColoursFromSeeds({ canvas });
    const tiers = ["--color-ink", "--color-ink-mid", "--color-ink-dim", "--color-ink-faint"] as const;
    for (const tier of tiers) {
      expect(contrastRatio(tokens[tier], tokens["--color-void"])).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(tokens[tier], tokens["--color-sunken"])).toBeGreaterThanOrEqual(4.5);
    }
    const onSurface = tiers.map((tier) => contrastRatio(tokens[tier], tokens["--color-surface"]));
    for (let i = 1; i < onSurface.length; i++) expect(onSurface[i - 1]).toBeGreaterThanOrEqual(onSurface[i]!);
  });

  it("decides dark or light from the canvas", () => {
    expect(themeColoursFromSeeds({ canvas: "#1a1b26" }).dark).toBe(true);
    expect(themeColoursFromSeeds({ canvas: "#fdf6e3" }).dark).toBe(false);
  });
});

describe("isThemeSeeds", () => {
  it("accepts partial seeds and refuses unknown keys or non-hex colours", () => {
    expect(isThemeSeeds({ canvas: "#112233", accents: { signal: "#00ff00" } })).toBe(true);
    expect(isThemeSeeds({ canvas: "#112233", extra: 1 })).toBe(false);
    expect(isThemeSeeds({ canvas: "#112233", accents: { teal: "#00ff00" } })).toBe(false);
    expect(isThemeSeeds({ canvas: "red" })).toBe(false);
    expect(isThemeSeeds({ ink: "#ffffff" })).toBe(false);
  });
});

describe("authoredThemeId", () => {
  it("slugs the label and appends six hex digits of entropy", () => {
    expect(authoredThemeId("My Theme!", "ABCDEF12")).toBe("custom-my-theme-abcdef");
  });

  it("falls back to theme for an empty slug and pads short entropy", () => {
    expect(authoredThemeId("!!!", "zz1")).toBe("custom-theme-100000");
  });
});
