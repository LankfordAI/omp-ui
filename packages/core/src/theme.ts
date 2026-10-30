// Theme preference and imported themes (issue #999). Pure — only the
// canonical guard — because the renderer, the preload-less plan verifier
// page, and main all read it through the @omp-ui/core/theme-preference subpath.
import { isObject } from "./guards";

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
 * themes live in the renderer's theme-sources.json; imported ones in the
 * registry's `importedThemes`.
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
/** Upper bound on stored imported themes; each rides every state broadcast. */
export const IMPORTED_THEMES_MAX = 24;
const LABEL_MAX = 80;

const IMPORTED_ID = /^vscode-[a-z0-9]+(?:-[a-z0-9]+)*$/;
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

/** Structural check of a stored imported theme; contrast is the renderer's gate. */
export function isImportedTheme(value: unknown): value is ThemeSource {
  if (!isObject(value)) return false;
  const { id, label, dark, tokens, syntax, overrides } = value;
  if (typeof id !== "string" || !IMPORTED_ID.test(id) || id.length > 64) return false;
  if (typeof label !== "string" || label.trim() === "" || label.length > LABEL_MAX) return false;
  if (typeof dark !== "boolean") return false;
  const tokenOk = exactColours(tokens, THEME_TOKEN_NAMES, (key, colour) =>
    key === "--color-edge-hi" || key === "--color-edge-lo" ? CSS_RGB.test(colour) : OPAQUE_HEX.test(colour),
  );
  if (!tokenOk) return false;
  if (!exactColours(syntax, THEME_SYNTAX_SEEDS, (_key, colour) => OPAQUE_HEX.test(colour))) return false;
  if (overrides === undefined) return true;
  if (!isObject(overrides)) return false;
  if (Object.keys(overrides).some((key) => key !== "term" && key !== "code")) return false;
  return (
    partialColours(overrides.term, THEME_TERMINAL_SLOTS, TERMINAL_HEX) &&
    partialColours(overrides.code, THEME_CODE_ROLES, OPAQUE_HEX)
  );
}

/**
 * Registry read: rows that fail the structure check or the contrast gate drop
 * (a hand-edited registry cannot smuggle in an unreadable theme), later
 * duplicates of an id drop, and the list caps.
 */
export function parseImportedThemes(value: unknown): ThemeSource[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: ThemeSource[] = [];
  for (const item of value) {
    if (!isImportedTheme(item) || seen.has(item.id)) continue;
    if (themeContrastFailures(deriveTheme(item)).length > 0) continue;
    seen.add(item.id);
    out.push(item);
    if (out.length === IMPORTED_THEMES_MAX) break;
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

/** Materialize the public Theme shape consumed throughout the renderer. */
export function deriveTheme(source: ThemeSource): Theme {
  return {
    id: source.id,
    label: source.label,
    dark: source.dark,
    tokens: source.tokens,
    term: deriveTerminal(source),
    code: deriveCode(source),
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

/** One pairing below its floor, or two depth planes that collapse into one. */
export type ThemeContrastFailure =
  | { kind: "contrast"; label: string; fg: string; bg: string; ratio: number; min: number }
  | { kind: "planes"; label: string; colour: string };

/**
 * Ink tiers descend on purpose: `ink` is reading content, `ink-faint` is
 * de-emphasis (timestamps, disabled affordances) that must be *visible*, not
 * legible at length. Each tier gets the floor its job needs.
 */
const INK_TIERS: ReadonlyArray<readonly [ThemeTokenName, number]> = [
  ["--color-ink", 10],
  ["--color-ink-mid", 4.5],
  ["--color-ink-dim", 3],
  ["--color-ink-faint", 2],
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
  // Disabled chrome renders on bg-raised: ink-dim is its text, ink-faint its icons.
  check("ink-dim on raised", t["--color-ink-dim"], t["--color-raised"], 3);
  check("ink-faint on raised", t["--color-ink-faint"], t["--color-raised"], 2);

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
