import { useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import { copyFallback } from "../lib/clipboard";
import type { CreatedTerminal } from "../lib/terminal";
import { SelectionContextMenu } from "./SelectionContextMenu";

/**
 * Right-click Copy for an xterm selection (issue #638) in the console drawer
 * and terminal tabs. xterm keeps its selection in its own model, not the DOM,
 * and on right-click only stages it in its hidden textarea for a native
 * browser menu — which Electron never shows. So the text is captured here at
 * contextmenu time and offered through the app's one selection menu. A
 * right-click without a selection falls through untouched.
 */
export function useTerminalCopyMenu(termRef: RefObject<CreatedTerminal | null>): {
  onContextMenu: (event: ReactMouseEvent<HTMLElement>) => void;
  menu: ReactNode;
} {
  const [menu, setMenu] = useState<{ x: number; y: number; text: string } | null>(null);

  const onContextMenu = (event: ReactMouseEvent<HTMLElement>): void => {
    const term = termRef.current?.term;
    if (!term?.hasSelection()) return;
    const text = term.getSelection();
    if (text === "") return;
    // preventDefault keeps a remote browser client's native menu from opening
    // over ours; the captured string keeps Copy immune to later output.
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, text });
  };

  return {
    onContextMenu,
    menu:
      menu === null ? null : (
        <SelectionContextMenu
          x={menu.x}
          y={menu.y}
          markdown={null}
          // copyFallback (not navigator.clipboard) so remote clients over
          // http://<lan-ip> without the async Clipboard API still copy (#37).
          // Focus returns to the terminal so typing resumes without a click.
          onCopy={() => {
            void copyFallback(menu.text);
            termRef.current?.term.focus();
          }}
          onCopyMarkdown={null}
          onClose={() => setMenu(null)}
        />
      ),
  };
}
