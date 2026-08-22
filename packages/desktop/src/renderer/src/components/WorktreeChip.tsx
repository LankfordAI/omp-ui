import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionWorktree } from "@omp-ui/core/types";
import { backend } from "../backend";
import { cn } from "../lib/cn";
import { Chip, CopyButton, Panel } from "./ui";

/**
 * The Session HUD's worktree chip as an actionable popover (issue #260): the
 * chip itself is unchanged — mono `⎇ branch`, checkout path in the tooltip —
 * but clicking it opens copy rows for the branch and the checkout path, a
 * quiet "cut from <base>" line, and open targets (VS Code when available,
 * Files always) that hand the checkout path to the existing openProject
 * channel. Neutral chrome throughout — the signal accent stays reserved for
 * liveness (ADR-0004). Positioning and dismissal follow the sidebar's
 * terminal-menu convention; Escape restores focus to the trigger, matching
 * BranchChip.
 */

/**
 * A 40-hex commit base reads as its 8-char short form; a ref name (the user's
 * own pick) reads verbatim. Shared with the diffs pane's "since" chip.
 */
export function shortBase(base: string): string {
  return /^[0-9a-f]{40}$/.test(base) ? base.slice(0, 8) : base;
}

const rowText =
  "block w-full rounded-md px-2.5 py-1.5 text-left text-xs text-ink-mid transition-colors duration-150 hover:bg-hover hover:text-ink focus-visible:bg-hover focus-visible:text-ink focus-visible:outline-none";

export function WorktreeChip({
  worktree,
  className,
}: {
  worktree: SessionWorktree;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  /** null = never asked; asked once per mount, like the sidebar's discovery. */
  const [vsCodeAvailable, setVsCodeAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | null>(null);
  /** Wraps the trigger *and* the popover, so one containment test covers both. */
  const rootRef = useRef<HTMLSpanElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const close = (): void => {
    setOpen(false);
    setError(null);
  };

  const toggle = (): void => {
    if (open) {
      close();
      return;
    }
    const rect = triggerRef.current?.getBoundingClientRect();
    setPos(rect ? { x: rect.left, y: rect.bottom + 4 } : null);
    setOpen(true);
    if (vsCodeAvailable === null) {
      backend
        .getProjectOpenAvailability()
        .then((a) => setVsCodeAvailable(a.vsCode))
        .catch(() => setVsCodeAvailable(false));
    }
  };

  // Click-outside / Escape dismissal, matching BranchChip. The trigger is
  // inside rootRef, so a click on it is not an outside click — its own
  // onClick toggles, and the popover closes exactly once.
  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      const root = rootRef.current;
      if (root !== null && event.target instanceof Node && root.contains(event.target)) return;
      close();
    };
    const dismissOnEscape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
      triggerRef.current?.focus();
    };
    window.addEventListener("pointerdown", dismissOutside);
    window.addEventListener("keydown", dismissOnEscape);
    return () => {
      window.removeEventListener("pointerdown", dismissOutside);
      window.removeEventListener("keydown", dismissOnEscape);
    };
  }, [open]);

  const openIn = (target: "vscode" | "files"): void => {
    setError(null);
    backend.openProject(worktree.path, target).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : String(err));
    });
  };

  return (
    <span ref={rootRef} className={cn("inline-flex", className)}>
      <button
        ref={triggerRef}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        title={worktree.path}
        onClick={toggle}
        className="rounded-full focus-visible:outline focus-visible:outline-1 focus-visible:outline-line"
      >
        <Chip mono>⎇ {worktree.branch}</Chip>
      </button>
      {open &&
        pos !== null &&
        createPortal(
          <div role="menu" className="fixed z-50" style={{ left: pos.x, top: pos.y }}>
            <Panel
              className={cn(
                "edge-lit animate-rise w-64 p-1",
                pos.x > window.innerWidth / 2 && "-translate-x-full",
              )}
            >
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span className="min-w-0 truncate font-mono text-xs text-ink" title={worktree.branch}>
                  {worktree.branch}
                </span>
                <CopyButton text={worktree.branch} label="copy" />
              </div>
              <div className="flex items-center justify-between gap-2 px-2.5 py-1.5">
                <span
                  className="min-w-0 truncate font-mono text-[10px] text-ink-faint"
                  title={worktree.path}
                >
                  {worktree.path}
                </span>
                <CopyButton text={worktree.path} label="copy" />
              </div>
              {worktree.base !== null && (
                <p className="px-2.5 pb-1.5 text-[10px] text-ink-faint" title={worktree.base}>
                  cut from {shortBase(worktree.base)}
                </p>
              )}
              <div className="my-1 border-t border-line-soft" />
              {vsCodeAvailable === true && (
                <button type="button" role="menuitem" className={rowText} onClick={() => openIn("vscode")}>
                  Open in VS Code
                </button>
              )}
              <button type="button" role="menuitem" className={rowText} onClick={() => openIn("files")}>
                Open in Files
              </button>
              {error !== null && (
                <p role="alert" className="px-2.5 py-1.5 text-[10px] leading-relaxed text-rose">
                  {error}
                </p>
              )}
            </Panel>
          </div>,
          document.body,
        )}
    </span>
  );
}
