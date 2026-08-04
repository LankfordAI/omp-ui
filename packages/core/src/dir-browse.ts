import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DirBrowseResult } from "./types";

/** Leading-~ expansion only: "~" → home, "~/x" → join(home, "x"); else unchanged. */
export function expandHomePath(input: string, home: string = os.homedir()): string {
  if (input === "~") return home;
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return path.join(home, input.slice(2));
  }
  return input;
}

/** True for `~`, `~/...`, and absolute paths — the only shapes the picker browses. */
function isBrowsablePath(trimmed: string, home: string): boolean {
  if (trimmed === "~" || trimmed.startsWith("~/") || trimmed.startsWith("~\\")) return true;
  return path.isAbsolute(expandHomePath(trimmed, home));
}

/**
 * Lists candidate directories for a partial path. The input splits at its last
 * separator: a trailing "/" (or bare "~") lists that directory unfiltered;
 * otherwise the dirname is listed and the basename is a case-insensitive
 * prefix filter. Hidden entries only when the prefix starts with ".".
 */
export async function browseDirectories(
  partialPath: string,
  opts?: { home?: string },
): Promise<DirBrowseResult> {
  const home = opts?.home ?? os.homedir();
  const trimmed = partialPath.trim();
  if (!isBrowsablePath(trimmed, home)) {
    return { parentPath: "", entries: [], error: "invalid" };
  }
  const resolved = path.resolve(expandHomePath(trimmed, home));
  const dirMode = /[/\\]$/.test(trimmed) || trimmed === "~";
  const parentPath = dirMode ? resolved : path.dirname(resolved);
  const prefix = dirMode ? "" : path.basename(resolved);

  let dirents;
  try {
    dirents = await fs.readdir(parentPath, { withFileTypes: true });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    const error = code === "EACCES" || code === "EPERM" ? "denied" : "missing";
    return { parentPath, entries: [], error };
  }

  const lowerPrefix = prefix.toLowerCase();
  const showHidden = prefix.startsWith(".");
  const entries = dirents
    .filter(
      (d) =>
        d.isDirectory() &&
        d.name.toLowerCase().startsWith(lowerPrefix) &&
        (showHidden || !d.name.startsWith(".")),
    )
    .map((d) => ({ name: d.name, fullPath: path.join(parentPath, d.name) }))
    .sort((a, b) => a.name.localeCompare(b.name));

  return { parentPath, entries, error: null };
}

/**
 * Expands ~ and resolves; throws Error with a user-facing message when the
 * result is not an absolute path to an existing directory.
 */
export async function resolveProjectPath(
  input: string,
  opts?: { home?: string },
): Promise<string> {
  const home = opts?.home ?? os.homedir();
  const trimmed = input.trim();
  if (!isBrowsablePath(trimmed, home)) {
    throw new Error("path must start with ~/ or /");
  }
  const resolved = path.resolve(expandHomePath(trimmed, home));
  let st;
  try {
    st = await fs.stat(resolved);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new Error(`no such directory: ${resolved}`);
    }
    if (code === "EACCES" || code === "EPERM") {
      throw new Error(`permission denied: ${resolved}`);
    }
    throw err;
  }
  if (!st.isDirectory()) throw new Error(`not a directory: ${resolved}`);
  return resolved;
}
