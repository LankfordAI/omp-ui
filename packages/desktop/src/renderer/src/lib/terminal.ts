import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { FontFamily } from "./font-families";
import type { Theme } from "./themes";

export interface CreatedTerminal {
  term: Terminal;
  fit: FitAddon;
}

/** Constructs the common xterm surface and resilient renderer addons. */
export function createTerminal(
  host: HTMLElement,
  theme: Theme,
  font: FontFamily,
): CreatedTerminal {
  const term = new Terminal({
    fontFamily: font.mono,
    fontSize: 12.5,
    lineHeight: 1.45,
    cursorBlink: true,
    cursorStyle: "bar",
    allowTransparency: false,
    scrollback: 10000,
    smoothScrollDuration: 0,
    theme: theme.term as ITheme,
  });
  const fit = new FitAddon();
  term.open(host);
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon());
  try {
    const webgl = new WebglAddon();
    webgl.onContextLoss(() => webgl.dispose());
    term.loadAddon(webgl);
  } catch {
    // WebGL unavailable — retain xterm's DOM renderer.
  }
  return { term, fit };
}

/** Repaints a live terminal without rebuilding it or losing scrollback. */
export function applyTerminalAppearance(
  term: Terminal,
  theme: Theme,
  font: FontFamily,
): void {
  term.options.theme = { ...theme.term } as ITheme;
  term.options.fontFamily = font.mono;
  term.refresh(0, term.rows - 1);
}
