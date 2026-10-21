/**
 * Fleet dispatch (issue #899, ADR-0061): the Node half on the owning host.
 * The resource sampler and the OS / package-manager probes (issue #905)
 * behind `fleet:hostReport`, and the staged dispatch prompt — written into
 * the lineage dir at accept time, delivered on the initialCommands rail, and
 * unlinked once omp acknowledges the prompt.
 */
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { FleetHostOs, FleetPackageManager } from "./fleet";
import {
  removeLineageArtifact,
  writeLineageArtifact,
} from "./lineage-artifact";

export const FLEET_PROMPT_ARTIFACT = "fleet-prompt.md";

/** Stages the dispatch prompt; dies with the lineage dir like every lineage artifact. */
export function stageFleetPrompt(absLineageDir: string, text: string): string {
  return writeLineageArtifact(
    absLineageDir,
    path.join(absLineageDir, FLEET_PROMPT_ARTIFACT),
    text,
  );
}

/** The staged prompt; null when absent, unreadable, or blank. */
export function readFleetPrompt(absLineageDir: string): string | null {
  try {
    const text = fs.readFileSync(
      path.join(absLineageDir, FLEET_PROMPT_ARTIFACT),
      "utf8",
    );
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

/** Removes the staged prompt after omp acknowledged it; absent is success. */
export function consumeFleetPrompt(absLineageDir: string): void {
  removeLineageArtifact(path.join(absLineageDir, FLEET_PROMPT_ARTIFACT));
}

export interface HostResources {
  cpuCount: number;
  /** 0..1 over the sample window; null when the window saw no ticks. */
  cpuUtilization: number | null;
  totalMemoryBytes: number;
  availableMemoryBytes: number;
}

function cpuTicks(): { idle: number; total: number } {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    const t = cpu.times;
    idle += t.idle;
    total += t.user + t.nice + t.sys + t.idle + t.irq;
  }
  return { idle, total };
}

/**
 * Available memory: Linux reads `MemAvailable` from /proc/meminfo (it counts
 * reclaimable page cache); every other platform, and any read failure, uses
 * `os.freemem()`. On macOS that under-counts reclaimable pages, which only
 * makes placement conservative there.
 */
function availableMemory(): number {
  if (process.platform === "linux") {
    try {
      const match = /^MemAvailable:\s+(\d+)\s+kB/m.exec(
        fs.readFileSync("/proc/meminfo", "utf8"),
      );
      if (match !== null) return Number(match[1]) * 1024;
    } catch {
      // fall through to os.freemem()
    }
  }
  return os.freemem();
}

/** Two `os.cpus()` snapshots `intervalMs` apart: utilization is 1 - idle/total over every core. */
export async function sampleHostResources(
  intervalMs = 200,
): Promise<HostResources> {
  const before = cpuTicks();
  await delay(intervalMs);
  const after = cpuTicks();
  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  const cpuUtilization =
    totalDelta > 0
      ? Math.min(1, Math.max(0, 1 - idleDelta / totalDelta))
      : null;
  return {
    cpuCount: os.cpus().length,
    cpuUtilization,
    totalMemoryBytes: os.totalmem(),
    availableMemoryBytes: availableMemory(),
  };
}

/** Seams for the OS and package-manager probes; every default reads the real host. */
export interface HostProbeDeps {
  platform?: NodeJS.Platform;
  /** Default process.env: the environment fleet exec children inherit. */
  env?: NodeJS.ProcessEnv;
  /** Default: stat isFile, then access X_OK (F_OK on win32). */
  isExecutableFile?: (p: string) => Promise<boolean>;
  /** Default: utf8 read. */
  readFile?: (p: string) => Promise<string>;
  /** Default: execFile with a 2 s timeout; resolves stdout trimmed. */
  run?: (file: string, args: string[]) => Promise<string>;
  osVersion?: () => string;
  osRelease?: () => string;
  osType?: () => string;
}

const PROBE_RUN_TIMEOUT_MS = 2_000;

async function defaultIsExecutableFile(p: string): Promise<boolean> {
  try {
    let stat: fs.Stats;
    try {
      stat = await fs.promises.stat(p);
    } catch (err) {
      // winget.exe under WindowsApps is an app execution alias (a reparse
      // point stat may fail to follow); its existence is what counts.
      if (process.platform !== "win32") throw err;
      const link = await fs.promises.lstat(p);
      return link.isFile() || link.isSymbolicLink();
    }
    if (!stat.isFile()) return false;
    await fs.promises.access(
      p,
      process.platform === "win32" ? fs.constants.F_OK : fs.constants.X_OK,
    );
    return true;
  } catch {
    return false;
  }
}

function defaultRun(file: string, args: string[]): Promise<string> {
  // Executor form (not Promise.withResolvers): core's tsconfig lib is ES2022.
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: "utf8", timeout: PROBE_RUN_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(stdout.trim());
      },
    );
  });
}

/**
 * os-release(5) `KEY=value` lines: blanks and `#` comments skipped, one pair
 * of matching `"` or `'` quotes stripped, `\"`, `\\`, `\$` unescaped.
 */
export function parseOsRelease(text: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") &&
      value.at(-1) === value[0]
    ) {
      value = value.slice(1, -1);
    }
    fields[key] = value.replace(/\\(["\\$])/g, "$1");
  }
  return fields;
}

async function linuxOs(
  readFile: (p: string) => Promise<string>,
): Promise<FleetHostOs> {
  for (const file of ["/etc/os-release", "/usr/lib/os-release"]) {
    let text: string;
    try {
      text = await readFile(file);
    } catch {
      continue;
    }
    const fields = parseOsRelease(text);
    return {
      name: fields.PRETTY_NAME || fields.NAME || "Linux",
      version: fields.VERSION_ID || null,
    };
  }
  return { name: "Linux", version: null };
}

async function darwinOs(
  run: (file: string, args: string[]) => Promise<string>,
): Promise<FleetHostOs> {
  try {
    return {
      name: "macOS",
      version: (await run("/usr/bin/sw_vers", ["-productVersion"])) || null,
    };
  } catch {
    return { name: "macOS", version: null };
  }
}

/** `os.version()` still says "Windows 10" on Windows 11; build 22000 and up is 11. */
function windowsOs(
  osVersion: () => string,
  osRelease: () => string,
): FleetHostOs {
  let name = "";
  let version: string | null = null;
  try {
    name = osVersion().trim();
  } catch {
    // name stays empty
  }
  try {
    version = osRelease().trim() || null;
  } catch {
    // version stays null
  }
  const build = Number(version?.split(".")[2]);
  if (
    Number.isFinite(build) &&
    build >= 22000 &&
    name.startsWith("Windows 10")
  ) {
    name = `Windows 11${name.slice("Windows 10".length)}`;
  }
  return { name: name || "Windows", version };
}

/** The member's OS for `fleet:hostReport`; never throws, any failure lands on the platform fallback. */
export async function detectHostOs(
  deps: HostProbeDeps = {},
): Promise<FleetHostOs> {
  const platform = deps.platform ?? process.platform;
  const osRelease = deps.osRelease ?? os.release;
  switch (platform) {
    case "linux":
      return linuxOs(deps.readFile ?? ((p) => fs.promises.readFile(p, "utf8")));
    case "darwin":
      return darwinOs(deps.run ?? defaultRun);
    case "win32":
      return windowsOs(deps.osVersion ?? os.version, osRelease);
    default: {
      let name = platform as string;
      let version: string | null = null;
      try {
        name = (deps.osType ?? os.type)() || name;
        version = osRelease() || null;
      } catch {
        // keep what was read
      }
      return { name, version };
    }
  }
}

interface ManagerFallback {
  /** Environment variable the path sits under; absent means `path` is absolute. */
  env?: string;
  path: string;
}

interface ManagerProbe {
  name: string;
  binary: string;
  fallbacks: ManagerFallback[];
  /** Not reported when this manager was found (yum is dnf's compatibility name). */
  unless?: string;
}

const PACKAGE_MANAGER_TABLE: Partial<Record<NodeJS.Platform, ManagerProbe[]>> =
  {
    linux: [
      { name: "dnf", binary: "dnf", fallbacks: [] },
      { name: "yum", binary: "yum", fallbacks: [], unless: "dnf" },
      { name: "apt", binary: "apt-get", fallbacks: [] },
      { name: "zypper", binary: "zypper", fallbacks: [] },
      { name: "pacman", binary: "pacman", fallbacks: [] },
      { name: "apk", binary: "apk", fallbacks: [] },
      {
        name: "brew",
        binary: "brew",
        fallbacks: [{ path: "/home/linuxbrew/.linuxbrew/bin/brew" }],
      },
      { name: "flatpak", binary: "flatpak", fallbacks: [] },
      { name: "snap", binary: "snap", fallbacks: [] },
    ],
    darwin: [
      {
        name: "brew",
        binary: "brew",
        fallbacks: [
          { path: "/opt/homebrew/bin/brew" },
          { path: "/usr/local/bin/brew" },
        ],
      },
      {
        name: "port",
        binary: "port",
        fallbacks: [{ path: "/opt/local/bin/port" }],
      },
    ],
    win32: [
      {
        name: "winget",
        binary: "winget.exe",
        fallbacks: [
          { env: "LOCALAPPDATA", path: "Microsoft\\WindowsApps\\winget.exe" },
        ],
      },
      {
        name: "choco",
        binary: "choco.exe",
        fallbacks: [
          { env: "ChocolateyInstall", path: "bin\\choco.exe" },
          { env: "ProgramData", path: "chocolatey\\bin\\choco.exe" },
        ],
      },
      {
        name: "scoop",
        binary: "scoop.cmd",
        fallbacks: [
          { env: "SCOOP", path: "shims\\scoop.cmd" },
          { env: "USERPROFILE", path: "scoop\\shims\\scoop.cmd" },
        ],
      },
    ],
  };

/** Windows environment names are case-insensitive; everywhere else they are exact. */
function envValue(
  env: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== "win32") return env[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === lower) return env[key];
  }
  return undefined;
}

/**
 * Package managers found on this host, in table order. PATH is the one fleet
 * exec children inherit; a manager found only at a known install location is
 * reported with `onPath: false`. Path handling follows `platform`, so the
 * probe runs on any host under test.
 */
export async function detectPackageManagers(
  deps: HostProbeDeps = {},
): Promise<FleetPackageManager[]> {
  const platform = deps.platform ?? process.platform;
  const table = PACKAGE_MANAGER_TABLE[platform];
  if (table === undefined) return [];
  const env = deps.env ?? process.env;
  const isExecutableFile = deps.isExecutableFile ?? defaultIsExecutableFile;
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const pathDirs = (envValue(env, "PATH", platform) ?? "")
    .split(pathApi.delimiter)
    .filter((dir) => dir !== "");

  const probe = async (
    manager: ManagerProbe,
  ): Promise<FleetPackageManager | null> => {
    for (const dir of pathDirs) {
      const candidate = pathApi.join(dir, manager.binary);
      if (await isExecutableFile(candidate))
        return { name: manager.name, path: candidate, onPath: true };
    }
    for (const fallback of manager.fallbacks) {
      let candidate = fallback.path;
      if (fallback.env !== undefined) {
        const base = envValue(env, fallback.env, platform);
        if (base === undefined || base === "") continue;
        candidate = pathApi.join(base, fallback.path);
      }
      if (await isExecutableFile(candidate))
        return { name: manager.name, path: candidate, onPath: false };
    }
    return null;
  };

  const found = await Promise.all(table.map(probe));
  const names = new Set(found.flatMap((m) => (m === null ? [] : [m.name])));
  return found.filter(
    (m, i): m is FleetPackageManager =>
      m !== null &&
      (table[i].unless === undefined || !names.has(table[i].unless)),
  );
}
