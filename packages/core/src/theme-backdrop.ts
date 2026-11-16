// Theme backdrops (issue #1168): the reference a stored theme carries, the
// byte checks every authoring route runs, and the plane-opacity floors that
// keep text readable over any backdrop pixel. Pure — the renderer imports it.
import { isObject } from "./guards";
import { contrastRatio, mixHex, type ThemeTokenName } from "./theme";

export type ThemeBackdropKind = "image" | "scene";
export type ThemeBackdropMime = "image/png" | "image/jpeg" | "image/webp" | "image/svg+xml";

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
export const BACKDROP_SCENE_BYTES_MAX = 128 * 1024;
export const BACKDROP_BLUR_MAX = 32;
export const BACKDROP_DEFAULT_BLUR = 12;

const ASSET_HASH = /^[0-9a-f]{64}$/;
const BACKDROP_KEYS = ["assetHash", "kind", "mime", "blur"];
/** Retired with the scrim (#1187): rows and files written before carry it; readers accept and drop it. */
export const LEGACY_DIM_KEY = "dim";
const MIMES: readonly string[] = ["image/png", "image/jpeg", "image/webp", "image/svg+xml"];

const inRange = (value: unknown, max: number): boolean =>
  typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= max;

export function isThemeBackdrop(value: unknown): value is ThemeBackdrop {
  if (!isObject(value) || Array.isArray(value)) return false;
  const keys = Object.keys(value).filter((key) => key !== LEGACY_DIM_KEY);
  if (keys.length !== BACKDROP_KEYS.length || !BACKDROP_KEYS.every((key) => keys.includes(key))) return false;
  const { assetHash, kind, mime, blur } = value;
  if (typeof assetHash !== "string" || !ASSET_HASH.test(assetHash)) return false;
  if (kind !== "image" && kind !== "scene") return false;
  if (typeof mime !== "string" || !MIMES.includes(mime)) return false;
  if ((kind === "scene") !== (mime === "image/svg+xml")) return false;
  return inRange(blur, BACKDROP_BLUR_MAX);
}

/** A stored backdrop with only its current keys (drops the retired `dim`). */
export function currentThemeBackdrop(backdrop: ThemeBackdrop): ThemeBackdrop {
  const { assetHash, kind, mime, blur } = backdrop;
  return { assetHash, kind, mime, blur };
}

/** What the bytes are, from their own signature (the head test `sniffIconMime` uses). GIF and ICO are null. */
export function sniffBackdropMime(bytes: Uint8Array): ThemeBackdropMime | null {
  const at = (i: number): number => bytes[i] ?? -1;
  if (at(0) === 0x89 && at(1) === 0x50 && at(2) === 0x4e && at(3) === 0x47) return "image/png";
  if (at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return "image/jpeg";
  const riff = String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF";
  if (riff && String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP") return "image/webp";
  const head = new TextDecoder().decode(bytes.subarray(0, 1024)).replace(/^\uFEFF/, "").trimStart();
  if (head.startsWith("<") && /<svg[\s>]/i.test(head)) return "image/svg+xml";
  return null;
}

export type BackdropCheck =
  | { ok: true; kind: ThemeBackdropKind; mime: ThemeBackdropMime }
  | { ok: false; message: string };

const SCENE_ACTIVE = /<\s*(script|foreignObject|animate|animateTransform|animateMotion|set)\b/i;
const SCENE_EXTERNAL = [/\b(?:href|src)\s*=\s*["']\s*(?!#|data:)/i, /@import\b/i, /url\(\s*["']?\s*(?!#|data:)/i];

/**
 * Defence in depth for every authoring route: the renderer only ever shows a
 * backdrop through `<img>`, where no script runs and no subresource loads.
 */
export function checkBackdropBytes(bytes: Uint8Array): BackdropCheck {
  if (bytes.length === 0) return { ok: false, message: "the backdrop file is empty" };
  const mime = sniffBackdropMime(bytes);
  if (mime === null) return { ok: false, message: "backdrops must be PNG, JPEG, WebP or SVG" };
  if (mime !== "image/svg+xml") {
    if (bytes.length > BACKDROP_IMAGE_BYTES_MAX) return { ok: false, message: "image backdrops can be at most 4 MiB" };
    return { ok: true, kind: "image", mime };
  }
  if (bytes.length > BACKDROP_SCENE_BYTES_MAX) return { ok: false, message: "scene backdrops can be at most 128 KiB" };
  const text = new TextDecoder().decode(bytes);
  if (SCENE_ACTIVE.test(text)) {
    return { ok: false, message: "scenes cannot contain script, foreignObject or SMIL animation" };
  }
  if (SCENE_EXTERNAL.some((pattern) => pattern.test(text))) {
    return { ok: false, message: "scenes cannot load other files" };
  }
  return { ok: true, kind: "scene", mime };
}

const STILL =
  "<style>@layer omp-still{*,*::before,*::after{animation:none!important;transition:none!important}}</style>";

/** The scene with every CSS animation and transition forced off. */
export function stillScene(svg: string): string {
  return svg.replace(/<svg\b[^>]*>/i, (open) => open + STILL);
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
