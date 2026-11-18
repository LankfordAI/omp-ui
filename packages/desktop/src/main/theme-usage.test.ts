import { describe, expect, it } from "vitest";
import { DEFAULT_LIGHT_THEME_ID, DEFAULT_THEME_ID, type ThemePreference } from "@omp-ui/core/theme";
import { sourceFromDraft } from "@omp-ui/core/theme-file";
import { OFFICIAL_THEME_REPOSITORY } from "@omp-ui/core/theme-origin";
import { THEME_SLUG_CHARS_MAX } from "@omp-ui/core/theme-repository-format";
import { CURATED_THEME_SOURCES } from "@omp-ui/core/theme-sources";
import { isThemeUsageKey, readThemeUsageSample } from "./theme-usage";

const local = sourceFromDraft("custom-local", "Private label", { canvas: "#1a1b26" });
const origin = {
  repository: OFFICIAL_THEME_REPOSITORY,
  path: "themes/sakura-fuji-dark.json",
  commit: "1".repeat(40),
  blob: "2".repeat(40),
  animate: false,
};
const fixed: ThemePreference = {
  themeMode: "fixed",
  themeId: local.id,
  darkThemeId: DEFAULT_THEME_ID,
  lightThemeId: DEFAULT_LIGHT_THEME_ID,
};
const system: ThemePreference = { ...fixed, themeMode: "system" };
const graphite = { themeKey: `builtin/${DEFAULT_THEME_ID}`, isDefault: true };
const light = { themeKey: `builtin/${DEFAULT_LIGHT_THEME_ID}`, isDefault: true };
const custom = { themeKey: "custom/other", isDefault: false };
const malformedSlugs = [
  "nested/dusk",
  "dusk.details",
  "Dusk",
  "dusk--night",
  "-dusk",
  "dusk-",
  "dusk_name",
  "a".repeat(THEME_SLUG_CHARS_MAX + 1),
];

describe("readThemeUsageSample", () => {
  it("reads only the active fixed or Follow System pick", () => {
    expect(readThemeUsageSample(fixed, [local], true)).toEqual(custom);
    expect(readThemeUsageSample(fixed, [local], false)).toEqual(custom);
    expect(readThemeUsageSample(system, [local], true)).toEqual(graphite);
    expect(readThemeUsageSample(system, [local], false)).toEqual(light);
    expect(readThemeUsageSample({ ...system, darkThemeId: local.id }, [local], true)).toEqual(custom);
  });

  it("resolves curated ids before stored rows and measures defaults against the active slot", () => {
    const collision = { ...local, id: DEFAULT_THEME_ID, origin };
    expect(readThemeUsageSample({ ...fixed, themeId: DEFAULT_THEME_ID }, [collision], false)).toEqual(graphite);
    expect(readThemeUsageSample({ ...fixed, themeId: DEFAULT_LIGHT_THEME_ID }, [], false)).toEqual({
      ...light,
      isDefault: false,
    });
    expect(readThemeUsageSample({ ...system, darkThemeId: DEFAULT_LIGHT_THEME_ID }, [], true)).toEqual({
      ...light,
      isDefault: false,
    });
    expect(readThemeUsageSample({ ...system, lightThemeId: DEFAULT_THEME_ID }, [], false)).toEqual({
      ...graphite,
      isDefault: false,
    });
  });

  it("falls back to stock Graphite for unresolved picks, including the light slot", () => {
    expect(readThemeUsageSample({ ...system, lightThemeId: "missing" }, [local], false)).toEqual(graphite);
    expect(readThemeUsageSample({ ...fixed, themeId: local.id.toUpperCase() }, [local], true)).toEqual(graphite);
    expect(readThemeUsageSample(fixed, [{ ...local, label: "" }], true)).toEqual(graphite);
    expect(readThemeUsageSample(fixed, [{ ...local, origin: { ...origin, path: "themes/.json" } }], true)).toEqual(
      graphite,
    );
    expect(readThemeUsageSample(fixed, [{ ...local, label: "" }, local], true)).toEqual(custom);
    expect(readThemeUsageSample({ ...fixed, themeId: ` ${DEFAULT_THEME_ID}` }, [], true)).toEqual(graphite);
  });

  it.each(["sakura-fuji-dark", "sakura-fuji-light"])("uses the official public path for %s", (slug) => {
    const source = { ...local, origin: { ...origin, path: `themes/${slug}.json` } };
    const updated = {
      ...sourceFromDraft("custom-reinstall", "New label", { canvas: "#eeeeee" }),
      origin: { ...source.origin, commit: "3".repeat(40), blob: "4".repeat(40), animate: true },
    };
    const expected = { themeKey: `official/${slug}`, isDefault: false };
    expect(readThemeUsageSample(fixed, [source], true)).toEqual(expected);
    expect(readThemeUsageSample({ ...fixed, themeId: updated.id }, [updated], false)).toEqual(expected);
  });

  it.each([
    ...malformedSlugs.map((slug) => `themes/${slug}.json`),
    "sakura-fuji-dark.json",
    "Themes/sakura-fuji-dark.json",
  ])("keeps valid stored rows with non-publisher paths generic (%s)", (path) => {
    expect(readThemeUsageSample(fixed, [{ ...local, origin: { ...origin, path } }], true)).toEqual(custom);
  });

  it("keeps local, imported, detached, and third-party rows generic", () => {
    const { origin: _origin, ...detached } = { ...local, id: "custom-detached", origin };
    for (const source of [
      local,
      sourceFromDraft("vscode-import", "Sakura Fuji Dark", { canvas: "#1a1b26" }),
      detached,
      { ...local, origin: { ...origin, repository: "someone/omp-ui-themes" } },
    ]) {
      expect(readThemeUsageSample({ ...fixed, themeId: source.id }, [source], true)).toEqual(custom);
    }
  });
});

describe("isThemeUsageKey", () => {
  it("accepts exact curated and generic keys and publisher slugs without a catalog", () => {
    for (const { id } of CURATED_THEME_SOURCES) expect(isThemeUsageKey(`builtin/${id}`)).toBe(true);
    expect(isThemeUsageKey("custom/other")).toBe(true);
    expect(isThemeUsageKey("official/new-release-2")).toBe(true);
    expect(isThemeUsageKey(`official/${"a".repeat(THEME_SLUG_CHARS_MAX)}`)).toBe(true);
  });

  it.each([
    ...malformedSlugs.map((slug) => `official/${slug}`),
    "official/",
    "official/dusk.json",
    "official/dusk\n",
    "official/dusk ",
    "Official/dusk",
    "builtin/unknown",
    `builtin/${DEFAULT_THEME_ID.toUpperCase()}`,
    "custom/local",
    null,
    42,
    {},
  ])("rejects %j", (key) => {
    expect(isThemeUsageKey(key)).toBe(false);
  });
});
