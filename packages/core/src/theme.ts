// Theme preference, stored themes (issues #999, #1168) and the theme gate.
// Pure — only the canonical guard — because the renderer, the preload-less
// plan verifier page, and main all read it through the @omp-ui/core/theme subpath.
import { isObject } from "./guards";
import { isThemeBackdrop, type ThemeBackdrop } from "./theme-backdrop";

/** Every `--color-*` token a theme supplies, in canonical order. */
export const THEME_TOKEN_NAMES = [
  "--color-void",
  "--color-sunken",
  "--color-surface",
  "--color-raised",
  "--color-overlay",
  "--color-hover",
  "--color-line",
  "--color-line-soft",
  "--color-line-strong",
  "--color-ink",
  "--color-ink-mid",
  "--color-ink-dim",
  "--color-ink-faint",
  "--color-signal",
  "--color-signal-dim",
  "--color-signal-wash",
  "--color-copper",
  "--color-copper-dim",
  "--color-copper-wash",
  "--color-rose",
  "--color-rose-dim",
  "--color-rose-wash",
  "--color-iris",
  "--color-iris-dim",
  "--color-iris-wash",
  "--color-think-cool",
  "--color-think-warm",
  "--color-edge-hi",
  "--color-edge-lo",
] as const;
export type ThemeTokenName = (typeof THEME_TOKEN_NAMES)[number];

/** The six syntax seeds the shiki and xterm projections read. */
export const THEME_SYNTAX_SEEDS = ["comment", "string", "constant", "function", "type", "property"] as const;
export type ThemeSyntaxSeed = (typeof THEME_SYNTAX_SEEDS)[number];

/** xterm ITheme slots a theme may override. */
export const THEME_TERMINAL_SLOTS = [
  "background",
  "foreground",
  "cursor",
  "cursorAccent",
  "selectionBackground",
  "selectionInactiveBackground",
  "black",
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightBlack",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;
export type ThemeTerminalSlot = (typeof THEME_TERMINAL_SLOTS)[number];

/** shiki roles a theme may override. */
export const THEME_CODE_ROLES = [
  "foreground",
  "comment",
  "string",
  "constant",
  "keyword",
  "function",
  "type",
  "property",
  "punctuation",
  "inserted",
  "deleted",
] as const;
export type ThemeCodeRole = (typeof THEME_CODE_ROLES)[number];

/**
 * One theme's raw colours: complete semantic tokens, the syntax seeds, and
 * only the terminal/code slots that must differ from the projection. Curated
 * themes live in the renderer's theme-sources.json; imported and authored
 * ones in the registry's `storedThemes`.
 */
export interface ThemeSource {
  id: string;
  label: string;
  dark: boolean;
  tokens: Record<ThemeTokenName, string>;
  syntax: Record<ThemeSyntaxSeed, string>;
  overrides?: {
    term?: Partial<Record<ThemeTerminalSlot, string>>;
    code?: Partial<Record<ThemeCodeRole, string>>;
  };
  /** Present only on a stored theme that carries a backdrop. */
  backdrop?: ThemeBackdrop;
}

/** The theme a fresh install paints, and the dark pick's default. */
export const DEFAULT_THEME_ID = "graphite";
/** The light pick's default in system mode. */
export const DEFAULT_LIGHT_THEME_ID = "light";

/** Fixed: one theme always. System: the light or dark pick, following the OS. */
export type ThemeMode = "fixed" | "system";
export type ColorScheme = "light" | "dark";

/** Ids of imported themes start here, so they never shadow a curated id. */
export const IMPORTED_THEME_ID_PREFIX = "vscode-";
/** Ids of authored themes start here, so they never shadow a curated id. */
export const AUTHORED_THEME_ID_PREFIX = "custom-";
/** Upper bound on stored themes of both kinds; each rides every state broadcast. */
export const STORED_THEMES_MAX = 24;
const LABEL_MAX = 80;

/** An imported (`vscode-`) or authored (`custom-`) theme id. */
export const STORED_ID = /^(?:vscode|custom)-[a-z0-9]+(?:-[a-z0-9]+)*$/;
const OPAQUE_HEX = /^#[0-9a-f]{6}$/i;
const TERMINAL_HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/i;
const CSS_RGB = /^rgb\(\d{1,3} \d{1,3} \d{1,3} \/ (?:0|1|0?\.\d+)\)$/;

/** Exactly `keys`, each a string accepted by `valid(key, value)`. */
function exactColours(
  value: unknown,
  keys: readonly string[],
  valid: (key: string, colour: string) => boolean,
): boolean {
  if (!isObject(value) || Array.isArray(value)) return false;
  const present = Object.keys(value);
  if (present.length !== keys.length) return false;
  return keys.every((key) => {
    const colour = value[key];
    return typeof colour === "string" && valid(key, colour);
  });
}

/** A subset of `keys`, each a string matching `pattern`. */
function partialColours(value: unknown, keys: readonly string[], pattern: RegExp): boolean {
  if (value === undefined) return true;
  if (!isObject(value) || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, colour]) => keys.includes(key) && typeof colour === "string" && pattern.test(colour),
  );
}

/** True for an imported or authored theme id; curated ids carry neither prefix. */
export function isStoredThemeId(id: string): boolean {
  return storedThemeKind(id) !== null;
}

/** "imported" for vscode-, "authored" for custom-, null for a curated id. */
export function storedThemeKind(id: string): "imported" | "authored" | null {
  if (id.startsWith(IMPORTED_THEME_ID_PREFIX)) return "imported";
  if (id.startsWith(AUTHORED_THEME_ID_PREFIX)) return "authored";
  return null;
}

/** Structural check of a stored theme; contrast is the gate's job. */
export function isStoredTheme(value: unknown): value is ThemeSource {
  if (!isObject(value)) return false;
  const { id, label, dark, tokens, syntax, overrides, backdrop } = value;
  if (typeof id !== "string" || !STORED_ID.test(id) || id.length > 64) return false;
  if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX) return false;
  if (typeof dark !== "boolean") return false;
  const tokenOk = exactColours(tokens, THEME_TOKEN_NAMES, (key, colour) =>
    key === "--color-edge-hi" || key === "--color-edge-lo" ? CSS_RGB.test(colour) : OPAQUE_HEX.test(colour),
  );
  if (!tokenOk) return false;
  if (!exactColours(syntax, THEME_SYNTAX_SEEDS, (_key, colour) => OPAQUE_HEX.test(colour))) return false;
  if (backdrop !== undefined && !isThemeBackdrop(backdrop)) return false;
  if (overrides === undefined) return true;
  if (!isObject(overrides)) return false;
  if (Object.keys(overrides).some((key) => key !== "term" && key !== "code")) return false;
  return (
    partialColours(overrides.term, THEME_TERMINAL_SLOTS, TERMINAL_HEX) &&
    partialColours(overrides.code, THEME_CODE_ROLES, OPAQUE_HEX)
  );
}

/**
 * Registry read: rows that fail the structure check or the theme gate drop
 * (a hand-edited registry cannot smuggle in an unreadable theme), later
 * duplicates of an id drop, and the list caps.
 */
export function parseStoredThemes(value: unknown): ThemeSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ThemeSource[] = [];
  for (const item of value) {
    if (!isStoredTheme(item) || seen.has(item.id)) continue;
    if (themeGateFailures(item).length > 0) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length === STORED_THEMES_MAX) break;
  }
  return out;
}

/** The persisted theme preference, as the registry and the broadcast carry it. */
export interface ThemePreference {
  themeMode: ThemeMode;
  themeId: string;
  lightThemeId: string;
  darkThemeId: string;
}

/** A persisted preference read back from untrusted storage; missing fields take defaults. */
export function parseThemePreference(value: unknown): ThemePreference {
  const fields = isObject(value) ? value : {};
  const id = (field: unknown, fallback: string): string =>
    typeof field === "string" && field !== "" ? field : fallback;
  return {
    themeMode: fields.themeMode === "system" ? "system" : "fixed",
    themeId: id(fields.themeId, DEFAULT_THEME_ID),
    lightThemeId: id(fields.lightThemeId, DEFAULT_LIGHT_THEME_ID),
    darkThemeId: id(fields.darkThemeId, DEFAULT_THEME_ID),
  };
}

/** The theme id to paint: the fixed pick, or the OS scheme's pick. */
export function effectiveThemeId(preference: ThemePreference, prefersDark: boolean): string {
  if (preference.themeMode !== "system") return preference.themeId;
  return prefersDark ? preference.darkThemeId : preference.lightThemeId;
}

/* ------------------------------------------------------------ derivation */

export type TerminalPalette = Record<ThemeTerminalSlot, string>;
export type CodeTheme = Record<ThemeCodeRole, string>;

/** A theme as every consumer reads it: chrome tokens, xterm ITheme, shiki colours. */
export interface Theme {
  id: string;
  label: string;
  /** Drives `color-scheme` and the dark-chrome utilities. */
  dark: boolean;
  /** Every `--color-*` token. */
  tokens: Record<ThemeTokenName, string>;
  /** The xterm ITheme, derived from semantic tokens and syntax seeds. */
  term: TerminalPalette;
  /** The shiki theme colours, derived from semantic tokens and syntax seeds. */
  code: CodeTheme;
  /** Changes whenever any colour changes; consumers that cache by theme key on it. */
  rev: string;
  backdrop: ThemeBackdrop | null;
}

function parseHex(hex: string): readonly [number, number, number] {
  if (!OPAQUE_HEX.test(hex)) throw new TypeError(`Expected #rrggbb, received ${hex}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Mix an opaque `#rrggbb` colour against another channel-by-channel.
 *
 * ANSI brights retain 70% of their hue and take 30% of the theme's reading
 * ink. `Math.round` is part of the contract: generated palettes must remain
 * byte-stable across consumers rather than depending on CSS colour syntax.
 */
export function mixHex(colour: string, ink: string, colourWeight = 0.7): string {
  if (colourWeight < 0 || colourWeight > 1) {
    throw new RangeError(`Colour weight must be between 0 and 1, received ${colourWeight}`);
  }
  const source = parseHex(colour);
  const target = parseHex(ink);
  const channel = (index: number): string =>
    Math.round(source[index] * colourWeight + target[index] * (1 - colourWeight))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(0)}${channel(1)}${channel(2)}`;
}

/** Project semantic roles and syntax seeds onto xterm's fixed ANSI slots. */
export function deriveTerminal(source: ThemeSource): TerminalPalette {
  const token = source.tokens;
  const syntax = source.syntax;
  const overrides = source.overrides?.term;

  // Normal-slot overrides participate in bright derivation. A curated ANSI
  // blue therefore remains a coherent pair unless brightBlue is also explicit.
  const red = overrides?.red ?? token["--color-rose"];
  const green = overrides?.green ?? token["--color-signal"];
  const yellow = overrides?.yellow ?? token["--color-copper"];
  const blue = overrides?.blue ?? syntax.function;
  const magenta = overrides?.magenta ?? token["--color-iris"];
  const cyan = overrides?.cyan ?? syntax.type;
  const ink = token["--color-ink"];

  return {
    background: token["--color-surface"],
    foreground: ink,
    cursor: token["--color-signal"],
    cursorAccent: token["--color-surface"],
    selectionBackground: `${token["--color-iris"]}59`,
    selectionInactiveBackground: `${token["--color-iris"]}2e`,
    black: source.dark ? token["--color-sunken"] : ink,
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: token["--color-ink-mid"],
    brightBlack: source.dark ? token["--color-ink-faint"] : token["--color-ink-dim"],
    brightRed: mixHex(red, ink),
    brightGreen: mixHex(green, ink),
    brightYellow: mixHex(yellow, ink),
    brightBlue: mixHex(blue, ink),
    brightMagenta: mixHex(magenta, ink),
    brightCyan: mixHex(cyan, ink),
    brightWhite: ink,
    ...overrides,
  };
}

/** Project semantic roles and the six syntax seeds onto shiki roles. */
export function deriveCode(source: ThemeSource): CodeTheme {
  const token = source.tokens;
  const syntax = source.syntax;
  return {
    foreground: token["--color-ink"],
    comment: syntax.comment,
    string: syntax.string,
    constant: syntax.constant,
    keyword: token["--color-iris"],
    function: syntax.function,
    type: syntax.type,
    property: syntax.property,
    punctuation: token["--color-ink-mid"],
    inserted: token["--color-signal"],
    deleted: token["--color-rose"],
    ...source.overrides?.code,
  };
}

/** FNV-1a 32-bit as 8 lowercase hex digits. */
function fnv1a(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/** Materialize the public Theme shape consumed throughout the renderer. */
export function deriveTheme(source: ThemeSource): Theme {
  return {
    id: source.id,
    label: source.label,
    dark: source.dark,
    tokens: source.tokens,
    term: deriveTerminal(source),
    code: deriveCode(source),
    rev: fnv1a(JSON.stringify([source.tokens, source.syntax, source.overrides ?? null])),
    backdrop: source.backdrop ?? null,
  };
}

/* --------------------------------------------------------- contrast gate */

/** WCAG 2.x relative luminance; `#rrggbbaa` is truncated to its opaque channels. */
export function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "").slice(0, 6);
  const channel = (offset: number): number => {
    const c = Number.parseInt(h.slice(offset, offset + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
}

/** WCAG contrast ratio between two colours. */
export function contrastRatio(a: string, b: string): number {
  const [la, lb] = [relativeLuminance(a), relativeLuminance(b)];
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Lighten (dark theme) or darken (light theme) `colour` toward `ink` until it clears `min` on `bg`. */
export function liftToContrast(colour: string, bg: string, ink: string, min: number): string {
  // 0.025 steps keep the hue as long as possible; weight 0 is the ink itself,
  // which every accepted base already clears.
  for (let w = 1; w >= 0; w -= 0.025) {
    const mixed = mixHex(colour, ink, Math.max(w, 0));
    if (contrastRatio(mixed, bg) >= min) return mixed;
  }
  return ink;
}

/**
 * Step `colour` off `from` when the two collapse (planes may not). A plane
 * already at the end of its direction — a white surface asked to go lighter —
 * steps the other way instead.
 */
export function separatePlane(colour: string, from: string, toward: string): string {
  if (colour !== from) return colour;
  const opposite = toward === "#ffffff" ? "#000000" : "#ffffff";
  for (const target of [toward, opposite]) {
    const nudged = mixHex(colour, target, 0.94);
    if (nudged !== from) return nudged;
  }
  return mixHex(colour, opposite, 0.85);
}

/** One pairing below its floor, or two depth planes that collapse into one. */
export type ThemeContrastFailure =
  | { kind: "contrast"; label: string; fg: string; bg: string; ratio: number; min: number }
  | { kind: "planes"; label: string; colour: string };

/** A contrast failure, or an authored theme's signal accent that is not a green. */
export type ThemeGateFailure = ThemeContrastFailure | { kind: "signal"; colour: string; hue: number };

/**
 * Ink tiers descend on purpose: `ink` is reading content, `ink-faint` is the
 * deepest de-emphasis. But every tier ships carrying real text (timestamps,
 * model names, section headers, usage receipts), so every text-bearing tier
 * holds the WCAG AA 4.5:1 floor; the tiers stay distinguishable by staying
 * strictly ordered. Round 0 of the UI hill-climb (#1042) measured
 * `ink-faint` at 2.58:1 on Dark Modern surface across 408 visible text nodes,
 * so the old 3:1/2:1 floors are retired here as well as in the palette.
 */
const INK_TIERS: ReadonlyArray<readonly [ThemeTokenName, number]> = [
  ["--color-ink", 10],
  ["--color-ink-mid", 4.5],
  ["--color-ink-dim", 4.5],
  ["--color-ink-faint", 4.5],
];

const ACCENTS = ["signal", "copper", "rose", "iris"] as const;

/**
 * `black` is the terminal's own backdrop slot, so it is exempt. `brightBlack`
 * is the dim tier and carries that tier's 2:1 floor. Selection colours are
 * alpha-composited, not layered opaquely, so a ratio against the background
 * would be fiction.
 */
const ANSI_READABLE = [
  "red",
  "green",
  "yellow",
  "blue",
  "magenta",
  "cyan",
  "white",
  "brightRed",
  "brightGreen",
  "brightYellow",
  "brightBlue",
  "brightMagenta",
  "brightCyan",
  "brightWhite",
] as const;

/**
 * The contrast gate (issues #36, #999). Every curated theme passes it in the
 * renderer's test suite, and an imported theme is saved only when it returns
 * no failures. These are WCAG ratios, not taste; an unparseable colour yields
 * NaN and fails rather than slipping through unmeasured.
 */
export function themeContrastFailures(theme: Theme): ThemeContrastFailure[] {
  const failures: ThemeContrastFailure[] = [];
  const t = theme.tokens;
  const surface = t["--color-surface"];
  const check = (label: string, fg: string, bg: string, min: number): void => {
    const ratio = contrastRatio(fg, bg);
    if (!(ratio >= min)) failures.push({ kind: "contrast", label, fg, bg, ratio, min });
  };

  // Every ink tier legible on its surface.
  for (const [token, min] of INK_TIERS) check(token, t[token], surface, min);
  // Raised cards and disabled chrome carry the same ink text as the surface,
  // so both tiers hold AA on bg-raised too (issue #1042).
  check("ink-dim on raised", t["--color-ink-dim"], t["--color-raised"], 4.5);
  check("ink-faint on raised", t["--color-ink-faint"], t["--color-raised"], 4.5);

  // Light planes separate by luminance only: a pale tint within a few steps
  // of the composer surface vanishes (issue #66).
  if (!theme.dark) {
    for (const accent of ACCENTS) {
      check(`${accent}-wash off raised`, t[`--color-${accent}-wash`], t["--color-raised"], 1.2);
    }
  }
  // The wash is the accent's own tinted plane, so the accent must clear both.
  for (const accent of ACCENTS) {
    const colour = t[`--color-${accent}`];
    check(`${accent} on surface`, colour, surface, 3);
    check(`${accent} on wash`, colour, t[`--color-${accent}-wash`], 3);
  }
  // The thinking slider paints on the popover; the pill on the composer surface.
  for (const end of ["--color-think-cool", "--color-think-warm"] as const) {
    check(`${end} on surface`, t[end], surface, 3);
    check(`${end} on overlay`, t[end], t["--color-overlay"], 3);
  }
  // The plan guardrail derives the plan review palette from these (issue #384).
  check("ink on canvas", t["--color-ink"], surface, 4.5);
  check("ink on chip", t["--color-ink"], t["--color-hover"], 4.5);
  check("plan link on canvas", mixHex(t["--color-iris"], t["--color-ink"], 0.7), surface, 4.5);

  for (const [role, colour] of Object.entries(theme.code)) check(`code.${role}`, colour, surface, 3);

  const background = theme.term.background;
  for (const slot of ANSI_READABLE) check(`term.${slot}`, theme.term[slot], background, 3);
  check("term.brightBlack", theme.term.brightBlack, background, 2);

  // Equal planes collapse the elevation model: a modal stops reading as
  // floating, a hovered row stops answering "am I on it?".
  const planes: ReadonlyArray<readonly [string, ThemeTokenName, ThemeTokenName]> = [
    ["void = surface", "--color-void", "--color-surface"],
    ["surface = raised", "--color-surface", "--color-raised"],
    ["overlay = surface", "--color-overlay", "--color-surface"],
    ["hover = raised", "--color-hover", "--color-raised"],
  ];
  for (const [label, a, b] of planes) {
    if (t[a].toLowerCase() === t[b].toLowerCase()) failures.push({ kind: "planes", label, colour: t[a] });
  }
  return failures;
}

/* ----------------------------------------------------------- signal rule */

/** OKLab hue in degrees [0, 360) and chroma of an opaque #rrggbb colour. */
export function oklabHueChroma(hex: string): { hue: number; chroma: number } {
  const linear = parseHex(hex).map((value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  const [r, g, b] = linear as [number, number, number];
  // CSS Color 4: linear sRGB → LMS → OKLab.
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const hue = ((Math.atan2(bb, a) * 180) / Math.PI + 360) % 360;
  return { hue, chroma: Math.hypot(a, bb) };
}

/** The signal accent means agent liveness, so it must read as a green (ADR-0004). */
export function signalAccentFailure(colour: string): ThemeGateFailure | null {
  const { hue, chroma } = oklabHueChroma(colour);
  if (hue >= 100 && hue <= 200 && chroma >= 0.03) return null;
  return { kind: "signal", colour, hue };
}

/** Every reason a stored theme may not be saved: contrast, plane collapse, signal. */
export function themeGateFailures(source: ThemeSource): ThemeGateFailure[] {
  const failures: ThemeGateFailure[] = themeContrastFailures(deriveTheme(source));
  if (storedThemeKind(source.id) === "authored") {
    const signal = signalAccentFailure(source.tokens["--color-signal"]);
    if (signal !== null) failures.push(signal);
  }
  return failures;
}
