import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { parseSemver, type FetchLike } from "./omp-update";
import type { AppPackageFormat } from "./types";

// Pure, transport- and UI-agnostic omp-ui release update logic. The Electron
// main process drives this over IPC; nothing here touches Electron (ADR-0002).
// The AppImage in-place path (electron-updater) lives in the main process —
// this module owns the shared parts: release lookup, package-format
// detection, and the checksum-verified download the deb/rpm/Flatpak paths use.

export const APP_GITHUB_REPO = "LankfordAI/omp-ui";
export const APP_LATEST_RELEASE_URL =
  "https://api.github.com/repos/LankfordAI/omp-ui/releases/latest";
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

const defaultFetch = fetch as unknown as FetchLike;

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
 * How this omp-ui install was packaged, best-effort: APPIMAGE env → appimage;
 * /.flatpak-info exists → flatpak; /usr/bin/dpkg exists → deb; /usr/bin/rpm
 * exists → rpm; else unknown. Precedence is in that order (a dual dpkg+rpm
 * system reads as deb — the common Debian-derived case).
 */
export function detectPackageFormat(
  env: NodeJS.ProcessEnv = process.env,
  exists: (p: string) => boolean = fs.existsSync,
): AppPackageFormat {
  if (env.APPIMAGE) return "appimage";
  if (exists("/.flatpak-info")) return "flatpak";
  if (exists("/usr/bin/dpkg")) return "deb";
  if (exists("/usr/bin/rpm")) return "rpm";
  return "unknown";
}

/**
 * The exact asset name electron-builder/release.yml publishes for a
 * format+version (from packages/desktop/electron-builder.yml artifactName
 * rules and the Flatpak assemble step in release.yml). AppImage/unknown never
 * go through asset download, so they are not representable here.
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

export async function sha256Hex(data: Buffer): Promise<string> {
  return crypto.createHash("sha256").update(data).digest("hex");
}

/**
 * Streaming fetch surface for large assets (real global fetch satisfies it).
 * `headers`/`body` are optional so plain JSON/arrayBuffer test doubles also
 * satisfy it — callers fall back to indeterminate progress and arrayBuffer().
 */
export interface DownloadFetchLike {
  (url: string, init?: { signal?: AbortSignal }): Promise<{
    ok: boolean;
    status: number;
    headers?: { get(name: string): string | null };
    body?: {
      getReader(): {
        read(): Promise<{ done: boolean; value?: Uint8Array }>;
      };
    } | null;
    arrayBuffer(): Promise<ArrayBuffer>;
  }>;
}

const defaultDownloadFetch = fetch as unknown as DownloadFetchLike;

/**
 * Streams a release asset to `targetPath`, written atomically (temp file +
 * rename, same idiom as downloadOmp) so a partial download never leaves a
 * truncated artifact behind. The full bytes are verified against
 * `expectedSha256`; on mismatch or HTTP failure the tmp file is removed and
 * the error propagates. `onProgress(percent | null)` fires per chunk (null
 * when the response carries no content-length). Falls back to arrayBuffer()
 * when the body is null.
 */
export async function downloadAppAsset(opts: {
  url: string;
  targetPath: string;
  expectedSha256: string;
  fetchImpl?: DownloadFetchLike;
  onProgress?: (percent: number | null) => void;
}): Promise<void> {
  const res = await (opts.fetchImpl ?? defaultDownloadFetch)(opts.url, {
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (!res.ok) {
    throw new Error(`failed to download ${path.basename(opts.targetPath)}: HTTP ${res.status}`);
  }
  const lengthHeader = res.headers?.get?.("content-length") ?? null;
  const total = lengthHeader === null ? NaN : Number(lengthHeader);
  const track = Number.isFinite(total) && total > 0;
  if (!track) opts.onProgress?.(null);

  let buf: Buffer;
  if (res.body) {
    const reader = res.body.getReader();
    const chunks: Buffer[] = [];
    let read = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value ?? new Uint8Array());
      chunks.push(chunk);
      read += chunk.length;
      if (track) opts.onProgress?.(Math.floor((read / total) * 100));
    }
    buf = Buffer.concat(chunks);
  } else {
    buf = Buffer.from(await res.arrayBuffer());
  }

  await fs.promises.mkdir(path.dirname(opts.targetPath), { recursive: true });
  const tmp = `${opts.targetPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2)}`;
  await fs.promises.writeFile(tmp, buf);
  const actual = await sha256Hex(buf);
  if (actual.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
    await fs.promises.rm(tmp, { force: true });
    throw new Error(`checksum mismatch for ${path.basename(opts.targetPath)}`);
  }
  await fs.promises.rename(tmp, opts.targetPath);
}
