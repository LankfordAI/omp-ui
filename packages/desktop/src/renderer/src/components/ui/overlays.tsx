import { useEffect, useId, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useT } from "../../lib/i18n";
import { cn } from "../../lib/cn";
import { IconButton } from "./controls";
import { IconClose } from "./icons";
import { TONE_TEXT, type Tone } from "./tone";

/* ----------------------------------------------------------------- Overlay */

const overlayStack: symbol[] = [];
let lockedOverlays = 0;
let previousBodyOverflow = "";
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export type RestoreFocusTo = () => HTMLElement | null;

function visibleTab(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-tab-id]")].find(
      (tab) => tab.style.display !== "none",
    ) ?? null
  );
}

export function useOverlay(
  open: boolean,
  onClose?: () => void,
  restoreFocusTo?: RestoreFocusTo,
) {
  const root = useRef<HTMLDivElement>(null);
  const token = useRef(Symbol("overlay"));
  const trigger = useRef<HTMLElement | null>(null);
  const tabAtOpen = useRef<HTMLElement | null>(null);
  const close = useRef(onClose);
  const restore = useRef(restoreFocusTo);
  close.current = onClose;
  restore.current = restoreFocusTo;

  useEffect(() => {
    if (!open) return;
    trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    tabAtOpen.current = visibleTab();
    const id = token.current;
    overlayStack.push(id);
    if (lockedOverlays++ === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
      document.getElementById("root")?.setAttribute("inert", "");
    }

    const frame = requestAnimationFrame(() => {
      const host = root.current;
      const initial = host?.querySelector<HTMLElement>("[data-modal-initial-focus]");
      (initial ?? host?.querySelector<HTMLElement>(FOCUSABLE) ?? host)?.focus();
    });
    const onKey = (event: KeyboardEvent) => {
      if (overlayStack.at(-1) !== id) return;
      if (
        event.key === "Escape" &&
        event.target instanceof Node &&
        (event.target instanceof Element ? event.target : event.target.parentElement)?.closest('[role="menu"]')
      ) {
        return;
      }
      if (event.key === "Escape" && close.current) {
        event.preventDefault();
        event.stopImmediatePropagation();
        close.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...(root.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])];
      if (focusable.length === 0) {
        event.preventDefault();
        root.current?.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("keydown", onKey, true);
      const at = overlayStack.lastIndexOf(id);
      if (at >= 0) overlayStack.splice(at, 1);
      if (--lockedOverlays === 0) {
        document.body.style.overflow = previousBodyOverflow;
        document.getElementById("root")?.removeAttribute("inert");
      }
      const activeTab = visibleTab();
      const switchedComposer =
        activeTab !== tabAtOpen.current
          ? activeTab?.querySelector<HTMLElement>("[data-composer-input]:not([disabled])") ?? null
          : null;
      (restore.current?.() ?? switchedComposer ?? trigger.current)?.focus({ preventScroll: true });
    };
  }, [open]);
  return root;
}

const SHEET_POSITION: Record<"left" | "right" | "bottom", string> = {
  left: "inset-y-0 left-0 w-[min(22rem,92vw)] border-r animate-sheet-left",
  right: "inset-y-0 right-0 w-[min(22rem,92vw)] border-l animate-sheet-right",
  bottom:
    "inset-x-0 bottom-0 max-h-[min(82dvh,var(--app-viewport-height,82dvh))] rounded-t-2xl border-t animate-sheet-up",
};

/** Past this many pixels of downward drag, releasing dismisses a bottom sheet. */
const SHEET_DISMISS_PX = 72;

export function Sheet({
  open,
  placement,
  label,
  onClose,
  restoreFocusTo,
  children,
}: {
  open: boolean;
  placement: "left" | "right" | "bottom";
  label: string;
  onClose: () => void;
  restoreFocusTo?: RestoreFocusTo;
  children: ReactNode;
}) {
  const root = useOverlay(open, onClose, restoreFocusTo);
  const t = useT();
  // Bottom-sheet swipe-to-dismiss. The drag lives on the handle/header only,
  // so the body keeps native scrolling; transforms are written straight to the
  // node — a re-render per pointermove would fight the browser for 60fps.
  const drag = useRef<{ pointerId: number; startY: number; delta: number } | null>(null);
  if (!open) return null;

  const beginDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (placement !== "bottom") return;
    // Capturing over a control would swallow its click — the close button
    // lives inside this header. Drags start on the passive chrome only.
    if (e.target instanceof Element && e.target.closest("button") !== null) return;
    drag.current = { pointerId: e.pointerId, startY: e.clientY, delta: 0 };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const moveDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    // Only downward travel moves the sheet; upward drag is a no-op, not a grow.
    d.delta = Math.max(0, e.clientY - d.startY);
    if (root.current) {
      root.current.style.transform = d.delta > 0 ? `translateY(${d.delta}px)` : "";
      root.current.style.transition = "none";
    }
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    const d = drag.current;
    if (d === null || d.pointerId !== e.pointerId) return;
    drag.current = null;
    if (d.delta > SHEET_DISMISS_PX) {
      onClose();
      return;
    }
    // Spring back: hand the transform to a transition, then clear it.
    if (root.current) {
      root.current.style.transition = "transform 0.2s var(--ease-out-quint)";
      root.current.style.transform = "";
    }
  };

  return createPortal(
    <div data-overlay-root className="fixed inset-0 z-[60]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="animate-scrim pointer-events-none absolute inset-0 bg-void/65 backdrop-blur-sm" aria-hidden />
      <section
        ref={root}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        tabIndex={-1}
        className={cn(
          "ambient edge-lit absolute flex max-h-[var(--app-viewport-height,100dvh)] flex-col overflow-hidden border-line-strong bg-sunken",
          SHEET_POSITION[placement],
        )}
      >
        <header
          className={cn(
            "relative shrink-0 border-b border-line",
            placement === "bottom" && "touch-none",
          )}
          onPointerDown={beginDrag}
          onPointerMove={moveDrag}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
        >
          {placement === "bottom" && (
            <div aria-hidden className="flex justify-center pt-2">
              <span className="h-1 w-9 rounded-full bg-line-strong" />
            </div>
          )}
          <div className="flex min-h-11 items-center gap-3 px-[max(1rem,var(--safe-left))] pr-[max(0.5rem,var(--safe-right))]">
            <h2 className="min-w-0 flex-1 truncate font-display text-sm font-semibold text-ink">{label}</h2>
            <IconButton label={t("common.overlay.closeNamed", { label })} onClick={onClose} className="size-11">
              <IconClose />
            </IconButton>
          </div>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[var(--safe-bottom)]">
          {children}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Shared workflow overlay. Desktop keeps caller width; compact defaults full-screen. */
export function Modal({
  children,
  onClose,
  restoreFocusTo,
  width = "w-[30rem]",
  mobile = "fullscreen",
  role = "dialog",
  labelledBy,
  className,
}: {
  children: ReactNode;
  onClose?: () => void;
  restoreFocusTo?: RestoreFocusTo;
  width?: string;
  mobile?: "fullscreen" | "dialog";
  role?: "dialog" | "alertdialog";
  labelledBy?: string;
  /** Layout additions for the inner content box (e.g. a bounded column). */
  className?: string;
}) {
  const root = useOverlay(true, onClose, restoreFocusTo);
  const t = useT();
  return createPortal(
    <div
      data-overlay-root
      className="fixed inset-0 z-[70] flex items-center justify-center bg-void/70 backdrop-blur-sm"
      onPointerDown={(e) => e.target === e.currentTarget && onClose?.()}
    >
      <div
        ref={root}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        tabIndex={-1}
        className={cn(
          "ambient edge-lit animate-rise relative max-h-[min(80dvh,var(--app-viewport-height,80dvh))] max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-line-strong bg-overlay",
          width,
          className,
          mobile === "fullscreen" ? "compact-modal-fullscreen" : "compact-modal-dialog",
        )}
      >
        {onClose && (
          <IconButton label={t("common.overlay.close")} onClick={onClose} className="compact-modal-close absolute right-2 top-2 z-20 hidden bg-raised">
            <IconClose />
          </IconButton>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/** Destructive or disruptive decision overlay with one semantic alertdialog surface. */
export function ConfirmDialog({
  kicker,
  title,
  tone,
  children,
  actions,
  onClose,
  width,
}: {
  kicker: ReactNode;
  title: ReactNode;
  tone: Tone;
  children: ReactNode;
  actions: ReactNode;
  onClose: () => void;
  width?: string;
}) {
  const titleId = useId();

  return (
    <Modal
      role="alertdialog"
      labelledBy={titleId}
      onClose={onClose}
      width={width}
      mobile="dialog"
      className="flex flex-col"
    >
      <header className="shrink-0 border-b border-line px-4 py-3.5">
        <p className={cn("mb-1 font-mono text-[10px] uppercase tracking-[0.16em]", TONE_TEXT[tone])}>
          {kicker}
        </p>
        <h2 id={titleId} className="font-display text-base font-semibold text-ink">
          {title}
        </h2>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{children}</div>
      <footer className="flex shrink-0 justify-end gap-2 border-t border-line px-4 py-3">{actions}</footer>
    </Modal>
  );
}
