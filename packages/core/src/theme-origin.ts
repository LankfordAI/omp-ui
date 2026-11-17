// Where a repository theme came from (#1178, ADR-0096). Pure: theme.ts validates
// stored rows with it and the renderer reads it through the theme subpath.
import { isObject } from "./guards";

/** Canonical "owner/repo": lowercase GitHub owner (≤39) and repository (≤100), no ".git". */
export const THEME_REPOSITORY_ID =
  /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?\/(?!\.\.?$)(?!.*\.git$)[a-z0-9._-]{1,100}$/;
export const GIT_SHA = /^[0-9a-f]{40}$/;
/** The repository omp-ui bundles themes from and lists without being added (#1209). */
export const OFFICIAL_THEME_REPOSITORY = "lankfordai/omp-ui-themes";
/** Relative POSIX path of a .json file; no segment starts with "." (no "..", no hidden files). */
const THEME_PATH = /^[A-Za-z0-9_-][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*\.json$/;
const THEME_PATH_MAX = 200;
const ORIGIN_KEYS = ["repository", "path", "commit", "blob", "animate"];

export interface ThemeOrigin {
  /** Canonical "owner/repo" on github.com. */
  repository: string;
  /** The theme file's path inside the repository, as the theme index lists it. */
  path: string;
  /** The commit the theme was installed from. */
  commit: string;
  /** Git blob SHA-1 of the installed theme file; a listing with another blob offers an update. */
  blob: string;
  /** Lets this theme's scene animate; false until the user turns it on. */
  animate: boolean;
}

export function isRepositoryThemePath(value: unknown): value is string {
  return typeof value === "string" && value.length <= THEME_PATH_MAX && THEME_PATH.test(value);
}

export function isThemeOrigin(value: unknown): value is ThemeOrigin {
  if (!isObject(value) || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  if (keys.length !== ORIGIN_KEYS.length || !ORIGIN_KEYS.every((key) => keys.includes(key))) return false;
  return (
    typeof value.repository === "string" &&
    THEME_REPOSITORY_ID.test(value.repository) &&
    isRepositoryThemePath(value.path) &&
    typeof value.commit === "string" &&
    GIT_SHA.test(value.commit) &&
    typeof value.blob === "string" &&
    GIT_SHA.test(value.blob) &&
    typeof value.animate === "boolean"
  );
}
