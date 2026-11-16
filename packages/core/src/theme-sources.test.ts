// The curated table is the id registry main resolves theme_set against (issue
// #1175): its shape is a host-tool contract now, not just a renderer asset.
import { describe, expect, it } from "vitest";
import { deriveTheme, themeGateFailures } from "./theme";
import { CURATED_THEME_SOURCES } from "./theme-sources";

describe("CURATED_THEME_SOURCES (issue #1175)", () => {
  it("carries twelve curated themes with unique ids and graphite first", () => {
    expect(CURATED_THEME_SOURCES).toHaveLength(12);
    expect(CURATED_THEME_SOURCES[0]!.id).toBe("graphite");
    const ids = CURATED_THEME_SOURCES.map((theme) => theme.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.filter((id) => id === "graphite")).toEqual(["graphite"]);
  });

  it("keeps every row past the theme gate", () => {
    for (const source of CURATED_THEME_SOURCES) {
      expect(themeGateFailures(source)).toEqual([]);
      expect(deriveTheme(source).id).toBe(source.id);
    }
  });
});
