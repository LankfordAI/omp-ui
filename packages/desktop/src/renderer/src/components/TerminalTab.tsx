import { useCallback, useEffect, useRef, useState } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages } from "../lib/clipboard-image";
import { useTheme } from "../lib/themes";
import { registerTermWriter, useStore } from "../store";
import { Button, IconButton } from "./ui";

/**
 * xterm renders into a canvas, so it cannot read Tailwind classes — the
 * palette has to be handed over as literal colours. `lib/themes.ts` is the
 * source of truth for those: each theme carries its own `term` ITheme
 * alongside the CSS tokens, so a switch moves both together.
 *
 * `background` is the `surface` plane so the terminal sits on the same colour
 * as the pane around it, and ANSI is harmonized with that theme's accent set
 * rather than a stock 16-colour scheme.
 */
export function TerminalTab({ tabId, active }: { tabId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const theme = useTheme();
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
      theme: theme.term as ITheme,
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
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      backend.ptyResize(tabId, term.cols, term.rows);
    });
    observer.observe(host);
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
      observer.disconnect();
      host.removeEventListener("paste", onPaste, true);
      host.removeEventListener("dragover", onDragOver);
      host.removeEventListener("drop", onDrop);
      term.dispose();
      termRef.current = null;
    };
  }, [tabId, pasteImages]);

  // Re-theme a live terminal in place. Deliberately NOT a dep of the mount
  // effect: rebuilding the terminal would drop the scrollback and the PTY
  // writer registration. The spread is required — xterm compares the options
  // object by reference, so mutating the retrieved theme is ignored
  // (@xterm/xterm/typings/xterm.d.ts:881-889).
  useEffect(() => {
    const term = termRef.current?.term;
    if (term) term.options.theme = { ...theme.term } as ITheme;
  }, [theme]);

  // Re-fit when a hidden/inactive tab resurfaces (display:none → real box).
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    if (!t) return;
    t.fit.fit();
    backend.ptyResize(tabId, t.term.cols, t.term.rows);
  }, [active, tabId]);

  return (
    <div className="terminal-tab ambient relative h-full w-full bg-surface p-2">
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
