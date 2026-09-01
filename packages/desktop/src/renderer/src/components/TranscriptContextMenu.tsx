import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import { Panel } from "./ui";

/**
 * Right-click menu for a live text selection in the native transcript
 * (issue #72). Follows the sidebar's terminal-menu pattern — one
 * fixed-position [role="menu"] portaled to document.body, dismissed by
 * outside pointerdown or Escape, first item focused on open — rather than
 * introducing a second menu convention.
 *
 * The parent captures the selection text at contextmenu time and owns the
 * copy itself (via `copyFallback`); this component is only positioning,
 * dismissal, and intent. That split keeps the action immune to the selection
 * collapsing between right-click and click.
 */

/** Identical to the sidebar terminal menu's item — one menu convention. */
const MENU_ITEM_CLASS =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

export function TranscriptContextMenu({
  x,
  y,
  markdown,
  onCopy,
  onCopyMarkdown,
  onClose,
}: {
  x: number;
  y: number;
  /** Raw turn markdown when the selection maps onto an assistant render item's source. */
  markdown: string | null;
  onCopy: () => void;
  onCopyMarkdown: (() => void) | null;
  onClose: () => void;
}) {
  const t = useT();
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the first item on open (mount-only: re-running on parent re-renders
  // would steal focus back from a user who moved to the second item).
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, []);

  useDismissal({ open: true, refs: menuRef, onClose, onEscape: onClose });

  const copyMarkdown = onCopyMarkdown;
  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="fixed z-50"
      style={{ left: x, top: y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      <Panel
        className={cn(
          "edge-lit animate-rise p-1",
          x > window.innerWidth / 2 && "-translate-x-full",
          y > window.innerHeight / 2 && "-translate-y-full",
        )}
      >
        <button
          type="button"
          role="menuitem"
          className={MENU_ITEM_CLASS}
          onClick={() => {
            onCopy();
            onClose();
          }}
        >
          {t("transcript.contextmenu.copy")}
        </button>
        {markdown !== null && copyMarkdown !== null && (
          <button
            type="button"
            role="menuitem"
            className={MENU_ITEM_CLASS}
            onClick={() => {
              copyMarkdown();
              onClose();
            }}
          >
            {t("transcript.contextmenu.copyMarkdown")}
          </button>
        )}
      </Panel>
    </div>,
    document.body,
  );
}
