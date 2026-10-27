import * as fs from "node:fs";
import * as path from "node:path";
import { downloadFileAtomically } from "./download";
import { defaultFetch, type DownloadFetchLike, type FetchLike } from "./fetch";
import { compareVersions, parseSemver } from "./semver";
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
/** Fixed release pages the update card hands off to when the feed's release
 *  cannot be read (issue #930) — never a URL taken from the refused body. */
export const APP_LATEST_RELEASE_PAGE_URL = `https://github.com/${APP_GITHUB_REPO}/releases/latest`;
export const APP_NIGHTLY_RELEASE_PAGE_URL = `https://github.com/${APP_GITHUB_REPO}/releases/tag/nightly`;

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

/** One release lookup: the parsed release, a feed that could not be reached
 *  (network, timeout, non-OK HTTP, non-JSON body), or a feed that answered
 *  with a release this build refuses to parse, plus the fixed page to open. */
export type AppReleaseLookup =
  | { kind: "release"; release: AppReleaseInfo }
  | { kind: "unreachable" }
  | { kind: "unreadable"; page: string };


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

/** nightly.yml stamps `Nightly <X.Y.Z-nightly.YYYYMMDDTHHMMSS.sha7>` as the release
 *  title (the publish step titles the release exactly `Nightly ${VERSION}`);
 *  anything else is not a nightly we can trust. The optional `T<HHMMSS>` is the
 *  #929 stamp: builds published before it shipped carry the old date-only form,
 *  and installs out there in the wild must still be able to read the rolling
 *  release, so both shapes parse. */
const NIGHTLY_TITLE_RE = /^Nightly (\d+\.\d+\.\d+-nightly\.\d{8}(?:T\d{6})?\.[0-9a-f]{7})$/;

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

async function lookupRelease(
  apiUrl: string,
  page: string,
  parse: (body: unknown) => AppReleaseInfo | null,
  fetchImpl: FetchLike,
): Promise<AppReleaseLookup> {
  let body: unknown;
  try {
    const res = await fetchImpl(apiUrl, { signal: AbortSignal.timeout(10_000) });
    // 403/429 rate limits; 404 when only prereleases exist (stable) or while
    // nightly.yml recreates the rolling release.
    if (!res.ok) return { kind: "unreachable" };
    body = await res.json();
  } catch {
    return { kind: "unreachable" };
  }
  const release = parse(body);
  return release === null ? { kind: "unreadable", page } : { kind: "release", release };
}

/** Rolling nightly prerelease lookup (issue #493). 10s timeout. */
export async function fetchNightlyAppRelease(
  fetchImpl: FetchLike = defaultFetch,
): Promise<AppReleaseLookup> {
  return lookupRelease(APP_NIGHTLY_RELEASE_URL, APP_NIGHTLY_RELEASE_PAGE_URL, parseNightlyRelease, fetchImpl);
}

const APP_VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:-nightly\.(\d{8})(?:T(\d{6}))?\.([0-9a-f]{7}))?$/;

/**
 * Train-aware version ordering (issue #493). Base X.Y.Z decides first. At
 * equal base, nightly ranks newer on the nightly train and bare stable ranks
 * newer on the stable train. Two nightlies order by stamp — date, then the
 * `T<HHMMSS>` build time (#929), then sha as the last resort — with an
 * old date-only stamp ranking below every same-day stamped build.
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
    // Same day: the UTC build time orders nightlies (issue #929 — sha7 is
    // not chronological, so hex luck used to hide newer same-day builds).
    const aTime = A[5] ?? "000000";
    const bTime = B[5] ?? "000000";
    if (aTime !== bTime) return aTime < bTime ? -1 : 1;
    if (A[6] !== B[6]) return A[6]! < B[6]! ? -1 : 1;
    return 0;
  }
  if (aNightly === bNightly) return 0;
  const nightlyNewer = train === "nightly";
  return aNightly === nightlyNewer ? 1 : -1;
}

/** Latest stable release lookup. 10s timeout. */
export async function fetchLatestAppRelease(
  fetchImpl: FetchLike = defaultFetch,
): Promise<AppReleaseLookup> {
  return lookupRelease(APP_LATEST_RELEASE_URL, APP_LATEST_RELEASE_PAGE_URL, parseLatestRelease, fetchImpl);
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
