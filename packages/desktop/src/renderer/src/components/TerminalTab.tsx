import { useCallback, useEffect, useRef, useState } from "react";
import type { ChangeEvent } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import type { ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { hasClipboardImage, readClipboardImages, readImageFiles } from "../lib/clipboard-image";
import type { ClipboardImages } from "../lib/clipboard-image";
import { useTheme } from "../lib/themes";
import { useFontFamily } from "../lib/font-families";
import { registerTermWriter, useStore } from "../store";
import { useT } from "../lib/i18n";
import { FindBar } from "./FindBar";
import { Button, IconButton, IconClose } from "./ui";

/**
 * xterm paints search decorations onto its own canvas, so — like the `term`
 * above — the copper wash is handed over as literal colours projected from
 * the active theme's token map (issue #270).
 */
function searchDecorations(tokens: Record<string, string>) {
  return {
    matchBackground: tokens["--color-copper-wash"],
    matchBorder: tokens["--color-copper-dim"],
    matchOverviewRuler: tokens["--color-copper"],
    activeMatchBackground: tokens["--color-copper-dim"],
    activeMatchBorder: tokens["--color-copper"],
    activeMatchColorOverviewRuler: tokens["--color-copper-dim"],
  };
}

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
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon; search: SearchAddon } | null>(null);
  const imagePickerRef = useRef<HTMLInputElement>(null);
  const theme = useTheme();
  const font = useFontFamily();
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);
  const searchOpen = useStore((s) => s.searchOpen[tabId] === true);
  const closeSearch = useStore((s) => s.closeSearch);
  /**
   * An image Attachment cannot ride the PTY as bytes, so main writes it to a scratch
   * file and delivers the *path* as a bracketed paste — omp's TUI editor
   * recognises an image path there and loads the file itself. Feedback is a
   * transient note, because the terminal itself shows omp's `[Image #N]` marker
   * a moment later and that is the real confirmation.
   */
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);

  // Find within the session (issue #270): the bar text and the addon's match
  // position/count, which feed the FindBar readout. `resultIndex` is -1 when
  // the highlight limit is exceeded — no active match.
  const [query, setQuery] = useState("");
  const [resultIndex, setResultIndex] = useState(0);
  const [resultCount, setResultCount] = useState(0);

  const deliverImages = useCallback(
    async ({ images, rejected }: ClipboardImages) => {
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
        setNote({
          text: sent === 1 ? t("terminal.note.attached", { n: sent }) : t("terminal.note.attachedPlural", { n: sent }),
          bad: false,
        });
      }
    },
    [tabId],
  );

  const pasteImages = useCallback(
    async (data: DataTransfer | null) => deliverImages(await readClipboardImages(data)),
    [deliverImages],
  );

  const pickImages = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const input = event.currentTarget;
      const files = Array.from(input.files ?? []);
      // Clear before any file reads or transport so choosing the same file is
      // a new change even while a previous selection is still being delivered.
      input.value = "";
      await deliverImages(await readImageFiles(files));
      termRef.current?.term.focus();
    },
    [deliverImages],
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
      fontFamily: font.mono,
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
    const search = new SearchAddon();
    term.loadAddon(search);
    const resultsSub = search.onDidChangeResults(({ resultIndex, resultCount }) => {
      setResultIndex(resultIndex);
      setResultCount(resultCount);
    });
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
    termRef.current = { term, fit, search };

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
      resultsSub.dispose();
      term.dispose();
      termRef.current = null;
    };
  }, [tabId, pasteImages]);

  // Re-theme and re-font a live terminal in place. Deliberately NOT a dep of
  // the mount effect: rebuilding the terminal would drop the scrollback and
  // the PTY writer registration. The spread is required — xterm compares the
  // options object by reference, so mutating the retrieved theme is ignored
  // (@xterm/xterm/typings/xterm.d.ts:881-889). The refresh repaints the
  // canvas with the new font's metrics without waiting for the next keystroke.
  useEffect(() => {
    const term = termRef.current?.term;
    if (!term) return;
    term.options.theme = { ...theme.term } as ITheme;
    term.options.fontFamily = font.mono;
    term.refresh(0, term.rows - 1);
  }, [theme, font]);

  // Find within the session (issue #270): re-issue the search as the query
  // changes. A theme switch first clears the old-colour decorations so the
  // re-issue restarts at the top instead of advancing the selection.
  const lastSearchTheme = useRef<string | null>(null);
  useEffect(() => {
    const t = termRef.current;
    if (!t || !searchOpen) return;
    const { term, search } = t;
    if (query.trim() === "") {
      search.clearDecorations();
      search.clearActiveDecoration();
      term.clearSelection();
      setResultIndex(0);
      setResultCount(0);
      return;
    }
    if (lastSearchTheme.current !== theme.id) {
      search.clearDecorations();
      search.clearActiveDecoration();
      lastSearchTheme.current = theme.id;
    }
    search.findNext(query, { caseSensitive: false, decorations: searchDecorations(theme.tokens) });
  }, [query, searchOpen, theme]);

  // Step through the matches; a blank query has nothing to step.
  const findNext = useCallback(
    () => {
      const t = termRef.current;
      if (!t || query.trim() === "") return;
      t.search.findNext(query, { caseSensitive: false, decorations: searchDecorations(theme.tokens) });
    },
    [query, theme],
  );
  const findPrevious = useCallback(
    () => {
      const t = termRef.current;
      if (!t || query.trim() === "") return;
      t.search.findPrevious(query, { caseSensitive: false, decorations: searchDecorations(theme.tokens) });
    },
    [query, theme],
  );

  // A true→false flip (Escape or ✕) tears the search down and hands focus
  // back to the xterm textarea; the query itself is preserved for the next
  // open. The ref makes it fire on the flip, not on every re-render.
  const wasSearchOpen = useRef(false);
  useEffect(() => {
    const wasOpen = wasSearchOpen.current;
    wasSearchOpen.current = searchOpen;
    if (wasOpen && !searchOpen) {
      const t = termRef.current;
      if (t) {
        t.search.clearDecorations();
        t.search.clearActiveDecoration();
        t.term.clearSelection();
        t.term.focus();
      }
      setResultIndex(0);
      setResultCount(0);
      lastSearchTheme.current = null;
    }
  }, [searchOpen]);

  // Re-fit when a hidden/inactive tab resurfaces (display:none → real box).
  // Focus follows the active terminal tab (issue #126): whenever a tab becomes
  // the active one — a fresh spawn, a mount while already active, or a sidebar
  // resurface — the xterm textarea is focused so the user can type without a
  // second click. The effect fires after the mount effect has built the xterm
  // instance, so the focus lands once the first keystrokes can be delivered.
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    if (!t) return;
    t.fit.fit();
    backend.ptyResize(tabId, t.term.cols, t.term.rows);
    t.term.focus();
  }, [active, tabId]);

  return (
    <div className="terminal-tab ambient relative h-full w-full bg-surface p-2">
      <div ref={hostRef} className="h-full w-full" />
      <span
        className="absolute right-3 top-3 z-10"
        onMouseDown={(event) => event.preventDefault()}
      >
        <Button
          variant="outline"
          tone="neutral"
          className="bg-surface/90 backdrop-blur max-[899px]:h-11 max-[899px]:px-3"
          onClick={() => imagePickerRef.current?.click()}
        >
          <svg
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth={1.4}
            aria-hidden
            className="size-3.5"
          >
            <path
              d="m5.1 8.8 4.5-4.5a2.1 2.1 0 0 1 3 3l-5.7 5.6a3.4 3.4 0 0 1-4.8-4.8l5.6-5.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          {t("terminal.tab.attachImages")}
        </Button>
      </span>
      <input
        ref={imagePickerRef}
        type="file"
        accept="image/*"
        multiple
        tabIndex={-1}
        aria-hidden
        className="sr-only"
        onChange={pickImages}
      />
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
            label={t("terminal.note.dismiss")}
            tone={note.bad ? "rose" : "signal"}
            onClick={() => setNote(null)}
          >
            <IconClose />
          </IconButton>
        </div>
      )}
      {exitCode !== undefined && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-void/85 backdrop-blur-sm">
          <p className="font-display text-sm text-ink-mid">
            {t("terminal.tab.exited")}{" "}
            <span className="font-mono tabular-nums text-rose">
              {t("terminal.tab.exitedCode", { code: exitCode })}
            </span>
          </p>
          <Button tone="signal" variant="outline" onClick={() => void resumeDead(tabId)}>
            {t("terminal.tab.resume")}
          </Button>
        </div>
      )}
      {searchOpen && exitCode === undefined && (
        <FindBar
          query={query}
          onQueryChange={setQuery}
          matchIndex={resultIndex >= 0 ? resultIndex : null}
          matchCount={resultCount}
          onPrev={findPrevious}
          onNext={findNext}
          onClose={() => closeSearch(tabId)}
        />
      )}
    </div>
  );
}
