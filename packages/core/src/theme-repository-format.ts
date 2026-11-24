// Theme repositories (#1178, ADR-0096): the repository reference, the theme
// index a repository publishes, and the shapes Browse and Install carry. Pure —
// the renderer validates input and previews listings with it.
import { isObject } from "./guards";
import { BACKDROP_VIDEO_BYTES_MAX, type ThemeBackdropKind, type ThemeBackdropMime } from "./theme-backdrop";
import { GIT_SHA, OFFICIAL_THEME_REPOSITORY, THEME_REPOSITORY_ID, isRepositoryThemePath } from "./theme-origin";
import { isThemeSeeds, type ThemeSeeds } from "./theme-seeds";
import { stripJsonc } from "./vscode-theme";

export const THEME_REPOSITORIES_MAX = 16;
export const THEME_INDEX_FILE = "omp-ui-themes.json";
export const THEME_INDEX_FORMAT = "omp-ui-theme-index";
export const THEME_INDEX_VERSION = 1;
export const THEME_INDEX_BYTES_MAX = 64 * 1024;
export const THEME_INDEX_ENTRIES_MAX = 48;
/** Index v2 (#1210): read when the repository tree has it (and no v3); lenient on unknown and optional fields. */
export const THEME_INDEX_V2_FILE = "omp-ui-themes.v2.json";
export const THEME_INDEX_V2_VERSION = 2;
export const THEME_INDEX_V2_BYTES_MAX = 512 * 1024;
export const THEME_INDEX_V2_ENTRIES_MAX = 500;
/** Index v3 (#1320): preferred when the repository tree has it; adds video backdrops alongside image and scene. */
export const THEME_INDEX_V3_FILE = "omp-ui-themes.v3.json";
export const THEME_INDEX_V3_VERSION = 3;
export const THEME_INDEX_V3_BYTES_MAX = 512 * 1024;
export const THEME_INDEX_V3_ENTRIES_MAX = 500;
export const THEME_TAGS_MAX = 6;
export const THEME_TAG_CHARS_MAX = 24;
export const THEME_DESCRIPTION_MAX = 160;
export const THEME_SLUG_CHARS_MAX = 64;
/** Theme backdrops accepted by GitHub theme repositories (image, SVG scene, and video in v3). */
export type RepositoryBackdropKind = ThemeBackdropKind;
export type RepositoryBackdropMime = ThemeBackdropMime;
/** Maximum theme file size in a GitHub theme repository (24 MiB; accommodates 16 MiB video backdrops as base64). */
export const REPOSITORY_THEME_FILE_BYTES_MAX = 24 * 1024 * 1024;
/** Image backdrops the official repository accepts; tighter than the app's 4 MiB. The tool and the Share panel both read it. */
export const REPOSITORY_IMAGE_BYTES_MAX = 1024 * 1024;
/** Video backdrops the official repository accepts (16 MiB decoded). The tool and the Share panel both read it. */
export const REPOSITORY_VIDEO_BYTES_MAX = BACKDROP_VIDEO_BYTES_MAX;
/**
 * The official theme repository's tag vocabulary (its tags.json), offered by the
 * Share panel (#1212). The repository's CI is authoritative; keep this in step.
 */
export const OFFICIAL_THEME_TAGS: readonly string[] = [
  "abstract",
  "animated",
  "city",
  "cool",
  "cozy",
  "high-contrast",
  "landscape",
  "minimal",
  "monochrome",
  "nature",
  "pastel",
  "pixel-art",
  "port",
  "retro",
  "seasonal",
  "space",
  "warm",
];
/** Lowercase words joined by single hyphens: tags and theme file slugs. */
export const THEME_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const THEME_DETAILS_FORMAT = "omp-ui-theme-details";
export const THEME_DETAILS_VERSION = 1;
const GITHUB_HANDLE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const DETAILS_KEYS = ["format", "version", "tags", "description"];
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

/** What a repository says about a theme beyond its colours (#1210). */
export interface ThemeMeta {
  /** Valid slugs, first occurrence wins, at most THEME_TAGS_MAX. */
  tags: string[];
  /** A GitHub handle, shown as a courtesy credit. */
  author: string | null;
  description: string | null;
  /** YYYY-MM-DD the repository first listed the theme. */
  added: string | null;
  featured: boolean;
}

export const EMPTY_THEME_META: ThemeMeta = Object.freeze({
  tags: Object.freeze([]) as unknown as string[],
  author: null,
  description: null,
  added: null,
  featured: false,
});

export function isThemeTag(value: unknown): value is string {
  return typeof value === "string" && value.length <= THEME_TAG_CHARS_MAX && THEME_SLUG.test(value);
}

export function isThemeAuthor(value: unknown): value is string {
  return typeof value === "string" && GITHUB_HANDLE.test(value);
}

/** Trimmed description of 1 to THEME_DESCRIPTION_MAX characters, else null. */
function parseDescription(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length >= 1 && trimmed.length <= THEME_DESCRIPTION_MAX ? trimmed : null;
}

/** Lenient: each field that is absent or invalid takes its EMPTY_THEME_META value. Never fails. */
export function parseThemeMeta(value: Record<string, unknown>): ThemeMeta {
  const tags: string[] = [];
  if (Array.isArray(value.tags)) {
    for (const tag of value.tags) {
      if (!isThemeTag(tag) || tags.includes(tag)) continue;
      tags.push(tag);
      if (tags.length === THEME_TAGS_MAX) break;
    }
  }
  return {
    tags,
    author: isThemeAuthor(value.author) ? value.author : null,
    description: parseDescription(value.description),
    added: typeof value.added === "string" && ISO_DATE.test(value.added) ? value.added : null,
    featured: value.featured === true,
  };
}

/** The repositories Browse and Install accept: the official one first while enabled, then the added ones. */
export function effectiveThemeRepositories(added: readonly string[], officialThemes: boolean): string[] {
  if (!officialThemes || added.includes(OFFICIAL_THEME_REPOSITORY)) return [...added];
  return [OFFICIAL_THEME_REPOSITORY, ...added];
}

export interface ThemeIndexEntry {
  path: string;
  /** Trimmed. */
  label: string;
  seeds: ThemeSeeds;
  backdrop: RepositoryBackdropKind | null;
  /** EMPTY_THEME_META for a v1 index. */
  meta: ThemeMeta;
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
  /** Index entries dropped because the tree lacks the path or the file exceeds REPOSITORY_THEME_FILE_BYTES_MAX. */
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
  mime: RepositoryBackdropMime;
  /** base64, as every other binary here travels. */
  data: string;
  blur: number;
}

export type RepositoryThemeBackdropResult =
  | { ok: true; backdrop: RepositoryThemeBackdrop }
  | { ok: false; message: string };

const MALFORMED = { ok: false, message: "the theme index is malformed" } as const;

/** JSON, format and version checks shared by both index versions. */
function parseIndexRoot(
  text: string,
  version: number,
): { ok: true; root: Record<string, unknown> } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return MALFORMED;
  }
  if (!isObject(parsed) || Array.isArray(parsed)) return MALFORMED;
  if (parsed.format !== THEME_INDEX_FORMAT) return { ok: false, message: "this is not an omp-ui theme index" };
  if (typeof parsed.version === "number" && parsed.version > version) {
    return { ok: false, message: "this theme repository needs a newer omp-ui" };
  }
  if (parsed.version !== version) return MALFORMED;
  return { ok: true, root: parsed };
}

/** The four required fields, checked identically by v1, v2 and v3; null when any is invalid or the path repeats. */
function requiredEntryFields(
  entry: Record<string, unknown>,
  paths: ReadonlySet<string>,
  allowVideo: boolean,
): Omit<ThemeIndexEntry, "meta"> | null {
  const { path, label, seeds, backdrop } = entry;
  if (!isRepositoryThemePath(path) || paths.has(path)) return null;
  if (typeof label !== "string") return null;
  const trimmed = label.trim();
  if (trimmed.length < 1 || trimmed.length > LABEL_MAX) return null;
  if (!isThemeSeeds(seeds)) return null;
  if (backdrop !== "image" && backdrop !== "scene" && backdrop !== null && !(allowVideo && backdrop === "video")) {
    return null;
  }
  return { path, label: trimmed, seeds, backdrop };
}

/** Strict (v1): exact entry keys and no meta. Lenient (v2/v3): unknown keys ignored, meta parsed. */
function parseEntries(
  themes: readonly unknown[],
  strict: boolean,
  allowVideo: boolean,
): { ok: true; entries: ThemeIndexEntry[] } | { ok: false; message: string } {
  const entries: ThemeIndexEntry[] = [];
  const paths = new Set<string>();
  for (const [i, entry] of themes.entries()) {
    const invalid = { ok: false, message: `theme index entry ${i + 1} is invalid` } as const;
    if (!isObject(entry) || Array.isArray(entry)) return invalid;
    if (strict && !hasExactKeys(entry, ENTRY_KEYS)) return invalid;
    const fields = requiredEntryFields(entry, paths, allowVideo);
    if (fields === null) return invalid;
    paths.add(fields.path);
    entries.push({ ...fields, meta: strict ? EMPTY_THEME_META : parseThemeMeta(entry) });
  }
  return { ok: true, entries };
}

export function parseThemeIndex(
  text: string,
): { ok: true; entries: ThemeIndexEntry[] } | { ok: false; message: string } {
  const head = parseIndexRoot(text, THEME_INDEX_VERSION);
  if (!head.ok) return head;
  if (!hasExactKeys(head.root, INDEX_KEYS)) return MALFORMED;
  const themes = head.root.themes;
  if (!Array.isArray(themes) || themes.length > THEME_INDEX_ENTRIES_MAX) return MALFORMED;
  return parseEntries(themes, true, false);
}

/** Index v2 (#1210): unknown root and entry keys are ignored; optional fields fall back to their defaults. */
export function parseThemeIndexV2(
  text: string,
): { ok: true; entries: ThemeIndexEntry[] } | { ok: false; message: string } {
  const head = parseIndexRoot(text, THEME_INDEX_V2_VERSION);
  if (!head.ok) return head;
  const themes = head.root.themes;
  if (!Array.isArray(themes) || themes.length > THEME_INDEX_V2_ENTRIES_MAX) return MALFORMED;
  return parseEntries(themes, false, false);
}

/** Index v3 (#1320): same lenient metadata rules as v2, plus `backdrop: "video"`. */
export function parseThemeIndexV3(
  text: string,
): { ok: true; entries: ThemeIndexEntry[] } | { ok: false; message: string } {
  const head = parseIndexRoot(text, THEME_INDEX_V3_VERSION);
  if (!head.ok) return head;
  const themes = head.root.themes;
  if (!Array.isArray(themes) || themes.length > THEME_INDEX_V3_ENTRIES_MAX) return MALFORMED;
  return parseEntries(themes, false, true);
}

/** The file a contributor writes next to a theme file in a theme repository (#1210). */
export interface ThemeDetails {
  tags: string[];
  description: string;
  author: string | null;
}

const DETAILS_MALFORMED = { ok: false, message: "the theme details file is malformed" } as const;

/** Strict: exact keys (author optional), 1 to 6 unique valid tags, description 1 to 160 after trim. */
export function parseThemeDetails(
  text: string,
): { ok: true; details: ThemeDetails } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return DETAILS_MALFORMED;
  }
  if (!isObject(parsed) || Array.isArray(parsed)) return DETAILS_MALFORMED;
  if (parsed.format !== THEME_DETAILS_FORMAT) return { ok: false, message: "this is not an omp-ui theme details file" };
  if (typeof parsed.version === "number" && parsed.version > THEME_DETAILS_VERSION) {
    return { ok: false, message: "this theme details file needs a newer omp-ui" };
  }
  if (parsed.version !== THEME_DETAILS_VERSION) return DETAILS_MALFORMED;
  const hasAuthor = Object.hasOwn(parsed, "author");
  if (!hasExactKeys(parsed, hasAuthor ? [...DETAILS_KEYS, "author"] : DETAILS_KEYS)) return DETAILS_MALFORMED;
  const { tags, description, author } = parsed;
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > THEME_TAGS_MAX) return DETAILS_MALFORMED;
  if (!tags.every(isThemeTag) || new Set(tags).size !== tags.length) return DETAILS_MALFORMED;
  const trimmed = parseDescription(description);
  if (trimmed === null) return DETAILS_MALFORMED;
  if (hasAuthor && !isThemeAuthor(author)) return DETAILS_MALFORMED;
  return { ok: true, details: { tags: [...tags], description: trimmed, author: hasAuthor ? (author as string) : null } };
}

/** Two-space JSON plus a trailing newline; author omitted when null. Key order: format, version, tags, description, author. */
export function themeDetailsFile(details: ThemeDetails): string {
  const value: Record<string, unknown> = {
    format: THEME_DETAILS_FORMAT,
    version: THEME_DETAILS_VERSION,
    tags: details.tags,
    description: details.description,
  };
  if (details.author !== null) value.author = details.author;
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** Lowercase; each run outside [a-z0-9] becomes one hyphen; trim hyphens; cut to 64 and trim a trailing hyphen. May return "". */
export function themeSlug(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, THEME_SLUG_CHARS_MAX).replace(/-+$/, "");
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
