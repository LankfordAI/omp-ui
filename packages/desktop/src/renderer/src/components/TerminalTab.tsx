import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { backend } from "../backend";
import { registerTermWriter, useStore } from "../store";

export function TerminalTab({ tabId, active }: { tabId: string; active: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const exitCode = useStore((s) => s.exited[tabId]);
  const resumeDead = useStore((s) => s.resumeDead);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const term = new Terminal({
      fontFamily: "monospace",
      fontSize: 13,
      scrollback: 5000,
      theme: { background: "#121212" },
    });
    const fit = new FitAddon();
    term.open(host);
    term.loadAddon(fit);
    term.loadAddon(new WebLinksAddon());
    try {
      term.loadAddon(new WebglAddon());
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

    return () => {
      dataSub.dispose();
      unregister();
      window.removeEventListener("resize", onResize);
      term.dispose();
      termRef.current = null;
    };
  }, [tabId]);

  // Re-fit when a hidden/inactive tab resurfaces (display:none → real box).
  useEffect(() => {
    if (!active) return;
    const t = termRef.current;
    if (!t) return;
    t.fit.fit();
    backend.ptyResize(tabId, t.term.cols, t.term.rows);
  }, [active, tabId]);

  return (
    <div className="relative h-full w-full">
      <div ref={hostRef} className="h-full w-full pl-1 pt-1" />
      {exitCode !== undefined && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-neutral-900/85">
          <p className="text-sm text-neutral-400">agent exited (code {exitCode})</p>
          <button
            className="rounded bg-neutral-700 px-3 py-1.5 text-sm hover:bg-neutral-600"
            onClick={() => void resumeDead(tabId)}
          >
            resume session
          </button>
        </div>
      )}
    </div>
  );
}
