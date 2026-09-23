import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { backend } from "../backend";
import { useTheme } from "../lib/themes";
import { useFontFamily } from "../lib/font-families";
import { matchesHotkey } from "../lib/hotkeys";
import { applyTerminalAppearance, createTerminal, type CreatedTerminal } from "../lib/terminal";
import { findRecord, registerShellWriter, sessionCwd, useStore } from "../store";
import { useT } from "../lib/i18n";
import { useTerminalCopyMenu } from "./useTerminalCopyMenu";
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
  const t = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<CreatedTerminal | null>(null);
  const spawnedRef = useRef(false);
  /** Working tree the current shell was spawned in; a move forces a respawn. */
  const spawnedCwdRef = useRef<string | null>(null);
  /** Handoff key already spawned into this PTY; a newer key forces a respawn. */
  const handoffKeyRef = useRef<number | null>(null);
  const theme = useTheme();
  const font = useFontFamily();
  const projectCwd = useStore(
    (s) =>
      sessionCwd(findRecord(s.state, tabId)) ??
      s.tabs.find((t) => t.tabId === tabId)?.projectCwd,
  );
  const exitCode = useStore((s) => s.shellExited[tabId]);
  const clearShellExited = useStore((s) => s.clearShellExited);
  const handoff = useStore((s) => s.tuiHandoff[tabId]);
  const sendTuiHandoff = useStore((s) => s.sendTuiHandoff);
  const dismissTuiHandoff = useStore((s) => s.dismissTuiHandoff);
  const restartSession = useStore((s) => s.restartSession);
  const copyMenu = useTerminalCopyMenu(termRef);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const { term, fit } = createTerminal(host, theme, font);
    termRef.current = { term, fit };

    // mod+j is this drawer's own toggle (App.tsx). xterm translates Ctrl+J to
    // a line feed and stops the keydown before the window-level hotkey sees
    // it, so with focus in the console the chord would run the shell's current
    // line instead of closing the drawer (issue #637). Returning false makes
    // xterm skip the event, which then bubbles to useHotkeys untouched.
    term.attachCustomKeyEventHandler((e) => !matchesHotkey(e, "mod+j"));

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
      handoffKeyRef.current = null;
      backend.shellKill(tabId); // no-op if main already killed it
    };
  }, [tabId]);

  // Spawn on first visible; on later visible flips just re-fit and re-size
  // (display:none → real box degenerates fit, same as TerminalTab's refit).
  // A staged handoff key the PTY has not seen yet spawns omp's TUI client
  // instead of the login shell; main kills the previous program first, so the
  // respawn is a clean replacement rather than a second process. A session that
  // moved working tree — a released worktree (issue #334) — respawns for the
  // same reason: the drawer runs in the session's tree, not the one it started
  // in, and its old shell is already dead.
  useEffect(() => {
    const key = handoff?.key ?? null;
    // Dismissing drops the record, so the next staging restarts numbering at 1.
    // Forget the spawned key the moment the record goes — before the
    // visibility guard, since the drawer stays mounted while closed — so that
    // fresh 1 cannot match a retired one and silently skip the respawn.
    if (key === null) handoffKeyRef.current = null;
    const t = termRef.current;
    if (!t || !visible || projectCwd === undefined) return;
    t.fit.fit();
    const staged = key !== null && key !== handoffKeyRef.current;
    const moved = spawnedCwdRef.current !== null && spawnedCwdRef.current !== projectCwd;
    if (spawnedRef.current && !staged && !moved) {
      backend.shellResize(tabId, t.term.cols, t.term.rows);
      return;
    }
    spawnedRef.current = true;
    spawnedCwdRef.current = projectCwd;
    handoffKeyRef.current = key;
    void backend
      .shellSpawn(tabId, projectCwd, t.term.cols, t.term.rows, staged ? "omp-tui" : "shell")
      .then(() => clearShellExited(tabId))
      .catch((err: unknown) => {
        spawnedRef.current = false; // next visible flip retries
        spawnedCwdRef.current = null;
        handoffKeyRef.current = null; // and retries as the same program
        const msg = err instanceof Error ? err.message : String(err);
        t.term.write(`\x1b[31m${staged ? "omp" : "shell"} failed to start: ${msg}\x1b[0m\r\n`);
      });
  }, [visible, tabId, projectCwd, clearShellExited, handoff?.key]);

  // Focus follows the drawer opening, as it follows the active terminal tab
  // (issue #126, issue #637): the first open (the drawer mounts visible) and
  // every reopen put the cursor in the shell. Keyed on `visible` alone — the
  // spawn effect above also re-runs on a working-tree move or a handoff
  // restage, which must not pull focus out of the composer. focus() is a
  // browser no-op while #root is inert under a modal or the tab is hidden.
  useEffect(() => {
    if (visible) termRef.current?.term.focus();
  }, [visible]);

  // Re-theme and re-font a live terminal in place. Deliberately NOT a dep of
  // the mount effect: rebuilding the terminal would drop the scrollback and
  // the PTY writer registration. The spread is required — xterm compares the
  // options object by reference, so mutating the retrieved theme is ignored
  // (@xterm/xterm/typings/xterm.d.ts:881-889). The refresh repaints the
  // canvas with the new font's metrics without waiting for the next keystroke.
  useEffect(() => {
    const term = termRef.current?.term;
    if (term) applyTerminalAppearance(term, theme, font);
  }, [theme, font]);

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
    <div className="ambient relative flex min-h-0 flex-1 flex-col bg-surface p-2">
      {handoff !== undefined && (
        <div className="mb-2 shrink-0 rounded-md border border-line bg-raised px-2.5 py-2">
          <p className="truncate font-mono text-[11px] text-ink">{handoff.line}</p>
          <div className="mt-1.5 flex items-center gap-2">
            <p className="min-w-0 flex-1 truncate text-[11px] text-ink-dim">
              {handoff.phase === "running" ? t("shell.handoff.running") : t("shell.handoff.exited")}
            </p>
            {handoff.phase === "running" ? (
              <Button
                tone="signal"
                variant="outline"
                size="xs"
                onClick={() => sendTuiHandoff(tabId)}
              >
                {t("shell.handoff.send")}
              </Button>
            ) : (
              <Button
                tone="copper"
                variant="outline"
                size="xs"
                // restartSession alerts and resolves false rather than
                // throwing; retiring the banner on that path would take the
                // retry with it and leave only "restart shell", which spawns a
                // login shell and never picks the credential up.
                onClick={() =>
                  void restartSession(tabId).then((ok) => {
                    if (ok) dismissTuiHandoff(tabId);
                  })
                }
              >
                {t("shell.handoff.restartSession")}
              </Button>
            )}
            <Button variant="ghost" size="xs" onClick={() => dismissTuiHandoff(tabId)}>
              {t("shell.handoff.dismiss")}
            </Button>
          </div>
        </div>
      )}
      {/* The banner shares the column, so the host takes the remaining box
          instead of the full one; the ResizeObserver re-fits xterm to it. */}
      <div ref={hostRef} className="min-h-0 w-full flex-1" onContextMenu={copyMenu.onContextMenu} />
      {/* Suppressed while a handoff exists — its banner owns the exited state
          (restart the session, not the program). */}
      {exitCode !== undefined && handoff === undefined && (
        <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-void/85 backdrop-glass">
          <p className="font-display text-sm text-ink-mid">
            {t("shell.drawer.exited")}{" "}
            <span className="font-mono tabular-nums text-rose">
              {t("shell.drawer.exitedCode", { code: exitCode })}
            </span>
          </p>
          <Button tone="signal" variant="outline" onClick={restart}>
            {t("shell.exited.restart")}
          </Button>
        </div>
      )}
      {copyMenu.menu}
    </div>
  );
}
