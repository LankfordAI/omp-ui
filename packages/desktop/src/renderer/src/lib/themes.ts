import { useSyncExternalStore } from "react";
import { backend } from "../backend";

import themeSourcesJson from "./theme-sources.json";

/**
 * Runtime themes (issue #36).
 *
 * `theme-sources.json` is the renderer's sole raw-colour source. Semantic
 * tokens drive CSS directly, while xterm and shiki receive deterministic
 * projections because neither can consume CSS custom properties. A small
 * override is reserved for a palette's curated identity; overrides always win
 * over projection, so every non-overridden consumer follows token changes.
 */

export const TOKEN_NAMES = [
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
  "--color-edge-hi",
  "--color-edge-lo",
] as const;

type TokenName = (typeof TOKEN_NAMES)[number];

type SyntaxSeedName = "comment" | "string" | "constant" | "function" | "type" | "property";

type TerminalSlot =
  | "background"
  | "foreground"
  | "cursor"
  | "cursorAccent"
  | "selectionBackground"
  | "selectionInactiveBackground"
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";
type TerminalPalette = Record<TerminalSlot, string>;

export interface CodeTheme {
  foreground: string;
  comment: string;
  string: string;
  constant: string;
  keyword: string;
  function: string;
  type: string;
  property: string;
  punctuation: string;
  inserted: string;
  deleted: string;
}

export interface Theme {
  id: string;
  label: string;
  /** Drives `color-scheme` and the dark-chrome utilities. */
  dark: boolean;
  /** Every `--color-*` token from the generated default theme block. */
  tokens: Record<string, string>;
  /** The xterm ITheme, derived from semantic tokens and syntax seeds. */
  term: Record<string, string>;
  /** The shiki theme colours, derived from semantic tokens and syntax seeds. */
  code: CodeTheme;
}

export interface ThemeSource {
  id: string;
  label: string;
  dark: boolean;
  tokens: Record<TokenName, string>;
  syntax: Record<SyntaxSeedName, string>;
  overrides?: {
    term?: Partial<TerminalPalette>;
    code?: Partial<CodeTheme>;
  };
}

// This annotation deliberately type-checks the imported JSON at the boundary:
// missing tokens/seeds and misspelled override slots fail compilation here.
const THEME_SOURCES: readonly ThemeSource[] = themeSourcesJson;

const HEX = /^#[0-9a-f]{6}$/i;

function parseHex(hex: string): readonly [number, number, number] {
  if (!HEX.test(hex)) throw new TypeError(`Expected #rrggbb, received ${hex}`);
  return [
    Number.parseInt(hex.slice(1, 3), 16),
    Number.parseInt(hex.slice(3, 5), 16),
    Number.parseInt(hex.slice(5, 7), 16),
  ];
}

/**
 * Mix an opaque `#rrggbb` colour against ink channel-by-channel.
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

/** Project semantic roles and the six curated syntax seeds onto shiki roles. */
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

/** Materialize the stable public Theme shape consumed throughout the renderer. */
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

export const THEMES: readonly Theme[] = THEME_SOURCES.map(deriveTheme);

export const DEFAULT_THEME_ID = "graphite";

/**
 * Mirror of the store's `themeId`. The renderer needs the palette before the
 * first backend round-trip resolves, and the pre-paint boot script needs it
 * synchronously, so localStorage — not the backend — is the read path here.
 */
const KEY = "omp-ui.themeId";

/**
 * The theme applied when nothing else resolves — an unknown id, an empty
 * store, or storage that refuses to be read.
 */
const DEFAULT_THEME: Theme = THEMES.find((t) => t.id === DEFAULT_THEME_ID) ?? THEMES[0];

/** Unknown id (renamed theme, hand-edited storage) degrades, never throws. */
export function resolveTheme(id: string | undefined): Theme {
  return THEMES.find((t) => t.id === id) ?? DEFAULT_THEME;
}

let current: Theme = DEFAULT_THEME;
const listeners = new Set<() => void>();

/**
 * The single runtime writer. Everything a palette touches that is not a
 * Tailwind utility — `color-scheme`, the persisted mirror, the native window
 * chrome — is repainted here, so no caller has to remember the list.
 *
 * Every side effect is individually guarded rather than assumed: the store
 * calls this during its own boot, and the store's tests run in vitest's node
 * environment with no `document` and no `localStorage`.
 */
export function applyTheme(theme: Theme): void {
  current = theme;

  if (typeof document !== "undefined") {
    const root = document.documentElement;
    // Tailwind v4 emits each `@theme` token as a `:root` custom property and
    // utilities that dereference it, so overriding the properties here
    // re-themes every utility and every base rule with no CSS rebuild.
    for (const [k, v] of Object.entries(theme.tokens)) root.style.setProperty(k, v);
    root.style.colorScheme = theme.dark ? "dark" : "light";
    // For the light-theme utilities and for debugging only — the palette
    // rides the custom properties above, not this attribute.
    root.dataset.theme = theme.id;
  }

  try {
    // The pre-paint boot script reads this mirror, so persisting is what
    // keeps the next launch from flashing graphite before the store loads.
    window.localStorage.setItem(KEY, theme.id);
  } catch {
    // Storage unavailable (or no DOM at all): the palette still applies.
  }

  // Native chrome is painted by the OS, not CSS — the frameless titlebar
  // overlay only changes through main. The bridge is absent under test, and
  // main already swallows platform errors, so neither a missing bridge nor a
  // rejected call may take the switch down with it.
  try {
    void backend
      ?.setWindowChrome(theme.tokens["--color-void"], theme.tokens["--color-ink-mid"])
      ?.catch(() => {});
  } catch {
    // No bridge: native chrome keeps its previous colour.
  }

  for (const cb of listeners) cb();
}

function subscribe(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** The applied theme's id — lets a caller skip a redundant re-apply. */
export function currentThemeId(): string {
  return current.id;
}

/** Current theme, live across every consumer (terminal, code blocks, chrome). */
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => current);
}

// Boot from the persisted mirror so the palette is right on the first paint,
// well before the store's first backend round-trip resolves.
try {
  applyTheme(resolveTheme(window.localStorage.getItem(KEY) ?? undefined));
} catch {
  // No storage (or no DOM): the default is already applied.
}
