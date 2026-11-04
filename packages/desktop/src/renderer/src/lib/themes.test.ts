// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import themeSourcesJson from "./theme-sources.json";
import {
  THEME_TOKEN_NAMES,
  deriveCode,
  deriveTerminal,
  deriveTheme,
  mixHex,
  themeContrastFailures,
} from "@omp-ui/core/theme";
import { THEMES, type Theme, type ThemeSource } from "./themes";

/** Fully-derived issue #163 migration fixture; remove only with an intentional palette change. */
/** Derived from lib/theme-sources.json; regenerate with the palette (issue #1042 ink AA lift). */
const LEGACY_THEMES: readonly Theme[] = [
  {
    "id": "graphite",
    "label": "Graphite",
    "dark": true,
    "tokens": {
      "--color-void": "#0a0b0d",
      "--color-sunken": "#0e1013",
      "--color-surface": "#14171b",
      "--color-raised": "#1a1e23",
      "--color-overlay": "#22272e",
      "--color-hover": "#2a3037",
      "--color-line": "#23282f",
      "--color-line-soft": "#1b1f24",
      "--color-line-strong": "#333a43",
      "--color-ink": "#eaeef3",
      "--color-ink-mid": "#c4cedb",
      "--color-ink-dim": "#adb6c1",
      "--color-ink-faint": "#989fa9",
      "--color-signal": "#4de0a1",
      "--color-signal-dim": "#2a8f65",
      "--color-signal-wash": "#0f2a20",
      "--color-copper": "#f2aa6a",
      "--color-copper-dim": "#a8703c",
      "--color-copper-wash": "#2a1e12",
      "--color-rose": "#f4768e",
      "--color-rose-dim": "#a34355",
      "--color-rose-wash": "#2b1419",
      "--color-iris": "#a190f9",
      "--color-iris-dim": "#6152a8",
      "--color-iris-wash": "#1c1830",
      "--color-think-cool": "#71c5ea",
      "--color-think-warm": "#f188c6",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#14171b",
      "foreground": "#eaeef3",
      "cursor": "#4de0a1",
      "cursorAccent": "#14171b",
      "selectionBackground": "#a190f959",
      "selectionInactiveBackground": "#a190f92e",
      "black": "#0e1013",
      "red": "#f4768e",
      "green": "#4de0a1",
      "yellow": "#f2aa6a",
      "blue": "#7fa9f0",
      "magenta": "#a190f9",
      "cyan": "#66d9d2",
      "white": "#c4cedb",
      "brightBlack": "#989fa9",
      "brightRed": "#ef9cad",
      "brightGreen": "#7ee3ba",
      "brightYellow": "#edbe95",
      "brightBlue": "#a2bff0",
      "brightMagenta": "#b6acf4",
      "brightCyan": "#91dfdc",
      "brightWhite": "#eaeef3"
    },
    "code": {
      "foreground": "#eaeef3",
      "comment": "#5f6b7c",
      "string": "#e0b184",
      "constant": "#e39db5",
      "keyword": "#a190f9",
      "function": "#7fb8e8",
      "type": "#6fc7d4",
      "property": "#a8c5e8",
      "punctuation": "#c4cedb",
      "inserted": "#8fd4b8",
      "deleted": "#f4768e"
    }
  },
  {
    "id": "dark-modern",
    "label": "Dark Modern",
    "dark": true,
    "tokens": {
      "--color-void": "#141414",
      "--color-sunken": "#181818",
      "--color-surface": "#1f1f1f",
      "--color-raised": "#252526",
      "--color-overlay": "#2d2d30",
      "--color-hover": "#37373d",
      "--color-line": "#2b2b2b",
      "--color-line-soft": "#242424",
      "--color-line-strong": "#3c3c3c",
      "--color-ink": "#e9e9e9",
      "--color-ink-mid": "#cdcdcd",
      "--color-ink-dim": "#bababa",
      "--color-ink-faint": "#a8a8a8",
      "--color-signal": "#51cba4",
      "--color-signal-dim": "#2f8468",
      "--color-signal-wash": "#12271f",
      "--color-copper": "#deb87c",
      "--color-copper-dim": "#957a4d",
      "--color-copper-wash": "#2a2114",
      "--color-rose": "#fb8685",
      "--color-rose-dim": "#a13636",
      "--color-rose-wash": "#2c1616",
      "--color-iris": "#61acff",
      "--color-iris-dim": "#2e64a6",
      "--color-iris-wash": "#132233",
      "--color-think-cool": "#52c3ff",
      "--color-think-warm": "#e788ca",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#1f1f1f",
      "foreground": "#e9e9e9",
      "cursor": "#51cba4",
      "cursorAccent": "#1f1f1f",
      "selectionBackground": "#61acff59",
      "selectionInactiveBackground": "#61acff2e",
      "black": "#181818",
      "red": "#fb8685",
      "green": "#51cba4",
      "yellow": "#deb87c",
      "blue": "#569cd6",
      "magenta": "#c586c0",
      "cyan": "#4ec9b0",
      "white": "#cdcdcd",
      "brightBlack": "#a8a8a8",
      "brightRed": "#ee7f7f",
      "brightGreen": "#80d3b9",
      "brightYellow": "#e0c69e",
      "brightBlue": "#86b5dc",
      "brightMagenta": "#b5aaed",
      "brightCyan": "#80d3c2",
      "brightWhite": "#e9e9e9"
    },
    "code": {
      "foreground": "#e9e9e9",
      "comment": "#6a9955",
      "string": "#ce9178",
      "constant": "#b5cea8",
      "keyword": "#61acff",
      "function": "#dcdcaa",
      "type": "#4ec9b0",
      "property": "#9cdcfe",
      "punctuation": "#cdcdcd",
      "inserted": "#7cd6a7",
      "deleted": "#fb8685"
    }
  },
  {
    "id": "monokai",
    "label": "Monokai",
    "dark": true,
    "tokens": {
      "--color-void": "#1b1c18",
      "--color-sunken": "#22231e",
      "--color-surface": "#272822",
      "--color-raised": "#2f302a",
      "--color-overlay": "#3a3b34",
      "--color-hover": "#49483e",
      "--color-line": "#3b3c35",
      "--color-line-soft": "#2f302a",
      "--color-line-strong": "#54554c",
      "--color-ink": "#fafaf4",
      "--color-ink-mid": "#e0e0d7",
      "--color-ink-dim": "#d0d0c5",
      "--color-ink-faint": "#c1bfb2",
      "--color-signal": "#a8e431",
      "--color-signal-dim": "#6f9720",
      "--color-signal-wash": "#222a12",
      "--color-copper": "#ffac43",
      "--color-copper-dim": "#ac6715",
      "--color-copper-wash": "#2e2011",
      "--color-rose": "#ffa2c5",
      "--color-rose-dim": "#a81b4e",
      "--color-rose-wash": "#2c1220",
      "--color-iris": "#cfb0ff",
      "--color-iris-dim": "#7455ab",
      "--color-iris-wash": "#241d33",
      "--color-think-cool": "#69dbf1",
      "--color-think-warm": "#f99ed1",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#272822",
      "foreground": "#fafaf4",
      "cursor": "#a8e431",
      "cursorAccent": "#272822",
      "selectionBackground": "#cfb0ff59",
      "selectionInactiveBackground": "#cfb0ff2e",
      "black": "#22231e",
      "red": "#ffa2c5",
      "green": "#a8e431",
      "yellow": "#ffac43",
      "blue": "#66d9ef",
      "magenta": "#cfb0ff",
      "cyan": "#66d9ef",
      "white": "#e0e0d7",
      "brightBlack": "#c1bfb2",
      "brightRed": "#f96b9c",
      "brightGreen": "#c1e96f",
      "brightYellow": "#fbb765",
      "brightBlue": "#96e3f0",
      "brightMagenta": "#c6a8fb",
      "brightCyan": "#96e3f0",
      "brightWhite": "#fafaf4"
    },
    "code": {
      "foreground": "#fafaf4",
      "comment": "#75715e",
      "string": "#e6db74",
      "constant": "#ae81ff",
      "keyword": "#cfb0ff",
      "function": "#a6e22e",
      "type": "#66d9ef",
      "property": "#fd971f",
      "punctuation": "#e0e0d7",
      "inserted": "#a8e431",
      "deleted": "#ffa2c5"
    }
  },
  {
    "id": "solarized-dark",
    "label": "Solarized Dark",
    "dark": true,
    "tokens": {
      "--color-void": "#00212b",
      "--color-sunken": "#002028",
      "--color-surface": "#002b36",
      "--color-raised": "#01323d",
      "--color-overlay": "#073642",
      "--color-hover": "#0c4553",
      "--color-line": "#0b3c49",
      "--color-line-soft": "#04303b",
      "--color-line-strong": "#14505f",
      "--color-ink": "#f0ead7",
      "--color-ink-mid": "#d1d3c6",
      "--color-ink-dim": "#bcc3bc",
      "--color-ink-faint": "#acb4ae",
      "--color-signal": "#3ac5ba",
      "--color-signal-dim": "#1c6b65",
      "--color-signal-wash": "#032b2e",
      "--color-copper": "#f79c76",
      "--color-copper-dim": "#8a330f",
      "--color-copper-wash": "#2a1a10",
      "--color-rose": "#f39a98",
      "--color-rose-dim": "#94211f",
      "--color-rose-wash": "#2b1315",
      "--color-iris": "#acaee2",
      "--color-iris-dim": "#484c85",
      "--color-iris-wash": "#151d33",
      "--color-think-cool": "#35c1b6",
      "--color-think-warm": "#ee90c0",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#002b36",
      "foreground": "#f0ead7",
      "cursor": "#3ac5ba",
      "cursorAccent": "#002b36",
      "selectionBackground": "#acaee259",
      "selectionInactiveBackground": "#acaee22e",
      "black": "#002028",
      "red": "#f39a98",
      "green": "#3ac5ba",
      "yellow": "#f79c76",
      "blue": "#268bd2",
      "magenta": "#acaee2",
      "cyan": "#2aa198",
      "white": "#d1d3c6",
      "brightBlack": "#acb4ae",
      "brightRed": "#e26e66",
      "brightGreen": "#6bb8ac",
      "brightYellow": "#d77f55",
      "brightBlue": "#68aad3",
      "brightMagenta": "#9798ca",
      "brightCyan": "#6bb8ac",
      "brightWhite": "#f0ead7"
    },
    "code": {
      "foreground": "#f0ead7",
      "comment": "#5d757c",
      "string": "#b58900",
      "constant": "#d33682",
      "keyword": "#acaee2",
      "function": "#268bd2",
      "type": "#2aa198",
      "property": "#93a1a1",
      "punctuation": "#d1d3c6",
      "inserted": "#859900",
      "deleted": "#f39a98"
    }
  },
  {
    "id": "one-dark",
    "label": "One Dark",
    "dark": true,
    "tokens": {
      "--color-void": "#1b1f27",
      "--color-sunken": "#21252e",
      "--color-surface": "#282c34",
      "--color-raised": "#2f343e",
      "--color-overlay": "#383e4a",
      "--color-hover": "#404756",
      "--color-line": "#363c46",
      "--color-line-soft": "#2d323b",
      "--color-line-strong": "#4b5263",
      "--color-ink": "#e1e5ec",
      "--color-ink-mid": "#cfd4dc",
      "--color-ink-dim": "#c3c9d3",
      "--color-ink-faint": "#b8bec7",
      "--color-signal": "#9fca7f",
      "--color-signal-dim": "#69845c",
      "--color-signal-wash": "#1e2a1c",
      "--color-copper": "#e1b58b",
      "--color-copper-dim": "#8a6c51",
      "--color-copper-wash": "#2b2317",
      "--color-rose": "#f3aab0",
      "--color-rose-dim": "#93515a",
      "--color-rose-wash": "#2e1d20",
      "--color-iris": "#dfabee",
      "--color-iris-dim": "#845896",
      "--color-iris-wash": "#2a1e31",
      "--color-think-cool": "#75c5cf",
      "--color-think-warm": "#eea0d3",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#282c34",
      "foreground": "#e1e5ec",
      "cursor": "#9fca7f",
      "cursorAccent": "#282c34",
      "selectionBackground": "#dfabee59",
      "selectionInactiveBackground": "#dfabee2e",
      "black": "#21252e",
      "red": "#f3aab0",
      "green": "#9fca7f",
      "yellow": "#e1b58b",
      "blue": "#61afef",
      "magenta": "#dfabee",
      "cyan": "#56b6c2",
      "white": "#cfd4dc",
      "brightBlack": "#b8bec7",
      "brightRed": "#eebcc2",
      "brightGreen": "#b3d2a0",
      "brightYellow": "#e1c3a8",
      "brightBlue": "#87bfee",
      "brightMagenta": "#e0bced",
      "brightCyan": "#80c4cf",
      "brightWhite": "#e1e5ec"
    },
    "code": {
      "foreground": "#e1e5ec",
      "comment": "#7f848e",
      "string": "#98c379",
      "constant": "#d19a66",
      "keyword": "#dfabee",
      "function": "#61afef",
      "type": "#e5c07b",
      "property": "#e06c75",
      "punctuation": "#cfd4dc",
      "inserted": "#9fca7f",
      "deleted": "#f3aab0"
    }
  },
  {
    "id": "dracula",
    "label": "Dracula",
    "dark": true,
    "tokens": {
      "--color-void": "#191a24",
      "--color-sunken": "#20222c",
      "--color-surface": "#282a36",
      "--color-raised": "#2f3240",
      "--color-overlay": "#383b4b",
      "--color-hover": "#44475a",
      "--color-line": "#3a3d4d",
      "--color-line-soft": "#2e3140",
      "--color-line-strong": "#535776",
      "--color-ink": "#fafaf4",
      "--color-ink-mid": "#dee0ea",
      "--color-ink-dim": "#cccfdb",
      "--color-ink-faint": "#bbbfca",
      "--color-signal": "#53fc7d",
      "--color-signal-dim": "#3fa35e",
      "--color-signal-wash": "#173222",
      "--color-copper": "#ffba6e",
      "--color-copper-dim": "#a57c55",
      "--color-copper-wash": "#332818",
      "--color-rose": "#ffa7a6",
      "--color-rose-dim": "#a54348",
      "--color-rose-wash": "#331b1d",
      "--color-iris": "#d1b0ff",
      "--color-iris-dim": "#7e67a7",
      "--color-iris-wash": "#2a2140",
      "--color-think-cool": "#8debff",
      "--color-think-warm": "#ff99d5",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#282a36",
      "foreground": "#fafaf4",
      "cursor": "#53fc7d",
      "cursorAccent": "#282a36",
      "selectionBackground": "#d1b0ff59",
      "selectionInactiveBackground": "#d1b0ff2e",
      "black": "#20222c",
      "red": "#ffa7a6",
      "green": "#53fc7d",
      "yellow": "#f1fa8c",
      "blue": "#bd93f9",
      "magenta": "#ff79c6",
      "cyan": "#8be9fd",
      "white": "#dee0ea",
      "brightBlack": "#bbbfca",
      "brightRed": "#fec0bd",
      "brightGreen": "#85fba1",
      "brightYellow": "#f4faab",
      "brightBlue": "#cfb2f8",
      "brightMagenta": "#fea0d4",
      "brightCyan": "#aceefa",
      "brightWhite": "#fafaf4"
    },
    "code": {
      "foreground": "#fafaf4",
      "comment": "#6272a4",
      "string": "#f1fa8c",
      "constant": "#bd93f9",
      "keyword": "#ff79c6",
      "function": "#50fa7b",
      "type": "#8be9fd",
      "property": "#ffb86c",
      "punctuation": "#dee0ea",
      "inserted": "#53fc7d",
      "deleted": "#ffa7a6"
    }
  },
  {
    "id": "nord",
    "label": "Nord",
    "dark": true,
    "tokens": {
      "--color-void": "#232831",
      "--color-sunken": "#292e39",
      "--color-surface": "#2e3440",
      "--color-raised": "#353c4a",
      "--color-overlay": "#3b4252",
      "--color-hover": "#434c5e",
      "--color-line": "#3b4252",
      "--color-line-soft": "#333a47",
      "--color-line-strong": "#4c566a",
      "--color-ink": "#eef1f6",
      "--color-ink-mid": "#d7dde7",
      "--color-ink-dim": "#c9d1df",
      "--color-ink-faint": "#bec5d2",
      "--color-signal": "#b4cca0",
      "--color-signal-dim": "#72846c",
      "--color-signal-wash": "#28321f",
      "--color-copper": "#e9baac",
      "--color-copper-dim": "#8c645c",
      "--color-copper-wash": "#32241c",
      "--color-rose": "#e7b9be",
      "--color-rose-dim": "#824e58",
      "--color-rose-wash": "#301c20",
      "--color-iris": "#d6bed2",
      "--color-iris-dim": "#7c687f",
      "--color-iris-wash": "#2d2331",
      "--color-think-cool": "#95c8d7",
      "--color-think-warm": "#e2b1d3",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#2e3440",
      "foreground": "#eef1f6",
      "cursor": "#b4cca0",
      "cursorAccent": "#2e3440",
      "selectionBackground": "#d6bed259",
      "selectionInactiveBackground": "#d6bed22e",
      "black": "#292e39",
      "red": "#e7b9be",
      "green": "#b4cca0",
      "yellow": "#ebcb8b",
      "blue": "#81a1c1",
      "magenta": "#d6bed2",
      "cyan": "#88c0d0",
      "white": "#d7dde7",
      "brightBlack": "#bec5d2",
      "brightRed": "#cc8c93",
      "brightGreen": "#c5d7ba",
      "brightYellow": "#ebd6aa",
      "brightBlue": "#a2b9d1",
      "brightMagenta": "#ddcddd",
      "brightCyan": "#a7cfdb",
      "brightWhite": "#eef1f6"
    },
    "code": {
      "foreground": "#eef1f6",
      "comment": "#7b88a1",
      "string": "#a3be8c",
      "constant": "#b48ead",
      "keyword": "#81a1c1",
      "function": "#88c0d0",
      "type": "#8fbcbb",
      "property": "#d8dee9",
      "punctuation": "#d7dde7",
      "inserted": "#b4cca0",
      "deleted": "#e7b9be"
    }
  },
  {
    "id": "gruvbox-dark",
    "label": "Gruvbox Dark",
    "dark": true,
    "tokens": {
      "--color-void": "#1d2021",
      "--color-sunken": "#232526",
      "--color-surface": "#282828",
      "--color-raised": "#32302f",
      "--color-overlay": "#3c3836",
      "--color-hover": "#504945",
      "--color-line": "#3c3836",
      "--color-line-soft": "#302e2d",
      "--color-line-strong": "#5a524c",
      "--color-ink": "#f4e7be",
      "--color-ink-mid": "#e6d8b0",
      "--color-ink-dim": "#dbcdab",
      "--color-ink-faint": "#cec2a5",
      "--color-signal": "#c6c92f",
      "--color-signal-dim": "#7c7d27",
      "--color-signal-wash": "#2a2c10",
      "--color-copper": "#ffb169",
      "--color-copper-dim": "#a45b1f",
      "--color-copper-wash": "#332312",
      "--color-rose": "#ffada2",
      "--color-rose-dim": "#a23b2f",
      "--color-rose-wash": "#331a15",
      "--color-iris": "#e8b5c3",
      "--color-iris-dim": "#8b5f6b",
      "--color-iris-wash": "#2f2126",
      "--color-think-cool": "#abc3ba",
      "--color-think-warm": "#eeabc4",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#282828",
      "foreground": "#f4e7be",
      "cursor": "#c6c92f",
      "cursorAccent": "#282828",
      "selectionBackground": "#e8b5c359",
      "selectionInactiveBackground": "#e8b5c32e",
      "black": "#232526",
      "red": "#ffada2",
      "green": "#c6c92f",
      "yellow": "#fabd2f",
      "blue": "#83a598",
      "magenta": "#e8b5c3",
      "cyan": "#8ec07c",
      "white": "#e6d8b0",
      "brightBlack": "#cec2a5",
      "brightRed": "#fcbeaa",
      "brightGreen": "#d4d25a",
      "brightYellow": "#f8ca5a",
      "brightBlue": "#a5b9a3",
      "brightMagenta": "#dca2a5",
      "brightCyan": "#adcc90",
      "brightWhite": "#f4e7be"
    },
    "code": {
      "foreground": "#f4e7be",
      "comment": "#9d8f7c",
      "string": "#b8bb26",
      "constant": "#d3869b",
      "keyword": "#fb4934",
      "function": "#fabd2f",
      "type": "#8ec07c",
      "property": "#83a598",
      "punctuation": "#e6d8b0",
      "inserted": "#c6c92f",
      "deleted": "#ffada2"
    }
  },
  {
    "id": "tokyo-night",
    "label": "Tokyo Night",
    "dark": true,
    "tokens": {
      "--color-void": "#121218",
      "--color-sunken": "#16161e",
      "--color-surface": "#1a1b26",
      "--color-raised": "#20212e",
      "--color-overlay": "#282a3a",
      "--color-hover": "#33364a",
      "--color-line": "#292b3d",
      "--color-line-soft": "#20222f",
      "--color-line-strong": "#3d405c",
      "--color-ink": "#cad5f7",
      "--color-ink-mid": "#b4bfe7",
      "--color-ink-dim": "#a9b2dc",
      "--color-ink-faint": "#9ea7c9",
      "--color-signal": "#a0d06c",
      "--color-signal-dim": "#67834d",
      "--color-signal-wash": "#20291a",
      "--color-copper": "#ffa066",
      "--color-copper-dim": "#9f674a",
      "--color-copper-wash": "#302216",
      "--color-rose": "#ff8197",
      "--color-rose-dim": "#9a5062",
      "--color-rose-wash": "#2e1a24",
      "--color-iris": "#bd9cf9",
      "--color-iris-dim": "#77659f",
      "--color-iris-wash": "#262038",
      "--color-think-cool": "#7fd1ff",
      "--color-think-warm": "#f78bc8",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#1a1b26",
      "foreground": "#cad5f7",
      "cursor": "#a0d06c",
      "cursorAccent": "#1a1b26",
      "selectionBackground": "#bd9cf959",
      "selectionInactiveBackground": "#bd9cf92e",
      "black": "#16161e",
      "red": "#ff8197",
      "green": "#a0d06c",
      "yellow": "#e0af68",
      "blue": "#7aa2f7",
      "magenta": "#bd9cf9",
      "cyan": "#7dcfff",
      "white": "#b4bfe7",
      "brightBlack": "#9ea7c9",
      "brightRed": "#ef9ab4",
      "brightGreen": "#add296",
      "brightYellow": "#d9ba93",
      "brightBlue": "#92b1f7",
      "brightMagenta": "#c1adf8",
      "brightCyan": "#94d1fd",
      "brightWhite": "#cad5f7"
    },
    "code": {
      "foreground": "#cad5f7",
      "comment": "#6a739e",
      "string": "#9ece6a",
      "constant": "#ff9e64",
      "keyword": "#bd9cf9",
      "function": "#7aa2f7",
      "type": "#2ac3de",
      "property": "#7dcfff",
      "punctuation": "#b4bfe7",
      "inserted": "#a0d06c",
      "deleted": "#ff8197"
    }
  },
  {
    "id": "catppuccin-mocha",
    "label": "Catppuccin Mocha",
    "dark": true,
    "tokens": {
      "--color-void": "#11111b",
      "--color-sunken": "#181825",
      "--color-surface": "#1e1e2e",
      "--color-raised": "#262637",
      "--color-overlay": "#313244",
      "--color-hover": "#3b3c52",
      "--color-line": "#313244",
      "--color-line-soft": "#27273a",
      "--color-line-strong": "#45475a",
      "--color-ink": "#cfd8f6",
      "--color-ink-mid": "#bdc6e6",
      "--color-ink-dim": "#b3bbdb",
      "--color-ink-faint": "#a9b0ce",
      "--color-signal": "#a8e5a3",
      "--color-signal-dim": "#6d9071",
      "--color-signal-wash": "#1e2f22",
      "--color-copper": "#fcb589",
      "--color-copper-dim": "#9e7462",
      "--color-copper-wash": "#31251c",
      "--color-rose": "#f991ae",
      "--color-rose-dim": "#9a5d75",
      "--color-rose-wash": "#2f1d2a",
      "--color-iris": "#cda8f9",
      "--color-iris-dim": "#826da3",
      "--color-iris-wash": "#292140",
      "--color-think-cool": "#8bdeed",
      "--color-think-warm": "#f7c4e9",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#1e1e2e",
      "foreground": "#cfd8f6",
      "cursor": "#a8e5a3",
      "cursorAccent": "#1e1e2e",
      "selectionBackground": "#cda8f959",
      "selectionInactiveBackground": "#cda8f92e",
      "black": "#181825",
      "red": "#f991ae",
      "green": "#a8e5a3",
      "yellow": "#f9e2af",
      "blue": "#89b4fa",
      "magenta": "#cda8f9",
      "cyan": "#94e2d5",
      "white": "#bdc6e6",
      "brightBlack": "#a9b0ce",
      "brightRed": "#eca6c4",
      "brightGreen": "#b4e1bc",
      "brightYellow": "#ecdfc4",
      "brightBlue": "#9ebff9",
      "brightMagenta": "#ceb6f8",
      "brightCyan": "#a6dfdf",
      "brightWhite": "#cfd8f6"
    },
    "code": {
      "foreground": "#cfd8f6",
      "comment": "#7f849c",
      "string": "#a6e3a1",
      "constant": "#fab387",
      "keyword": "#cda8f9",
      "function": "#89b4fa",
      "type": "#f9e2af",
      "property": "#89dceb",
      "punctuation": "#bdc6e6",
      "inserted": "#a8e5a3",
      "deleted": "#f991ae"
    }
  },
  {
    "id": "light",
    "label": "Light",
    "dark": false,
    "tokens": {
      "--color-void": "#e8ecf0",
      "--color-sunken": "#f1f4f7",
      "--color-surface": "#fafbfc",
      "--color-raised": "#ffffff",
      "--color-overlay": "#ffffff",
      "--color-hover": "#e6ebf0",
      "--color-line": "#d8dee5",
      "--color-line-soft": "#e7ecf1",
      "--color-line-strong": "#b9c2cc",
      "--color-ink": "#101419",
      "--color-ink-mid": "#283745",
      "--color-ink-dim": "#3d4b59",
      "--color-ink-faint": "#57606a",
      "--color-signal": "#09704c",
      "--color-signal-dim": "#14a06d",
      "--color-signal-wash": "#d7f0e4",
      "--color-copper": "#9a5006",
      "--color-copper-dim": "#c97a2a",
      "--color-copper-wash": "#f8e8d5",
      "--color-rose": "#b11a38",
      "--color-rose-dim": "#d24a63",
      "--color-rose-wash": "#fbe5ea",
      "--color-iris": "#4732b6",
      "--color-iris-dim": "#6f5ad0",
      "--color-iris-wash": "#eae5fb",
      "--color-think-cool": "#056888",
      "--color-think-warm": "#a1156b",
      "--color-edge-hi": "rgb(255 255 255 / 0.9)",
      "--color-edge-lo": "rgb(15 23 32 / 0.10)"
    },
    "term": {
      "background": "#fafbfc",
      "foreground": "#101419",
      "cursor": "#09704c",
      "cursorAccent": "#fafbfc",
      "selectionBackground": "#4732b659",
      "selectionInactiveBackground": "#4732b62e",
      "black": "#101419",
      "red": "#b11a38",
      "green": "#09704c",
      "yellow": "#9a5006",
      "blue": "#1c5fb0",
      "magenta": "#4732b6",
      "cyan": "#0b7078",
      "white": "#283745",
      "brightBlack": "#3d4b59",
      "brightRed": "#7e1b30",
      "brightGreen": "#105b42",
      "brightYellow": "#734111",
      "brightBlue": "#19477f",
      "brightMagenta": "#382a84",
      "brightCyan": "#0d5259",
      "brightWhite": "#101419"
    },
    "code": {
      "foreground": "#101419",
      "comment": "#6a7885",
      "string": "#984b1a",
      "constant": "#a11a6b",
      "keyword": "#4732b6",
      "function": "#1c5fb0",
      "type": "#0b7078",
      "property": "#2a5a8a",
      "punctuation": "#283745",
      "inserted": "#09704c",
      "deleted": "#b11a38"
    }
  },
  {
    "id": "solarized-light",
    "label": "Solarized Light",
    "dark": false,
    "tokens": {
      "--color-void": "#e6e0cd",
      "--color-sunken": "#eee8d5",
      "--color-surface": "#f7f1de",
      "--color-raised": "#fdf6e3",
      "--color-overlay": "#fffaec",
      "--color-hover": "#e9e2cf",
      "--color-line": "#ded8c4",
      "--color-line-soft": "#eee8d5",
      "--color-line-strong": "#bfb99f",
      "--color-ink": "#053440",
      "--color-ink-mid": "#244751",
      "--color-ink-dim": "#34545e",
      "--color-ink-faint": "#436268",
      "--color-signal": "#116863",
      "--color-signal-dim": "#2aa198",
      "--color-signal-wash": "#cce8e2",
      "--color-copper": "#9b4209",
      "--color-copper-dim": "#cb4b16",
      "--color-copper-wash": "#f5decc",
      "--color-rose": "#ae2422",
      "--color-rose-dim": "#dc322f",
      "--color-rose-wash": "#f7dcd9",
      "--color-iris": "#4d51a1",
      "--color-iris-dim": "#6c71c4",
      "--color-iris-wash": "#e0e1f2",
      "--color-think-cool": "#156881",
      "--color-think-warm": "#a12166",
      "--color-edge-hi": "rgb(255 255 255 / 0.9)",
      "--color-edge-lo": "rgb(15 23 32 / 0.10)"
    },
    "term": {
      "background": "#f7f1de",
      "foreground": "#053440",
      "cursor": "#116863",
      "cursorAccent": "#f7f1de",
      "selectionBackground": "#4d51a159",
      "selectionInactiveBackground": "#4d51a12e",
      "black": "#053440",
      "red": "#ae2422",
      "green": "#116863",
      "yellow": "#9b4209",
      "blue": "#1c6fa8",
      "magenta": "#4d51a1",
      "cyan": "#1a7d76",
      "white": "#244751",
      "brightBlack": "#34545e",
      "brightRed": "#782c2e",
      "brightGreen": "#146665",
      "brightYellow": "#704220",
      "brightBlue": "#155c86",
      "brightMagenta": "#374983",
      "brightCyan": "#146665",
      "brightWhite": "#053440"
    },
    "code": {
      "foreground": "#053440",
      "comment": "#7c8d8d",
      "string": "#8a6800",
      "constant": "#a32468",
      "keyword": "#4d51a1",
      "function": "#1c6fa8",
      "type": "#1a7d76",
      "property": "#586e75",
      "punctuation": "#244751",
      "inserted": "#5f7000",
      "deleted": "#ae2422"
    }
  }
];

const THEME_SOURCES: readonly ThemeSource[] = themeSourcesJson;

describe("theme derivation", () => {
  const source: ThemeSource = { ...THEME_SOURCES[0], overrides: undefined };

  it("preserves every fully-derived migration value byte-for-byte", () => {
    // String equality protects values, object key order, theme order, and ids.
    expect(JSON.stringify(THEMES)).toBe(JSON.stringify(LEGACY_THEMES));
  });

  it("keeps source ids aligned with runtime ids and token keys in canonical order", () => {
    const sourceIds = THEME_SOURCES.map(({ id }) => id);
    expect(THEMES.map(({ id }) => id)).toEqual(sourceIds);
    expect(new Set(sourceIds).size).toBe(sourceIds.length);

    for (const item of THEME_SOURCES) {
      expect(Object.keys(item.tokens)).toEqual(THEME_TOKEN_NAMES);
    }
  });

  it("contains valid source and derived colours", () => {
    const opaqueHex = /^#[0-9a-f]{6}$/;
    const terminalHex = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/;
    const cssRgb = /^rgb\(\d+ \d+ \d+ \/ (?:0|1|0?\.\d+)\)$/;

    for (const item of THEME_SOURCES) {
      for (const [key, value] of Object.entries(item.tokens)) {
        expect(`${item.id} ${key} ${value}`).toSatisfy(() =>
          key === "--color-edge-hi" || key === "--color-edge-lo"
            ? cssRgb.test(value)
            : opaqueHex.test(value),
        );
      }
      for (const [key, value] of Object.entries(item.syntax)) {
        expect(`${item.id} syntax.${key} ${value}`).toSatisfy(() => opaqueHex.test(value));
      }
      for (const [key, value] of Object.entries(item.overrides?.term ?? {})) {
        expect(`${item.id} term.${key} ${value}`).toSatisfy(() => terminalHex.test(value));
      }
      for (const [key, value] of Object.entries(item.overrides?.code ?? {})) {
        expect(`${item.id} code.${key} ${value}`).toSatisfy(() => opaqueHex.test(value));
      }

      const theme = deriveTheme(item);
      for (const [key, value] of Object.entries(theme.term)) {
        expect(`${item.id} term.${key} ${value}`).toSatisfy(() => terminalHex.test(value));
      }
      for (const [key, value] of Object.entries(theme.code)) {
        expect(`${item.id} code.${key} ${value}`).toSatisfy(() => opaqueHex.test(value));
      }
    }
  });

  it("mixes opaque hex channels against ink with the documented rounding", () => {
    expect(mixHex("#336699", "#ffffff")).toBe("#7094b8");
    expect(mixHex("#336699", "#ffffff", 1)).toBe("#336699");
    expect(mixHex("#336699", "#ffffff", 0)).toBe("#ffffff");
    expect(() => mixHex("#369", "#ffffff")).toThrow("Expected #rrggbb");
    expect(() => mixHex("#336699", "#ffffff", 1.01)).toThrow("between 0 and 1");
  });

  it("maps semantic tokens and syntax seeds onto every terminal slot", () => {
    const token = source.tokens;
    const syntax = source.syntax;
    const ink = token["--color-ink"];

    expect(deriveTerminal(source)).toEqual({
      background: token["--color-surface"],
      foreground: ink,
      cursor: token["--color-signal"],
      cursorAccent: token["--color-surface"],
      selectionBackground: `${token["--color-iris"]}59`,
      selectionInactiveBackground: `${token["--color-iris"]}2e`,
      black: token["--color-sunken"],
      red: token["--color-rose"],
      green: token["--color-signal"],
      yellow: token["--color-copper"],
      blue: syntax.function,
      magenta: token["--color-iris"],
      cyan: syntax.type,
      white: token["--color-ink-mid"],
      brightBlack: token["--color-ink-faint"],
      brightRed: mixHex(token["--color-rose"], ink),
      brightGreen: mixHex(token["--color-signal"], ink),
      brightYellow: mixHex(token["--color-copper"], ink),
      brightBlue: mixHex(syntax.function, ink),
      brightMagenta: mixHex(token["--color-iris"], ink),
      brightCyan: mixHex(syntax.type, ink),
      brightWhite: ink,
    });

    const light = deriveTerminal({ ...source, dark: false });
    expect(light.black).toBe(ink);
    expect(light.brightBlack).toBe(token["--color-ink-dim"]);
  });

  it("maps semantic tokens and syntax seeds onto every code role", () => {
    const token = source.tokens;
    const syntax = source.syntax;
    expect(deriveCode(source)).toEqual({
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
    });
  });

  it("projects semantic changes through consumers unless a final override wins", () => {
    const changed: ThemeSource = {
      ...source,
      tokens: {
        ...source.tokens,
        "--color-surface": "#010203",
        "--color-signal": "#123456",
        "--color-rose": "#654321",
        "--color-iris": "#abcdef",
      },
    };
    const projected = deriveTheme(changed);
    expect(projected.term.background).toBe("#010203");
    expect(projected.term.cursor).toBe("#123456");
    expect(projected.term.green).toBe("#123456");
    expect(projected.term.red).toBe("#654321");
    expect(projected.term.magenta).toBe("#abcdef");
    expect(projected.code.inserted).toBe("#123456");
    expect(projected.code.deleted).toBe("#654321");
    expect(projected.code.keyword).toBe("#abcdef");

    const overridden: ThemeSource = {
      ...changed,
      overrides: {
        term: { background: "#111111", red: "#222222", brightRed: "#333333" },
        code: { deleted: "#444444" },
      },
    };
    const theme = deriveTheme(overridden);
    expect(theme.term.background).toBe("#111111");
    expect(theme.term.red).toBe("#222222");
    expect(theme.term.brightRed).toBe("#333333");
    expect(theme.code.deleted).toBe("#444444");

    const inheritedBright = deriveTerminal({
      ...changed,
      overrides: { term: { red: "#222222" } },
    });
    expect(inheritedBright.brightRed).toBe(mixHex("#222222", changed.tokens["--color-ink"]));
  });

  it("stores only overrides that change their projected slot", () => {
    for (const item of THEME_SOURCES) {
      for (const section of ["term", "code"] as const) {
        const overrides = item.overrides?.[section] ?? {};
        for (const [slot, value] of Object.entries(overrides)) {
          const withoutSlot = Object.fromEntries(
            Object.entries(overrides).filter(([key]) => key !== slot),
          );
          const changed: ThemeSource = {
            ...item,
            overrides: { ...item.overrides, [section]: withoutSlot },
          };
          const projected = section === "term" ? deriveTerminal(changed) : deriveCode(changed);
          const projectedValue = Object.entries(projected).find(([key]) => key === slot)?.[1];
          expect(`${item.id} ${section}.${slot}`).toSatisfy(() => projectedValue !== value);
        }
      }
    }
  });
});

describe("theme contrast", () => {
  // The gate lives in @omp-ui/core/theme so an imported theme (issue #999)
  // meets exactly the floors every curated theme meets here. A failure names
  // the pairing and its ratio, not just a boolean.
  for (const theme of THEMES) {
    it(`${theme.id} passes the contrast gate`, () => {
      expect(themeContrastFailures(theme)).toEqual([]);
    });
  }

  it("gives every theme the same token key set", () => {
    // `applyTheme` only writes the keys a theme holds, so a missing key would
    // silently leave the *previous* theme's value applied after a switch.
    const expected = Object.keys(THEMES[0]!.tokens).sort();
    for (const theme of THEMES) {
      expect(`${theme.id}: ${Object.keys(theme.tokens).sort().join(",")}`).toBe(
        `${theme.id}: ${expected.join(",")}`,
      );
    }
  });

  it("gives every theme a unique id", () => {
    // The id is the persisted key and shiki's theme name; a collision would
    // make one theme unreachable.
    const ids = THEMES.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
