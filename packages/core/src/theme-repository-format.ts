// Theme repositories (#1178, ADR-0096): the repository reference, the theme
// index a repository publishes, and the shapes Browse and Install carry. Pure —
// the renderer validates input and previews listings with it.
import { isObject } from "./guards";
import type { ThemeBackdropKind, ThemeBackdropMime } from "./theme-backdrop";
import { GIT_SHA, THEME_REPOSITORY_ID, isRepositoryThemePath } from "./theme-origin";
import { isThemeSeeds, type ThemeSeeds } from "./theme-seeds";
import { stripJsonc } from "./vscode-theme";

export const THEME_REPOSITORIES_MAX = 16;
export const THEME_INDEX_FILE = "omp-ui-themes.json";
export const THEME_INDEX_FORMAT = "omp-ui-theme-index";
export const THEME_INDEX_VERSION = 1;
export const THEME_INDEX_BYTES_MAX = 64 * 1024;
export const THEME_INDEX_ENTRIES_MAX = 48;
const LABEL_MAX = 80;
const GITHUB_URL = /^https:\/\/github\.com\/([^/?#\s]+)\/([^/?#\s]+?)(?:\.git)?\/?$/i;
const SHORT_REF = /^([^/\s]+)\/([^/\s]+)$/;
const INDEX_KEYS = ["format", "version", "themes"];
const ENTRY_KEYS = ["path", "label", "seeds", "backdrop"];
const INSTALL_KEYS = ["repository", "commit", "path"];

const hasExactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
};

/** "owner/repo" or https://github.com/owner/repo[.git][/] → canonical lowercase "owner/repo"; null otherwise. */
export function parseThemeRepositoryRef(input: string): string | null {
  const text = input.trim();
  const match = GITHUB_URL.exec(text) ?? SHORT_REF.exec(text);
  if (match === null) return null;
  const id = `${match[1]!.toLowerCase()}/${match[2]!.toLowerCase()}`;
  return THEME_REPOSITORY_ID.test(id) ? id : null;
}

/** Registry read: canonical ids only, first occurrence wins, capped. */
export function parseThemeRepositories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !THEME_REPOSITORY_ID.test(item) || out.includes(item)) continue;
    out.push(item);
    if (out.length === THEME_REPOSITORIES_MAX) break;
  }
  return out;
}

export interface ThemeIndexEntry {
  path: string;
  /** Trimmed. */
  label: string;
  seeds: ThemeSeeds;
  backdrop: ThemeBackdropKind | null;
}

export interface ThemeRepositoryEntry extends ThemeIndexEntry {
  /** Git blob SHA-1 at the listing's commit. */
  blob: string;
  /** Bytes, from the git tree. */
  size: number;
}

export interface ThemeRepositoryListing {
  repository: string;
  commit: string;
  themes: ThemeRepositoryEntry[];
  /** Index entries dropped because the tree lacks the path or the file exceeds THEME_FILE_BYTES_MAX. */
  skipped: number;
}

export type ThemeRepositoryListingResult =
  | { ok: true; listing: ThemeRepositoryListing }
  | { ok: false; message: string };

export type ThemeRepositoryAddResult = { ok: true; repository: string } | { ok: false; message: string };

export interface RepositoryThemeInstallRequest {
  repository: string;
  commit: string;
  path: string;
}

/** One repository theme's backdrop, verified host-side for Preview (#1182). Nothing is stored. */
export interface RepositoryThemeBackdrop {
  mime: ThemeBackdropMime;
  /** base64, as every other binary here travels. */
  data: string;
  dim: number;
  blur: number;
}

export type RepositoryThemeBackdropResult =
  | { ok: true; backdrop: RepositoryThemeBackdrop }
  | { ok: false; message: string };

const MALFORMED = { ok: false, message: "the theme index is malformed" } as const;

export function parseThemeIndex(
  text: string,
): { ok: true; entries: ThemeIndexEntry[] } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return MALFORMED;
  }
  if (!isObject(parsed) || Array.isArray(parsed)) return MALFORMED;
  if (parsed.format !== THEME_INDEX_FORMAT) return { ok: false, message: "this is not an omp-ui theme index" };
  if (typeof parsed.version === "number" && parsed.version > THEME_INDEX_VERSION) {
    return { ok: false, message: "this theme repository needs a newer omp-ui" };
  }
  if (parsed.version !== THEME_INDEX_VERSION) return MALFORMED;
  if (!hasExactKeys(parsed, INDEX_KEYS)) return MALFORMED;
  const themes = parsed.themes;
  if (!Array.isArray(themes) || themes.length > THEME_INDEX_ENTRIES_MAX) return MALFORMED;

  const entries: ThemeIndexEntry[] = [];
  const paths = new Set<string>();
  for (const [i, entry] of themes.entries()) {
    const invalid = { ok: false, message: `theme index entry ${i + 1} is invalid` } as const;
    if (!isObject(entry) || Array.isArray(entry) || !hasExactKeys(entry, ENTRY_KEYS)) return invalid;
    const { path, label, seeds, backdrop } = entry;
    if (!isRepositoryThemePath(path) || paths.has(path)) return invalid;
    if (typeof label !== "string") return invalid;
    const trimmed = label.trim();
    if (trimmed.length < 1 || trimmed.length > LABEL_MAX) return invalid;
    if (!isThemeSeeds(seeds)) return invalid;
    if (backdrop !== "image" && backdrop !== "scene" && backdrop !== null) return invalid;
    paths.add(path);
    entries.push({ path, label: trimmed, seeds, backdrop });
  }
  return { ok: true, entries };
}

export function isRepositoryThemeInstallRequest(value: unknown): value is RepositoryThemeInstallRequest {
  if (!isObject(value) || Array.isArray(value) || !hasExactKeys(value, INSTALL_KEYS)) return false;
  return (
    typeof value.repository === "string" &&
    THEME_REPOSITORY_ID.test(value.repository) &&
    typeof value.commit === "string" &&
    GIT_SHA.test(value.commit) &&
    isRepositoryThemePath(value.path)
  );
}

/** Lowercased colours with sorted keys; an empty accents/syntax map reads as absent. */
function canonicalSeeds(seeds: ThemeSeeds): string {
  const colours = (map: Partial<Record<string, string>> | undefined): Array<[string, string]> | null => {
    if (map === undefined) return null;
    const entries = Object.entries(map)
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([key, colour]): [string, string] => [key, colour.toLowerCase()])
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return entries.length === 0 ? null : entries;
  };
  return JSON.stringify([
    seeds.canvas.toLowerCase(),
    seeds.ink?.toLowerCase() ?? null,
    colours(seeds.accents),
    colours(seeds.syntax),
  ]);
}

/** Equal after lowercasing every hex and ignoring key order; absent ink/accents/syntax keys equal absent. */
export function sameThemeSeeds(a: ThemeSeeds, b: ThemeSeeds): boolean {
  return canonicalSeeds(a) === canonicalSeeds(b);
}
