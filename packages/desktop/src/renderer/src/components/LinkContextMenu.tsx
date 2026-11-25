import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { cn } from "../lib/cn";
import { useDismissal } from "../lib/use-dismissal";
import { Panel } from "./ui";
import { MENU_ITEM_CLASS } from "./SelectionContextMenu";

/**
 * Right-click menu for a transcript link (issue #1359): copy the target URL.
 * The anchor carries no href attribute by design (#101), so Chromium's own
 * "Copy link address" has nothing to offer; the component that renders the
 * link holds the URL and owns this menu. Same portaled-menu convention as
 * SelectionContextMenu — one [role="menu"], outside pointerdown or Escape
 * dismisses, first item focused on open.
 */
export function LinkContextMenu({
  x,
  y,
  onCopy,
  onClose,
}: {
  x: number;
  y: number;
  onCopy: () => void;
  onClose: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);

  // Focus the first item on open (mount-only, as in SelectionContextMenu).
  useEffect(() => {
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, []);

  useDismissal({ open: true, refs: menuRef, onClose, onEscape: onClose });

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
          Copy link
        </button>
      </Panel>
    </div>,
    document.body,
  );
}
