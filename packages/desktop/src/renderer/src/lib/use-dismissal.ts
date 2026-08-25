import { useEffect, useRef, type RefObject } from "react";

/**
 * Window-level dismissal for a single surface (issue #298).
 *
 * While `open` is true, a pointerdown on the window that lands outside every
 * `refs` element calls `onClose`. When `onEscape` is provided, Escape also
 * closes the surface (after `event.preventDefault()`) and may restore focus
 * to the trigger via `restoreFocus`. When `onEscape` is omitted the hook
 * registers no keydown listener at all: a surface that never had Escape
 * dismissal keeps not having it.
 *
 * Callbacks are read from a latest-ref on every event, so passing fresh
 * closures with per-render state does not re-subscribe the listeners — only
 * `open` and `exemptSelector` are effect dependencies.
 */
export interface DismissalOptions {
  /** The surface is dismissable while true; while false nothing is registered. */
  open: boolean;
  /**
   * Elements containing the surface; a pointerdown inside any non-null one
   * never dismisses. A fresh array each render is fine — it is read from the
   * latest-ref at event time.
   */
  refs: RefObject<Element | null> | readonly RefObject<Element | null>[];
  /** Called on an outside pointerdown. */
  onClose: () => void;
  /** Optional Escape handler; omitting it registers no keydown listener. */
  onEscape?: () => void;
  /** Runs after an Escape dismissal. */
  restoreFocus?: () => void;
  /**
   * `closest()` selector for elements that must never dismiss — e.g. a
   * portaled confirm dialog the popover owns, which sits outside `refs`.
   */
  exemptSelector?: string;
}

export function useDismissal(options: DismissalOptions): void {
  const { open, exemptSelector } = options;
  const latest = useRef(options);
  latest.current = options;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const { refs, onClose, exemptSelector: exempt } = latest.current;
      const target = event.target;
      if (target instanceof Node) {
        const list = Array.isArray(refs) ? refs : [refs];
        for (const ref of list) {
          const element = ref.current;
          if (element !== null && element.contains(target)) return;
        }
      }
      if (exempt !== undefined && target instanceof Element && target.closest(exempt) !== null) {
        return;
      }
      onClose();
    };
    window.addEventListener("pointerdown", onPointerDown);
    let onKeyDown: ((event: KeyboardEvent) => void) | null = null;
    if (latest.current.onEscape !== undefined) {
      onKeyDown = (event: KeyboardEvent) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        latest.current.onEscape?.();
        latest.current.restoreFocus?.();
      };
      window.addEventListener("keydown", onKeyDown);
    }
    return () => {
      window.removeEventListener("pointerdown", onPointerDown);
      if (onKeyDown !== null) window.removeEventListener("keydown", onKeyDown);
    };
  }, [open, exemptSelector]);
}
