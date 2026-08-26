import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { ProjectOpenAvailability, ProjectOpenTarget, ProjectRecord } from "@omp-ui/core/types";
import { backend, displayMessage } from "../backend";
import { useDismissal } from "../lib/use-dismissal";
import { cn } from "../lib/cn";
import { Capsule, CAPSULE_SEGMENT, Chevron, IconButton, IconClose, Panel } from "./ui";

/**
 * The project header's Open split control (issue #169): one segment that
 * launches the preferred target, one that opens the menu of every target the
 * host can actually reach.
 *
 * Availability is resolved once by the sidebar and handed down, so a window of
 * twenty project sections asks the host once rather than twenty times. `null`
 * means "not resolved yet" — distinct from "resolved, nothing optional" — and
 * is the only state that disables both segments outright, because until the
 * answer arrives there is no honest primary action to name.
 *
 * Pending and error state are deliberately local: opening one project must
 * never busy or blame another, and a failure belongs beside the project it
 * happened to.
 */

/** Identical to the sidebar terminal menu's item — one menu convention. */
const MENU_ITEM_CLASS =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

/** Fixed and compact: the menu holds a few short entries, and a popup sized
 *  to this trigger would be unreadably narrow. */
const MENU_WIDTH = 176;
const MENU_GAP = 4;
/** Breathing room kept between the menu and every viewport edge. */
const VIEWPORT_EDGE = 8;

interface MenuGeometry {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

const TARGET_LABEL: Record<ProjectOpenTarget, string> = {
  vscode: "VS Code",
  files: "Files",
  terminal: "Terminal",
};

export function ProjectOpenControl({
  project,
  availability,
  refreshAvailability,
}: {
  project: Pick<ProjectRecord, "name" | "path">;
  /** `null` until the host has answered; the control is inert until then. */
  availability: ProjectOpenAvailability | null;
  /** Re-asks the host; the parent commits the fresh answer. */
  refreshAvailability: () => Promise<void>;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [geometry, setGeometry] = useState<MenuGeometry | null>(null);
  const [pending, setPending] = useState<ProjectOpenTarget | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  /** Synchronous duplicate guard: two activations in one tick see one state. */
  const pendingRef = useRef(false);
  /** Deferred until React has committed the trigger's enabled state. */
  const focusAfterPendingRef = useRef<"primary" | "trigger" | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const unresolved = availability === null;
  const busy = pending !== null;
  const disabled = unresolved || busy;
  /** VS Code when the host has it, the file manager otherwise (issue #169).
   *  Terminal is menu-only, never the primary segment. */
  const preferred: ProjectOpenTarget = availability?.vsCode === true ? "vscode" : "files";

  const closeMenu = useCallback((restoreFocus: boolean) => {
    setMenuOpen(false);
    setGeometry(null);
    if (restoreFocus) triggerRef.current?.focus();
  }, []);


  /**
   * Launch and settle. `pendingRef` is the guard rather than `pending` because
   * two clicks inside one React batch would both read the stale state. Focus
   * recovery is deferred until React has committed the enabled control.
   */
  const launch = (target: ProjectOpenTarget, restoreTo: "primary" | "trigger") => {
    if (pendingRef.current) return;
    pendingRef.current = true;
    if (restoreTo === "primary") focusAfterPendingRef.current = "primary";
    setPending(target);
    setError(null);
    void (async () => {
      try {
        await backend.openProject(project.path, target);
      } catch (err) {
        if (mountedRef.current) setError(displayMessage(err));
        // A failed launch of a discoverable target is the one moment the
        // cached answer is suspect — re-ask so the control stops offering a
        // dead destination.
        if (target === "vscode" || target === "terminal") {
          try {
            await refreshAvailability();
          } catch {
            // Availability is the parent's to report; the launch error stands.
          }
        }
      } finally {
        pendingRef.current = false;
        if (mountedRef.current) setPending(null);
      }
    })();
  };

  /** Menu picks close first: a popup hanging over a request in flight reads as stuck. */
  const select = (target: ProjectOpenTarget) => {
    closeMenu(false);
    focusAfterPendingRef.current = "trigger";
    launch(target, "trigger");
  };

  // A menu pick must return to the trigger after it is enabled, regardless of
  // where disabling it temporarily left document focus. Consume the intent so
  // later pending transitions cannot steal focus a second time.
  useEffect(() => {
    if (pending !== null) return;
    const intent = focusAfterPendingRef.current;
    if (intent === null) return;
    focusAfterPendingRef.current = null;
    if (intent === "trigger") {
      triggerRef.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (active === null || active === document.body) primaryRef.current?.focus();
  }, [pending]);

  // An unresolved or busy control cannot honour a pick, and a menu left open
  // behind one points at entries that would do nothing.
  useEffect(() => {
    if (disabled) {
      setMenuOpen(false);
      setGeometry(null);
    }
  }, [disabled]);

  // Anchored before paint: the measured height decides below-vs-above, so the
  // menu is never painted in the wrong place and never scrolls the shell to fit.
  useLayoutEffect(() => {
    if (!menuOpen) return;
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (trigger === null || menu === null) return;

    const rect = trigger.getBoundingClientRect();
    // The visual viewport is the honest one under a compact keyboard or a
    // pinch-zoom; inner{Width,Height} is the fallback where it is unsupported.
    const visualViewport = window.visualViewport;
    const viewportLeft = visualViewport?.offsetLeft ?? 0;
    const viewportTop = visualViewport?.offsetTop ?? 0;
    const viewportWidth = visualViewport?.width ?? window.innerWidth;
    const viewportHeight = visualViewport?.height ?? window.innerHeight;
    const viewportRight = viewportLeft + viewportWidth;
    const viewportBottom = viewportTop + viewportHeight;
    const width = Math.min(MENU_WIDTH, Math.max(0, viewportWidth - VIEWPORT_EDGE * 2));

    // Constrain the width before measuring height: on a narrow viewport the
    // description wraps, so measuring at the nominal width would undercount.
    menu.style.width = `${width}px`;
    const roomBelow = Math.max(
      0,
      viewportBottom - VIEWPORT_EDGE - rect.bottom - MENU_GAP,
    );
    const roomAbove = Math.max(0, rect.top - MENU_GAP - viewportTop - VIEWPORT_EDGE);
    const wanted = menu.scrollHeight;
    // Below by default; move above only when below cannot fit and above offers more room.
    const above = wanted > roomBelow && roomAbove > roomBelow;
    const maxHeight = above ? roomAbove : roomBelow;
    const height = Math.min(wanted, maxHeight);
    const minLeft = viewportLeft + VIEWPORT_EDGE;
    const maxLeft = viewportRight - VIEWPORT_EDGE - width;
    const minTop = viewportTop + VIEWPORT_EDGE;
    const maxTop = viewportBottom - VIEWPORT_EDGE - height;

    setGeometry({
      // Right-aligned to the trigger, then clamped inside both visual edges.
      left: Math.max(minLeft, Math.min(rect.right - width, maxLeft)),
      top: above
        ? Math.max(minTop, Math.min(rect.top - MENU_GAP - height, maxTop))
        : Math.max(minTop, Math.min(rect.bottom + MENU_GAP, maxTop)),
      width,
      maxHeight,
    });
  }, [menuOpen]);

  // Once per opening: re-focusing on every parent re-render would drag the user
  // back off the entry they arrowed to.
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("[role='menuitem']")?.focus();
  }, [menuOpen]);

  // Outside pointerdown dismisses without touching focus: the user is already
  // on their way somewhere else, and pulling focus back would fight them.
  useDismissal({
    open: menuOpen,
    refs: [menuRef, wrapperRef],
    onClose: () => closeMenu(false),
  });

  /** Roving arrow focus with wrap. Enter/Space stay native to the buttons. */
  const moveFocus = (delta: 1 | -1) => {
    const menu = menuRef.current;
    if (menu === null) return;
    const items = Array.from(menu.querySelectorAll<HTMLElement>("[role='menuitem']"));
    if (items.length === 0) return;
    const index = items.indexOf(document.activeElement as HTMLElement);
    const next =
      index === -1
        ? delta === 1
          ? items[0]
          : items[items.length - 1]
        : items[(index + delta + items.length) % items.length];
    next?.focus();
  };

  const filesDescriptionId = `project-open-files-${project.path}`;
  const terminalDescriptionId = `project-open-terminal-${project.path}`;
  const primaryLabel = busy ? "Opening…" : "Open";

  return (
    <div
      ref={wrapperRef}
      // The header row is itself a drag handle for reorder (issue #115), so a
      // control living inside it must neither start a drag nor reach the row's
      // collapse/expand click.
      draggable={false}
      onPointerDown={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.stopPropagation();
        }
      }}
      onMouseDown={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.stopPropagation();
        }
      }}
      onClick={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.stopPropagation();
        }
      }}
      onDragStart={(event) => {
        if (event.target instanceof Node && event.currentTarget.contains(event.target)) {
          event.preventDefault();
          event.stopPropagation();
        }
      }}
      className="flex min-w-0 flex-col items-end gap-1"
    >
      <Capsule className="font-display">
        <button
          ref={primaryRef}
          type="button"
          disabled={disabled}
          aria-busy={busy}
          aria-label={
            unresolved
              ? `Open ${project.name}`
              : `Open ${project.name} in ${TARGET_LABEL[preferred]}`
          }
          title={
            unresolved
              ? `checking how ${project.name} can be opened…`
              : `open ${project.path} in ${TARGET_LABEL[preferred]}`
          }
          onClick={() => launch(preferred, "primary")}
          className={cn(CAPSULE_SEGMENT, "text-[11px] text-ink-mid")}
        >
          <span className="truncate">{primaryLabel}</span>
        </button>

        <button
          ref={triggerRef}
          type="button"
          disabled={disabled}
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          aria-label={`Choose how to open ${project.name}`}
          title={`choose how to open ${project.name}`}
          onClick={() => (menuOpen ? closeMenu(true) : setMenuOpen(true))}
          className={cn(CAPSULE_SEGMENT, "px-1 text-ink-dim")}
        >
          <Chevron open className="size-2.5" />
        </button>
      </Capsule>

      {error !== null && (
        <p
          role="alert"
          className="flex w-full items-start gap-1.5 rounded-md border border-rose-dim/50 bg-rose-wash px-2 py-1.5 text-left text-[11px] text-rose"
        >
          <span className="min-w-0 flex-1 break-words">{error}</span>
          <IconButton
            label={`dismiss open error for ${project.name}`}
            onClick={() => setError(null)}
            className="size-4"
          >
            <IconClose className="size-2.5" />
          </IconButton>
        </p>
      )}

      {menuOpen &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={`Choose how to open ${project.name}`}
            className="fixed z-50 overflow-y-auto"
            style={{
              width: geometry?.width ?? MENU_WIDTH,
              left: geometry?.left ?? 0,
              top: geometry?.top ?? 0,
              maxHeight: geometry?.maxHeight,
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                // Handle Escape on the portalled menu before it reaches the
                // Sheet's window listener; dismiss only this popup and return
                // keyboard focus to the control that opened it.
                event.preventDefault();
                event.stopPropagation();
                closeMenu(true);
                return;
              }
              if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
              // Ours: neither scroll the sidebar nor wake Electron's auto-hidden
              // menu bar (main/index.ts: autoHideMenuBar).
              event.preventDefault();
              moveFocus(event.key === "ArrowDown" ? 1 : -1);
            }}
            onContextMenu={(event) => event.preventDefault()}
            onDragStart={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
          >
            <Panel className="edge-lit p-1">
              {/* VS Code leads when the host can reach it — the issue's preferred
                  handoff — and is absent, never broken, when it cannot. */}
              {availability?.vsCode === true && (
                <button
                  type="button"
                  role="menuitem"
                  aria-label={`Open ${project.name} in VS Code`}
                  className={MENU_ITEM_CLASS}
                  onClick={() => select("vscode")}
                >
                  VS Code
                </button>
              )}
              <button
                type="button"
                role="menuitem"
                aria-label={`Open ${project.name} in Files`}
                aria-describedby={filesDescriptionId}
                className={MENU_ITEM_CLASS}
                onClick={() => select("files")}
              >
                Files
              </button>
              <span
                id={filesDescriptionId}
                className="block px-2.5 pt-0.5 pb-1 text-[10px] text-ink-faint"
              >
                Opens the project directory in the system file manager.
              </span>
              {availability?.terminal === true && (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    aria-label={`Open ${project.name} in Terminal`}
                    aria-describedby={terminalDescriptionId}
                    className={MENU_ITEM_CLASS}
                    onClick={() => select("terminal")}
                  >
                    Terminal
                  </button>
                  <span
                    id={terminalDescriptionId}
                    className="block px-2.5 pt-0.5 pb-1 text-[10px] text-ink-faint"
                  >
                    Opens a system terminal at the project root.
                  </span>
                </>
              )}
            </Panel>
          </div>,
          document.body,
        )}
    </div>
  );
}
