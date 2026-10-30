// VS Code colour theme import (issue #999). Pure — the renderer's import
// preview and main's save gate both run it, so the stored theme is exactly the
// one the user previewed.
import { isObject } from "./guards";
import {
  IMPORTED_THEME_ID_PREFIX,
  contrastRatio as contrast,
  deriveTheme,
  mixHex,
  relativeLuminance,
  themeContrastFailures,
  type ThemeContrastFailure,
  type ThemeSource,
  type ThemeSyntaxSeed,
  type ThemeTerminalSlot,
  type ThemeTokenName,
} from "./theme";

/**
 * A VS Code theme file after its `include` chain is resolved: `colors`
 * merged child-over-parent, `tokenColors` concatenated parent-first (VS Code's
 * own order, so a child's rule wins a tie).
 */
export interface VsCodeThemeDocument {
  name: string | null;
  type: "dark" | "light" | "hc" | "hcLight" | null;
  colors: Record<string, string>;
  tokenColors: VsCodeTokenRule[];
}

export interface VsCodeTokenRule {
  scopes: string[];
  foreground: string;
}

/** Outcome of a VS Code import: a theme that passed the contrast gate, or why not. */
export type VsCodeImportResult =
  | { ok: true; source: ThemeSource }
  | { ok: false; reason: "parse"; message: string }
  | { ok: false; reason: "contrast"; label: string; failures: ThemeContrastFailure[] };

/** Most `include` hops followed; VS Code's own built-ins chain three deep. */
export const VSCODE_INCLUDE_DEPTH_MAX = 8;

/**
 * Strip `//` and block comments and trailing commas: VS Code theme files are
 * JSONC (the built-in Dark Modern has both). Strings are copied verbatim, so a
 * `//` inside a colour key or URL survives.
 */
export function stripJsonc(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i += 1;
    } else if (ch === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end === -1 ? text.length : end + 2;
    } else {
      out += ch;
      i += 1;
    }
  }
  // Trailing commas before a closer; strings were already copied, but a
  // `,]` inside one is not valid theme content, so this pass is safe.
  return out.replace(/,(\s*[}\]])/g, "$1");
}

/** One file of the chain, before merging: its own colours/rules and its parent. */
export interface VsCodeThemeFile {
  name: string | null;
  type: VsCodeThemeDocument["type"];
  include: string | null;
  colors: Record<string, string>;
  tokenColors: VsCodeTokenRule[];
}

/**
 * Parse one theme file. Throws with a user-facing message when the text is
 * not a theme; unknown keys are ignored, and a `tokenColors` given as a path
 * (a `.tmTheme`) is rejected because it carries no JSON rules to read.
 */
export function parseVsCodeThemeFile(text: string): VsCodeThemeFile {
  let raw: unknown;
  try {
    raw = JSON.parse(stripJsonc(text.replace(/^\uFEFF/, "")));
  } catch (err) {
    throw new Error(`not valid JSON: ${err instanceof Error ? err.message : String(err)}`, { cause: err });
  }
  if (!isObject(raw) || Array.isArray(raw)) throw new Error("not a VS Code colour theme (expected a JSON object)");
  const { name, type, include, colors, tokenColors } = raw;
  if (typeof tokenColors === "string") {
    throw new Error("tokenColors points at a .tmTheme file; only JSON tokenColors can be imported");
  }
  const outColors: Record<string, string> = {};
  if (isObject(colors) && !Array.isArray(colors)) {
    for (const [key, value] of Object.entries(colors)) {
      if (typeof value === "string") outColors[key] = value;
    }
  }
  const rules: VsCodeTokenRule[] = [];
  if (Array.isArray(tokenColors)) {
    for (const rule of tokenColors) {
      if (!isObject(rule) || !isObject(rule.settings)) continue;
      const foreground = rule.settings.foreground;
      if (typeof foreground !== "string") continue;
      const scope = rule.scope;
      const scopes = (typeof scope === "string" ? scope.split(",") : Array.isArray(scope) ? scope : [])
        .filter((s): s is string => typeof s === "string")
        .map((s) => s.trim())
        .filter((s) => s !== "");
      rules.push({ scopes, foreground });
    }
  }
  const hasColors = Object.keys(outColors).length > 0;
  if (!hasColors && rules.length === 0 && typeof include !== "string") {
    throw new Error("not a VS Code colour theme (no colors or tokenColors)");
  }
  return {
    name: typeof name === "string" && name.trim() !== "" ? name.trim() : null,
    type: type === "dark" || type === "light" || type === "hc" || type === "hcLight" ? type : null,
    include: typeof include === "string" && include.trim() !== "" ? include.trim() : null,
    colors: outColors,
    tokenColors: rules,
  };
}

/** Merge a chain ordered child → root into one document. */
export function mergeVsCodeThemeChain(chain: readonly VsCodeThemeFile[]): VsCodeThemeDocument {
  const rootFirst = [...chain].reverse();
  const colors: Record<string, string> = {};
  const tokenColors: VsCodeTokenRule[] = [];
  for (const file of rootFirst) {
    Object.assign(colors, file.colors);
    tokenColors.push(...file.tokenColors);
  }
  const child = chain[0];
  return {
    name: child?.name ?? chain.find((f) => f.name !== null)?.name ?? null,
    type: chain.find((f) => f.type !== null)?.type ?? null,
    colors,
    tokenColors,
  };
}

/* ------------------------------------------------------------- colour math */

const HEX_ANY = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * A VS Code colour (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`) as opaque
 * `#rrggbb`, alpha composited over `backdrop`. Null for anything else.
 */
export function normalizeVsCodeColour(value: string | undefined, backdrop: string): string | null {
  if (value === undefined) return null;
  const v = value.trim();
  if (!HEX_ANY.test(v)) return null;
  const digits = v.length <= 5 ? [...v.slice(1)].map((d) => d + d).join("") : v.slice(1);
  const rgb = `#${digits.slice(0, 6).toLowerCase()}`;
  if (digits.length === 6) return rgb;
  const alpha = Number.parseInt(digits.slice(6, 8), 16) / 255;
  return mixHex(rgb, backdrop, alpha);
}

/** Lighten (dark theme) or darken (light theme) `colour` toward `ink` until it clears `min` on `bg`. */
function readable(colour: string, bg: string, ink: string, min: number): string {
  // 0.025 steps keep the hue as long as possible; weight 0 is the ink itself,
  // which every accepted base already clears.
  for (let w = 1; w >= 0; w -= 0.025) {
    const mixed = mixHex(colour, ink, Math.max(w, 0));
    if (contrast(mixed, bg) >= min) return mixed;
  }
  return ink;
}

/**
 * Step `colour` off `from` when the two collapse (planes may not). A plane
 * already at the end of its direction — a white surface asked to go lighter —
 * steps the other way instead.
 */
function distinct(colour: string, from: string, toward: string): string {
  if (colour !== from) return colour;
  const opposite = toward === "#ffffff" ? "#000000" : "#ffffff";
  for (const target of [toward, opposite]) {
    const nudged = mixHex(colour, target, 0.94);
    if (nudged !== from) return nudged;
  }
  return mixHex(colour, opposite, 0.85);
}

/* ------------------------------------------------------------ token scopes */

/**
 * TextMate selector match, VS Code style: a rule scope `a.b` matches the
 * token scope `a.b` and every `a.b.*`. Only the leaf segment of a descendant
 * selector (`meta.x entity.name`) is compared — enough to pick a seed colour.
 */
function scopeScore(ruleScope: string, wanted: string): number {
  const leaf = ruleScope.split(/\s+/).pop() ?? "";
  if (leaf === wanted) return 1000 + leaf.length;
  if (wanted.startsWith(`${leaf}.`)) return leaf.length;
  return -1;
}

/** The foreground VS Code would give `scope`: the most specific rule, later rule on a tie. */
function scopeColour(rules: readonly VsCodeTokenRule[], scopes: readonly string[]): string | undefined {
  for (const wanted of scopes) {
    let best: { score: number; colour: string } | null = null;
    for (const rule of rules) {
      for (const ruleScope of rule.scopes) {
        const score = scopeScore(ruleScope, wanted);
        if (score >= 0 && (best === null || score >= best.score)) best = { score, colour: rule.foreground };
      }
    }
    if (best) return best.colour;
  }
  return undefined;
}

/** Seed → token scopes probed in order; the first scope any rule colours wins. */
const SEED_SCOPES: Record<ThemeSyntaxSeed, readonly string[]> = {
  comment: ["comment.line", "comment"],
  string: ["string.quoted.double", "string"],
  constant: ["constant.numeric", "constant.language", "constant"],
  function: ["entity.name.function", "support.function"],
  type: ["entity.name.type", "entity.name.class", "support.type", "storage.type"],
  property: ["variable.other.property", "support.type.property-name", "variable.other.object.property", "variable"],
};

/* ---------------------------------------------------------------- mapping */

/** VS Code's own terminal defaults (terminalColorRegistry.ts), used where a theme names none. */
const TERMINAL_DEFAULTS: Record<"dark" | "light", Record<string, string>> = {
  dark: {
    red: "#cd3131",
    green: "#0dbc79",
    yellow: "#e5e510",
    blue: "#2472c8",
    magenta: "#bc3fbc",
    cyan: "#11a8cd",
  },
  light: {
    red: "#cd3131",
    green: "#107c10",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
  },
};

/** VS Code's editor defaults (editorColors.ts / baseColors.ts). */
const EDITOR_DEFAULTS = {
  dark: { background: "#1e1e1e", foreground: "#d4d4d4" },
  light: { background: "#ffffff", foreground: "#000000" },
} as const;

const ANSI_KEYS: Record<string, string> = {
  red: "terminal.ansiRed",
  green: "terminal.ansiGreen",
  yellow: "terminal.ansiYellow",
  blue: "terminal.ansiBlue",
  magenta: "terminal.ansiMagenta",
  cyan: "terminal.ansiCyan",
  brightRed: "terminal.ansiBrightRed",
  brightGreen: "terminal.ansiBrightGreen",
  brightYellow: "terminal.ansiBrightYellow",
  brightBlue: "terminal.ansiBrightBlue",
  brightMagenta: "terminal.ansiBrightMagenta",
  brightCyan: "terminal.ansiBrightCyan",
};

/** `vscode-` + a slug of the label; an empty slug falls back to `theme`. */
export function importedThemeId(label: string): string {
  const slug = label
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return `${IMPORTED_THEME_ID_PREFIX}${slug === "" ? "theme" : slug}`;
}

/**
 * Map a resolved VS Code theme onto omp-ui's token set. VS Code's own keys
 * name the planes (`editor.background`, `sideBar.background`, …), the ink
 * (`editor.foreground`, `descriptionForeground`), the accents (the terminal
 * ANSI colours, which every theme sets and which already carry the meanings
 * omp-ui's accents do: green success, yellow attention, red error, magenta
 * the user's own voice), and the syntax seeds (`tokenColors`). Every colour
 * that must clear a contrast floor is lifted toward the ink only as far as
 * that floor needs, so a theme keeps its hues; the gate then runs unchanged.
 * Signal stays reserved for liveness (ADR-0004): it is the theme's green,
 * never its brand accent.
 */
export function mapVsCodeTheme(doc: VsCodeThemeDocument, label: string): ThemeSource {
  const editorBgRaw = doc.colors["editor.background"];
  const typeDark = doc.type === "dark" || doc.type === "hc";
  const typeLight = doc.type === "light" || doc.type === "hcLight";
  // An untyped theme is classified by its own editor background.
  const provisional = normalizeVsCodeColour(editorBgRaw, "#000000");
  const dark = typeDark || (!typeLight && (provisional === null || relativeLuminance(provisional) < 0.2));
  const scheme = dark ? "dark" : "light";
  const defaults = EDITOR_DEFAULTS[scheme];

  const surface = normalizeVsCodeColour(editorBgRaw, defaults.background) ?? defaults.background;
  const colour = (key: string, over: string = surface): string | null =>
    normalizeVsCodeColour(doc.colors[key], over);
  const first = (keys: readonly string[], over: string = surface): string | null => {
    for (const key of keys) {
      const value = colour(key, over);
      if (value !== null) return value;
    }
    return null;
  };

  // Curated themes sink void/sunken below the surface and lift raised/overlay
  // above it in both schemes; hover and borders step toward the ink.
  const deeper = "#000000";
  const lighter = "#ffffff";
  const toward = dark ? "#ffffff" : "#000000";
  const rawInk = first(["editor.foreground", "foreground"]) ?? defaults.foreground;
  const ink = readable(rawInk, surface, toward, 10);

  // Planes: VS Code's own chrome surfaces where the theme sets them,
  // otherwise small steps off the editor background in the theme's direction.
  const step = (base: string, weight: number, target: string): string => mixHex(base, target, 1 - weight);
  const sunken = distinct(
    first(["sideBar.background", "activityBar.background", "panel.background"]) ?? step(surface, 0.04, deeper),
    surface,
    deeper,
  );
  const voidPlane = distinct(
    first(["titleBar.activeBackground", "activityBar.background", "editorGroupHeader.tabsBackground"]) ??
      step(sunken, 0.04, deeper),
    surface,
    deeper,
  );
  const raised = distinct(
    first(["editorWidget.background", "input.background", "dropdown.background"]) ?? step(surface, 0.04, lighter),
    surface,
    lighter,
  );
  const overlay = distinct(
    first(["editorSuggestWidget.background", "quickInput.background", "menu.background"]) ??
      step(raised, 0.05, lighter),
    surface,
    lighter,
  );
  let hover = first(["list.hoverBackground", "list.inactiveSelectionBackground", "toolbar.hoverBackground"]) ??
    step(overlay, 0.06, toward);
  // Ink must read on the hover chip (plan review uses it): step back toward
  // the surface until it does.
  for (let w = 0.9; contrast(ink, hover) < 4.5 && w >= 0; w -= 0.1) hover = mixHex(hover, surface, w);
  hover = distinct(hover, raised, toward);

  const line = first(["panel.border", "sideBar.border", "editorGroup.border", "widget.border"]) ??
    step(surface, 0.12, toward);
  const lineSoft = mixHex(line, surface, 0.55);
  const lineStrong = first(["focusBorder", "input.border", "contrastBorder"]) ?? step(line, 0.12, toward);

  // Ink tiers: the theme's own secondary foregrounds, lifted to each floor
  // on both the surface and the raised plane (disabled chrome sits on raised).
  const tier = (keys: readonly string[], weight: number, min: number): string => {
    const base = first(keys) ?? mixHex(ink, surface, weight);
    const onSurface = readable(base, surface, ink, min);
    return readable(onSurface, raised, ink, min);
  };
  const inkMid = tier(["descriptionForeground", "sideBar.foreground"], 0.72, 4.5);
  const inkDim = tier(["tab.inactiveForeground", "editorLineNumber.foreground"], 0.55, 3);
  const inkFaint = tier(["disabledForeground", "editorLineNumber.foreground"], 0.42, 2);

  const ansi = TERMINAL_DEFAULTS[scheme];
  const termColour = (slot: string): string =>
    colour(ANSI_KEYS[slot]!, surface) ?? normalizeVsCodeColour(ansi[slot], surface) ?? ink;

  // An accent must clear 3:1 on the surface AND on its own wash.
  const accent = (raw: string): { colour: string; dim: string; wash: string } => {
    const lifted = readable(raw, surface, ink, 3);
    let wash = mixHex(lifted, surface, dark ? 0.16 : 0.14);
    if (!dark) {
      // Light washes must separate from raised by 1.2:1 (issue #66) yet keep the accent at 3:1.
      for (let w = 0.14; contrast(wash, raised) < 1.2 && w <= 0.5; w += 0.02) wash = mixHex(lifted, surface, w);
    }
    const colourOnWash = readable(lifted, wash, ink, 3);
    return { colour: colourOnWash, dim: mixHex(colourOnWash, surface, 0.6), wash };
  };
  const signal = accent(first(["terminal.ansiGreen", "gitDecoration.untrackedResourceForeground"]) ?? termColour("green"));
  const copper = accent(first(["editorWarning.foreground", "terminal.ansiYellow"]) ?? termColour("yellow"));
  const rose = accent(first(["editorError.foreground", "errorForeground", "terminal.ansiRed"]) ?? termColour("red"));
  const iris = accent(first(["terminal.ansiMagenta"]) ?? termColour("magenta"));

  // The plan link (iris mixed 70% with ink) must read at 4.5:1 on the surface.
  // Bounded by weight, not by reaching `ink`: rounding can stall a geometric
  // mix one channel step short of it forever.
  let irisColour = iris.colour;
  for (let w = 0.9; contrast(mixHex(irisColour, ink, 0.7), surface) < 4.5 && w >= 0; w -= 0.1) {
    irisColour = mixHex(iris.colour, ink, w);
  }

  const thinkEnd = (raw: string): string => readable(readable(raw, surface, ink, 3), overlay, ink, 3);
  const thinkCool = thinkEnd(termColour("cyan"));
  const thinkWarm = thinkEnd(termColour("magenta"));

  const tokens: Record<ThemeTokenName, string> = {
    "--color-void": voidPlane,
    "--color-sunken": sunken,
    "--color-surface": surface,
    "--color-raised": raised,
    "--color-overlay": overlay,
    "--color-hover": hover,
    "--color-line": line,
    "--color-line-soft": lineSoft,
    "--color-line-strong": lineStrong,
    "--color-ink": ink,
    "--color-ink-mid": inkMid,
    "--color-ink-dim": inkDim,
    "--color-ink-faint": inkFaint,
    "--color-signal": signal.colour,
    "--color-signal-dim": signal.dim,
    "--color-signal-wash": signal.wash,
    "--color-copper": copper.colour,
    "--color-copper-dim": copper.dim,
    "--color-copper-wash": copper.wash,
    "--color-rose": rose.colour,
    "--color-rose-dim": rose.dim,
    "--color-rose-wash": rose.wash,
    "--color-iris": irisColour,
    "--color-iris-dim": iris.dim,
    "--color-iris-wash": iris.wash,
    "--color-think-cool": thinkCool,
    "--color-think-warm": thinkWarm,
    "--color-edge-hi": dark ? "rgb(255 255 255 / 0.05)" : "rgb(255 255 255 / 0.9)",
    "--color-edge-lo": dark ? "rgb(0 0 0 / 0.4)" : "rgb(15 23 32 / 0.10)",
  };

  const seedFallback: Record<ThemeSyntaxSeed, string> = {
    comment: inkDim,
    string: termColour("green"),
    constant: termColour("magenta"),
    function: termColour("blue"),
    type: termColour("cyan"),
    property: inkMid,
  };
  const syntax = {} as Record<ThemeSyntaxSeed, string>;
  for (const seed of Object.keys(SEED_SCOPES) as ThemeSyntaxSeed[]) {
    const raw = normalizeVsCodeColour(scopeColour(doc.tokenColors, SEED_SCOPES[seed]), surface) ?? seedFallback[seed];
    syntax[seed] = readable(raw, surface, ink, 3);
  }

  // Keyword is the one shiki role whose projection (iris) would replace the
  // theme's own colour; carry it as an override when the theme names one.
  const code: Partial<Record<"keyword", string>> = {};
  const keyword = normalizeVsCodeColour(scopeColour(doc.tokenColors, ["keyword.control", "keyword", "storage"]), surface);
  if (keyword !== null) {
    const lifted = readable(keyword, surface, ink, 3);
    if (lifted !== irisColour) code.keyword = lifted;
  }

  // Terminal: the theme's own ANSI slots, lifted to 3:1 on the terminal
  // background (the surface). Brights the theme omits stay derived.
  const term: Partial<Record<ThemeTerminalSlot, string>> = {};
  const projected = deriveTheme({ id: "probe", label, dark, tokens, syntax }).term;
  for (const slot of Object.keys(ANSI_KEYS) as ThemeTerminalSlot[]) {
    const raw = colour(ANSI_KEYS[slot]!, surface);
    if (raw === null) continue;
    const lifted = readable(raw, surface, ink, 3);
    if (lifted !== projected[slot]) term[slot] = lifted;
  }

  const source: ThemeSource = { id: importedThemeId(label), label, dark, tokens, syntax };
  if (Object.keys(term).length > 0 || Object.keys(code).length > 0) {
    source.overrides = {};
    if (Object.keys(term).length > 0) source.overrides.term = term;
    if (Object.keys(code).length > 0) source.overrides.code = code;
  }
  return source;
}

/**
 * Parse → map → gate, for a theme whose `include` chain is already resolved.
 * `labelFallback` names a theme whose file has no `name` (the file name).
 */
export function importVsCodeTheme(doc: VsCodeThemeDocument, labelFallback: string): VsCodeImportResult {
  const label = (doc.name ?? labelFallback).trim().slice(0, 80) || "Imported theme";
  let source: ThemeSource;
  try {
    source = mapVsCodeTheme(doc, label);
  } catch (err) {
    return { ok: false, reason: "parse", message: err instanceof Error ? err.message : String(err) };
  }
  const failures = themeContrastFailures(deriveTheme(source));
  if (failures.length > 0) return { ok: false, reason: "contrast", label, failures };
  return { ok: true, source };
}

/** One picked file: its base name and UTF-8 text. */
export interface VsCodeThemeFileInput {
  name: string;
  text: string;
}

/** Largest accepted theme file; One Dark Pro, a large one, is ~63 KB. */
export const VSCODE_THEME_FILE_BYTES_MAX = 2 * 1024 * 1024;
/** Most files one import may carry: the theme plus its `include` chain. */
export const VSCODE_THEME_FILES_MAX = VSCODE_INCLUDE_DEPTH_MAX + 1;

function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/**
 * Import from picked files: the first is the theme, the rest may supply its
 * `include` chain, matched by base name (a picker hands over names, never
 * paths). A missing include fails with the file to pick alongside.
 */
export function importVsCodeThemeFiles(files: readonly VsCodeThemeFileInput[]): VsCodeImportResult {
  const [theme] = files;
  if (theme === undefined) return { ok: false, reason: "parse", message: "no file was selected" };
  if (files.length > VSCODE_THEME_FILES_MAX) {
    return { ok: false, reason: "parse", message: `at most ${VSCODE_THEME_FILES_MAX} files can be imported together` };
  }
  const byName = new Map(files.map((file) => [baseName(file.name).toLowerCase(), file]));
  const chain: VsCodeThemeFile[] = [];
  const visited = new Set<string>();
  let current: VsCodeThemeFileInput | undefined = theme;
  while (current !== undefined) {
    const name = baseName(current.name);
    if (visited.has(name.toLowerCase())) return { ok: false, reason: "parse", message: `the include chain loops back to ${name}` };
    if (chain.length > VSCODE_INCLUDE_DEPTH_MAX) {
      return { ok: false, reason: "parse", message: `the include chain is deeper than ${VSCODE_INCLUDE_DEPTH_MAX}` };
    }
    visited.add(name.toLowerCase());
    let parsed: VsCodeThemeFile;
    try {
      parsed = parseVsCodeThemeFile(current.text);
    } catch (err) {
      return { ok: false, reason: "parse", message: `${name}: ${err instanceof Error ? err.message : String(err)}` };
    }
    chain.push(parsed);
    if (parsed.include === null) break;
    const includeName = baseName(parsed.include);
    current = byName.get(includeName.toLowerCase());
    if (current === undefined) {
      return { ok: false, reason: "parse", message: `${name} includes ${includeName}; select it together with the theme` };
    }
  }
  const fileLabel = baseName(theme.name).replace(/\.(?:jsonc?|color-theme\.json)$/i, "");
  return importVsCodeTheme(mergeVsCodeThemeChain(chain), fileLabel);
}
