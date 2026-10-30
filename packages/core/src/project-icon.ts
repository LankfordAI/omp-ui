import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { ProjectIcon } from "./types";

/**
 * Project icons (issue #1000): the favicon or app icon a project's checkout
 * already carries, turned into a small `data:` URL the owning instance puts on
 * its `ProjectRecord`, so the monogram box can paint it in place of initials
 * on this app and on every joined remote instance alike.
 *
 * Decoding raster pixels needs Electron's `nativeImage` (ADR-0002 keeps it out
 * of core), so callers inject a `RasterNormalizer`. Everything else — where to
 * look, what the bytes really are, ICO entry selection, size caps — lives here.
 */

/** Longest edge, in pixels, of a normalized raster icon. */
export const PROJECT_ICON_PX = 64;

/** Files larger than this are never read as icon candidates. */
export const PROJECT_ICON_MAX_SOURCE_BYTES = 1024 * 1024;

/**
 * Formats the normalizer cannot re-encode (SVG, GIF, WebP, a single-image
 * ICO) ride through as-is only up to this size: every icon is part of every
 * state broadcast, so a large one is skipped rather than shipped.
 */
export const PROJECT_ICON_PASSTHROUGH_BYTES = 16 * 1024;

/** A normalized icon's PNG may not exceed this either. */
const MAX_NORMALIZED_BYTES = 32 * 1024;

/**
 * PNG or JPEG bytes in, PNG bytes whose longest edge is at most
 * `PROJECT_ICON_PX` out; null when the bytes do not decode.
 */
export type RasterNormalizer = (bytes: Uint8Array) => Uint8Array | null;

const EXTENSIONS = ["svg", "png", "ico", "webp", "jpg", "jpeg", "gif"] as const;

/**
 * Where detection looks, first hit wins: the locations the common web and app
 * scaffolds put their favicon or app icon (Next.js `app/` with or without
 * `src/`, Vite/CRA `public/`, SvelteKit `static/`, generic `assets/`), each
 * vector-first so the sharpest source of one location wins.
 */
export const PROJECT_ICON_CANDIDATES: readonly string[] = [
  "favicon.ico",
  ...EXTENSIONS.map((ext) => `public/favicon.${ext}`),
  ...EXTENSIONS.map((ext) => `app/icon.${ext}`),
  "app/favicon.ico",
  ...EXTENSIONS.map((ext) => `src/app/icon.${ext}`),
  "src/app/favicon.ico",
  ...EXTENSIONS.map((ext) => `static/favicon.${ext}`),
  ...EXTENSIONS.map((ext) => `assets/icon.${ext}`),
];

export type IconMime = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/svg+xml" | "image/x-icon";

/** What the bytes are, from their own signature — never from a file name. */
export function sniffIconMime(bytes: Uint8Array): IconMime | null {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const riff = String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  if (riff && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (at(0) === 0x47 && at(1) === 0x49 && at(2) === 0x46 && at(3) === 0x38) return "image/gif";
  if (at(0) === 0 && at(1) === 0 && at(2) === 1 && at(3) === 0 && (at(4) > 0 || at(5) > 0)) return "image/x-icon";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

/**
 * The one ICO entry worth showing at monogram size: the one closest to
 * `PROJECT_ICON_PX` (an exact match beats a larger one, which beats a smaller
 * one; deeper colour breaks ties). A PNG-compressed entry comes back as plain
 * PNG; a bitmap entry comes back as a rebuilt single-image ICO, which the
 * renderer's `<img>` decodes itself. Null for a malformed directory.
 */
export function icoBestImage(bytes: Uint8Array): { mime: "image/png" | "image/x-icon"; bytes: Uint8Array } | null {
  if (bytes.length < 6) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(0, true) !== 0 || view.getUint16(2, true) !== 1) return null;
  const count = view.getUint16(4, true);
  let best: { entry: number; width: number; bpp: number; size: number; offset: number } | null = null;
  for (let i = 0; i < count; i++) {
    const entry = 6 + i * 16;
    if (entry + 16 > bytes.length) return null;
    const width = view.getUint8(entry) || 256;
    const bpp = view.getUint16(entry + 6, true);
    const size = view.getUint32(entry + 8, true);
    const offset = view.getUint32(entry + 12, true);
    if (size === 0 || offset + size > bytes.length) continue;
    const candidate = { entry, width, bpp, size, offset };
    if (best === null || icoRank(candidate) < icoRank(best)) best = candidate;
  }
  if (best === null) return null;
  const data = bytes.subarray(best.offset, best.offset + best.size);
  if (sniffIconMime(data) === "image/png") return { mime: "image/png", bytes: data };
  const out = new Uint8Array(22 + data.length);
  const outView = new DataView(out.buffer);
  outView.setUint16(2, 1, true);
  outView.setUint16(4, 1, true);
  out.set(bytes.subarray(best.entry, best.entry + 12), 6);
  outView.setUint32(18, 22, true);
  out.set(data, 22);
  return { mime: "image/x-icon", bytes: out };
}

/** Lower is better: distance from the target size (undersized costs double), then colour depth. */
function icoRank({ width, bpp }: { width: number; bpp: number }): number {
  const distance = width >= PROJECT_ICON_PX ? width - PROJECT_ICON_PX : 2 * (PROJECT_ICON_PX - width);
  return distance * 64 - Math.min(bpp, 32);
}

function toDataUrl(mime: IconMime, bytes: Uint8Array): string {
  return `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`;
}

/**
 * The icon `data:` URL for one image's bytes, or null when the bytes are not
 * an image this can show at monogram size. PNG and JPEG are always
 * normalized; the other formats pass through under the size cap.
 */
export function projectIconDataUrl(bytes: Uint8Array, normalize: RasterNormalizer): string | null {
  const mime = sniffIconMime(bytes);
  if (mime === null) return null;
  if (mime === "image/x-icon") {
    const best = icoBestImage(bytes);
    if (best === null) return null;
    if (best.mime === "image/png") return projectIconDataUrl(best.bytes, normalize);
    return best.bytes.length <= PROJECT_ICON_PASSTHROUGH_BYTES ? toDataUrl(best.mime, best.bytes) : null;
  }
  if (mime === "image/png" || mime === "image/jpeg") {
    const png = normalize(bytes);
    return png !== null && png.length > 0 && png.length <= MAX_NORMALIZED_BYTES ? toDataUrl("image/png", png) : null;
  }
  return bytes.length <= PROJECT_ICON_PASSTHROUGH_BYTES ? toDataUrl(mime, bytes) : null;
}

/**
 * Detection: the first candidate under `root` that is a regular file within
 * the source cap and yields an icon. A candidate that exists but does not
 * decode is skipped, so a broken `favicon.ico` falls through to the next
 * location. Null when nothing qualifies.
 */
export async function detectProjectIcon(
  root: string,
  normalize: RasterNormalizer,
): Promise<Extract<ProjectIcon, { source: "detected" }> | null> {
  for (const file of PROJECT_ICON_CANDIDATES) {
    const full = path.join(root, ...file.split("/"));
    let bytes: Uint8Array;
    try {
      const stat = await fs.stat(full);
      if (!stat.isFile() || stat.size === 0 || stat.size > PROJECT_ICON_MAX_SOURCE_BYTES) continue;
      bytes = await fs.readFile(full);
    } catch {
      continue;
    }
    const dataUrl = projectIconDataUrl(bytes, normalize);
    if (dataUrl !== null) return { source: "detected", file, dataUrl };
  }
  return null;
}

const DATA_URL = /^data:image\/(png|jpeg|gif|webp|svg\+xml|x-icon);base64,[A-Za-z0-9+/]+=*$/;

/** Structural guard for a persisted or proxied icon; the registry's parse and the arg codec share it. */
export function isProjectIcon(value: unknown): value is ProjectIcon {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  switch (v.source) {
    case "none":
      return Object.keys(v).length === 1;
    case "custom":
      return Object.keys(v).length === 2 && typeof v.dataUrl === "string" && DATA_URL.test(v.dataUrl);
    case "detected":
      return (
        Object.keys(v).length === 3 &&
        typeof v.file === "string" &&
        PROJECT_ICON_CANDIDATES.includes(v.file) &&
        typeof v.dataUrl === "string" &&
        DATA_URL.test(v.dataUrl)
      );
    default:
      return false;
  }
}
