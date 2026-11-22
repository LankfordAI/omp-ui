import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import type { FontFamily } from "./font-families";
import type { Theme } from "./themes";

export interface CreatedTerminal {
  term: Terminal;
  fit: FitAddon;
  /** Clears pending WebGL-retry timers and disposes the live renderer addon.
   *  Call sites that tear the terminal down call this first (Phase 4). */
  dispose(): void;
}

/** Performance plan Phase 4: two reload attempts after a context loss —
 *  a dead GPU is still dead at 500 ms, and a second chance covers a process
 *  that is mid-restart. After the second throw, behavior is the shipped one:
 *  xterm keeps its DOM renderer. */
export const WEBGL_RETRY_DELAYS_MS = [500, 2_000];

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
  // WebGL renderer lifecycle (performance plan Phase 4): construction can
  // throw synchronously when the GPU is dead — today's and every attempt's
  // path. On context loss the addon is disposed and reloaded on a plain
  // timer ladder, so a transient GPU-process death returns the tab to the
  // GPU renderer instead of stranding it on the DOM renderer for the whole
  // run (the shipped one-way `onContextLoss → dispose` did exactly that).
  let webgl: WebglAddon | undefined;
  let retryTimer: number | undefined;
  let attempt = 0;
  let disposed = false;
  const loadWebgl = (): void => {
    if (disposed) return;
    try {
      const addon = new WebglAddon();
      addon.onContextLoss(() => {
        addon.dispose();
        if (webgl === addon) webgl = undefined;
        if (disposed || attempt >= WEBGL_RETRY_DELAYS_MS.length) return;
        const delay = WEBGL_RETRY_DELAYS_MS[attempt];
        attempt += 1;
        retryTimer = window.setTimeout(() => {
          retryTimer = undefined;
          loadWebgl();
        }, delay);
      });
      term.loadAddon(addon);
      webgl = addon;
      // A renderer that survives its first reload closes the episode: a
      // later loss restarts the ladder fresh.
      if (attempt > 0) attempt = 0;
    } catch {
      // Construction threw (GPU still dead, or unavailable at all): with
      // attempts left this rides the same ladder; with none it is today's
      // outcome — xterm keeps its DOM renderer.
      if (disposed || attempt >= WEBGL_RETRY_DELAYS_MS.length) return;
      const delay = WEBGL_RETRY_DELAYS_MS[attempt];
      attempt += 1;
      retryTimer = window.setTimeout(() => {
        retryTimer = undefined;
        loadWebgl();
      }, delay);
    }
  };
  loadWebgl();
  return {
    term,
    fit,
    dispose() {
      disposed = true;
      if (retryTimer !== undefined) window.clearTimeout(retryTimer);
      retryTimer = undefined;
      webgl?.dispose();
      webgl = undefined;
    },
  };
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
