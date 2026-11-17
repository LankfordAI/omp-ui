import { describe, expect, it } from "vitest";
import { buildThemeIndexes, checkThemeRepository, type ThemeRepositoryReport } from "./theme-repository-tool";
import { parseThemeIndex, parseThemeIndexV2, themeDetailsFile } from "./theme-repository-format";

const encode = (text: string): Uint8Array => new TextEncoder().encode(text);
const SCENE = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="1" height="1"/></svg>';
const sceneData = Buffer.from(SCENE).toString("base64");

const themeText = (label: string, canvas: string, backdrop?: Record<string, unknown>): string =>
  JSON.stringify({ format: "omp-ui-theme", version: 1, label, seeds: { canvas }, ...(backdrop ? { backdrop } : {}) });
const detailsText = (tags: string[] = ["cool"]): string =>
  themeDetailsFile({ tags, description: "A theme.", author: "LankfordAI" });
const TAGS = JSON.stringify({
  format: "omp-ui-theme-tags",
  version: 1,
  tags: [
    { id: "cool", description: "Blues lead." },
    { id: "warm", description: "Reds lead." },
  ],
});

/** A valid repository with two themes; `patch` adds, replaces, or (null) removes files. */
function repo(patch: Record<string, string | Uint8Array | null> = {}): Map<string, Uint8Array> {
  const base: Record<string, string | Uint8Array | null> = {
    "README.md": "# themes",
    "tags.json": TAGS,
    "featured.json": JSON.stringify({ format: "omp-ui-theme-featured", version: 1, paths: ["themes/dusk.json"] }),
    ".github/workflows/check.yml": "on: pull_request",
    "themes/dusk.json": themeText("Dusk", "#1a1b26", { mime: "image/svg+xml", data: sceneData, blur: 12 }),
    "themes/dusk.details.json": detailsText(),
    "themes/night.json": themeText("Night", "#101010"),
    "themes/night.details.json": detailsText(["warm"]),
    ...patch,
  };
  const files = new Map<string, Uint8Array>();
  for (const [path, value] of Object.entries(base)) {
    if (value !== null) files.set(path, typeof value === "string" ? encode(value) : value);
  }
  return files;
}

describe("checkThemeRepository", () => {
  it("reports no errors for a valid repository", () => {
    const report = checkThemeRepository(repo());
    expect(report.errors).toEqual([]);
    expect(report.themes.map((t) => [t.path, t.backdrop])).toEqual([
      ["themes/dusk.json", "scene"],
      ["themes/night.json", null],
    ]);
    expect(report.featured).toEqual(["themes/dusk.json"]);
  });

  const png = (size: number): Uint8Array => {
    const bytes = new Uint8Array(size);
    bytes.set([0x89, 0x50, 0x4e, 0x47]);
    return bytes;
  };

  it.each<[string, Record<string, string | Uint8Array | null>, RegExp]>([
    ["a stray file", { "screenshot.png": "x" }, /^screenshot\.png: not allowed/],
    ["a file in a subdirectory of themes/", { "themes/extra/a.json": "{}" }, /^themes\/extra\/a\.json: not allowed/],
    ["an invalid slug", { "themes/Big_Name.json": "{}" }, /^themes\/Big_Name\.json: the file name/],
    ["a theme without details", { "themes/night.details.json": null }, /^themes\/night\.json: has no details file/],
    [
      "a theme file with a comment",
      { "themes/night.json": `// mine\n${themeText("Night", "#101010")}` },
      /^themes\/night\.json: must be plain JSON/,
    ],
    ["a tag outside the vocabulary", { "themes/night.details.json": detailsText(["space"]) }, /the tag "space" is not in tags\.json/],
    [
      "a non-green signal",
      {
        "themes/night.json": JSON.stringify({
          format: "omp-ui-theme",
          version: 1,
          label: "Night",
          seeds: { canvas: "#101010", accents: { signal: "#ff4060" } },
        }),
      },
      /agent activity colour #ff4060 is not a green \(hue \d+°/,
    ],
    [
      "a declared mime that differs from the bytes",
      { "themes/dusk.json": themeText("Dusk", "#1a1b26", { mime: "image/png", data: sceneData, blur: 12 }) },
      /the backdrop says it is image\/png but its bytes are image\/svg\+xml/,
    ],
    ["a duplicate label", { "themes/night.json": themeText("dusk", "#101010") }, /the label "dusk" is already used by themes\/dusk\.json/],
    [
      "a duplicate theme",
      { "themes/copy.json": themeText("Copy", "#101010"), "themes/copy.details.json": detailsText() },
      /^themes\/night\.json: is a copy of themes\/copy\.json/,
    ],
    [
      "an oversized image",
      {
        "themes/night.json": themeText("Night", "#101010", {
          mime: "image/png",
          data: Buffer.from(png(1024 * 1024 + 1)).toString("base64"),
          blur: 0,
        }),
      },
      /image backdrops can be at most 1 MiB/,
    ],
    [
      "a featured path that does not exist",
      { "featured.json": JSON.stringify({ format: "omp-ui-theme-featured", version: 1, paths: ["themes/gone.json"] }) },
      /^featured\.json: "themes\/gone\.json" is not a theme file/,
    ],
  ])("names %s", (_name, patch, message) => {
    const { errors } = checkThemeRepository(repo(patch));
    expect(errors).toContainEqual(expect.stringMatching(message));
  });
});

describe("buildThemeIndexes", () => {
  it("writes indexes each released parser accepts, featured first", () => {
    const built = buildThemeIndexes(checkThemeRepository(repo()), null, "2026-11-17");
    if (!built.ok) throw new Error(built.message);
    const v1 = parseThemeIndex(built.v1);
    const v2 = parseThemeIndexV2(built.v2);
    expect(v1.ok && v1.entries.map((e) => e.path)).toEqual(["themes/dusk.json", "themes/night.json"]);
    expect(v2.ok && v2.entries.map((e) => [e.path, e.meta.featured, e.meta.tags])).toEqual([
      ["themes/dusk.json", true, ["cool"]],
      ["themes/night.json", false, ["warm"]],
    ]);
  });

  it("keeps a previous added date and dates a new theme today", () => {
    const first = buildThemeIndexes(checkThemeRepository(repo({ "featured.json": null })), null, "2026-01-01");
    if (!first.ok) throw new Error(first.message);
    const grown = repo({
      "featured.json": null,
      "themes/aurora.json": themeText("Aurora", "#0b1020"),
      "themes/aurora.details.json": detailsText(),
    });
    const second = buildThemeIndexes(checkThemeRepository(grown), first.v2, "2026-11-17");
    if (!second.ok) throw new Error(second.message);
    const v2 = parseThemeIndexV2(second.v2);
    // Oldest first, then path: aurora is newest though it sorts first by path.
    expect(v2.ok && v2.entries.map((e) => [e.path, e.meta.added])).toEqual([
      ["themes/dusk.json", "2026-01-01"],
      ["themes/night.json", "2026-01-01"],
      ["themes/aurora.json", "2026-11-17"],
    ]);
  });

  it("caps v1 at 48 entries while v2 holds every theme", () => {
    const themes = Array.from({ length: 60 }, (_, i) => ({
      path: `themes/t${String(i).padStart(2, "0")}.json`,
      label: `T${i}`,
      seeds: { canvas: "#101010" },
      backdrop: null,
      details: { tags: ["cool"], description: "A theme.", author: null },
    }));
    const report: ThemeRepositoryReport = { errors: [], themes, featured: [] };
    const built = buildThemeIndexes(report, null, "2026-11-17");
    if (!built.ok) throw new Error(built.message);
    const v1 = parseThemeIndex(built.v1);
    const v2 = parseThemeIndexV2(built.v2);
    expect(v1.ok && v1.entries).toHaveLength(48);
    expect(v2.ok && v2.entries).toHaveLength(60);
  });

  it("refuses a report with errors", () => {
    expect(buildThemeIndexes({ errors: ["x: bad"], themes: [], featured: [] }, null, "2026-11-17").ok).toBe(false);
  });
});
