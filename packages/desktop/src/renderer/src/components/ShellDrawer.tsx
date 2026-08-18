import { useEffect, useRef } from "react";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal, type ITheme } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { backend } from "../backend";
import { useTheme } from "../lib/themes";
import { findRecord, registerShellWriter, sessionCwd, useStore } from "../store";
import { Button } from "./ui";

/**
 * The console drawer's right half (issue #42): a real PTY running the user's
 * login shell in the session's working tree (its worktree, if any) — not omp's stateless rpc `bash`
 * verb. Terminal construction mirrors TerminalTab (same options, addons, WebGL
 * context-loss handling); the differences are the shell channels, the lazy
 * spawn-on-first-visible, and a ResizeObserver (the drawer width moves with
 * the inspector rail without a window resize).
 */

export function ShellDrawer({ tabId, visible }: { tabId: string; visible: boolean }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<{ term: Terminal; fit: FitAddon } | null>(null);
  const spawnedRef = useRef(false);
  const theme = useTheme();
  const projectCwd = useStore(
    (s) =>
      sessionCwd(findRecord(s.state, tabId)) ??
      s.tabs.find((t) => t.tabId === tabId)?.projectCwd,
  );
  const exitCode = useStore((s) => s.shellExited[tabId]);
  const clearShellExited = useStore((s) => s.clearShellExited);

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

    // No spawn here: after a mode-switch round trip the drawer can remount
    // while display:none, where fit() degenerates. The visible effect spawns.
    const dataSub = term.onData((d) => backend.shellWrite(tabId, d));
    const unregister = registerShellWriter(tabId, (data) => term.write(data));

    // The drawer width moves with the inspector rail without a window resize,
    // so TerminalTab's window-listener alone is insufficient.
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      backend.shellResize(tabId, term.cols, term.rows);
    });
    observer.observe(host);

    return () => {
      observer.disconnect();
      dataSub.dispose();
      unregister();
      term.dispose();
      termRef.current = null;
      spawnedRef.current = false;
      backend.shellKill(tabId); // no-op if main already killed it
    };
  }, [tabId]);

  // Spawn on first visible; on later visible flips just re-fit and re-size
  // (display:none → real box degenerates fit, same as TerminalTab's refit).
  useEffect(() => {
    const t = termRef.current;
    if (!t || !visible || projectCwd === undefined) return;
    t.fit.fit();
    if (spawnedRef.current) {
      backend.shellResize(tabId, t.term.cols, t.term.rows);
      return;
    }
    spawnedRef.current = true;
    void backend
      .shellSpawn(tabId, projectCwd, t.term.cols, t.term.rows)
      .then(() => clearShellExited(tabId))
      .catch((err: unknown) => {
        spawnedRef.current = false; // next visible flip retries
        const msg = err instanceof Error ? err.message : String(err);
        t.term.write(`\x1b[31mshell failed to start: ${msg}\x1b[0m\r\n`);
      });
  }, [visible, tabId, projectCwd, clearShellExited]);

  // Re-theme a live terminal in place. Deliberately NOT a dep of the mount
  // effect: rebuilding the terminal would drop the scrollback and the PTY
  // writer registration. The spread is required — xterm compares the options
  // object by reference, so mutating the retrieved theme is ignored
  // (@xterm/xterm/typings/xterm.d.ts:881-889).
  useEffect(() => {
    const term = termRef.current?.term;
    if (term) term.options.theme = { ...theme.term } as ITheme;
  }, [theme]);

  // Main's kill-first makes this a clean replacement; scrollback is kept.
  const restart = (): void => {
    const t = termRef.current;
    if (!t || projectCwd === undefined) return;
    t.fit.fit();
    void backend
      .shellSpawn(tabId, projectCwd, t.term.cols, t.term.rows)
      .then(() => clearShellExited(tabId))
      .catch(() => {});
  };

  return (
    <div className="ambient relative min-h-0 flex-1 bg-surface p-2">
      <div ref={hostRef} className="h-full w-full" />
      {exitCode !== undefined && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-void/85 backdrop-blur-sm">
          <p className="font-display text-sm text-ink-mid">
            shell exited{" "}
            <span className="font-mono tabular-nums text-rose">(code {exitCode})</span>
          </p>
          <Button tone="signal" variant="outline" onClick={restart}>
            restart shell
          </Button>
        </div>
      )}
    </div>
  );
}
