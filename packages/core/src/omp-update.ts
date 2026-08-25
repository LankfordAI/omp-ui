import { execFile } from "node:child_process";
import { downloadFileAtomically } from "./download";
import { defaultFetch, type DownloadFetchLike, type FetchLike } from "./fetch";
import { resolveOmpBinary } from "./paths";
import type { OmpUpdateInfo } from "./types";

// Pure, transport- and UI-agnostic omp install/update logic. The Electron main
// process (or a future packages/server) drives this over IPC/dialogs; nothing
// here touches Electron.

export const OMP_NPM_LATEST_URL =
  "https://registry.npmjs.org/@oh-my-pi/pi-coding-agent/latest";
export const OMP_GITHUB_REPO = "can1357/oh-my-pi";
export const OMP_RELEASE_BASE = `https://github.com/${OMP_GITHUB_REPO}/releases/download`;

export interface Semver {
  major: number;
  minor: number;
  patch: number;
}

/** Parses an optional `v`-prefixed `X.Y.Z` (extra segments ignored). */
export function parseSemver(value: string): Semver | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(value).trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

/** -1 when a < b, 0 when equal, 1 when a > b. Unparseable sorts lowest. */
export function compareVersions(a: string, b: string): number {
  const A = parseSemver(a);
  const B = parseSemver(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (A[key] !== B[key]) return A[key] < B[key] ? -1 : 1;
  }
  return 0;
}

/** Extracts `omp/<X.Y.Z>` (the shape of `omp --version`) from output. */
export function parseOmpVersion(output: string): string | null {
  const raw = /omp\/(\S+)/.exec(output)?.[1];
  if (!raw) return null;
  const s = parseSemver(raw);
  return s ? `${s.major}.${s.minor}.${s.patch}` : null;
}

/**
 * The GitHub release asset name for a platform/arch, matching omp's own
 * installer (`omp-<platform>-<arch>`, `.exe` on Windows). Null on an
 * unsupported combination.
 */
export function ompAssetName(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  const p =
    platform === "linux" ? "linux" : platform === "darwin" ? "darwin" : platform === "win32" ? "windows" : null;
  const a = arch === "x64" || arch === "arm64" ? arch : arch === "ia32" ? "x64" : null;
  if (!p || !a) return null;
  return `omp-${p}-${a}${p === "windows" ? ".exe" : ""}`;
}


/** Runs `omp --version` and resolves with its stdout. Inject for tests. */
export type VersionRunner = (ompPath: string) => Promise<string>;

export const execVersionRunner: VersionRunner = (ompPath) =>
  new Promise((resolve, reject) => {
    execFile(ompPath, ["--version"], { timeout: 10_000 }, (err, stdout) => {
      if (err) reject(err);
      else resolve(stdout);
    });
  });

/** Reads the installed version, or null when the run fails. */
export async function readInstalledOmpVersion(
  ompPath: string,
  runner: VersionRunner = execVersionRunner,
): Promise<string | null> {
  try {
    return parseOmpVersion(await runner(ompPath));
  } catch {
    return null;
  }
}

/** Latest published omp version from the npm registry, or null on failure. */
export async function fetchLatestOmpVersion(
  fetchImpl: FetchLike = defaultFetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(OMP_NPM_LATEST_URL);
    if (!res.ok) return null;
    const body = (await res.json()) as { version?: unknown };
    if (typeof body?.version !== "string") return null;
    const s = parseSemver(body.version);
    return s ? `${s.major}.${s.minor}.${s.patch}` : null;
  } catch {
    return null;
  }
}

/**
 * Downloads the prebuilt omp binary for this host and validates the temporary
 * executable before atomically replacing the managed copy.
 */
export async function downloadOmp(opts: {
  version: string;
  targetPath: string;
  fetchImpl?: DownloadFetchLike;
  /**
   * Verifies the downloaded file actually runs as omp before it shadows any
   * existing copy. Defaults to {@link execVersionRunner}; pass `null` to skip
   * (low-level callers/tests that write a stub body).
   */
  verifyRunner?: VersionRunner | null;
  onProgress?: (percent: number | null) => void;
}): Promise<void> {
  const asset = ompAssetName();
  if (!asset) {
    throw new Error(`unsupported platform/arch for omp binary (${process.platform}/${process.arch})`);
  }
  const version = opts.version.replace(/^v/, "");
  await downloadFileAtomically({
    url: `${OMP_RELEASE_BASE}/v${version}/${asset}`,
    targetPath: opts.targetPath,
    description: `omp ${version}`,
    fetchImpl: opts.fetchImpl,
    mode: process.platform === "win32" ? undefined : 0o755,
    onProgress: opts.onProgress,
    validateTemp:
      opts.verifyRunner === null
        ? undefined
        : async (tempPath) => {
            const runner = opts.verifyRunner ?? execVersionRunner;
            // The managed copy outranks PATH, so only commit a candidate that
            // proves it can execute as omp.
            const installed = await readInstalledOmpVersion(tempPath, runner);
            if (installed === null) {
              throw new Error(`downloaded omp binary failed validation (${tempPath})`);
            }
          },
  });
}

/**
 * One-shot snapshot of the omp install/update situation. Non-fatal failures
 * (no network, `--version` failing) degrade individual fields instead of
 * throwing; only unexpected wiring errors land in `error`.
 */
export async function checkOmpUpdate(opts: {
  installPath?: string | null;
  fetchImpl?: FetchLike;
  runner?: VersionRunner;
} = {}): Promise<OmpUpdateInfo> {
  const installPath = opts.installPath !== undefined ? opts.installPath : resolveOmpBinary();
  const info: OmpUpdateInfo = {
    installPath,
    installedVersion: null,
    latestVersion: null,
    updateAvailable: false,
    error: null,
  };
  try {
    if (installPath) info.installedVersion = await readInstalledOmpVersion(installPath, opts.runner);
    info.latestVersion = await fetchLatestOmpVersion(opts.fetchImpl);
    if (info.latestVersion !== null && info.installedVersion !== null) {
      info.updateAvailable = compareVersions(info.installedVersion, info.latestVersion) < 0;
    }
  } catch (e) {
    info.error = e instanceof Error ? e.message : String(e);
  }
  return info;
}
