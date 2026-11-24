// The official theme repository's checker and index generator (#1213). Node
// only and not exported from the package: its tests and the CLI the themes
// repository runs in CI import it directly. Every rule here is one a machine can
// check; the reviewer checks the rest (the repository's CONTRIBUTING.md).
import { createHash } from "node:crypto";
import { isObject } from "./guards";
import { themeGateFailures, type ThemeGateFailure } from "./theme";
import { checkBackdropBytes } from "./theme-backdrop";
import { parseThemeFile, sourceFromDraft } from "./theme-file";
import {
  REPOSITORY_IMAGE_BYTES_MAX,
  REPOSITORY_THEME_FILE_BYTES_MAX,
  THEME_DESCRIPTION_MAX,
  THEME_INDEX_BYTES_MAX,
  THEME_INDEX_ENTRIES_MAX,
  THEME_INDEX_FORMAT,
  THEME_INDEX_V2_BYTES_MAX,
  THEME_INDEX_V2_ENTRIES_MAX,
  THEME_INDEX_V2_VERSION,
  THEME_INDEX_VERSION,
  THEME_SLUG,
  THEME_SLUG_CHARS_MAX,
  isThemeTag,
  parseThemeDetails,
  parseThemeIndexV2,
  sameThemeSeeds,
  type RepositoryBackdropKind,
  type ThemeDetails,
} from "./theme-repository-format";
import type { ThemeSeeds } from "./theme-seeds";

export const TAG_VOCABULARY_MAX = 40;
/** Featured themes lead both indexes, in featured.json order. */
export const FEATURED_MAX = 12;

export interface CheckedTheme {
  /** themes/<slug>.json */
  path: string;
  /** Trimmed. */
  label: string;
  /** Verbatim from the theme file. */
  seeds: ThemeSeeds;
  backdrop: RepositoryBackdropKind | null;
  details: ThemeDetails;
}

export interface ThemeRepositoryReport {
  errors: string[];
  /** Every theme that passed the per-theme rules, sorted by path. */
  themes: CheckedTheme[];
  /** featured.json's paths, in file order. */
  featured: string[];
}

const TOP_LEVEL = new Set([
  "README.md",
  "LICENSE",
  "LICENSE-CODE",
  "CONTRIBUTING.md",
  "tags.json",
  "featured.json",
  "omp-ui-themes.json",
  "omp-ui-themes.v2.json",
  ".gitignore",
  ".gitattributes",
  "tools/omp-ui-theme-tool.mjs",
]);
const DETAILS_SUFFIX = ".details.json";
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const TAGS_KEYS = ["format", "version", "tags"];
const TAG_KEYS = ["id", "description"];
const FEATURED_KEYS = ["format", "version", "paths"];

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const exactKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every((key) => present.includes(key));
};

/** Plain JSON (no comments, no trailing commas); undefined when it does not parse. */
function plainJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

export function formatGateFailure(failure: ThemeGateFailure): string {
  switch (failure.kind) {
    case "contrast":
      return `${failure.label}: ${failure.ratio.toFixed(2)}:1 (needs ${failure.min}:1)`;
    case "planes":
      return `${failure.label}: the two planes are the same colour`;
    case "signal":
      return (
        `agent activity colour ${failure.colour} is not a green ` +
        `(hue ${Math.round(failure.hue)}°; it needs a hue from 100° to 200° and must not be grey)`
      );
  }
}

/** The vocabulary in tags.json; empty after reporting why it is invalid. */
function readVocabulary(files: ReadonlyMap<string, Uint8Array>, fail: (path: string, message: string) => void): Set<string> {
  const bytes = files.get("tags.json");
  if (bytes === undefined) {
    fail("tags.json", "missing; it lists the tags themes may use");
    return new Set();
  }
  const value = plainJson(bytes);
  if (!isObject(value) || Array.isArray(value) || !exactKeys(value, TAGS_KEYS)) {
    fail("tags.json", 'must be { "format": "omp-ui-theme-tags", "version": 1, "tags": [...] } and nothing else');
    return new Set();
  }
  if (value.format !== "omp-ui-theme-tags" || value.version !== 1) {
    fail("tags.json", 'format must be "omp-ui-theme-tags" and version 1');
  }
  const tags = value.tags;
  if (!Array.isArray(tags) || tags.length < 1 || tags.length > TAG_VOCABULARY_MAX) {
    fail("tags.json", `tags must list 1 to ${TAG_VOCABULARY_MAX} tags`);
    return new Set();
  }
  const vocabulary = new Set<string>();
  for (const [i, tag] of tags.entries()) {
    const at = `tag ${i + 1}`;
    if (!isObject(tag) || Array.isArray(tag) || !exactKeys(tag, TAG_KEYS)) {
      fail("tags.json", `${at} must be { "id", "description" } and nothing else`);
      continue;
    }
    if (!isThemeTag(tag.id)) {
      fail("tags.json", `${at}: the id must be lowercase words joined by hyphens, 24 characters at most`);
      continue;
    }
    if (vocabulary.has(tag.id)) fail("tags.json", `${at}: "${tag.id}" is listed twice`);
    if (
      typeof tag.description !== "string" ||
      tag.description.length < 1 ||
      tag.description.length > THEME_DESCRIPTION_MAX
    ) {
      fail("tags.json", `${at}: the description must be 1 to ${THEME_DESCRIPTION_MAX} characters`);
    }
    vocabulary.add(tag.id);
  }
  return vocabulary;
}

/** One theme file and its details file against rules 4 to 7; null after reporting why it fails. */
function checkTheme(
  path: string,
  bytes: Uint8Array,
  detailsPath: string,
  detailsBytes: Uint8Array,
  vocabulary: ReadonlySet<string>,
  fail: (path: string, message: string) => void,
): { theme: CheckedTheme; backdropHash: string | null } | null {
  let ok = true;
  const bad = (at: string, message: string): void => {
    ok = false;
    fail(at, message);
  };

  let theme: Omit<CheckedTheme, "details"> | null = null;
  let backdropHash: string | null = null;
  const raw = bytes.length > REPOSITORY_THEME_FILE_BYTES_MAX ? undefined : plainJson(bytes);
  if (bytes.length > REPOSITORY_THEME_FILE_BYTES_MAX) {
    bad(path, "the theme file is larger than 6 MiB");
  } else if (raw === undefined) {
    bad(path, "must be plain JSON, with no comments or trailing commas");
  } else {
    const parsed = parseThemeFile(decode(bytes));
    if (!parsed.ok) {
      bad(path, parsed.message);
    } else {
      const label = parsed.draft.label.trim();
      for (const failure of themeGateFailures(sourceFromDraft("custom-check", label, parsed.draft.seeds))) {
        bad(path, formatGateFailure(failure));
      }
      let kind: RepositoryBackdropKind | null = null;
      const backdrop = parsed.draft.backdrop;
      if (backdrop !== null && backdrop.from === "bytes") {
        if (!STRICT_BASE64.test(backdrop.data)) {
          bad(path, "the backdrop data is not strict base64");
        } else {
          const data = Buffer.from(backdrop.data, "base64");
          const check = checkBackdropBytes(data);
          const declared = isObject(raw) && isObject(raw.backdrop) ? raw.backdrop.mime : undefined;
          if (!check.ok) {
            bad(path, check.message);
          } else if (check.kind === "video") {
            bad(path, "video backdrops are not accepted in theme repositories");
          } else if (declared !== check.mime) {
            bad(path, `the backdrop says it is ${String(declared)} but its bytes are ${check.mime}`);
          } else if (check.kind === "image" && data.length > REPOSITORY_IMAGE_BYTES_MAX) {
            bad(path, "image backdrops can be at most 1 MiB in this repository");
          } else {
            kind = check.kind;
            backdropHash = createHash("sha256").update(data).digest("hex");
          }
        }
      }
      theme = { path, label, seeds: parsed.draft.seeds, backdrop: kind };
    }
  }

  let details: ThemeDetails | null = null;
  const parsedDetails = parseThemeDetails(decode(detailsBytes));
  if (!parsedDetails.ok) {
    bad(detailsPath, parsedDetails.message);
  } else {
    for (const tag of parsedDetails.details.tags) {
      if (!vocabulary.has(tag)) bad(detailsPath, `the tag "${tag}" is not in tags.json`);
    }
    details = parsedDetails.details;
  }

  if (!ok || theme === null || details === null) return null;
  return { theme: { ...theme, details }, backdropHash };
}

function readFeatured(
  files: ReadonlyMap<string, Uint8Array>,
  themeFiles: ReadonlySet<string>,
  fail: (path: string, message: string) => void,
): string[] {
  const bytes = files.get("featured.json");
  if (bytes === undefined) return [];
  const value = plainJson(bytes);
  if (!isObject(value) || Array.isArray(value) || !exactKeys(value, FEATURED_KEYS)) {
    fail("featured.json", 'must be { "format": "omp-ui-theme-featured", "version": 1, "paths": [...] } and nothing else');
    return [];
  }
  if (value.format !== "omp-ui-theme-featured" || value.version !== 1) {
    fail("featured.json", 'format must be "omp-ui-theme-featured" and version 1');
  }
  const paths = value.paths;
  if (!Array.isArray(paths) || paths.length > FEATURED_MAX) {
    fail("featured.json", `paths must list at most ${FEATURED_MAX} theme files`);
    return [];
  }
  const out: string[] = [];
  for (const path of paths) {
    if (typeof path !== "string" || !themeFiles.has(path)) {
      fail("featured.json", `${JSON.stringify(path)} is not a theme file in this repository`);
    } else if (out.includes(path)) {
      fail("featured.json", `${path} is listed twice`);
    } else {
      out.push(path);
    }
  }
  return out;
}

/** Every rule of the standard a machine can check. `files` maps repository-relative POSIX paths to bytes. */
export function checkThemeRepository(files: ReadonlyMap<string, Uint8Array>): ThemeRepositoryReport {
  const errors: string[] = [];
  const fail = (path: string, message: string): void => {
    errors.push(`${path}: ${message}`);
  };

  // Rules 1 and 2: allowed paths, slugs, and theme/details pairs.
  const themeFiles = new Map<string, string>(); // slug → path
  const detailsFiles = new Map<string, string>();
  for (const path of [...files.keys()].sort()) {
    if (TOP_LEVEL.has(path) || path.startsWith(".github/")) continue;
    const inThemes = path.startsWith("themes/") && !path.slice("themes/".length).includes("/");
    if (!inThemes || !path.endsWith(".json")) {
      fail(path, "not allowed in this repository");
      continue;
    }
    const file = path.slice("themes/".length);
    const isDetails = file.endsWith(DETAILS_SUFFIX);
    const name = isDetails ? file.slice(0, -DETAILS_SUFFIX.length) : file.slice(0, -".json".length);
    if (!THEME_SLUG.test(name) || name.length > THEME_SLUG_CHARS_MAX) {
      fail(path, `the file name must be lowercase words joined by hyphens, ${THEME_SLUG_CHARS_MAX} characters at most`);
      continue;
    }
    (isDetails ? detailsFiles : themeFiles).set(name, path);
  }
  for (const [slug, path] of themeFiles) {
    if (!detailsFiles.has(slug)) fail(path, `has no details file themes/${slug}${DETAILS_SUFFIX}`);
  }
  for (const [slug, path] of detailsFiles) {
    if (!themeFiles.has(slug)) fail(path, `has no theme file themes/${slug}.json`);
  }

  // Rule 3.
  const vocabulary = readVocabulary(files, fail);

  // Rules 4 to 7.
  const checked: Array<{ theme: CheckedTheme; backdropHash: string | null }> = [];
  for (const [slug, path] of [...themeFiles].sort(([, a], [, b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const detailsPath = detailsFiles.get(slug);
    if (detailsPath === undefined) continue;
    const result = checkTheme(path, files.get(path)!, detailsPath, files.get(detailsPath)!, vocabulary, fail);
    if (result !== null) checked.push(result);
  }

  // Rule 8.
  const labels = new Map<string, string>();
  for (const [i, { theme, backdropHash }] of checked.entries()) {
    const key = theme.label.toLowerCase();
    const first = labels.get(key);
    if (first !== undefined) fail(theme.path, `the label "${theme.label}" is already used by ${first}`);
    else labels.set(key, theme.path);
    const copy = checked
      .slice(0, i)
      .find((other) => other.backdropHash === backdropHash && sameThemeSeeds(other.theme.seeds, theme.seeds));
    if (copy !== undefined) fail(theme.path, `is a copy of ${copy.theme.path}`);
  }

  // Rules 9 and 10.
  const featured = readFeatured(files, new Set(themeFiles.values()), fail);
  if (themeFiles.size > THEME_INDEX_V2_ENTRIES_MAX) {
    fail("themes/", `the repository can hold at most ${THEME_INDEX_V2_ENTRIES_MAX} themes`);
  }

  return { errors, themes: checked.map((c) => c.theme), featured };
}

const fileText = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

/** Both indexes as file text. `previousV2` is the committed v2 index or null; `today` is YYYY-MM-DD (UTC). */
export function buildThemeIndexes(
  report: ThemeRepositoryReport,
  previousV2: string | null,
  today: string,
): { ok: true; v1: string; v2: string } | { ok: false; message: string } {
  if (report.errors.length > 0) return { ok: false, message: "the repository has errors; run check" };

  const previous = previousV2 === null ? null : parseThemeIndexV2(previousV2);
  const added = new Map<string, string>();
  if (previous !== null && previous.ok) {
    for (const entry of previous.entries) if (entry.meta.added !== null) added.set(entry.path, entry.meta.added);
  }
  const dated = report.themes.map((theme) => ({ theme, added: added.get(theme.path) ?? today }));
  const featuredRank = new Map(report.featured.map((path, i) => [path, i]));
  dated.sort((a, b) => {
    const fa = featuredRank.get(a.theme.path);
    const fb = featuredRank.get(b.theme.path);
    if (fa !== undefined || fb !== undefined) {
      if (fa === undefined) return 1;
      if (fb === undefined) return -1;
      return fa - fb;
    }
    if (a.added !== b.added) return a.added < b.added ? -1 : 1;
    return a.theme.path < b.theme.path ? -1 : a.theme.path > b.theme.path ? 1 : 0;
  });

  const v2 = fileText({
    format: THEME_INDEX_FORMAT,
    version: THEME_INDEX_V2_VERSION,
    themes: dated.map(({ theme, added: date }) => ({
      path: theme.path,
      label: theme.label,
      seeds: theme.seeds,
      backdrop: theme.backdrop,
      tags: theme.details.tags,
      description: theme.details.description,
      ...(theme.details.author !== null ? { author: theme.details.author } : {}),
      added: date,
      featured: featuredRank.has(theme.path),
    })),
  });
  if (Buffer.byteLength(v2, "utf8") > THEME_INDEX_V2_BYTES_MAX) {
    return { ok: false, message: "omp-ui-themes.v2.json would be larger than 512 KiB" };
  }

  const v1Entries: unknown[] = [];
  const v1Of = (themes: unknown[]): string => fileText({ format: THEME_INDEX_FORMAT, version: THEME_INDEX_VERSION, themes });
  let v1 = v1Of(v1Entries);
  for (const { theme } of dated) {
    if (v1Entries.length === THEME_INDEX_ENTRIES_MAX) break;
    const next = [...v1Entries, { path: theme.path, label: theme.label, seeds: theme.seeds, backdrop: theme.backdrop }];
    const text = v1Of(next);
    if (Buffer.byteLength(text, "utf8") > THEME_INDEX_BYTES_MAX) break;
    v1Entries.push(next[next.length - 1]);
    v1 = text;
  }
  return { ok: true, v1, v2 };
}
