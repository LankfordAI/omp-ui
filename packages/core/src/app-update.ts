import * as fs from "node:fs";
import * as path from "node:path";
import { downloadFileAtomically } from "./download";
import { defaultFetch, type DownloadFetchLike, type FetchLike } from "./fetch";
import { compareVersions, parseSemver } from "./omp-update";
import type { AppPackageFormat, UpdateTrain } from "./types";

// Pure, transport- and UI-agnostic omp-ui release update logic. The Electron
// main process drives this over IPC; nothing here touches Electron (ADR-0002).
// The auto-updatable AppImage/NSIS/macOS-zip path (electron-updater) lives in
// the main process — this module owns the shared parts: release lookup,
// package-format detection, and the checksum-verified download the
// deb/rpm/Flatpak paths use.

export const APP_GITHUB_REPO = "LankfordAI/omp-ui";
export const APP_LATEST_RELEASE_URL =
  "https://api.github.com/repos/LankfordAI/omp-ui/releases/latest";
export const APP_NIGHTLY_RELEASE_URL =
  "https://api.github.com/repos/LankfordAI/omp-ui/releases/tags/nightly";
export const APP_RELEASE_DOWNLOAD_BASE =
  `https://github.com/${APP_GITHUB_REPO}/releases/download`;

export interface AppReleaseInfo {
  /** Normalized X.Y.Z (v-prefix stripped). */
  version: string;
  /** Original tag_name, e.g. "v0.2.0". */
  tag: string;
  /** html_url of the release page. */
  url: string;
  /** Release display name, null when absent. */
  name: string | null;
  /** Asset file names only. */
  assets: string[];
}


/**
 * Validated parse of GET /releases/latest. Null on malformed, draft, or
 * prerelease. (`/releases/latest` never returns drafts/prereleases and
 * releaseType "release" never creates them, but the guard keeps a hand-made
 * or proxy-mangled body from ever producing an "update" prompt.)
 */
export function parseLatestRelease(body: unknown): AppReleaseInfo | null {
  if (body === null || typeof body !== "object") return null;
  if (!("tag_name" in body) || typeof body.tag_name !== "string") return null;
  const semver = parseSemver(body.tag_name);
  if (!semver) return null;
  if (!("html_url" in body) || typeof body.html_url !== "string") return null;
  if (("draft" in body && body.draft === true) || ("prerelease" in body && body.prerelease === true)) {
    return null;
  }
  const assets =
    "assets" in body && Array.isArray(body.assets)
      ? body.assets
          .filter((a): a is { name: string } =>
            a !== null && typeof a === "object" && "name" in a && typeof a.name === "string",
          )
          .map((a) => a.name)
      : [];
  const name = "name" in body && typeof body.name === "string" ? body.name : null;
  return {
    version: `${semver.major}.${semver.minor}.${semver.patch}`,
    tag: body.tag_name,
    url: body.html_url,
    name,
    assets,
  };
}

/** nightly.yml stamps `Nightly <X.Y.Z-nightly.YYYYMMDD.sha7>` as the release title. */
const NIGHTLY_TITLE_RE = /(\d+\.\d+\.\d+-nightly\.\d{8}\.[0-9a-f]{7})/;

/** Validated parse of GET /releases/tags/nightly (issue #493). */
export function parseNightlyRelease(body: unknown): AppReleaseInfo | null {
  if (body === null || typeof body !== "object") return null;
  if (!("tag_name" in body) || typeof body.tag_name !== "string") return null;
  if (!("html_url" in body) || typeof body.html_url !== "string") return null;
  if (!("prerelease" in body) || body.prerelease !== true) return null;
  if ("draft" in body && body.draft === true) return null;
  if (!("name" in body) || typeof body.name !== "string") return null;
  const version = NIGHTLY_TITLE_RE.exec(body.name)?.[1];
  if (version === undefined) return null;
  const assets =
    "assets" in body && Array.isArray(body.assets)
      ? body.assets
          .filter((a): a is { name: string } =>
            a !== null && typeof a === "object" && "name" in a && typeof a.name === "string",
          )
          .map((a) => a.name)
      : [];
  return { version, tag: body.tag_name, url: body.html_url, name: body.name, assets };
}

/** Rolling nightly prerelease, or null on any network/HTTP/parse failure. */
export async function fetchNightlyAppRelease(
  fetchImpl: FetchLike = defaultFetch,
): Promise<AppReleaseInfo | null> {
  try {
    const res = await fetchImpl(APP_NIGHTLY_RELEASE_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseNightlyRelease(await res.json());
  } catch {
    return null;
  }
}

const APP_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})\.([0-9a-f]{7}))?/;

/**
 * Train-aware version ordering (issue #493). Base X.Y.Z decides first. At
 * equal base, nightly ranks newer on the nightly train and bare stable ranks
 * newer on the stable train. Two nightlies order by date, then sha.
 * Unparseable versions sort lowest, mirroring compareVersions.
 */
export function compareAppVersions(a: string, b: string, train: UpdateTrain): number {
  const A = APP_VERSION_RE.exec(a);
  const B = APP_VERSION_RE.exec(b);
  if (!A && !B) return 0;
  if (!A) return -1;
  if (!B) return 1;
  const base = compareVersions(`${A[1]}.${A[2]}.${A[3]}`, `${B[1]}.${B[2]}.${B[3]}`);
  if (base !== 0) return base;
  const aNightly = A[4] !== undefined;
  const bNightly = B[4] !== undefined;
  if (aNightly && bNightly) {
    if (A[4] !== B[4]) return A[4]! < B[4]! ? -1 : 1;
    if (A[5] !== B[5]) return A[5]! < B[5]! ? -1 : 1;
    return 0;
  }
  if (aNightly === bNightly) return 0;
  const nightlyNewer = train === "nightly";
  return aNightly === nightlyNewer ? 1 : -1;
}

/** Latest stable release, or null on any network/HTTP/parse failure. 10s timeout. */
export async function fetchLatestAppRelease(
  fetchImpl: FetchLike = defaultFetch,
): Promise<AppReleaseInfo | null> {
  try {
    const res = await fetchImpl(APP_LATEST_RELEASE_URL, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null; // 403/429 rate limits, 404 when only prereleases exist
    return parseLatestRelease(await res.json());
  } catch {
    return null;
  }
}

/**
 * How this install updates. Windows packages are NSIS. macOS DMG installs
 * auto-update through the ZIP feed Squirrel.Mac consumes. Linux preserves the
 * APPIMAGE → Flatpak → deb → rpm precedence; other platforms are unknown.
 */
export function detectPackageFormat(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
  platform: NodeJS.Platform = process.platform,
): AppPackageFormat {
  if (platform === "win32") return "nsis";
  if (platform === "darwin") return "maczip";
  if (platform !== "linux") return "unknown";
  if (env.APPIMAGE) return "appimage";
  if (exists("/.flatpak-info")) return "flatpak";
  if (exists("/usr/bin/dpkg")) return "deb";
  if (exists("/usr/bin/rpm")) return "rpm";
  return "unknown";
}

/**
 * The exact asset name electron-builder/release.yml publishes for a
 * format+version (from packages/desktop/electron-builder.yml artifactName
 * rules and the Flatpak assemble step in release.yml). Auto-update/unknown
 * formats never go through asset download, so they are not representable here.
 */
export function expectedAssetName(
  format: "deb" | "rpm" | "flatpak",
  version: string,
): string {
  switch (format) {
    case "deb":
      return `omp-ui_${version}_amd64.deb`;
    case "rpm":
      return `omp-ui-${version}.x86_64.rpm`;
    case "flatpak":
      return `omp-ui-${version}-x86_64.flatpak`;
  }
}

/**
 * Selects the asset to download: the exact expected name MUST appear in
 * release.assets — never pick by suffix/similarity, so a crafted or
 * mis-named asset is never executed. Null when absent.
 */
export function selectAsset(
  release: AppReleaseInfo,
  format: "deb" | "rpm" | "flatpak",
): string | null {
  const expected = expectedAssetName(format, release.version);
  return release.assets.includes(expected) ? expected : null;
}

/** Parses `sha256sum` output (`<hex>  <name>` per line; blanks skipped). */
export function parseSha256Sums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const m = /^([0-9a-fA-F]{64}) [ *]?(.+)$/.exec(trimmed);
    if (m) sums.set(m[2], m[1].toLowerCase());
  }
  return sums;
}

/** SHA256SUMS.txt for a tag, or null on any failure. */
export async function fetchSha256Sums(
  tag: string,
  fetchImpl: FetchLike = defaultFetch,
): Promise<Map<string, string> | null> {
  try {
    const res = await fetchImpl(`${APP_RELEASE_DOWNLOAD_BASE}/${tag}/SHA256SUMS.txt`, {
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    return parseSha256Sums(Buffer.from(await res.arrayBuffer()).toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Downloads and checksum-verifies a release asset before atomically replacing
 * the target. The shared downloader owns streaming, progress, and cleanup.
 */
export async function downloadAppAsset(opts: {
  url: string;
  targetPath: string;
  expectedSha256: string;
  fetchImpl?: DownloadFetchLike;
  onProgress?: (percent: number | null) => void;
}): Promise<void> {
  await downloadFileAtomically({
    url: opts.url,
    targetPath: opts.targetPath,
    description: path.basename(opts.targetPath),
    expectedSha256: opts.expectedSha256,
    fetchImpl: opts.fetchImpl,
    onProgress: opts.onProgress,
  });
}
