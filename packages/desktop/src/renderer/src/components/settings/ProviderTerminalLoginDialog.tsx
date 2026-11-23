import { useEffect, useRef } from "react";
import "@xterm/xterm/css/xterm.css";
import { Button, Modal } from "../ui";
import { backend, displayMessage } from "../../backend";
import { useFontFamily } from "../../lib/font-families";
import { applyTerminalAppearance, createPtyResizePusher, createTerminal, type CreatedTerminal } from "../../lib/terminal";
import { useTheme } from "../../lib/themes";
import { registerShellWriter, useStore } from "../../store";
import { useTerminalCopyMenu } from "../useTerminalCopyMenu";

/**
 * The synthetic PTY key for a terminal sign-in (issue #1197): it is not a tab,
 * so no session record owns it — ShellHost keys its programs by this string
 * alone, and `killAll` at quit still reaps the child. One dialog is mounted at
 * a time (ProvidersPage state), so the provider id keeps the key unique per
 * login without needing a tab id.
 */
export const providerLoginTerminalId = (providerId: string): string =>
  `provider-login:${providerId}`;

/**
 * The in-app terminal for a risk-warning provider sign-in (issue #1197). omp
 * prompts "type yes to accept the risk" before any auth URL, which its rpc
 * `login` refuses, so the only working path is the real interactive CLI. This
 * dialog runs `omp login <providerId>` in a PTY (main spawns it through the
 * console ShellHost with the program `{ program: "omp-login", providerId }`,
 * after checking the id against its own login-risk roster) and shows the
 * terminal verbatim: the user answers omp's prompt and pastes codes here —
 * omp-ui never types "yes" for them. omp opens the browser itself; the xterm
 * WebLinks addon makes any URL it prints clickable, and the prompt text is
 * visible regardless of whether the OS browser launch succeeds.
 *
 * Exit 0 closes the dialog and re-reads the credentials through `onSignedIn`;
 * a non-zero exit keeps the output on screen with Retry/Close. Closing — or
 * unmounting by any route — kills the PTY.
 */
export function ProviderTerminalLoginDialog({
  providerId,
  label,
  onClose,
  onSignedIn,
}: {
  providerId: string;
  label: string;
  onClose: () => void;
  onSignedIn: () => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<CreatedTerminal | null>(null);
  const theme = useTheme();
  const font = useFontFamily();
  const copyMenu = useTerminalCopyMenu(termRef);
  const ptyId = providerLoginTerminalId(providerId);
  const exitCode = useStore((s) => s.shellExited[ptyId]);
  const clearShellExited = useStore((s) => s.clearShellExited);

  // Spawn on mount, kill on unmount; one PTY per dialog open. The cwd argument
  // is a placeholder: main runs an omp-login child in the home directory and
  // ignores whatever the renderer passes (issue #1197).
  useEffect(() => {
    const host = hostRef.current;
    if (host === null) return;
    const { term, fit, dispose: disposeRenderers } = createTerminal(host, theme, font);
    termRef.current = { term, fit, dispose: disposeRenderers };
    const dataSub = term.onData((data) => backend.shellWrite(ptyId, data));
    // The dialog renders the terminal only while open, so every byte writes
    // straight through — no hidden-drawer buffering like ShellDrawer needs.
    const unregister = registerShellWriter(ptyId, (data) => term.write(data));
    const pushResize = createPtyResizePusher(term, (cols, rows) =>
      backend.shellResize(ptyId, cols, rows),
    );
    const observer = new ResizeObserver(() => {
      if (host.clientWidth === 0 || host.clientHeight === 0) return;
      fit.fit();
      pushResize();
    });
    observer.observe(host);
    void backend
      .shellSpawn(ptyId, "", term.cols, term.rows, { program: "omp-login", providerId })
      .then(() => clearShellExited(ptyId))
      .catch((err: unknown) => {
        term.write(`\x1b[31momp failed to start: ${displayMessage(err)}\x1b[0m\r\n`);
      });
    term.focus();
    return () => {
      observer.disconnect();
      dataSub.dispose();
      unregister();
      // Phase 4: cancel pending WebGL-retry timers before the surface goes.
      disposeRenderers();
      term.dispose();
      termRef.current = null;
      // Closing the dialog ends the login attempt: kill first, and ShellHost
      // suppresses the exit event so a late 0 cannot claim success.
      backend.shellKill(ptyId);
    };
    // theme/font restyle the live terminal below; rebuilding would drop it.
  }, [ptyId, providerId, clearShellExited]);

  useEffect(() => {
    const term = termRef.current?.term;
    if (term) applyTerminalAppearance(term, theme, font);
  }, [theme, font]);

  // A clean exit means the credential is stored: hand the refresh to the page
  // and close. A failure keeps the terminal up so the output stays readable.
  useEffect(() => {
    if (exitCode !== undefined && exitCode === 0) onSignedIn();
  }, [exitCode, onSignedIn]);

  const retry = (): void => {
    const t2 = termRef.current;
    if (t2 === null) return;
    t2.fit.fit();
    t2.term.reset();
    void backend
      .shellSpawn(ptyId, "", t2.term.cols, t2.term.rows, { program: "omp-login", providerId })
      .then(() => clearShellExited(ptyId))
      .catch((err: unknown) => {
        t2.term.write(`\x1b[31momp failed to start: ${displayMessage(err)}\x1b[0m\r\n`);
      });
  };

  return (
    <Modal onClose={onClose} width="w-[46rem]" labelledBy="provider-terminal-login-title">
      <div className="flex h-full min-h-0 flex-col gap-2 p-4">
        <p id="provider-terminal-login-title" className="text-sm font-medium text-ink">
          {`Sign in to ${label} in a terminal`}
        </p>
        <p className="break-words text-xs leading-relaxed text-ink-dim">
          omp asks you to accept its account-risk warning here — type the answer it asks for yourself. Paste any code it requests into the terminal. If no browser opens, copy the sign-in URL from the terminal and open it.
        </p>
        <div className="ambient relative min-h-0 flex-1 overflow-hidden rounded-lg border border-line bg-surface p-2">
          <div ref={hostRef} className="h-full w-full" onContextMenu={copyMenu.onContextMenu} />
          {copyMenu.menu}
        </div>
        {exitCode !== undefined && exitCode !== 0 && (
          <div className="flex flex-wrap items-center gap-2">
            <p className="min-w-0 flex-1 break-words text-sm text-ink-mid">
              login exited{" "}
              <span className="font-mono tabular-nums text-rose">
                {`(code ${exitCode})`}
              </span>
            </p>
            <Button tone="signal" variant="outline" size="xs" onClick={retry}>
              retry
            </Button>
            <Button variant="ghost" size="xs" onClick={onClose}>
              close
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}
