// The omp-ui theme file and the save request every authoring route hands the
// host (issue #1168). Pure — the renderer parses files with it before saving.
import { isObject } from "./guards";
import { AUTHORED_THEME_ID_PREFIX, STORED_ID, type ThemeGateFailure, type ThemeSource } from "./theme";
import { BACKDROP_BLUR_MAX, BACKDROP_IMAGE_BYTES_MAX, LEGACY_DIM_KEY, type ThemeBackdropMime } from "./theme-backdrop";
import { isThemeSeeds, themeColoursFromSeeds, type ThemeSeeds } from "./theme-seeds";
import { stripJsonc } from "./vscode-theme";

export const THEME_FILE_FORMAT = "omp-ui-theme";
export const THEME_FILE_VERSION = 1;
/** An omp-ui theme file larger than this cannot hold a valid one (a 4 MiB backdrop as base64, plus seeds). */
export const THEME_FILE_BYTES_MAX = 6 * 1024 * 1024;

/** What every authoring route hands the host. */
export interface StoredThemeDraft {
  /** Present to replace an existing authored theme; absent to create one. */
  id?: string;
  label: string;
  seeds: ThemeSeeds;
  backdrop: DraftBackdrop | null;
}

export type DraftBackdrop =
  | { from: "bytes"; data: string /* base64 */; blur: number }
  | { from: "asset"; assetHash: string; blur: number };

export type SaveStoredThemeResult =
  | { ok: true; source: ThemeSource }
  | { ok: false; reason: "invalid"; message: string }
  | { ok: false; reason: "gate"; label: string; failures: ThemeGateFailure[] };

/** The exported file: a draft plus the format stamp. */
export interface ThemeFile {
  format: typeof THEME_FILE_FORMAT;
  version: 1;
  label: string;
  seeds: ThemeSeeds;
  backdrop?: { mime: ThemeBackdropMime; data: string; blur: number };
}

const LABEL_MAX = 80;
/** Base64 length of the largest accepted image backdrop. */
const BACKDROP_DATA_MAX = Math.ceil(BACKDROP_IMAGE_BYTES_MAX / 3) * 4;
const ASSET_HASH = /^[0-9a-f]{64}$/;

const hasOnlyKeys = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

const inRange = (value: unknown, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

function isDraftBackdrop(value: unknown): value is DraftBackdrop {
  if (!isObject(value) || Array.isArray(value)) return false;
  if (!inRange(value.blur, BACKDROP_BLUR_MAX)) return false;
  if (value.from === "bytes") {
    return (
      hasOnlyKeys(value, ["from", "data", "blur", LEGACY_DIM_KEY]) &&
      typeof value.data === "string" &&
      value.data.length <= BACKDROP_DATA_MAX
    );
  }
  if (value.from === "asset") {
    return (
      hasOnlyKeys(value, ["from", "assetHash", "blur", LEGACY_DIM_KEY]) &&
      typeof value.assetHash === "string" &&
      ASSET_HASH.test(value.assetHash)
    );
  }
  return false;
}

export function isStoredThemeDraft(value: unknown): value is StoredThemeDraft {
  if (!isObject(value) || Array.isArray(value)) return false;
  if (!hasOnlyKeys(value, ["id", "label", "seeds", "backdrop"])) return false;
  const { id, label, seeds, backdrop } = value;
  if (id !== undefined && (typeof id !== "string" || !STORED_ID.test(id) || !id.startsWith(AUTHORED_THEME_ID_PREFIX))) {
    return false;
  }
  if (typeof label !== "string") return false;
  const trimmed = label.trim().length;
  if (trimmed < 1 || trimmed > LABEL_MAX) return false;
  if (!isThemeSeeds(seeds)) return false;
  return backdrop === null || isDraftBackdrop(backdrop);
}

/** Pure: seeds to a complete source, without the backdrop. */
export function sourceFromDraft(id: string, label: string, seeds: ThemeSeeds): ThemeSource {
  return { id, label, ...themeColoursFromSeeds(seeds) };
}

const MALFORMED = { ok: false, message: "the theme file is malformed" } as const;

/** An omp-ui theme file to a draft. The draft never carries an id: importing a file always creates a theme. */
export function parseThemeFile(text: string): { ok: true; draft: StoredThemeDraft } | { ok: false; message: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonc(text));
  } catch {
    return MALFORMED;
  }
  if (!isObject(parsed) || Array.isArray(parsed)) return MALFORMED;
  if (parsed.format !== THEME_FILE_FORMAT) return { ok: false, message: "this is not an omp-ui theme file" };
  if (typeof parsed.version === "number" && parsed.version > THEME_FILE_VERSION) {
    return { ok: false, message: "this theme file needs a newer omp-ui" };
  }
  if (parsed.version !== THEME_FILE_VERSION) return MALFORMED;
  if (!hasOnlyKeys(parsed, ["format", "version", "label", "seeds", "backdrop"])) return MALFORMED;

  let backdrop: DraftBackdrop | null = null;
  if (parsed.backdrop !== undefined) {
    const file = parsed.backdrop;
    if (!isObject(file) || Array.isArray(file) || !hasOnlyKeys(file, ["mime", "data", "blur", LEGACY_DIM_KEY])) {
      return MALFORMED;
    }
    // The mime is informational: the host sniffs the bytes themselves.
    if (typeof file.mime !== "string" || typeof file.data !== "string") return MALFORMED;
    backdrop = { from: "bytes", data: file.data, blur: file.blur as number };
  }
  const draft = { label: parsed.label, seeds: parsed.seeds, backdrop };
  return isStoredThemeDraft(draft) ? { ok: true, draft } : MALFORMED;
}
