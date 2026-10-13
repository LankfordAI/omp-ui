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

/**
 * Coalesced PTY resize pushes (#858). A ResizeObserver fires once per frame
 * while a sidebar/inspector width transition runs, and a drag-resize fires
 * continuously; today every callback pushes a SIGWINCH at the child, which
 * makes the shell repaint the whole prompt each frame. This pushes the first
 * real size change immediately (so a window drag still feels instant) and at
 * most one further push per PTY_RESIZE_QUIET_MS, always ending with the final
 * size. A callback whose cols/rows already match what was last pushed sends
 * nothing at all — the common case mid-transition, where the grid only
 * changes at character-cell thresholds.
 */
export const PTY_RESIZE_QUIET_MS = 150;

export function createPtyResizePusher(
  term: Terminal,
  send: (cols: number, rows: number) => void,
): () => void {
  let lastSent: string | null = null;
  let timer: number | null = null;
  const push = (): void => {
    timer = null;
    const key = `${term.cols},${term.rows}`;
    if (key === lastSent) return;
    lastSent = key;
    send(term.cols, term.rows);
  };
  return () => {
    const key = `${term.cols},${term.rows}`;
    if (key === lastSent) return;
    if (timer === null) {
      push();
      timer = window.setTimeout(push, PTY_RESIZE_QUIET_MS);
      return;
    }
    // A quiet-period change is pending; the trailing push will carry it.
  };
}
