// Theme seeds (issue #1168): the few colours an author picks. Everything else
// derives through the same mapper a VS Code import uses, so imported and
// authored themes share one derivation and one gate. Pure — the renderer's
// editor previews exactly what main will store.
import { isObject } from "./guards";
import {
  AUTHORED_THEME_ID_PREFIX,
  THEME_SYNTAX_SEEDS,
  contrastRatio,
  liftToContrast,
  mixHex,
  relativeLuminance,
  type ThemeSource,
  type ThemeSyntaxSeed,
} from "./theme";
import { mapVsCodeTheme, type VsCodeThemeDocument } from "./vscode-theme";

export type ThemeSeedAccent = "signal" | "copper" | "rose" | "iris";
export const THEME_SEED_ACCENTS: readonly ThemeSeedAccent[] = ["signal", "copper", "rose", "iris"];

export interface ThemeSeeds {
  /** The reading surface. Its luminance decides dark or light. */
  canvas: string;
  ink?: string;
  accents?: Partial<Record<ThemeSeedAccent, string>>;
  syntax?: Partial<Record<ThemeSyntaxSeed, string>>;
}

interface SeedDefaults {
  ink: string;
  accents: Record<ThemeSeedAccent, string>;
  syntax: Record<ThemeSyntaxSeed, string>;
  think: { cool: string; warm: string };
}

/** The curated `graphite` (dark) and `light` themes' own colours; pinned by theme-seeds.test.ts. */
export const THEME_SEED_DEFAULTS: Record<"dark" | "light", SeedDefaults> = {
  dark: {
    ink: "#eaeef3",
    accents: { signal: "#4de0a1", copper: "#f2aa6a", rose: "#f57d94", iris: "#a595f9" },
    syntax: {
      comment: "#5f6b7c",
      string: "#e0b184",
      constant: "#e39db5",
      function: "#7fb8e8",
      type: "#6fc7d4",
      property: "#a8c5e8",
    },
    think: { cool: "#71c5ea", warm: "#f188c6" },
  },
  light: {
    ink: "#101419",
    accents: { signal: "#066544", copper: "#894706", rose: "#ab1936", iris: "#4732b6" },
    syntax: {
      comment: "#6a7885",
      string: "#984b1a",
      constant: "#a11a6b",
      function: "#1c5fb0",
      type: "#0a6168",
      property: "#2a5a8a",
    },
    think: { cool: "#055f7d", warm: "#a1156b" },
  },
};

const SEED_HEX = /^#[0-9a-f]{6}$/i;
const SEED_KEYS = ["canvas", "ink", "accents", "syntax"];

/** Present keys are a subset of `keys` and each value is a `#rrggbb` string. */
function seedColours(value: unknown, keys: readonly string[]): boolean {
  if (!isObject(value) || Array.isArray(value)) return false;
  return Object.entries(value).every(
    ([key, colour]) => keys.includes(key) && typeof colour === "string" && SEED_HEX.test(colour),
  );
}

export function isThemeSeeds(value: unknown): value is ThemeSeeds {
  if (!isObject(value) || Array.isArray(value)) return false;
  if (Object.keys(value).some((key) => !SEED_KEYS.includes(key))) return false;
  const { canvas, ink, accents, syntax } = value;
  if (typeof canvas !== "string" || !SEED_HEX.test(canvas)) return false;
  if (ink !== undefined && (typeof ink !== "string" || !SEED_HEX.test(ink))) return false;
  if (accents !== undefined && !seedColours(accents, THEME_SEED_ACCENTS)) return false;
  return syntax === undefined || seedColours(syntax, THEME_SYNTAX_SEEDS);
}

/** VS Code scope per syntax seed: the first scope the mapper probes for that seed. */
const SEED_SCOPE: Record<ThemeSyntaxSeed, string> = {
  comment: "comment.line",
  string: "string.quoted.double",
  constant: "constant.numeric",
  function: "entity.name.function",
  type: "entity.name.type",
  property: "variable.other.property",
};

/** Tokens and syntax for a set of seeds. Never throws for valid seeds. */
export function themeColoursFromSeeds(seeds: ThemeSeeds): Pick<ThemeSource, "dark" | "tokens" | "syntax"> {
  const canvas = seeds.canvas.toLowerCase();
  const dark = relativeLuminance(canvas) < 0.2;
  const defaults = THEME_SEED_DEFAULTS[dark ? "dark" : "light"];
  const ink = seeds.ink ?? defaults.ink;
  const accents = { ...defaults.accents, ...seeds.accents };
  const syntax = { ...defaults.syntax, ...seeds.syntax };

  const doc: VsCodeThemeDocument = {
    name: null,
    type: dark ? "dark" : "light",
    colors: {
      "editor.background": canvas,
      "editor.foreground": ink,
      "terminal.ansiGreen": accents.signal,
      "editorWarning.foreground": accents.copper,
      "editorError.foreground": accents.rose,
      "terminal.ansiMagenta": accents.iris,
    },
    tokenColors: THEME_SYNTAX_SEEDS.map((seed) => ({ scopes: [SEED_SCOPE[seed]], foreground: syntax[seed] })),
  };
  // The mapper's id and its terminal/keyword overrides are discarded: an
  // authored theme is exactly what its seeds derive to.
  const mapped = mapVsCodeTheme(doc, "seeded");
  const tokens = { ...mapped.tokens };

  // The mapper lifts ink tiers on the surface and raised planes only; chrome
  // text also sits on sunken and void, so lift there too and keep the tiers ordered.
  const mappedInk = tokens["--color-ink"];
  const surface = tokens["--color-surface"];
  const planes = [surface, tokens["--color-raised"], tokens["--color-sunken"], tokens["--color-void"]];
  const [wMid, wDim, wFaint] = dark ? [0.82, 0.72, 0.65] : [0.9, 0.81, 0.72];
  const lift = (weight: number): string =>
    planes.reduce((colour, plane) => liftToContrast(colour, plane, mappedInk, 4.5), mixHex(mappedInk, surface, weight));
  const stronger = (a: string, b: string): string => (contrastRatio(a, surface) >= contrastRatio(b, surface) ? a : b);
  const faint = lift(wFaint);
  const dim = stronger(lift(wDim), faint);
  const mid = stronger(lift(wMid), dim);
  tokens["--color-ink-mid"] = mid;
  tokens["--color-ink-dim"] = dim;
  tokens["--color-ink-faint"] = faint;

  // The mapper would take the thinking ends from VS Code's terminal cyan and
  // magenta; seeds name neither, so use the scheme's own.
  const overlay = tokens["--color-overlay"];
  const thinkEnd = (raw: string): string =>
    liftToContrast(liftToContrast(raw, surface, mappedInk, 3), overlay, mappedInk, 3);
  tokens["--color-think-cool"] = thinkEnd(defaults.think.cool);
  tokens["--color-think-warm"] = thinkEnd(defaults.think.warm);

  return { dark, tokens, syntax: mapped.syntax };
}

/** The seeds that reproduce a theme's main colours, for Duplicate and Edit. */
export function seedsOfTheme(source: Pick<ThemeSource, "tokens" | "syntax">): Required<ThemeSeeds> {
  const t = source.tokens;
  return {
    canvas: t["--color-surface"],
    ink: t["--color-ink"],
    accents: {
      signal: t["--color-signal"],
      copper: t["--color-copper"],
      rose: t["--color-rose"],
      iris: t["--color-iris"],
    },
    syntax: { ...source.syntax },
  };
}

/** "custom-" + slug of the label + "-" + 6 hex digits from `entropy`. */
export function authoredThemeId(label: string, entropy: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  const suffix = entropy.toLowerCase().replace(/[^0-9a-f]/g, "").slice(0, 6).padEnd(6, "0");
  return `${AUTHORED_THEME_ID_PREFIX}${slug === "" ? "theme" : slug}-${suffix}`;
}
