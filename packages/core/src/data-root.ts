import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

/**
 * Which build of omp-ui owns a data root (issue #442, Release P). Packaged,
 * standalone unpackaged, and electron-vite runs each get their own root so a
 * long-lived host and a `npm run dev` never share registry, credentials, or
 * host lock.
 */
export type BuildFlavor = "installed" | "dev" | "dev-server";

const FLAVOR_DIR: Readonly<Record<BuildFlavor, string>> = {
  installed: "omp-ui",
  dev: "omp-ui-dev",
  "dev-server": "omp-ui-dev-server",
};

const FLAVOR_DIR_NAMES: readonly string[] = Object.values(FLAVOR_DIR);

/**
 * Platform data home. Linux/other: `$XDG_DATA_HOME` (only when absolute — the
 * XDG spec says a relative value is invalid and must be ignored) or
 * `~/.local/share`; macOS: `~/Library/Application Support`; Windows:
 * `%LOCALAPPDATA%` or `~/AppData/Local`.
 */
export function dataHome(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  if (platform === "win32") {
    return env.LOCALAPPDATA || path.win32.join(home, "AppData", "Local");
  }
  if (platform === "darwin") return path.posix.join(home, "Library", "Application Support");
  const xdg = env.XDG_DATA_HOME;
  if (xdg && path.posix.isAbsolute(xdg)) return xdg;
  return path.posix.join(home, ".local", "share");
}

/**
 * `<dataHome>/omp-ui`, `omp-ui-dev`, or `omp-ui-dev-server` for the flavor.
 * A set, non-empty `OMP_UI_DATA_DIR` replaces the WHOLE root — no flavor
 * suffix is appended. Deliberately blind to `OMP_PROFILE`, `PI_PROFILE`, and
 * `PI_CODING_AGENT_DIR`: those select omp's profile, never omp-ui's data.
 * The result is canonical (see `canonicalDataRoot`).
 */
export function resolveDataRoot(
  flavor: BuildFlavor,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = homedir(),
): string {
  const override = env.OMP_UI_DATA_DIR;
  if (override) return canonicalDataRoot(override, platform);
  // Path syntax follows the target platform, not the host, so a Windows root
  // resolves correctly from a Linux test.
  const p = platform === "win32" ? path.win32 : path.posix;
  return canonicalDataRoot(p.join(dataHome(platform, env, home), FLAVOR_DIR[flavor]), platform);
}

/** `<dataRoot>/omp` — the managed OMP install dir for this flavor. */
export function resolveManagedOmpDir(
  flavor: BuildFlavor,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return path.join(resolveDataRoot(flavor, env), "omp");
}

/**
 * Canonicalises a root — realpath when it exists, `path.resolve` otherwise —
 * so two spellings of one directory (symlink, relative, trailing slash) can
 * never look like two hosts. Then rejects a root nested inside another
 * flavor's root: when the last segment is a flavor dir name AND some segment
 * above it is too (`/x/omp-ui/omp-ui-dev`), the roots would share claim
 * evidence and the host lock could be fooled. `/x/omp-ui/omp` is fine — only
 * the flavor names collide.
 */
export function canonicalDataRoot(
  root: string,
  platform: NodeJS.Platform = process.platform,
): string {
  let canonical: string;
  try {
    canonical = realpathSync.native(root);
  } catch {
    canonical = (platform === "win32" ? path.win32 : path.posix).resolve(root);
  }
  const segments = canonical.split(platform === "win32" ? /[\\/]+/ : "/").filter(Boolean);
  const last = segments.at(-1);
  if (
    last !== undefined &&
    FLAVOR_DIR_NAMES.includes(last) &&
    segments.some((segment, index) => index < segments.length - 1 && FLAVOR_DIR_NAMES.includes(segment))
  ) {
    throw new Error(`nested data root: ${root}`);
  }
  return canonical;
}

/**
 * Permanent host-claim evidence in a canonical root: any of these means a
 * persistent host has owned (or owns) the data, and a legacy Electron
 * authority must refuse to open it.
 */
export const AUTHORITY_CLAIM_MARKERS = [
  "host.lock",
  "migration.json",
  "registry.json",
  "provider-keys.json",
  "remote-instances.json",
  "worktrees",
] as const;

/**
 * The `AUTHORITY_CLAIM_MARKERS` present in `root` (file or dir), in marker
 * order. Filesystem evidence only — never probes a process. A missing root
 * has no evidence.
 */
export function authorityClaimEvidence(root: string): string[] {
  return AUTHORITY_CLAIM_MARKERS.filter((marker) => existsSync(path.join(root, marker)));
}
