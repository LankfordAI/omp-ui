import {
  DEFAULT_LIGHT_THEME_ID,
  DEFAULT_THEME_ID,
  effectiveThemeId,
  isStoredTheme,
  type ThemePreference,
  type ThemeSource,
} from "@omp-ui/core/theme";
import { OFFICIAL_THEME_REPOSITORY } from "@omp-ui/core/theme-origin";
import { THEME_SLUG, THEME_SLUG_CHARS_MAX } from "@omp-ui/core/theme-repository-format";
import { CURATED_THEME_SOURCES } from "@omp-ui/core/theme-sources";

export interface ThemeUsageSample {
  themeKey: string;
  isDefault: boolean;
}

const builtinPrefix = "builtin/";
const curatedKeysById = new Map(CURATED_THEME_SOURCES.map(({ id }) => [id, `${builtinPrefix}${id}`] as const));
const fallbackKey = `${builtinPrefix}${DEFAULT_THEME_ID}`;
const customKey = "custom/other";
const officialPrefix = "official/";
const themePathPrefix = "themes/";
const themePathSuffix = ".json";

export function isThemeUsageKey(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (value === customKey) return true;
  if (value.startsWith(builtinPrefix)) return curatedKeysById.has(value.slice(builtinPrefix.length));
  if (!value.startsWith(officialPrefix)) return false;
  const slug = value.slice(officialPrefix.length);
  return slug.length <= THEME_SLUG_CHARS_MAX && THEME_SLUG.test(slug);
}

/** Sample the painted theme, using only public identities for curated and official themes. */
export function readThemeUsageSample(
  preference: ThemePreference,
  stored: readonly ThemeSource[],
  prefersDark: boolean,
): ThemeUsageSample {
  const id = effectiveThemeId(preference, prefersDark);
  const builtinKey = curatedKeysById.get(id);
  if (builtinKey !== undefined) {
    const stockId = preference.themeMode === "system" && !prefersDark ? DEFAULT_LIGHT_THEME_ID : DEFAULT_THEME_ID;
    return { themeKey: builtinKey, isDefault: id === stockId };
  }

  const source = stored.find((entry) => entry?.id === id && isStoredTheme(entry));
  if (source === undefined) return { themeKey: fallbackKey, isDefault: true };

  const origin = source.origin;
  if (
    origin?.repository === OFFICIAL_THEME_REPOSITORY &&
    origin.path.startsWith(themePathPrefix) &&
    origin.path.endsWith(themePathSuffix)
  ) {
    const themeKey = `${officialPrefix}${origin.path.slice(themePathPrefix.length, -themePathSuffix.length)}`;
    if (isThemeUsageKey(themeKey)) return { themeKey, isDefault: false };
  }
  return { themeKey: customKey, isDefault: false };
}
