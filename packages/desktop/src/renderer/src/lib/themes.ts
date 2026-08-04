import { useSyncExternalStore } from "react";
import { backend } from "../backend";

/**
 * Runtime themes (issue #36).
 *
 * This file is the ONE place literal hex lives in the renderer. A palette has
 * three consumers that cannot share a mechanism — Tailwind's `--color-*`
 * tokens (CSS), xterm's ITheme (canvas, cannot read CSS), and shiki's theme
 * (tokens are emitted as inline `style={{ color }}`) — so a theme that lived
 * only in `style.css` would still leave two palettes drifting behind it. Each
 * `Theme` below carries all three, authored together, so a switch is atomic.
 *
 * `style.css` keeps the graphite `@theme` block as the *build-time* default;
 * `applyTheme` overrides those same custom properties on the root element,
 * which Tailwind v4 utilities dereference at paint time (`.bg-surface` is
 * `background-color: var(--color-surface)`), so no CSS rebuild is involved.
 * Consequence: `graphite`'s `tokens` must stay byte-identical to that block.
 *
 * Every theme keeps the reservation from ADR-0004: `signal` is agent liveness
 * and success only, `copper` attention, `rose` failure, `iris` the user's own
 * voice. A borrowed palette (Monokai, Solarized) is re-mapped onto those four
 * roles rather than copied slot-for-slot, because the "is it working?" glance
 * is a property of the reservation, not of any particular hue.
 */

export interface Theme {
  id: string;
  label: string;
  /** Drives `color-scheme` and the dark-chrome utilities. */
  dark: boolean;
  /** Every `--color-*` token from style.css's @theme block. */
  tokens: Record<string, string>;
  /** The xterm ITheme, replacing TERM_THEME. */
  term: Record<string, string>;
  /** The shiki theme's colours, replacing GRAPHITE's literals. */
  code: {
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
  };
}

export const THEMES: readonly Theme[] = [
  {
    id: "graphite",
    label: "Graphite",
    dark: true,
    tokens: {
      "--color-void": "#0a0b0d",
      "--color-sunken": "#0e1013",
      "--color-surface": "#14171b",
      "--color-raised": "#1a1e23",
      "--color-overlay": "#22272e",
      "--color-hover": "#2a3037",
      "--color-line": "#23282f",
      "--color-line-soft": "#1b1f24",
      "--color-line-strong": "#333a43",
      "--color-ink": "#e8ecf1",
      "--color-ink-mid": "#a8b2bf",
      "--color-ink-dim": "#6f7b8a",
      "--color-ink-faint": "#4a5361",
      "--color-signal": "#4ade9f",
      "--color-signal-dim": "#2a8f65",
      "--color-signal-wash": "#0f2a20",
      "--color-copper": "#f0a868",
      "--color-copper-dim": "#a8703c",
      "--color-copper-wash": "#2a1e12",
      "--color-rose": "#f2748c",
      "--color-rose-dim": "#a34355",
      "--color-rose-wash": "#2b1419",
      "--color-iris": "#9d8cf5",
      "--color-iris-dim": "#6152a8",
      "--color-iris-wash": "#1c1830",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)",
    },
    term: {
      background: "#14171b",
      foreground: "#e8ecf1",
      cursor: "#4ade9f",
      cursorAccent: "#14171b",
      selectionBackground: "#9d8cf559",
      selectionInactiveBackground: "#9d8cf52e",
      black: "#0e1013",
      red: "#f2748c",
      green: "#4ade9f",
      yellow: "#f0a868",
      blue: "#7fa9f0",
      magenta: "#9d8cf5",
      cyan: "#66d9d2",
      white: "#a8b2bf",
      brightBlack: "#4a5361",
      brightRed: "#ef9cad",
      brightGreen: "#7ee3ba",
      brightYellow: "#edbe95",
      brightBlue: "#a2bff0",
      brightMagenta: "#b6acf4",
      brightCyan: "#91dfdc",
      brightWhite: "#e8ecf1",
    },
    code: {
      foreground: "#e8ecf1",
      comment: "#5f6b7c",
      string: "#e0b184",
      constant: "#e39db5",
      keyword: "#9d8cf5",
      function: "#7fb8e8",
      type: "#6fc7d4",
      property: "#a8c5e8",
      punctuation: "#a8b2bf",
      inserted: "#8fd4b8",
      deleted: "#f2748c",
    },
  },
  {
    id: "dark-modern",
    label: "Dark Modern",
    dark: true,
    tokens: {
      "--color-void": "#141414",
      "--color-sunken": "#181818",
      "--color-surface": "#1f1f1f",
      "--color-raised": "#252526",
      "--color-overlay": "#2d2d30",
      "--color-hover": "#37373d",
      "--color-line": "#2b2b2b",
      "--color-line-soft": "#242424",
      "--color-line-strong": "#3c3c3c",
      "--color-ink": "#e7e7e7",
      "--color-ink-mid": "#b5b5b5",
      "--color-ink-dim": "#8b8b8b",
      "--color-ink-faint": "#5f5f5f",
      "--color-signal": "#4ec9a2",
      "--color-signal-dim": "#2f8468",
      "--color-signal-wash": "#12271f",
      "--color-copper": "#dcb67a",
      "--color-copper-dim": "#957a4d",
      "--color-copper-wash": "#2a2114",
      "--color-rose": "#f14c4c",
      "--color-rose-dim": "#a13636",
      "--color-rose-wash": "#2c1616",
      "--color-iris": "#9c8cf0",
      "--color-iris-dim": "#61549c",
      "--color-iris-wash": "#1d1a2e",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)",
    },
    term: {
      background: "#1f1f1f",
      foreground: "#e7e7e7",
      cursor: "#4ec9a2",
      cursorAccent: "#1f1f1f",
      selectionBackground: "#9c8cf059",
      selectionInactiveBackground: "#9c8cf02e",
      black: "#181818",
      red: "#f14c4c",
      green: "#4ec9a2",
      yellow: "#dcb67a",
      blue: "#569cd6",
      magenta: "#9c8cf0",
      cyan: "#4ec9b0",
      white: "#b5b5b5",
      brightBlack: "#5f5f5f",
      brightRed: "#ee7f7f",
      brightGreen: "#80d3b9",
      brightYellow: "#e0c69e",
      brightBlue: "#86b5dc",
      brightMagenta: "#b5aaed",
      brightCyan: "#80d3c2",
      brightWhite: "#e7e7e7",
    },
    code: {
      foreground: "#e7e7e7",
      comment: "#6a9955",
      string: "#ce9178",
      constant: "#b5cea8",
      keyword: "#9c8cf0",
      function: "#dcdcaa",
      type: "#4ec9b0",
      property: "#9cdcfe",
      punctuation: "#b5b5b5",
      inserted: "#7cd6a7",
      deleted: "#f14c4c",
    },
  },
  {
    id: "monokai",
    label: "Monokai",
    dark: true,
    tokens: {
      "--color-void": "#1b1c18",
      "--color-sunken": "#22231e",
      "--color-surface": "#272822",
      "--color-raised": "#2f302a",
      "--color-overlay": "#3a3b34",
      "--color-hover": "#49483e",
      "--color-line": "#3b3c35",
      "--color-line-soft": "#2f302a",
      "--color-line-strong": "#54554c",
      "--color-ink": "#f8f8f2",
      "--color-ink-mid": "#c8c8bd",
      "--color-ink-dim": "#9a9a8d",
      "--color-ink-faint": "#75715e",
      "--color-signal": "#a6e22e",
      "--color-signal-dim": "#6f9720",
      "--color-signal-wash": "#222a12",
      "--color-copper": "#fd971f",
      "--color-copper-dim": "#ac6715",
      "--color-copper-wash": "#2e2011",
      "--color-rose": "#f92672",
      "--color-rose-dim": "#a81b4e",
      "--color-rose-wash": "#2c1220",
      "--color-iris": "#ae81ff",
      "--color-iris-dim": "#7455ab",
      "--color-iris-wash": "#241d33",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)",
    },
    term: {
      background: "#272822",
      foreground: "#f8f8f2",
      cursor: "#a6e22e",
      cursorAccent: "#272822",
      selectionBackground: "#ae81ff59",
      selectionInactiveBackground: "#ae81ff2e",
      black: "#22231e",
      red: "#f92672",
      green: "#a6e22e",
      yellow: "#fd971f",
      blue: "#66d9ef",
      magenta: "#ae81ff",
      cyan: "#66d9ef",
      white: "#c8c8bd",
      brightBlack: "#75715e",
      brightRed: "#f96b9c",
      brightGreen: "#c1e96f",
      brightYellow: "#fbb765",
      brightBlue: "#96e3f0",
      brightMagenta: "#c6a8fb",
      brightCyan: "#96e3f0",
      brightWhite: "#f8f8f2",
    },
    code: {
      foreground: "#f8f8f2",
      comment: "#75715e",
      string: "#e6db74",
      constant: "#ae81ff",
      keyword: "#ae81ff",
      function: "#a6e22e",
      type: "#66d9ef",
      property: "#fd971f",
      punctuation: "#c8c8bd",
      inserted: "#a6e22e",
      deleted: "#f92672",
    },
  },
  {
    id: "solarized-dark",
    label: "Solarized Dark",
    dark: true,
    tokens: {
      "--color-void": "#00212b",
      "--color-sunken": "#002028",
      "--color-surface": "#002b36",
      "--color-raised": "#01323d",
      "--color-overlay": "#073642",
      "--color-hover": "#0c4553",
      "--color-line": "#0b3c49",
      "--color-line-soft": "#04303b",
      "--color-line-strong": "#14505f",
      "--color-ink": "#eee8d5",
      "--color-ink-mid": "#93a1a1",
      "--color-ink-dim": "#839496",
      "--color-ink-faint": "#586e75",
      "--color-signal": "#2aa198",
      "--color-signal-dim": "#1c6b65",
      "--color-signal-wash": "#032b2e",
      "--color-copper": "#cb4b16",
      "--color-copper-dim": "#8a330f",
      "--color-copper-wash": "#2a1a10",
      "--color-rose": "#dc322f",
      "--color-rose-dim": "#94211f",
      "--color-rose-wash": "#2b1315",
      "--color-iris": "#6c71c4",
      "--color-iris-dim": "#484c85",
      "--color-iris-wash": "#151d33",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)",
    },
    term: {
      background: "#002b36",
      foreground: "#eee8d5",
      cursor: "#2aa198",
      cursorAccent: "#002b36",
      selectionBackground: "#6c71c459",
      selectionInactiveBackground: "#6c71c42e",
      black: "#002028",
      red: "#dc322f",
      green: "#2aa198",
      yellow: "#cb4b16",
      blue: "#268bd2",
      magenta: "#6c71c4",
      cyan: "#2aa198",
      white: "#93a1a1",
      brightBlack: "#586e75",
      brightRed: "#e26e66",
      brightGreen: "#6bb8ac",
      brightYellow: "#d77f55",
      brightBlue: "#68aad3",
      brightMagenta: "#9798ca",
      brightCyan: "#6bb8ac",
      brightWhite: "#eee8d5",
    },
    code: {
      foreground: "#eee8d5",
      comment: "#5d757c",
      string: "#b58900",
      constant: "#d33682",
      keyword: "#6c71c4",
      function: "#268bd2",
      type: "#2aa198",
      property: "#93a1a1",
      punctuation: "#93a1a1",
      inserted: "#859900",
      deleted: "#dc322f",
    },
  },
  {
    id: "light",
    label: "Light",
    dark: false,
    tokens: {
      "--color-void": "#e8ecf0",
      "--color-sunken": "#f1f4f7",
      "--color-surface": "#fafbfc",
      "--color-raised": "#ffffff",
      "--color-overlay": "#ffffff",
      "--color-hover": "#e6ebf0",
      "--color-line": "#d8dee5",
      "--color-line-soft": "#e7ecf1",
      "--color-line-strong": "#b9c2cc",
      "--color-ink": "#12161b",
      "--color-ink-mid": "#41505f",
      "--color-ink-dim": "#5f6f7e",
      "--color-ink-faint": "#8c9aa8",
      "--color-signal": "#0f7d55",
      "--color-signal-dim": "#14a06d",
      "--color-signal-wash": "#dff3e9",
      "--color-copper": "#a3560c",
      "--color-copper-dim": "#c97a2a",
      "--color-copper-wash": "#fbeedd",
      "--color-rose": "#b31d3a",
      "--color-rose-dim": "#d24a63",
      "--color-rose-wash": "#fce8ec",
      "--color-iris": "#4a34b8",
      "--color-iris-dim": "#6f5ad0",
      "--color-iris-wash": "#eae5fb",
      "--color-edge-hi": "rgb(255 255 255 / 0.9)",
      "--color-edge-lo": "rgb(15 23 32 / 0.10)",
    },
    term: {
      background: "#fafbfc",
      foreground: "#12161b",
      cursor: "#0f7d55",
      cursorAccent: "#fafbfc",
      selectionBackground: "#4a34b859",
      selectionInactiveBackground: "#4a34b82e",
      black: "#12161b",
      red: "#b31d3a",
      green: "#0f7d55",
      yellow: "#a3560c",
      blue: "#1c5fb0",
      magenta: "#4a34b8",
      cyan: "#0b7078",
      white: "#41505f",
      brightBlack: "#5f6f7e",
      brightRed: "#7e1b30",
      brightGreen: "#105b42",
      brightYellow: "#734111",
      brightBlue: "#19477f",
      brightMagenta: "#382a84",
      brightCyan: "#0d5259",
      brightWhite: "#12161b",
    },
    code: {
      foreground: "#12161b",
      comment: "#6a7885",
      string: "#984b1a",
      constant: "#a11a6b",
      keyword: "#4a34b8",
      function: "#1c5fb0",
      type: "#0b7078",
      property: "#2a5a8a",
      punctuation: "#41505f",
      inserted: "#0f7d55",
      deleted: "#b31d3a",
    },
  },
  {
    id: "solarized-light",
    label: "Solarized Light",
    dark: false,
    tokens: {
      "--color-void": "#e6e0cd",
      "--color-sunken": "#eee8d5",
      "--color-surface": "#f7f1de",
      "--color-raised": "#fdf6e3",
      "--color-overlay": "#fffaec",
      "--color-hover": "#e9e2cf",
      "--color-line": "#ded8c4",
      "--color-line-soft": "#eee8d5",
      "--color-line-strong": "#bfb99f",
      "--color-ink": "#073642",
      "--color-ink-mid": "#586e75",
      "--color-ink-dim": "#657b83",
      "--color-ink-faint": "#93a1a1",
      "--color-signal": "#1a7d76",
      "--color-signal-dim": "#2aa198",
      "--color-signal-wash": "#dcefe9",
      "--color-copper": "#a3480f",
      "--color-copper-dim": "#cb4b16",
      "--color-copper-wash": "#f7e6d6",
      "--color-rose": "#b02724",
      "--color-rose-dim": "#dc322f",
      "--color-rose-wash": "#f8e2df",
      "--color-iris": "#4f53a3",
      "--color-iris-dim": "#6c71c4",
      "--color-iris-wash": "#e5e5f4",
      "--color-edge-hi": "rgb(255 255 255 / 0.9)",
      "--color-edge-lo": "rgb(15 23 32 / 0.10)",
    },
    term: {
      background: "#f7f1de",
      foreground: "#073642",
      cursor: "#1a7d76",
      cursorAccent: "#f7f1de",
      selectionBackground: "#4f53a359",
      selectionInactiveBackground: "#4f53a32e",
      black: "#073642",
      red: "#b02724",
      green: "#1a7d76",
      yellow: "#a3480f",
      blue: "#1c6fa8",
      magenta: "#4f53a3",
      cyan: "#1a7d76",
      white: "#586e75",
      brightBlack: "#657b83",
      brightRed: "#782c2e",
      brightGreen: "#146665",
      brightYellow: "#704220",
      brightBlue: "#155c86",
      brightMagenta: "#374983",
      brightCyan: "#146665",
      brightWhite: "#073642",
    },
    code: {
      foreground: "#073642",
      comment: "#7c8d8d",
      string: "#8a6800",
      constant: "#a32468",
      keyword: "#4f53a3",
      function: "#1c6fa8",
      type: "#1a7d76",
      property: "#586e75",
      punctuation: "#586e75",
      inserted: "#5f7000",
      deleted: "#b02724",
    },
  },
];

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
