// Theme backdrops (issue #1168): the reference a stored theme carries, the
// byte checks every authoring route runs, and the plane-opacity floors that
// keep text readable over any backdrop pixel. Pure — the renderer imports it.
import { isObject } from "./guards";
import { contrastRatio, mixHex, type ThemeTokenName } from "./theme";

export type ThemeBackdropImageMime = "image/png" | "image/jpeg" | "image/webp";
export type ThemeBackdropSceneMime = "image/svg+xml";
export type ThemeBackdropVideoMime = "video/mp4" | "video/webm";
export type ThemeBackdropMime = ThemeBackdropImageMime | ThemeBackdropSceneMime | ThemeBackdropVideoMime;
export type ThemeBackdropKind = "image" | "scene" | "video";

export interface ThemeBackdrop {
  /** Lowercase hex SHA-256 of the stored bytes. */
  assetHash: string;
  kind: ThemeBackdropKind;
  mime: ThemeBackdropMime;
  /** 0-32: px of blur applied once to the backdrop layer. */
  blur: number;
}

/** A backdrop asset's bytes on the wire: base64, as every other binary here travels. */
export interface ThemeBackdropBytes {
  mime: ThemeBackdropMime;
  data: string;
}

export const BACKDROP_IMAGE_BYTES_MAX = 4 * 1024 * 1024;
export const BACKDROP_SCENE_BYTES_MAX = 4 * 1024 * 1024;
export const BACKDROP_VIDEO_BYTES_MAX = 16 * 1024 * 1024;
export const BACKDROP_BYTES_MAX = Math.max(
  BACKDROP_IMAGE_BYTES_MAX,
  BACKDROP_SCENE_BYTES_MAX,
  BACKDROP_VIDEO_BYTES_MAX,
);
export const BACKDROP_BLUR_MAX = 32;
export const BACKDROP_DEFAULT_BLUR = 12;
export const BACKDROP_SCENE_FRAME_NAME = "omp-backdrop-scene";

const ASSET_HASH = /^[0-9a-f]{64}$/;
const BACKDROP_KEYS = ["assetHash", "kind", "mime", "blur"];
/** Retired with the scrim (#1187): rows and files written before carry it; readers accept and drop it. */
export const LEGACY_DIM_KEY = "dim";
const MIMES: readonly ThemeBackdropMime[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/svg+xml",
  "video/mp4",
  "video/webm",
];

export function backdropKindForMime(mime: ThemeBackdropMime): ThemeBackdropKind {
  if (mime === "image/svg+xml") return "scene";
  if (mime === "video/mp4" || mime === "video/webm") return "video";
  return "image";
}

const inRange = (value: unknown, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

export function isThemeBackdrop(value: unknown): value is ThemeBackdrop {
  if (!isObject(value) || Array.isArray(value)) return false;
  const keys = Object.keys(value).filter((key) => key !== LEGACY_DIM_KEY);
  if (keys.length !== BACKDROP_KEYS.length || !BACKDROP_KEYS.every((key) => keys.includes(key))) return false;
  const { assetHash, kind, mime, blur } = value;
  if (typeof assetHash !== "string" || !ASSET_HASH.test(assetHash)) return false;
  if (kind !== "image" && kind !== "scene" && kind !== "video") return false;
  if (typeof mime !== "string" || !MIMES.includes(mime as ThemeBackdropMime)) return false;
  if (kind !== backdropKindForMime(mime as ThemeBackdropMime)) return false;
  return inRange(blur, BACKDROP_BLUR_MAX);
}

/** A stored backdrop with only its current keys (drops the retired `dim`). */
export function currentThemeBackdrop(backdrop: ThemeBackdrop): ThemeBackdrop {
  const { assetHash, kind, mime, blur } = backdrop;
  return { assetHash, kind, mime, blur };
}

/** Allowlisted ISO Base Media File Format major brands for MP4 video containers (excludes QuickTime, HEIF/AVIF). */
const MP4_MAJOR_BRANDS: Readonly<Record<string, true>> = {
  isom: true,
  iso2: true,
  iso3: true,
  iso4: true,
  iso5: true,
  iso6: true,
  mp41: true,
  mp42: true,
  av01: true,
  avc1: true,
  "M4V ": true,
  "m4v ": true,
  dash: true,
  msdh: true,
  msix: true,
};

const EBML_SCAN_MAX = 4096;

function readUint32BE(bytes: Uint8Array, offset: number): number {
  return (
    ((bytes[offset]! << 24) | (bytes[offset + 1]! << 16) | (bytes[offset + 2]! << 8) | bytes[offset + 3]!) >>> 0
  );
}

function sniffMp4(bytes: Uint8Array): boolean {
  if (bytes.length < 16) return false;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) return false;
  const size = readUint32BE(bytes, 0);
  let boxEnd: number;
  let brandOffset: number;
  if (size === 1) {
    if (bytes.length < 24) return false;
    const hi = readUint32BE(bytes, 8);
    const lo = readUint32BE(bytes, 12);
    if (hi > 0x1fffff) return false;
    const extSize = hi * 0x100000000 + lo;
    if (extSize < 24 || extSize > bytes.length) return false;
    boxEnd = extSize;
    brandOffset = 16;
  } else if (size === 0) {
    boxEnd = bytes.length;
    brandOffset = 8;
  } else {
    if (size < 16 || size > bytes.length) return false;
    boxEnd = size;
    brandOffset = 8;
  }
  if (brandOffset + 8 > boxEnd) return false;
  if ((boxEnd - (brandOffset + 8)) % 4 !== 0) return false;
  const majorBrand = String.fromCharCode(
    bytes[brandOffset]!,
    bytes[brandOffset + 1]!,
    bytes[brandOffset + 2]!,
    bytes[brandOffset + 3]!,
  );
  return Object.hasOwn(MP4_MAJOR_BRANDS, majorBrand);
}

function readEbmlVintWidth(first: number, maxWidth: number): { width: number; mask: number } | null {
  if (first === 0) return null;
  let width = 1;
  let mask = 0x80;
  while (width <= maxWidth && (first & mask) === 0) {
    width += 1;
    mask >>= 1;
  }
  return width <= maxWidth ? { width, mask } : null;
}

function readEbmlId(bytes: Uint8Array, offset: number, limit: number): { value: number; next: number } | null {
  if (offset >= limit) return null;
  const info = readEbmlVintWidth(bytes[offset]!, 4);
  if (info === null || offset + info.width > limit) return null;
  let value = 0;
  for (let i = 0; i < info.width; i++) value = value * 256 + bytes[offset + i]!;
  return { value, next: offset + info.width };
}

function readEbmlSize(bytes: Uint8Array, offset: number, limit: number): { value: number; next: number } | null {
  if (offset >= limit) return null;
  const first = bytes[offset]!;
  const info = readEbmlVintWidth(first, 8);
  if (info === null || offset + info.width > limit) return null;
  let value = first & (info.mask - 1);
  let allOnes = value === info.mask - 1;
  for (let i = 1; i < info.width; i++) {
    const b = bytes[offset + i]!;
    if (b !== 0xff) allOnes = false;
    value = value * 256 + b;
  }
  if (allOnes || !Number.isSafeInteger(value)) return null;
  return { value, next: offset + info.width };
}

function sniffWebm(bytes: Uint8Array): boolean {
  if (bytes.length < 4) return false;
  if (bytes[0] !== 0x1a || bytes[1] !== 0x45 || bytes[2] !== 0xdf || bytes[3] !== 0xa3) return false;
  const headerSize = readEbmlSize(bytes, 4, bytes.length);
  if (headerSize === null) return false;
  const headerEnd = headerSize.next + headerSize.value;
  if (headerEnd > bytes.length) return false;
  const limit = Math.min(headerEnd, EBML_SCAN_MAX);
  let pos = headerSize.next;
  while (pos < limit) {
    const id = readEbmlId(bytes, pos, limit);
    if (id === null) return false;
    const size = readEbmlSize(bytes, id.next, limit);
    if (size === null) return false;
    const dataStart = size.next;
    const dataEnd = dataStart + size.value;
    if (dataEnd > headerEnd) return false;
    if (id.value === 0x4282) {
      let end = dataEnd;
      while (end > dataStart && bytes[end - 1] === 0x00) end -= 1;
      return (
        end - dataStart === 4 &&
        bytes[dataStart] === 0x77 &&
        bytes[dataStart + 1] === 0x65 &&
        bytes[dataStart + 2] === 0x62 &&
        bytes[dataStart + 3] === 0x6d
      );
    }
    pos = dataEnd;
  }
  return false;
}

/** What the bytes are, from their own signature (the head test `sniffIconMime` uses). GIF and ICO are null. */
export function sniffBackdropMime(bytes: Uint8Array): ThemeBackdropMime | null {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const riff = String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  if (riff && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  if (sniffMp4(bytes)) return "video/mp4";
  if (sniffWebm(bytes)) return "video/webm";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export type BackdropCheck =
  | { ok: true; kind: "image"; mime: ThemeBackdropImageMime }
  | { ok: true; kind: "scene"; mime: ThemeBackdropSceneMime }
  | { ok: true; kind: "video"; mime: ThemeBackdropVideoMime }
  | { ok: false; message: string };

const SCENE_ACTIVE = /<\s*(script|foreignObject|animate|animateTransform|animateMotion|set)\b/i;
const SCENE_PARSER_DIFF_COMMENT = /--!>|<!--+>/;
const SCENE_HTML_UNSAFE = [
  /<\s*(?:meta|base|link|iframe|frame|frameset|object|embed|applet|form|input|button|textarea|select|a|img|picture|audio|video|source|track|portal|noscript|template|html|head|body|b|big|blockquote|br|center|code|dd|div|dl|dt|em|h[1-6]|hr|i|li|listing|menu|nobr|ol|p|pre|ruby|s|small|span|strong|strike|sub|sup|table|tt|u|ul|var)\b/i,
  /<\s*font\b[^>]*\b(?:color|face|size)\s*=/i,
  /\bhttp-equiv\s*=/i,
  /\bon[a-z]+\s*=/i,
];
const SCENE_EXTERNAL = [
  /\b(?:href|src)\s*=\s*(?:"\s*(?![#"']|data:)|'\s*(?![#"']|data:)|(?![#"'\s>]|data:))/i,
  /@import\b/i,
  /url\(\s*["']?\s*(?!#|data:)/i,
];

type PreparedSceneSvg = { ok: true; markup: string } | { ok: false; message: string };

function prepareSceneSvg(svg: string): PreparedSceneSvg {
  if (SCENE_PARSER_DIFF_COMMENT.test(svg)) {
    return { ok: false, message: "scenes cannot contain HTML breakout, navigation, or interactive elements" };
  }
  const markup = svg
    .replace(/^\uFEFF/, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!DOCTYPE[\s\S]*?>\s*)?/i, "")
    .trim();
  if (SCENE_ACTIVE.test(markup)) {
    return { ok: false, message: "scenes cannot contain script, foreignObject or SMIL animation" };
  }
  if (SCENE_HTML_UNSAFE.some((pattern) => pattern.test(markup))) {
    return { ok: false, message: "scenes cannot contain HTML breakout, navigation, or interactive elements" };
  }
  if (SCENE_EXTERNAL.some((pattern) => pattern.test(markup))) {
    return { ok: false, message: "scenes cannot load other files" };
  }
  const isSingleRoot =
    (/^<svg[\s>]/i.test(markup) && /<\/svg>$/i.test(markup)) || /^<svg\b[^>]*\/>$/i.test(markup);
  if (!isSingleRoot) {
    return { ok: false, message: "scenes must contain only a single root svg element" };
  }
  return { ok: true, markup };
}

/**
 * Defence in depth for every authoring route: images render through `<img>`,
 * scenes through a sandboxed `srcdoc` iframe (with `<img>` fallback), and
 * videos through a muted `<video>` element.
 */
export function checkBackdropBytes(bytes: Uint8Array): BackdropCheck {
  if (bytes.length === 0) return { ok: false, message: "the backdrop file is empty" };
  const mime = sniffBackdropMime(bytes);
  if (mime === null) return { ok: false, message: "backdrops must be PNG, JPEG, WebP, SVG, MP4 or WebM" };
  if (mime === "video/mp4" || mime === "video/webm") {
    if (bytes.length > BACKDROP_VIDEO_BYTES_MAX) return { ok: false, message: "video backdrops can be at most 16 MiB" };
    return { ok: true, kind: "video", mime };
  }
  if (mime !== "image/svg+xml") {
    if (bytes.length > BACKDROP_IMAGE_BYTES_MAX) return { ok: false, message: "image backdrops can be at most 4 MiB" };
    return { ok: true, kind: "image", mime };
  }
  if (bytes.length > BACKDROP_SCENE_BYTES_MAX) return { ok: false, message: "scene backdrops can be at most 4 MiB" };
  const text = new TextDecoder().decode(bytes);
  const prepared = prepareSceneSvg(text);
  if (!prepared.ok) return prepared;
  return { ok: true, kind: "scene", mime };
}

const STILL =
  "<style>@layer omp-still{*,*::before,*::after{animation:none!important;transition:none!important}}</style>";

/** The scene with every CSS animation and transition forced off. */
export function stillScene(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/i, (open) => open + STILL);
}

const SCENE_FRAME_CSP =
  "default-src 'none'; base-uri 'none'; form-action 'none'; style-src 'unsafe-inline'; img-src data:;";

/** Wraps a validated SVG scene in an isolated HTML document for a sandboxed iframe, or null if unsafe. */
export function sceneFrameHtml(svg: string): string | null {
  const prepared = prepareSceneSvg(svg);
  if (!prepared.ok) return null;
  const normalized = prepared.markup.replace(/<svg\b([^>]*?)(\s*\/?)>/i, (match, attrs: string, close: string) =>
    /\bpreserveAspectRatio\s*=/i.test(attrs)
      ? match
      : `<svg${attrs} preserveAspectRatio="xMidYMid slice"${close}>`,
  );
  return (
    `<!doctype html><html><head>` +
    `<meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="${SCENE_FRAME_CSP}">` +
    `<style>html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}` +
    `svg{display:block;width:100%;height:100%}</style>` +
    `</head><body>${normalized}</body></html>`
  );
}

/* ---------------------------------------------------------------- floors */

export interface BackdropFloors {
  void: number;
  sunken: number;
  reading: number;
  overlay: number;
}

type Pairing = readonly [fg: ThemeTokenName, plane: ThemeTokenName, min: number];

const CHROME_TEXT: ReadonlyArray<readonly [ThemeTokenName, number]> = [
  ["--color-ink", 4.5],
  ["--color-ink-mid", 4.5],
  ["--color-ink-dim", 4.5],
  ["--color-ink-faint", 4.5],
  ["--color-signal", 3],
  ["--color-copper", 3],
  ["--color-rose", 3],
  ["--color-iris", 3],
];

const onPlane = (plane: ThemeTokenName): Pairing[] => CHROME_TEXT.map(([fg, min]) => [fg, plane, min] as const);

const READING: Pairing[] = [
  ["--color-ink", "--color-surface", 10],
  ["--color-ink-mid", "--color-surface", 4.5],
  ["--color-ink-dim", "--color-surface", 4.5],
  ["--color-ink-faint", "--color-surface", 4.5],
  ["--color-signal", "--color-surface", 3],
  ["--color-copper", "--color-surface", 3],
  ["--color-rose", "--color-surface", 3],
  ["--color-iris", "--color-surface", 3],
  ["--color-think-cool", "--color-surface", 3],
  ["--color-think-warm", "--color-surface", 3],
  ["--color-ink-dim", "--color-raised", 4.5],
  ["--color-ink-faint", "--color-raised", 4.5],
];

/** The modal page scrim's void share: overlays.tsx's `bg-void/70` under every `glass-overlay` plane. */
const MODAL_SCRIM = 0.7;

/**
 * Lowest plane opacity, in percent 50-100, at which every text pairing on that
 * plane still clears its floor over any backdrop pixel (pure black or white).
 * The overlay plane (modal dialogs) is measured over those pixels under the
 * modal's own page scrim.
 */
export function backdropFloors(tokens: Record<ThemeTokenName, string>): BackdropFloors {
  const raw = ["#000000", "#ffffff"];
  const underModal = raw.map((pixel) => mixHex(tokens["--color-void"], pixel, MODAL_SCRIM));
  const floor = (pairings: readonly Pairing[], backs: readonly string[]): number => {
    for (let a = 50; a <= 100; a++) {
      const clears = pairings.every(([fg, plane, min]) =>
        backs.every((back) => contrastRatio(tokens[fg], mixHex(tokens[plane], back, a / 100)) >= min),
      );
      if (clears) return a;
    }
    return 100;
  };
  return {
    void: floor(onPlane("--color-void"), raw),
    sunken: floor(onPlane("--color-sunken"), raw),
    reading: floor(READING, raw),
    overlay: floor(onPlane("--color-overlay"), underModal),
  };
}
