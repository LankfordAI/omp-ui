import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages } from "../lib/clipboard-image";
import { registerTermWriter, useStore } from "../store";
import { Button, IconButton } from "./ui";

/**
 * xterm renders into a canvas, so it cannot read Tailwind classes — the palette
 * has to be handed over as literal colours. These are the only raw hex values
 * in the renderer, and every one is a copy of a token in `src/style.css`, which
 * stays the source of truth: change it there first, then mirror it here.
 *
 * `background` is the `surface` plane so the terminal sits on the same black as
 * the pane around it. ANSI is harmonized with the accent set rather than a
 * stock 16-colour scheme: mint for green, copper for yellow, rose for red,
 * iris for magenta/blue.
 */
const TERM_THEME = {
  background: "#14171b", // --color-surface
  foreground: "#e8ecf1", // --color-ink
  cursor: "#4ade9f", // --color-signal
  cursorAccent: "#14171b",
  selectionBackground: "#9d8cf559", // --color-iris @ 35%
  selectionInactiveBackground: "#9d8cf52e",
  black: "#0e1013", // --color-sunken
  red: "#f2748c", // --color-rose
  green: "#4ade9f", // --color-signal
  yellow: "#f0a868", // --color-copper
  blue: "#7fa9f0",
  magenta: "#9d8cf5", // --color-iris
  cyan: "#66d9d2",
  white: "#a8b2bf", // --color-ink-mid
  brightBlack: "#4a5361", // --color-ink-faint
  brightRed: "#f79bab",
  brightGreen: "#7ceebc",
  brightYellow: "#f7c493",
  brightBlue: "#a5c5f7",
  brightMagenta: "#bcb0f9",
  brightCyan: "#93e8e3",
  brightWhite: "#e8ecf1", // --color-ink
} satisfies ITheme;

export function TerminalTab({ tabId, active }: { tabId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);
  /**
   * A pasted image cannot ride the PTY as bytes, so main writes it to a scratch
   * file and delivers the *path* as a bracketed paste — omp's TUI editor
   * recognises an image path there and loads the file itself. Feedback is a
   * transient note, because the terminal itself shows omp's `[Image #N]` marker
   * a moment later and that is the real confirmation.
   */
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  const pasteImages = useCallback(
    async (data: DataTransfer | null) => {
      const { images, rejected } = await readClipboardImages(data);
      const failures = [...rejected];
      let sent = 0;
      for (const image of images) {
        try {
          // Serially, one bracketed paste per image: omp refuses a payload
          // carrying two path anchors, so a batched paste attaches nothing.
          await backend.ptyPasteImage(tabId, image);
          sent += 1;
        } catch (err) {
          failures.push(err instanceof Error ? err.message : String(err));
        }
      }
      if (failures.length > 0) {
        setNote({ text: failures.join("; "), bad: true });
      } else if (sent > 0) {
        setNote({ text: `attached ${sent} image${sent === 1 ? "" : "s"}`, bad: false });
      }
    },
    [tabId],
  );

  // Auto-dismiss: this is a receipt, not an error to be acknowledged. A failure
  // lingers longer because it is the only place the reason is shown.
  useEffect(() => {
    if (note === null) return;
    const timer = window.setTimeout(() => setNote(null), note.bad ? 6000 : 2000);
    return () => window.clearTimeout(timer);
  }, [note]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: '"JetBrains Mono Variable", ui-monospace, "SFMono-Regular", monospace',
      fontSize: 12.5,
      lineHeight: 1.45,
      cursorBlink: true,
      cursorStyle: "bar",
      // The host div paints the same colour, so transparency buys nothing and
      // costs the WebGL renderer its fast path.
      allowTransparency: false,
      scrollback: 10000,
      smoothScrollDuration: 0,
      theme: TERM_THEME,
    });
    const fit = new FitAddon();
    term.open(host);
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    try {
      const webgl = new WebglAddon();
      // GPU process restart (driver reset, suspend, OOM) kills the WebGL
      // context; disposing the addon restores the DOM renderer so the
      // terminal keeps rendering instead of showing a dead canvas.
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      // WebGL unavailable — silently stay on the DOM renderer.
    }
    termRef.current = { term, fit };

    // Spawn size is 80×24; immediately fit the real viewport and push it.
    fit.fit();
    backend.ptyResize(tabId, term.cols, term.rows);

    const dataSub = term.onData((d) => backend.ptyWrite(tabId, d));
    const unregister = registerTermWriter(tabId, (data) => term.write(data));
    const onResize = () => {
      fit.fit();
      backend.ptyResize(tabId, term.cols, term.rows);
    };
    window.addEventListener("resize", onResize);

    // Capture phase, on the host: xterm's hidden textarea would otherwise turn
    // an image paste into its *filename* as typed text. Text pastes are not
    // touched — xterm's own handling is what the user expects.
    const onPaste = (e: ClipboardEvent) => {
      if (!hasClipboardImage(e.clipboardData)) return;
      e.preventDefault();
      e.stopPropagation();
      void pasteImages(e.clipboardData);
    };
    // Dropping an image file is the same gesture by another route; without a
    // dragover preventDefault the browser navigates the window to the file.
    const onDragOver = (e: DragEvent) => {
      if (hasClipboardImage(e.dataTransfer)) e.preventDefault();
    };
    const onDrop = (e: DragEvent) => {
      if (!hasClipboardImage(e.dataTransfer)) return;
      e.preventDefault();
      void pasteImages(e.dataTransfer);
    };
    host.addEventListener("paste", onPaste, true);
    host.addEventListener("dragover", onDragOver);
    host.addEventListener("drop", onDrop);

    return () => {
      dataSub.dispose();
      unregister();
      window.removeEventListener("resize", onResize);
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      term.dispose();
      termRef.current = null;
    };
  }, [tabId, pasteImages]);

  // Re-fit when a hidden/inactive tab resurfaces (display:none → real box).
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    if (!t) return;
    t.fit.fit();
    backend.ptyResize(tabId, t.term.cols, t.term.rows);
  }, [active, tabId]);

  return (
    <div className="relative h-full w-full bg-surface p-2">
      <div ref={hostRef} className="h-full w-full" />
      {note !== null && (
        <div
          className={cn(
            "animate-rise absolute bottom-3 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2",
            "max-w-[80%] rounded-full border px-3 py-1 text-[11px] backdrop-blur",
            note.bad
              ? "border-rose-dim/50 bg-rose-wash text-rose"
              : "border-signal-dim/50 bg-signal-wash text-signal",
          )}
        >
          <span className="min-w-0 break-words" data-selectable>
            {note.text}
          </span>
          <IconButton
            label="dismiss"
            tone={note.bad ? "rose" : "signal"}
            onClick={() => setNote(null)}
          >
            <svg viewBox="0 0 16 16" fill="none" strokeWidth={1.6} className="size-2.5">
              <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeLinecap="round" />
            </svg>
          </IconButton>
        </div>
      )}
      {exitCode !== undefined && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-void/85 backdrop-blur-sm">
          <p className="font-display text-sm text-ink-mid">
            agent exited <span className="font-mono tabular-nums text-rose">(code {exitCode})</span>
          </p>
          <Button tone="signal" variant="outline" onClick={() => void resumeDead(tabId)}>
            resume session
          </Button>
        </div>
      )}
    </div>
  );
}
