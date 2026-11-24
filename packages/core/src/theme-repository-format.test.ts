import { describe, expect, it } from "vitest";
import {
  EMPTY_THEME_META,
  OFFICIAL_THEME_TAGS,
  THEME_INDEX_ENTRIES_MAX,
  THEME_REPOSITORIES_MAX,
  effectiveThemeRepositories,
  isThemeTag,
  parseThemeDetails,
  parseThemeIndex,
  parseThemeIndexV2,
  parseThemeIndexV3,
  parseThemeRepositories,
  parseThemeRepositoryRef,
  sameThemeSeeds,
  themeDetailsFile,
  themeSlug,
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
        { path: "themes/dusk.json", label: "Dusk", seeds: { canvas: "#1a1b26" }, backdrop: "scene", meta: EMPTY_THEME_META },
        {
          path: "dawn.json",
          label: "Dawn",
          seeds: { canvas: "#ffffff", accents: { signal: "#066544" } },
          backdrop: null,
          meta: EMPTY_THEME_META,
        },
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

const indexV2 = (themes: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: "omp-ui-theme-index", version: 2, themes, ...extra });

describe("parseThemeIndexV2", () => {
  it("ignores unknown root and entry keys and reads the details", () => {
    const result = parseThemeIndexV2(
      indexV2(
        [
          {
            ...entry("themes/dusk.json"),
            tags: ["cool", "abstract"],
            author: "LankfordAI",
            description: "  Night  ",
            added: "2026-11-17",
            featured: true,
            rating: 5,
          },
        ],
        { generator: "tool" },
      ),
    );
    expect(result).toEqual({
      ok: true,
      entries: [
        {
          path: "themes/dusk.json",
          label: "Dusk",
          seeds: { canvas: "#1a1b26" },
          backdrop: null,
          meta: { tags: ["cool", "abstract"], author: "LankfordAI", description: "Night", added: "2026-11-17", featured: true },
        },
      ],
    });
  });

  it("keeps an entry whose optional fields are invalid, with their defaults", () => {
    const result = parseThemeIndexV2(
      indexV2([{ ...entry("a.json"), tags: "cool", author: "-bad-", description: "", added: "17/11/2026", featured: "yes" }]),
    );
    expect(result.ok && result.entries[0]!.meta).toEqual(EMPTY_THEME_META);
  });

  it("drops a duplicate and a seventh tag", () => {
    const result = parseThemeIndexV2(
      indexV2([{ ...entry("a.json"), tags: ["a", "b", "a", "c", "d", "e", "f", "g", "Bad Tag"] }]),
    );
    expect(result.ok && result.entries[0]!.meta.tags).toEqual(["a", "b", "c", "d", "e", "f"]);
  });

  it("fails an entry whose required field is invalid (including video backdrop)", () => {
    expect(parseThemeIndexV2(indexV2([{ ...entry("a.json"), seeds: { canvas: "red" } }]))).toEqual({
      ok: false,
      message: "theme index entry 1 is invalid",
    });
    expect(parseThemeIndexV2(indexV2([{ ...entry("a.json"), backdrop: "video" }]))).toEqual({
      ok: false,
      message: "theme index entry 1 is invalid",
    });
  });

  it("names a newer version and refuses version 1", () => {
    expect(parseThemeIndexV2(JSON.stringify({ format: "omp-ui-theme-index", version: 3, themes: [] }))).toEqual({
      ok: false,
      message: "this theme repository needs a newer omp-ui",
    });
    expect(parseThemeIndexV2(index([]))).toEqual({ ok: false, message: "the theme index is malformed" });
  });
});

const indexV3 = (themes: unknown[], extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: "omp-ui-theme-index", version: 3, themes, ...extra });

describe("parseThemeIndexV3", () => {
  it("accepts image, scene, video and null backdrops with details and ignores unknown keys", () => {
    const result = parseThemeIndexV3(
      indexV3(
        [
          { ...entry("themes/dusk.json"), backdrop: "video", tags: ["animated"], author: "LankfordAI", description: "Loop", added: "2026-11-24", featured: true, extra: 1 },
          { ...entry("themes/still.json"), backdrop: "image" },
          { ...entry("themes/scene.json"), backdrop: "scene" },
          { ...entry("themes/plain.json"), backdrop: null },
        ],
        { generator: "tool" },
      ),
    );
    expect(result.ok && result.entries.map((e) => [e.path, e.backdrop])).toEqual([
      ["themes/dusk.json", "video"],
      ["themes/still.json", "image"],
      ["themes/scene.json", "scene"],
      ["themes/plain.json", null],
    ]);
    expect(result.ok && result.entries[0]!.meta).toEqual({
      tags: ["animated"],
      author: "LankfordAI",
      description: "Loop",
      added: "2026-11-24",
      featured: true,
    });
  });

  it("rejects unknown backdrop kinds, older versions, and names a newer version", () => {
    expect(parseThemeIndexV3(indexV3([{ ...entry("a.json"), backdrop: "audio" }]))).toEqual({
      ok: false,
      message: "theme index entry 1 is invalid",
    });
    expect(parseThemeIndexV3(JSON.stringify({ format: "omp-ui-theme-index", version: 4, themes: [] }))).toEqual({
      ok: false,
      message: "this theme repository needs a newer omp-ui",
    });
    expect(parseThemeIndexV3(indexV2([]))).toEqual({ ok: false, message: "the theme index is malformed" });
    expect(parseThemeIndexV3(index([]))).toEqual({ ok: false, message: "the theme index is malformed" });
  });
});

const details = (patch: Record<string, unknown> = {}): string =>
  JSON.stringify({ format: "omp-ui-theme-details", version: 1, tags: ["cool"], description: "Night", ...patch });

describe("parseThemeDetails", () => {
  it("accepts a file with and without an author", () => {
    expect(parseThemeDetails(details())).toEqual({ ok: true, details: { tags: ["cool"], description: "Night", author: null } });
    expect(parseThemeDetails(details({ author: "someone" }))).toMatchObject({ ok: true, details: { author: "someone" } });
  });

  it.each([
    ["zero tags", details({ tags: [] })],
    ["a tag failing the slug", details({ tags: ["Cool"] })],
    ["a duplicate tag", details({ tags: ["cool", "cool"] })],
    ["an empty description", details({ description: "   " })],
    ["an unknown key", details({ extra: 1 })],
    ["an invalid author", details({ author: "a b" })],
    ["a comment", `// hi\n${details()}`],
  ])("refuses %s", (_name, text) => {
    expect(parseThemeDetails(text)).toEqual({ ok: false, message: "the theme details file is malformed" });
  });

  it("names another format and a newer version", () => {
    expect(parseThemeDetails(details({ format: "omp-ui-theme" }))).toMatchObject({
      message: "this is not an omp-ui theme details file",
    });
    expect(parseThemeDetails(details({ version: 2 }))).toMatchObject({ message: "this theme details file needs a newer omp-ui" });
  });

  it("round-trips themeDetailsFile output", () => {
    for (const value of [
      { tags: ["cool", "warm"], description: "Two", author: "LankfordAI" },
      { tags: ["cool"], description: "One", author: null },
    ]) {
      expect(parseThemeDetails(themeDetailsFile(value))).toEqual({ ok: true, details: value });
    }
  });
});

describe("themeSlug", () => {
  it("turns a label into a file slug", () => {
    expect(themeSlug("Sakura Fuji (dark)")).toBe("sakura-fuji-dark");
    expect(themeSlug("桜")).toBe("");
    expect(themeSlug(`${"a".repeat(63)} b`)).toBe("a".repeat(63));
  });
});

describe("OFFICIAL_THEME_TAGS", () => {
  it("holds valid, unique tags within the repository's vocabulary cap", () => {
    expect(OFFICIAL_THEME_TAGS.every(isThemeTag)).toBe(true);
    expect(new Set(OFFICIAL_THEME_TAGS).size).toBe(OFFICIAL_THEME_TAGS.length);
    expect(OFFICIAL_THEME_TAGS.length).toBeLessThanOrEqual(40);
  });
});

describe("effectiveThemeRepositories", () => {
  it("puts the official repository first while enabled, once, and omits it while off", () => {
    expect(effectiveThemeRepositories(["o/r"], true)).toEqual(["lankfordai/omp-ui-themes", "o/r"]);
    expect(effectiveThemeRepositories(["o/r", "lankfordai/omp-ui-themes"], true)).toEqual(["o/r", "lankfordai/omp-ui-themes"]);
    expect(effectiveThemeRepositories(["o/r"], false)).toEqual(["o/r"]);
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
