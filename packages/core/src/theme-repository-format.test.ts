import { describe, expect, it } from "vitest";
import {
  THEME_INDEX_ENTRIES_MAX,
  THEME_REPOSITORIES_MAX,
  parseThemeIndex,
  parseThemeRepositories,
  parseThemeRepositoryRef,
  sameThemeSeeds,
} from "./theme-repository-format";

const entry = (path: string, label = "Dusk"): Record<string, unknown> => ({
  path,
  label,
  seeds: { canvas: "#1a1b26" },
  backdrop: null,
});
const index = (themes: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: "omp-ui-theme-index", version: 1, themes, ...extra });

describe("parseThemeRepositoryRef", () => {
  it.each([
    ["Owner/Repo", "owner/repo"],
    ["  owner/repo  ", "owner/repo"],
    ["https://github.com/O/R", "o/r"],
    ["https://github.com/o/r.git", "o/r"],
    ["https://github.com/o/r/", "o/r"],
    ["https://GitHub.com/LankfordAI/omp-ui", "lankfordai/omp-ui"],
  ])("canonicalizes %s", (input, expected) => {
    expect(parseThemeRepositoryRef(input)).toBe(expected);
  });

  it.each([
    "http://github.com/o/r",
    "https://evil.com/o/r",
    "https://user@github.com/o/r",
    "https://github.com:8443/o/r",
    "https://github.com/o/r?tab=x",
    "https://github.com/o/r#x",
    "o/r/extra",
    "o/..",
    "o/.",
    "-o/r",
    "o-/r",
    "o/r.git",
    "",
    "just-a-name",
  ])("refuses %s", (input) => {
    expect(parseThemeRepositoryRef(input)).toBeNull();
  });
});

describe("parseThemeIndex", () => {
  it("returns entries with labels trimmed", () => {
    const result = parseThemeIndex(
      index([
        { ...entry("themes/dusk.json"), label: "  Dusk  ", backdrop: "scene" },
        { ...entry("dawn.json", "Dawn"), seeds: { canvas: "#ffffff", accents: { signal: "#066544" } } },
      ]),
    );
    expect(result).toEqual({
      ok: true,
      entries: [
        { path: "themes/dusk.json", label: "Dusk", seeds: { canvas: "#1a1b26" }, backdrop: "scene" },
        { path: "dawn.json", label: "Dawn", seeds: { canvas: "#ffffff", accents: { signal: "#066544" } }, backdrop: null },
      ],
    });
  });

  it("names a newer format version", () => {
    expect(parseThemeIndex(JSON.stringify({ format: "omp-ui-theme-index", version: 2, themes: [] }))).toEqual({
      ok: false,
      message: "this theme repository needs a newer omp-ui",
    });
  });

  it("refuses another format, malformed JSON, and unknown top-level keys", () => {
    expect(parseThemeIndex(JSON.stringify({ format: "omp-ui-theme", version: 1, themes: [] }))).toEqual({
      ok: false,
      message: "this is not an omp-ui theme index",
    });
    expect(parseThemeIndex("{")).toMatchObject({ ok: false, message: "the theme index is malformed" });
    expect(parseThemeIndex(index([], { extra: true }))).toMatchObject({ ok: false, message: "the theme index is malformed" });
  });

  it.each([
    ["a duplicate path", [entry("a.json"), entry("a.json", "Other")]],
    ["a parent segment", [entry("../x.json")]],
    ["an absolute path", [entry("/abs.json")]],
    ["an empty segment", [entry("a//b.json")]],
    ["a hidden segment", [entry(".hidden/x.json")]],
    ["a non-json file", [entry("x.svg")]],
    ["an 81-character label", [entry("a.json", "x".repeat(81))]],
    ["a blank label", [entry("a.json", "   ")]],
    ["an unknown entry key", [{ ...entry("a.json"), extra: 1 }]],
    ["an unknown backdrop kind", [{ ...entry("a.json"), backdrop: "video" }]],
    ["invalid seeds", [{ ...entry("a.json"), seeds: { canvas: "red" } }]],
  ])("refuses %s, naming the entry", (_name, themes) => {
    expect(parseThemeIndex(index(themes))).toMatchObject({ ok: false, message: expect.stringMatching(/^theme index entry \d+ is invalid$/) });
  });

  it("accepts the entry cap and refuses one more", () => {
    const at = Array.from({ length: THEME_INDEX_ENTRIES_MAX }, (_, i) => entry(`t${i}.json`));
    expect(parseThemeIndex(index(at)).ok).toBe(true);
    expect(parseThemeIndex(index([...at, entry("over.json")])).ok).toBe(false);
  });
});

describe("parseThemeRepositories", () => {
  it("keeps canonical ids once, in order, capped", () => {
    const ids = Array.from({ length: THEME_REPOSITORIES_MAX + 2 }, (_, i) => `o/r${i}`);
    const parsed = parseThemeRepositories(["o/r0", "Bad/Case", 7, "o/r0", ...ids]);
    expect(parsed).toHaveLength(THEME_REPOSITORIES_MAX);
    expect(parsed.slice(0, 2)).toEqual(["o/r0", "o/r1"]);
    expect(parseThemeRepositories("o/r")).toEqual([]);
  });
});

describe("sameThemeSeeds", () => {
  it("ignores hex case and key order but not a changed colour", () => {
    const a = { canvas: "#1A1B26", accents: { signal: "#9ECE6A", rose: "#f7768e" } };
    const b = { accents: { rose: "#F7768E", signal: "#9ece6a" }, canvas: "#1a1b26" };
    expect(sameThemeSeeds(a, b)).toBe(true);
    expect(sameThemeSeeds(a, { ...b, canvas: "#1a1b27" })).toBe(false);
    expect(sameThemeSeeds({ canvas: "#000000" }, { canvas: "#000000", ink: "#ffffff" })).toBe(false);
  });
});
