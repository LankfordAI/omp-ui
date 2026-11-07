import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseEnv } from "node:util";
import { normalizeProfileName } from "./paths";
import type { StatsSourceInfo } from "./types";

export interface StatsSourceOptions {
  env: NodeJS.ProcessEnv;
  /** Neutral host cwd, also used for the collector child (normally os.homedir()). */
  cwd: string;
  platform?: NodeJS.Platform;
  home?: string;
}

const DIRECTORY_KEYS = new Set([
  "OMP_PROFILE", "PI_PROFILE", "OMP_CONFIG_DIR", "PI_CONFIG_DIR",
  "OMP_CODING_AGENT_DIR", "PI_CODING_AGENT_DIR", "XDG_DATA_HOME",
  "XDG_STATE_HOME", "XDG_CACHE_HOME",
]);

/** Only project directory-affecting dotenv values; never return credential values. */
function directoryDotenv(file: string, platform: NodeJS.Platform): NodeJS.ProcessEnv {
  try {
    const parsed = parseEnv(fs.readFileSync(file, "utf8"));
    const result: NodeJS.ProcessEnv = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (value === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || value.includes("\0")) continue;
      if (DIRECTORY_KEYS.has(platform === "win32" ? key.toUpperCase() : key)) result[key] = value;
    }
    // Alias after parsing, independent of the order parseEnv emits the keys.
    // Prefix recognition is case-sensitive even on Windows.
    for (const key of Object.keys(result)) {
      if (key.startsWith("OMP_")) result[`PI_${key.slice(4)}`] = result[key];
    }
    return result;
  } catch {
    return {};
  }
}

/**
 * Port of OMP v18.17.0 dirs.ts + env.ts, not an existence search for databases.
 * env is the already-running host environment: Bun's earlier cwd dotenv
 * autoload, if any, is part of that input and cannot be undone here.
 */
export function resolveStatsSource({
  env: incoming,
  cwd,
  platform = process.platform,
  home = os.homedir(),
}: StatsSourceOptions): StatsSourceInfo {
  const paths = platform === "win32" ? path.win32 : path.posix;
  const env: NodeJS.ProcessEnv = {};
  for (const key of DIRECTORY_KEYS) {
    const actual = platform === "win32"
      ? Object.keys(incoming).find((name) => name.toUpperCase() === key)
      : key;
    const value = actual === undefined ? undefined : incoming[actual];
    if (value !== undefined) env[key] = value;
  }
  const profile = normalizeProfileName(env.OMP_PROFILE !== undefined ? env.OMP_PROFILE : env.PI_PROFILE);
  // The CLI calls setProfile before importing the command/env loader. In
  // default mode it must not retain a parent's propagated named-profile agent.
  const base = (): string => paths.join(home, env.PI_CONFIG_DIR || ".omp");
  const profileRoot = (name: string | undefined): string => name
    ? paths.join(base(), "profiles", name)
    : base();
  const profileDerived = (): boolean => {
    let legacy: string | undefined;
    try { legacy = normalizeProfileName(env.PI_PROFILE); } catch { /* safe legacy fallback */ }
    return legacy !== undefined && env.PI_CODING_AGENT_DIR === paths.join(profileRoot(legacy), "agent");
  };
  if (profile) {
    env.OMP_PROFILE = profile;
    env.PI_PROFILE = profile;
    env.PI_CODING_AGENT_DIR = paths.join(profileRoot(profile), "agent");
  } else {
    if (profileDerived()) delete env.PI_CODING_AGENT_DIR;
    delete env.OMP_PROFILE;
    delete env.PI_PROFILE;
  }
  const configRoot = profileRoot(profile);
  const initialAgent = !profile && env.PI_CODING_AGENT_DIR
    ? paths.resolve(cwd, env.PI_CODING_AGENT_DIR)
    : paths.join(configRoot, "agent");
  // Capture every file before applying any value. Relocated roots do not
  // trigger another dotenv pass; dotenv profile values never reselect profile.
  const files = [
    paths.join(home, ".env"),
    paths.join(configRoot, ".env"),
    paths.join(initialAgent, ".env"),
    paths.join(cwd, ".env"),
  ].map((file) => directoryDotenv(file, platform));
  for (const [key, value] of Object.entries(env)) {
    if (value?.includes("\0")) delete env[key];
  }
  for (const values of files.reverse()) {
    for (const [parsedKey, value] of Object.entries(values)) {
      const key = platform === "win32" ? parsedKey.toUpperCase() : parsedKey;
      if (!env[key]) env[key] = value;
    }
  }
  const root = profileRoot(profile);
  const defaultAgent = paths.join(root, "agent");
  const agent = !profile && env.PI_CODING_AGENT_DIR && !profileDerived()
    ? paths.resolve(cwd, env.PI_CODING_AGENT_DIR)
    : defaultAgent;
  let dataRoot = root;
  let agentDataRoot = agent;
  if ((platform === "linux" || platform === "darwin") && agent === defaultAgent && env.XDG_DATA_HOME) {
    const selected = profile
      ? paths.join(env.XDG_DATA_HOME, "omp", "profiles", profile)
      : paths.join(env.XDG_DATA_HOME, "omp");
    try {
      if (fs.existsSync(paths.resolve(cwd, selected))) {
        dataRoot = selected;
        agentDataRoot = selected;
      }
    } catch { /* OMP falls back when the existence probe fails. */ }
  }
  const sessionsRoot = paths.resolve(cwd, agentDataRoot, "sessions");
  return {
    profile: profile ?? null,
    databasePath: paths.resolve(cwd, dataRoot, "stats.db"),
    sessionsRoot,
    archiveRoot: paths.join(paths.dirname(sessionsRoot), "archive", "sessions"),
  };
}
