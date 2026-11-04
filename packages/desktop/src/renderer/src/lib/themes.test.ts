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
      "--color-ink": "#e8ecf1",
      "--color-ink-mid": "#adb6c3",
      "--color-ink-dim": "#9aa3ae",
      "--color-ink-faint": "#9299a3",
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
      "--color-think-cool": "#6fc3e8",
      "--color-think-warm": "#ef86c4",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#14171b",
      "foreground": "#e8ecf1",
      "cursor": "#4ade9f",
      "cursorAccent": "#14171b",
      "selectionBackground": "#9d8cf559",
      "selectionInactiveBackground": "#9d8cf52e",
      "black": "#0e1013",
      "red": "#f2748c",
      "green": "#4ade9f",
      "yellow": "#f0a868",
      "blue": "#7fa9f0",
      "magenta": "#9d8cf5",
      "cyan": "#66d9d2",
      "white": "#adb6c3",
      "brightBlack": "#9299a3",
      "brightRed": "#ef9cad",
      "brightGreen": "#7ee3ba",
      "brightYellow": "#edbe95",
      "brightBlue": "#a2bff0",
      "brightMagenta": "#b6acf4",
      "brightCyan": "#91dfdc",
      "brightWhite": "#e8ecf1"
    },
    "code": {
      "foreground": "#e8ecf1",
      "comment": "#5f6b7c",
      "string": "#e0b184",
      "constant": "#e39db5",
      "keyword": "#9d8cf5",
      "function": "#7fb8e8",
      "type": "#6fc7d4",
      "property": "#a8c5e8",
      "punctuation": "#adb6c3",
      "inserted": "#8fd4b8",
      "deleted": "#f2748c"
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
      "--color-ink": "#e7e7e7",
      "--color-ink-mid": "#c1c1c1",
      "--color-ink-dim": "#acacac",
      "--color-ink-faint": "#a2a2a2",
      "--color-signal": "#4ec9a2",
      "--color-signal-dim": "#2f8468",
      "--color-signal-wash": "#12271f",
      "--color-copper": "#dcb67a",
      "--color-copper-dim": "#957a4d",
      "--color-copper-wash": "#2a2114",
      "--color-rose": "#f58080",
      "--color-rose-dim": "#a13636",
      "--color-rose-wash": "#2c1616",
      "--color-iris": "#59a5ff",
      "--color-iris-dim": "#2e64a6",
      "--color-iris-wash": "#132233",
      "--color-think-cool": "#4fc1ff",
      "--color-think-warm": "#e586c8",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#1f1f1f",
      "foreground": "#e7e7e7",
      "cursor": "#4ec9a2",
      "cursorAccent": "#1f1f1f",
      "selectionBackground": "#59a5ff59",
      "selectionInactiveBackground": "#59a5ff2e",
      "black": "#181818",
      "red": "#f58080",
      "green": "#4ec9a2",
      "yellow": "#dcb67a",
      "blue": "#569cd6",
      "magenta": "#c586c0",
      "cyan": "#4ec9b0",
      "white": "#c1c1c1",
      "brightBlack": "#a2a2a2",
      "brightRed": "#ee7f7f",
      "brightGreen": "#80d3b9",
      "brightYellow": "#e0c69e",
      "brightBlue": "#86b5dc",
      "brightMagenta": "#b5aaed",
      "brightCyan": "#80d3c2",
      "brightWhite": "#e7e7e7"
    },
    "code": {
      "foreground": "#e7e7e7",
      "comment": "#6a9955",
      "string": "#ce9178",
      "constant": "#b5cea8",
      "keyword": "#59a5ff",
      "function": "#dcdcaa",
      "type": "#4ec9b0",
      "property": "#9cdcfe",
      "punctuation": "#c1c1c1",
      "inserted": "#7cd6a7",
      "deleted": "#f58080"
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
      "--color-ink": "#f8f8f2",
      "--color-ink-mid": "#dadad1",
      "--color-ink-dim": "#c4c4ba",
      "--color-ink-faint": "#bab8ab",
      "--color-signal": "#a6e22e",
      "--color-signal-dim": "#6f9720",
      "--color-signal-wash": "#222a12",
      "--color-copper": "#fda43b",
      "--color-copper-dim": "#ac6715",
      "--color-copper-wash": "#2e2011",
      "--color-rose": "#fc9bbe",
      "--color-rose-dim": "#a81b4e",
      "--color-rose-wash": "#2c1220",
      "--color-iris": "#c8a9ff",
      "--color-iris-dim": "#7455ab",
      "--color-iris-wash": "#241d33",
      "--color-think-cool": "#66d9ef",
      "--color-think-warm": "#f79ccf",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#272822",
      "foreground": "#f8f8f2",
      "cursor": "#a6e22e",
      "cursorAccent": "#272822",
      "selectionBackground": "#c8a9ff59",
      "selectionInactiveBackground": "#c8a9ff2e",
      "black": "#22231e",
      "red": "#fc9bbe",
      "green": "#a6e22e",
      "yellow": "#fda43b",
      "blue": "#66d9ef",
      "magenta": "#c8a9ff",
      "cyan": "#66d9ef",
      "white": "#dadad1",
      "brightBlack": "#bab8ab",
      "brightRed": "#f96b9c",
      "brightGreen": "#c1e96f",
      "brightYellow": "#fbb765",
      "brightBlue": "#96e3f0",
      "brightMagenta": "#c6a8fb",
      "brightCyan": "#96e3f0",
      "brightWhite": "#f8f8f2"
    },
    "code": {
      "foreground": "#f8f8f2",
      "comment": "#75715e",
      "string": "#e6db74",
      "constant": "#ae81ff",
      "keyword": "#c8a9ff",
      "function": "#a6e22e",
      "type": "#66d9ef",
      "property": "#fd971f",
      "punctuation": "#dadad1",
      "inserted": "#a6e22e",
      "deleted": "#fc9bbe"
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
      "--color-ink": "#eee8d5",
      "--color-ink-mid": "#cbcdc1",
      "--color-ink-dim": "#b1b8b1",
      "--color-ink-faint": "#a6aea8",
      "--color-signal": "#32bfb4",
      "--color-signal-dim": "#1c6b65",
      "--color-signal-wash": "#032b2e",
      "--color-copper": "#ef9570",
      "--color-copper-dim": "#8a330f",
      "--color-copper-wash": "#2a1a10",
      "--color-rose": "#ed9492",
      "--color-rose-dim": "#94211f",
      "--color-rose-wash": "#2b1315",
      "--color-iris": "#a5a8db",
      "--color-iris-dim": "#484c85",
      "--color-iris-wash": "#151d33",
      "--color-think-cool": "#32bfb4",
      "--color-think-warm": "#ec8ebe",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#002b36",
      "foreground": "#eee8d5",
      "cursor": "#32bfb4",
      "cursorAccent": "#002b36",
      "selectionBackground": "#a5a8db59",
      "selectionInactiveBackground": "#a5a8db2e",
      "black": "#002028",
      "red": "#ed9492",
      "green": "#32bfb4",
      "yellow": "#ef9570",
      "blue": "#268bd2",
      "magenta": "#a5a8db",
      "cyan": "#2aa198",
      "white": "#cbcdc1",
      "brightBlack": "#a6aea8",
      "brightRed": "#e26e66",
      "brightGreen": "#6bb8ac",
      "brightYellow": "#d77f55",
      "brightBlue": "#68aad3",
      "brightMagenta": "#9798ca",
      "brightCyan": "#6bb8ac",
      "brightWhite": "#eee8d5"
    },
    "code": {
      "foreground": "#eee8d5",
      "comment": "#5d757c",
      "string": "#b58900",
      "constant": "#d33682",
      "keyword": "#a5a8db",
      "function": "#268bd2",
      "type": "#2aa198",
      "property": "#93a1a1",
      "punctuation": "#cbcdc1",
      "inserted": "#859900",
      "deleted": "#ed9492"
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
      "--color-ink": "#dfe3ea",
      "--color-ink-mid": "#d3d8e0",
      "--color-ink-dim": "#bcc2cc",
      "--color-ink-faint": "#b1b7c0",
      "--color-signal": "#98c379",
      "--color-signal-dim": "#69845c",
      "--color-signal-wash": "#1e2a1c",
      "--color-copper": "#daae85",
      "--color-copper-dim": "#8a6c51",
      "--color-copper-wash": "#2b2317",
      "--color-rose": "#eca4aa",
      "--color-rose-dim": "#93515a",
      "--color-rose-wash": "#2e1d20",
      "--color-iris": "#d9a5e8",
      "--color-iris-dim": "#845896",
      "--color-iris-wash": "#2a1e31",
      "--color-think-cool": "#73c3cd",
      "--color-think-warm": "#ec9ed1",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#282c34",
      "foreground": "#dfe3ea",
      "cursor": "#98c379",
      "cursorAccent": "#282c34",
      "selectionBackground": "#d9a5e859",
      "selectionInactiveBackground": "#d9a5e82e",
      "black": "#21252e",
      "red": "#eca4aa",
      "green": "#98c379",
      "yellow": "#daae85",
      "blue": "#61afef",
      "magenta": "#d9a5e8",
      "cyan": "#56b6c2",
      "white": "#d3d8e0",
      "brightBlack": "#b1b7c0",
      "brightRed": "#e8b7bd",
      "brightGreen": "#adcd9b",
      "brightYellow": "#dcbea3",
      "brightBlue": "#87bfee",
      "brightMagenta": "#dbb8e9",
      "brightCyan": "#7fc4ce",
      "brightWhite": "#dfe3ea"
    },
    "code": {
      "foreground": "#dfe3ea",
      "comment": "#7f848e",
      "string": "#98c379",
      "constant": "#d19a66",
      "keyword": "#d9a5e8",
      "function": "#61afef",
      "type": "#e5c07b",
      "property": "#e06c75",
      "punctuation": "#d3d8e0",
      "inserted": "#98c379",
      "deleted": "#eca4aa"
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
      "--color-ink": "#f8f8f2",
      "--color-ink-mid": "#d7d9e3",
      "--color-ink-dim": "#c0c3cf",
      "--color-ink-faint": "#b4b8c3",
      "--color-signal": "#50fa7b",
      "--color-signal-dim": "#3fa35e",
      "--color-signal-wash": "#173222",
      "--color-copper": "#ffb86c",
      "--color-copper-dim": "#a57c55",
      "--color-copper-wash": "#332818",
      "--color-rose": "#ff9d9d",
      "--color-rose-dim": "#a54348",
      "--color-rose-wash": "#331b1d",
      "--color-iris": "#cbaafa",
      "--color-iris-dim": "#7e67a7",
      "--color-iris-wash": "#2a2140",
      "--color-think-cool": "#8be9fd",
      "--color-think-warm": "#ff97d3",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#282a36",
      "foreground": "#f8f8f2",
      "cursor": "#50fa7b",
      "cursorAccent": "#282a36",
      "selectionBackground": "#cbaafa59",
      "selectionInactiveBackground": "#cbaafa2e",
      "black": "#20222c",
      "red": "#ff9d9d",
      "green": "#50fa7b",
      "yellow": "#f1fa8c",
      "blue": "#bd93f9",
      "magenta": "#ff79c6",
      "cyan": "#8be9fd",
      "white": "#d7d9e3",
      "brightBlack": "#b4b8c3",
      "brightRed": "#fdb8b7",
      "brightGreen": "#82f99f",
      "brightYellow": "#f3f9ab",
      "brightBlue": "#cfb1f7",
      "brightMagenta": "#fd9fd3",
      "brightCyan": "#aceefa",
      "brightWhite": "#f8f8f2"
    },
    "code": {
      "foreground": "#f8f8f2",
      "comment": "#6272a4",
      "string": "#f1fa8c",
      "constant": "#bd93f9",
      "keyword": "#ff79c6",
      "function": "#50fa7b",
      "type": "#8be9fd",
      "property": "#ffb86c",
      "punctuation": "#d7d9e3",
      "inserted": "#50fa7b",
      "deleted": "#ff9d9d"
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
      "--color-ink": "#eceff4",
      "--color-ink-mid": "#dae0ea",
      "--color-ink-dim": "#c2cad8",
      "--color-ink-faint": "#b7becb",
      "--color-signal": "#adc599",
      "--color-signal-dim": "#72846c",
      "--color-signal-wash": "#28321f",
      "--color-copper": "#e2b4a6",
      "--color-copper-dim": "#8c645c",
      "--color-copper-wash": "#32241c",
      "--color-rose": "#e0b2b7",
      "--color-rose-dim": "#824e58",
      "--color-rose-wash": "#301c20",
      "--color-iris": "#cfb7cb",
      "--color-iris-dim": "#7c687f",
      "--color-iris-wash": "#2d2331",
      "--color-think-cool": "#93c6d5",
      "--color-think-warm": "#e0afd1",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#2e3440",
      "foreground": "#eceff4",
      "cursor": "#adc599",
      "cursorAccent": "#2e3440",
      "selectionBackground": "#cfb7cb59",
      "selectionInactiveBackground": "#cfb7cb2e",
      "black": "#292e39",
      "red": "#e0b2b7",
      "green": "#adc599",
      "yellow": "#ebcb8b",
      "blue": "#81a1c1",
      "magenta": "#cfb7cb",
      "cyan": "#88c0d0",
      "white": "#dae0ea",
      "brightBlack": "#b7becb",
      "brightRed": "#cc8c93",
      "brightGreen": "#c0d2b4",
      "brightYellow": "#ebd6aa",
      "brightBlue": "#a1b8d0",
      "brightMagenta": "#d8c8d7",
      "brightCyan": "#a6cedb",
      "brightWhite": "#eceff4"
    },
    "code": {
      "foreground": "#eceff4",
      "comment": "#7b88a1",
      "string": "#a3be8c",
      "constant": "#b48ead",
      "keyword": "#81a1c1",
      "function": "#88c0d0",
      "type": "#8fbcbb",
      "property": "#d8dee9",
      "punctuation": "#dae0ea",
      "inserted": "#adc599",
      "deleted": "#e0b2b7"
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
      "--color-ink": "#f2e5bc",
      "--color-ink-mid": "#ebddb5",
      "--color-ink-dim": "#d4c6a5",
      "--color-ink-faint": "#c7bb9e",
      "--color-signal": "#bfc227",
      "--color-signal-dim": "#7c7d27",
      "--color-signal-wash": "#2a2c10",
      "--color-copper": "#fea861",
      "--color-copper-dim": "#a45b1f",
      "--color-copper-wash": "#332312",
      "--color-rose": "#fda49a",
      "--color-rose-dim": "#a23b2f",
      "--color-rose-wash": "#331a15",
      "--color-iris": "#e1aebc",
      "--color-iris-dim": "#8b5f6b",
      "--color-iris-wash": "#2f2126",
      "--color-think-cool": "#a9c1b8",
      "--color-think-warm": "#eca9c2",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#282828",
      "foreground": "#f2e5bc",
      "cursor": "#bfc227",
      "cursorAccent": "#282828",
      "selectionBackground": "#e1aebc59",
      "selectionInactiveBackground": "#e1aebc2e",
      "black": "#232526",
      "red": "#fda49a",
      "green": "#bfc227",
      "yellow": "#fabd2f",
      "blue": "#83a598",
      "magenta": "#e1aebc",
      "cyan": "#8ec07c",
      "white": "#ebddb5",
      "brightBlack": "#c7bb9e",
      "brightRed": "#fab8a4",
      "brightGreen": "#cecd54",
      "brightYellow": "#f8c959",
      "brightBlue": "#a4b8a3",
      "brightMagenta": "#dca2a5",
      "brightCyan": "#accb8f",
      "brightWhite": "#f2e5bc"
    },
    "code": {
      "foreground": "#f2e5bc",
      "comment": "#9d8f7c",
      "string": "#b8bb26",
      "constant": "#d3869b",
      "keyword": "#fb4934",
      "function": "#fabd2f",
      "type": "#8ec07c",
      "property": "#83a598",
      "punctuation": "#ebddb5",
      "inserted": "#bfc227",
      "deleted": "#fda49a"
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
      "--color-ink": "#c8d3f5",
      "--color-ink-mid": "#b4bfe6",
      "--color-ink-dim": "#a1aad3",
      "--color-ink-faint": "#98a1c3",
      "--color-signal": "#9ece6a",
      "--color-signal-dim": "#67834d",
      "--color-signal-wash": "#20291a",
      "--color-copper": "#ff9e64",
      "--color-copper-dim": "#9f674a",
      "--color-copper-wash": "#302216",
      "--color-rose": "#f77a91",
      "--color-rose-dim": "#9a5062",
      "--color-rose-wash": "#2e1a24",
      "--color-iris": "#bb9af7",
      "--color-iris-dim": "#77659f",
      "--color-iris-wash": "#262038",
      "--color-think-cool": "#7dcfff",
      "--color-think-warm": "#f589c6",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#1a1b26",
      "foreground": "#c8d3f5",
      "cursor": "#9ece6a",
      "cursorAccent": "#1a1b26",
      "selectionBackground": "#bb9af759",
      "selectionInactiveBackground": "#bb9af72e",
      "black": "#16161e",
      "red": "#f77a91",
      "green": "#9ece6a",
      "yellow": "#e0af68",
      "blue": "#7aa2f7",
      "magenta": "#bb9af7",
      "cyan": "#7dcfff",
      "white": "#b4bfe6",
      "brightBlack": "#98a1c3",
      "brightRed": "#e995af",
      "brightGreen": "#abd094",
      "brightYellow": "#d9ba92",
      "brightBlue": "#91b1f6",
      "brightMagenta": "#bfabf6",
      "brightCyan": "#94d0fc",
      "brightWhite": "#c8d3f5"
    },
    "code": {
      "foreground": "#c8d3f5",
      "comment": "#6a739e",
      "string": "#9ece6a",
      "constant": "#ff9e64",
      "keyword": "#bb9af7",
      "function": "#7aa2f7",
      "type": "#2ac3de",
      "property": "#7dcfff",
      "punctuation": "#b4bfe6",
      "inserted": "#9ece6a",
      "deleted": "#f77a91"
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
      "--color-ink": "#cdd6f4",
      "--color-ink-mid": "#c0c9e9",
      "--color-ink-dim": "#acb4d4",
      "--color-ink-faint": "#a2a9c7",
      "--color-signal": "#a6e3a1",
      "--color-signal-dim": "#6d9071",
      "--color-signal-wash": "#1e2f22",
      "--color-copper": "#fab387",
      "--color-copper-dim": "#9e7462",
      "--color-copper-wash": "#31251c",
      "--color-rose": "#f38ba8",
      "--color-rose-dim": "#9a5d75",
      "--color-rose-wash": "#2f1d2a",
      "--color-iris": "#cba6f7",
      "--color-iris-dim": "#826da3",
      "--color-iris-wash": "#292140",
      "--color-think-cool": "#89dceb",
      "--color-think-warm": "#f5c2e7",
      "--color-edge-hi": "rgb(255 255 255 / 0.05)",
      "--color-edge-lo": "rgb(0 0 0 / 0.4)"
    },
    "term": {
      "background": "#1e1e2e",
      "foreground": "#cdd6f4",
      "cursor": "#a6e3a1",
      "cursorAccent": "#1e1e2e",
      "selectionBackground": "#cba6f759",
      "selectionInactiveBackground": "#cba6f72e",
      "black": "#181825",
      "red": "#f38ba8",
      "green": "#a6e3a1",
      "yellow": "#f9e2af",
      "blue": "#89b4fa",
      "magenta": "#cba6f7",
      "cyan": "#94e2d5",
      "white": "#c0c9e9",
      "brightBlack": "#a2a9c7",
      "brightRed": "#e8a2bf",
      "brightGreen": "#b2dfba",
      "brightYellow": "#ecdec4",
      "brightBlue": "#9dbef8",
      "brightMagenta": "#ccb4f6",
      "brightCyan": "#a5dede",
      "brightWhite": "#cdd6f4"
    },
    "code": {
      "foreground": "#cdd6f4",
      "comment": "#7f849c",
      "string": "#a6e3a1",
      "constant": "#fab387",
      "keyword": "#cba6f7",
      "function": "#89b4fa",
      "type": "#f9e2af",
      "property": "#89dceb",
      "punctuation": "#c0c9e9",
      "inserted": "#a6e3a1",
      "deleted": "#f38ba8"
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
      "--color-ink": "#12161b",
      "--color-ink-mid": "#41505f",
      "--color-ink-dim": "#546270",
      "--color-ink-faint": "#59626c",
      "--color-signal": "#0e724e",
      "--color-signal-dim": "#14a06d",
      "--color-signal-wash": "#d7f0e4",
      "--color-copper": "#9f540c",
      "--color-copper-dim": "#c97a2a",
      "--color-copper-wash": "#f8e8d5",
      "--color-rose": "#b31d3a",
      "--color-rose-dim": "#d24a63",
      "--color-rose-wash": "#fbe5ea",
      "--color-iris": "#4a34b8",
      "--color-iris-dim": "#6f5ad0",
      "--color-iris-wash": "#eae5fb",
      "--color-think-cool": "#0b6a8a",
      "--color-think-warm": "#a3196d",
      "--color-edge-hi": "rgb(255 255 255 / 0.9)",
      "--color-edge-lo": "rgb(15 23 32 / 0.10)"
    },
    "term": {
      "background": "#fafbfc",
      "foreground": "#12161b",
      "cursor": "#0e724e",
      "cursorAccent": "#fafbfc",
      "selectionBackground": "#4a34b859",
      "selectionInactiveBackground": "#4a34b82e",
      "black": "#12161b",
      "red": "#b31d3a",
      "green": "#0e724e",
      "yellow": "#9f540c",
      "blue": "#1c5fb0",
      "magenta": "#4a34b8",
      "cyan": "#0b7078",
      "white": "#41505f",
      "brightBlack": "#546270",
      "brightRed": "#7e1b30",
      "brightGreen": "#105b42",
      "brightYellow": "#734111",
      "brightBlue": "#19477f",
      "brightMagenta": "#382a84",
      "brightCyan": "#0d5259",
      "brightWhite": "#12161b"
    },
    "code": {
      "foreground": "#12161b",
      "comment": "#6a7885",
      "string": "#984b1a",
      "constant": "#a11a6b",
      "keyword": "#4a34b8",
      "function": "#1c5fb0",
      "type": "#0b7078",
      "property": "#2a5a8a",
      "punctuation": "#41505f",
      "inserted": "#0e724e",
      "deleted": "#b31d3a"
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
      "--color-ink": "#073642",
      "--color-ink-mid": "#2e515b",
      "--color-ink-dim": "#3f5f69",
      "--color-ink-faint": "#47676d",
      "--color-signal": "#176c66",
      "--color-signal-dim": "#2aa198",
      "--color-signal-wash": "#cce8e2",
      "--color-copper": "#a1470f",
      "--color-copper-dim": "#cb4b16",
      "--color-copper-wash": "#f5decc",
      "--color-rose": "#b02724",
      "--color-rose-dim": "#dc322f",
      "--color-rose-wash": "#f7dcd9",
      "--color-iris": "#4f53a3",
      "--color-iris-dim": "#6c71c4",
      "--color-iris-wash": "#e0e1f2",
      "--color-think-cool": "#196a83",
      "--color-think-warm": "#a32468",
      "--color-edge-hi": "rgb(255 255 255 / 0.9)",
      "--color-edge-lo": "rgb(15 23 32 / 0.10)"
    },
    "term": {
      "background": "#f7f1de",
      "foreground": "#073642",
      "cursor": "#176c66",
      "cursorAccent": "#f7f1de",
      "selectionBackground": "#4f53a359",
      "selectionInactiveBackground": "#4f53a32e",
      "black": "#073642",
      "red": "#b02724",
      "green": "#176c66",
      "yellow": "#a1470f",
      "blue": "#1c6fa8",
      "magenta": "#4f53a3",
      "cyan": "#1a7d76",
      "white": "#2e515b",
      "brightBlack": "#3f5f69",
      "brightRed": "#782c2e",
      "brightGreen": "#146665",
      "brightYellow": "#704220",
      "brightBlue": "#155c86",
      "brightMagenta": "#374983",
      "brightCyan": "#146665",
      "brightWhite": "#073642"
    },
    "code": {
      "foreground": "#073642",
      "comment": "#7c8d8d",
      "string": "#8a6800",
      "constant": "#a32468",
      "keyword": "#4f53a3",
      "function": "#1c6fa8",
      "type": "#1a7d76",
      "property": "#586e75",
      "punctuation": "#2e515b",
      "inserted": "#5f7000",
      "deleted": "#b02724"
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
