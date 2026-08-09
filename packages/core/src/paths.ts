import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Ported from @oh-my-pi/pi-utils src/dirs.ts (v17.1.8): profile validation.
const PROFILE_NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const WINDOWS_RESERVED_BASENAME_RE = /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\..*)?$/i;

/**
 * Mirrors omp's readProfileFromEnvSafe: OMP_PROFILE wins over PI_PROFILE when
 * defined (an explicitly-empty OMP_PROFILE selects the default profile);
 * invalid names resolve to undefined. Never throws.
 */
export function resolveProfile(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const raw = env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE;
  if (raw === undefined || raw === "") return undefined;
  if (!PROFILE_NAME_RE.test(raw) || WINDOWS_RESERVED_BASENAME_RE.test(raw)) return undefined;
  return raw;
}

/**
 * Exact port of omp's sessions-root resolution (pi-utils src/dirs.ts:228-330).
 * Call lazily at every use — the XDG branch is existence-gated and can flip
 * while the app runs.
 */
export function getSessionsRoot(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path;
  const profile = resolveProfile(env);
  const configName = env.PI_CONFIG_DIR || ".omp"; // directory NAME under $HOME
  const configRoot = profile
    ? pathApi.join(home, configName, "profiles", profile)
    : pathApi.join(home, configName);
  const defaultAgent = pathApi.join(configRoot, "agent");
  // PI_CODING_AGENT_DIR applies only to the DEFAULT profile (ignored when a
  // named profile is active).
  const agentDir =
    !profile && env.PI_CODING_AGENT_DIR
      ? pathApi.resolve(env.PI_CODING_AGENT_DIR)
      : defaultAgent;
  const isDefault = agentDir === defaultAgent;
  if ((platform === "linux" || platform === "darwin") && isDefault) {
    const xdg = env.XDG_DATA_HOME;
    if (xdg) {
      // XDG flattens the agent/ prefix, and only applies if the dir ALREADY EXISTS.
      const candidate = profile
        ? pathApi.join(xdg, "omp", "profiles", profile)
        : pathApi.join(xdg, "omp");
      try {
        if (fs.existsSync(candidate)) return pathApi.join(candidate, "sessions");
      } catch {
        // fall through to the default
      }
    }
  }
  return pathApi.join(agentDir, "sessions");
}

export function getArchiveRoot(sessionsRoot: string): string {
  return path.join(path.dirname(sessionsRoot), "archive", "sessions");
}

// ADR-0003: per-lineage session dirs, direct children of the sessions root.
// The char class excludes both separators deliberately: this predicate gates a
// recursive delete (archive.ts:deleteSessionFiles), and a `.+` here would let a
// corrupt registry value like `omp-ui--x/../..--<uuid>` escape the root.
const LINEAGE_DIR_RE = /^omp-ui--[^/\\]+-[0-9a-f-]{36}$/;

function slugify(projectCwd: string): string {
  const slug = path
    .basename(projectCwd)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
  return slug || "project";
}

export function mintLineageDirName(projectCwd: string): string {
  return `omp-ui--${slugify(projectCwd)}--${randomUUID()}`;
}

export function isLineageDirName(name: string): boolean {
  return LINEAGE_DIR_RE.test(name);
}

export function ompBinaryName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "omp.exe" : "omp";
}

/**
 * The directory omp-ui installs and updates its own private copy of the omp
 * binary into (overridable via `OMP_UI_INSTALL_DIR`). App-scoped under the
 * user's data home, so it never collides with a bun-global or Homebrew omp.
 */
export function managedOmpDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  if (env.OMP_UI_INSTALL_DIR) return env.OMP_UI_INSTALL_DIR;
  if (platform === "win32") {
    return path.win32.join(env.LOCALAPPDATA ?? path.win32.join(home, "AppData", "Local"), "omp-ui", "bin");
  }
  return path.join(home, ".local", "share", "omp-ui", "bin");
}

/** The managed binary path itself. */
export function managedOmpPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path;
  return pathApi.join(managedOmpDir(env, platform, home), ompBinaryName(platform));
}

/**
 * Electron launched from a .desktop/AppImage may lack ~/.bun/bin on PATH, so
 * resolution checks an explicit override, then the app-managed copy, then PATH,
 * then known install spots. First existing hit wins; null → caller surfaces a
 * user-facing error.
 *
 * The app-managed copy ranks above PATH on purpose: once omp-ui installs or
 * updates it, resolveOmpBinary returns it regardless of where a previous omp
 * lived (bun global, Homebrew, …), so an update actually takes effect instead
 * of silently losing to a stale copy earlier on PATH.
 */
export function resolveOmpBinary(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
  exists: (candidate: string) => boolean = fs.existsSync,
): string | null {
  const pathApi = platform === "win32" ? path.win32 : path;
  const candidates: string[] = [];
  if (env.OMP_UI_OMP_PATH) candidates.push(env.OMP_UI_OMP_PATH);
  candidates.push(managedOmpPath(env, platform, home));
  const delimiter = platform === "win32" ? ";" : path.delimiter;
  for (const dir of (env.PATH ?? "").split(delimiter)) {
    if (dir) candidates.push(pathApi.join(dir, ompBinaryName(platform)));
  }
  candidates.push(pathApi.join(home, ".bun", "bin", ompBinaryName(platform)));
  if (platform !== "win32") {
    candidates.push(path.join("/usr/local/bin", ompBinaryName(platform)));
    candidates.push(path.join(home, ".local", "bin", ompBinaryName(platform)));
  }
  for (const candidate of candidates) {
    try {
      if (exists(candidate)) return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}
