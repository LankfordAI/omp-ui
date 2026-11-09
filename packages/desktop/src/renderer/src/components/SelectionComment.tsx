import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import { createPortal } from "react-dom";
import {
  normalizeAnnotationComment,
  normalizeAnnotationQuote,
  annotationQuotePreview,
  type Annotation,
} from "../lib/annotations";
import { cn } from "../lib/cn";
import { useT } from "../lib/i18n";
import { useDismissal } from "../lib/use-dismissal";
import { Button, IconPencil, Panel } from "./ui";

/** A live selection inside a surface: its quote and the point to anchor UI at. */
export interface SelectionAnchor {
  quote: string;
  x: number;
  y: number;
}

/** Button geometry follows the drag endpoint; the editor keeps its own anchor. */
interface SelectionButtonAnchor extends SelectionAnchor {
  bounds: { top: number; bottom: number };
  cursorX: number;
  backward: boolean;
}

/** The quote, editor endpoint, and whole-selection bounds in parent coordinates. */
export function selectionAnchor(
  sel: Selection | null,
  offset: { left: number; top: number } = { left: 0, top: 0 },
): SelectionButtonAnchor | null {
  if (sel === null || sel.isCollapsed || sel.rangeCount === 0) return null;
  const quote = normalizeAnnotationQuote(sel.toString());
  if (quote === "") return null;
  const range = sel.getRangeAt(0);
  const bounds = range.getBoundingClientRect();
  const rects = range.getClientRects();
  const last = rects.length > 0 ? rects[rects.length - 1]! : bounds;
  const first = rects.length > 0 ? rects[0]! : bounds;
  const backward = sel.focusNode === range.startContainer && sel.focusOffset === range.startOffset;
  return {
    quote,
    x: last.right + offset.left,
    y: last.bottom + offset.top,
    cursorX: (backward ? first.left : last.right) + offset.left,
    backward,
    bounds: {
      top: bounds.top + offset.top,
      bottom: bounds.bottom + offset.top,
    },
  };
}

/**
 * The floating "comment" button outside the whole selection (#983, #1122).
 * Pointerdown is swallowed so pressing it never collapses the selection.
 */
export function SelectionCommentButton({
  anchor,
  onComment,
}: {
  anchor: SelectionButtonAnchor;
  onComment: () => void;
}) {
  const t = useT();
  const button = useRef<HTMLButtonElement>(null);
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null);
  useLayoutEffect(() => {
    const place = (): void => {
      if (button.current === null) return;
      const { width, height } = button.current.getBoundingClientRect();
      const viewport = window.visualViewport;
      const left = (viewport?.offsetLeft ?? 0) + 8;
      const top = (viewport?.offsetTop ?? 0) + 8;
      const right = left + (viewport?.width ?? window.innerWidth) - 16;
      const bottom = top + (viewport?.height ?? window.innerHeight) - 16;
      const above = anchor.bounds.top - 8 - height;
      const below = anchor.bounds.bottom + 8;
      // A viewport-filling selection has no safe floating slot; right-click
      // Comment remains available rather than covering the selected text.
      const fitsAbove = above >= top && above + height <= bottom;
      const fitsBelow = below >= top && below + height <= bottom;
      if (width > right - left || (!fitsAbove && !fitsBelow)) {
        setPosition(null);
        return;
      }
      // Below a forward drag, above a backward drag: closest to the cursor
      // without covering any highlighted line. Only flip at a viewport edge.
      const useBelow = anchor.backward ? !fitsAbove : fitsBelow;
      setPosition({
        left: Math.max(left, Math.min(anchor.cursorX, right - width)),
        top: useBelow ? below : above,
      });
    };
    place();
    const observer = new ResizeObserver(place);
    if (button.current !== null) observer.observe(button.current);
    window.addEventListener("resize", place);
    window.visualViewport?.addEventListener("resize", place);
    window.visualViewport?.addEventListener("scroll", place);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("resize", place);
      window.visualViewport?.removeEventListener("scroll", place);
    };
  }, [anchor]);
  return createPortal(
    <button
      ref={button}
      type="button"
      data-selection-comment
      aria-label={t("annotation.comment.button")}
      title={t("annotation.comment.button")}
      onPointerDown={(event) => event.preventDefault()}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onComment}
      className="fixed z-40 flex max-w-[calc(100vw-1rem)] items-center gap-1 rounded-md border border-line-strong bg-overlay px-1.5 py-0.5 text-xs text-ink-mid shadow-float transition-colors hover:border-iris-dim hover:text-ink"
      style={{ left: position?.left ?? 0, top: position?.top ?? 0, visibility: position === null ? "hidden" : undefined }}
    >
      <IconPencil className="size-3" />
      {t("annotation.comment.button")}
    </button>,
    document.body,
  );
}

/**
 * The inline popover the Comment action opens: the quote it annotates and one
 * comment field. Enter saves (Shift+Enter breaks the line), Escape cancels.
 */
export function SelectionCommentPopover({
  anchor,
  onSave,
  onClose,
}: {
  anchor: SelectionAnchor;
  onSave: (annotation: Annotation) => void;
  onClose: () => void;
}) {
  const t = useT();
  const panel = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  const [comment, setComment] = useState("");
  useEffect(() => field.current?.focus({ preventScroll: true }), []);
  // No onEscape here: the field owns Escape so it can stop the event before
  // the window-level dialog handlers (approval card, extension dialog) see it.
  useDismissal({ open: true, refs: panel, onClose });

  const save = (): void => {
    onSave({ quote: anchor.quote, comment: normalizeAnnotationComment(comment) });
    onClose();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.nativeEvent.stopImmediatePropagation();
      onClose();
    } else if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      save();
    }
  };

  return createPortal(
    <div
      ref={panel}
      role="dialog"
      aria-label={t("annotation.comment.title")}
      className={cn(
        "fixed z-50 mt-1 w-80 max-w-[calc(100vw-1rem)]",
        anchor.x > window.innerWidth / 2 && "-translate-x-full",
        anchor.y > window.innerHeight / 2 && "-translate-y-full",
      )}
      style={{ left: anchor.x, top: anchor.y }}
    >
      <Panel className="edge-lit animate-rise space-y-2 p-2">
        <p
          title={anchor.quote}
          className="truncate border-l-2 border-iris-dim/70 pl-1.5 text-xs italic text-ink-dim"
        >
          {annotationQuotePreview(anchor.quote, 80)}
        </p>
        <textarea
          ref={field}
          rows={2}
          value={comment}
          placeholder={t("annotation.comment.placeholder")}
          aria-label={t("annotation.comment.title")}
          onChange={(event) => setComment(event.target.value)}
          onKeyDown={onKeyDown}
          className="block w-full resize-none rounded border border-line bg-raised px-2 py-1.5 text-xs leading-relaxed text-ink placeholder:text-ink-faint focus:border-line-strong focus:outline-none"
        />
        <div className="flex items-center justify-end gap-1.5">
          <Button size="xs" variant="ghost" onClick={onClose}>
            {t("annotation.comment.cancel")}
          </Button>
          <Button size="xs" variant="solid" tone="signal" onClick={save}>
            {t("annotation.comment.save")}
          </Button>
        </div>
      </Panel>
    </div>,
    document.body,
  );
}

/** Share gesture gating between the transcript and the script-less plan frame. */
function listenForSelection(doc: Document, sync: () => void, hide: () => void): () => void {
  let selecting = false;
  const onPointerDown = (event: PointerEvent): void => {
    const target = event.target as Element | null;
    if (event.button !== 0 || target?.closest?.("[data-selection-comment]")) return;
    selecting = true;
    hide();
  };
  const onSelectionChange = (): void => {
    if (!selecting) sync();
  };
  const onPointerUp = (): void => {
    if (!selecting) return;
    selecting = false;
    sync();
  };
  const cancel = (): void => {
    selecting = false;
    hide();
  };
  doc.addEventListener("pointerdown", onPointerDown, true);
  doc.addEventListener("selectionchange", onSelectionChange);
  doc.addEventListener("pointerup", onPointerUp, true);
  doc.addEventListener("pointercancel", cancel, true);
  // A drag can finish outside the plan frame that started it.
  if (doc !== document) window.addEventListener("pointerup", onPointerUp, true);
  return () => {
    doc.removeEventListener("pointerdown", onPointerDown, true);
    doc.removeEventListener("selectionchange", onSelectionChange);
    doc.removeEventListener("pointerup", onPointerUp, true);
    doc.removeEventListener("pointercancel", cancel, true);
    if (doc !== document) window.removeEventListener("pointerup", onPointerUp, true);
  };
}

/**
 * The floating comment button for selections inside `root` (issue #983):
 * tracks settled selections and offers the button while a non-empty
 * selection sits in a `[data-selectable]` region of the surface. `enabled`
 * false hides it (no annotation target, or a popover/menu already open).
 */
export function useSelectionCommentButton(
  root: RefObject<HTMLElement | null>,
  enabled: boolean,
): { anchor: SelectionButtonAnchor | null; clear: () => void } {
  const [anchor, setAnchor] = useState<SelectionButtonAnchor | null>(null);
  useEffect(() => {
    if (!enabled) {
      setAnchor(null);
      return;
    }
    const sync = (): void => {
      const sel = window.getSelection();
      const host = root.current;
      if (sel === null || sel.rangeCount === 0 || host === null || !selectionInside(host, sel)) {
        setAnchor(null);
        return;
      }
      setAnchor(selectionAnchor(sel));
    };
    // A scroll moves the selection's rects; drop the button rather than chase it.
    const scroller = root.current;
    const hide = (): void => setAnchor(null);
    const unbind = listenForSelection(document, sync, hide);
    scroller?.addEventListener("scroll", hide, { passive: true });
    return () => {
      unbind();
      scroller?.removeEventListener("scroll", hide);
    };
  }, [enabled, root]);
  const clear = useCallback(() => setAnchor(null), []);
  return { anchor, clear };
}

/** Whether the selection lives under `root` and starts in a `[data-selectable]` region. */
export function selectionInside(root: HTMLElement, sel: Selection): boolean {
  if (sel.rangeCount === 0 || sel.isCollapsed) return false;
  const common = sel.getRangeAt(0).commonAncestorContainer;
  const commonEl = common.nodeType === Node.TEXT_NODE ? common.parentElement : (common as HTMLElement);
  if (commonEl === null || !root.contains(commonEl)) return false;
  const anchorNode = sel.anchorNode;
  const anchorEl =
    anchorNode === null
      ? null
      : anchorNode.nodeType === Node.TEXT_NODE
        ? anchorNode.parentElement
        : (anchorNode as HTMLElement);
  return anchorEl?.closest("[data-selectable]") != null;
}

/** A right-click on a selection inside a plan frame, in parent-window coordinates. */
export interface FrameSelectionMenu {
  x: number;
  y: number;
  text: string;
}

/**
 * Selection tracking inside the plan review's document frame (issue #983,
 * ADR-0077). The frame is `sandbox="allow-same-origin"` with no script
 * token, so its document is readable from here and runs nothing itself.
 * Rebinds on every load — a new `srcdoc` is a new document — and maps the
 * frame's client coordinates into the window's.
 */
export function useFrameSelection(
  frame: HTMLIFrameElement | null,
  enabled: boolean,
): {
  anchor: SelectionButtonAnchor | null;
  clear: () => void;
  menu: FrameSelectionMenu | null;
  closeMenu: () => void;
} {
  const [anchor, setAnchor] = useState<SelectionButtonAnchor | null>(null);
  const [menu, setMenu] = useState<FrameSelectionMenu | null>(null);
  useEffect(() => {
    setAnchor(null);
    setMenu(null);
    if (frame === null || !enabled) return;
    let unbind: (() => void) | null = null;
    const bind = (): void => {
      unbind?.();
      unbind = null;
      const doc = frame.contentDocument;
      if (doc === null || doc.body === null) return;
      const offset = (): { left: number; top: number } => {
        const rect = frame.getBoundingClientRect();
        return { left: rect.left, top: rect.top };
      };
      const sync = (): void => setAnchor(selectionAnchor(doc.getSelection(), offset()));
      const onContextMenu = (event: MouseEvent): void => {
        const sel = doc.getSelection();
        if (sel === null || sel.isCollapsed || sel.toString() === "") return;
        // Same contract as the transcript (issue #72): keep the selection, own the menu.
        event.preventDefault();
        const at = offset();
        setAnchor(null);
        setMenu({ x: event.clientX + at.left, y: event.clientY + at.top, text: sel.toString() });
      };
      // Scrolling the plan moves the selection's rects: drop the button.
      const hide = (): void => setAnchor(null);
      const unbindSelection = listenForSelection(doc, sync, hide);
      doc.addEventListener("contextmenu", onContextMenu);
      doc.addEventListener("scroll", hide, { passive: true });
      unbind = () => {
        unbindSelection();
        doc.removeEventListener("contextmenu", onContextMenu);
        doc.removeEventListener("scroll", hide);
      };
    };
    frame.addEventListener("load", bind);
    if (frame.contentDocument?.readyState === "complete") bind();
    return () => {
      frame.removeEventListener("load", bind);
      unbind?.();
    };
  }, [frame, enabled]);
  const clear = useCallback(() => setAnchor(null), []);
  const closeMenu = useCallback(() => setMenu(null), []);
  return { anchor, clear, menu, closeMenu };
}
